/**
 * ⭐ §157（2026-11-05）配置中心 —— 运行时覆盖层
 *
 * ## 为什么有这一层
 * `config.ts` 是环境变量快照，改了必须重建容器。
 * 发版给别人自建后，代理 / TMDB key / Emby / CMS 这些不该逼人去改 compose，
 * 蛙哥拍板：「把能设置的都放在设置面板上，compose 越简洁越好」。
 *
 * ## 优先级（读任何受管配置都走这个顺序）
 *   app_config 表（看板保存的） > 环境变量（compose/.env） > 代码默认值
 *
 * ## 生效方式
 * 看板保存 → 写表 → 更新内存 Map ⇒ 立即生效，不重启容器。
 * config.ts 里受管字段全部改成 getter，每次读取现查这个 Map。
 *
 * ## 种子（seed）
 * 启动时把「表里没有、但 env 里有值」的键写进表 —— 这样：
 * ① 设置面板首次打开就能看到现网真实值（而不是空白）；
 * ② compose 之后可以放心瘦身（值已经固化到库里，删掉 env 行不丢配置）。
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
    seedFromEnv();
    reloadOverrides();
  } catch {
    /* 建表/种子失败 ⇒ 空覆盖层，一切走 env/默认，服务照常起 */
  }
}

/** 环境变量值非空 ⇒ 写进表（表里已有该键则不动） */
function seedFromEnv(): void {
  if (!dbRef || !hasTable(dbRef)) return;
  for (const def of CONFIG_KEYS) {
    if (overrides.has(def.key)) continue;
    const envVal = process.env[def.envKey]?.trim();
    if (!envVal) continue;
    const row = dbRef
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(def.key) as { value?: string } | undefined;
    if (row && typeof row.value === 'string' && row.value !== '') continue;
    dbRef
      .prepare(
        'INSERT INTO app_config(key, value, updated_at) VALUES(?, ?, ?) ' +
          'ON CONFLICT(key) DO NOTHING',
      )
      .run(def.key, envVal, new Date().toISOString());
  }
}

/** 重新从表加载进内存（保存后调用 ⇒ 立即生效） */
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

/** 读覆盖层（没有 = undefined，调用方回落 env/默认） */export function getOverride(key: string): string | undefined {
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
    dbRef.prepare(
      'INSERT INTO app_config(key, value, updated_at) VALUES(?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, value, new Date().toISOString());
  }
  reloadOverrides();
}

/* ═══════════════════════════════════════════════════════════════
   受管键清单（面板展示顺序 = 这里顺序；group 分组）
   ⚠️ secret 字段：GET 回传只给「是否已设置」，值永不回传前端。
   ═══════════════════════════════════════════════════════════════ */
export interface ConfigKeyDef {
  key: string;
  envKey: string;
  group: 'proxy' | 'tmdb' | 'emby' | 'cms';
  label: string;
  /** password = 面板掩码显示、留空不覆盖 */
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export const CONFIG_KEYS: ConfigKeyDef[] = [
  // ── 代理 ──
  { key: 'tmdb.proxy', envKey: 'TMDB_PROXY', group: 'proxy',
    label: 'TMDB 代理', placeholder: 'http://host.docker.internal:7890',
    help: '大陆直连 api.themoviedb.org 会超时，填宿主机/机场节点地址；留空 = 直连' },
  { key: 'hanime.proxy', envKey: 'HANIME_PROXY', group: 'proxy',
    label: 'hanime 扫描代理', placeholder: 'http://host.docker.internal:7890',
    help: '定期更新检测抓 hanime 用的代理节点' },
  { key: 'download.proxy', envKey: 'DL_PROXY', group: 'proxy',
    label: '下载代理', placeholder: 'http://host.docker.internal:7890',
    help: '下视频文件的降级通道；是否真的走代理由「下载页 · 代理模式」另控（支持逗号分隔多个）' },
  { key: 'hanime.flaresolverr', envKey: 'FLARESOLVERR', group: 'proxy',
    label: 'FlareSolverr 地址', placeholder: 'http://172.20.0.1:28191/v1',
    help: '抓链接（relink）/签名重抓走它；自建 docker run flaresolverr 后填地址' },

  // ── TMDB ──
  { key: 'tmdb.apiKey', envKey: 'TMDB_API_KEY', group: 'tmdb',
    label: 'TMDB API Key', secret: true, placeholder: 'themoviedb.org 申请',
    help: '采集/刮削/人工绑定全靠它；在 themoviedb.org 免费申请' },

  // ── Emby ──
  { key: 'emby.base', envKey: 'EMBY_BASE', group: 'emby',
    label: 'Emby 地址', placeholder: 'http://host.docker.internal:8096',
    help: '容器里访问宿主 Emby 用 host.docker.internal 或 docker0 网关 172.17.0.1/172.20.0.1' },
  { key: 'emby.apiKey', envKey: 'EMBY_API_KEY', group: 'emby',
    label: 'Emby API Key', secret: true, placeholder: 'Emby 控制台 → 高级 → API 密钥',
    help: '扫 Emby 库 / 入库后刷新必须；Emby 控制台生成' },
  { key: 'emby.libId', envKey: 'EMBY_LIB_ID', group: 'emby',
    label: 'Emby 媒体库 ID', placeholder: '如 196470',
    help: '「扫 Emby」只扫这个库；库 ID 见 Emby 该库页面 URL' },
  { key: 'emby.adminUid', envKey: 'EMBY_ADMIN_UID', group: 'emby',
    label: 'Emby 管理员 UID', placeholder: '用户页 URL 里的 id',
    help: '必须 admin 账号，否则扫出来的是「查不到的假 0」' },

  // ── CMS ──
  { key: 'cms.baseUrl', envKey: 'CMS_BASE_URL', group: 'cms',
    label: 'CMS 地址', placeholder: 'http://172.17.0.1:9528',
    help: 'cloud-media-sync 的 API（真接口在 9528；⛔ 别填全量同步相关路径）' },
  { key: 'cms.user', envKey: 'CMS_USER', group: 'cms',
    label: 'CMS 账号', placeholder: 'ADMIN_USERNAME' },
  { key: 'cms.pass', envKey: 'CMS_PASS', group: 'cms',
    label: 'CMS 密码', secret: true, placeholder: 'ADMIN_PASSWORD' },
  { key: 'cms.webhookUrl', envKey: 'CMS_WEBHOOK_URL', group: 'cms',
    label: 'CMS 入库通知（webhook 上游）', placeholder: 'http://172.17.0.1:9528/api/emby/webhook',
    help: '§155 入库通知过滤的上游地址；留空用内置默认' },
  { key: 'cms.nsfwPaths', envKey: 'CMS_NSFW_PATHS', group: 'cms',
    label: '成人内容路径关键词', placeholder: '/里番/,/日本av/',
    help: '逗号分隔；路径命中 = 入库通知剥图（§155）' },
];

/** 给 config.ts 用的便捷读取：覆盖 > env > 默认 */
export function ovStr(key: string, envKey: string, def: string): string {
  const o = getOverride(key);
  if (o !== undefined) return o;
  return process.env[envKey]?.trim() || def;
}
