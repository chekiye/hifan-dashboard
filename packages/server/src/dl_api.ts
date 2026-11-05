/**
 * ⭐ §85（2026-10-29）hanime 下载 API
 *
 * ## 端点
 * | 端点 | 作用 |
 * |---|---|
 * | `GET  /api/dl/status?workId=` | 某作品的逐集下载状态（已下/下载中/失败） |
 * | `POST /api/dl/one`           | 下载单集 |
 * | `POST /api/dl/work`          | 下载整部（缺的集批量下） |
 * | `GET  /api/dl/link/:vid`     | 单集的链接详情（画质/过期/直链） |
 *
 * ## 🔴 为什么下载要在服务端跑，不在浏览器跑
 * - 浏览器下载会落到**运行浏览器的那台机器**（作者的电脑），不是 NAS ⇒ 不满足需求
 * - 服务端跑可以直接写 NAS 挂载目录
 * - 签名链接会在容器内经代理取（⛔ 容器直连 hembed 不通，实测 ECONNRESET）
 *
 * ## ⛔ 铁律
 * - 一集一次请求，⛔ 不做「整部一次性 200 并发」⇒ 会打爆代理与 CDN
 * - 下载失败**不重试**（⛔ 由用户点重试），避免占满带宽
 * - ⛔ 禁 DELETE：`work_dl` 的记录只写不删
 */
import { access, constants, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@hifan/core';
import { IntakeChecker, buildLinkFileBase } from '@hifan/matcher';
import { config } from './config.js';
import { DownloadService, type DownloadConfig } from './download.js';
import { DlWorker, stateOf } from './dl_worker.js';
import { IngestWorker } from './ingest.js';
import { CmsClient } from './cms.js';
import { Scraper, SCRAPE_STEPS, type ScrapeConfig } from './scrape.js';
import { RelinkService, type RelinkConfig } from './relink.js';
import { auditLinks } from './link_audit.js';
/* ⭐⭐ §135 逐集来源选择：mteam 本地视频作为与 hanime 并列的「可取来源」 */
import { listMtFiles, mtRoot, type MtFile, type SrcPick } from './mt_source.js';
import {
  syncLinksForVids,
  syncMissingLinks,
  refreshExpiringLinks,
  type LinkSyncResult,
} from './link_sync.js';

/**
 * ⭐ §154d（2026-11-04 作者「抓到hanime说无来源」×2）：对齐引擎落位表加载。
 *
 * `data/hn_ep_map.json`（vid → [work_id, season, episode]）由
 * `build_hn_ep_map.py` 从看板对齐结果导出 —— **抽屉 hanime 列的同一份真相**。
 * 注入 `IntakeChecker` 后，`/api/dl/pick` 的来源列、下载执行（resolveTargets）
 * 与抽屉/全部片名的落位同源，⛔ 不再出现「抽屉有 hanime、来源列说无」。
 *
 * ⚠️ 路径约定与 `align_ep_override.json` 完全一致（board.ts epOverrides 同款）：
 *    env `HN_EP_MAP_PATH` 优先，否则取 **DB 同目录**（容器内 = /app/data/）。
 * ⚠️ 读不到 / 解析失败 ⇒ 返回 null（⛔ 绝不让它把接口打成 500），走旧落位逻辑。
 * ⚠️ mtime 缓存：改文件即时生效，不用重启容器。
 */
let _hnEpMapCache: { key: string; map: Map<string, [number, number, number]> | null } | null = null;
export function loadHnEpMap(): Map<string, [number, number, number]> | null {
  const p =
    process.env.HN_EP_MAP_PATH ||
    resolve(dirname(config.dbPath), 'hn_ep_map.json');
  try {
    if (!existsSync(p)) return null;
    const key = `${p}:${statSync(p).mtimeMs}`;
    if (_hnEpMapCache && _hnEpMapCache.key === key) return _hnEpMapCache.map;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as {
      vid?: Record<string, [number, number, number]>;
    };
    const out = new Map<string, [number, number, number]>();
    for (const [vid, hit] of Object.entries(raw.vid ?? {})) {
      if (!Array.isArray(hit) || hit.length < 3) continue;
      const w = Number(hit[0]);
      const s = Number(hit[1]);
      const e = Number(hit[2]);
      if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e)) continue;
      out.set(String(vid), [w, s, e]);
    }
    _hnEpMapCache = { key, map: out };
    return out;
  } catch {
    return _hnEpMapCache?.map ?? null;
  }
}

/**
 * 探一下媒体库根目录「在不在、能不能写」。
 *
 * 🔴 为什么要这个接口：自研刮削最常见的失败**不是**「代码错」，
 *    而是「115 挂载没起来 / 容器没权限写」——那时报错会是一堆 ENOENT，
 *    从看板上根本看不出是环境问题。这里把它变成一个可见的布尔值（0cs）。
 */
async function probeDir(dir: string): Promise<{ ok: boolean; error?: string; count?: number }> {
  if (!dir) return { ok: false, error: '未配置路径' };
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return { ok: false, error: '不是目录' };
    try {
      await access(dir, constants.W_OK);
    } catch {
      return { ok: false, error: '目录存在但不可写（权限/挂载只读）' };
    }
    const list = await readdir(dir, { withFileTypes: true });
    return { ok: true, count: list.filter((d) => d.isDirectory()).length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DlApiOptions {
  db: DB;
  cfg: DownloadConfig;
  /** ⭐ 签名重抓配置（可选 —— 没配就不自动重抓，只报「需重抓」） */
  relink?: RelinkConfig;
  /** ⭐ §88 队列 worker 参数 */
  worker?: { maxAttempts?: number; minFreeGb?: number };
  /** 落盘子目录（算 filePath 用，须与 DownloadService 一致） */
  subdir?: string;
  /** 是否随服务启动自动开跑 */
  autoStart?: boolean;
  /** ⭐ §92 自研刮削入库配置（不给 = 不做刮削，只下载） */
  scrape?: ScrapeConfig & {
    workerAutoStart?: boolean;
    maxAttempts?: number;
    /** 🔴 §97 strm 库根目录（容器内，只读挂载）—— 用来验收 CMS 真生成了 strm */
    strmRoot?: string | null;
    /**
     * ⭐ §93-3 CMS 配置 —— 入库的第二步。
     * 我们只把文件写进 115 原件目录，**Emby 读的是 CMS 生成的 strm 库**，
     * 所以要触发 CMS 跑一次增量同步，Emby 才看得见。
     */
    cms?: { baseUrl: string; user: string; pass: string; autoSync?: boolean; timeoutMs?: number };
  };
}

/** 落位信息（哪一集 → 落什么名）—— 从 intake 的落位结果反查，保证与看板显示一致 */
interface Resolved {
  vid: string;
  mediaType: 'tv' | 'movie';
  tmdbId: number;
  season: number;
  episode: number;
  fileBase: string;
}

/**
 * ⭐ 从 intake 的逐集落位结果里取出「可下载的目标」。
 *
 * 🔴 关键：**复用 `IntakeChecker.workIntake()`**（§83 的落位判据唯一出口），
 *    ⛔ 不另写一份集号解析（0lx 铁律）。
 */
export function resolveTargets(
  intake: IntakeChecker,
  db: DB,
  workId: number,
  opts: { onlyMissing?: boolean; includeOwned?: boolean } = {},
): { targets: Resolved[]; meta: { nameZh: string | null; mediaType: 'tv' | 'movie'; tmdbId: number } } {
  const d = intake.workIntake(workId);
  if (!d) return { targets: [], meta: { nameZh: null, mediaType: 'tv', tmdbId: workId } };

  const targets: Resolved[] = [];
  for (const sg of d.seasons) {
    for (const e of sg.episodes) {
      // ⛔ 排除的格、已入库的格、Special 都不下
      // ⭐ §139（2026-11-03 作者「已入库的也安排上下载一条龙，可能会有洗版需求」）：
      //    force 洗版时 `includeOwned: true` 放行已入库的集 —— 否则已入库作品
      //    targets 恒为空，一条龙接口对它毫无作用。
      if (e.excluded) continue;
      if (e.owned && !opts.includeOwned) continue;
      if (sg.isSpecials) continue;
      if (opts.onlyMissing && e.future) continue;
      const vid = e.src?.vid;
      if (!vid) continue;
      if (!e.link) continue; // 没有链接 ⇒ 下不了
      targets.push({
        vid,
        mediaType: d.mediaType,
        tmdbId: d.workId,
        season: e.season,
        episode: e.episode,
        fileBase: buildLinkFileBase(d.nameZh, d.workId, e.season, e.episode),
      });
    }
  }
  return { targets, meta: { nameZh: d.nameZh, mediaType: d.mediaType, tmdbId: d.workId } };
}

/**
 * ⭐ 「这部作品里**已经下好**的 vid」快照。
 *
 * 🔴 F17（2026-10-31 代码审查）：`resolveTargets` 的 missing 判据是 **Emby 已入库**，
 *    ⛔ 不看 `work_dl.done_at`。所以「已下好但还没入库 / 还没被 Emby 扫到」的集
 *    仍然在 targets 里 ⇒ `worker.enqueue()` 的 UPSERT 会把 `done_at` 清成 NULL
 *    （重下要这个语义）⇒ **整批重下**。
 *
 *    这正是 §96 踩过的「一轮重下 12 集 3GB」，当时只在 `/oneshot` 里用快照挡住，
 *    而前端两个下载按钮（单集 data-dl / 整部 dlall）走的**都是** `/api/dl/enqueue`
 *    ⇒ 那个洞一直开在主路径上。
 *
 * ⚠️ 调用时序铁律：**先快照 → 再入队**。反过来查到的全是 NULL（enqueue 已清 done_at）。
 * ⚠️ 老库无 work_dl ⇒ 返回空集合（全当没下过），不抛错。
 */
export function dlDoneVidsOf(db: DB, workId: number): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .prepare(
        `SELECT vid FROM work_dl
          WHERE tmdb_id = ? AND done_at IS NOT NULL AND revoked_at IS NULL`,
      )
      .all(workId) as Array<{ vid: string }>;
    for (const r of rows) set.add(String(r.vid));
  } catch {
    /* 老库无 work_dl ⇒ 全当没下过 */
  }
  return set;
}

