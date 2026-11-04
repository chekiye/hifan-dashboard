/**
 * ⭐ §88（2026-10-30）下载队列 worker
 *
 * ## 为什么要有它（蛙哥原话）
 * 「能否做进 8848 看板，下载进度能否看见」
 * ⇒ 原来的 `POST /api/dl/one` 是**同步阻塞**的：一集下完才返回。
 *   整部下（12 集 × 250MB / 6MB/s ≈ 8 分钟）HTTP 早断了，页面刷新就没了，
 *   中途一个字都看不到。**关掉浏览器 = 下载白跑**。
 * ⇒ 改成：接口只负责「入队」立刻返回，真正的下载在**服务端常驻 worker** 里跑。
 *
 * ## 队列在哪
 * 不另建表 —— 就是 `work_dl` 里那几个字段（§88 migration）：
 *   `queued_at` 非空 + `done_at` 空 + `revoked_at` 空 ⇒ 还没下完
 * 排序：`queued_at` 升序（先入先下）。
 *
 * ## 🔴 僵死任务的回收
 * 容器重启 / 进程被杀时，正在下的那行会停在「running」不动。
 * ⇒ 判据是 `beam_at`（心跳，下载中每 ~1 秒更新一次）：
 *   超过 **90 秒**没心跳 = 僵死 ⇒ worker 直接捡回来重跑（靠 Range 续传，不白下）。
 *
 * ## ⛔ 铁律
 * - **串行**（一次一集）。⛔ 不开并发 —— 会同时打爆 CDN 和代理，且 6MB/s 的
 *   总带宽分给 4 路只会让每路都变慢，总时长不变还更容易触发 403。
 * - ⛔ 不 DELETE：失败只写 error_msg，用户点重试才重新入队。
 * - 失败**不自动无限重试**：每集最多 `maxAttempts`（默认 2）次，避免死循环烧流量。
 */
import type { DB } from '@hifan/core';
import { statfs } from 'node:fs/promises';
import type { DownloadService, DlTarget } from './download.js';
import { isRelinkWorthy } from './download.js';

/**
 * 🔴 §89（2026-10-30 凌晨）补齐了两个**队列化之后丢掉的能力**：
 *
 * ## ① 失败后不再「一死到底」
 * 旧实现：`await this.dl.download(...)` 的返回值**被整个丢掉**，失败只在
 * `download()` 内部 `markFail()` 写了 `error_msg`。而 `nextTask()` 的 SQL 是
 * `AND error_msg IS NULL` ⇒ **写进去的那一刻就永远不会再被选中**。
 * 后果：`maxAttempts` 形同虚设 —— 第一次失败就永久停摆，只能人工点「重试」。
 * ⇒ 现在在**同一次循环内**重试（最多 maxAttempts 次），不去动 SQL 口径。
 *
 * ## ② 签名过期不再「没人救」
 * 旧的同步接口 `POST /api/dl/one` 有一整套「`link_expired`/`link_forbidden`
 * ⇒ 自动 `relinkOne()` ⇒ 重下」的逻辑；改走队列 worker 之后**这段逻辑没搬过来**。
 * 🔴 而 hembed 的签名 TTL 只有 ~11 小时 ⇒ 全库链接每天早上集体失效，
 *    那时点下载会 100% 失败且不会自愈。⇒ 现在把 relink 注入 worker。
 */
export interface DlWorkerOptions {
  /** 每集最多试几次（含第一次）。默认 2 */
  maxAttempts?: number;
  /** 队列空了以后隔多久再看一次（毫秒）。默认 2500 */
  idleMs?: number;
  /** 心跳超时（毫秒）—— 超过就认为僵死。默认 90 秒 */
  staleMs?: number;
  /**
   * ⭐ 签名重抓（可选 —— 没注入就只重试不重抓）。
   *
   * 只用一个方法，避免把整个 RelinkService 的类型拖进来（循环依赖）。
   * 🔴 慢（8~20 秒/集，要开真浏览器解 CF）⇒ 只在签名类错误上调用。
   */
  relink?: { relinkOne(vid: string): Promise<{ vid: string; ok: boolean; error?: string }> };
  /** 重抓前是否要停下等一等（毫秒，默认 1200）—— 让上一次的 CF 挑战冷却 */
  relinkDelayMs?: number;
  /**
   * ⭐ 落盘目录剩余空间下限（GB）。低于这个值就**自动暂停**，不再往下塞。
   *
   * 🔴 为什么必须有：一集 250MB，整部 12 集就是 3GB，几个作品就是几十 GB。
   *    蛙哥的 cifs 盘不是无限大，**下满了会把整个 NAS 拖死**
   *    （而且 SQLite 库也在别的盘上，写满会直接损坏）。
   *    ⇒ 宁可停下等人工清，也不能写到 0 字节。
   */
  minFreeGb?: number;
}

