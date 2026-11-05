/**
 * ⭐ §92（2026-10-30）刮削入库队列 —— 自研，**不依赖 MoviePilot**
 *
 * ## 作者定调（当天两次改口，以第二次为准）
 * ①「把 MP 那套流程搬进去 8848 看板，实现抓取，下载，刮削，入库，一条龙」
 * ②「**我不想你调用 MP 刮削**，我想把 MP 那一套流程搬进去 8848 看板，和 MP 分开」
 * ⇒ 刮削实现全部在 `scrape.ts`（自己打 TMDB、自己写 nfo、自己下图片、自己复制落位），
 *   这个文件只负责**排队与状态**：谁该刮、刮到哪、失败几次、结果落哪。
 *
 * ## 🔴 为什么必须排队（不能同步接口）
 * 一集 = 复制 250MB 进 115 挂载 + 拿 7 张图 + 3 个 nfo，实测 5~40 秒。
 * 整部 12 集 ≈ 5 分钟。同步接口挂那么久，刷新就断、失败也没处看（0r41）。
 *
 * ## 状态一律用时间戳推导（同 work_want / work_dl，⛔ 不新增 state 列）
 * | 条件 | 含义 |
 * |---|---|
 * | done_at 非空 | 已进 115 媒体库（dest 是完整路径）|
 * | revoked_at 非空 | 人工作废 |
 * | queued_at 空 | 「一条龙」里等下载完成 |
 * | queued_at 非空 + err 空 | 排队/进行中 |
 * | err 非空 + attempts < max | 重试中（退避：把 queued_at 往后推）|
 * | err 非空 + attempts >= max | 失败（前端给「重试」按钮）|
 */
import { existsSync } from 'node:fs';
import type { DB } from '@hifan/core';
import type { Scraper, ScrapeStepFn } from './scrape.js';
import type { CmsClient } from './cms.js';

/** Emby 刷新的最小间隔 —— 全库递归重扫很重，5 分钟内只刷一次 */
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

/** CMS 触发的最小间隔 —— 增量同步会重读 115 生活事件，别每集都触发 */
const CMS_MIN_INTERVAL_MS = 3 * 60_000;

/** 入队载荷 */
export interface IngestItem {
  vid: string;
  tmdbId: number;
  season: number;
  episode: number;
  /** 看板容器里的落盘路径 */
  srcPath: string;
  /** true = 先等下载完成（「一条龙」用），false = 立刻可以刮削 */
  waitDownload?: boolean;
}

/** 前端要的一集状态 */
export interface IngestState {
  vid: string;
  tmdbId: number | null;
  season: number | null;
  episode: number | null;
  /** waiting（等下载）/ queued / running / done / failed */
  state: 'waiting' | 'queued' | 'running' | 'done' | 'failed';
  dest: string | null;
  title: string | null;
  year: number | null;
  epTitle: string | null;
  err: string | null;
  attempts: number;
  doneAt: string | null;
}

export interface IngestWorkerOptions {
  maxAttempts?: number;
  idleMs?: number;
  /**
   * CMS 客户端 —— 入库的**第二步**。
   *
   * 我们把真文件/nfo/图片写进 115 原件目录后，Emby 还看不见：
   * 它读的是 CMS 生成的 strm 库。所以收工时要触发 CMS 跑一次增量同步。
   * 没注入 = 不触发（只看板上报「未配置」）。
   */
  cms?: CmsClient | null;
  /** CMS 自动同步开关（config.cms.autoSync） */
  cmsAutoSync?: boolean;
  /**
   * 🔴🔴 strm 库根目录（容器内）—— 用来**确认** CMS 到底有没有生成 strm。
   *
   * 作者 2026-10-30 报的真实现象：「你调用 CMS 速度太快了，文件还没落盘你就调，
   * 导致 strm 根本没生成，第二次增量才生成视频文件」。
   * 我们写进 115 挂载点 = 本地落盘完成，但 CloudDrive 是**异步上传**到 115 云端，
   * CMS 去 115 拉列表时可能还看不到这个文件 ⇒ 那一轮同步白跑。
   * ⇒ 光「触发成功」不算数（0bt 自证指标），必须**回头看产物在不在**：
   *    `strmPathOf(dest)` 存在 = 真成了；不存在 = 隔一会儿再触发，直到出现或重试用尽。
   */
  strmRoot?: string | null;
  /** strm 首次检查延迟（毫秒）—— 给 CMS 同步任务一点执行时间 */
  strmFirstCheckMs?: number;
  /** strm 重试退避（秒），长度 = 最多重试几轮 */
  strmBackoffS?: number[];
}

