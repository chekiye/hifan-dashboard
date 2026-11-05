/**
 * ⭐ §157（2026-11-05）配置中心 —— 运行时覆盖层
 * ⭐ §158 扩面：路径 / 行为开关 / 推送 / 访问认证 全部纳入
 * ⭐ §159 重构成「卡片」模型：告别人话化、按归属卡片分组、高级项折叠
 *
 * ## 为什么有这一层
 * `config.ts` 是环境变量快照，改了必须重建容器。
 * 发版给别人自建后，代理 / TMDB key / Emby / CMS 这些不该逼人去改 compose，
 * 作者拍板：「把能设置的都放在设置面板上，compose 越简洁越好」。
 *
 * ## 优先级（读任何受管配置都走这个顺序）
 *   app_config 表（看板保存的） > 环境变量（compose/.env） > 代码默认值
 *
 * ## 生效方式
 * 看板保存 → 写表 → 更新内存 Map ⇒ 立即生效，不重启容器。
 * config.ts 里受管字段全部改成 getter，每次读取现查这个 Map。
 *
 * ## 两类键（**别在 UI 上骗人**）
 * - 默认（热）：连接 / 开关 / 限额 —— 保存即生效
 * - `restart: true`：路径 / 端口这类在进程启动时就绑定死的 —— 保存进库，
 *   **重建容器后**才用到新值。面板上会明确标「需重建容器」。
 *
 * ## 种子（seed）
 * 启动时把「表里没有、但 env 里有值」的键写进表 —— 这样：
 * ① 设置面板首次打开就能看到现网真实值（而不是空白）；
 * ② compose 之后可以放心瘦身（值已经固化到库里，删掉 env 行不丢配置）。
 *
 * ## §159 卡片模型（为什么不再用 group）
 * 旧版把 38 个键平铺成 9 个「分组」，用户看到的是 38 个输入框 —— 作者原话
 * 「完全就是无脑堆设置，不管别人会不会设置」。
 * 现在每个键归属一张**卡片**（card），卡片挂在**标签页**（tab）下：
 *   连接(network/tmdb/emby/cms) · 目录(3 张) · 任务(3 张) · 通知(2 张) · 系统(2 张)
 * 一级界面只画卡片 + 状态灯，字段全部收进「点开卡片」的弹窗。
 */
import type { DB } from '@hifan/core';

/** 内存覆盖缓存：key → value（一律字符串；布尔/数字由读取方转换） */
const overrides = new Map<string, string>();

let dbRef: DB | null = null;
let loaded = false;

/** 表存在吗（线上可能还没跑建表；缺失时按空覆盖层处理） */
function hasTable(db: DB): boolean {
  try {
    return Boolean(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='app_config'",
      ).get(),
    );
  } catch {
    return false;
  }
}

/**
 * 启动时注入 db 实例：建表（如缺）→ 种子（env 有值而表里没有的键写进表）→ 加载内存
 */