export interface QueueItem {
  vid: string;
  mediaType: 'tv' | 'movie';
  tmdbId: number;
  season: number;
  episode: number;
  filePath: string | null;
  progressBytes: number;
  totalBytes: number | null;
  speedKbps: number;
  channel: string | null;
  error: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  doneAt: string | null;
  beamAt: string | null;
  revokedAt: string | null;
  attempts: number;
}

/** 一集的当前状态（给前端） */
export type QueueState = 'queued' | 'running' | 'done' | 'failed' | 'revoked';

export function stateOf(q: QueueItem): QueueState {
  if (q.revokedAt) return 'revoked';
  if (q.doneAt) return 'done';
  if (q.error) return 'failed';
  if (q.queuedAt) {
    const alive = q.beamAt ? Date.now() - Date.parse(q.beamAt) < 90_000 : false;
    return alive || q.progressBytes > 0 ? 'running' : 'queued';
  }
  return 'done';
}

export class DlWorker {
  private running = false;
  private paused = false;
  private loop: Promise<void> | null = null;
  /** 当前正在下的那集（给前端显示「正在下第 N 个」） */
  private current: string | null = null;
  private _hasCols: boolean | undefined;

  constructor(
    private readonly db: DB,
    private readonly dl: DownloadService,
    private readonly opts: DlWorkerOptions = {},
  ) {}

