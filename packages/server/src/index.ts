/**
 * 服务入口
 *
 * M1 目标：能启动、能迁移、能通过健康检查、能拦截危险 DB 路径。
 * 尚未实现：采集 / 扫描 / 匹配（M2~M4）
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { FastifyRequest } from 'fastify';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, getMigrationState, type DB } from '@hifan/core';
import { config, validateConfig } from './config.js';
import { initOverrides } from './config_overrides.js';
import { registerAppConfigApi } from './app_config.js';
import { BoardApi } from './board.js';
import { LibraryApi } from './library.js';
import { IntakeChecker } from '@hifan/matcher';
import { HiddenService } from './hidden.js';
import { CheckedService } from './checked.js';
import { EmbyVerifyService } from './emby_verify.js';
import { WantService } from './want.js';
import { registerDlApi, loadHnEpMap } from './dl_api.js';
import { registerManualBindApi } from './manual_bind_api.js';
import { TmdbClient } from '@hifan/collector';
import { DlSettingsStore } from './dl_settings.js';
import { scanEmby, autoCloseWanted } from './emby_scan.js';
import { AuthService, readAuthConfig, isLanRequest, isSecureRequest } from './auth.js';
import { loginPage } from './login-page.js';
import { createUpdateService } from './autoupdate_service.js';
import type { TaskName } from './scheduler.js';

/**
 * 当前里程碑 —— 每次推进阶段时改这里，
 * 便于在 /api/health 与启动日志里一眼确认线上跑的是哪个阶段。
 * （实测：容器日志曾长期显示 M1，容易误判进度）
 */
const MILESTONE = 'M5 统一 TMDB 2000+ 主库（v7 已并入）+ 本地匹配主线';

const app = Fastify({
  logger: {
    // 结构化 JSON 日志 —— Docker 环境下 `docker logs` 直接可读。
    // 刻意不使用 pino-pretty：开发环境若需彩色输出，装一次即可，
    // 但生产镜像不应为格式化器增加依赖。
    level: process.env.LOG_LEVEL || 'info',
  },
});

await app.register(cors, { origin: true });

/**
 * 表单解析（application/x-www-form-urlencoded）。
 *
 * 🔴 Fastify 默认**不解析表单**，POST /login 会拿到 undefined body。
 *    刻意不引 @fastify/formbody —— 镜像零编译链是本项目铁律，
 *    这个需求也就登录页一个，自写 15 行比加依赖划算。
 */
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body: string, done) => {
    try {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body)) out[k] = v;
      done(null, out);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

// ── 登录认证（公网反代用；局域网直连不拦）────────────────────────
/**
 * 🔴 必须**在任何路由之前**初始化：
 *    `/api/health` 的处理器会闭包引用 `auth.enabled`，
 *    定义写在后面就是 TDZ 引用（首次构建根本没报出来，
 *    因为 TS 只查已声明符号，运行到才炸）。
 */
const authCfg = readAuthConfig();
const auth = new AuthService(authCfg);

/** 免检路径：登录相关 + 健康检查（容器 healthcheck 依赖它）*/
const OPEN_PATHS = new Set(['/login', '/api/login', '/api/logout', '/api/health']);

/**
 * 认证闸门。
 *
 * 口径：
 *   - 没配 HIFAN_USER/HIFAN_PASS → 完全不拦（内网模式）
 *   - 局域网直连（Host 是内网 IP / localhost）→ 不拦
 *     ⚠️ 必须看 Host 而不是 socket IP —— Lucky 反代与容器同机，
 *        公网过来的请求 socket 也是内网，只看 socket 会把公网一起放过
 *   - 其余（公网经反代）→ 校验 session cookie
 */
app.addHook('onRequest', async (req, reply) => {
  if (!auth.enabled) return;
  if (OPEN_PATHS.has(req.url.split('?')[0])) return;
  if (isLanRequest(req)) return;

  const token = readCookie(req.headers.cookie, authCfg.cookieName);
  if (auth.verifyToken(token)) return;

  if (req.url.startsWith('/api/')) {
    return reply.code(401).send({ ok: false, error: '未登录' });
  }
  const nxt = encodeURIComponent(req.url);
  return reply.code(302).header('Location', `/login?next=${nxt}`).send();
});

app.log.info(
  {
    authEnabled: auth.enabled,
    user: authCfg.user || '(未设置)',
    lanBypass: true,
  },
  auth.enabled
    ? `登录认证已启用，用户名=${authCfg.user}；局域网直连不拦`
    : '未设置 HIFAN_USER/HIFAN_PASS，登录认证未启用（局域网模式）',
);

// ── 数据库 ──────────────────────────────────────────────────────
let db: DB;
try {
  db = openDb({ path: config.dbPath });
  const mig = getMigrationState(db);
  app.log.info(
    { dbPath: config.dbPath, ...mig },
    mig.upToDate ? '数据库就绪，schema 已是最新' : '数据库迁移中',
  );
  /* ⭐ §157 配置中心：建表（如缺）→ env 种子 → 加载内存覆盖层。
     之后 config 的受管 getter 全部「表 > env > 默认」，看板改完立即生效。 */
  initOverrides(db);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  app.log.error({ err: msg }, '数据库初始化失败');
  console.error('\n[致命] 数据库初始化失败：\n' + msg + '\n');
  process.exit(1);
}

// ── 路由 ────────────────────────────────────────────────────────

/** 健康检查：M1 的核心验收点 */
app.get('/api/health', async () => {
  const mig = getMigrationState(db);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tmdb_work)   AS tmdbWork,
         (SELECT COUNT(*) FROM tmdb_episode) AS tmdbEp,
         (SELECT COUNT(*) FROM local_work)  AS localWork,
         (SELECT COUNT(*) FROM local_file)  AS localFile,
         (SELECT COUNT(*) FROM emby_series
           WHERE synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')) AS embySeries,
         (SELECT COUNT(*) FROM emby_episode
           WHERE synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')) AS embyEpisode,
         (SELECT COUNT(*) FROM match_result) AS matches,
         (SELECT COUNT(*) FROM gap)          AS gaps`,
    )
    .get() as Record<string, number>;

  return {
    ok: mig.upToDate,
    status: mig.upToDate ? 'healthy' : 'migrating',
    db: { path: config.dbPath, ...mig },
    counts,
    jobs: db.prepare('SELECT job_name, status, processed, succeeded, failed FROM job_state').all(),
    milestone: MILESTONE,
    /** 登录认证是否启用 —— 前端据此决定要不要显示「退出登录」 */
    authEnabled: auth.enabled,
    modules: {
      collector: '未实现 (M2)',
      scanner: '未实现 (M3)',
      matcher: '未实现 (M4)',
      web: '未实现 (M5)',
    },
  };
});

/** 看板概览 —— M5 前先返回结构，数据为空 */
app.get('/api/stats/overview', async () => {
  const r = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM tmdb_work)  AS totalPool,
        /* ⭐ 2026-10-27（§70）：owned 判据换成 Emby 里番库（原为 local_work）。
           蛙哥定调：Emby 里有才算入库；本地 /library 那批 Emby 根本看不到。 */
        (SELECT COUNT(DISTINCT s.tmdb_id) FROM emby_series s
          WHERE s.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')) AS owned,
        (SELECT COUNT(*) FROM gap WHERE kind = 'missing_work') AS missingWork,
        (SELECT COUNT(*) FROM gap WHERE kind = 'missing_ep')   AS missingEp,
        (SELECT COUNT(*) FROM gap WHERE kind = 'unlisted')      AS unlisted`,
    )
    .get() as { totalPool: number; owned: number; missingWork: number; missingEp: number; unlisted: number };

  return {
    ...r,
    complete: r.totalPool > 0 ? Math.max(0, r.totalPool - r.missingWork) : 0,
    coveragePct: r.totalPool > 0 ? Number(((r.owned / r.totalPool) * 100).toFixed(1)) : 0,
  };
});