export function registerDlApi(
  app: FastifyInstance,
  opts: DlApiOptions,
): { worker: DlWorker; ingest: IngestWorker | null; scraper: Scraper | null } {
  const { db, cfg } = opts;
  const intake = new IntakeChecker(db, loadHnEpMap());
  const dl = new DownloadService(db, cfg);
  const relink = opts.relink ? new RelinkService(db, opts.relink) : null;

  /* ⭐ §88 队列 worker —— 常驻。接口只入队，真正的下载在这里跑。 */
  const worker = new DlWorker(db, dl, {
    maxAttempts: opts.worker?.maxAttempts ?? 2,
    minFreeGb: opts.worker?.minFreeGb ?? 20,
    /* 🔴 §89：把 relink 注入 worker —— 否则签名过期/470 之后永远不自愈。
       旧实现只给同步接口 `/api/dl/one` 装了重抓，队列化时漏搬。 */
    relink: relink ?? undefined,
  });

  /** 落盘绝对路径（容器内）—— 入队时就算好，worker 靠它反推文件名 */
  const filePathOf = (t: Resolved): string =>
    `${cfg.root}/${cfg.subdir}/${t.fileBase}.mp4`;

  /** 把 resolveTargets 的结果转成入队载荷 */
  const toEnqueueItems = (ts: Resolved[]) =>
    ts.map((t) => ({
      vid: t.vid,
      mediaType: t.mediaType,
      tmdbId: t.tmdbId,
      season: t.season,
      episode: t.episode,
      fileBase: t.fileBase,
      filePath: filePathOf(t),
    }));

  /* ⭐ §92 刮削入库 —— **自研刮削器** + 入库 worker（未配媒体库根目录就整体关掉，⛔ 不半残）
     🔴 不再依赖 MoviePilot：TMDB 取详情 / 写 nfo / 下图片 / 复制落位全在自己进程里跑。 */
  const scraper = opts.scrape?.libraryRoot
    ? new Scraper({
        ...opts.scrape,
        /**
         * 🔴 N2（2026-10-31 复核）：给刮削器一个「这库以前用过吗」的探针。
         *   ENOENT 时用它区分「真·新库」和「115 挂载没就绪」——
         *   挂载没就绪时 mkdir 会把目录建到挂载点底下的真实磁盘，挂载恢复后被遮蔽，
         *   文件还在但 Emby 永远看不到（Compose 注释里 2026-10-28 真实发生过）。
         *
         *   锚点用 `work_ingest` 的历史 done（⛔ 不是 tmdb_work 计数：
         *   看板库 1635 部与媒体目录是两回事，新部署时同样非空 ⇒ 会误杀新库）。
         *   表还没建（migration #19 之前）时返回 false，不影响首次部署。
         */
        libraryEverUsed: () => {
          try {
            return Boolean(
              db
                .prepare('SELECT 1 AS x FROM work_ingest WHERE done_at IS NOT NULL LIMIT 1')
                .get(),
            );
          } catch {
            return false;
          }
        },
      })
    : null;
  /* ⭐ §93-3 CMS 客户端：入库第二步（115 原件 → strm 库），Emby 只认 strm 库 */
  const cmsCfg = opts.scrape?.cms;
  const cms = cmsCfg ? new CmsClient(cmsCfg) : null;
  const ingest = scraper
    ? new IngestWorker(db, scraper, {
        maxAttempts: opts.scrape?.maxAttempts ?? 3,
        cms,
        cmsAutoSync: cmsCfg?.autoSync,
        strmRoot: opts.scrape?.strmRoot ?? null,
      })
    : null;

  /** 某作品的逐集下载状态 */
  app.get('/api/dl/status', async (req) => {
    const q = req.query as { workId?: string };
    const workId = Number(q.workId ?? '');
    if (!Number.isFinite(workId) || workId <= 0) {
      return { ok: false, error: 'workId 非法' };
    }
    const { targets } = resolveTargets(intake, db, workId);
    const states = dl.statusOf(targets.map((t) => t.vid));
    return {
      ok: true,
      workId,
      items: targets.map((t) => ({
        vid: t.vid,
        season: t.season,
        episode: t.episode,
        fileBase: t.fileBase,
        state: states.get(t.vid) ?? null,
      })),
    };
  });

  /** 单集的链接详情（前端「看链接」用） */
  app.get('/api/dl/link/:vid', async (req, reply) => {
    const { vid } = req.params as { vid: string };
    const link = dl.getLink(vid);
    if (!link) return reply.code(404).send({ ok: false, error: '没有这一集的链接' });
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      link: {
        vid: link.vid,
        url: link.url,
        quality: link.quality,
        srcKind: link.src_kind,
        isM3u8: Number(link.is_m3u8) === 1,
        expiresAt: link.expires_at,
        /** ⭐ §116 这一集的真实字节数（HEAD 拿的）；null = 没补过 */
        size: (link as { size?: number | null }).size ?? null,
        expired: link.expires_at != null && link.expires_at <= nowSec,
        remainSec: link.expires_at != null ? link.expires_at - nowSec : null,
      },
    };
  });

  /** 下载单集 */
  app.post('/api/dl/one', async (req, reply) => {
    const b = (req.body ?? {}) as { workId?: number; vid?: string };
    const workId = Number(b.workId ?? 0);
    const vid = String(b.vid ?? '').trim();
    if (!vid) return reply.code(400).send({ ok: false, error: 'vid 不能为空' });

    let targets: Resolved[];
    if (Number.isFinite(workId) && workId > 0) {
      targets = resolveTargets(intake, db, workId).targets;
    } else {
      // 没给 workId ⇒ 只落盘名要不到中文剧名 ⇒ ⛔ 要求必须给 workId
      return reply.code(400).send({ ok: false, error: '缺 workId（落盘文件名要用 TMDB 剧名）' });
    }
    const t = targets.find((x) => x.vid === vid);
    if (!t) {
      return reply.code(404).send({ ok: false, error: '这一集不在可下载范围（已入库/已排除/无链接）' });
    }

    const r = await dl.download(t);
    if (!r.ok) {
      /* 🔴 签名失效 ⇒ 自动重抓一次再下。
       *
       * ⭐ 2026-10-29 浏览器点击实测发现（重要）：
       *  - `link_expired`：`expires_at` 已过 ⇒ 明确的过期
       *  - `link_forbidden`：HTTP 403/470 ⇒ **expires_at 还在未来，但源站已经拒了**
       *    （实测 vid 12043 youjizz 无签名预览版 → 470；重抓能换成有签名版）
       * ⇒ 两者都要触发重抓，否则用户点「重试」永远还是同一个错，功能等于死掉。
       *
       * ⚠️ 重抓会开真浏览器解 CF，**慢**（8~20 秒）⇒ 只在这两种明确场景下触发。
       * ⛔ HTTP 404 不重抓（CDN 上根本没这个副本，重抓也白搭）。 */
      const needRelink = r.code === 'link_expired' || r.code === 'link_forbidden';
      if (needRelink && relink) {
        const rr = await relink.relinkOne(vid);
        if (rr.ok) {
          const r2 = await dl.download(t);
          if (r2.ok) {
            return {
              ok: true,
              vid: r2.vid,
              filePath: r2.filePath,
              bytes: r2.bytes,
              quality: r2.quality,
              secs: Number(r2.secs.toFixed(1)),
              relinked: true,
            };
          }
          const code2 = r2.code === 'link_expired' ? 409 : r2.code === 'm3u8_unsupported' ? 501 : 500;
          return reply.code(code2).send({ ok: false, error: r2.error, code: r2.code, vid, relinked: true });
        }
        const msg =
          r.code === 'link_forbidden'
            ? `签名已失效（HTTP ${r.error.match(/\d+/)?.[0] ?? ''}），自动重抓也失败：${rr.error ?? '未知原因'}`
            : `签名已过期，自动重抓也失败：${rr.error ?? '未知原因'}`;
        return reply.code(409).send({
          ok: false,
          error: msg,
          code: r.code,
          vid,
          relinked: false,
        });
      }
      const code = r.code === 'link_expired' ? 409 : r.code === 'm3u8_unsupported' ? 501 : 500;
      return reply.code(code).send({ ok: false, error: r.error, code: r.code, vid });
    }
    return {
      ok: true,
      vid: r.vid,
      filePath: r.filePath,
      bytes: r.bytes,
      quality: r.quality,
      secs: Number(r.secs.toFixed(1)),
    };
  });

  /**
   * 下载整部（串行，⛔ 不并发 —— 会打爆代理与 CDN）
   *
   * @param onlyMissing 只下「已入库检测判定为缺」的集（默认 true）
   */
  app.post('/api/dl/work', async (req, reply) => {
    const b = (req.body ?? {}) as { workId?: number; onlyMissing?: boolean };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const onlyMissing = b.onlyMissing !== false;
    const { targets, meta } = resolveTargets(intake, db, workId, { onlyMissing });

    if (!targets.length) {
      return { ok: true, workId, nameZh: meta.nameZh, total: 0, done: 0, failed: 0, results: [] };
    }

    const results: Array<Record<string, unknown>> = [];
    let done = 0;
    let failed = 0;
    for (const t of targets) {
      const r = await dl.download(t);
      if (r.ok) {
        done++;
        results.push({ vid: r.vid, ok: true, bytes: r.bytes, filePath: r.filePath, secs: Number(r.secs.toFixed(1)) });
      } else {
        failed++;
        results.push({ vid: r.vid, ok: false, error: r.error, code: r.code });
      }
    }
    return { ok: true, workId, nameZh: meta.nameZh, total: targets.length, done, failed, results };
  });

  /** 人工作废（文件被手动删了）—— ⛔ 不 DELETE，只写 revoked_at */
  app.post('/api/dl/revoke', async (req) => {
    const b = (req.body ?? {}) as { vid?: string };
    const vid = String(b.vid ?? '').trim();
    if (!vid) return { ok: false, error: 'vid 不能为空' };
    return { ok: dl.revoke(vid) };
  });

  /* ══════════════════════════════════════════════════════════════════
     ⭐ §88（2026-10-30）下载队列 —— 「进度看得见」
     ══════════════════════════════════════════════════════════════════ */

  /**
   * ⭐ 入队：单集 / 整部缺集 / 指定 vid 列表。
   *
   * 🔴 为什么不再用同步的 /api/dl/one：
   *   一集 250MB / 6MB/s ≈ 40 秒，整部 12 集 ≈ 8 分钟。
   *   同步接口挂那么久，浏览器刷新就断，中途零反馈。
   * ⇒ 现在接口只写队列（毫秒返回），下载在常驻 worker 里跑，
   *   前端 1 秒轮询 /api/dl/queue 看进度。
   *
   * @param workId 作品 id（必填 —— 落盘名要 TMDB 剧名）
   * @param vids   只入队这些集；不传 = 整部缺集
   * @param onlyMissing 默认 true（只下「入库检测判定为缺」的）
   */
  app.post('/api/dl/enqueue', async (req, reply) => {
    const b = (req.body ?? {}) as { workId?: number; vids?: string[]; onlyMissing?: boolean };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const onlyMissing = b.onlyMissing !== false;
    /* 🔴 F17：先快照「已下好」的 vid，再入队 —— 顺序反了就查到全 NULL（见 dlDoneVidsOf 注释） */
    const dlDone = dlDoneVidsOf(db, workId);
    const { targets, meta } = resolveTargets(intake, db, workId, { onlyMissing });
    if (!targets.length) {
      return { ok: true, workId, nameZh: meta.nameZh, enqueued: 0, total: 0, alreadyDownloaded: 0 };
    }
    const want = (b.vids ?? []).map((v) => String(v).trim()).filter(Boolean);
    /* 🔴 F17：已下好的集**不再重下**（原来这里只按 onlyMissing 过滤 ⇒ 3GB 重下事故原样复现） */
    const picked = (want.length ? targets.filter((t) => want.includes(t.vid)) : targets)
      .filter((t) => !dlDone.has(t.vid));
    const enqueued = picked.length ? worker.enqueue(toEnqueueItems(picked)) : 0;
    if (enqueued && !worker.status.running) worker.start();
    return {
      ok: true, workId, nameZh: meta.nameZh,
      enqueued, total: targets.length,
      /**
       * 这批里「已经下过、被跳过」的条数 —— 前端据此区分「没有要下的」和「真的失败」（F31）。
       * 🔴 N1（2026-10-31 复核）：不能再写 `targets.length - picked.length`。
       *    单集点击传 vids:[vid]，**若这一集没有链接/已入库，它压根不在 targets 里**
       *    ⇒ picked 为空、但差值 = 整部其他缺集数 ⇒ 弹「这一集已经下载过了」，
       *    真相却是「这一集没有可下载的链接」。必须只数真正已被 dlDone 命中的。
       */
      alreadyDownloaded: targets.filter((t) => dlDone.has(t.vid)).length,
      queue: worker.list(1000).length,
    };
  });

  /**
   * ⭐ 队列全貌（前端「下载」页 1 秒轮询这个）。
   *
   * 返回：队列条目 + 汇总计数 + **按通道的流量统计**（机场流量看这个）
   */
  app.get('/api/dl/queue', async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 300) || 300, 1), 1000);
    const items = worker.list(limit);
    const counts = { queued: 0, running: 0, done: 0, failed: 0, revoked: 0 };
    for (const it of items) counts[stateOf(it)]++;
    const traffic = worker.traffic();
    /* ⭐ §89：队列空着时也要能报磁盘余量（否则看板永远显示「—」） */
    await worker.touchDisk(`${cfg.root}/${cfg.subdir}`);
    const channels = dl.channels().map((c) => ({ id: c.id, kind: c.kind }));
    return {
      ok: true,
      worker: worker.status,
      disk: worker.diskStatus,
      channels,
      /** ⭐ §90 当前代理模式 —— 前端据此渲染通道开关（省一次请求，1 秒轮询里带上） */
      proxyMode: dl.proxyMode(),
      counts,
      traffic,
      items: items.map((it) => ({
        vid: it.vid,
        tmdbId: it.tmdbId,
        mediaType: it.mediaType,
        season: it.season,
        episode: it.episode,
        filePath: it.filePath,
        state: stateOf(it),
        progressBytes: it.progressBytes,
        totalBytes: it.totalBytes,
        speedKbps: it.speedKbps,
        channel: it.channel,
        error: it.error,
        attempts: it.attempts,
        queuedAt: it.queuedAt,
        doneAt: it.doneAt,
      })),
    };
  });

  /** ⭐ 暂停 / 继续队列（设「晚上别下，白天再说」用） */
  app.post('/api/dl/pause', async () => {
    worker.pause();
    return { ok: true, ...worker.status };
  });

  app.post('/api/dl/resume', async () => {
    worker.resume();
    if (!worker.status.running) worker.start();
    return { ok: true, ...worker.status };
  });

  /** ⭐ 取消某一集（从队列拿走，⛔ 不删记录） */
  app.post('/api/dl/cancel', async (req) => {
    const b = (req.body ?? {}) as { vid?: string };
    const vid = String(b.vid ?? '').trim();
    if (!vid) return { ok: false, error: 'vid 不能为空' };
    return { ok: worker.cancel(vid) };
  });

  /** ⭐ 把失败的一集重新塞回队列（用户点「重试」） */
  app.post('/api/dl/requeue', async (req) => {
    const b = (req.body ?? {}) as { workId?: number; vid?: string };
    const vid = String(b.vid ?? '').trim();
    const workId = Number(b.workId ?? 0);
    if (!vid || !Number.isFinite(workId) || workId <= 0) {
      return { ok: false, error: 'vid / workId 都要给' };
    }
    const { targets } = resolveTargets(intake, db, workId);
    const t = targets.find((x) => x.vid === vid);
    if (!t) return { ok: false, error: '这一集不在可下载范围' };
    const n = worker.enqueue(toEnqueueItems([t]));
    if (!worker.status.running) worker.start();
    return { ok: n > 0, enqueued: n };
  });

  /* ══════════════════════════════════════════════════════════════════
     ⭐ §85 签名重抓 API
     ══════════════════════════════════════════════════════════════════ */

  /**
   * 单集重抓 —— 前端「需重抓」徽章点一下就刷新签名。
   *
   * 🔴 FlareSolverr 开真浏览器，**慢**（8~20 秒）⇒ 前端要显示 loading，不能无提示干等。
   */
  app.post('/api/dl/relink', async (req, reply) => {
    if (!relink) return reply.code(501).send({ ok: false, error: '未配置重抓通道' });
    const b = (req.body ?? {}) as { vid?: string };
    const vid = String(b.vid ?? '').trim();
    if (!vid) return reply.code(400).send({ ok: false, error: 'vid 不能为空' });
    const r = await relink.relinkOne(vid);
    if (!r.ok) return reply.code(404).send({ ok: false, error: r.error, vid });
    return {
      ok: true,
      vid,
      url: r.link!.url,
      quality: r.link!.quality,
      srcKind: r.link!.srcKind,
      expiresAt: r.link!.expiresAt,
    };
  });

  /**
   * 批量重抓过期链接。
   *
   * 🔴 慢（每集 8~20 秒）⇒ 必须限量（默认 10），⛔ 不能一次几百条。
   * @param all true = 全量刷新（不只是过期的）；默认只抓已过期的
   */
  app.post('/api/dl/relink-expired', async (req, reply) => {
    if (!relink) return reply.code(501).send({ ok: false, error: '未配置重抓通道' });
    const b = (req.body ?? {}) as { limit?: number; all?: boolean };
    const limit = Math.min(Math.max(Number(b.limit ?? 10) || 10, 1), 50);
    const all = b.all === true;
    const results = await relink.relinkExpired(limit, !all);
    const ok = results.filter((r) => r.ok).length;
    return { ok: true, total: results.length, succeeded: ok, failed: results.length - ok, results };
  });

  /* ══════════════════════════════════════════════════════════════════
     ⭐ §86（2026-10-30）链接覆盖对账 —— 「后期抓的剧集和链接真的落地了吗」
     ══════════════════════════════════════════════════════════════════ */

  /**
   * ⭐ 全局链接健康报告。
   *
   * 🔴 作者的核心诉求（2026-10-30）：
   *   「我需要确定后期抓的剧集和下载链接是真的落地到看板」
   * ⇒ 这个接口就是那个「验收器」：
   *   - `srcTotal` 源侧（hanime entry_detail）去重后的集数 —— **分母**
   *   - `linked` 已有链接的集数 —— **分子**
   *   - `missing` 真缺口（源侧有、链接表没有）
   *   - `expired` 签名已过期（明天 05:01 集体过期就是这个数）
   *   - `lastFetchedAt` 最后一次抓链接的时间 —— **证明增量抓取在跑**
   */
  app.get('/api/dl/audit', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 2000);
    return { ok: true, ...auditLinks(db, limit) };
  });

  /**
   * ⭐ §90 下载通道设置（代理模式）。
   *
   * | proxyMode | 行为 | 机场流量 |
   * |---|---|---|
   * | `off`（默认） | 只直连，IP 全被封就**如实报错** | 0 |
   * | `fallback` | 直连全灭才降级代理 | 只有失败集 |
   * | `always` | 只用代理 | 全部 |
   *
   * 🔴 只影响**下视频文件**；抓链接（relink）走 FlareSolverr，不在这个开关管辖内。
   */
  app.get('/api/dl/settings', async () => ({
    ok: true,
    settings: cfg.settings?.get() ?? { proxyMode: 'off' },
    /** 当前实际会用到的通道顺序，方便前端直接展示 */
    channels: dl.channels().map((c) => c.id),
  }));

  app.post('/api/dl/settings', async (req, reply) => {
    const b = (req.body ?? {}) as { proxyMode?: string };
    const mode = String(b.proxyMode ?? '');
    if (mode !== 'off' && mode !== 'fallback' && mode !== 'always') {
      return reply.code(400).send({ ok: false, error: 'proxyMode 只能是 off / fallback / always' });
    }
    if (!cfg.settings) {
      return reply.code(501).send({ ok: false, error: '未配置设置存储（重启服务）' });
    }
    const next = cfg.settings.set({ proxyMode: mode });
    return { ok: true, settings: next, channels: dl.channels().map((c) => c.id) };
  });

  /**
   * ⭐ 手动补链接（针对指定 vid 列表，或不传就补「源侧有、链接表没有」的缺口）。
   *
   * 🔴 慢（每集 8~20 秒）⇒ 必须限量 ⇒ 前端要有 loading 态。
   */
  app.post('/api/dl/sync', async (req, reply) => {
    if (!relink) return reply.code(501).send({ ok: false, error: '未配置重抓通道' });
    const b = (req.body ?? {}) as { vids?: string[]; limit?: number };
    const limit = Math.min(Math.max(Number(b.limit ?? 20) || 20, 1), 50);
    const vids = (b.vids ?? []).map((v) => String(v).trim()).filter(Boolean);
    const r: LinkSyncResult = vids.length
      ? await syncLinksForVids(db, relink, vids.slice(0, limit))
      : await syncMissingLinks(db, relink, { limit });
    return { ok: true, ...r };
  });

  /**
   * ⭐ 刷新即将过期的链接（签名 TTL ≈ 11 小时 ⇒ 这是每天都要跑的活儿）。
   */
  app.post('/api/dl/refresh-expiring', async (req, reply) => {
    if (!relink) return reply.code(501).send({ ok: false, error: '未配置重抓通道' });
    const b = (req.body ?? {}) as { limit?: number; horizonSec?: number };
    const limit = Math.min(Math.max(Number(b.limit ?? 20) || 20, 1), 50);
    const r = await refreshExpiringLinks(db, relink, {
      limit,
      horizonSec: Number(b.horizonSec ?? 6 * 3600),
    });
    return { ok: true, ...r };
  });

  /* ══════════════════════════════════════════════════════════════════
     ⭐ §91（2026-10-30）刮削入库 —— 「抓取 → 下载 → 刮削 → 入库」一条龙
     ══════════════════════════════════════════════════════════════════ */

  /**
   * 把某作品「已下载但还没入库」的集，以及「等下载」的集，塞进刮削队列。
   *
   * 🔴 两类要分开对待：
   *   - 已下载（work_dl.done）：立刻可刮 ⇒ queued_at = now
   *   - 还没下（缺集）：先挂 waiting，等 worker 的 promoteWaiting() 在下载完成后提升
   * ⛔ 已经入库过的（work_ingest.done_at 非空）不再入队 —— 否则每点一次就把整部重刮一遍，
   *    MP 那边会当成重复整理，几百 MB 重传。
   */
  const ingestEnqueue = (
    workId: number,
    vids?: string[],
    /** ⭐ §139 洗版：跳过 work_ingest done 过滤，已入库的也重新刮削入库 */
    force = false,
  ): { queued: number; waiting: number; skipped: number; nameZh: string | null } => {
    if (!ingest) return { queued: 0, waiting: 0, skipped: 0, nameZh: null };
    const want = (vids ?? []).map((v) => String(v).trim()).filter(Boolean);
    const pick = <T extends { vid: string }>(arr: T[]) =>
      want.length ? arr.filter((x) => want.includes(x.vid)) : arr;

    /** ① 已下载、未入库 */
    let downloaded: Array<{ vid: string; tmdb_id: number; season: number; episode: number; file_path: string }> = [];
    try {
      downloaded = db
        .prepare(
          `SELECT d.vid, d.tmdb_id, d.season, d.episode, d.file_path
             FROM work_dl d
            WHERE d.tmdb_id = ? AND d.done_at IS NOT NULL AND d.revoked_at IS NULL
              AND d.file_path IS NOT NULL
              ${
                force
                  ? /* ⭐ §139 洗版：已入库的也重新入刮削队列 */
                    ''
                  : `AND NOT EXISTS (SELECT 1 FROM work_ingest i
                               WHERE i.vid = d.vid AND i.done_at IS NOT NULL)`
              }`,
        )
        .all(workId) as typeof downloaded;
    } catch {
      /* 老库无 work_dl / work_ingest ⇒ 空跑 */
    }

    /** ② 还没下的缺集（只登记「等下载」，不在这里触发下载） */
    const { targets, meta } = resolveTargets(intake, db, workId, {
      onlyMissing: true,
      includeOwned: force,
    });
    const dlDone = new Set(downloaded.map((d) => String(d.vid)));
    const pending = targets.filter((t) => !dlDone.has(t.vid));

    const q1 = pick(downloaded).map((d) => ({
      vid: String(d.vid),
      tmdbId: Number(d.tmdb_id ?? workId),
      season: Number(d.season ?? 1),
      episode: Number(d.episode ?? 0),
      srcPath: String(d.file_path),
      waitDownload: false,
    }));
    const q2 = pick(pending).map((t) => ({
      vid: t.vid,
      tmdbId: t.tmdbId,
      season: t.season,
      episode: t.episode,
      srcPath: filePathOf(t),
      waitDownload: true,
    }));

    const queued = ingest.enqueue(q1);
    const waiting = ingest.enqueue(q2);
    if (!ingest.status.running) ingest.start();
    return { queued, waiting, skipped: 0, nameZh: meta.nameZh };
  };

  /**
   * ⭐ 刮削器自检（前端「下载」页显示、排查用）。
   *
   * 🔴 这里**不报「在线」**，只报「媒体库根目录能不能写」——
   *    自研刮削的失败点从「MP 挂了」变成了「115 挂载没起来 / 没权限」，
   *    那才是真正会卡住入库的东西（0cs：口径要讲出来，别让人猜）。
   */
  app.get('/api/dl/scraper', async () => {
    if (!scraper) {
      return { ok: false, enabled: false, error: '未配置媒体库根目录（SCRAPE_LIBRARY_ROOT）' };
    }
    const root = opts.scrape?.libraryRoot ?? '';
    const probe = await probeDir(root);
    return {
      ok: true,
      enabled: true,
      libraryRoot: root,
      writable: probe.ok,
      probeError: probe.error ?? null,
      dirCount: probe.count ?? null,
      tmdb: {
        baseUrl: opts.scrape?.tmdb.baseUrl ?? null,
        proxy: opts.scrape?.tmdb.proxy ? '已配置' : '直连',
      },
      /* ⭐ §93-3 入库第二步：CMS 有没有配、上次同步结果（看板要能看出「同步了没有」）*/
      cms: {
        configured: Boolean(cms?.configured),
        endpoint: cms?.endpoint ?? null,
        autoSync: cmsCfg?.autoSync !== false,
        last: ingest?.status.lastCms ?? null,
      },
      worker: ingest?.status ?? null,
    };
  });

  /**
   * ⭐ §93-3 手动触发一次 CMS 增量同步。
   *
   * 什么时候用：入库完成但 Emby 里没出现 —— 多半是 CMS 那次没跑到
   * （或自动同步被关了）。点一下比去 CMS 网页里找按钮快。
   *
   * ⛔ 只走 `/api/sync/lift`（增量），**绝不调 `/api/sync/full`** ——
   *    全量同步会把整个 115 重扫一遍，几十分钟起步。
   */
  app.post('/api/dl/cms/sync', async (_req, reply) => {
    if (!cms) return reply.code(501).send({ ok: false, error: '未配置 CMS（缺 CMS_BASE_URL/USER/PASS）' });
    if (!cms.configured) {
      return reply.code(200).send({ ok: false, error: 'CMS 账号未配置（CMS_USER / CMS_PASS）' });
    }
    /* 🔴 走 ingest 的同一份逻辑（0lx），**不**直接调 cms.triggerSync()。
       原因（2026-10-31 部署验收实测）：直接调只把结果放进 HTTP 返回体，
       worker.status.lastCms 不更新 ⇒ 前端点完「同步 CMS」toast 一闪，
       页面上「上次同步」那行永远是「还没触发过」⇒ 用户以为按钮没用、以为部署没成功。
       F28 同族：接口成功 ≠ 结果可见。 */
    if (ingest) {
      const r = await ingest.syncCmsManually();
      return { ok: r.ok, message: r.message, ms: r.ms };
    }
    const r = await cms.triggerSync();
    return { ok: r.ok, message: r.message, ms: r.ms };
  });

  /** CMS 连通性自检（只登录，不触发同步） */
  app.get('/api/dl/cms/probe', async () => {
    if (!cms) return { ok: false, error: '未配置 CMS' };
    const r = await cms.probe();
    return { ok: r.ok, message: r.message, ms: r.ms, endpoint: cms.endpoint };
  });

  /** 某作品的逐集入库状态（前端画「入库 x/y」与逐集徽章） */
  app.get('/api/dl/ingest', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    const q = req.query as { workId?: string };
    const workId = Number(q.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const r = ingest.list(workId);
    return { ok: true, workId, ...r, worker: ingest.status };
  });

  /**
   * ⭐ 只入库：把这部**已经下载好**的集送去刮削（不重新下载）。
   * 也顺手把缺集登记成「等下载」，一条龙点过之后这里就不用管了。
   */
  app.post('/api/dl/ingest', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    const b = (req.body ?? {}) as { workId?: number; vids?: string[] };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const r = ingestEnqueue(workId, b.vids);
    return { ok: true, workId, ...r };
  });

  /** 人工重试一集（失败 → 重新进队） */
  app.post('/api/dl/ingest/retry', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    const b = (req.body ?? {}) as { vid?: string; workId?: number };
    const vid = String(b.vid ?? '').trim();
    if (vid) return { ok: ingest.retry(vid), vid };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: '需要 vid 或 workId' });
    }
    const r = ingest.list(workId);
    let n = 0;
    for (const it of r.items) if (it.state === 'failed') n += ingest.retry(it.vid) ? 1 : 0;
    return { ok: true, workId, retried: n };
  });

  /**
   * ⭐ §93 重刮 —— 把**已入库**的集退回待刮，重做一遍。
   *
   * 用于两种场景：① 命名规则/字段规则改了，已落位的要跟着更新；
   * ② 某部刮出来的目录名不对（实测：TMDB zh-CN 返回日文原名，落成日文目录）。
   *
   * ⚠️ 只重刮不重下 —— 源文件必须还在，否则 worker 会报 `src_missing`。
   */
  app.post('/api/dl/ingest/rescrape', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    const b = (req.body ?? {}) as { vid?: string; workId?: number };
    const vid = String(b.vid ?? '').trim();
    if (vid) {
      const n = ingest.rescrape({ vid });
      return { ok: n > 0, vid, rescraped: n };
    }
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: '需要 vid 或 workId' });
    }
    const n = ingest.rescrape({ workId });
    return { ok: n > 0, workId, rescraped: n };
  });

  /**
   * ⭐ §93 刮削中心 —— 「刮削」页签的**唯一数据源**（2 秒轮询）。
   *
   * ## 为什么一个接口给全
   * | 区块 | 从哪来 | 用来看什么 |
   * |---|---|---|
   * | `worker` | 内存 | 现在跑没跑、在刮哪一集、第几步 |
   * | `steps`  | 常量 | 八格进度条（未开始的灰格要能画出来）|
   * | `active` | work_ingest 未完成 | 待刮 / 等下载 / 失败（含 err @ 卡在哪步）|
   * | `done`   | work_ingest 最近完成 | 「这段记录」——哪部哪集、什么时候入的库 |
   * | `counts` | 现算聚合 | 顶部四个数字 |
   *
   * 🔴 全部一次返回，⛔ 不让前端打三个请求再拼 —— 三个请求的返回时刻不同，
   *    进度条与数字会互相打架（0cs：口径要讲出来，别让人猜）。
   */
  app.get('/api/dl/scrape/list', async (req) => {
    if (!ingest) {
      return {
        ok: false, enabled: false, counts: null, steps: SCRAPE_STEPS, active: [], done: [],
        /* 🔴 前端刮削页读 `d.cms`：这里不返 ⇒ 页面会常驻「CMS 未配置」并藏掉「同步 CMS」按钮 */
        cms: { configured: Boolean(cms?.configured), last: null },
      };
    }
    const q = (req.query ?? {}) as { doneLimit?: string };
    const doneLimit = Math.min(Math.max(Number(q.doneLimit ?? 120) || 120, 1), 500);
    const r = ingest.all(doneLimit);
    return {
      ok: true,
      enabled: true,
      /** 八步清单（前端据此画「未开始」的灰格） */
      steps: SCRAPE_STEPS,
      worker: ingest.status,
      counts: r.counts,
      active: r.active,
      done: r.done,
      /**
       * 🔴 F28（2026-10-31 代码审查）：前端 `renderScrape()` 读 `d.cms`，
       *    而本接口原来**不返**这个字段 ⇒ `cms.configured` 恒 falsy ⇒
       *    页面常驻「CMS 未配置（缺 CMS_USER/CMS_PASS）——入库后 Emby 不会出现新集」，
       *    且「同步 CMS」按钮**永不渲染**（§97 的手动补同步入口在前端是死的）。
       *    ⇒ 与 `/api/dl/scraper`（:683-689）同口径补上，⛔ 别再让两个接口各说各话（0cs/0lx）。
       */
      cms: { configured: Boolean(cms?.configured), last: ingest.status.lastCms ?? null },
      /** 刮削写库的根目录 —— 让人一眼确认「往哪儿写」，省得猜 */
      libraryRoot: opts.scrape?.libraryRoot ?? null,
    };
  });

  /** 进行中的部（待下页顶部进度条 3 秒轮询这个；⛔ 不重绘卡片，避免滚动跳位） */
  app.get('/api/dl/ingest/active', async () => {
    if (!ingest) return { ok: false, enabled: false, rows: [] };
    const rows = ingest.active();
    if (!rows.length) return { ok: true, enabled: true, rows: [], worker: ingest.status };

    /* 🔴 下载进度也要给（用户要的是「卡在哪一环」）：
          dlDone = work_dl 里下完的集数，dlTotal = 这部登记的集数（ingest.total）
          ⛔ 分母用 ingest.total 而不是 tmdb_episode_total —— 后者可能比实际有源的集多，
             百分比会永远到不了 100%，变成「永远差几集」的假象。 */
    const ids = rows.map((r) => r.workId);
    const marks = ids.map(() => '?').join(',');
    const dlDone = new Map<number, number>();
    try {
      const dr = db
        .prepare(
          `SELECT tmdb_id, COUNT(*) AS n FROM work_dl
            WHERE tmdb_id IN (${marks}) AND done_at IS NOT NULL AND revoked_at IS NULL
            GROUP BY tmdb_id`,
        )
        .all(...ids) as Array<{ tmdb_id: number; n: number }>;
      for (const r of dr) dlDone.set(Number(r.tmdb_id), Number(r.n ?? 0));
    } catch {
      /* 老库无 work_dl ⇒ 只报入库进度 */
    }
    return {
      ok: true,
      enabled: true,
      rows: rows.map((r) => ({
        ...r,
        dlDone: dlDone.get(r.workId) ?? 0,
        dlTotal: r.total,
      })),
      worker: ingest.status,
    };
  });

  /**
   * ⭐⭐ 一条龙：**下载 + 刮削 + 入库**，一次点击。
   *
   * 顺序（worker 保证，不是接口里 for 循环）：
   *   ① 缺集全部进下载队列
   *   ② 全部集（已下的 + 缺的）进刮削队列（缺的挂 waiting）
   *   ③ 下载 worker 下完一集 ⇒ 入库 worker 的 promoteWaiting() 自动把它提升为可刮
   *   ④ 入库 worker 串行刮削 ⇒ 复制进 115 库 + nfo + 图片
   *
   * 🔴 为什么不在接口里同步跑：整部下完 + 入库 = 十几分钟，接口挂不住（0r41）。
   */
  app.post('/api/dl/oneshot', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    /**
     * ⭐ §139（2026-11-03 作者「已入库的也安排上下载一条龙，可能会有洗版需求，先安排上」）：
     *   `force: true` = 洗版 —— 已入库（Emby owned）的集也重新下载 + 重新刮削入库。
     *   普通调用（force 缺省 false）行为与原版完全一致，⛔ 一行不变。
     */
    const b = (req.body ?? {}) as { workId?: number; vids?: string[]; force?: boolean };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const force = b.force === true;
    /* 🔴🔴 必须**先**把「已经下好」的 vid 快照下来，再入队下载。
       踩过的坑（2026-10-30 实测，一轮就重下了 12 集 3GB）：
         `worker.enqueue()` 的 UPSERT 会把 `done_at` 清成 NULL（重下要这个语义），
         所以「先 enqueue、后查 work_dl.done_at」查到的全是 NULL
         ⇒ 已下好的集被当成「缺集」重新排队，同时入库入队也查不到「已下载」
         ⇒ 看板显示「下载 0/12、入库 0/12」，用户以为数据全没了。
       ⇒ 顺序必须是：**快照已完成 → 再入队 → 只入缺的**。
       ⚠️ 2026-10-31 F17：这段逻辑已抽成 `dlDoneVidsOf()`，`/api/dl/enqueue` 同用（0lx）。 */
    const dlDoneVids = dlDoneVidsOf(db, workId);

    // ① 缺集入下载队列（⚠️ 已下好的不再重下；force 洗版时整部都重下）
    const { targets, meta } = resolveTargets(intake, db, workId, {
      onlyMissing: !force,
      includeOwned: force,
    });
    const want = (b.vids ?? []).map((v) => String(v).trim()).filter(Boolean);
    const picked = (want.length ? targets.filter((t) => want.includes(t.vid)) : targets)
      .filter((t) => force || !dlDoneVids.has(t.vid));
    let dlEnqueued = 0;
    if (picked.length) {
      dlEnqueued = worker.enqueue(toEnqueueItems(picked));
      if (!worker.status.running) worker.start();
    }
    // ② 全流程登记到入库队列（已下的立刻可刮，缺的等下载；force 时已入库的也重新刮）
    const r = ingestEnqueue(workId, want.length ? want : undefined, force);
    return {
      ok: true, workId, nameZh: meta.nameZh, force,
      download: {
        enqueued: dlEnqueued,
        missing: Math.max(0, targets.length - (force ? 0 : dlDoneVids.size)),
        alreadyDownloaded: dlDoneVids.size,
      },
      ingest: { queued: r.queued, waiting: r.waiting },
    };
  });

  /* ══════════════════════════════════════════════════════════════════
     ⭐⭐ §135（2026-11-02）逐集来源选择
     「哪一集用 hanime 下、哪一集直接取 mteam 本地视频」+ 一个按钮走完
     下载 → 改名 → 刮削 → 入库
     ══════════════════════════════════════════════════════════════════ */

  /** 读人工选择（只取生效行 = superseded_at IS NULL） */
  const readPicks = (
    workId: number,
  ): Map<
    string,
    { src: SrcPick; hanimeVid: string | null; mtPath: string | null; note: string | null; pickedAt: string }
  > => {
    const map = new Map<
      string,
      { src: SrcPick; hanimeVid: string | null; mtPath: string | null; note: string | null; pickedAt: string }
    >();
    try {
      const rows = db
        .prepare(
          `SELECT season, episode, src, hanime_vid, mt_path, note, picked_at
             FROM work_ep_src
            WHERE work_id = ? AND superseded_at IS NULL`,
        )
        .all(workId) as Array<Record<string, unknown>>;
      for (const r of rows) {
        map.set(`${Number(r.season)}-${Number(r.episode)}`, {
          src: String(r.src) === 'mteam' ? 'mteam' : 'hanime',
          hanimeVid: (r.hanime_vid as string | null) ?? null,
          mtPath: (r.mt_path as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          pickedAt: String(r.picked_at ?? ''),
        });
      }
    } catch {
      /* 老库无 work_ep_src（migration #27 之前）⇒ 全当没选过 */
    }
    return map;
  };

  /**
   * ⭐ 逐集清单 + 可选来源 + 人工选择 + 默认建议。
   *
   * 🔴 为什么用 `intake.workIntake()` 而不是 `resolveTargets()`：
   *   后者只给「可下载」的集（会剔掉已入库/已排除/无链接），
   *   而选择器要**全部集都列出来**（已入库的标灰、排除的标灰），
   *   否则用户会以为「这集消失了」。
   */
  app.get('/api/dl/pick', async (req, reply) => {
    const q = (req.query ?? {}) as { workId?: string };
    const workId = Number(q.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const d = intake.workIntake(workId);
    if (!d) return reply.code(404).send({ ok: false, error: '作品不存在' });

    const picks = readPicks(workId);
    const root = mtRoot();
    const now = Math.floor(Date.now() / 1000);
    const eps: Array<Record<string, unknown>> = [];
    const cnt = { total: 0, owned: 0, excluded: 0, future: 0, pickHanime: 0, pickMteam: 0, noSrc: 0 };

    for (const sg of d.seasons) {
      /* ⭐ §146（2026-11-03 作者「为什么会有漏了没有文件检测的」）：
         S00（特典）原先整季跳过 ⇒ 那些行在「来源」列只剩一个「—」，
         既看不到盘上有多少 MB、也没法单独洗版。
         实测 97718 生吃萝莉 Re：TMDB 把第一话放进 S00E01，Emby 里也有这一集
         （338 MB），但来源列是「—」。
         ⇒ 来源选择是**只读清单**，特典也照列（标 `special:true`，
           整部一条龙仍不下它，见 `/api/dl/run` 的同一条注释）。 */
      for (const e of sg.episodes) {
        cnt.total++;
        if (e.owned) cnt.owned++;
        if (e.excluded) cnt.excluded++;
        if (e.future) cnt.future++;

        const key = `${e.season}-${e.episode}`;
        const mt = await listMtFiles(db, workId, e.season, e.episode, root);
        const hn = e.src?.vid
          ? [{
              vid: e.src.vid,
              quality: e.link?.quality ?? null,
              size: (e.link as { size?: number | null } | null)?.size ?? null,
              expired: e.link?.expiresAt != null && Number(e.link.expiresAt) <= now,
              isM3u8: e.link?.isM3u8 ?? false,
              /* ⭐ §150：这条视频落到这一集是**推出来的**（标题里没集号，按剩余集位补的）。
                 必须透给前端 —— 不然作者会以为「源站明写了这一集」。 */
              guessed: Boolean(e.src.guessed),
            }]
          : [];

        const manual = picks.get(key) ?? null;

        /* 默认建议：人工 > mteam 盘上已有 > hanime 有直链 > 无源 */
        let suggest: SrcPick | 'none';
        let suggestWhy: string;
        if (e.owned) {
          suggest = 'none';
          suggestWhy = '已入库';
        } else if (manual) {
          suggest = manual.src;
          suggestWhy = '你选的';
        } else if (mt.length) {
          suggest = 'mteam';
          suggestWhy = 'mteam 盘上已有，不用下载';
        } else if (hn.length && !hn[0].isM3u8) {
          suggest = 'hanime';
          suggestWhy = hn[0].expired ? '直链已过期，下载前会自动重抓' : '有直链可下';
        } else {
          suggest = 'none';
          suggestWhy = '两边都没资源';
        }
        if (suggest === 'none' && !e.owned) cnt.noSrc++;
        if (manual?.src === 'mteam') cnt.pickMteam++;
        else if (manual?.src === 'hanime') cnt.pickHanime++;

        eps.push({
          season: e.season,
          episode: e.episode,
          /* §146：特典行也列出来（来源列不再整格「—」），前端只做角标，不改执行口径 */
          special: e.season === 0,
          name: e.name,
          airDate: e.airDate,
          owned: e.owned,
          excluded: e.excluded,
          future: e.future,
          dl: e.dl,
          hanime: hn,
          mteam: mt,
          manual,
          suggest,
          suggestWhy,
        });
      }
    }

    return {
      ok: true,
      workId,
      nameZh: d.nameZh,
      nameOriginal: d.nameOriginal,
      mediaType: d.mediaType,
      /** mteam 全量库根（容器内）—— 让人一眼确认「从哪儿取」 */
      mtRoot: root,
      counts: cnt,
      eps,
    };
  });

  /**
   * 存/清某几集的来源选择。
   *
   * 🔴 改选 = **旧行置 superseded_at + 插新行**，⛔ 不 UPDATE、⛔ 不 DELETE。
   *    改过什么要能查得到（人工事实层的通则，同 manual_bind）。
   * `src: 'auto'` = 清除人工选择，回到默认策略。
   */
  app.post('/api/dl/pick', async (req, reply) => {
    const b = (req.body ?? {}) as {
      workId?: number;
      picks?: Array<{
        season?: number;
        episode?: number;
        src?: string;
        hanimeVid?: string | null;
        mtPath?: string | null;
        note?: string | null;
      }>;
    };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const list = Array.isArray(b.picks) ? b.picks : [];
    if (!list.length) return reply.code(400).send({ ok: false, error: 'picks 为空' });

    const nowIso = new Date().toISOString();
    const sup = db.prepare(
      `UPDATE work_ep_src SET superseded_at = ?
        WHERE work_id = ? AND season = ? AND episode = ? AND superseded_at IS NULL`,
    );
    const ins = db.prepare(
      `INSERT INTO work_ep_src (work_id, season, episode, src, hanime_vid, mt_path, note, picked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let saved = 0;
    let cleared = 0;
    let failed = 0;
    try {
      db.exec('BEGIN');
      for (const p of list) {
        const season = Number(p.season ?? 0);
        const episode = Number(p.episode ?? 0);
        if (!Number.isFinite(season) || !Number.isFinite(episode)) { failed++; continue; }
        const raw = String(p.src ?? '').toLowerCase();
        const r = sup.run(nowIso, workId, season, episode);
        const changed = Number(r?.changes ?? 0) > 0;
        if (raw === 'auto' || raw === '') {
          if (changed) cleared++;
          continue;
        }
        if (raw !== 'hanime' && raw !== 'mteam') { failed++; continue; }
        ins.run(
          workId, season, episode, raw,
          raw === 'hanime' ? (p.hanimeVid ?? null) : null,
          raw === 'mteam' ? (p.mtPath ?? null) : null,
          p.note ?? null,
          nowIso,
        );
        saved++;
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return { ok: true, workId, saved, cleared, failed };
  });

  /**
   * ⭐⭐ 按选择执行：**下载（hanime）+ 直接刮削（mteam）+ 改名 + 入库**
   *
   * ## 分流规则（每集各自决定，⛔ 不是整部一刀切）
   * | 选择 | 动作 |
   * |---|---|
   * | hanime | 入下载队列（未下过的才入）→ 下完由 `promoteWaiting()` 自动进刮削 |
   * | mteam  | **不进下载队列** —— 文件就在 `/downloads/mteam里番全量库` 里，
   * |        | 直接把 srcPath 指过去，立刻可刮（0 秒，不花流量） |
   * | auto / 没选 | 默认策略：mteam 盘上有就用 mteam，否则 hanime |
   *
   * ## 🔴 三条不能省的检查
   * ① mteam 文件必须先 `stat` 确认存在 —— 不存在就跳过并如实报，
   *    ⛔ 不塞进队列让 worker 排队后报 src_missing（用户会以为在下）。
   * ② 已入库（owned）/ 已排除 / 未播出 的集一律跳过（与 resolveTargets 同口径）。
   * ③ **先快照 work_dl.done 再入队**（`dlDoneVidsOf`）—— enqueue 会清 done_at，
   *    顺序反了会把已下好的当缺集重下（§96 实测重下过 12 集 3GB）。
   */
  app.post('/api/dl/run', async (req, reply) => {
    if (!ingest) return reply.code(501).send({ ok: false, error: '未配置刮削通道' });
    /**
     * ⭐ §142（2026-11-03 作者「我要的洗版是可以针对单集去洗版，而不是整一部洗」）：
     *   · `eps`   = 只处理这几集（缺省 = 整部，与原行为一致）
     *   · `force` = 洗版：已入库的集也重新下载 / 重新刮削入库（覆盖 115 库文件）
     *   ⚠️ 两个都缺省时，行为与改造前**逐字一致**（已入库跳过、已下好的不重下）。
     */
    const b = (req.body ?? {}) as {
      workId?: number;
      force?: boolean;
      /** ⭐ §147 干跑：只算计划不入队（洗版预演） */
      dry?: boolean;
      eps?: Array<{ season?: number; episode?: number }>;
    };
    const workId = Number(b.workId ?? 0);
    if (!Number.isFinite(workId) || workId <= 0) {
      return reply.code(400).send({ ok: false, error: 'workId 非法' });
    }
    const force = b.force === true;
    const only = new Set(
      (Array.isArray(b.eps) ? b.eps : [])
        .map((x) => `${Number(x?.season)}-${Number(x?.episode)}`)
        .filter((k) => !k.startsWith('NaN')),
    );
    const d = intake.workIntake(workId);
    if (!d) return reply.code(404).send({ ok: false, error: '作品不存在' });

    const picks = readPicks(workId);
    const root = mtRoot();
    const now = Math.floor(Date.now() / 1000);

    interface Plan {
      season: number;
      episode: number;
      src: SrcPick;
      vid: string;
      /** hanime 落盘路径 / mteam 绝对路径 */
      srcPath: string;
      fileBase: string;
      mtPath?: string;
    }
    const plan: Plan[] = [];
    const skipped: Array<{ season: number; episode: number; why: string }> = [];

    for (const sg of d.seasons) {
      /* ⭐ §146（2026-11-03）：整部一条龙仍然**不含特典**（保持原行为，0r118 不动）；
         只有「指定了集」的单集洗版才放行 S00 —— 否则特典行有来源格却点了没反应。 */
      if (sg.isSpecials && !only.size) continue;
      for (const e of sg.episodes) {
        /* ⭐ §142 单集洗版：指定了集就只做这几集 */
        if (only.size && !only.has(`${e.season}-${e.episode}`)) continue;
        if (e.owned && !force) { skipped.push({ season: e.season, episode: e.episode, why: '已入库' }); continue; }
        if (e.excluded) { skipped.push({ season: e.season, episode: e.episode, why: '已排除' }); continue; }
        if (e.future) { skipped.push({ season: e.season, episode: e.episode, why: '还没播出' }); continue; }

        const key = `${e.season}-${e.episode}`;
        const manual = picks.get(key) ?? null;
        const fileBase = buildLinkFileBase(d.nameZh, d.workId, e.season, e.episode);
        const hnPath = filePathOf({
          vid: e.src?.vid ?? '',
          mediaType: d.mediaType,
          tmdbId: d.workId,
          season: e.season,
          episode: e.episode,
          fileBase,
        });

        /* 人工选 mteam ⇒ 只认 mteam（文件不在就如实报，⛔ 不偷偷退回 hanime） */
        if (manual?.src === 'mteam') {
          const mt = await listMtFiles(db, workId, e.season, e.episode, root);
          const want = manual.mtPath
            ? mt.find((f) => f.path === manual.mtPath || f.name === manual.mtPath)
            : mt[0];
          const chosen: MtFile | null = want ?? mt[0] ?? null;
          if (!chosen) {
            skipped.push({ season: e.season, episode: e.episode, why: 'mteam 盘上没有这一集的文件' });
            continue;
          }
          const st = await stat(chosen.abs).catch(() => null);
          if (!st || st.size <= 0) {
            skipped.push({
              season: e.season, episode: e.episode,
              why: `mteam 文件读不到：${chosen.abs}`,
            });
            continue;
          }
          plan.push({
            season: e.season, episode: e.episode, src: 'mteam',
            vid: `mt:${workId}:${e.season}:${e.episode}`,
            srcPath: chosen.abs, fileBase, mtPath: chosen.path,
          });
          continue;
        }

        /* 人工选 hanime / 没选 ⇒ 走 hanime（没选的先看 mteam 有没有，有就不用下） */
        if (!manual) {
          const mt = await listMtFiles(db, workId, e.season, e.episode, root);
          if (mt.length) {
            const st = await stat(mt[0].abs).catch(() => null);
            if (st && st.size > 0) {
              plan.push({
                season: e.season, episode: e.episode, src: 'mteam',
                vid: `mt:${workId}:${e.season}:${e.episode}`,
                srcPath: mt[0].abs, fileBase, mtPath: mt[0].path,
              });
              continue;
            }
          }
        }
        if (!e.src?.vid) {
          skipped.push({ season: e.season, episode: e.episode, why: 'hanime 没有这一集' });
          continue;
        }
        if (!e.link) {
          skipped.push({ season: e.season, episode: e.episode, why: 'hanime 没有直链（需先抓链接）' });
          continue;
        }
        plan.push({
          season: e.season, episode: e.episode, src: 'hanime',
          vid: e.src.vid, srcPath: hnPath, fileBase,
        });

      }
    }

    const hnPlanned = plan.filter((p) => p.src === 'hanime');
    const mtPlanned = plan.filter((p) => p.src === 'mteam');

    /* ① 先快照「已经下好」的 vid —— enqueue 会清 done_at（顺序铁律，见 §96） */
    const dlDone = dlDoneVidsOf(db, workId);
    /* ⭐ §142 洗版：force 时已下好的也重下（换了更高质量的版本，旧文件必须被覆盖） */
    const hnNew = hnPlanned.filter((p) => force || !dlDone.has(p.vid));

    /* ⭐⭐ §147（2026-11-03 作者「洗版流程我们还没执行过，先把流程模拟出来」）：
       **干跑**（`dry:true`）—— 把「会动哪几集、每集从哪来、盘上多大」全算出来，
       一个队列都不入、一个文件都不碰。洗版是覆盖 115 库文件，动手前必须能先看清。 */
    if (b.dry === true) {
      const sz = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
      const items: Array<{
        season: number; episode: number; src: string; vid: string;
        needDownload: boolean; size: number; srcPath: string;
        /** 115 库里这一集现在多大（覆盖前后的对照，0 = 库里没有） */
        libSize: number;
      }> = [];
      const libOf = (s: number, e: number): number => {
        try {
          const r = db
            .prepare('SELECT lib_size FROM ep_media WHERE work_id=? AND season=? AND episode=? LIMIT 1')
            .get(workId, s, e) as { lib_size?: number | null } | undefined;
          return Number(r?.lib_size ?? 0) || 0;
        } catch {
          return 0;
        }
      };
      for (const p of plan) {
        const size = await sz(p.srcPath);
        items.push({
          season: p.season,
          episode: p.episode,
          src: p.src,
          vid: p.vid,
          /** mteam = 盘上文件（0 流量）；hanime = 要真下载 */
          needDownload: p.src === 'hanime' && (force || !dlDone.has(p.vid)),
          /** 盘上实测大小；hanime 未下载时为 0 */
          size,
          srcPath: p.srcPath,
          libSize: libOf(p.season, p.episode),
        });
      }
      return {
        ok: true,
        dry: true,
        workId,
        nameZh: d.nameZh,
        plan: {
          hanime: hnPlanned.length,
          mteam: mtPlanned.length,
          download: items.filter((x) => x.needDownload).length,
          alreadyDownloaded: hnPlanned.length - hnNew.length,
          skip: skipped.length,
        },
        items,
        skipped,
      };
    }

    /* ② hanime 缺集入下载队列 */
    let dlEnqueued = 0;
    if (hnNew.length) {
      dlEnqueued = worker.enqueue(
        toEnqueueItems(
          hnNew.map((p) => ({
            vid: p.vid,
            mediaType: d.mediaType,
            tmdbId: d.workId,
            season: p.season,
            episode: p.episode,
            fileBase: p.fileBase,
          })),
        ),
      );
      if (!worker.status.running) worker.start();
    }

    /* ③ 刮削队列：hanime 走原口径（已下的立刻刮 / 缺的等下载），mteam 直接刮 */
    let ingestQueued = 0;
    let ingestWaiting = 0;
    if (hnPlanned.length) {
      /* ⭐ §142 洗版：force ⇒ 去掉 done_at 守卫（0r205：否则已入库的 vid 静默跳过） */
      const r = ingestEnqueue(workId, hnPlanned.map((p) => p.vid), force);
      ingestQueued += r.queued;
      ingestWaiting += r.waiting;
    }
    if (mtPlanned.length) {
      ingestQueued += ingest.enqueue(
        mtPlanned.map((p) => ({
          vid: p.vid,
          tmdbId: d.workId,
          season: p.season,
          episode: p.episode,
          srcPath: p.srcPath,
          waitDownload: false,
        })),
        force,
      );
    }
    if (!ingest.status.running) ingest.start();

    return {
      ok: true,
      workId,
      nameZh: d.nameZh,
      /** 这批要做什么（前端按钮点完直接显示，不用自己再算一遍） */
      plan: {
        hanime: hnPlanned.length,
        mteam: mtPlanned.length,
        /** 其中 hanime 还要真下载的集数（已下好的不算） */
        download: dlEnqueued,
        alreadyDownloaded: hnPlanned.length - hnNew.length,
        skip: skipped.length,
      },
      download: { enqueued: dlEnqueued },
      ingest: { queued: ingestQueued, waiting: ingestWaiting },
      skipped,
      /** 逐集明细（前端 toast/日志用，排查「为什么这集没动」） */
      items: plan.map((p) => ({
        season: p.season, episode: p.episode, src: p.src, vid: p.vid, srcPath: p.srcPath,
      })),
    };
  });

  /* ⭐ §88：worker 交给 index.ts 决定何时 start（等库 migration 跑完再开） */
  if (opts.autoStart) {
    worker.start();
    if (ingest && opts.scrape?.workerAutoStart !== false) ingest.start();
  }

  return { worker, ingest, scraper };
}
