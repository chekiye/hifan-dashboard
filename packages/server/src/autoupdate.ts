/**
 * 更新编排 —— 把「抓取 → 差集 → 落库 → 推送」串成一条流水线
 *
 * 🔴🔴 铁律 0（验收唯一标准）：**线上库真变且看板接口返新值**
 *   dry-run ≠ 修复。本模块的落库**必须**落到线上库，
 *   落完要能查得到新行/新集数，看板接口也要跟着返新值。
 *
 * 🔴 铁律 1（两种「键」不能混用）—— 这是本模块最容易出事的地方：
 *
 *   | 用途                | 用哪个函数      | 为什么                                   |
 *   |---------------------|----------------|------------------------------------------|
 *   | **对齐基线/做差集**  | `workKey()`    | 额外剥掉「第N話」⇒ 第1话与第2话归同一部  |
 *   | **写库 src_key**     | `norm()`       | 库里 `source_work.src_key` 就是 norm 的产物 |
 *
 *   ⛔ 若差集用 norm 而落库用 workKey（或反过来），会出现：
 *      「差集说这部续更了」但「库里找不到对应的 src_key 行」
 *      ⇒ 白干一场，且看板看不出任何异常。
 *
 * 🔴 铁律 2（新收录作品⛔不自动建 work）
 *   蛙哥拍板「事实字段自动落 + 新建/匹配留人工」。
 *   ⇒ 续更（集数变多）⇒ 自动更新 source_work 的 episodes/entry_detail（**事实**）
 *   ⇒ 新收录作品 ⇒ 只写 pending 队列，⛔不新建 tmdb_work、不做匹配
 *
 * 🔴 铁律 3（推送失败不许影响主流程）
 *   推送挂了就挂了，数据已经落好了。⛔不能因为推送失败把整轮标 failed。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '@hifan/core';
import {
  scanHanime,
  diffWorks,
  loadJsonlDir,
  norm,
  workKey,
  pickTargetRow,
  maxEpisodeNoOf,
  TmdbClient,
  type DiffResult,
  type HanimeItem,
  type ScanSummary,
  type RowRef,
} from '@hifan/collector';
import { pushWecom, formatUpdateReport, type WecomConfig } from './wecom.js';
import { judgeBatch, summarize, formatJudgeReport, type JudgeItem, type JudgeSummary } from './tmdb_judge.js';

/** TMDB 连接参数（判定阶段用） */
export interface TmdbConn {
  apiKey: string;
  proxy: string;
  baseUrl: string;
  rateLimitMs: number;
  maxRetries: number;
}

export interface AutoUpdateOptions {
  db: DB;
  /** 数据目录（容器内 /app/data） */
  dataDir: string;
  /** 企微推送配置 */
  wecom: WecomConfig;
  /** 抓取年份 */
  years: number[];
  /** 是否自动落库 */
  autoApply: boolean;
  /** FlareSolverr 地址 */
  flaresolverr?: string;
  /** 代理 */
  proxy?: string;
  /** 🔴 TMDB 判定参数 —— 不传则跳过判定阶段（只做抓取与落库） */
  tmdb?: TmdbConn;
  /**
   * 🔴 §86（2026-10-30）：**下载链接同步** —— 本轮新抓到的 vid 自动补链接。
   * 不传 ⇒ 不取链接（保持旧行为）。
   */
  linkSync?: LinkSyncHook;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** 🔴 §86：链接同步的回调（由 server 层注入，避免 server 模块互相依赖） */
export interface LinkSyncHook {
  /** 单轮最多处理多少条（FlareSolverr 慢 ⇒ 必须限量） */
  limit?: number;
  /** 给这批 vid 补链接 */
  sync: (vids: string[]) => Promise<LinkSyncSummary>;
}

/** 🔴 §86：链接同步结果 */
export interface LinkSyncSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  vids: string[];
  errors: Array<{ vid: string; error: string }>;
  /** 因超限没处理的条数（留到下一轮） */
  pendingLeft: number;
  durationMs: number;
}

