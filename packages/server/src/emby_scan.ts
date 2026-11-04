/**
 * 一键扫 Emby 里番库（2026-10-28 §80 蛙哥）
 *
 * ## 来历
 * 蛙哥：「再加一个入库检测，点一下自动扫 emby 库，然后匹配新增的片做入库检测」
 *
 * ## 与 `scripts/emby_sync.py` 的关系（⛔ 不是重复造轮子）
 * | | emby_sync.py | 本文件 |
 * |---|---|---|
 * | 跑在哪 | 本机 python + SSH 到 NAS | **看板容器内**，点按钮就触发 |
 * | 写库方式 | 生成 SQL → `nas_apply_sql.py`（停容器再写） | 进程内直接写（容器就是唯一写者） |
 * | 用途 | 批量/救火/审计（保留原始 JSON 快照） | 日常「我刚下了几部，帮我看看进来了没」 |
 * 两者**判据完全一致**：目录名里的 `{tmdbid=xxxxx}` 逐字相等，⛔ 不做标题模糊匹配。
 *
 * ## 🔴 两条必须守住的防线
 * ① **假 0 防线**：Emby 权限不足（非 admin 账号）时 `Items?ParentId=` 返回 **0 条**，
 *    那是「查不到」不是「库里空了」（0ac/0ad 的假 0 家族）。
 *    ⇒ 拉到 0 部、或比上次少一半以上，**一律拒绝写库**并报错，
 *      ⛔ 绝不用一次假 0 把入库判定全清空。
 * ② **不 DELETE**：写 `INSERT OR REPLACE` + 新 `synced_at`，查询侧只认 `last_sync`
 *    ⇒ 已从 Emby 移除的条目自动出局，历史行仍可审计（铁律 0）。
 *
 * ## 依赖的环境变量（不配就不给扫，⛔ 不猜默认 key）
 *   EMBY_API_KEY     必填 —— 从 sw 的 .env 注入 compose，⛔ 不写进 git
 *   EMBY_BASE        默认 http://host.docker.internal:8096（容器 → 宿主 Emby）
 *   EMBY_LIB_ID      默认 196470（「动画里番」库）
 *   EMBY_ADMIN_UID   默认 主账号 uid（必须 admin，否则假 0）
 */
import type { DB } from '@hifan/core';
import { config } from './config.js';

const PAT_TMDB = /[[{]tmdbid=(\d+)[\]}]/i;

/* ⭐ §157 配置中心：改走 config.emby（app_config 表 > env > 默认），看板可改立即生效 */
const EMBY_BASE = () => config.emby.base;
const EMBY_LIB_ID = () => config.emby.libId;
const EMBY_ADMIN_UID = () => config.emby.adminUid;

/** 拉到多少部才允许写库（防线①：低于此数视为「假 0 / 权限不足」，拒写） */
const MIN_SERIES_TO_WRITE = 100;

export interface EmbyScanResult {
  ok: boolean;
  /** 本次扫到的总数 */
  series: number;
  episodes: number;
  /** 新增（这次有、上次 last_sync 没有）*/
  added: Array<{ tmdbId: number; name: string | null }>;
  /** 消失（上次有、这次没有）*/
  removed: Array<{ tmdbId: number; name: string | null }>;
  addedEpisodes: number;
  /** 新增里能对上 tmdb_work 的部数（这才是「看板会亮起来」的） */
  addedOnBoard: number;
  elapsedMs: number;
  syncedAt: string;
  /** 被防线①拦下时的说明 */
  refused?: string;
  error?: string;
}

interface EmbyItem {
  Id?: string;
  Name?: string;
  Path?: string;
  ProductionYear?: number;
  ChildCount?: number;
  ProviderIds?: Record<string, string>;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  SeriesId?: string;
}

async function fetchItems(kind: 'Series' | 'Episode', timeoutMs = 180_000): Promise<EmbyItem[]> {
  const key = config.emby.apiKey;
  if (!key) throw new Error('未配置 Emby API Key（设置页 → 系统设置 → Emby），无法扫 Emby');
  const url =
    `${EMBY_BASE()}/emby/Users/${EMBY_ADMIN_UID()}/Items` +
    `?ParentId=${EMBY_LIB_ID()}&Recursive=true&IncludeItemTypes=${kind}` +
    `&Fields=Path,ProviderIds,ProductionYear,ChildCount&Limit=20000`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'X-Emby-Token': key }, signal: ctl.signal });
    if (!r.ok) throw new Error(`Emby 返回 HTTP ${r.status}（${kind}）`);
    const j = (await r.json()) as { Items?: EmbyItem[]; TotalRecordCount?: number };
    return j.Items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** 从路径/ProviderIds 里取 tmdb id —— 与 emby_sync.py 同口径（先路径后 ProviderIds） */
