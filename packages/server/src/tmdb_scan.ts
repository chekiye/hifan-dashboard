/**
 * ⭐ §79-3 TMDB 兜底维护 —— **不再自己发现新作品**
 *
 * 🔴🔴 方向纠正（蛙哥 2026-10-28）：
 *   旧版本 `runTmdbScan` 干的事是 `collectByKeyword` 全量 discover 再塞进 `tmdb_work`。
 *   那等于让 TMDB 当发现源，后果实测：
 *     · 库里出现 191 部「TMDB 有、hanime/mteam 都没有」的孤儿
 *     · 出现首播日期是 2027 的未来番（`賢者タイム…` / `ママぼっくい`）
 *     · 用户拿看板给的英文名去 hanime 搜，搜不到（因为那是 TMDB 的罗马字）
 *   ⇒ **新番发现只归 hanime**。TMDB 只做两件事：
 *       ① 给 hanime 已绑定的作品**补/更新分集元数据**
 *       ② 给 hanime 未绑定的作品**做判定**（结论交人工，⛔不自动绑）
 *
 * 🔴 铁律：**`clearCollectCursor` 保留但不再被主流程调用**
 *   它存在的意义是修掉「keyword 通道断点续跑导致新作品永远发现不了」。
 *   现在已经不走 keyword 通道了，这条坑自然消失。函数留着给历史脚本用。
 *
 * 🔴 铁律：**⛔ 不 DELETE 任何行** —— 那 191 部孤儿的清理是独立动作，需人工确认。
 *   本模块只「补」，不「删」。
 */

import type { DB } from '@hifan/core';
import { Collector, TmdbClient } from '@hifan/collector';

export interface TmdbMaintOptions {
  db: DB;
  apiKey: string;
  proxy: string;
  baseUrl: string;
  rateLimitMs: number;
  maxRetries: number;
  /** 单轮最多重拉多少部（防止一次打太多请求） */
  maxPerRun?: number;
  /** 只看最近多少天内 hanime 更新过的作品 */
  recentDays?: number;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TmdbMaintOutcome {
  ok: boolean;
  durationMs: number;
  /** 发现「hanime 集数 > TMDB 集数」的作品数 */
  behind: number;
  /** 实际重拉了分集的作品数 */
  refetched: number;
  /** 重拉后仍落后的（TMDB 确实没收录） */
  stillBehind: number;
  error?: string;
}

/**
 * 🔴 清掉 keyword 通道的断点游标（历史遗留，主流程已不再调用）。
 * ⛔ 不删 job_state 行（⛔禁 DELETE）—— 只把 cursor 置 NULL。
 */
export function clearCollectCursor(db: DB): boolean {
  const r = db
    .prepare(`UPDATE job_state SET cursor = NULL WHERE job_name = 'collect_keyword'`)
    .run();
  return r.changes > 0;
}

/** 跑一轮 TMDB 兜底维护 */
export async function runTmdbMaintenance(opts: TmdbMaintOptions): Promise<TmdbMaintOutcome> {
  const t0 = Date.now();
  const log = opts.onLog ?? (() => {});
  const maxPerRun = opts.maxPerRun ?? 50;
  const recentDays = opts.recentDays ?? 45;
  const out: TmdbMaintOutcome = {
    ok: true,
    durationMs: 0,
    behind: 0,
    refetched: 0,
    stillBehind: 0,
  };

  try {
    // ① 找「hanime 侧集数 > TMDB 已收录集数」的已绑定作品
    const rows = opts.db
      .prepare(
        `SELECT w.id AS work_id, w.media_type,
                MAX(s.episodes) AS src_eps,
                (SELECT COUNT(*) FROM tmdb_episode e WHERE e.work_id = w.id) AS tmdb_eps
           FROM source_work s
           JOIN tmdb_work w ON w.id = s.work_id
          WHERE s.src = 'hanime'
            AND s.work_id IS NOT NULL
            AND COALESCE(s.status, '') <> 'dup'
            AND s.updated_at >= datetime('now', ?)
          GROUP BY w.id
         HAVING MAX(s.episodes) > tmdb_eps
          ORDER BY MAX(s.episodes) - tmdb_eps DESC
          LIMIT ?`,
      )
      .all(`-${recentDays} days`, maxPerRun) as Array<{
      work_id: number;
      media_type: 'tv' | 'movie';
      src_eps: number;
      tmdb_eps: number;
    }>;

    out.behind = rows.length;
    log('TMDB 兜底：检出集数落后的作品', { behind: rows.length, recentDays, maxPerRun });

    if (rows.length) {
      const client = new TmdbClient({
        apiKey: opts.apiKey,
        proxy: opts.proxy,
        baseUrl: opts.baseUrl,
        rateLimitMs: opts.rateLimitMs,
        maxRetries: opts.maxRetries,
      });
      const collector = new Collector(opts.db, client);

      for (const r of rows) {
        try {
          // ⚠️ 重拉整季分集（TMDB 的 season 结构必须以官方为准，不能按集号猜）
          await collector.refetchEpisodes(r.media_type, r.work_id);
          out.refetched++;
          // 同步刷新 episode_total（供判定器读）
          const n = (
            opts.db
              .prepare(`SELECT COUNT(*) AS n FROM tmdb_episode WHERE work_id = ?`)
              .get(r.work_id) as { n: number }
          ).n;
          opts.db
            .prepare(`UPDATE tmdb_work SET episode_total = ?, fetched_at = ? WHERE id = ?`)
            .run(n, new Date().toISOString(), r.work_id);
        } catch (err) {
          log('重拉分集失败', { workId: r.work_id, err: String(err) });
        }
      }

      // ② 重拉后仍落后的 —— TMDB 确实没有这些集（hanime 更快）
      const still = opts.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT w.id
               FROM source_work s
               JOIN tmdb_work w ON w.id = s.work_id
              WHERE s.src = 'hanime' AND s.work_id IS NOT NULL
                AND COALESCE(s.status, '') <> 'dup'
                AND s.updated_at >= datetime('now', ?)
              GROUP BY w.id
             HAVING MAX(s.episodes) > (SELECT COUNT(*) FROM tmdb_episode e WHERE e.work_id = w.id)
           )`,
        )
        .get(`-${recentDays} days`) as { n: number };
      out.stillBehind = Number(still?.n ?? 0);
      log('TMDB 兜底完成', {
        refetched: out.refetched,
        stillBehind: out.stillBehind,
      });
    }
  } catch (err) {
    out.ok = false;
    out.error = err instanceof Error ? err.message : String(err);
    log('TMDB 兜底失败', { err: out.error });
  }

  out.durationMs = Date.now() - t0;
  return out;
}