export interface HanimeScanOutcome {
  ok: boolean;
  durationMs: number;
  /** 新收录作品 */
  newWorks: Array<{ key: string; title: string; count: number; episodeNos: number[] }>;
  /** 续更 */
  continued: Array<{
    key: string;
    title: string;
    oldCount: number;
    newCount: number;
    addedEps: number[];
  }>;
  /** 已落库的续更条数 */
  applied: number;
  /** 待人工处理的新收录 */
  pending: number;
  /** 因定位歧义跳过的条数（留人工） */
  skipped: number;
  /** 抓取统计 */
  scan: {
    totalRows: number;
    blocked: string[];
    zero: string[];
    perCombo: ScanSummary['perCombo'];
  };
  /** vid 差集（辅助，不作删除判据） */
  vidDiffCount: number;
  /** 🔴 TMDB 判定汇总（未启用判定时为 null） */
  judge: JudgeSummary | null;
  /** 🔴 §86：本轮的链接同步结果（未启用链接同步时为 null） */
  linkSync: LinkSyncSummary | null;
  pushed: boolean;
  error?: string;
}

/**
 * 🔴 从库里读 hanime 的基线条目（展平 entry_detail）
 *
 * 🔴🔴 铁律：过滤必须按 **`entry_detail[].year`**（每集自己的年份），
 *   ⛔ 不是 `source_work.year`（那是作品首播年）。
 *   实证（线上 id=3976）：`1LDK＋JK…` 的 work.year=2023，
 *   但它 2026 年还在更新（entry_detail 里 2026 的集，年份列 years=[2023..2026]）
 *   ⇒ 若按 work.year=2023 过滤，**2026 年的新集根本不在基线里**
 *   ⇒ 每次都误判成「新收录」⇒ 报告全是噪声。
 */