/**
 * 刮削入库 worker —— 常驻串行。
 *
 * ⛔ 不并发：TMDB 限流 0.25 秒/请求，一集要 ~4 次请求 + 7 张图；
 *    并发只会被限流打回来，还会把 115 挂载写满队列。
 */
export class IngestWorker {
  readonly status = {
    running: false,
    busy: false,
    current: null as string | null,
    /** ⭐ §93 当前这一集走到第几步（看板画八格进度条用；空闲时为 null） */
    step: null as {
      key: string;
      label: string;
      idx: number;
      total: number;
      sub: { done: number; total: number; unit: string } | null;
      /** 该步骤开始时刻（前端算「这步跑了多久」） */
      at: string;
    } | null,
    startedAt: null as string | null,
    lastAt: null as string | null,
    lastErr: null as string | null,
    /** 最近一集的产物路径（排查用） */
    lastTarget: null as string | null,
    /** ⭐ §93-3 最近一次触发 CMS 增量同步的结果（看板上报「已同步/同步失败」） */
    lastCms: null as {
      ok: boolean;
      message: string;
      at: string;
      ms: number;
    } | null,
    /** 🔴 §97 strm 生成确认 —— 「触发了同步」≠「strm 真出现了」 */
    strm: {
      /** 还没等到 strm 的集数（会自动重试） */
      pending: 0,
      /** 已确认 strm 落地的集数（本进程内） */
      ok: 0,
      /** 重试用尽仍缺的 vid */
      failed: [] as string[],
      /** 最近一次检查时刻 */
      lastAt: null as string | null,
    },
  };