export function initOverrides(db: DB): void {
  dbRef = db;
  loaded = true;
  try {
    if (!hasTable(db)) {
      db.exec(
        'CREATE TABLE IF NOT EXISTS app_config (' +
          'key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
    }

    /* 种子：env 有值、表里没有 ⇒ 写进表（让面板首次打开就是现网值） */
    if (hasTable(db)) {
      const now = new Date().toISOString();
      const ins = db.prepare(
        'INSERT INTO app_config(key, value, updated_at) VALUES(?, ?, ?) ' +
          'ON CONFLICT(key) DO NOTHING',
      );
      for (const d of CONFIG_KEYS) {
        const env = process.env[d.envKey]?.trim();
        if (env) ins.run(d.key, env, now);
      }
    }
  } catch {
    /* 建表/种子失败不阻塞启动 —— 覆盖层退化为一空 Map */
  }
  reloadOverrides();
}

/** 从表里重新加载到内存（保存后、以及启动时都走它） */
export function reloadOverrides(): void {
  overrides.clear();
  if (!dbRef) return;
  try {
    if (!hasTable(dbRef)) return;
    const rows = dbRef.prepare('SELECT key, value FROM app_config').all() as Array<{
      key: string;
      value: string;
    }>;
    for (const r of rows) {
      if (typeof r.key === 'string' && typeof r.value === 'string') {
        overrides.set(r.key, r.value);
      }
    }
  } catch {
    /* 读失败 ⇒ 维持空覆盖层 */
  }
}

/** 读覆盖层（没有 / 空串 = undefined，调用方回落 env/默认） */
export function getOverride(key: string): string | undefined {
  if (!loaded) return undefined;
  const v = overrides.get(key);
  return v === '' ? undefined : v;
}

/** 覆盖层里有没有这个键（含「已清空」状态，用于面板显示） */
export function hasOverride(key: string): boolean {
  return loaded && overrides.has(key);
}

/** 写/清一个键（value 为空串 = 清除覆盖，回到 env/默认） */
export function setOverride(key: string, value: string): void {
  if (!dbRef) throw new Error('配置中心未初始化（db 未注入）');
  if (!hasTable(dbRef)) {
    dbRef.exec(
      'CREATE TABLE IF NOT EXISTS app_config (' +
        'key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
  }
  if (value === '') {
    dbRef.prepare('DELETE FROM app_config WHERE key = ?').run(key);
  } else {
    dbRef
      .prepare(
        'INSERT INTO app_config(key, value, updated_at) VALUES(?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, new Date().toISOString());
  }
  reloadOverrides();
}

/* ═══════════════════════════════════════════════════════════════
   §159 卡片 / 标签页模型
   ⚠️ secret 字段：GET 回传只给「是否已设置」，值永不回传前端。
   ⚠️ restart 字段：面板标「需重建容器」，别让用户以为保存就生效了。
   ⚠️ advanced 字段：不出现在卡片详情里，收进「系统 → 高级参数」。
   ⚠️ hidden 字段：完全不进 UI（死配置 / 待删）。
   ═══════════════════════════════════════════════════════════════ */

/** 设置页的五个标签页 */
export type TabId = 'connect' | 'dirs' | 'tasks' | 'notify' | 'system';

/** 每张卡片的归属（卡片 = 一级界面上的一个方块） */
export type CardId =
  | 'network'
  | 'tmdb'
  | 'emby'
  | 'cms'
  | 'dir_library'
  | 'dir_download'
  | 'dir_strm'
  | 'task_download'
  | 'task_scrape'
  | 'wecom'
  | 'filter'
  | 'auth';

export interface CardMeta {
  id: CardId;
  tab: TabId;
  /** 卡片标题 */
  name: string;
  /** 角色一句话（卡片标题右侧的小字） */
  role: string;
  /** 这张卡是干什么的（弹窗副标题） */
  desc: string;
  /** 探活走哪个键（状态灯用；没有就不探活） */
  probeKey?: string;
}

/**
 * 卡片清单（顺序 = 界面顺序）。
 * 🔴 mteam / 任务扫描 这两张卡没有受管键（数据来自离线脚本 / scheduler.json），
 *    所以不在这里 —— 前端单独渲染，别为了统一把只读信息硬塞成「配置项」。
 */
export const CARDS: CardMeta[] = [
  { id: 'network', tab: 'connect', name: '网络与代理', role: '全局',
    desc: '三处要连外网的地方通常填同一个代理，所以放一起配。',
    probeKey: 'tmdb.proxy' },
  { id: 'tmdb', tab: 'connect', name: 'TMDB', role: '元数据源',
    desc: '作品名、封面、集数都从它来。',
    probeKey: 'tmdb.apiKey' },
  { id: 'emby', tab: 'connect', name: 'Emby', role: '媒体服务器',
    desc: '入库完成后通知它刷新，新片立刻出现在播放器里。',
    probeKey: 'emby.base' },
  { id: 'cms', tab: 'connect', name: 'CMS', role: '入库下游',
    desc: 'cloud-media-sync，负责生成 strm 让 115 的片子能在 Emby 播放。',
    probeKey: 'cms.baseUrl' },

  { id: 'dir_library', tab: 'dirs', name: '媒体库', role: '写入',
    desc: '整理好的片子放这里，也是 Emby 扫描的目录。',
    probeKey: 'scrape.libraryRoot' },
  { id: 'dir_download', tab: 'dirs', name: '下载目录', role: '写入',
    desc: '下载中的文件先落这里，整理完再搬去媒体库。',
    probeKey: 'download.root' },
  { id: 'dir_strm', tab: 'dirs', name: 'strm 校验目录', role: '只读',
    desc: '确认入库后 strm 真的生成了。不填也能跑。',
    probeKey: 'scrape.strmRoot' },

  { id: 'task_download', tab: 'tasks', name: '下载队列', role: '后台任务',
    desc: '把待下的片子一部部下下来，下完自动进整理。' },
  { id: 'task_scrape', tab: 'tasks', name: '入库队列', role: '后台任务',
    desc: '把下载好的文件改名、归位、生成 strm。' },

  { id: 'wecom', tab: 'notify', name: '企业微信', role: '通知渠道',
    desc: '新番、入库完成、任务失败都推给你。',
    probeKey: 'wecom.relayUrl' },
  { id: 'filter', tab: 'notify', name: '入库通知过滤', role: '规则',
    desc: '命中关键词的剥掉封面图再转发，避免在企微里弹图。' },

  { id: 'auth', tab: 'system', name: '访问认证', role: '安全',
    desc: '只在公网访问时需要，局域网直连可以不设。' },
];

export interface ConfigKeyDef {
  key: string;
  envKey: string;
  /** 归属卡片 */
  card: CardId;
  /** 人话标题（用户看得懂的，不是变量名） */
  label: string;
  /** 输入控件类型（默认 text）；password 走掩码 + 留空不覆盖 */
  type?: 'text' | 'password' | 'number' | 'boolean';
  /** password = 面板掩码显示、留空不覆盖 */
  secret?: boolean;
  /** 改完要重建容器才生效（路径类） */
  restart?: boolean;
  /** 收进「系统 → 高级参数」，不占卡片详情的位置 */
  advanced?: boolean;
  /** 完全不进 UI（死配置 / 待确认删除） */
  hidden?: boolean;
  placeholder?: string;
  /** 一句话说清「这是什么 / 改了会怎样」，用户看不懂就别写 */
  help?: string;
  min?: number;
  max?: number;
  /** 路径类：前端给一个「浏览」按钮，点开树形目录选择器 */
  pick?: 'dir';
}

export const CONFIG_KEYS: ConfigKeyDef[] = [
  /* ── 网络与代理 ───────────────────────────────────────────── */
  { key: 'tmdb.proxy', envKey: 'TMDB_PROXY', card: 'network',
    label: '代理地址', placeholder: 'http://host.docker.internal:7890',
    help: '大陆直连 TMDB 会超时，这里填你的代理（Clash 的 mixed 端口通常就是 7890）。留空 = 直连' },
  { key: 'hanime.proxy', envKey: 'HANIME_PROXY', card: 'network',
    label: 'hanime 专用代理', placeholder: '留空 = 跟随上面的代理',
    help: '只有 hanime 需要走别的节点时才填；平时留空就行' },
  { key: 'download.proxy', envKey: 'DL_PROXY', card: 'network',
    label: '下载专用代理', placeholder: '留空 = 跟随上面的代理',
    help: '下视频走的通道。默认先直连（不耗机场流量），失败了才走代理；多个代理用逗号隔开' },
  { key: 'hanime.flaresolverr', envKey: 'FLARESOLVERR', card: 'network',
    label: 'FlareSolverr 地址', placeholder: 'http://host.docker.internal:28191/v1',
    help: 'hanime 有 Cloudflare 验证，靠它绕过。自己起一个容器后填地址' },

  /* ── TMDB ────────────────────────────────────────────────── */
  { key: 'tmdb.apiKey', envKey: 'TMDB_API_KEY', card: 'tmdb', secret: true, type: 'password',
    label: 'API Key', placeholder: '32 位十六进制字符串',
    help: '在 themoviedb.org 注册 → 设置 → API → 申请（免费）。这是整个看板最关键的配置' },
  { key: 'tmdb.baseUrl', envKey: 'TMDB_BASE_URL', card: 'tmdb',
    label: '接口地址', placeholder: 'https://api.themoviedb.org/3',
    help: '用镜像或反代时才改；默认官方地址，一般不用动' },
  { key: 'tmdb.rateLimitMs', envKey: 'TMDB_RATE_LIMIT_MS', card: 'tmdb', type: 'number', min: 0, max: 5000, advanced: true,
    label: '请求间隔（毫秒）', placeholder: '250',
    help: '两次请求之间等多久。默认 250 毫秒；被限流（429）时调大' },

  /* ── Emby ─────────────────────────────────────────────────── */
  { key: 'emby.base', envKey: 'EMBY_BASE', card: 'emby',
    label: '服务器地址', placeholder: 'http://NAS局域网IP:8096',
    help: 'Emby 的访问地址。容器里访问宿主机用 host.docker.internal 或 172.17.0.1 —— 写 localhost 会连到容器自己' },
  { key: 'emby.apiKey', envKey: 'EMBY_API_KEY', card: 'emby', secret: true, type: 'password',
    label: 'API Key', placeholder: 'Emby 后台 → 高级 → API 密钥 → 新建',
    help: '扫库和入库后刷新都靠它。在 Emby 控制台生成，不是账号密码' },
  { key: 'emby.libId', envKey: 'EMBY_LIB_ID', card: 'emby',
    label: '媒体库 ID', placeholder: '如 196470',
    help: '「扫 Emby」只扫这一个库。打开该库页面，地址栏里的一串数字就是' },
  { key: 'emby.adminUid', envKey: 'EMBY_ADMIN_UID', card: 'emby', advanced: true,
    label: '管理员用户 ID', placeholder: '用户页地址里的 id',
    help: '必须是 admin 账号，否则扫出来的影片数是假的 0' },

  /* ── CMS（cloud-media-sync）───────────────────────────────── */
  { key: 'cms.baseUrl', envKey: 'CMS_BASE_URL', card: 'cms',
    label: '服务地址', placeholder: 'http://172.17.0.1:9528',
    help: 'cloud-media-sync 的接口地址（真正的 API 在 9528 端口，不是网页那个 9527）' },
  { key: 'cms.user', envKey: 'CMS_USER', card: 'cms',
    label: '账号', placeholder: 'ADMIN_USERNAME' },
  { key: 'cms.pass', envKey: 'CMS_PASS', card: 'cms', secret: true, type: 'password',
    label: '密码', placeholder: 'ADMIN_PASSWORD' },
  { key: 'cms.autoSync', envKey: 'CMS_AUTO_SYNC', card: 'cms', type: 'boolean',
    label: '入库完成后自动让它生成 strm',
    help: '开着 = 入库完自动接上，不用你去 CMS 点一次；关着 = 只提示状态' },

  /* ── 目录 · 媒体库 ───────────────────────────────────────── */
  { key: 'scrape.libraryRoot', envKey: 'SCRAPE_LIBRARY_ROOT', card: 'dir_library', restart: true, pick: 'dir',
    label: '媒体库根目录', placeholder: '/library',
    help: '整理好的片子放这里，对应 compose 里挂给容器的那个目录。改完要重建容器才生效' },

  /* ── 目录 · 下载 ─────────────────────────────────────────── */
  { key: 'download.root', envKey: 'DL_ROOT', card: 'dir_download', restart: true, pick: 'dir',
    label: '下载落盘目录', placeholder: '/downloads',
    help: '下载中的文件放这里。必须是本地盘 —— 网络盘/云盘会写坏数据库。改完要重建容器' },
  { key: 'download.subdir', envKey: 'DL_SUBDIR', card: 'dir_download', restart: true,
    label: '子目录名', placeholder: '待整理',
    help: '下载完先堆在这个子目录里，整理时再搬走。留空 = 直接放根目录' },

  /* ── 目录 · strm 校验 ────────────────────────────────────── */
  { key: 'scrape.strmRoot', envKey: 'SCRAPE_STRM_ROOT', card: 'dir_strm', restart: true, pick: 'dir',
    label: 'strm 目录', placeholder: '/strm',
    help: '用来核对「入库后 strm 真的生成了」。不填也能跑，只是少一道校验' },

  /* ── 任务 · 下载队列 ─────────────────────────────────────── */
  { key: 'download.workerAutoStart', envKey: 'DL_WORKER_AUTOSTART', card: 'task_download',
    type: 'boolean', restart: true,
    label: '服务启动后自动开始下载',
    help: '关掉 = 起来不自动下，要你手动点开始（限流或调试时用）。改完要重建容器' },
  { key: 'download.directFirst', envKey: 'DL_DIRECT_FIRST', card: 'task_download', type: 'boolean',
    label: '优先直连（不走代理）',
    help: '开着 = 先试直连，省代理流量，失败才走代理；关掉 = 全部走代理' },
  { key: 'download.maxAttempts', envKey: 'DL_MAX_ATTEMPTS', card: 'task_download', type: 'number', min: 1, max: 20, advanced: true,
    label: '单集最多重试几次', placeholder: '2' },
  { key: 'download.minFreeGb', envKey: 'DL_MIN_FREE_GB', card: 'task_download', type: 'number', min: 1, max: 10000, advanced: true,
    label: '磁盘剩多少 GB 就停止下载', placeholder: '20',
    help: '保险丝。盘写满会把数据库一起搞坏，默认剩 20GB 就停' },

  /* ── 任务 · 入库队列 ─────────────────────────────────────── */
  { key: 'scrape.workerAutoStart', envKey: 'SCRAPE_WORKER_AUTOSTART', card: 'task_scrape',
    type: 'boolean', restart: true,
    label: '服务启动后自动开始整理',
    help: '关掉 = 入库要手动触发。改完要重建容器' },
  { key: 'scrape.embyRefresh', envKey: 'SCRAPE_EMBY_REFRESH', card: 'task_scrape', type: 'boolean',
    label: '整理完通知 Emby 刷新',
    help: '开着 = 每部入库完让 Emby 扫一次，新片立刻能看到' },
  { key: 'scrape.maxAttempts', envKey: 'SCRAPE_MAX_ATTEMPTS', card: 'task_scrape', type: 'number', min: 1, max: 20, advanced: true,
    label: '单集最多重试几次', placeholder: '3' },
  { key: 'scrape.copyStallMs', envKey: 'SCRAPE_COPY_STALL_MS', card: 'task_scrape', type: 'number', min: 10000, max: 3600000, advanced: true,
    label: '复制卡住多久算失败（毫秒）', placeholder: '300000',
    help: '注意不是单集总时长：只看「文件多久没长大」。慢但有进展不会被误判' },
  { key: 'scrape.allowNewRoot', envKey: 'SCRAPE_ALLOW_NEW_ROOT', card: 'task_scrape', type: 'boolean', advanced: true,
    label: '媒体库目录不存在时自动创建',
    help: '⚠ 默认关。只有真要挪库才开 —— 开着又碰上挂载没就绪，文件会建到真实磁盘上，挂载恢复后被遮住（等于静默丢文件）' },

  /* ── 通知 · 企业微信 ─────────────────────────────────────── */
  { key: 'wecom.enabled', envKey: 'WECOM_ENABLED', card: 'wecom', type: 'boolean',
    label: '启用推送',
    help: '关掉 = 任务照跑，只是不给你发消息' },
  { key: 'wecom.relayUrl', envKey: 'WECOM_RELAY_URL', card: 'wecom',
    label: '转发器地址', placeholder: 'http://172.17.0.1:9098/push',
    help: '企微接口在另一个网段，容器直连会超时，所以要经宿主机上的转发器（scripts/wecom_relay.py）' },
  { key: 'wecom.relayToken', envKey: 'WECOM_RELAY_TOKEN', card: 'wecom', secret: true, type: 'password',
    label: '转发器密钥', placeholder: '与 wecom_relay.py 里的 token 一致' },

  /* ── 通知 · 入库过滤 ─────────────────────────────────────── */
  { key: 'cms.webhookUrl', envKey: 'CMS_WEBHOOK_URL', card: 'filter',
    label: '过滤后转发到哪里', placeholder: 'http://172.17.0.1:9527/api/emby/webhook?token=...',
    help: 'Emby 的 webhook 应该指向本看板的 /api/emby/webhook-filter，这里填它转发去的上游地址' },
  { key: 'cms.filterToken', envKey: 'CMS_FILTER_TOKEN', card: 'filter', secret: true, type: 'password',
    label: '过滤入口 token', placeholder: '默认 hifan-filter',
    help: '本看板 /api/emby/webhook-filter 的访问口令。改了必须同步改 Emby 里配的 webhook 地址' },
  { key: 'cms.nsfwPaths', envKey: 'CMS_NSFW_PATHS', card: 'filter',
    label: '命中哪些路径就剥图', placeholder: '/里番/,/日本av/',
    help: '逗号分隔。路径里含这些词的通知会去掉封面图再转发，避免在企微里弹出大图' },

  /* ── 系统 · 访问认证 ─────────────────────────────────────── */
  { key: 'auth.user', envKey: 'HIFAN_USER', card: 'auth',
    label: '用户名', placeholder: '留空 = 不需要登录',
    help: '只在公网访问时需要。填了用户名和密码才启用登录' },
  { key: 'auth.pass', envKey: 'HIFAN_PASS', card: 'auth', secret: true, type: 'password',
    label: '密码', placeholder: '留空 = 不需要登录',
    help: '保存后下次登录立即生效，不用重启容器' },

  /* ── 不展示：死配置 / 待确认删除 ─────────────────────────── */
  /* 🔴 scan.* 只有设置页在读，没有任何业务代码消费（packages/scanner 也从未被
     server import 过）。§159 先隐藏免误导，等作者确认后再删代码。 */
  { key: 'scan.libraryRoot', envKey: 'SCAN_LIBRARY_ROOT', card: 'dir_library', hidden: true, restart: true,
    label: '（已废弃）NAS 扫描根目录' },
  { key: 'scan.excludeDirs', envKey: 'SCAN_EXCLUDE_DIRS', card: 'dir_library', hidden: true,
    label: '（已废弃）扫描排除目录' },
];

/**
 * 哪些键支持「测连接」—— 有真实探活实现的。
 * ⚠️ 放在这里而不是前端硬编码：加键时只改一处，UI 自动长出测试按钮。
 */
const TESTABLE = new Set([
  'tmdb.proxy', 'hanime.proxy', 'download.proxy', 'hanime.flaresolverr',
  'tmdb.apiKey', 'tmdb.baseUrl',
  'emby.base', 'emby.apiKey', 'emby.libId', 'emby.adminUid',
  'cms.baseUrl', 'cms.user', 'cms.pass', 'cms.webhookUrl',
  'wecom.relayUrl',
  'scrape.libraryRoot', 'scrape.strmRoot', 'download.root',
]);

export function isTestable(key: string): boolean {
  return TESTABLE.has(key);
}

/** 给 config.ts 用的便捷读取：覆盖 > env > 默认（字符串） */
export function ovStr(key: string, envKey: string, def: string): string {
  const o = getOverride(key);
  if (o !== undefined) return o;
  return process.env[envKey]?.trim() || def;
}

/** 数值：覆盖 > env > 默认；非法值回落默认 */
export function ovNum(key: string, envKey: string, def: number): number {
  const raw = ovStr(key, envKey, '');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : def;
}

/** 布尔：覆盖 > env > 默认；只认 true/false/1/0/yes/no/on/off（不区分大小写） */
export function ovBool(key: string, envKey: string, def: boolean): boolean {
  const raw = ovStr(key, envKey, '').toLowerCase();
  if (!raw) return def;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return def;
}
