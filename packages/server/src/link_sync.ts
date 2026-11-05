/**
 * ⭐ §86（2026-10-30）**链接同步** —— 让「后期新抓到的剧集」自动带上下载链接
 *
 * ## 🔴🔴 为什么必须有这个模块（这是「持续落地」的最后一环）
 *
 * 作者原话（2026-10-30）：
 * > 「hanime 还是一直在更新的，所以 hanime 的剧集和下载链接后期还需要继续抓，
 * >   我需要确定后期抓的剧集和下载链接是真的落地到看板」
 *
 * ### 现状的断链（2026-10-30 实测查清）
 * - `source_link` 3548 条**全部**是 2026-10-29 一次性灌进去的（`fetchDays = 1`）
 * - §79 的 hanime 定期扫描（cron 每周一 04:00）**只抓列表页、只落剧集事实字段**
 *   ⇒ ⛔ **它从不碰 watch 页，从不取链接**
 * - ⇒ 后果：明天下午签名集体过期后，**新抓到的剧集永远不会有链接**
 *
 * ## 🔴 铁律
 * 1. **限流**：FlareSolverr 每集 8~20 秒 ⇒ 一次最多 N 条（默认 20），⛔ 不并发轰
 * 2. **串行 + 间隔**：每条之间喘 1200ms（与 `relinkExpired` 同一套）
 * 3. **UPSERT 不 DELETE**：`source_link` 只写不删
 * 4. **失败不动旧行**：宁可让旧链接保留着显示「需重抓」，也别写成空
 * 5. **口径唯一**：分母从 `source_work.entry_detail` 现算（`link_audit.ts` 同源）
 */
import type { DB } from '@hifan/core';
import type { RelinkService } from './relink.js';

export interface LinkSyncOptions {
  /** 本轮最多处理多少条 */
  limit?: number;
  /** 每条之间的间隔毫秒 */
  gapMs?: number;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface LinkSyncResult {
  /** 本轮处理的条数 */
  attempted: number;
  /** 成功取到链接 */
  succeeded: number;
  /** 失败（源站没给可下载直链 / CF 拦住） */
  failed: number;
  /** 处理的 vid 列表 */
  vids: string[];
  /** 失败明细（vid → 原因） */
  errors: Array<{ vid: string; error: string }>;
  /** 耗时 */
  durationMs: number;
}

/** 取源侧全部 vid（去重）—— 与 link_audit.ts 同一口径 */
function sourceVids(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT entry_detail FROM source_work
        WHERE src = 'hanime' AND entry_detail IS NOT NULL AND entry_detail != ''`,
    )
    .all() as Array<{ entry_detail: string | null }>;
  const seen = new Set<string>();
  for (const r of rows) {
    let details: Array<Record<string, unknown>> = [];
    try {
      details = r.entry_detail ? (JSON.parse(r.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      details = [];
    }
    for (const d of details) {
      const vid = d.vid != null ? String(d.vid) : '';
      if (vid) seen.add(vid);
    }
  }
  return [...seen];
}

/**
 * ⭐ 给指定的一批 vid 补链接（**新剧集用这个**）。
 *
 * @param vids 要处理的 vid 列表（通常是新扫出来的那些）
 */
export async function syncLinksForVids(
  db: DB,
  relink: RelinkService,
  vids: string[],
  opts: LinkSyncOptions = {},
): Promise<LinkSyncResult> {
  const t0 = Date.now();
  const gap = opts.gapMs ?? 1200;
  const log = opts.onLog ?? (() => {});
  const errors: LinkSyncResult['errors'] = [];
  let succeeded = 0;
  let failed = 0;

  for (const vid of vids) {
    try {
      const r = await relink.relinkOne(vid);
      if (r.ok) {
        succeeded++;
      } else {
        failed++;
        errors.push({ vid, error: r.error ?? '未知原因' });
      }
    } catch (e) {
      failed++;
      errors.push({ vid, error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise<void>((res) => setTimeout(res, gap));
  }

  const result: LinkSyncResult = {
    attempted: vids.length,
    succeeded,
    failed,
    vids: [...vids],
    errors,
    durationMs: Date.now() - t0,
  };
  log(`链接同步完成：${succeeded}/${vids.length} 成功`, {
    failed,
    durationMs: result.durationMs,
  });
  return result;
}

/**
 * ⭐ 补齐「源侧有、链接表没有」的缺口。
 *
 * 🔴 这是**兜底**——正常情况下新集应该由 `syncLinksForVids` 在同轮补上；
 *    这个函数负责捡漏（上一轮失败、超时被中断、手工灌库的）。
 */
export async function syncMissingLinks(
  db: DB,
  relink: RelinkService,
  opts: LinkSyncOptions = {},
): Promise<LinkSyncResult> {
  const log = opts.onLog ?? (() => {});
  const limit = opts.limit ?? 20;
  const have = new Set(
    (
      db.prepare(`SELECT vid FROM source_link`).all() as Array<{ vid: string }>
    ).map((r) => String(r.vid)),
  );
  const missing = sourceVids(db).filter((v) => !have.has(v));
  if (!missing.length) {
    return { attempted: 0, succeeded: 0, failed: 0, vids: [], errors: [], durationMs: 0 };
  }
  log(`发现 ${missing.length} 个 vid 缺链接，本轮补前 ${Math.min(limit, missing.length)} 条`);
  return syncLinksForVids(db, relink, missing.slice(0, limit), opts);
}

/**
 * ⭐ 刷新「即将过期 / 已过期」的链接。
 *
 * 🔴 签名 TTL ≈ 11 小时 ⇒ 这是**每天都要跑**的活儿，不是可选项。
 * @param horizonSec 提前多久刷新（默认 6 小时 ⇒ 覆盖 TTL 的窗口）
 */
export async function refreshExpiringLinks(
  db: DB,
  relink: RelinkService,
  opts: LinkSyncOptions & { horizonSec?: number } = {},
): Promise<LinkSyncResult> {
  const log = opts.onLog ?? (() => {});
  const limit = opts.limit ?? 20;
  const horizon = opts.horizonSec ?? 6 * 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT vid FROM source_link
        WHERE is_m3u8 = 0 AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC LIMIT ?`,
    )
    .all(nowSec + horizon, limit) as Array<{ vid: string }>;
  const vids = rows.map((r) => String(r.vid));
  if (!vids.length) {
    return { attempted: 0, succeeded: 0, failed: 0, vids: [], errors: [], durationMs: 0 };
  }
  log(`发现 ${vids.length} 条链接即将过期/已过期，本轮刷新`);
  return syncLinksForVids(db, relink, vids, opts);
}