  private get hasCols(): boolean {
    if (this._hasCols === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_dl')`)
          .all() as Array<{ name: string }>;
        this._hasCols = rows.some((r) => r.name === 'queued_at');
      } catch {
        this._hasCols = false;
      }
    }
    return this._hasCols;
  }

  get status(): { running: boolean; paused: boolean; current: string | null } {
    return { running: this.running, paused: this.paused, current: this.current };
  }

  /** ⭐ 最近一次磁盘检查结果（前端显示「还剩多少空间」） */
  private disk: { freeGb: number | null; at: number | null; blocked: boolean } = {
    freeGb: null, at: null, blocked: false,
  };

  get diskStatus(): { freeGb: number | null; at: number | null; blocked: boolean } {
    return { ...this.disk };
  }

  /**
   * ⭐ §89：主动刷新一次磁盘余量（前端轮询队列时调）。
   *
   * 🔴 为什么需要：`disk` 原来只在 **worker 真要开工前**才算一次
   *   ⇒ 队列空着的时候 `/api/dl/queue` 永远返回 `freeGb: null`，
   *     看板显示「磁盘 —」，用户根本看不出还剩多少空间。
   *   加 15 秒节流，避免 1 秒轮询变成 1 秒一次 statfs。
   */
  async touchDisk(dir: string): Promise<void> {
    if (this.disk.at && Date.now() - this.disk.at < 15_000) return;
    const free = await this.freeGbOf(dir);
    this.disk = {
      freeGb: free,
      at: Date.now(),
      blocked: free != null && free < (this.opts.minFreeGb ?? 20),
    };
  }

  /** 检查落盘目录剩余空间（GB）。出错就当作「不拦」（⛔ 不能因为量不到就停摆） */
  private async freeGbOf(dir: string): Promise<number | null> {
    try {
      const s = await statfs(dir);
      return (Number(s.bavail) * Number(s.bsize)) / 1024 / 1024 / 1024;
    } catch {
      return null;
    }
  }

  /**
   * ⭐ 入队（幂等）—— 同一集重复入队不会重下。
   *
   * 🔴 关键：**必须清掉 error_msg 和 done_at**
   *   - 不清 error_msg ⇒ 上次失败的记录会被当成「已失败」，worker 跳过，用户点了重试没反应
   *   - 不清 done_at ⇒ 重下时状态一直是「已完成」，进度条永远不动
   *   （这就是 §80 `work_want.add()` 那个「UPSERT 必清 done_at」的同类坑。）
   */
  enqueue(items: Array<Omit<DlTarget, 'fileBase'> & { fileBase: string; filePath: string }>): number {
    if (!this.hasCols) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO work_dl
         (vid, media_type, tmdb_id, season, episode, file_path, bytes, quality,
          error_msg, started_at, done_at, revoked_at,
          queued_at, progress_bytes, speed_kbps, beam_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, NULL, 0)
       ON CONFLICT(vid) DO UPDATE SET
         media_type     = excluded.media_type,
         tmdb_id        = excluded.tmdb_id,
         season         = excluded.season,
         episode        = excluded.episode,
         file_path      = excluded.file_path,
         error_msg      = NULL,
         done_at        = NULL,
         revoked_at     = NULL,
         queued_at      = excluded.queued_at,
         progress_bytes = 0,
         speed_kbps     = 0,
         beam_at        = NULL,
         attempts       = 0`,
    );
    let n = 0;
    for (const it of items) {
      try {
        stmt.run(
          it.vid, it.mediaType, it.tmdbId, it.season, it.episode, it.filePath, now,
        );
        n++;
      } catch {
        /* 单条失败不影响其它 */
      }
    }
    return n;
  }

  /** 取消一集（从队列里拿走，但⛔ 不删记录） */
  cancel(vid: string): boolean {
    if (!this.hasCols) return false;
    const r = this.db
      .prepare(`UPDATE work_dl SET queued_at = NULL, beam_at = NULL, speed_kbps = 0 WHERE vid = ? AND done_at IS NULL`)
      .run(vid);
    return Number(r.changes) > 0;
  }

  /** 队列里下一件要干的活（含僵死回收） */
  private nextTask(): QueueItem | null {
    if (!this.hasCols) return null;
    const now = Date.now();
    // ① 从未开始过的（progress 0、无心跳）或排队中的
    // ② 心跳停了的（僵死）—— 但 attempts 没超上限
    const rows = this.db
      .prepare(
        `SELECT vid, media_type, tmdb_id, season, episode, file_path,
                IFNULL(progress_bytes,0) AS progress_bytes, total_bytes, IFNULL(speed_kbps,0) AS speed_kbps,
                channel, error_msg, queued_at, started_at, done_at, beam_at, revoked_at,
                IFNULL(attempts,0) AS attempts
           FROM work_dl
          WHERE queued_at IS NOT NULL
            AND done_at IS NULL
            AND revoked_at IS NULL
            AND error_msg IS NULL
            AND IFNULL(attempts,0) < ?
          ORDER BY queued_at ASC
          LIMIT 20`,
      )
      .all(this.opts.maxAttempts ?? 2) as Array<Record<string, unknown>>;

    for (const r of rows) {
      const vid = String(r.vid);
      if (this.current === vid) continue; // 自己正在跑的那集别抢
      const beam = r.beam_at as string | null;
      const stale = !beam || now - Date.parse(beam) > (this.opts.staleMs ?? 90_000);
      // 心跳还在（别的进程在跑，比如上一次的 worker 还没退）⇒ 跳过
      if (!stale) continue;
      return {
        vid,
        mediaType: (r.media_type as 'tv' | 'movie') ?? 'tv',
        tmdbId: Number(r.tmdb_id ?? 0),
        season: Number(r.season ?? 0),
        episode: Number(r.episode ?? 0),
        filePath: (r.file_path as string | null) ?? null,
        progressBytes: Number(r.progress_bytes ?? 0),
        totalBytes: r.total_bytes == null ? null : Number(r.total_bytes),
        speedKbps: Number(r.speed_kbps ?? 0),
        channel: (r.channel as string | null) ?? null,
        error: (r.error_msg as string | null) ?? null,
        queuedAt: (r.queued_at as string | null) ?? null,
        startedAt: (r.started_at as string | null) ?? null,
        doneAt: (r.done_at as string | null) ?? null,
        beamAt: beam,
        revokedAt: (r.revoked_at as string | null) ?? null,
        attempts: Number(r.attempts ?? 0),
      };
    }
    return null;
  }

  /** 全部队列（给前端） */
  list(limit = 300): QueueItem[] {
    if (!this.hasCols) return [];
    const rows = this.db
      .prepare(
        `SELECT vid, media_type, tmdb_id, season, episode, file_path,
                IFNULL(progress_bytes,0) AS progress_bytes, total_bytes, IFNULL(speed_kbps,0) AS speed_kbps,
                channel, error_msg, queued_at, started_at, done_at, beam_at, revoked_at,
                IFNULL(attempts,0) AS attempts
           FROM work_dl
          /* 🔴 §89：done_at IS NOT NULL 也要算进来。
             migration#18 之前那条同步下载路径写的历史记录**没有 queued_at**，
             旧 SQL 只认 queued_at IS NOT NULL ⇒ 列表里看不到，
             但 traffic() 是按 done_at 统计的 ⇒ **列表 5 集 / 流量 21 集** 对不上。
             现在两边同源，都是「下过的 + 在队列里的」。
             ⚠️ 这里在模板字符串内，⛔ 不能出现反引号（会提前终止字符串 · 0r33）。 */
          WHERE queued_at IS NOT NULL OR done_at IS NOT NULL
          ORDER BY CASE WHEN done_at IS NULL AND error_msg IS NULL THEN 0 ELSE 1 END,
                   IFNULL(queued_at, done_at) DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      vid: String(r.vid),
      mediaType: (r.media_type as 'tv' | 'movie') ?? 'tv',
      tmdbId: Number(r.tmdb_id ?? 0),
      season: Number(r.season ?? 0),
      episode: Number(r.episode ?? 0),
      filePath: (r.file_path as string | null) ?? null,
      progressBytes: Number(r.progress_bytes ?? 0),
      totalBytes: r.total_bytes == null ? null : Number(r.total_bytes),
      speedKbps: Number(r.speed_kbps ?? 0),
      channel: (r.channel as string | null) ?? null,
      error: (r.error_msg as string | null) ?? null,
      queuedAt: (r.queued_at as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      doneAt: (r.done_at as string | null) ?? null,
      beamAt: (r.beam_at as string | null) ?? null,
      revokedAt: (r.revoked_at as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
    }));
  }

  /** ⭐ 流量统计：按通道分组累计已下字节（机场流量看这个） */
  traffic(): Array<{ channel: string; bytes: number; count: number }> {
    if (!this.hasCols) return [];
    try {
      const rows = this.db
        .prepare(
          /* 🔴 COALESCE 不是 IFNULL —— SQLite 的 IFNULL 只接受 2 个参数，
             写成 IFNULL(a,b,0) 会直接抛 "wrong number of arguments"
             然后被 catch 吞掉 ⇒ 流量统计永远返回空数组（2026-10-30 真踩）。 */
          `SELECT IFNULL(channel,'(未记录)') AS channel,
                  SUM(COALESCE(bytes, progress_bytes, 0)) AS bytes,
                  COUNT(*) AS c
             FROM work_dl
            WHERE done_at IS NOT NULL AND revoked_at IS NULL
            GROUP BY channel
            ORDER BY bytes DESC`,
        )
        .all() as Array<{ channel: string; bytes: number; c: number }>;
      return rows.map((r) => ({ channel: r.channel, bytes: Number(r.bytes ?? 0), count: Number(r.c ?? 0) }));
    } catch {
      return [];
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop;
    this.loop = null;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        await sleep(2000);
        continue;
      }
      let task: QueueItem | null = null;
      try {
        task = this.nextTask();
      } catch {
        task = null;
      }
      if (!task) {
        await sleep(this.opts.idleMs ?? 2500);
        continue;
      }

      /* ⭐ 磁盘闸门：剩余空间不够就不开工（⛔ 宁可停，也不能写到 0 字节） */
      const dir = (task.filePath ?? '').replace(/\/[^/]*$/, '') || '/';
      const free = await this.freeGbOf(dir);
      this.disk = { freeGb: free, at: Date.now(), blocked: free != null && free < (this.opts.minFreeGb ?? 20) };
      if (this.disk.blocked) {
        // 等 60 秒再看（别 2 秒一次刷 statfs，也别一直空转）
        await sleep(60_000);
        continue;
      }

      this.current = task.vid;
      // 从 file_path 反推 fileBase（入队时已算好，⛔ 不在这里重算命名 —— 0lx）
      const base = (task.filePath ?? '').split('/').pop()?.replace(/\.mp4$/i, '') ?? `tmdb-${task.tmdbId}-S${task.season}E${task.episode}`;

      // 心跳：先写一次，让 statusOf 立刻显示「下载中」
      this.dl.beat({
        vid: task.vid,
        progressBytes: task.progressBytes,
        totalBytes: task.totalBytes,
        speedKbps: 0,
        channel: '…',
      });

      let lastBeat = 0;
      const maxAttempts = Math.max(1, this.opts.maxAttempts ?? 2);
      const target: DlTarget = {
        vid: task.vid,
        mediaType: task.mediaType,
        tmdbId: task.tmdbId,
        season: task.season,
        episode: task.episode,
        fileBase: base,
      };
      const onProgress = (p: { bytes: number; total: number | null; kbps: number; channel: string }): void => {
        const now = Date.now();
        // 🔴 进度写库节流到 1 秒 —— 每 500ms 写一次会把 SQLite 打满，
        //    而且前端也是 1 秒轮询，写更快没意义。
        if (now - lastBeat < 1000) return;
        lastBeat = now;
        this.dl.beat({
          vid: task.vid,
          progressBytes: p.bytes,
          totalBytes: p.total,
          speedKbps: p.kbps,
          channel: p.channel,
        });
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const res = await this.dl.download(target, onProgress);
          if (res.ok) break;

          /* ⛔ 这些错重试也没用：
             - m3u8_unsupported：播放清单格式，代码层面就不支持，重抓还是 m3u8
             - write_failed：写盘失败（磁盘满/权限），等一会儿也一样
             - 404（download_failed 里 CDN 无副本）：源站根本没这个文件
             - direct_blocked（§90）：直连 IP 全被 RST 且代理关闭。
               download() 内部已经跑了两轮、试遍 7~10 个 IP，再重试还是同一批
               ⇒ 如实留失败态，让用户决定「等会儿再试」还是「临时开局代理」 */
          if (res.code === 'm3u8_unsupported' || res.code === 'write_failed') break;
          if (res.code === 'direct_blocked') break;
          const is404 = res.code === 'download_failed' && /HTTP 404/.test(res.error);
          if (is404) break;
          if (attempt >= maxAttempts) break;

          /* ⭐ 签名类 + 无链接 ⇒ 先重抓再重下。
             🔴 这里的 relink 是**真开浏览器解 CF**，8~20 秒一集。
                所以只在「签名明确失效」或「压根没链接」时才动用，
                普通网络抖动（download_failed）只 sleep 后重试，不去烧这个时间。 */
          const needRelink = isRelinkWorthy(res.code);
          if (needRelink && this.opts.relink) {
            // 重抓期间不能再被别的循环当成僵死抢走：current 保持指向本集
            this.current = task.vid;
            /* 🔴 必须心跳一次并把 channel 写成 relink —— 否则前端会一直显示
               「下载中 0%」，用户以为卡死了（实际正在开浏览器解 CF，8~20 秒一集）。 */
            this.dl.beat({
              vid: task.vid,
              progressBytes: task.progressBytes,
              totalBytes: task.totalBytes,
              speedKbps: 0,
              channel: 'relink',
            });
            const rr = await this.opts.relink.relinkOne(task.vid);
            if (!rr.ok) {
              /* 重抓都失败（CF 拦死 / 源站没源）⇒ 别再空转，直接留失败态给用户看。
                 ⛔ 不 continue —— 那会白等一次 sleep 再打一次同样的错。 */
              break;
            }
            // 重抓成功 ⇒ 稍微等一下让 CDN 缓存新的签名
            await sleep(this.opts.relinkDelayMs ?? 1200);
          } else {
            await sleep(1200 + attempt * 800);
          }
        }
      } catch (e) {
        // download() 内部已经写 markFail，这里只是不让异常掀翻整个 loop
        void e;
      } finally {
        this.current = null;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