app.get('/api/config', async () => ({
  // 只回传非敏感信息
  scanLibraryRoot: config.scan.libraryRoot,
  excludeDirs: config.scan.excludeDirs,
  crossDevice: config.scan.crossDevice,
  cron: config.cron,
  hasTmdbKey: Boolean(config.tmdb.apiKey),
  hasTmdbProxy: Boolean(config.tmdb.proxy),
}));

/* ⭐ §157 配置中心（2026-11-05 蛙哥「把能设置的都放在设置面板上」）：
   GET/POST /api/app-config + 测试连接。设置页「系统设置」分组消费它。 */
registerAppConfigApi(app);

// ── 全量库 v7 证据档 API（内部/审核用）─────────────────────────
// ⭐ 2026-10-14 产品结构纠正：library_work 已从「看板数据源」降级为
//   「核对证据档」。主页不再有「全量库 v7」第三页签 ——
//   v7 已确认的内容经 enrich_pool.ts 提升进 tmdb_work，
//   以原本的 TMDB 看板形态（剧名/原名/季度/逐集编号与剧集名/封面）呈现。
//
//   这组接口保留有两个用途：
//     1. /review/ 审核页需要它来判断「这条有没有被确认过」
//     2. 回归核对：随时可查 v7 原始结论，不必重跑三源脚本
const library = new LibraryApi(db);

app.get('/api/library/stats', async () => library.stats());

app.get('/api/library/years', async () => library.byYear());

app.get('/api/library/works', async (req) => {
  const q = req.query as { year?: string; media?: string; limit?: string; offset?: string };
  return library.works({
    year: q.year,
    media: q.media,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  });
});

/** 单部详情 —— 用 query 传 mediaType，因为 tv/movie 是两个 id 空间 */
app.get('/api/library/work', async (req, reply) => {
  const q = req.query as { id?: string; media?: string };
  const id = Number(q.id);
  if (!id) return reply.code(400).send({ ok: false, error: '缺少 id' });
  const d = library.detail(q.media === 'movie' ? 'movie' : 'tv', id);
  if (!d) return reply.code(404).send({ ok: false, error: '作品不存在' });
  return d;
});

// ── 看板 API（M3：只读 TMDB 池）────────────────────────────────

// 🔴 2026-10-20 12:5x：逐件屏蔽服务必须**先于** board 实例化 ——
//    board 的列表/统计查询要靠它做服务端过滤（`visibleEx`）。
//    ⛔ 之前 board 在前、hidden 在后（318 行），导致 board 拿不到屏蔽集合。
const hidden = new HiddenService(db);

// 人工核对标记（2026-10-24 蛙哥）—— **不参与列表过滤** ⇒ 与 board 无耦合，
// 谁先实例化都行；放在 hidden 旁边只为读起来成对。
const checked = new CheckedService(db);

/* ⭐ 2026-10-27（§73）人工确认入库 —— 与 board **有耦合**：
   `embyFull` 的判定要读这张表（人工确认 ⇒ 等同 AI 判定无问题）。
   ⚠️ 但它不进 board 构造函数 —— 判定在 SQL 里直接读表，
      表不存在时降级成「没人确认过」，页面照常可用。 */
const embyVerify = new EmbyVerifyService(db);

/* ⭐ 2026-10-28（§80）喜欢 / 待下 / 订阅 —— 与 board **弱耦合**：
   卡片上的 ♥ 由 board.ts 的 SQL 子查询直接读表判定（`wantCol`），
   ⇒ 不进 board 构造函数；表不存在时降级成「一部都没喜欢」，页面照常可用。 */
const want = new WantService(db);

const board = new BoardApi(db, hidden);

/* ══════════════════════════════════════════════════════════════════
   ⭐ §85（2026-10-29）hanime 下载 API

   蛙哥：「下载路径落到 /本地下载盘」
        「我希望下载链接也在看板上呈现，和剧集一一对应」

   ⚠️ 挂载说明（compose 已改）：
      宿主 /本地下载盘  →  容器 /downloads
      ⛔ 绝不用 115 rclone 挂载路径（掉了 = 容器起不来，见 compose 注释）
   ══════════════════════════════════════════════════════════════════ */
/* ⭐ §90 下载运行时设置：代理模式在**看板上改、立即生效**，不改环境变量不重建容器。
   默认 `off` —— 蛙哥的机场只有 15G/月，一集 500MB，走代理几百集就爆。 */
const dlSettings = new DlSettingsStore(config.download.settingsPath);

const dlApi = registerDlApi(app, {
  db,
  cfg: {
    /* ⭐ §157 配置中心：代理/FlareSolverr/TMDB/CMS 全部 getter 活读，
       看板「系统设置」改完立即生效（⛔ 别改回快照拷贝，那会吃掉在线修改） */
    get proxy() {
      return config.download.proxy;
    },
    get proxies() {
      return config.download.proxy
        ? config.download.proxy.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    },
    directFirst: config.download.directFirst,
    root: config.download.root,
    subdir: config.download.subdir,
    settings: dlSettings,
    ipMemPath: config.download.ipMemPath,
  },
  /* ⭐ §88：队列 worker —— 随服务启动自动跑（一集下完自动接下集） */
  worker: {
    maxAttempts: config.download.maxAttempts,
    minFreeGb: config.download.minFreeGb,
  },
  autoStart: config.download.workerAutoStart,
  /* ⭐ 签名重抓通道：FlareSolverr（§79 定期扫描已在用同一条路）
     🔴 hembed 签名 TTL ~11h ⇒ 没有重抓能力，下载功能第二天就全废。 */
  relink: {
    get flaresolverr() {
      return config.hanime.flaresolverr;
    },
    get proxy() {
      return config.download.proxy;
    },
  },
  /* ⭐ §92 自研刮削入库 —— **不再调 MoviePilot**
     蛙哥：「我不想你调用 MP 刮削，我想把 MP 那一套流程搬进去 8848 看板，和 MP 分开」
     ⇒ TMDB 取详情 / 写 nfo / 下图片 / 复制落位，全在 scrape.ts 里自己跑。 */
  scrape: {
    libraryRoot: config.scrape.libraryRoot,
    imageBase: config.scrape.imageBase,
    /* 🔴 F24：单集复制的「无进展」超时（不是总时长），见 copy_stall.ts */
    copyStallMs: config.scrape.copyStallMs,
    embyRefresh: config.scrape.embyRefresh,
    maxAttempts: config.scrape.maxAttempts,
    workerAutoStart: config.scrape.workerAutoStart,
    /* 🔴 N2：库根 ENOENT 时是否放行当新库（默认 false —— 见过入库历史就必须当挂载问题） */
    allowNewRoot: config.scrape.allowNewRoot,
    /* 🔴 §97 验收目录：入库后回头确认 strm 真生成（不是「接口返回成功」就算） */
    strmRoot: config.scrape.strmRoot,
    tmdb: {
      get apiKey() {
        return config.tmdb.apiKey;
      },
      baseUrl: config.tmdb.baseUrl,
      get proxy() {
        return config.tmdb.proxy;
      },
      rateLimitMs: config.tmdb.rateLimitMs,
      maxRetries: config.tmdb.maxRetries,
      timeoutMs: 20_000,
    },
    /* ⭐ §93-3 入库第二步：触发 CMS 生成 strm（Emby 读的是 strm 库，不是 115 原件目录）
       CMS 是 host 网络、监听 0.0.0.0:9528 ⇒ 容器内走 docker0 网桥宿主侧 172.17.0.1。 */
    cms: {
      get baseUrl() {
        return config.cms.baseUrl;
      },
      get user() {
        return config.cms.user;
      },
      get pass() {
        return config.cms.pass;
      },
      autoSync: config.cms.autoSync,
      timeoutMs: config.cms.timeoutMs,
    },
  },
});
/* 引用一下，避免被 tree-shake（也让 /api/health 能报 worker 状态） */
void dlApi;