function loadBaselineFromDb(db: DB, years: number[]): HanimeItem[] {
  // ⛔ 不在 SQL 里按 year 过滤 —— work.year 与实际集年份不是一回事（见上）
  const rows = db
    .prepare(
      `SELECT src_key, title, year, entry_detail FROM source_work
       WHERE src = 'hanime' AND entry_detail IS NOT NULL`,
    )
    .all() as Array<{
    src_key: string;
    title: string;
    year: number;
    entry_detail: string | null;
  }>;

  const yearSet = new Set(years);
  const out: HanimeItem[] = [];
  for (const r of rows) {
    let details: Array<Record<string, unknown>> = [];
    try {
      details = r.entry_detail ? (JSON.parse(r.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      details = [];
    }
    for (const d of details) {
      const vid = d.vid ? String(d.vid) : '';
      const title = d.title ? String(d.title) : '';
      if (!vid || !title) continue;
      const y = Number(d.year ?? r.year ?? 0);
      // 🔴 按每集自己的年份过滤
      if (!yearSet.has(y)) continue;
      out.push({
        vid,
        title,
        year: y,
        genre: String(d.genre ?? ''),
        page: Number(d.page ?? 1),
      });
    }
  }
  return out;
}

/**
 * 🔴🔴 落库：把续更作品的事实字段写回 source_work。
 *
 * 🔴🔴 铁律 A：**必须用 UPDATE，不能用 INSERT OR REPLACE**
 *   `source_work` 有一堆**不能丢的列**：
 *     work_id / work_key / media_type / match_by / match_score / matched_on
 *     / probe_result / status / decided_by / decided_at / official_episodes / work_ja
 *   `INSERT OR REPLACE` = 删旧行插新行 ⇒ **只写我列的那几列，其余全变默认值**
 *   ⇒ work_id 变 NULL ⇒ TMDB 绑定断掉 ⇒ 看板整部作品消失
 *   ⇒ 实证：线上 id=3976 有 work_id=75031、match_by='auto_B'，
 *      REPLACE 一次就全没了。
 *   ⇒ 只 UPDATE 事实字段：episodes / entry_detail / years / updated_at
 *
 * 🔴 铁律 B：`years` 列是**历史全集**，⛔不能只按本轮条目重算
 *   实证：54 行 years 列 ≠ entry_detail 年份集（如 bibleblackonly 列=[2001..2007]
 *   而明细只有 2005/2006）⇒ 覆盖会丢历史年份。
 *   ⇒ UPDATE years = 旧 years ∪ 新增年份
 *
 * 🔴 铁律 C：`entry_detail` 是**增量合并**（按 vid 去重），⛔不是整行覆盖
 *   明细里带 `title_ja / title_zh / brand / playlist_id / title_page`
 *   —— 那是**匹配锚点**（0r 铁律：日文原名只对 hanime 有区分力）
 *   ⇒ 覆盖 ⇒ 锚点没了 ⇒ 后续匹配全部退化
 *   ⇒ 新条目只带 vid/year/title/genre/page ⇒ 合并时**保留旧条目的全部字段**
 *
 * 🔴 铁律 D：`status` / `decided_by` / `decided_at` / `work_id` ⛔一律不碰
 *   （那是蛙哥的匹配决策，⛔不替人做决定）
 *
 * 🔴 铁律 E：落库定位用「规则 C」（见 hanime_diff.ts:pickTargetRow）
 *   歧义时**宁可不动** ⇒ 返回 null 交给人工。
 */
function applyContinued(
  db: DB,
  continued: DiffResult['continued'],
  newItems: HanimeItem[],
): { applied: number; skipped: number; details: string[]; addedVids: string[] } {
  const details: string[] = [];
  let applied = 0;
  let skipped = 0;
  /**
   * 🔴 §86（2026-10-30）：本轮**真正新增到 entry_detail 的 vid**。
   *   ⇒ 这是「新剧集」的精确名单 ⇒ 链接同步只针对它们（⛔ 不全量重抓）。
   */
  const addedVids: string[] = [];

  // ── 候选行：workKey → 行数组（⛔不能只存一行，同一 workKey 可能多行） ──
  const rows = db
    .prepare(
      `SELECT id, src_key, title, status, episodes, entry_detail, year, years
       FROM source_work WHERE src = 'hanime'`,
    )
    .all() as RowRef[];

  const byWorkKey = new Map<string, RowRef[]>();
  const rowById = new Map<number, RowRef>();
  for (const r of rows) {
    rowById.set(r.id, r);
    let details2: Array<Record<string, unknown>> = [];
    try {
      details2 = r.entry_detail ? (JSON.parse(r.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      details2 = [];
    }
    // 行的 title 与它每个 entry 的 title 都可能贡献 workKey
    const keys = new Set<string>();
    const wkTitle = workKey(r.title);
    if (wkTitle) keys.add(wkTitle);
    for (const d of details2) {
      const k = workKey(String(d.title ?? ''));
      if (k) keys.add(k);
    }
    for (const k of keys) {
      if (!byWorkKey.has(k)) byWorkKey.set(k, []);
      byWorkKey.get(k)!.push(r);
    }
  }

  const upd = db.prepare(
    `UPDATE source_work
     SET episodes = ?, entry_detail = ?, years = ?, updated_at = ?
     WHERE id = ?`,
  );

  for (const c of continued) {
    const cands = byWorkKey.get(c.key) ?? [];
    const pick = pickTargetRow(c.key, cands);
    if (!pick.row) {
      skipped++;
      details.push(`⚠️ ${c.title}：${pick.reason}，跳过落库（留人工）`);
      continue;
    }
    const row = pick.row;

    // ── 合并 entry_detail（按 vid 去重，保留旧条目全部字段） ──
    let oldDetails: Array<Record<string, unknown>> = [];
    try {
      oldDetails = row.entry_detail ? (JSON.parse(row.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      oldDetails = [];
    }
    const byVid = new Map<string, Record<string, unknown>>();
    for (const d of oldDetails) {
      if (d.vid) byVid.set(String(d.vid), d);
    }
    let added = 0;
    for (const it of newItems) {
      if (workKey(it.title) !== c.key) continue;
      if (byVid.has(it.vid)) continue;
      // 🔴 只写新条目自带的字段，⛔不覆盖旧条目的 title_ja 等
      byVid.set(it.vid, {
        vid: it.vid,
        year: it.year,
        title: it.title,
        genre: it.genre,
        page: it.page,
      });
      added++;
      addedVids.push(it.vid);
    }
    if (added === 0) {
      // 没有真正的新条目（可能只是换 vid 重发）⇒ 不动库
      skipped++;
      details.push(`· ${c.title}：无新增条目（疑似换 vid 重发），未改库`);
      continue;
    }

    const merged = [...byVid.values()].sort((a, b) => {
      // 排序：先按集号（抽得到的），再按年份、vid
      const an = extractEpisodeNoSafe(String(a.title ?? ''));
      const bn = extractEpisodeNoSafe(String(b.title ?? ''));
      if (an !== null && bn !== null && an !== bn) return an - bn;
      const ay = Number(a.year ?? 0);
      const by = Number(b.year ?? 0);
      if (ay !== by) return ay - by;
      return Number(a.vid ?? 0) - Number(b.vid ?? 0);
    });

    // ── years：旧 ∪ 新（⛔不覆盖历史） ──
    let oldYears: number[] = [];
    try {
      oldYears = row.years ? (JSON.parse(row.years) as number[]) : [];
    } catch {
      oldYears = [];
    }
    const mergedYears = [
      ...new Set([
        ...oldYears.filter((y) => Number.isFinite(y)),
        ...merged.map((d) => Number(d.year ?? 0)).filter((y) => y > 0),
      ]),
    ].sort((a, b) => a - b);

    try {
      upd.run(
        merged.length,
        JSON.stringify(merged),
        JSON.stringify(mergedYears),
        new Date().toISOString(),
        row.id,
      );
      applied++;
      details.push(
        `✏️ ${c.title}（id=${row.id}）：${row.episodes ?? oldDetails.length} → ${merged.length} 集` +
          `（新增第 ${c.addedEps.join('、')} 话）`,
      );
    } catch (err) {
      skipped++;
      details.push(`❌ ${c.title} 落库失败：${(err as Error).message}`);
    }
  }

  return { applied, skipped, details, addedVids };
}

/** 抽集号（失败返回 null）—— 排序时用，不抛异常 */
function extractEpisodeNoSafe(title: string): number | null {
  try {
    const m = title.match(/第\s*(\d+)\s*[話话集期幕]/);
    if (m) return Number(m[1]);
    const m2 = title.match(/\b(?:ep|episode|vol|version|no)\s*[.\-]?\s*(\d+)\b/i);
    if (m2) return Number(m2[1]);
    const m3 = title.match(/(.+?)[\s\-–—~～.…、]+(\d+)\s*$/);
    if (m3 && !/^\d+$/.test(m3[1])) return Number(m3[2]);
    return null;
  } catch {
    return null;
  }
}

/**
 * 新收录作品写 pending 队列（⛔不新建 work、不做匹配）
 *
 * 🔴 用 `INSERT OR IGNORE`（⛔不是 REPLACE）：
 *   source_work 有 UNIQUE(src, src_key)，
 *   REPLACE 撞上已有行会**删掉那一行再插新的** ⇒ work_id/match_by 全丢
 *   ⇒ 用 IGNORE：撞了就跳过（那说明它其实不是「新收录」）
 *
 * 🔴 src_key 用 `norm()`（与库里的既有口径一致 —— 实测 1523/1542 行
 *   src_key === norm(title)），⛔不用 workKey（那个剥了集号，会撞聚合行）。
 */
function queuePendingNewWorks(
  db: DB,
  newWorks: DiffResult['newWorks'],
  newItems: HanimeItem[],
): { added: number; details: string[]; addedVids: string[] } {
  const details: string[] = [];
  let added = 0;
  /** 🔴 §86：本轮新收录作品的 vid（新番也要有链接） */
  const addedVids: string[] = [];

  const ins = db.prepare(
    `INSERT OR IGNORE INTO source_work
       (src, src_key, title, title_clean, year, episodes, years, entry_detail, status, updated_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /** 收集该作品的全部条目（按 vid 去重，带 title_ja 等锚点） */
  const detailsOf = (w: DiffResult['newWorks'][number]): string => {
    const seen = new Set<string>();
    const arr: Array<Record<string, unknown>> = [];
    for (const it of newItems) {
      if (workKey(it.title) !== w.key) continue;
      if (seen.has(it.vid)) continue;
      seen.add(it.vid);
      arr.push({
        vid: it.vid,
        year: it.year,
        title: it.title,
        genre: it.genre,
        page: it.page,
      });
    }
    return JSON.stringify(arr);
  };

  for (const w of newWorks) {
    const srcKey = norm(w.title) || `__short__${w.title.trim()}`;
    try {
      const r = ins.run(
        'hanime',
        srcKey,
        w.title,
        w.title,
        w.year,
        w.count,
        JSON.stringify([w.year]),
        // 🔴 §86：新收录作品**也要落 entry_detail** ——
        //    以前这里写 NULL ⇒ 新番在源侧供给统计里是 0、看板看不到任何条目、
        //    而且**永远不会有下载链接**（链接同步的分母来自 entry_detail）。
        detailsOf(w),
        'pending',
        new Date().toISOString(),
        '§79 定期扫描发现的新收录（待人工匹配）',
      );
      if (r.changes > 0) {
        added++;
        for (const v of w.vids) addedVids.push(v);
        details.push(`🆕 ${w.title}（${w.count} 集）已入待匹配队列`);
      } else {
        details.push(`· ${w.title}：src_key 已存在，跳过`);
      }
    } catch (err) {
      details.push(`❌ ${w.title} 入队失败：${(err as Error).message}`);
    }
  }
  return { added, details, addedVids };
}

/**
 * 🔴 把差集结果转成判定输入 —— 关键是从库里取 `work_id`。
 *
 * 🔴 查询键必须用 **`norm(title)`**（写库用的那个键），⛔ 不是差集里的 `workKey()`。
 *   两种键语义不同（0q1）：`workKey` 会多剥「第N話」，`norm` 不会。
 *   用错 ⇒ 查不到行 ⇒ 全部判成「未绑定」⇒ 已绑定作品被误报成「新番」。
 */
function buildJudgeItems(db: DB, diff: DiffResult): JudgeItem[] {
  const q = db.prepare(
    `SELECT work_id, year, episodes FROM source_work WHERE src = 'hanime' AND src_key = ?`,
  ) as unknown as {
    get: (k: string) => { work_id: number | null; year: number | null; episodes: number | null } | undefined;
  };

  const items: JudgeItem[] = [];

  for (const c of diff.continued) {
    const srcKey = norm(c.title) || `__short__${c.title.trim()}`;
    const row = q.get(srcKey);
    items.push({
      srcKey,
      title: c.title,
      year: row?.year ?? 0,
      episodes: c.newCount,
      addedEps: c.addedEps,
      kind: 'continued',
      workId: row?.work_id ?? null,
    });
  }

  for (const w of diff.newWorks) {
    const srcKey = norm(w.title) || `__short__${w.title.trim()}`;
    const row = q.get(srcKey);
    items.push({
      srcKey,
      title: w.title,
      year: row?.year ?? w.year ?? 0,
      episodes: w.count,
      addedEps: w.episodeNos,
      kind: 'new',
      workId: row?.work_id ?? null,
    });
  }

  return items;
}

/** 跑一轮 hanime 扫描 */
export async function runHanimeScan(opts: AutoUpdateOptions): Promise<HanimeScanOutcome> {
  const t0 = Date.now();
  const log = opts.onLog ?? (() => {});
  const outDir = join(opts.dataDir, 'hanime_recrawl');

  // ① 抓取
  const scan = await scanHanime({
    outDir,
    years: opts.years,
    flaresolverr: opts.flaresolverr,
    proxy: opts.proxy,
    onLog: (m) => log(m),
  });

  // 🔴 被 CF 拦截的组合 ⇒ 整轮标红，⛔不落库（拦截页当末页 = 数据缺失）
  if (scan.blockedCombos.length > 0) {
    return {
      ok: false,
      durationMs: Date.now() - t0,
      newWorks: [],
      continued: [],
      applied: 0,
      pending: 0,
      skipped: 0,
      scan: {
        totalRows: scan.totalRows,
        blocked: scan.blockedCombos,
        zero: scan.zeroCombos,
        perCombo: scan.perCombo,
      },
      vidDiffCount: 0,
      judge: null,
      linkSync: null,
      pushed: false,
      error: `以下组合被 CF 拦截，本轮不落库：${scan.blockedCombos.join('、')}`,
    };
  }

  // ② 差集（基线从线上库读，⛔不用本地快照）
  const baseline = loadBaselineFromDb(opts.db, opts.years);
  const fresh = loadJsonlDir(outDir).filter((x) => opts.years.includes(x.year));
  const diff = diffWorks(baseline, fresh);

  log('差集完成', {
    baseline: baseline.length,
    fresh: fresh.length,
    newWorks: diff.newWorks.length,
    continued: diff.continued.length,
    vidDiff: diff.vidDiff.length,
  });

  // ③ 落库
  let applied = 0;
  let pending = 0;
  let skipped = 0;
  const applyDetails: string[] = [];
  /** 🔴 §86：本轮新增的 vid（续更 + 新收录）—— 链接同步的输入 */
  const addedVids: string[] = [];
  if (opts.autoApply) {
    const r = applyContinued(opts.db, diff.continued, fresh);
    applied = r.applied;
    skipped = r.skipped;
    applyDetails.push(...r.details);
    addedVids.push(...r.addedVids);
    const p = queuePendingNewWorks(opts.db, diff.newWorks, fresh);
    pending = p.added;
    applyDetails.push(...p.details);
    addedVids.push(...p.addedVids);
    log('落库完成', { applied, pending, skipped, addedVids: addedVids.length });
  }

  /* ③-b 🔴🔴 §86（2026-10-30）：**同轮补下载链接** ——
   *
   * 🔴🔴 这是「后期抓的剧集和下载链接真的落地」的关键一环。
   *   以前的现状：`runHanimeScan` 只落剧集事实字段，⛔ **从不取链接**
   *   ⇒ 新抓到的剧集永远没有下载链接（`source_link` 全是 2026-10-29 一次性灌的）。
   *
   * 🔴 限流铁律：FlareSolverr 每集 8~20 秒 ⇒ 单轮上限 `linkLimit`（默认 20）。
   *    ⛔ 绝不一次几百条（会把源站打挂，且一轮要跑几十分钟）。
   *    超出的部分下一轮继续（链接表是累计的 ⇒ 不会漏）。
   */
  let linkSync: LinkSyncSummary | null = null;
  if (opts.linkSync && addedVids.length > 0) {
    const uniq = [...new Set(addedVids)];
    const limit = opts.linkSync.limit ?? 20;
    const batch = uniq.slice(0, limit);
    log(`本轮新增 ${uniq.length} 个 vid，开始补下载链接（取前 ${batch.length} 条）`, {
      total: uniq.length,
      batch: batch.length,
    });
    const r = await opts.linkSync.sync(batch);
    linkSync = {
      attempted: r.attempted,
      succeeded: r.succeeded,
      failed: r.failed,
      vids: r.vids,
      errors: r.errors.slice(0, 20),
      pendingLeft: uniq.length - batch.length,
      durationMs: r.durationMs,
    };
    applyDetails.push(
      `🔗 链接同步：${r.succeeded}/${r.attempted} 成功` +
        (linkSync.pendingLeft > 0 ? `（还有 ${linkSync.pendingLeft} 个留到下轮）` : ''),
    );
  }

  // ④ TMDB 判定（🔴 主链路核心：hanime 发现 → TMDB 回答「分集更新 还是 新番」）
  let judgeSummary: JudgeSummary | null = null;
  if (opts.tmdb && (diff.continued.length > 0 || diff.newWorks.length > 0)) {
    try {
      const client = new TmdbClient({
        apiKey: opts.tmdb.apiKey,
        proxy: opts.tmdb.proxy,
        baseUrl: opts.tmdb.baseUrl,
        rateLimitMs: opts.tmdb.rateLimitMs,
        maxRetries: opts.tmdb.maxRetries,
      });
      const items = buildJudgeItems(opts.db, diff);
      const outcomes = await judgeBatch(
        opts.db,
        client,
        items,
        new Date().getFullYear(),
        log,
      );
      judgeSummary = summarize(outcomes);
      log('TMDB 判定完成', {
        items: items.length,
        episodeUpdates: judgeSummary.episodeUpdates.length,
        newAnime: judgeSummary.newAnime.length,
        oldAnime: judgeSummary.oldAnime.length,
        inSync: judgeSummary.inSync.length,
        needsManual: judgeSummary.needsManual.length,
      });
    } catch (err) {
      // ⛔ 判定失败不许把整轮标 failed —— 抓取与落库已经成功，判定只是加值信息
      log('TMDB 判定失败（不影响落库结果）', { err: String(err) });
    }
  }

  // ⑤ 推送（⛔失败不影响主流程）
  const details = [
    ...diff.continued.map(
      (c) =>
        `· ${c.title}：${c.oldCount} → ${c.newCount} 集（新增第 ${c.addedEps.join('、')} 话）`,
    ),
    ...diff.newWorks.map((w) => `· 【新收录】${w.title}（${w.count} 集）`),
    ...(skipped > 0 ? [`· 另有 ${skipped} 条因定位歧义跳过，留人工处理`] : []),
  ];
  const hasUpdate = diff.continued.length > 0 || diff.newWorks.length > 0;
  let pushed = false;
  if (hasUpdate) {
    // 🔴 有判定结果就用判定报告（分成集更新 / 新番 / 往年漏匹配），否则退回旧格式
    const report = judgeSummary
      ? formatJudgeReport(
          judgeSummary,
          Date.now() - t0,
          linkSync
            ? {
                attempted: linkSync.attempted,
                succeeded: linkSync.succeeded,
                failed: linkSync.failed,
                pendingLeft: linkSync.pendingLeft,
              }
            : null,
        )
      : formatUpdateReport({
          task: 'hanime',
          newWorks: diff.newWorks.length,
          continued: diff.continued.length,
          newItems: diff.continued.reduce((a, c) => a + c.addedEps.length, 0),
          durationMs: Date.now() - t0,
          details,
        });
    const r = await pushWecom(opts.wecom, report);
    pushed = r.ok;
    if (!r.ok) log('企微推送失败（不影响本轮结果）', { error: r.error });
  }

  return {
    ok: true,
    durationMs: Date.now() - t0,
    newWorks: diff.newWorks.map((w) => ({
      key: w.key,
      title: w.title,
      count: w.count,
      episodeNos: w.episodeNos,
    })),
    continued: diff.continued.map((c) => ({
      key: c.key,
      title: c.title,
      oldCount: c.oldCount,
      newCount: c.newCount,
      addedEps: c.addedEps,
    })),
    applied,
    pending,
    skipped,
    scan: {
      totalRows: scan.totalRows,
      blocked: scan.blockedCombos,
      zero: scan.zeroCombos,
      perCombo: scan.perCombo,
    },
    vidDiffCount: diff.vidDiff.length,
    judge: judgeSummary,
    linkSync,
    pushed,
  };
}

/** 读基线库（调试/对比用） */
export function readBaselineFile(path: string): HanimeItem[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HanimeItem[];
  } catch {
    return [];
  }
}
