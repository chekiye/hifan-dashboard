/**
 * ⭐ §79 定期更新检测 —— 服务端装配
 *
 * 把「调度器 + 两个任务 + 企微推送」接成一个整体，供 index.ts 挂载。
 *
 * 🔴 两个任务的分工（蛙哥 2026-10-28 定调）：
 *
 *   `hanime`（主链路）= 抓 hanime → 差集 → 落事实字段 → **调 TMDB 判定**
 *                       → 推送「分集更新 N 部 / 新番 N 部 / 待人工 N 部」
 *   `tmdb`（兜底）= 找出「hanime 集数 > TMDB 集数」的已绑定作品，重拉分集元数据
 *                   ⛔ 不再 discover 新作品（那是孤儿与未来番的来源）
 *
 * 🔴 铁律：**这个模块不自动启动** —— 由 index.ts 显式调用 start()。
 */

import type { DB } from '@hifan/core';
import { Scheduler } from './scheduler.js';
import { runHanimeScan, type AutoUpdateOptions } from './autoupdate.js';
import { runTmdbMaintenance } from './tmdb_scan.js';
import { RelinkService } from './relink.js';
import { syncLinksForVids } from './link_sync.js';
import { config } from './config.js';

export interface UpdateServiceOptions {
  db: DB;
  /** 数据目录（容器内 /app/data） */
  dataDir: string;
  /** 调度器配置文件路径 */
  configPath: string;
  onLog: (msg: string, meta?: Record<string, unknown>) => void;
}

export function createUpdateService(opts: UpdateServiceOptions): {
  scheduler: Scheduler;
  start: () => void;
  stop: () => void;
} {
  const log = opts.onLog;

  /**
   * 🔴 §86（2026-10-30）：**签名重抓服务** —— 链接同步的底层能力。
   * 走 FlareSolverr（宿主 28191），容器内 `172.20.0.1:28191` 直连（§79 已在用同一条路）。
   */
  const relink = new RelinkService(opts.db, {
    flaresolverr: config.hanime.flaresolverr,
    proxy: config.download.proxy,
  });

  const tmdbConn = (): NonNullable<AutoUpdateOptions['tmdb']> => ({
    apiKey: config.tmdb.apiKey,
    proxy: config.tmdb.proxy,
    baseUrl: config.tmdb.baseUrl,
    rateLimitMs: config.tmdb.rateLimitMs,
    maxRetries: config.tmdb.maxRetries,
  });

  const autoOpts = (): AutoUpdateOptions => ({
    db: opts.db,
    dataDir: opts.dataDir,
    wecom: {
      relayUrl: config.wecom.relayUrl,
      enabled: config.wecom.enabled,
      relayToken: config.wecom.relayToken,
    },
    years: [], // 运行时从 scheduler 配置取
    autoApply: true,
    flaresolverr: config.hanime.flaresolverr,
    proxy: config.hanime.proxy,
    // 🔴 判定是主链路的一部分 —— hanime 扫完立刻判，不等下一个 cron
    tmdb: tmdbConn(),
    /* 🔴 §86（2026-10-30）：**同轮补下载链接** ——
     * 以前 scan 只落剧集、从不取链接 ⇒ 新抓到的剧集永远没链接。
     * 现在新 vid 落库后立刻补签名直链（限量 20/轮 ⇒ FlareSolverr 慢，8~20 秒/集）。
     */
    linkSync: {
      limit: 20,
      sync: async (vids: string[]) => {
        const r = await syncLinksForVids(opts.db, relink, vids, {
          gapMs: 1200,
          onLog: (m, meta) => log(m, meta),
        });
        return {
          attempted: r.attempted,
          succeeded: r.succeeded,
          failed: r.failed,
          vids: r.vids,
          errors: r.errors,
          pendingLeft: 0,
          durationMs: r.durationMs,
        };
      },
    },
    onLog: (m, meta) => log(m, meta),
  });

  const scheduler = new Scheduler(
    opts.configPath,
    {
      hanime: async () => {
        const cfg = scheduler.getConfig();
        const r = await runHanimeScan({
          ...autoOpts(),
          years: cfg.hanimeYears,
          autoApply: cfg.autoApply,
        });
        const j = r.judge;
        return {
          ok: r.ok,
          newWorks: r.newWorks.length,
          continued: r.continued.length,
          applied: r.applied,
          pending: r.pending,
          skipped: r.skipped,
          // 🔴 判定结果单列，别混进 continued —— 用户要看的是「分集更新 / 新番」
          episodeUpdates: j ? j.episodeUpdates.length : 0,
          newAnime: j ? j.newAnime.length : 0,
          oldAnime: j ? j.oldAnime.length : 0,
          needsManual: j ? j.needsManual.length : 0,
          judged: j ? j.episodeUpdates.length + j.newAnime.length + j.oldAnime.length + j.inSync.length + j.needsManual.length : 0,
          pushed: r.pushed,
          durationMs: r.durationMs,
          error: r.error ?? null,
          /* 🔴 §86：链接同步结果（看板上要看「上轮补了多少链接」） */
          linkAttempted: r.linkSync?.attempted ?? 0,
          linkSucceeded: r.linkSync?.succeeded ?? 0,
          linkFailed: r.linkSync?.failed ?? 0,
          details: r.newWorks.map((w) => w.title).concat(r.continued.map((c) => c.title)),
        };
      },
      tmdb: async () => {
        const r = await runTmdbMaintenance({
          db: opts.db,
          apiKey: config.tmdb.apiKey,
          proxy: config.tmdb.proxy,
          baseUrl: config.tmdb.baseUrl,
          rateLimitMs: config.tmdb.rateLimitMs,
          maxRetries: config.tmdb.maxRetries,
          maxPerRun: 50,
          recentDays: 45,
          onLog: (m, meta) => log(m, meta),
        });
        return {
          ok: r.ok,
          behind: r.behind,
          refetched: r.refetched,
          stillBehind: r.stillBehind,
          durationMs: r.durationMs,
          error: r.error ?? null,
        };
      },
    },
    (m, meta) => log(m, meta),
  );

  return {
    scheduler,
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
  };
}