/* ══════════════════════════════════════════════════════════════
 * ⭐ §124 人工绑定（蛙哥：「我直接筛选未匹配，然后人工把未匹配的匹配上」）
 *
 * 路由集中在 `manual_bind_api.ts`；这里只负责把 TMDB 搜索能力接进去。
 * ⛔ TMDB 没配 key 时**降级成 null** ⇒ 候选接口返回 501，
 *    前端仍可用「库内已有作品」那条路（多数「多候选」场景够用）。
 * ══════════════════════════════════════════════════════════════ */
const tmdbSearch = config.tmdb.apiKey
  ? (async (query: string, mediaType: 'tv' | 'movie') => {
      const client = new TmdbClient({
        apiKey: config.tmdb.apiKey,
        proxy: config.tmdb.proxy,
        baseUrl: config.tmdb.baseUrl,
        rateLimitMs: config.tmdb.rateLimitMs,
        maxRetries: config.tmdb.maxRetries,
      });
      return client.search(mediaType, query, 1);
    })
  : null;

registerManualBindApi(app, { db, tmdbSearch });

/** 看板全量数据（一次请求拿全，避免 N+1） */
app.get('/api/board', async () => board.exportAll());

/** 全库统计 */
app.get('/api/board/stats', async () => board.stats());

/** 按年份分桶 */
app.get('/api/board/years', async () => board.byYear());

/**
 * ⭐⭐ §125：`ep_media` 判定分布 + 待落盘样本。
 *   验收脚本靠它**在线上自找样本** —— 「待落盘」这个状态会随下载消失（0r163/§125）。
 */
app.get('/api/board/media-stats', async () => board.mediaStats());

/** 某年的作品列表 */
app.get('/api/board/year/:year', async (req) => {
  const { year } = req.params as { year: string };
  const q = req.query as { type?: string; limit?: string; offset?: string };
  return board.worksByYear(Number(year), {
    mediaType: q.type === 'tv' || q.type === 'movie' ? q.type : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  });
});

/** 全部作品 */
app.get('/api/board/works', async (req) => {
  const q = req.query as { type?: string; withPoster?: string };
  return board.allWorks({
    mediaType: q.type === 'tv' || q.type === 'movie' ? q.type : undefined,
    withPosterOnly: q.withPoster === '1',
  });
});

/** 单部作品详情 + 季集 + 证据链（次要信息） */
app.get('/api/board/work/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const q = req.query as { media?: string };
  const d = board.detail(Number(id), q.media === 'movie' ? 'movie' : 'tv');
  if (!d) return reply.code(404).send({ ok: false, error: '作品不存在' });
  return d;
});

// ── 入库检测 API（M5：逐集状态）────────────────────────────────
// ⭐ §154d：注入 hn_ep_map（对齐引擎落位表）—— 见 dl_api.loadHnEpMap
const intake = new IntakeChecker(db, loadHnEpMap());

/** 全局入库概览 —— 三色数字 + 集数覆盖率 */
app.get('/api/intake/overview', async (req) => {
  const q = req.query as { hidden?: string };
  const ov = intake.overview() as Record<string, unknown>;
  // ⭐ 逐件屏蔽：把「已屏蔽 N 部」摆到概览里，蛙哥一眼知道核对时跳过了多少
  return { ...ov, hiddenWorks: intake.hiddenWorkCount(),
           includeHidden: q.hidden === '1' };
});

/** 缺集总清单（补货用） */
app.get('/api/intake/shortage', async (req) => {
  const q = req.query as { limit?: string; only?: string; hidden?: string };
  return intake.shortageList({
    limit: q.limit ? Number(q.limit) : 300,
    onlyMissing: q.only === '1',
    // ⭐ 逐件屏蔽：默认跳过已屏蔽的；?hidden=1 临时全看（蛙哥 2026-10-20）
    includeHidden: q.hidden === '1',
  });
});

/**
 * 反向缺口：本地有、看板主库无的作品。
 * 这类目录的 tmdb_id 因外键写成 NULL，只能从 dir_name 复原。
 */
app.get('/api/intake/unlisted', async (req) => {
  const q = req.query as { limit?: string; hidden?: string };
  return intake.unlistedList({
    limit: q.limit ? Number(q.limit) : 500,
    includeHidden: q.hidden === '1',
  });
});

/** 单部作品的逐集状态 —— MP 详情页的数据源 */
app.get('/api/intake/work/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const d = intake.workIntake(Number(id));
  if (!d) return reply.code(404).send({ ok: false, error: '作品不存在' });
  /* ⭐ §85：链接与下载状态**由 matcher 一并读**（`source_link` / `work_dl`）
     ⇒ 这里⛔ 不做二次注入（两处口径必然对不上，0lx）。 */
  return d;
});


// ── 逐件屏蔽 API（2026-10-20 蛙哥：「不是一刀切没」）────────────
//
// ⭐ 语义：`scope='board'` 屏蔽确定看板的 TMDB 作品（key = tmdb_id）；
//         `scope='unconfirmed'` 屏蔽未确定看板的源记录（key = source_work.src_key）。
// ⛔ 取消屏蔽不 DELETE，写 unhidden_at 留审计（铁律 0）。
// ⭐ `hidden` 实例已在上面（board 之前）创建，避免重复 new。

/** 已生效屏蔽的 key 集合 —— 看板/未确定看板/核对页共用同一份口径 */
app.get('/api/hidden/keys', async (req) => {
  const q = req.query as { scope?: string };
  const scope =
    q.scope === 'unconfirmed' ? 'unconfirmed'
    : q.scope === 'season' ? 'season'
    : 'board';
  return { ok: true, scope, keys: [...hidden.keys(scope)] };
});

/** 屏蔽列表（含作品名，方便回看当时屏了什么） */
app.get('/api/hidden/list', async (req) => {
  const q = req.query as { scope?: string; all?: string };
  const scope =
    q.scope === 'unconfirmed' ? 'unconfirmed'
    : q.scope === 'season' ? 'season'
    : q.scope === 'board' ? 'board'
    : undefined;
  return {
    ok: true,
    rows: hidden.list({
      ...(scope ? { scope } : {}),
      includeUnhidden: q.all === '1',
    }),
    stats: hidden.stats(),
  };
});

/**
 * ⭐ 2026-10-26（§69 ⑥）：**某作品被季级屏蔽的季号**。
 * 详情页抽屉打开时调一次，用来渲染「S02 已屏蔽（点击恢复）」。
 * ⚠️ 也可以直接从 `/api/board/work/:id` 的 `hiddenSeasons` 拿 —— 两条路都通，
 *   这里是给**不加载整部详情**的场景（如列表页角标）用的轻量接口。
 */
app.get('/api/hidden/seasons', async (req) => {
  const q = req.query as { workId?: string };
  const workId = String(q.workId ?? '').trim();
  if (!workId) return { ok: true, workId: null, seasons: [] };
  return { ok: true, workId, seasons: [...hidden.seasonKeys(workId)].sort((a, b) => a - b) };
});

/**
 * 某作品被**集级排除**的集（§74，2026-10-27）。
 *
 * 返回 `['1-3', ...]`（`<season>-<episode>`，与前端 localMap / stillMap 的 key 同款）。
 * ⚠️ 也可以直接从 `/api/board/work/:id` 的 `hiddenEpisodes` 拿 —— 两条路都通，
 *    这个端点给「只想拿排除列表」的调用方，省一次整部详情查询。
 */
app.get('/api/hidden/episodes', async (req) => {
  const q = req.query as { workId?: string };
  const workId = String(q.workId ?? '').trim();
  if (!workId) return { ok: true, workId: null, episodes: [] };
  return {
    ok: true,
    workId,
    episodes: [...hidden.episodeKeys(workId)].sort((a, b) => {
      const [as, ae] = a.split('-').map(Number);
      const [bs, be] = b.split('-').map(Number);
      return as - bs || ae - be;
    }),
  };
});

