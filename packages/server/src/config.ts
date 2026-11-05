/**
 * 配置加载
 *
 * ⭐ §157（2026-11-05）配置中心：受管字段改成 **getter 活读**，
 *    优先级 = app_config 表（看板设置页保存的） > 环境变量 > 代码默认值。
 *    看板上改完立即生效，不重启容器。未受管的字段保持启动快照不变。
 */
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ovBool, ovNum, ovStr } from './config_overrides.js';

/**
 * 仓库根目录定位
 *
 * ⚠️ 不能用 process.cwd() —— 实测踩坑：
 *   从仓库根跑 `node packages/server/dist/index.js` 与
 *   从 packages/server 跑，cwd 不同，同一 env 配置会解析到不同路径，
 *   导致「数据库写了一个地方、查的是另一个地方」（本次实际发生，
 *   采集 1284 部后查库为空）。
 *
 * 改为从本文件位置向上找 name=hifan-dashboard 的 package.json，
 * 保证任何 cwd 下解析一致。
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === 'hifan-dashboard') return dir;
      } catch {
        /* 读不到就继续向上 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

/** 全项目唯一版本源 = 根 package.json 的 version（CHANGELOG 与它对齐） */
function readPkgVersion(): string {
  try {
    const p = JSON.parse(readFileSync(resolve(repoRoot(), 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return p.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readPkgVersion();

function num(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function str(key: string, def: string): string {
  return process.env[key]?.trim() || def;
}

export const config = {
  /** 服务监听 */
  port: num('PORT', 8848),
  host: str('HOST', '0.0.0.0'),

  /**
   * 数据库路径
   * ⚠️ 生产必须落 /vol1 —— 见 docs/开发文档.md §2.4
   * 默认值故意指向本地 ./data（开发用），生产由 env 覆盖
   */
  dbPath: str('DB_PATH', resolve(repoRoot(), 'data', 'hifan.db')),

  /** TMDB（apiKey / proxy / baseUrl / rateLimitMs 受管：看板设置页可改，立即生效） */
  tmdb: {
    get apiKey(): string {
      return ovStr('tmdb.apiKey', 'TMDB_API_KEY', '');
    },
    /**
     * 代理：实测大陆直连 api.themoviedb.org 超时
     * 容器内可通过 host.docker.internal 或网段地址访问宿主机代理
     */
    get proxy(): string {
      return ovStr('tmdb.proxy', 'TMDB_PROXY', '');
    },
    /** 官方地址；用镜像/反代时在设置页改 */
    get baseUrl(): string {
      return ovStr('tmdb.baseUrl', 'TMDB_BASE_URL', 'https://api.themoviedb.org/3');
    },
    /** 限流：0.25 秒/请求（实测 TMDB 容忍值）；被 429 时设置页调大 */
    get rateLimitMs(): number {
      return Math.max(0, ovNum('tmdb.rateLimitMs', 'TMDB_RATE_LIMIT_MS', 250));
    },
    /** 详情接口偶发超时，重试次数 */
    maxRetries: num('TMDB_MAX_RETRIES', 3),
    // ⭐ §158：原 hentaiKeywordId 已删除 —— 服务端从不读它，
    //   真正消费 TMDB_HENTAI_KEYWORD_ID 的是采集器（packages/collector/src/cli.ts）。
  },

  /** NAS 扫描 —— 严格只读 */
  scan: {
    /** 里番库根路径（位于 rclone 挂载上，只读）· 受管，改后需重建容器 */
    get libraryRoot(): string {
      return ovStr('scan.libraryRoot', 'SCAN_LIBRARY_ROOT', '/library');
    },
    /** 必须排除的目录名 —— 防止递归进云挂载（受管，热生效） */
    get excludeDirs(): string[] {
      return ovStr('scan.excludeDirs', 'SCAN_EXCLUDE_DIRS', 'CloudDrive,115网盘挂载,@eaDir')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    /** 扫描时跨文件系统（false = 不跨，安全） */
    crossDevice: str('SCAN_CROSS_DEVICE', 'false') === 'true',
  },

  /**
   * ⭐ §79 定期更新检测（看板设置页驱动）
   *
   * 🔴 FlareSolverr：容器内走宿主网关（实测 host.docker.internal:28191 可达）
   * 🔴 代理：FlareSolverr 侧使用（容器内直连源站会超时）
   */
  hanime: {
    get flaresolverr(): string {
      return ovStr('hanime.flaresolverr', 'FLARESOLVERR', 'http://host.docker.internal:28191/v1');
    },
    get proxy(): string {
      // 默认空 = 直连；自建者须在设置面板填自己的节点（env 有值则自动种子进面板）
      return ovStr('hanime.proxy', 'HANIME_PROXY', '');
    },
  },

  /**
   * ⭐ §79 企业微信推送（受管：设置页可改，立即生效）
   *
   * 🔴 relayUrl = 宿主侧转发器（scripts/wecom_relay.py）
   *    拓扑：看板容器 → 宿主 host.docker.internal:9098 → 172.31.0.3:9097 → 企微
   *    （看板容器直连 172.31.0.3:9097 会超时 —— 两个 docker 网段不互通）
   */
  wecom: {
    get relayUrl(): string {
      return ovStr('wecom.relayUrl', 'WECOM_RELAY_URL', 'http://host.docker.internal:9098/push');
    },
    get enabled(): boolean {
      return ovBool('wecom.enabled', 'WECOM_ENABLED', true);
    },
    /** 转发器共享密钥（secret：面板只显示「已设置」，值不落日志） */
    get relayToken(): string {
      return ovStr('wecom.relayToken', 'WECOM_RELAY_TOKEN', '');
    },
  },

  /**
   * ⭐ §158 访问认证（受管：设置页可改，下次登录立即生效）
   *
   * 原实现在 auth.ts 里直读 process.env，且是**构造时快照** ——
   * 改密码必须重启容器，与「面板保存即生效」的承诺不一致。
   * 收编进配置中心后，readAuthConfig() 每次现读 getter。
   */
  auth: {
    /** 登录用户名；空 = 未启用登录（内网模式） */
    get user(): string {
      return ovStr('auth.user', 'HIFAN_USER', '');
    },
    /** 登录密码；空 = 未启用登录 */
    get pass(): string {
      return ovStr('auth.pass', 'HIFAN_PASS', '');
    },
    cookieName: str('HIFAN_COOKIE', 'hifan_session'),
    ttlMs: Number(str('HIFAN_SESSION_TTL_MS', '604800000')) || 604_800_000,
  },

  /**
   * ⭐ §85 hanime 下载（2026-10-29）
   * ⭐ §88 多通道（2026-10-30 重测，结论已改写）
   *
   * ## 🔴 2026-10-30 实测（作者问「能否不走代理，机场 15G 不够用」）
   * | 通道 | 成功率 | 速度 |
   * |---|---|---|
   * | 直连 hembed | 10/12（83%） | 5.8 MB/s（偶发 39.8） |
   * | 走代理 | 5/5（100%） | 6.1 MB/s |
   * ⇒ **代理不提速**，只是「打通被 RST 的连接」⇒ 默认 **直连优先**，
   *   只有失败的 17% 才消耗机场流量。
   *
   * ## ⚠️ 2026-10-29 那条「容器直连 hembed 不通」的记录**已作废**
   * 当时是真踩到（容器无 IPv6 路由，DNS 先返 v6 ⇒ Network unreachable），
   * 但 Node 的 `autoSelectFamily` 会自动回落 IPv4 ⇒ 现在直连是通的。
   * 保留这段是为了记住「别用旧结论覆盖新实测」。
   *
   * ## 多机场
   * `DL_PROXY` 支持逗号分隔多个：`http://a:7890,http://b:7890`
   * 顺序 = 降级顺序。第一个失败了试第二个。
   * 每个通道消耗多少流量，看板「下载」页有统计（按 work_dl.channel 分组）。
   */
  download: {
    /** 代理地址（空 = 只直连）。⭐ 支持逗号分隔多个，按顺序降级 */
    get proxy(): string {
      return ovStr('download.proxy', 'DL_PROXY', str('HANIME_PROXY', ''));
    },
    /** ⭐ 直连优先（默认 true）。false = 只用代理 */
    get directFirst(): boolean {
      return ovBool('download.directFirst', 'DL_DIRECT_FIRST', true);
    },
    /** 落盘根目录（容器内路径）—— 候选宿主路径见 compose · 受管，改后需重建容器 */
    get root(): string {
      return ovStr('download.root', 'DL_ROOT', '/downloads');
    },
    /** 落盘子目录 —— 作者拍板：待整理 · 受管，改后需重建容器 */
    get subdir(): string {
      return ovStr('download.subdir', 'DL_SUBDIR', '待整理');
    },
    /** 队列 worker 是否随服务启动自动跑 */
    /** 队列 worker 是否随服务启动自动跑 · 受管（改了要重建容器才重跑启动逻辑） */
    get workerAutoStart(): boolean {
      return ovBool('download.workerAutoStart', 'DL_WORKER_AUTOSTART', true);
    },
    /** 每集最多试几次（含第一次）· 受管，热生效 */
    get maxAttempts(): number {
      return Math.max(1, ovNum('download.maxAttempts', 'DL_MAX_ATTEMPTS', 2));
    },
    /**
     * ⭐ 落盘盘剩余空间下限（GB）—— 低于就自动停队列。
     * 🔴 一集 250MB，整部 3GB；cifs 盘写满会把 SQLite 一起搞坏。
     */
    get minFreeGb(): number {
      return Math.max(0, ovNum('download.minFreeGb', 'DL_MIN_FREE_GB', 20));
    },
    /**
     * ⭐ §90 IP 成败记忆（哪个 IP 能通 / 被 RST）。
     * 放 data/ 下 ⇒ 容器重启不丢；CDN 的节点状态是变化的，TTL 30 分钟。
     */
    ipMemPath: str('DL_IPMEM_PATH', resolve(repoRoot(), 'data', 'dl_ipmem.json')),
    /**
     * ⭐ §90 运行时设置（目前只有 proxyMode）。
     * 🔴 单独落文件而不是走环境变量 —— 看板上改完要**立即生效**，不能重建容器。
     */
    settingsPath: str('DL_SETTINGS_PATH', resolve(repoRoot(), 'data', 'dl_settings.json')),
  },

  /**
   * ⭐ §92 自研刮削入库（2026-10-30）—— **不依赖 MoviePilot**
   *
   * ## 背景（同一天两次改口，以第二次为准）
   * ①「把 MP 那套流程搬进看板」⇒ 先做成「驱动 MP」；
   * ②「**我不想你调用 MP 刮削**，和 MP 分开」⇒ 改成自己实现：
   *    自己打 TMDB、自己写 nfo、自己下图片、自己复制落位（`scrape.ts`）。
   *
   * ## 为什么媒体库根目录这样挂
   * 115 是通过 CloudDrive2（CloudFS）挂载到宿主：
   *   /115挂载父目录/CloudDrive/影视/影视资源/大电影/里番
   * ⇒ compose 里只把**父目录** `/115挂载父目录` 挂进容器 `/library`。
   *   🔴 ⛔ 不挂 CloudDrive 本身：那是 FUSE 挂载点，NAS 重启后若没恢复，
   *      Docker 创建挂载源会失败 ⇒ 容器起不来（2026-10-28 真踩，exit 255）。
   *      挂父级普通目录则最坏情况只是「目录空的」，容器照常起，接口如实报不可写。
   */
  scrape: {
    /** 媒体库根目录（容器内）—— 与 compose 的 /library 对应 · 受管，改后需重建容器 */
    get libraryRoot(): string {
      return ovStr(
        'scrape.libraryRoot',
        'SCRAPE_LIBRARY_ROOT',
        '/library/CloudDrive/影视/影视资源/大电影/里番',
      );
    },
    /** 图片基址（TMDB 图床；裸路径不需要 key） */
    imageBase: str('SCRAPE_IMAGE_BASE', 'https://image.tmdb.org/t/p'),
    /**
     * 🔴 F24：单集复制**「无进展」超时**（毫秒）—— ⛔ 不是单集刮削总时长。
     *
     *   复制 = `pipeline(read 115/CloudDrive 挂载 → write 媒体库)`，FUSE 不响应时
     *   这个 await **永不 resolve**；ingest worker 又是单并发（busy 锁）
     *   ⇒ 一集卡住 = 整条队列停摆、日志无任何报错、只能重启容器。
     *   原先这里是 `SCRAPE_TIMEOUT_MS`，注释承诺「含复制 250MB」，但全代码零消费（死配置）。
     *
     *   ⛔ 别按「总时长」判：§99 本地盘来源一上，单集 1~2GB 在 115 限速下
     *      合法跑超过这个值很常见 ⇒ 会把正常复制杀掉重来，白烧流量。
     *      按「目标 .part 多久一点没长」判，慢但有进展就不会被误杀。
     *   旧变量 `SCRAPE_TIMEOUT_MS` 仍兼容读入（NAS .env 里可能已设过），新变量优先。
     */
    get copyStallMs(): number {
      return Math.max(
        10_000,
        ovNum('scrape.copyStallMs', 'SCRAPE_COPY_STALL_MS', num('SCRAPE_TIMEOUT_MS', 300_000)),
      );
    },
    /** 落库后通知 Emby 刷新该库（best-effort） */
    get embyRefresh(): boolean {
      return ovBool('scrape.embyRefresh', 'SCRAPE_EMBY_REFRESH', true);
    },
    /** 单集最多试几次 */
    get maxAttempts(): number {
      return Math.max(1, ovNum('scrape.maxAttempts', 'SCRAPE_MAX_ATTEMPTS', 3));
    },
    /** 入库 worker 是否随服务启动自动跑 */
    /** 入库 worker 是否随服务启动自动跑 · 受管（改了要重建容器） */
    get workerAutoStart(): boolean {
      return ovBool('scrape.workerAutoStart', 'SCRAPE_WORKER_AUTOSTART', true);
    },
    /**
     * 🔴 N2：允许把「库根不存在(ENOENT)」当**新库**处理。
     * 默认 false —— 只要库里有过成功入库记录，库根读不出来就必须判「挂载没就绪」并停下来，
     * 否则 mkdir 会把目录建到 CloudDrive 挂载点底下的真实磁盘，挂载恢复后被遮蔽（静默丢文件）。
     * 非要把库挪到新路径 / 推倒重来时，才显式置 true。
     */
    get allowNewRoot(): boolean {
      return ovBool('scrape.allowNewRoot', 'SCRAPE_ALLOW_NEW_ROOT', false);
    },
    /**
     * 🔴🔴 strm 库根目录（容器内）—— **验收用的产物目录**。
     *
     * 作者 2026-10-30 报的现象：「你调 CMS 太快，文件还没落盘你就调，
     * 导致 strm 根本没生成，第二次增量才生成视频文件」。
     * 我们写进 115 挂载点只是本地落盘完成，CloudDrive 还要**异步上传**到 115 云端；
     * CMS 那一刻去拉 115 列表可能还看不到文件 ⇒ 同步返回成功但什么都没生成。
     * ⇒ compose 把宿主 `/strm库` **只读**挂到容器 `/strm`，
     *   入库后按 `<dest 去掉 /CloudDrive>` 换成 `.strm` 去**看文件在不在**，
     *   不在就按退避再触发同步（这才是真判据，不是「接口返回成功」）。
     * 置空 = 不验证（只剩「触发成功」这种自证指标）。
     */
    /** 受管：留空 = 不做 strm 落盘验证；改后需重建容器（容器内挂载路径） */
    get strmRoot(): string {
      return ovStr('scrape.strmRoot', 'SCRAPE_STRM_ROOT', '/strm');
    },
  },

  /**
   * CMS（cloud-media-sync）—— 入库的**第二步**，必须它来做。
   *
   * 我们刮削只把真文件 + nfo + 图片写进 115 原件目录；
   * **Emby 真正读的是 CMS 生成的 strm 库**（`/strm库`）。
   * strm 里是 `https://cms.example.com:16666/d/<115 fileid>`，那个 fileid
   * 只有 CMS 拿得到 ⇒ 所以入库收工时触发它跑一次增量同步即可（§93-3）。
   *
   * 默认地址 `172.17.0.1:9528`：CMS 是 host 网络，看板容器里
   * `127.0.0.1` 指自己（不通），docker0 网桥宿主侧才是它。
   * ⛔ 不要配 `/api/sync/full`（全量同步会把 115 整个重扫一遍）。
   */
  cms: {
    get baseUrl(): string {
      return ovStr('cms.baseUrl', 'CMS_BASE_URL', 'http://172.17.0.1:9528');
    },
    get user(): string {
      return ovStr('cms.user', 'CMS_USER', '');
    },
    get pass(): string {
      return ovStr('cms.pass', 'CMS_PASS', '');
    },
    /** 入库收工后是否自动触发（false = 只显示状态，不触发）· 受管，热生效 */
    get autoSync(): boolean {
      return ovBool('cms.autoSync', 'CMS_AUTO_SYNC', true);
    },
    timeoutMs: Math.max(3000, Number(str('CMS_TIMEOUT_MS', '15000')) || 15_000),
    /** ⭐ §155 入库通知过滤：上游 webhook 地址（看板可改） */
    get webhookUrl(): string {
      return ovStr('cms.webhookUrl', 'CMS_WEBHOOK_URL', '');
    },
    /**
     * ⭐ §158 入库通知过滤器的访问 token（原为 index.ts 里硬编码 'hifan-filter'）
     * Emby 那边配的 webhook URL 里带的 token 必须与这里一致，否则一律 401。
     */
    get filterToken(): string {
      return ovStr('cms.filterToken', 'CMS_FILTER_TOKEN', 'hifan-filter');
    },
    /** ⭐ §155 成人内容路径关键词（逗号分隔，看板可改） */
    get nsfwPaths(): string {
      return ovStr('cms.nsfwPaths', 'CMS_NSFW_PATHS', '/里番/,/日本av/');
    },
  },

  /**
   * ⭐ §157 Emby 连接（原散在 emby_scan.ts / scrape.ts 的 process.env 直读，
   * 收编进配置中心 ⇒ 看板设置页可改，立即生效）
   */
  emby: {
    get base(): string {
      return ovStr('emby.base', 'EMBY_BASE', 'http://host.docker.internal:8096').replace(/\/+$/, '');
    },
    get apiKey(): string {
      return ovStr('emby.apiKey', 'EMBY_API_KEY', '');
    },
    get libId(): string {
      return ovStr('emby.libId', 'EMBY_LIB_ID', '196470');
    },
    get adminUid(): string {
      return ovStr('emby.adminUid', 'EMBY_ADMIN_UID', '');
    },
  },

  /** 调度器配置文件（持久化用户改的 cron） */
  schedulerConfigPath: str(
    'SCHEDULER_CONFIG_PATH',
    resolve(repoRoot(), 'data', 'scheduler.json'),
  ),

  /** Web 静态资源目录 */
  webDist: str('WEB_DIST', resolve(repoRoot(), 'web')),
} as const;

/** 启动前的配置自检 —— 缺关键项直接拒绝启动，不留半残状态 */
export function validateConfig(): string[] {
  const problems: string[] = [];

  if (!config.tmdb.apiKey) {
    problems.push('TMDB_API_KEY 未设置 —— 采集器无法工作（当前阶段可容忍，启用 M2 前必须补）');
  }
  if (!config.tmdb.proxy) {
    problems.push('TMDB_PROXY 未设置 —— 实测大陆直连 api.themoviedb.org 会超时（当前阶段可容忍）');
  }

  const db = resolve(config.dbPath);
  if (db.startsWith('/vol02')) {
    problems.push(`DB_PATH=${db} 位于 /vol02 —— 网络挂载不支持文件锁，会损坏数据库`);
  }

  return problems;
}