  private timer: NodeJS.Timeout | null = null;
  private hasTable = true;
  /** 上次通知 Emby 刷新的时刻（节流用，见 maybeRefreshLibrary） */
  private lastRefreshAt = 0;
  /** 上次触发 CMS 增量同步的时刻（节流用，见 maybeRefreshLibrary） */
  private lastCmsAt = 0;
  /* 🔴🔴 节流会把「一部剧的最后一集」吞掉（§96 实测 2026-10-30 21:57）：
     E01 完成后触发同步（13:57:30），E02 是 58 秒后完成的 —— 落在 3 分钟窗口内
     被跳过，**之后没有任何补偿触发** ⇒ E02 的 strm 永远不生成，
     Emby 里只看到 1 集（用户会以为「一条龙漏了一集」）。
     ⇒ 被挡下的那次必须挂**尾随定时器**，窗口一过自动补跑一次。 */
  private cmsTimer: NodeJS.Timeout | null = null;
  private cmsPendingWorkId = 0;
  /** §97 等 strm 出现的集（vid → 期望 strm 路径 + 已重试轮数） */
  private strmWatch = new Map<string, { path: string; tries: number }>();
  private strmTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DB,
    private readonly scraper: Scraper,
    private readonly opts: IngestWorkerOptions = {},
  ) {
    try {
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_ingest'`)
        .get();
    } catch {
      this.hasTable = false;
    }
  }

  private get maxAttempts(): number {
    return Math.max(1, this.opts.maxAttempts ?? 3);
  }

  /**
   * 入队（幂等）。
   *
   * 🔴 三条都必须清：done_at / err / attempts。
   *   - 不清 done_at ⇒ 重刮一集永远显示「已入库」，重新入库按不动
   *   - 不清 err ⇒ 上次失败的记录被当作已失败直接跳过（0r43 的老坑）
   *   - 不清 attempts ⇒ 重试上限一进队列就顶满，永远只能试一次
   * 🔴 且**已入库的行不许被覆盖**（`WHERE done_at IS NULL`）：
   *   否则点一次一条龙就把已完成的行打回 waiting，看板显示「入库 0/12」。
   */
  enqueue(items: IngestItem[], force = false): number {
    if (!this.hasTable) return 0;
    const now = new Date().toISOString();
    /* ⭐ §139 洗版（2026-11-03 作者「已入库的也安排上下载一条龙，可能会有洗版需求」）：
       force=true 时去掉 `WHERE done_at IS NULL` 守卫 —— 已入库的 vid 重新入队
       （done_at 清 NULL → 重新刮削 → 覆盖 115 库文件）。普通调用守卫照旧。 */
    const stmt = this.db.prepare(
      `INSERT INTO work_ingest
         (vid, tmdb_id, season, episode, src_path, dest, title, year, ep_title,
          err, queued_at, done_at, beam_at, attempts, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, 0, NULL)
       ON CONFLICT(vid) DO UPDATE SET
         tmdb_id   = excluded.tmdb_id,
         season    = excluded.season,
         episode   = excluded.episode,
         src_path  = excluded.src_path,
         err       = NULL,
         attempts  = 0,
         queued_at = excluded.queued_at,
         beam_at   = NULL,
         revoked_at = NULL
       ${force ? '' : 'WHERE work_ingest.done_at IS NULL'}`,
    );
    let n = 0;
    for (const it of items) {
      try {
        const r = stmt.run(
          it.vid, it.tmdbId, it.season, it.episode, it.srcPath,
          it.waitDownload ? null : now,
        );
        /* 只数真变了的行（0bt：命令成功 ≠ 数据变了） */
        if (Number(r?.changes ?? 0) > 0) n++;
      } catch {
        /* 单条失败不拖累其它 */
      }
    }
    return n;
  }

  /** 把「等下载」的行提升为「可刮削」——work_dl 里 done 了才提 */
  promoteWaiting(): number {
    if (!this.hasTable) return 0;
    try {
      const r = this.db
        .prepare(
          `UPDATE work_ingest
              SET queued_at = ?
            WHERE queued_at IS NULL
              AND done_at IS NULL
              AND revoked_at IS NULL
              AND err IS NULL
              AND EXISTS (SELECT 1 FROM work_dl d
                           WHERE d.vid = work_ingest.vid
                             AND d.done_at IS NOT NULL
                             AND d.revoked_at IS NULL)`,
        )
        .run(new Date().toISOString());
      return Number(r.changes ?? 0);
    } catch {
      return 0;
    }
  }

  /** 取下一集可刮的（⛔ 不抢自己正在跑的那集） */
  private next(): Record<string, unknown> | null {
    if (!this.hasTable) return null;
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT i.vid, i.tmdb_id, i.season, i.episode, i.src_path,
                IFNULL(i.attempts,0) AS attempts,
                w.name_zh AS name_zh
           FROM work_ingest i
           LEFT JOIN tmdb_work w ON w.id = i.tmdb_id
          WHERE i.queued_at IS NOT NULL
            AND i.done_at IS NULL
            AND i.revoked_at IS NULL
            AND (i.err IS NULL OR IFNULL(i.attempts,0) < ?)
            AND i.queued_at <= ?
          ORDER BY i.queued_at ASC
          LIMIT 5`,
      )
      .all(this.maxAttempts, now) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (String(r.vid) === this.status.current) continue;
      return r;
    }
    return null;
  }

  /**
   * 当前卡在第几步（中文名），没有就 null。
   * 🔴 必须抽成方法：直接写 `this.status.step?.label` 时，
   *    TS 的控制流分析会因为前面 `status.step = null` 的赋值把它收窄成 `never`
   *    （属性收窄不会因中间的函数调用/await 重置）⇒ 编译期报「label 不存在于 never」。
   */
  private stepLabel(): string | null {
    return this.status.step?.label ?? null;
  }

  /** 跑一集。返回 false = 队列空 */
  async runOne(): Promise<boolean> {
    const row = this.next();
    if (!row) return false;
    const vid = String(row.vid);
    const nowIso = new Date().toISOString();

    this.status.current = vid;
    this.status.busy = true;
    this.status.step = null;
    let lastBeam = 0;
    try {
      this.db.prepare(`UPDATE work_ingest SET beam_at = ?, err = NULL WHERE vid = ?`).run(nowIso, vid);

      /* ⭐ §93 八步进度：更新内存（看板 2 秒轮询直接读）+ 节流写心跳
         🔴 心跳必须节流：第⑥步复制视频每秒回调一次，每次都写库 = 每秒一次
            SQLite + 115 FUSE 写，白白拖慢复制。2 秒够看板判「这台机器还活着」。 */
      const onStep: ScrapeStepFn = (e) => {
        const t = new Date();
        this.status.step = {
          key: e.key,
          label: e.label,
          idx: e.idx,
          total: e.total,
          sub: e.sub ?? null,
          at: t.toISOString(),
        };
        if (t.getTime() - lastBeam < 2000) return;
        lastBeam = t.getTime();
        try {
          this.db.prepare(`UPDATE work_ingest SET beam_at = ? WHERE vid = ?`).run(t.toISOString(), vid);
        } catch {
          /* 心跳写失败不该让整集失败 */
        }
      };

      const res = await this.scraper.ingest(
        {
          srcPath: String(row.src_path ?? ''),
          tmdbId: Number(row.tmdb_id ?? 0),
          season: Number(row.season ?? 1),
          episode: Number(row.episode ?? 0),
          /* §93 库里的中文名优先 —— TMDB 的 zh-CN 对部分条目直接返日文原名 */
          titleHint: (row.name_zh as string | null) ?? null,
        },
        onStep,
      );

      if (res.ok) {
        this.db
          .prepare(
            `UPDATE work_ingest
                SET dest = ?, title = ?, year = ?, season = COALESCE(?, season),
                    episode = COALESCE(?, episode), ep_title = ?,
                    err = NULL, done_at = ?, beam_at = ?
              WHERE vid = ?`,
          )
          .run(
            res.target ?? null, res.title ?? null, res.year ?? null,
            res.season ?? null, res.episode ?? null, res.episodeTitle ?? null,
            new Date().toISOString(), new Date().toISOString(), vid,
          );
        this.status.lastErr = null;
        this.status.lastTarget = res.target ?? null;
        /* 🔴 §97 不只看「写完」——还要回头确认 CMS 真把 strm 生成出来了 */
        this.watchStrm(vid, res.target ?? null);
        const w = res.warnings?.length ? ` (警告 ${res.warnings.length})` : '';
        console.log(`[ing] OK  ${vid} -> ${res.target ?? '?'} (${res.ms}ms)${w}`);
        if (res.warnings?.length) {
          for (const x of res.warnings.slice(0, 4)) console.log(`[ing]   warn: ${x}`);
        }
        /* 该作品收工了才通知 Emby 刷一次（⛔ 不是每集刷，见 scrape.ts 的说明） */
        void this.maybeRefreshLibrary(Number(row.tmdb_id ?? 0));
      } else {
        const attempts = Number(row.attempts ?? 0) + 1;
        const terminal = !res.retryable || attempts >= this.maxAttempts;
        /* 重试用「把 queued_at 往后推」实现（⛔ 不新增列）：
             退避 20s × attempts，到上限就停在原时间 ⇒ next() 的 attempts<max 自然不再取它 */
        const nextAt = terminal
          ? String(row.queued_at ?? nowIso)
          : new Date(Date.now() + 20_000 * attempts).toISOString();
        this.db
          .prepare(
            `UPDATE work_ingest SET err = ?, attempts = ?, queued_at = ?, beam_at = ? WHERE vid = ?`,
          )
          .run(
            /* 🔴 把「卡在第几步」一起写进 err —— 否则失败行只显示一个笼统原因，
               用户看不出是 TMDB 没响应还是复制视频时 115 挂了。 */
            `${res.code ?? 'scrape_failed'}: ${res.message ?? ''}${
              this.stepLabel() ? ` @ ${this.stepLabel()}` : ''
            }`.slice(0, 500),
            attempts, nextAt, nowIso, vid,
          );
        this.status.lastErr = `${res.message ?? res.code ?? '刮削失败'}${
          this.stepLabel() ? ` @ ${this.stepLabel()}` : ''
        }`;
        console.log(
          `[ing] FAIL ${vid} ${res.code} ${res.message} @ ${this.stepLabel() ?? '?'} (attempts=${attempts}/${this.maxAttempts})`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.lastErr = msg;
      console.log(`[ing] ERR ${vid} ${msg} @ ${this.stepLabel() ?? '?'}`);
    } finally {
      this.status.busy = false;
      this.status.current = null;
      this.status.step = null;
      this.status.lastAt = new Date().toISOString();
    }
    return true;
  }

  /**
   * 入库收尾：**先让 CMS 生成 strm，再刷 Emby**（各自节流）。
   *
   * ## 🔴 顺序为什么不能反（§93-3 实测定论）
   * 我们写字的地方是 115 **原件目录**，而 **Emby 读的是 CMS 生成的 strm 库**。
   * 不先让 CMS 跑一次，Emby 那边什么都没有 —— 刷一百遍也扫不出新集。
   * （§92 就是因为不知道这一步，一度以为「入库完了但 Emby 不认」无解。）
   *
   * ## 🔴 为什么是节流而不是「整部做完才刷」
   * 第一版写的是「该作品队列清空（没有 queued、没有 waiting）才刷」，
   * 2026-10-30 实测踩到反直觉后果：125498（紫音）1 集入库、还有 3 集在等下载
   * ⇒ waiting 不为 0 ⇒ **永远不刷新** ⇒ 已入库的那集在 Emby 里根本看不到。
   * 而「一条龙」里那 3 集可能几小时都没下来。
   *
   * ## 为什么不能每集都做
   * CMS 增量同步要重读 115 生活事件；Emby 的 `Refresh?Recursive=true` 会把
   * 460 多个目录整个重扫，12 集连刷 12 次会让 Emby 长时间不可用。
   * ⇒ CMS 3 分钟一次、Emby 5 分钟一次。
   */
  /** 真跑一次 CMS 增量同步（调用方负责节流判断）
   *  @param force 手动触发时置 true —— 让「关了自动同步」的人也能手动补一次，
   *               并且**结果仍然写进 status.lastCms**（⛔ 不能只在返回体里给） */
  private async doCmsSync(workId: number, force = false): Promise<boolean> {
    const cms = this.opts.cms;
    if (!cms || !cms.configured) return false;
    if (!force && this.opts.cmsAutoSync === false) return false;
    this.lastCmsAt = Date.now();
    try {
      const r = await cms.triggerSync();
      this.status.lastCms = {
        ok: r.ok,
        message: r.message,
        at: new Date().toISOString(),
        ms: r.ms,
      };
      console.log(
        r.ok
          ? `[ing] CMS 增量同步已触发（work ${workId}，${r.ms}ms）：${r.message}`
          : `[ing] CMS 同步失败（work ${workId}）：${r.message}`,
      );
      return r.ok;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.lastCms = { ok: false, message: msg, at: new Date().toISOString(), ms: 0 };
      console.log(`[ing] CMS 同步异常：${msg}`);
      return false;
    }
  }

  /**
   * 手动触发一次 CMS 增量同步（前端「同步 CMS」按钮）。
   *
   * 🔴 必须**回写 status.lastCms**，不能只把结果 return 给接口。
   *    踩过的坑（2026-10-31 部署验收实测）：`/api/dl/cms/sync` 直接调 cms.triggerSync()，
   *    结果只进了 HTTP 返回体 ⇒ 前端点完按钮 toast 一闪，页面上「上次同步」那行**永远不变**
   *    ⇒ 用户以为按钮没生效、以为部署没成功。这是 F28 的同族：接口成功 ≠ 结果可见。
   *
   * ⛔ 不另写一套：走 doCmsSync 同一份逻辑（0lx）。force=true 让「关自动同步」的人也能补。
   */
  async syncCmsManually(): Promise<{ ok: boolean; message: string; ms: number }> {
    const ok = await this.doCmsSync(0, true);
    const last = this.status.lastCms;
    return {
      ok,
      message: last?.message ?? (ok ? '已触发' : '未执行（CMS 未配置，或自动同步已关闭且未强制）'),
      ms: last?.ms ?? 0,
    };
  }

  /** 被节流挡下的那次同步 —— 挂尾随定时器，窗口一过补跑（⛔ 不能就这么丢掉） */
  private scheduleCmsTrailing(workId: number): void {
    if (Number.isFinite(workId) && workId > 0) this.cmsPendingWorkId = workId;
    if (this.cmsTimer) return;
    const wait = Math.max(1_000, CMS_MIN_INTERVAL_MS - (Date.now() - this.lastCmsAt) + 500);
    this.cmsTimer = setTimeout(() => {
      this.cmsTimer = null;
      const w = this.cmsPendingWorkId;
      this.cmsPendingWorkId = 0;
      void (async () => {
        const ok = await this.doCmsSync(w);
        /* 尾随那次失败 ⇒ 退回让 Emby 自己扫一次，别让新集永远不出现 */
        if (!ok && Date.now() - this.lastRefreshAt >= REFRESH_MIN_INTERVAL_MS) {
          this.lastRefreshAt = Date.now();
          try {
            await this.scraper.refreshLibrary();
          } catch {
            /* 刷新失败不影响主流程 */
          }
        }
      })();
    }, wait);
    /* 别让定时器吊着进程退出 */
    if (typeof this.cmsTimer.unref === 'function') this.cmsTimer.unref();
    console.log(`[ing] CMS 同步落在节流窗口内，${Math.round(wait / 1000)}s 后补跑（work ${workId}）`);
  }

  /** 115 原件路径 → 期望的 strm 路径（映射规则见 config.scrape.strmRoot 注释） */
  private strmPathOf(dest: string | null | undefined): string | null {
    const root = this.opts.strmRoot;
    if (!root || !dest) return null;
    /* dest 形如 /library/CloudDrive/影视/…/x.mp4
       strm 形如 /strm/影视/…/x.strm（CMS 把 115 目录结构原样镜像） */
    const i = dest.indexOf('/CloudDrive');
    if (i < 0) return null;
    const rel = dest.slice(i + '/CloudDrive'.length).replace(/\.mp4$/i, '.strm');
    return `${root.replace(/\/+$/, '')}${rel}`;
  }

  /** 入库成功后挂一个「等 strm 出现」的观察项（⛔ 不阻塞主流程） */
  private watchStrm(vid: string, dest: string | null | undefined): void {
    const p = this.strmPathOf(dest);
    if (!p) return;
    if (existsSync(p)) {
      this.status.strm.ok += 1;
      console.log(`[ing] strm 已就位 ${vid} -> ${p}`);
      return;
    }
    this.strmWatch.set(vid, { path: p, tries: 0 });
    this.status.strm.pending = this.strmWatch.size;
    this.scheduleStrmCheck(this.opts.strmFirstCheckMs ?? 25_000);
  }

  private scheduleStrmCheck(ms: number): void {
    if (!this.strmWatch.size) return;
    if (this.strmTimer) return;
    this.strmTimer = setTimeout(
      () => {
        this.strmTimer = null;
        void this.checkStrm();
      },
      Math.max(5_000, ms),
    );
    if (typeof this.strmTimer.unref === 'function') this.strmTimer.unref();
  }

  /**
   * 🔴 回头验产物：strm 在不在。缺 ⇒ 再触发一次 CMS 增量同步，按退避重试。
   *
   * 为什么必须这样（0bt 的教训）：「CMS 返回创建任务成功」是**自证指标**，
   * 文件还没上传到 115 时它照样返回成功，但什么都没生成。
   * 唯一可信判据是**产物文件存在**。
   */
  private async checkStrm(): Promise<void> {
    if (!this.strmWatch.size) return;
    const missing: Array<{ vid: string; path: string; tries: number }> = [];
    for (const [vid, it] of this.strmWatch) {
      if (existsSync(it.path)) {
        this.strmWatch.delete(vid);
        this.status.strm.ok += 1;
        console.log(`[ing] strm 已生成 ${vid}`);
      } else {
        missing.push({ vid, path: it.path, tries: it.tries });
      }
    }
    this.status.strm.pending = this.strmWatch.size;
    this.status.strm.lastAt = new Date().toISOString();
    if (!missing.length) {
      this.status.strm.failed = [];
      return;
    }

    const backoff = this.opts.strmBackoffS ?? [60, 120, 180, 300, 300];
    const round = Math.min(...missing.map((m) => m.tries)) + 1;
    if (round > backoff.length) {
      this.status.strm.failed = missing.map((m) => m.vid);
      for (const m of missing) this.strmWatch.delete(m.vid);
      this.status.strm.pending = this.strmWatch.size;
      console.log(
        `[ing] ⚠️ strm 重试用尽，仍缺 ${missing.length} 集：${missing
          .map((m) => m.vid)
          .join(',')} —— 多半是 115 上传没完成，去 115 确认文件在，再点「同步 CMS」`,
      );
      return;
    }
    for (const m of missing) {
      const cur = this.strmWatch.get(m.vid);
      if (cur) cur.tries = round;
    }
    /* 再触发一次增量同步 —— 作者实测的「第二次增量才生成视频文件」就是这个道理 */
    const ok = await this.doCmsSync(0);
    console.log(
      `[ing] strm 还缺 ${missing.length} 集，第 ${round} 次重试已触发同步（${ok ? 'ok' : '失败'}），${
        backoff[round - 1]
      }s 后再验`,
    );
    this.scheduleStrmCheck(backoff[round - 1] * 1000);
  }

  private async maybeRefreshLibrary(workId: number): Promise<void> {
    if (!Number.isFinite(workId) || workId <= 0) return;

    /* ① CMS：把 115 原件变成 strm（Emby 真正读的那一层） */
    let cmsOk = false;
    const cms = this.opts.cms;
    if (cms && this.opts.cmsAutoSync !== false && cms.configured) {
      if (Date.now() - this.lastCmsAt >= CMS_MIN_INTERVAL_MS) {
        cmsOk = await this.doCmsSync(workId);
      } else {
        /* 🔴 被挡下的这次不能丢：挂尾随，窗口过了补跑（§96） */
        this.scheduleCmsTrailing(workId);
      }
    }

    /* ② Emby 刷新。CMS 成功时它会自己提交一次媒体库刷新（实测有日志
       `开始提交刷新媒体库任务：196470`），这里就不重复重扫了。 */
    if (cmsOk) return;

    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
    this.lastRefreshAt = now;
    try {
      const r = await this.scraper.refreshLibrary();
      console.log(
        r.ok ? `[ing] Emby 刷新已触发（work ${workId}）` : `[ing] Emby 刷新跳过：${r.message}`,
      );
    } catch (e) {
      console.log(`[ing] Emby 刷新异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async loop(): Promise<void> {
    if (this.status.busy) return;
    try {
      this.promoteWaiting();
      await this.runOne();
    } catch (e) {
      this.status.lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  start(): void {
    if (this.timer) return;
    this.status.running = true;
    this.status.startedAt = new Date().toISOString();
    this.timer = setInterval(() => void this.loop(), this.opts.idleMs ?? 1500);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cmsTimer) clearTimeout(this.cmsTimer);
    this.cmsTimer = null;
    if (this.strmTimer) clearTimeout(this.strmTimer);
    this.strmTimer = null;
    this.status.running = false;
  }

  /** 一集的状态（前端画徽章用） */
  stateOfRow(r: Record<string, unknown>): IngestState {
    const doneAt = (r.done_at as string | null) ?? null;
    const err = (r.err as string | null) ?? null;
    const queuedAt = (r.queued_at as string | null) ?? null;
    const attempts = Number(r.attempts ?? 0);
    const beamAt = (r.beam_at as string | null) ?? null;

    let state: IngestState['state'];
    if (doneAt) state = 'done';
    else if (err && attempts >= this.maxAttempts) state = 'failed';
    else if (err) state = 'queued'; // 退避重试中
    else if (!queuedAt) state = 'waiting';
    else if (beamAt && Date.now() - Date.parse(beamAt) < 10 * 60_000) state = 'running';
    else state = 'queued';

    return {
      vid: String(r.vid),
      tmdbId: r.tmdb_id == null ? null : Number(r.tmdb_id),
      season: r.season == null ? null : Number(r.season),
      episode: r.episode == null ? null : Number(r.episode),
      state,
      dest: (r.dest as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      year: r.year == null ? null : Number(r.year),
      epTitle: (r.ep_title as string | null) ?? null,
      err,
      attempts,
      doneAt,
    };
  }

  /** 某作品逐集状态 + 汇总 */
  list(workId: number): {
    counts: { total: number; done: number; running: number; queued: number; waiting: number; failed: number };
    items: IngestState[];
  } {
    const empty = { total: 0, done: 0, running: 0, queued: 0, waiting: 0, failed: 0 };
    if (!this.hasTable) return { counts: empty, items: [] };
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT vid, tmdb_id, season, episode, dest, title, year, ep_title,
                  err, queued_at, done_at, beam_at, IFNULL(attempts,0) AS attempts
             FROM work_ingest
            WHERE tmdb_id = ? AND revoked_at IS NULL
            ORDER BY season ASC, episode ASC`,
        )
        .all(workId) as Array<Record<string, unknown>>;
    } catch {
      return { counts: empty, items: [] };
    }
    const items = rows.map((r) => this.stateOfRow(r));
    const counts = { ...empty, total: items.length };
    for (const it of items) {
      if (it.state === 'done') counts.done++;
      else if (it.state === 'running') counts.running++;
      else if (it.state === 'queued') counts.queued++;
      else if (it.state === 'waiting') counts.waiting++;
      else counts.failed++;
    }
    return { counts, items };
  }

  /**
   * 进行中的部（待下页顶部进度条用）。
   * ⛔ 不缓存 —— 现算（0r31：缓存数字就是自证指标）。
   */
  active(): Array<{ workId: number; total: number; done: number; failed: number; running: number; queued: number; waiting: number }> {
    if (!this.hasTable) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT tmdb_id AS workId,
                  COUNT(*) AS total,
                  SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
                  SUM(CASE WHEN done_at IS NULL AND err IS NOT NULL AND IFNULL(attempts,0) >= ? THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN done_at IS NULL AND queued_at IS NOT NULL AND (err IS NULL OR IFNULL(attempts,0) < ?) THEN 1 ELSE 0 END) AS running,
                  SUM(CASE WHEN done_at IS NULL AND queued_at IS NULL THEN 1 ELSE 0 END) AS waiting
             FROM work_ingest
            WHERE revoked_at IS NULL AND tmdb_id IS NOT NULL
            GROUP BY tmdb_id
           HAVING done < total`,
        )
        .all(this.maxAttempts, this.maxAttempts) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        workId: Number(r.workId),
        total: Number(r.total ?? 0),
        done: Number(r.done ?? 0),
        failed: Number(r.failed ?? 0),
        running: Number(r.running ?? 0),
        queued: 0,
        waiting: Number(r.waiting ?? 0),
      }));
    } catch {
      return [];
    }
  }

  /**
   * ⭐ §93 全局刮削列表 —— 「刮削」页签的数据源（不分作品）。
   *
   * ## 🔴 为什么不直接 `ORDER BY 时间 DESC LIMIT 300`
   * 库里 done 的行会越攒越多（现在就几百条），一条 SQL 倒序取 N 条
   * ⇒ **排在老队列里的 waiting/queued 会被 done 挤出去**，看板显示「队列是空的」，
   *   实际还有 40 集在等 —— 假的空比报错更坏（0dc「报 0 先分清真假」）。
   * ⇒ 分两次取：未完成的**全部**，已完成的只要最近 N 条。
   *
   * ⛔ counts 一律现算，不读缓存（0r31）。
   */
  all(doneLimit = 120): {
    counts: { total: number; done: number; running: number; queued: number; waiting: number; failed: number };
    active: IngestState[];
    done: IngestState[];
  } {
    const empty = { total: 0, done: 0, running: 0, queued: 0, waiting: 0, failed: 0 };
    if (!this.hasTable) return { counts: empty, active: [], done: [] };
    const COLS = `vid, tmdb_id, season, episode, dest, title, year, ep_title,
                  err, queued_at, done_at, beam_at, IFNULL(attempts,0) AS attempts`;
    try {
      const active = (
        this.db
          .prepare(
            `SELECT ${COLS} FROM work_ingest
              WHERE done_at IS NULL AND revoked_at IS NULL
              ORDER BY tmdb_id ASC, season ASC, episode ASC
              LIMIT 800`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => this.stateOfRow(r));

      const done = (
        this.db
          .prepare(
            `SELECT ${COLS} FROM work_ingest
              WHERE done_at IS NOT NULL AND revoked_at IS NULL
              ORDER BY done_at DESC
              LIMIT ?`,
          )
          .all(doneLimit) as Array<Record<string, unknown>>
      ).map((r) => this.stateOfRow(r));

      const c = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
                  SUM(CASE WHEN done_at IS NULL AND queued_at IS NULL THEN 1 ELSE 0 END) AS waiting,
                  SUM(CASE WHEN done_at IS NULL AND err IS NOT NULL AND IFNULL(attempts,0) >= ? THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN done_at IS NULL AND queued_at IS NOT NULL
                            AND (err IS NULL OR IFNULL(attempts,0) < ?) THEN 1 ELSE 0 END) AS queued
             FROM work_ingest WHERE revoked_at IS NULL`,
        )
        .get(this.maxAttempts, this.maxAttempts) as Record<string, unknown>;

      return {
        counts: {
          total: Number(c?.total ?? 0),
          done: Number(c?.done ?? 0),
          waiting: Number(c?.waiting ?? 0),
          failed: Number(c?.failed ?? 0),
          queued: Number(c?.queued ?? 0),
          running: this.status.busy ? 1 : 0,
        },
        active,
        done,
      };
    } catch {
      return { counts: empty, active: [], done: [] };
    }
  }

  /** 人工重试一集（failed → queued） */
  retry(vid: string): boolean {
    if (!this.hasTable) return false;
    const r = this.db
      .prepare(
        `UPDATE work_ingest
            SET err = NULL, attempts = 0, queued_at = ?, beam_at = NULL
          WHERE vid = ? AND done_at IS NULL AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), vid);
    return Number(r.changes ?? 0) > 0;
  }

  /**
   * 重刮：把**已完成**的记录退回待刮，让 worker 重做一遍。
   *
   * 🔴 为什么需要（2026-10-30 §93 实测踩到）
   *  命名规则 / nfo 字段改了之后，已经落位的那些集不会自己更新 ——
   *  旧代码只给了「失败重试」，`done` 的行没有任何入口能重做，
   *  只能靠手写 SQL 去 `UPDATE done_at = NULL`（那本该是产品能力，不是运维动作）。
   *
   * ⚠️ 清掉 `dest/title/year/ep_title` 是**故意的**：重刮前那一套是根据旧规则算的，
   *    留着会让看板显示一个即将失效的路径。成功写回后自然又有值。
   * ⚠️ `src_path` 指向的原文件必须还在（退不回「待下载」状态 —— 这里只重刮不重下）。
   *
   * @returns 退回去的条数（changes>0 才算，0bt：命令成功 ≠ 数据变了）
   */
  rescrape(q: { workId?: number; vid?: string }): number {
    if (!this.hasTable) return 0;
    const now = new Date().toISOString();
    const base = `UPDATE work_ingest
                     SET done_at = NULL, queued_at = ?, beam_at = NULL, err = NULL, attempts = 0,
                         dest = NULL, title = NULL, year = NULL, ep_title = NULL
                   WHERE done_at IS NOT NULL AND revoked_at IS NULL AND src_path IS NOT NULL`;
    const r = q.vid
      ? this.db.prepare(`${base} AND vid = ?`).run(now, q.vid)
      : this.db.prepare(`${base} AND tmdb_id = ?`).run(now, Number(q.workId ?? 0));
    return Number(r.changes ?? 0);
  }
}