/** 屏蔽 / 取消屏蔽 —— 同一入口，幂等 */
app.post('/api/hidden/toggle', async (req, reply) => {
  const b = (req.body ?? {}) as { scope?: string; key?: string; reason?: string };
  const scope =
    b.scope === 'unconfirmed' ? 'unconfirmed'
    : b.scope === 'season' ? 'season'
    : b.scope === 'episode' ? 'episode'
    : b.scope === 'board' ? 'board'
    : null;
  const key = String(b.key ?? '').trim();
  if (!scope) {
    return reply.code(400).send({
      ok: false,
      error: 'scope 必须是 board / unconfirmed / season / episode',
    });
  }
  if (!key) return reply.code(400).send({ ok: false, error: 'key 不能为空' });
  // 🔴 season 的 key 必须带 workId（⛔ 不能只给 `S2` —— 那会屏掉全库所有第 2 季）
  if (scope === 'season' && !/^\d+:S\d{1,3}$/.test(key)) {
    return reply.code(400).send({
      ok: false,
      error: 'season 的 key 格式必须是 `<tmdb_id>:S<季号>`（如 118067:S2）',
    });
  }
  // 🔴 episode 同理：必须 `<tmdb_id>:S<季>:E<集>`，缺 workId 会跨作品误伤
  if (scope === 'episode' && !/^\d+:S\d{1,3}:E\d{1,4}$/.test(key)) {
    return reply.code(400).send({
      ok: false,
      error: 'episode 的 key 格式必须是 `<tmdb_id>:S<季>:E<集>`（如 284897:S1:E3）',
    });
  }
  try {
    const now = hidden.keys(scope).has(key);
    if (now) {
      const ok = hidden.unhide(scope, key);
      return { ok: true, action: ok ? 'unhidden' : 'noop', scope, key,
               stats: hidden.stats() };
    }
    const isNew = hidden.hide(scope, key, b.reason);
    return { ok: true, action: isNew ? 'hidden' : 'revived', scope, key,
             stats: hidden.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** 批量屏蔽（未确定看板常用：一次屏掉一整个合集） */
app.post('/api/hidden/bulk', async (req, reply) => {
  const b = (req.body ?? {}) as { scope?: string; keys?: string[]; reason?: string };
  const scope =
    b.scope === 'unconfirmed' ? 'unconfirmed'
    : b.scope === 'season' ? 'season'
    : 'board';
  const keys = (b.keys ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) return reply.code(400).send({ ok: false, error: 'keys 为空' });
  if (scope === 'season') {
    const bad = keys.filter((k) => !/^\d+:S\d{1,3}$/.test(k));
    if (bad.length) {
      return reply.code(400).send({
        ok: false,
        error: `season 的 key 格式必须是 <tmdb_id>:S<季号>，非法 ${bad.length} 个`,
      });
    }
  }
  try {
    let n = 0;
    for (const k of keys) if (hidden.hide(scope, k, b.reason)) n += 1;
    return { ok: true, scope, count: keys.length, newlyHidden: n,
             stats: hidden.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── 人工核对标记 API（2026-10-24 蛙哥）──────────────────────────
//
// ⭐ 语义：蛙哥人眼核对过这一部、确认没问题 ⇒ 打勾留凭证。
//    ⛔ 与「逐件屏蔽」相反：核对过的部**照常显示**在看板上（不参与任何过滤），
//    只是多一个 ✓ 角标 + 计入「已核对 N/1456」进度。
// ⛔ 取消核对不 DELETE，写 unchecked_at 留审计（铁律 0）。

/** 已核对 key 集合 —— 前端首屏拿一次，渲染卡片角标/年份进度 */
app.get('/api/checked/keys', async () => {
  return { ok: true, scope: 'board', keys: [...checked.keys('board')],
           stats: checked.stats() };
});

/** 核对清单（含作品名/年份，抽屉里回看「我核过哪些」） */
app.get('/api/checked/list', async (req) => {
  const q = req.query as { all?: string };
  return {
    ok: true,
    rows: checked.list({ scope: 'board', includeUnchecked: q.all === '1' }),
    stats: checked.stats(),
  };
});

/** 标记 / 取消核对 —— 同一入口，幂等 */
app.post('/api/checked/toggle', async (req, reply) => {
  const b = (req.body ?? {}) as { key?: string; note?: string };
  const key = String(b.key ?? '').trim();
  if (!key) return reply.code(400).send({ ok: false, error: 'key 不能为空' });
  // 🔴 key 必须是纯数字（tmdb_id 文本）—— 拒绝路径/通配等任何非数字形态，
  //    与屏蔽接口的「只认数字 key」口径一致（0as 类坑：不接任意字符串落库）。
  if (!/^\d+$/.test(key)) {
    return reply.code(400).send({ ok: false, error: 'key 必须是 tmdb_id（纯数字）' });
  }
  try {
    if (checked.keys('board').has(key)) {
      const ok = checked.uncheck('board', key);
      return { ok: true, action: ok ? 'unchecked' : 'noop', key,
               stats: checked.stats() };
    }
    const isNew = checked.check('board', key, b.note);
    return { ok: true, action: isNew ? 'checked' : 'revived', key,
             stats: checked.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * ⭐ 2026-10-27（§73）人工确认入库
 *
 * 蛙哥：「针对这些我知道都入库了，但系统无法判断的，我手动标记入库没问题」
 *       「人工标记后的效果和 ai 识别无问题的效果一样」
 *
 * 🔴 与 `/api/checked/*` 的区别：checked 是「三方信息核对凭证」，**不影响判定**；
 *    这里确认的是「Emby 里收全了」⇒ `embyFull` 直接变 true。
 */
app.get('/api/emby_verify/keys', async () => {
  return { ok: true, keys: [...embyVerify.keys()], stats: embyVerify.stats() };
});

/** 确认清单（含作品名/年份，抽屉里回看「我确认过哪些」） */
app.get('/api/emby_verify/list', async (req) => {
  const q = req.query as { all?: string };
  return {
    ok: true,
    rows: embyVerify.list({ includeRevoked: q.all === '1' }),
    stats: embyVerify.stats(),
  };
});

/** 确认 / 取消确认 —— 同一入口，幂等 */
app.post('/api/emby_verify/toggle', async (req, reply) => {
  const b = (req.body ?? {}) as {
    id?: unknown; media?: unknown; note?: unknown;
    snapEps?: unknown; snapNeed?: unknown;
  };
  // 🔴 只认数字 id + tv/movie —— 与屏蔽/核对接口的「不接任意字符串落库」口径一致
  const id = Number(b.id);
  const media = String(b.media ?? 'tv');
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ ok: false, error: 'id 必须是正整数 tmdb_id' });
  }
  if (media !== 'tv' && media !== 'movie') {
    return reply.code(400).send({ ok: false, error: 'media 只能是 tv 或 movie' });
  }
  // 快照只接受有限非负数，其余一律当「拿不到」⇒ ⛔ 不编造数字
  const numOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  try {
    const key = `${media}:${id}`;
    if (embyVerify.keys().has(key)) {
      const ok = embyVerify.revoke(id, media);
      return { ok: true, action: ok ? 'revoked' : 'noop', key, stats: embyVerify.stats() };
    }
    const r = embyVerify.verify(id, media, {
      note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined,
      snapEps: numOrNull(b.snapEps),
      snapNeed: numOrNull(b.snapNeed),
    });
    return {
      ok: true,
      action: r.isNew ? 'verified' : 'revived',
      key,
      stats: embyVerify.stats(),
    };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * ⭐ 2026-10-28（§80）批量核对
 *
 * 蛙哥：「批量核对也要加上，我点一下批量核对，可以多选一次性核对」
 *
 * ⛔ 前端不逐部打 `/api/checked/toggle`（N 部 = N 次往返，选 200 部就卡死）。
 * 这里一条请求、一个事务。
 *
 * 🔴 key 只认纯数字 tmdb_id（与单部接口同口径，0as：不接任意字符串落库）。
 * 返回 `{count, newly}` —— `newly` 是**真新增**的条数，避免「选了 10 部却说核对 3 部」。
 */
app.post('/api/checked/bulk', async (req, reply) => {
  const b = (req.body ?? {}) as { keys?: unknown; note?: unknown; on?: unknown };
  const raw = Array.isArray(b.keys) ? b.keys : [];
  const keys = raw
    .map((k) => String(k ?? '').trim())
    .filter((k) => /^\d+$/.test(k));
  if (!keys.length) {
    return reply.code(400).send({ ok: false, error: 'keys 必须是非空的 tmdb_id 数组' });
  }
  // `on` 缺省 = true（批量核对的主用法）；显式 false = 批量取消核对
  const on = b.on === false ? false : true;
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : undefined;
  const now = new Date().toISOString();
  let newly = 0;
  try {
    db.exec('BEGIN');
    const seen = checked.keys('board');
    if (on) {
      for (const k of keys) {
        if (!seen.has(k)) newly++;
        checked.check('board', k, note);
      }
    } else {
      for (const k of keys) checked.uncheck('board', k);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  void now;
  return { ok: true, on, count: keys.length, newly, stats: checked.stats() };
});

/**
 * ⭐ §151 标签档位（2026-11-04 蛙哥）
 *
 * 「把 hanime 的所有视频标签都抓出来，汇总去重，我后续需要单独设置高亮……
 *   让我一眼就看出来，然后避开下载」
 *
 * 四档（§153）：1=避开（红） 2=谨慎（琥珀） 3=喜欢（绿） 4=本命（紫）
 * 0=取消（⛔ 不 DELETE，写 0 留审计）
 * ⚠️ 标签清单来自 `video_tag`，没有 hanime 源条目的作品不会有标记（数据边界，不假装有）。
 */
app.get('/api/tag-mark', async () => {
  try {
    return { ok: true, ...board.tagMarks.view() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      tags: [], marks: {}, total: 0,
    };
  }
});

app.post('/api/tag-mark', async (req, reply) => {
  const b = (req.body ?? {}) as { tag?: string; level?: number | string };
  const tag = String(b.tag ?? '').trim();
  const level = Number(b.level);
  if (!tag) return reply.code(400).send({ ok: false, error: 'tag 不能为空' });
  if (![0, 1, 2, 3, 4].includes(level)) {
    return reply
      .code(400)
      .send({ ok: false, error: 'level 只能是 0(取消) / 1(避开) / 2(谨慎) / 3(喜欢) / 4(本命)' });
  }
  try {
    board.tagMarks.set(tag, level as 0 | 1 | 2 | 3 | 4);
    /* ⚠️ 回整份 marks（不是只回这一条）——前端要拿它立刻重画全库角标，
       少一个标签的颜色就会变成「改了没生效」。 */
    return { ok: true, tag, level, marks: board.tagMarks.marks() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * ⭐ 2026-10-28（§80）喜欢 / 待下 / 订阅
 *
 * 蛙哥：「再加一个喜欢（待下，订阅）功能就是我点一下，这一部进入一个待下状态，
 *        空了我去补下载+入库。这功能也要做批量」
 *
 * 四态全在这一个模块里：
 *   want（待下中） → done（已收） → revoked（不要了）
 * ⛔ 与入库判定无关：不碰 emby_*，只让卡片多一个 ♥ + 多一个筛选档。
 */
app.get('/api/want/keys', async (req) => {
  const q = req.query as { pending?: string };
  return {
    ok: true,
    keys: [...want.keys({ pendingOnly: q.pending === '1' })],
    // 已收的单独给一份 ⇒ 卡片能画绿♥、清单能划线（⛔ 不让前端自己推）
    doneKeys: [...want.doneKeys()],
    stats: want.stats(),
  };
});

/**
 * ⭐ §87（2026-10-30 蛙哥：「待下，对齐 hanime 和下载链接」）
 *
 * 待下页每张卡都要能看出三件事：**源站有几条 / 直链抓到几条 / 还差几条**。
 *
 * 🔴 只算**待下清单里那几十部**（不是全库 1440 部）⇒ 每次打开现算，成本可控。
 *    ⛔ 不做全库预聚合缓存 —— 缓存数字就是自证指标（0r31）。
 * 🔴 分母 = `entry_detail` 里**去重后的 vid 数**，与 `board.detail()` 的 `dlSource`
 *    同一口径（同一份数据、同一种去重方式），⛔ 不另立第二套口径（0lx）。
 */
app.get('/api/dl/want-audit', async () => {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = want.list({ includeDone: true }) as unknown as Array<Record<string, unknown>>;
  } catch {
    return { ok: true, rows: [] };
  }
  if (!rows.length) return { ok: true, rows: [] };

  const ids = [...new Set(rows.map((r) => Number(r.tmdb_id)).filter(Number.isFinite))];
  if (!ids.length) return { ok: true, rows: [] };
  const marks = ids.map(() => '?').join(',');

  /** work_id → 源站/直链统计 */
  const stat = new Map<number, { srcN: number; linkN: number; expN: number; m3u8N: number }>();
  try {
    const agg = db.prepare(`
      WITH v AS (
        SELECT DISTINCT sw.work_id AS wid, json_extract(j.value,'$.vid') AS vid
          FROM source_work sw, json_each(sw.entry_detail) j
         WHERE sw.src = 'hanime' AND sw.work_id IN (${marks})
           AND json_valid(sw.entry_detail)
      )
      SELECT v.wid AS wid, COUNT(*) AS srcN,
             SUM(CASE WHEN sl.vid IS NOT NULL THEN 1 ELSE 0 END) AS linkN,
             SUM(CASE WHEN sl.is_m3u8 = 1 THEN 1 ELSE 0 END)    AS m3u8N,
             SUM(CASE WHEN sl.expires_at IS NOT NULL
                       AND sl.expires_at <= CAST(strftime('%s','now') AS INTEGER)
                      THEN 1 ELSE 0 END)                        AS expN
        FROM v LEFT JOIN source_link sl ON sl.vid = v.vid
       GROUP BY v.wid
    `).all(...ids) as Array<{ wid: number; srcN: number; linkN: number; expN: number; m3u8N: number }>;
    for (const r of agg) {
      stat.set(Number(r.wid), {
        srcN: Number(r.srcN ?? 0), linkN: Number(r.linkN ?? 0),
        expN: Number(r.expN ?? 0), m3u8N: Number(r.m3u8N ?? 0),
      });
    }
  } catch {
    /* 老库 / 还没跑 migration #15 ⇒ 全按「没有链接」处理，⛔ 不许 500 */
  }

  /** Emby 现有集数（现算，⛔ 不用点♥那一刻的快照 —— 快照只用于「确认后数据变了」告警） */
  const emby = new Map<number, number>();
  try {
    const er = db.prepare(`
      SELECT tmdb_id, COUNT(*) AS n FROM emby_episode
       WHERE tmdb_id IN (${marks})
         AND synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')
       GROUP BY tmdb_id
    `).all(...ids) as Array<{ tmdb_id: number; n: number }>;
    for (const r of er) emby.set(Number(r.tmdb_id), Number(r.n));
  } catch { /* 没同步过 ⇒ 空表，前端显示「—」而不是 0（0cs） */ }

  const eps = new Map<number, number>();
  try {
    const tr = db.prepare(`
      SELECT id, episode_total FROM tmdb_work WHERE id IN (${marks})
    `).all(...ids) as Array<{ id: number; episode_total: number }>;
    for (const r of tr) eps.set(Number(r.id), Number(r.episode_total ?? 0));
  } catch { /* 忽略 */ }

  /**
   * ⭐ §89：这一部**已经下到本地**的集数（work_dl 里 done 且没作废的）。
   *
   * 🔴 为什么要有：待下是个**人工标记**，下载多少集不会自动改它
   *   ⇒ 用户点♥ → 下载完 → 待下还挂着，得自己记得点「已收」。
   *   这里把「已下 N 集」摆到卡片上，让他一眼看出该不该收，而**不自动改他的标记**。
   */
  const dlN = new Map<number, number>();
  try {
    const dr = db.prepare(`
      SELECT tmdb_id, COUNT(*) AS n FROM work_dl
       WHERE tmdb_id IN (${marks}) AND done_at IS NOT NULL AND revoked_at IS NULL
       GROUP BY tmdb_id
    `).all(...ids) as Array<{ tmdb_id: number; n: number }>;
    for (const r of dr) dlN.set(Number(r.tmdb_id), Number(r.n ?? 0));
  } catch { /* 老库还没 work_dl ⇒ 当 0 */ }

  /**
   * ⭐ §91：这一部**已经刮削进 115 媒体库**的集数（work_ingest done）。
   *
   * 🔴 与 dlEps 分开报：下完了 ≠ 入库了。
   *   下载在本地待整理目录，入库是 MP 复制到 115 并写好 nfo/封面。
   *   两个数字摆一起，用户才看得出「卡在哪一环」。
   */
  const ingN = new Map<number, number>();
  try {
    const ir = db.prepare(`
      SELECT tmdb_id, COUNT(*) AS n FROM work_ingest
       WHERE tmdb_id IN (${marks}) AND done_at IS NOT NULL AND revoked_at IS NULL
       GROUP BY tmdb_id
    `).all(...ids) as Array<{ tmdb_id: number; n: number }>;
    for (const r of ir) ingN.set(Number(r.tmdb_id), Number(r.n ?? 0));
  } catch { /* 老库还没跑 migration #19 ⇒ 当 0 */ }

  return {
    ok: true,
    rows: rows.map((r) => {
      const id = Number(r.tmdb_id);
      const st = stat.get(id) || { srcN: 0, linkN: 0, expN: 0, m3u8N: 0 };
      return {
        key: `${String(r.media_type)}:${id}`,
        media: String(r.media_type),
        tmdbId: id,
        name: (r.nameZh as string | null) ?? (r.nameOriginal as string | null) ?? null,
        year: r.year == null ? null : Number(r.year),
        state: String(r.state ?? 'want'),
        tmdbEps: eps.get(id) ?? null,
        embyEps: emby.has(id) ? emby.get(id)! : null,
        dlEps: dlN.get(id) ?? 0,
        ingEps: ingN.get(id) ?? 0,
        ...st,
      };
    }),
  };
});

/** 待下清单（附作品名/年份/封面，抽屉里回看） */
app.get('/api/want/list', async (req) => {
  const q = req.query as { all?: string; done?: string; revoked?: string };
  return {
    ok: true,
    rows: want.list({
      includeDone: q.done === '1' || q.all === '1',
      includeRevoked: q.revoked === '1' || q.all === '1',
    }),
    stats: want.stats(),
  };
});

/** 单部 加入 / 取消 待下 —— 幂等，同一入口 */
app.post('/api/want/toggle', async (req, reply) => {
  const b = (req.body ?? {}) as {
    id?: unknown; media?: unknown; note?: unknown;
    snapEps?: unknown; snapNeed?: unknown;
  };
  const id = Number(b.id);
  const media = String(b.media ?? 'tv');
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ ok: false, error: 'id 必须是正整数 tmdb_id' });
  }
  if (media !== 'tv' && media !== 'movie') {
    return reply.code(400).send({ ok: false, error: 'media 只能是 tv 或 movie' });
  }
  const numOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  try {
    const key = `${media}:${id}`;
    if (want.keys().has(key)) {
      const ok = want.remove(id, media);
      return { ok: true, action: ok ? 'removed' : 'noop', key, stats: want.stats() };
    }
    const r = want.add(id, media, {
      note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined,
      snapEps: numOrNull(b.snapEps),
      snapNeed: numOrNull(b.snapNeed),
    });
    return { ok: true, action: r.isNew ? 'want' : 'revived', key, stats: want.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** 批量 加入 / 取消 待下（一条事务；key 形如 `tv:207840`） */
app.post('/api/want/bulk', async (req, reply) => {
  const b = (req.body ?? {}) as { keys?: unknown; on?: unknown; note?: unknown };
  const raw = Array.isArray(b.keys) ? b.keys : [];
  const keys = raw.map((k) => String(k ?? '').trim()).filter(Boolean);
  if (!keys.length) {
    return reply.code(400).send({ ok: false, error: 'keys 必须是非空数组（形如 tv:207840）' });
  }
  const on = b.on === false ? false : true;
  try {
    const r = want.bulk(keys, on, {
      note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined,
    });
    return { ok: true, on, ...r, stats: want.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** 标记已收 / 撤销已收（「空了我去补下载」下完之后点一下） */
app.post('/api/want/done', async (req, reply) => {
  const b = (req.body ?? {}) as { id?: unknown; media?: unknown; done?: unknown };
  const id = Number(b.id);
  const media = String(b.media ?? 'tv');
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ ok: false, error: 'id 必须是正整数 tmdb_id' });
  }
  if (media !== 'tv' && media !== 'movie') {
    return reply.code(400).send({ ok: false, error: 'media 只能是 tv 或 movie' });
  }
  const on = b.done !== false;
  const ok = on ? want.markDone(id, media) : want.unmarkDone(id, media);
  return { ok: true, done: on, changed: ok, stats: want.stats() };
});

/**
 * ⭐ 2026-10-28（§80）一键扫 Emby 里番库
 *
 * 蛙哥：「再加一个入库检测，点一下自动扫 emby 库，然后匹配新增的片做入库检测」
 *
 * 流程：容器内直连 Emby API → 拉全库 Series/Episode → 落 `emby_series`/`emby_episode`
 *      → 与上次 `last_sync` 做差集 → 顺带**自动闭环待下清单**（收全的自动标已收）。
 *
 * 🔴 防线见 emby_scan.ts：扫到 < 100 部一律拒写（防权限假 0 把入库判定清空）。
 * ⚠️ 耗时数十秒（457 部 + 数千集），前端必须给 loading 态。
 */
// ── CMS 入库通知过滤（§155：成人内容推送不带图）────────────────
// 链路（2026-11-04 抓包定论）：Emby Webhooks → CMS `/api/emby/webhook` →
// CMS 按事件里的 tmdbid 查 TMDB 海报，推企微 `news` 图文（picurl=TMDB URL）；
// **事件里没有 tmdbid 时 CMS 自动降级为纯文本通知**（标题/时间/剧情保留）。
// ⇒ 本路由夹在中间：命中敏感目录的 library.new 剥掉 tmdbid+图片 tag 再转发，
//   正常影视原样转发（照常有图）；⛔ 删除等其他事件一律原样转发 ——
//   CMS 的「媒体深度删除」依赖完整 payload，剥字段会删不掉云盘资源。
app.post('/api/emby/webhook-filter', async (req, reply) => {
  const token = String((req.query as Record<string, unknown>)?.token ?? '');
  if (process.env.CMS_FILTER_TOKEN && token !== process.env.CMS_FILTER_TOKEN) {
    return reply.code(401).send({ ok: false, error: 'bad token' });
  }
  const body = (req.body ?? {}) as Record<string, any>;
  const nsfwHints = config.cms.nsfwPaths
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const path = String(body?.Item?.Path ?? '');
  const isNsfw =
    String(body?.Event ?? '') === 'library.new' &&
    path.length > 0 &&
    nsfwHints.some((h) => path.toLowerCase().includes(h.toLowerCase()));
  let filtered: string[] = [];
  if (isNsfw) {
    for (const k of ['ProviderIds', 'ImageTags', 'BackdropImageTags']) {
      if (body.Item && body.Item[k] !== undefined) {
        delete body.Item[k];
        filtered.push(k);
      }
    }
  }
  /* ⭐ §157：上游地址看板可改（app_config > env > 内置默认） */
  const upstream =
    config.cms.webhookUrl ||
    'http://172.17.0.1:9527/api/emby/webhook';
  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    console.log(
      `[cms-filter] event=${body?.Event} nsfw=${isNsfw} stripped=[${filtered.join(',')}] upstream=${r.status}`,
    );
    return reply.code(r.status).send(text);
  } catch (e) {
    console.error('[cms-filter] 转发 CMS 失败:', (e as Error).message);
    return reply.code(502).send({ ok: false, error: 'upstream failed' });
  }
});

app.post('/api/emby/scan', async (_req, reply) => {
  try {
    const r = await scanEmby(db);
    if (!r.ok) {
      return reply.code(r.refused ? 409 : 502).send({ ...r, ok: false });
    }
    // 扫完自动闭环待下（收全的部自动标「已收」）
    let autoClosed: Array<{ tmdbId: number; mediaType: string; name: string | null }> = [];
    try {
      autoClosed = autoCloseWanted(db);
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, '待下自动闭环失败（不影响扫描结果）');
    }
    return { ...r, ok: true, autoClosed, wantStats: want.stats() };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** 上次扫描时间 + Emby 现状（设置页/入库检测页显示） */
app.get('/api/emby/sync_info', async () => {
  try {
    const rows = db
      .prepare(`SELECT key, value FROM emby_sync_meta`)
      .all() as Array<{ key: string; value: string }>;
    const m: Record<string, string> = {};
    for (const r of rows) m[r.key] = r.value;
    return {
      ok: true,
      lastSync: m.last_sync ?? null,
      libraryId: m.library_id ?? null,
      seriesCount: m.series_count ? Number(m.series_count) : null,
      episodeCount: m.episode_count ? Number(m.episode_count) : null,
      configured: Boolean(config.emby.apiKey),
    };
  } catch (err) {
    return {
      ok: false,
      lastSync: null,
      configured: Boolean(config.emby.apiKey),
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

/**
 * 未确定看板「extra 待钉」的人工标记回传
 *
 * 蛙哥 2026-10-24：标记只存浏览器 localStorage ⇒ 助手读不到，核对链路断在这里。
 * ⇒ 页面「提交给助手」按钮 POST 到本接口，落 /app/data/pin_marks.json
 *    （DB 同卷，持久；宿主 /your/local/dir/data/pin_marks.json）。
 *
 * ⛔ 只写这一个固定文件，不接路径参数、不碰数据库、不触发任何重建。
 * ⛔ 前端内容一律按白名单重建，不整包透传（防止畸形/超大内容落盘）。
 */
const PIN_MARKS_PATH = resolve(config.dbPath, '..', 'pin_marks.json');

app.get('/api/pin_marks', async () => {
  try {
    if (!existsSync(PIN_MARKS_PATH)) return { ok: true, count: 0, marks: {} };
    const j = JSON.parse(readFileSync(PIN_MARKS_PATH, 'utf-8')) as {
      marks?: Record<string, unknown>;
      received_at?: string;
    };
    const marks = j.marks ?? {};
    return { ok: true, count: Object.keys(marks).length, received_at: j.received_at, marks };
  } catch (err) {
    return { ok: false, count: 0, marks: {}, error: err instanceof Error ? err.message : String(err) };
  }
});

app.post('/api/pin_marks', async (req, reply) => {
  const b = (req.body ?? {}) as { marks?: Record<string, { pick?: { s?: unknown; e?: unknown }; skip?: unknown; wait?: unknown; ts?: unknown }>; unset?: unknown; page?: string };
  const marks = b.marks;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) {
    return reply.code(400).send({ ok: false, error: 'marks 必须是对象' });
  }
  const keys = Object.keys(marks);
  if (keys.length > 3000) {
    return reply.code(400).send({ ok: false, error: `marks 条目过多：${keys.length}` });
  }

  const clean: Record<string, unknown> = {};
  for (const k of keys) {
    if (k.length > 200) continue;
    const v = marks[k];
    if (!v || typeof v !== 'object') continue;
    const ts = Number(v.ts) || Date.now();
    if (v.pick && typeof v.pick === 'object') {
      const s = Number(v.pick.s);
      const e = Number(v.pick.e);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 99 || e < 0 || e > 999) continue;
      clean[k] = { pick: { s, e }, ts };
    } else if (v.skip) {
      clean[k] = { skip: 1, ts };
    } else if (v.wait) {
      clean[k] = { wait: 1, ts };
    }
  }

  try {
    /* 🔴🔴 2026-10-24 17:50 —— 原来是整包 writeFileSync **覆盖**，这条是硬 bug。
       实证：蛙哥「真正的蓝色 / 抽彩三角铃 我已经确认提交过几次了」，但容器日志
       只有两次 POST，且两次都是 count=3（旧的 90698×2 + 98108），他那 4 条从没上来。
       根因两条叠加：
         ① 覆盖写 ⇒ 任何一端提交都把另一端的标记清空（谁最后提交谁说了算）
         ② localStorage 按 origin 隔离 ⇒ `局域网IP:8848` 与
            `hifan.example.com:16666` 是两份互不可见的标记
       ⇒ 改成**合并**：文件里已有的当底，本次 clean 覆盖同名键，unset 显式摘除。
       ⛔ 不要改回覆盖：标记是「只会累积的事实」，覆盖必然丢他半天的勾选。 */
    let prev: Record<string, unknown> = {};
    try {
      if (existsSync(PIN_MARKS_PATH)) {
        const j0 = JSON.parse(readFileSync(PIN_MARKS_PATH, 'utf-8')) as { marks?: Record<string, unknown> };
        if (j0 && j0.marks && typeof j0.marks === 'object' && !Array.isArray(j0.marks)) prev = j0.marks;
      }
    } catch {
      prev = {}; /* 文件坏了就当空的：宁可少几条，也不能 500 让他一条都交不上 */
    }
    const del = new Set<string>();
    if (Array.isArray(b.unset)) {
      for (const k of b.unset as unknown[]) {
        if (typeof k === 'string' && k.length > 0 && k.length <= 200) del.add(k);
      }
    }
    const merged: Record<string, unknown> = { ...prev, ...clean };
    for (const k of del) delete merged[k];

    const payload = {
      page: String(b.page ?? '').slice(0, 60),
      received_at: new Date().toISOString(),
      count: Object.keys(merged).length,
      marks: merged,
    };
    writeFileSync(PIN_MARKS_PATH, JSON.stringify(payload, null, 1), 'utf-8');
    app.log.info(
      { count: payload.count, posted: keys.length, unset: del.size, prev: Object.keys(prev).length, path: PIN_MARKS_PATH },
      '已接收待钉标记（合并）',
    );
    return { ok: true, count: payload.count, posted: keys.length, unset: del.size, path: PIN_MARKS_PATH };
  } catch (err) {
    return reply.code(500).send({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── ⭐ §79 定期更新检测 API ─────────────────────────────────────
//
// 蛙哥拍板：cron 表达式做进 8848 看板的「设置」页，后续可自由改时间。
// ⇒ 调度器跑在 server 容器内（node），不依赖 NAS crontab（改时间不用 SSH）。
//
// 🔴 铁律：**配置写入前必须校验 cron 合法性**
//   非法表达式 ⇒ 调度器永远不触发 ⇒ 看板看着正常但数据永远不更新
//   ⇒ updateConfig 内部先 parse，失败直接回 400 并原样返回当前配置。
const updateService = createUpdateService({
  db,
  dataDir: resolve(config.dbPath, '..'),
  configPath: config.schedulerConfigPath,
  onLog: (msg, meta) => app.log.info(meta ?? {}, msg),
});
const scheduler = updateService.scheduler;

/** 读调度器配置（含解析错误、人类可读描述、下次触发时间） */
app.get('/api/scheduler/config', async () => ({
  ok: true,
  config: scheduler.getConfig(),
}));

/** 改调度器配置 —— 非法 cron 直接 400，不落盘 */
app.post('/api/scheduler/config', async (req, reply) => {
  const b = (req.body ?? {}) as {
    hanimeCron?: unknown;
    tmdbCron?: unknown;
    enabled?: unknown;
    hanimeYears?: unknown;
    autoApply?: unknown;
  };

  const patch: Record<string, unknown> = {};
  if (b.hanimeCron !== undefined) patch.hanimeCron = String(b.hanimeCron).trim();
  if (b.tmdbCron !== undefined) patch.tmdbCron = String(b.tmdbCron).trim();
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
  if (b.autoApply !== undefined) patch.autoApply = Boolean(b.autoApply);
  if (b.hanimeYears !== undefined) {
    const arr = Array.isArray(b.hanimeYears) ? b.hanimeYears : String(b.hanimeYears).split(',');
    const years = arr
      .map((y) => Number(String(y).trim()))
      .filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100);
    if (!years.length) {
      return reply.code(400).send({ ok: false, error: 'hanimeYears 至少要有一个 2000~2100 之间的年份' });
    }
    patch.hanimeYears = [...new Set(years)].sort((a, z) => z - a);
  }

  const r = scheduler.updateConfig(patch as never);
  if (!r.ok) {
    return reply.code(400).send({ ok: false, error: r.error, config: r.config });
  }
  return { ok: true, config: r.config };
});

/** 立即执行一次（手动触发） */
app.post('/api/scheduler/run', async (req, reply) => {
  const b = (req.body ?? {}) as { task?: unknown };
  const task = String(b.task ?? 'hanime');
  if (task !== 'hanime' && task !== 'tmdb') {
    return reply.code(400).send({ ok: false, error: 'task 只能是 hanime 或 tmdb' });
  }
  // ⛔ 不 await —— 抓取要几十秒到几分钟，同步等会拖住 HTTP 连接
  //   ⇒ 立即返回「已启动」，前端轮询 /api/scheduler/records 看结果
  void scheduler.runNow(task as TaskName).catch((err) => {
    app.log.error({ err: String(err) }, '手动扫描失败');
  });
  return { ok: true, started: true, task };
});

/** 执行记录（最近 30 条，新的在前） */
app.get('/api/scheduler/records', async () => ({
  ok: true,
  records: scheduler.getRecords(),
}));

// ── 图片静态资源 ────────────────────────────────────────────────
const imageRoot = resolve(config.dbPath, '..', 'images');
if (existsSync(imageRoot)) {
  await app.register(fastifyStatic, { root: imageRoot, prefix: '/images/', decorateReply: false });
  app.log.info({ imageRoot }, '已挂载图片静态资源');
}

// ── 静态资源（前端构建产物） ────────────────────────────────────
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });

  /* 待人工审核看板（单文件 HTML，数据内嵌，无需后端接口）
     路由：/review/ 与 /review —— 与主看板物理隔离，互不影响。
     ⚠️ 用户要求「我和你一起找规律」，所以必须能直接从局域网打开。 */
  const reviewPage = resolve(config.webDist, 'review', 'index.html');
  if (existsSync(reviewPage)) {
    await app.register(fastifyStatic, {
      root: resolve(config.webDist, 'review'),
      prefix: '/review/',
      decorateReply: false,
    });
    app.log.info({ reviewPage }, '已挂载待人工审核看板 /review/');
  } else {
    app.log.warn({ reviewPage }, '审核看板不存在，需执行 scripts/build_review_board.mjs');
  }

  /* 未确定匹配看板（单文件 HTML，数据内嵌，无需后端接口）
     路由：/unconfirmed/ 与 /unconfirmed
     与主看板物理隔离：主看板展示 `is_quarantined=0` 的**已确定**条目，
     本页展示 `source_work.status IN ('pending','orphan')` 的**未确定**记录
     （它们没有 work_id、没有 TMDB 条目，塞进主看板会污染既有口径）。
     数据由 scripts/build_unconfirmed_board.py 生成。 */
  const unconfirmedPage = resolve(config.webDist, 'unconfirmed', 'index.html');
  if (existsSync(unconfirmedPage)) {
    await app.register(fastifyStatic, {
      root: resolve(config.webDist, 'unconfirmed'),
      prefix: '/unconfirmed/',
      decorateReply: false,
    });
    app.log.info({ unconfirmedPage }, '已挂载未确定匹配看板 /unconfirmed/');
  } else {
    app.log.warn({ unconfirmedPage }, '未确定看板不存在，需执行 scripts/build_unconfirmed_board.py');
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: '接口不存在' });
    }
    if (req.url === '/review' || req.url === '/review/') return reply.sendFile('review/index.html');
    if (req.url === '/unconfirmed' || req.url === '/unconfirmed/') {
      return reply.sendFile('unconfirmed/index.html');
    }
    return reply.sendFile('index.html');
  });
  app.log.info({ webDist: config.webDist }, '已挂载前端静态资源');
} else {
  app.log.warn({ webDist: config.webDist }, '前端构建产物不存在，仅提供 API（M5 阶段完善）');
}

// ── 登录页路由 ──────────────────────────────────────────────────

/** 从 Cookie 头取指定值 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** 客户端 IP（反代场景取 XFF 首段） */
function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}

/** 登录页 */
app.get('/login', async (req, reply) => {
  const q = req.query as { next?: string; e?: string; ra?: string };
  const retryAfterSec = Number(q.ra || 0);
  const lock = auth.locked(clientIp(req));
  return reply.type('text/html; charset=utf-8').send(
    loginPage({
      next: safeNext(q.next),
      error: q.e ? decodeURIComponent(q.e) : lock.locked
        ? `登录失败次数过多，请 ${lock.retryAfterSec} 秒后再试`
        : '',
      retryAfterSec: lock.locked ? lock.retryAfterSec : retryAfterSec,
    }),
  );
});

/** 只允许站内相对路径，防开放重定向 */
function safeNext(n: string | undefined): string {
  if (!n) return '/';
  if (!n.startsWith('/') || n.startsWith('//')) return '/';
  return n;
}

/** 提交登录 */
app.post('/login', async (req, reply) => {
  const body = (req.body ?? {}) as { username?: string; password?: string; next?: string };
  const ip = clientIp(req);

  const lock = auth.locked(ip);
  if (lock.locked) {
    return reply.code(429).type('text/html; charset=utf-8').send(
      loginPage({
        next: safeNext(body.next),
        error: `登录失败次数过多，请 ${lock.retryAfterSec} 秒后再试`,
        retryAfterSec: lock.retryAfterSec,
      }),
    );
  }

  const ok = auth.verify(body.username ?? '', body.password ?? '');
  if (!ok) {
    const left = auth.recordFail(ip);
    req.log.warn({ ip, left }, '登录失败');
    return reply.code(401).type('text/html; charset=utf-8').send(
      loginPage({
        next: safeNext(body.next),
        error: `账号或密码错误（再错 ${Math.max(left, 0)} 次锁定 IP）`,
        retryAfterSec: 0,
      }),
    );
  }

  auth.clearFails(ip);
  const token = auth.create(ip);
  auth.setCookie(reply, token, isSecureRequest(req));
  req.log.info({ ip }, '登录成功');
  return reply.code(302).header('Location', safeNext(body.next)).send();
});

/** 登出 */
app.post('/api/logout', async (req, reply) => {
  auth.logout(readCookie(req.headers.cookie, authCfg.cookieName));
  auth.clearCookie(reply, isSecureRequest(req));
  return { ok: true };
});

// ── 启动 ────────────────────────────────────────────────────────
const problems = validateConfig();
if (problems.length) {
  app.log.warn({ problems }, '配置自检发现问题（当前阶段非阻塞）');
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `里番缺口看板 ${MILESTONE} 已启动 → http://${config.host}:${config.port}\n` +
      `数据库: ${config.dbPath}\n` +
      `下一步: M2 TMDB 采集模块`,
  );
} catch (err) {
  app.log.error({ err: String(err) }, '启动失败');
  process.exit(1);
}

// ── ⭐ 启动定期更新调度器（§79）──────────────────────────────
// 🔴 放在 listen 之后 —— 监听失败就别启调度器（免得白跑）
updateService.start();
const scfg = scheduler.getConfig();
app.log.info(
  {
    hanimeCron: scfg.hanimeCron,
    tmdbCron: scfg.tmdbCron,
    enabled: scfg.enabled,
    hanimeYears: scfg.hanimeYears,
    nextHanime: scfg.nextRuns.hanime,
    nextTmdb: scfg.nextRuns.tmdb,
    errors: scfg.errors,
  },
  '定期更新调度器已启动',
);

// ── 优雅退出 ────────────────────────────────────────────────────
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, '收到退出信号，关闭数据库连接');
    try {
      updateService.stop();
      db.close();
      await app.close();
    } finally {
      process.exit(0);
    }
  });
}