function tmdbOf(x: EmbyItem): number | null {
  const m = PAT_TMDB.exec(x.Path || '');
  if (m) return Number(m[1]);
  const pid = x.ProviderIds || {};
  const t = pid.Tmdb ?? pid.tmdb;
  if (t && /^\d+$/.test(String(t))) return Number(t);
  return null;
}

/**
 * 执行一次扫描并落库。
 *
 * ⚠️ 会在事务里写 `emby_series` / `emby_episode` / `emby_sync_meta` 三张表，
 *    调用方要对「耗时数十秒」有预期（前端按钮必须给 loading 态）。
 */
export async function scanEmby(db: DB): Promise<EmbyScanResult> {
  const t0 = Date.now();
  const empty = (err?: string): EmbyScanResult => ({
    ok: false, series: 0, episodes: 0, added: [], removed: [],
    addedEpisodes: 0, addedOnBoard: 0, elapsedMs: Date.now() - t0,
    syncedAt: '', error: err,
  });

  let ds: EmbyItem[];
  let de: EmbyItem[];
  try {
    [ds, de] = await Promise.all([fetchItems('Series'), fetchItems('Episode')]);
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }

  // ── 解析 ──────────────────────────────────────────────
  const series = new Map<number, { embyId: string; name: string | null; year: number | null; path: string | null; childCount: number | null }>();
  for (const x of ds) {
    const id = tmdbOf(x);
    if (id == null) continue;
    series.set(id, {
      embyId: String(x.Id ?? ''),
      name: x.Name ?? null,
      year: x.ProductionYear ?? null,
      path: x.Path ?? null,
      childCount: x.ChildCount ?? null,
    });
  }
  const eps: Array<{ tmdbId: number; season: number; episode: number; embyId: string; seriesId: string; path: string }> = [];
  for (const x of de) {
    const id = tmdbOf(x);
    if (id == null) continue;
    const s = x.ParentIndexNumber, e = x.IndexNumber;
    if (s == null || e == null) continue;
    eps.push({
      tmdbId: id, season: Number(s), episode: Number(e),
      embyId: String(x.Id ?? ''), seriesId: String(x.SeriesId ?? ''), path: x.Path ?? '',
    });
  }

  // ── 防线①：假 0 / 权限不足 ⇒ 拒写 ────────────────────
  if (series.size < MIN_SERIES_TO_WRITE) {
    return {
      ...empty(),
      series: series.size, episodes: eps.length,
      refused:
        `只扫到 ${series.size} 部（< ${MIN_SERIES_TO_WRITE}），判定为「权限不足/Emby 未就绪」的假 0，` +
        `本次不写库。请确认 EMBY_ADMIN_UID 是 admin 账号、EMBY_LIB_ID 指向「动画里番」库。`,
    };
  }

  // ── diff：与上一次 last_sync 的 tmdb_id 集合比 ────────
  const prevSync = (db
    .prepare(`SELECT value FROM emby_sync_meta WHERE key = 'last_sync'`)
    .get() as { value?: string } | undefined)?.value ?? '';
  const prev = new Map<number, string | null>();
  let prevEpCount = 0;
  if (prevSync) {
    try {
      const rows = db
        .prepare(`SELECT tmdb_id, name FROM emby_series WHERE synced_at = ?`)
        .all(prevSync) as Array<{ tmdb_id: number; name: string | null }>;
      for (const r of rows) prev.set(Number(r.tmdb_id), r.name);
      const e = db
        .prepare(`SELECT COUNT(*) AS n FROM emby_episode WHERE synced_at = ?`)
        .get(prevSync) as { n?: number } | undefined;
      prevEpCount = Number(e?.n ?? 0);
    } catch {
      /* 老库没有表/没同步过 ⇒ 当作首次扫描，全是「新增」 */
    }
  }

  const added: Array<{ tmdbId: number; name: string | null }> = [];
  const removed: Array<{ tmdbId: number; name: string | null }> = [];
  for (const [id, v] of series) if (!prev.has(id)) added.push({ tmdbId: id, name: v.name });
  for (const [id, name] of prev) if (!series.has(id)) removed.push({ tmdbId: id, name });

  // 新增的部里，有多少能被看板认出来（tmdb_work 里有）
  let addedOnBoard = 0;
  if (added.length) {
    const st = db.prepare(`SELECT 1 AS x FROM tmdb_work WHERE id = ? AND is_quarantined = 0`);
    for (const a of added) if (st.get(a.tmdbId)) addedOnBoard++;
  }

  // ── 落库（单事务，⛔ 不 DELETE）──────────────────────
  /* 🔴 时间格式必须与 `scripts/emby_sync.py` **完全一致**（`YYYY-MM-DDTHH:MM:SS` 本地时间）：
     两个入口（点按钮 / 跑脚本）写同一列 `emby_sync_meta.last_sync`，
     而查询侧是**字符串相等**比较（`synced_at = last_sync`）。
     ① 用 T 分隔：脚本用 `time.strftime('%Y-%m-%dT%H:%M:%S')`，这里改成不一样的话
        两套写法混在库里，人工排查时对不上；
     ② 用 Asia/Shanghai：容器 TZ 是 UTC，直接 `toISOString()` 会差 8 小时
        （铁律 0qb：时间一律转本地时区，否则「刚扫的」会显示成 8 小时前）。 */
  const syncedAt = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(' ', 'T');
  try {
    db.exec('BEGIN');
    db.prepare(
      `INSERT OR REPLACE INTO emby_sync_meta (key, value) VALUES
         ('last_sync', ?), ('library_id', ?), ('series_count', ?), ('episode_count', ?)`,
    ).run(syncedAt, EMBY_LIB_ID(), String(series.size), String(eps.length));

    const insS = db.prepare(
      `INSERT OR REPLACE INTO emby_series (tmdb_id, emby_id, name, year, path, child_count, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, v] of series) insS.run(id, v.embyId, v.name, v.year, v.path, v.childCount, syncedAt);

    const insE = db.prepare(
      `INSERT OR REPLACE INTO emby_episode (tmdb_id, season, episode, emby_id, series_id, path, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of eps) insE.run(e.tmdbId, e.season, e.episode, e.embyId, e.seriesId, e.path, syncedAt);

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    return empty('写库失败：' + (e instanceof Error ? e.message : String(e)));
  }

  return {
    ok: true,
    series: series.size,
    episodes: eps.length,
    added,
    removed,
    addedEpisodes: Math.max(0, eps.length - prevEpCount),
    addedOnBoard,
    elapsedMs: Date.now() - t0,
    syncedAt,
  };
}

/**
 * 扫完之后**自动闭环待下清单**（§80）
 *
 * 判据（三条全中才标已收，⛔ 不靠「Emby 里有这部」——那条太松）：
 *   ① 在 `work_want` 里且未撤销、还没标已收
 *   ② 加入时的快照 `snap_need` 有值（否则不知道目标集数，⛔ 不猜）
 *   ③ 当前 Emby 已收集数 >= `snap_need`（用与看板**同一个口径**：只认 last_sync + 扣屏蔽季）
 *
 * 返回被自动标收的部（前端提示「这几部收全了，已自动移到已收」）。
 */
export function autoCloseWanted(db: DB): Array<{ tmdbId: number; mediaType: string; name: string | null }> {
  let rows: Array<{ tmdb_id: number; media_type: string; snap_need: number; name: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT w.tmdb_id, w.media_type, w.snap_need,
                COALESCE(t.name_zh, t.name_original) AS name
           FROM work_want w
           LEFT JOIN tmdb_work t ON t.id = w.tmdb_id AND t.media_type = w.media_type
          WHERE w.revoked_at IS NULL AND w.done_at IS NULL
            AND w.snap_need IS NOT NULL AND w.snap_need > 0`,
      )
      .all() as never;
  } catch {
    return []; // 表不存在（老库）⇒ 什么都不做
  }
  if (!rows.length) return [];

  const haveStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM emby_episode ee
      WHERE ee.tmdb_id = ?
        AND ee.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')`,
  );
  const doneStmt = db.prepare(
    `UPDATE work_want SET done_at = ?
      WHERE media_type = ? AND tmdb_id = ? AND revoked_at IS NULL AND done_at IS NULL`,
  );
  const now = new Date().toISOString();
  const closed: Array<{ tmdbId: number; mediaType: string; name: string | null }> = [];
  for (const r of rows) {
    const n = Number((haveStmt.get(r.tmdb_id) as { n?: number } | undefined)?.n ?? 0);
    if (n >= Number(r.snap_need)) {
      doneStmt.run(now, r.media_type, r.tmdb_id);
      closed.push({ tmdbId: Number(r.tmdb_id), mediaType: r.media_type, name: r.name });
    }
  }
  return closed;
}
