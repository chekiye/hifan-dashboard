/**
 * ⭐ §85（2026-10-29）hanime 下载服务
 * ⭐ §88（2026-10-30）改造成「多通道 + 断点续传 + 实时进度」
 *
 * ## 职责
 * 把 `source_link` 表里的「最高画质直链」真正落到 NAS 上：
 *   查签名有效期 → 选通道 → 流式落盘 → 记 `work_dl` 审计行。
 *
 * ## 🔴🔴 通道策略（2026-10-30 实测数据，别凭记忆改）
 *
 * 作者的约束：「旁路由机场流量一个月只有 15G」⇒ 能不走代理就不走。
 *
 * | 通道 | 成功率 | 速度 | 说明 |
 * |---|---|---|---|
 * | **直连（hembed）** | 10/12 = 83% | 5.8 MB/s（偶发 39.8） | 失败全是 ECONNRESET，发生在 0.5 秒内 |
 * | 走代理 | 5/5 = 100% | 6.1 MB/s | ⭐ **不比直连快** |
 *
 * ⇒ 关键结论：**代理不提速，只是「打通被 reset 的连接」**。
 *   所以策略是 **直连优先 → 换 IP 重试 → 最后才走代理**，
 *   代理只在 17% 的失败集上消耗流量。
 *
 * ## 🔴 为什么多 IP 重试
 * `vdownload.hembed.com` 解析出 **5 个 IPv4**（143.244.51.x / 89.187.187.x）。
 * Node 默认只连第一个（或 autoSelectFamily 并行试 2 个），
 * 而 CDN 对**部分 IP 直接 RST** ⇒ 换一个 IP 往往就通了。
 * ⇒ 用 undici `Agent` 的 `connect.lookup` 把域名**强制解析到指定 IP**，逐个试。
 *
 * ## ⛔ 历史记录（已作废，留作对照）
 * 2026-10-29 记的是「容器直连 hembed 不通（容器 DNS 优先返 IPv6、无 v6 路由）」。
 * 2026-10-30 复测：容器确实**没有全局 IPv6**，但 Node 的 autoSelectFamily
 * 会自动回落到 IPv4 ⇒ 直连**是通的**，且 83% 成功。原文那条结论只对
 * 「不做 IPv4 回落」的调用方式成立。
 *
 * ## 文件名（MP 实测可识别）
 *   `tmdb剧集名[tmdbid=xxxx]-SXXEXX.mp4`
 *   —— 在 MP v3 容器内跑 `MetaInfo` 实测：`media_id` / `season` / `episode` 全部正确解析。
 * ⛔ 不要用 `{[tmdbid=x;s=1;e=8]}`（v3 认得 tmdbid 但认不得 `s=`/`e=` ⇒ 名字里残留 "Mp4"）。
 *
 * ## ⛔ 不做的事
 * - 不转码、不转封装（作者 2026-10-29：「不需要，只要能播放就行」）
 * - 不处理 m3u8（本轮不做）⇒ 遇 m3u8 直接报错，不静默跳过
 * - 不删文件（铁律 0：⛔ 禁 DELETE）
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolve4 } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import type { DB } from '@hifan/core';
// 🔴 0lx：文件名生成**只有一份实现**（在 matcher 里），server 直接 import
import { buildLinkFileBase, safeFilePart } from '@hifan/matcher';
import { IpMemory } from './dl_ipmem.js';
import type { DlSettingsStore, ProxyMode } from './dl_settings.js';

/** 一条下载通道 */
export interface ChannelSpec {
  /** 稳定标识，会写进 work_dl.channel（统计流量用） */
  id: string;
  kind: 'direct' | 'proxy';
  /** 代理地址（kind=proxy 时必填） */
  url?: string;
}

export interface DownloadConfig {
  /** 代理列表（按顺序降级）。空数组 = 只直连 */
  proxies: string[];
  /** ⭐ 直连优先（默认 true）。false = 只用代理（调试用） */
  directFirst?: boolean;
  /** 代理地址（兼容旧配置：proxies 为空时用它） */
  proxy?: string;
  /** 落盘根目录（容器内路径） */
  root: string;
  /** 落盘子目录（相对 root） */
  subdir: string;
  /** 首字节超时（毫秒）—— 超时就换 IP / 换通道。默认 12000 */
  firstByteTimeoutMs?: number;
  /** 单集总时长上限（毫秒），防止卡死。默认 40 分钟 */
  totalTimeoutMs?: number;
  /**
   * ⭐ §90 运行时设置（代理模式）。不传 ⇒ 当 `off` 处理（永不代理）。
   * 传的是 store 本体而不是快照值 ⇒ 看板上改完，下一集立即生效，不用重建容器。
   */
  settings?: DlSettingsStore;
  /** ⭐ §90 IP 成败记忆的落盘路径。不传 ⇒ 只在内存里记（进程重启就忘） */
  ipMemPath?: string;
}

export interface LinkRow {
  vid: string;
  url: string;
  quality: number | null;
  src_kind: string | null;
  is_m3u8: number | null;
  expires_at: number | null;
}

export interface DlTarget {
  vid: string;
  mediaType: 'tv' | 'movie';
  tmdbId: number;
  season: number;
  episode: number;
  /** 落盘文件名（不含扩展名） */
  fileBase: string;
}

/** 进度回调载荷 */
export interface DlProgress {
  /** 已落盘字节（含续传前已有的部分） */
  bytes: number;
  /** 源站报的总大小；未知为 null */
  total: number | null;
  /** 瞬时速度 KB/s */
  kbps: number;
  /** 当前走的通道 id */
  channel: string;
}

export type ProgressCb = (p: DlProgress) => void;

export type DlResult =
  | {
      ok: true; vid: string; filePath: string; bytes: number;
      quality: number | null; secs: number;
      /** ⭐ 实际走的通道（direct / proxy0 …）—— 算机场流量用 */
      channel: string;
      /** 从头到尾试了几次（含换 IP、换通道） */
      attempts: number;
    }
  | { ok: false; vid: string; error: string; code: DlErrorCode; channel?: string; attempts?: number };

export type DlErrorCode =
  | 'no_link'          // 链接表里没这一集
  | 'link_expired'     // 签名过期（需要重抓）
  /**
   * ⭐ §85（2026-10-29 浏览器点击实测发现）：HTTP 403 / 470。
   *
   * 🔴 现象：签名「看起来没过期」（`expires_at` 还在未来），但源站已经拒了。
   *    实测 vid 12043 → HTTP 470 Unauthorized（youjizz 的无签名预览版要鉴权）。
   * 🔴 后果：只按 `expires_at` 判过期 ⇒ 这类失败**永远不会被自动重抓**。
   * ⇒ 单独一个错误码，让上层能据此触发重抓。
   */
  | 'link_forbidden'   // 403/470 —— 签名实际已失效（需重抓）
  | 'm3u8_unsupported' // HLS 本轮不做
  /**
   * ⭐ §90（2026-10-30）：**直连的 IP 全被源站 RST，而代理已关闭**。
   *
   * 这**不是**下载器坏了，也不是签名问题 —— 是 CDN 那边的节点状态。
   * 之所以要单独一个码：旧行为会默默降级到代理，作者看到流量账里
   * 冒出 111MB 代理消耗才知道走过代理。现在默认不走代理，
   * 撞上这种情况就**如实报错**，让用户自己决定要不要开局代理重试。
   */
  | 'direct_blocked'
  | 'download_failed'  // 其它 HTTP / 网络错（404 等：CDN 无副本，重抓也没用）
  | 'write_failed';    // 落盘错

/**
 * ⭐ §90：直连 IP 全灭、且代理模式为 `off` 时抛这个。
 *
 * 与普通网络错误的区别：这个错误**重试（同一条链接）也没用**，
 * 需要的是「换个时间」或「临时开局代理」。
 */
export class DirectBlockedError extends Error {
  constructor(readonly tried: number) {
    super(
      `直连的 ${tried} 个 IP 全部被源站拒绝（ECONNRESET）；代理通道已关闭，未消耗任何机场流量`,
    );
    this.name = 'DirectBlockedError';
  }
}

/**
 * 这个错误码是否值得「重抓链接再试」。
 *
 * ⛔ `direct_blocked` 不在里面 —— 链接是好的，是 IP 被封，重抓回来还是同一个 CDN。
 */
export function isRelinkWorthy(code: DlErrorCode): boolean {
  return code === 'link_expired' || code === 'link_forbidden' || code === 'no_link';
}

/**
 * ⭐ 带 HTTP 状态码的错误 —— 上层据此判断「要不要触发签名重抓」。
 *
 * 🔴 2026-10-29 实测：光有 message（"HTTP 470"）不够可靠，
 *    ⛔ 靠字符串匹配错误消息太脆 ⇒ 直接把 status 挂出来。
 */
export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/** 403 / 470 ⇒ 签名被判无效，值得重抓一次 */
export function isForbiddenStatus(status: number): boolean {
  return status === 403 || status === 470;
}

/** 判断链接是否还有效（签名过期时间 = Unix 秒） */
export function linkExpired(row: LinkRow, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (row.expires_at == null) return false; // 没过期时间 ⇒ 未知，按有效处理
  return row.expires_at <= nowSec;
}

/**
 * ⭐ 文件名安全化 —— ⛔ 绝不能出现 `/` `\` `:` 等路径分隔符。
 *
 * 🔴 0lx：**唯一实现在 matcher**（`safeFilePart`），这里只是转出。
 */
export { safeFilePart };

/**
 * 生成 MP 可识别的文件名：`剧集名[tmdbid=xxx]-S01E02`
 *
 * 🔴 0lx：**唯一实现在 matcher**（`buildLinkFileBase`），这里只是转出。
 */
export function buildFileBase(
  nameZh: string | null,
  tmdbId: number,
  season: number,
  episode: number,
): string {
  return buildLinkFileBase(nameZh, tmdbId, season, episode);
}

/** 这些错误重试也没用 ⇒ 立刻放弃，不换通道 */
function fatalCode(e: unknown): DlErrorCode | null {
  if (e instanceof HttpStatusError) {
    if (isForbiddenStatus(e.status)) return 'link_forbidden';
    if (e.status === 404 || e.status === 410) return 'download_failed';
  }
  return null;
}

export class DownloadService {
  private _has: boolean | undefined;
  /** 已解析过的域名 → IPv4 列表（同一轮里复用，避免反复查 DNS） */
  private readonly ipCache = new Map<string, { at: number; ips: string[] }>();
  /** ⭐ §90 哪个 IP 能通 / 被 RST 的记忆（跨集、跨重启） */
  private readonly ipMem: IpMemory | null;

  constructor(private readonly db: DB, private readonly cfg: DownloadConfig) {
    this.ipMem = cfg.ipMemPath ? new IpMemory(cfg.ipMemPath) : null;
  }

  /** ⭐ §90 当前代理模式（看板可改；未配置 ⇒ off = 永不代理） */
  proxyMode(): ProxyMode {
    try {
      return this.cfg.settings?.get().proxyMode ?? 'off';
    } catch {
      return 'off';
    }
  }

  /** 表不存在（老库没跑 migration）⇒ 降级成「一个都不能下」，⛔ 不许 500 */
  private get has(): boolean {
    if (this._has === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_dl')`)
          .all() as Array<{ name: string }>;
        this._has = rows.length > 0;
      } catch {
        this._has = false;
      }
    }
    return this._has;
  }

  /** ⭐ 有没有队列字段（migration #18 之后才有） */
  private get hasQueueCols(): boolean {
    try {
      const rows = this.db
        .prepare(`SELECT name FROM pragma_table_info('work_dl')`)
        .all() as Array<{ name: string }>;
      return rows.some((r) => r.name === 'queued_at');
    } catch {
      return false;
    }
  }

  /**
   * 通道列表 —— 由 §90 的 `proxyMode` 决定，默认 **只有直连**。
   *
   * | proxyMode | 返回 |
   * |---|---|
   * | `off`（默认） | `[direct]` —— 机场流量 0 |
   * | `fallback` | `[direct, proxy0, proxy1…]` —— 直连全灭才降级 |
   * | `always` | `[proxy0, proxy1…]` —— 应急/调试 |
   */
  channels(): ChannelSpec[] {
    const mode = this.proxyMode();
    const ps = this.cfg.proxies?.length ? this.cfg.proxies : this.cfg.proxy ? [this.cfg.proxy] : [];
    const proxies: ChannelSpec[] = ps.filter(Boolean).map((u, i) => ({
      id: `proxy${i}`,
      kind: 'proxy' as const,
      url: u,
    }));

    if (mode === 'always') {
      // 连代理都没配 ⇒ 别 500，退回直连
      return proxies.length ? proxies : [{ id: 'direct', kind: 'direct' }];
    }

    const out: ChannelSpec[] = [];
    if (this.cfg.directFirst !== false) out.push({ id: 'direct', kind: 'direct' });
    if (mode === 'fallback') out.push(...proxies);
    // 没有直连也没配代理 ⇒ 至少给个直连（别 500）
    if (!out.length) out.push({ id: 'direct', kind: 'direct' });
    return out;
  }

  /** 取链接行 */
  getLink(vid: string): LinkRow | null {
    try {
      const r = this.db
        .prepare(
          `SELECT vid, url, quality, src_kind, is_m3u8, expires_at
             FROM source_link WHERE vid = ?`,
        )
        .get(vid) as LinkRow | undefined;
      return r ?? null;
    } catch {
      return null;
    }
  }

  /** 已下载记录（当前态）—— 前端渲染「已下 / 下载中 / 失败」用 */
  statusOf(vids: string[]): Map<string, {
    state: 'queued' | 'running' | 'done' | 'failed';
    filePath: string | null; bytes: number | null; error: string | null;
  }> {
    const out = new Map<string, {
      state: 'queued' | 'running' | 'done' | 'failed';
      filePath: string | null; bytes: number | null; error: string | null;
    }>();
    if (!this.has || !vids.length) return out;
    const qcols = this.hasQueueCols;
    try {
      const marks = vids.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT vid, file_path, bytes, error_msg, started_at, done_at, revoked_at
                  ${qcols ? ', queued_at, progress_bytes, beam_at' : ''}
             FROM work_dl WHERE vid IN (${marks})`,
        )
        .all(...vids) as Array<Record<string, unknown>>;
      for (const r of rows) {
        if (r.revoked_at) continue; // ⛔ 人工作废 ⇒ 不算已下
        const doneAt = r.done_at as string | null;
        const err = r.error_msg as string | null;
        const queuedAt = (r.queued_at as string | null) ?? null;
        const beam = (r.beam_at as string | null) ?? null;
        const prog = r.progress_bytes == null ? null : Number(r.progress_bytes);
        // ⭐ 心跳 90 秒内 ⇒ 真在跑；否则是僵死（进程被杀）
        const alive = beam ? Date.now() - Date.parse(beam) < 90_000 : false;
        const state: 'queued' | 'running' | 'done' | 'failed' = doneAt
          ? 'done'
          : err && !queuedAt
            ? 'failed'
            : queuedAt && !err
              ? alive || (prog != null && prog > 0) ? 'running' : 'queued'
              : err
                ? 'failed'
                : 'queued';
        out.set(String(r.vid), {
          state,
          filePath: (r.file_path as string | null) ?? null,
          bytes: r.bytes == null ? null : Number(r.bytes),
          error: err,
        });
      }
    } catch {
      /* 表还没建 ⇒ 当作没下过 */
    }
    return out;
  }

  /**
   * ⭐ 核心：下载一集。
   *
   * 流程：直连（多 IP 逐个试）→ 代理1 → 代理2 …
   * 中途断流 ⇒ 用 Range 续传，接着往同一个文件写，⛔ 不从头重下。
   */
  async download(target: DlTarget, onProgress?: ProgressCb): Promise<DlResult> {
    const { vid } = target;

    const link = this.getLink(vid);
    if (!link) return { ok: false, vid, error: '链接表里没有这一集', code: 'no_link' };
    if (link.is_m3u8) {
      return { ok: false, vid, error: 'HLS(m3u8) 暂不支持', code: 'm3u8_unsupported' };
    }
    if (linkExpired(link)) {
      return { ok: false, vid, error: '签名已过期，需要重新抓取链接', code: 'link_expired' };
    }

    const outDir = join(this.cfg.root, this.cfg.subdir);
    const finalPath = join(outDir, `${safeFilePart(target.fileBase)}.mp4`);
    /* 🔴🔴 §90（2026-10-30 踩过，这条最重要）
     *
     * **先下到 `.part`，校验通过再改名成 `.mp4`。**
     *
     * 为什么必须这样：断点续传靠 `sizeOnDisk()` 判断「这一轮已经写了多少」。
     * 如果直接往最终文件名写，而目录里**已经有一个上次下好的成品**，
     * 第一个 IP 一失败（还没 createWriteStream，文件没被截断），
     * `sizeOnDisk()` 就把**整个成品的字节数**当成了「已下载进度」：
     *
     *     off=0    FAIL 89.187.187.10 fetch failed      ← 正常
     *     off=116962750 FAIL 143.244.51.59 fetch failed ← 拿了成品的全长！
     *     ...
     *     HTTP 416  ← 每个 IP 都在请求「从文件末尾开始」，全部 416
     *
     * 结果：13 个 IP 全部「被源站拒绝」，看起来像 CDN 封禁，
     * 实际是自家 bug —— 那次「重抓完再点下载」之所以全灭就是这个。
     *
     * 用 `.part` 之后：成品永不被当成进度，且真正的断点续传（同一集断过）
     * 仍然有效 —— 残留的 `.part` 就是这个用途。
     */
    const partPath = `${finalPath}.part`;

    const startedAt = new Date().toISOString();
    this.markStart(target, finalPath, link.quality, startedAt);

    const t0 = Date.now();
    let bytes = 0;
    let usedChannel = 'direct';
    let attempts = 0;

    try {
      await mkdir(dirname(finalPath), { recursive: true });

      const r = await this.pullAllChannels(link.url, partPath, onProgress);
      bytes = r.bytes;
      usedChannel = r.channel;
      attempts = r.attempts;
      const secs = (Date.now() - t0) / 1000;

      // ✅ 落盘后校验：文件真的在、大小对得上（⛔ 不信「写完就成功」）
      let real = bytes;
      try {
        const st = await stat(partPath);
        real = st.size;
      } catch {
        /* stat 失败就信 bytes */
      }
      if (real <= 0) {
        this.markFail(target, '落盘后文件大小为 0', finalPath, link.quality, startedAt);
        return { ok: false, vid, error: '落盘后文件大小为 0', code: 'write_failed', channel: usedChannel, attempts };
      }
      // 🔴 大小对不上（断流没续完）⇒ 算失败，⛔ 别当成功喂给 MP
      if (r.total != null && r.total > 0 && Math.abs(real - r.total) > 1024) {
        const msg = `大小不符：落盘 ${(real / 1048576).toFixed(1)}MB / 源站 ${(r.total / 1048576).toFixed(1)}MB`;
        this.markFail(target, msg, finalPath, link.quality, startedAt);
        return { ok: false, vid, error: msg, code: 'download_failed', channel: usedChannel, attempts };
      }

      // ✅ 校验通过 ⇒ 改回正式名（同目录 rename 是原子操作，MP 不会看到半个文件）
      await rename(partPath, finalPath);

      this.markDone(target, finalPath, real, link.quality, usedChannel, attempts);
      return { ok: true, vid, filePath: finalPath, bytes: real, quality: link.quality, secs, channel: usedChannel, attempts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code: DlErrorCode =
        e instanceof DirectBlockedError ? 'direct_blocked' : (fatalCode(e) ?? 'download_failed');
      this.markFail(target, msg, finalPath, link.quality, startedAt, usedChannel, attempts);
      return { ok: false, vid, error: msg, code, channel: usedChannel, attempts };
    }
  }

  /**
   * ⭐ 依次尝试所有通道 × 所有 IP。
   *
   * 🔴 断点续传：每换一次通道，把**已落盘字节**接上去（`Range: bytes=N-`），
   *    ⛔ 不删文件从头来 —— 一集 250MB，重下三次就是一小时。
   *
   * ⭐ §90 两轮：第一轮跑完直连全灭时，**强制重新解析**（DNS 轮询会给出新 IP），
   *    第二轮只试「没试过的新 IP」。RST 只要 0.2~0.6 秒，多试几个很便宜，
   *    但能避免为了一个坏 IP 池去烧机场流量。
   */
  private async pullAllChannels(
    url: string,
    filePath: string,
    onProgress?: ProgressCb,
  ): Promise<{ bytes: number; total: number | null; channel: string; attempts: number }> {
    const chans = this.channels();
    const host = (() => { try { return new URL(url).host; } catch { return ''; } })();

    let offset = 0;
    let total: number | null = null;
    let lastErr: unknown = null;
    const tried = new Map<string, number>();
    let directTried = 0;

    for (let round = 0; round < 2; round++) {
      const ips = await this.resolveIps(host, round > 0);
      /* ⛔ §90 教训：**别做「并发预探测」**（2026-10-30 实测踩过）
       *
       * 曾加过一版「先并发探 13 个 IP 挑能通的」，结果 13 个全判失败，
       * 紧接着的下载请求也全被 RST —— 而同样的 IP、同样的 URL，
       * 换成「慢慢串行试」就有 4/7 成功。
       * ⇒ CDN 对**同一出口 IP 的并发连接数**有硬限制：短时间打十几个连接
       *   会被整段限流，反而把本来能用的节点一起打死。
       * ⇒ 正确做法就是现在这样：**串行、试一个算一个**，RST 只要 0.2~0.6 秒，
       *   比并行探测（1~3 秒 + 触发限流）又快又稳。
       */
      // 直连时逐个 IP 试；代理不用 IP（由代理解析 DNS）
      const plan: Array<{ ch: ChannelSpec; ip: string | null }> = [];
      for (const ch of chans) {
        if (ch.kind === 'direct') {
          if (ips.length) for (const ip of ips) plan.push({ ch, ip });
          else plan.push({ ch, ip: null });
        } else {
          plan.push({ ch, ip: null });
        }
      }

      let anyNew = false;
      for (const { ch, ip } of plan) {
        // 同一通道同一 IP 只试一次（跨轮也去重）
        const key = `${ch.id}|${ip ?? ''}`;
        if (tried.has(key)) continue;
        tried.set(key, 1);
        anyNew = true;
        if (ch.kind === 'direct') directTried++;

        try {
          const r = await this.pullOnce(url, filePath, offset, ch, ip, onProgress);
          // ⭐ 记住这个 IP 能通**且多快** ⇒ 下一集/下一部直接用它（快的排前面）
          if (ch.kind === 'direct' && ip) this.ipMem?.markOk(host, ip, r.mbps);
          console.log(`[dl] OK ${host} ${ch.id}/${ip ?? '-'} ${(r.bytes / 1048576).toFixed(1)}MB @${r.mbps}MB/s`);
          offset = r.bytes;
          total = r.total ?? total;
          return { bytes: offset, total, channel: ch.id, attempts: tried.size };
        } catch (e) {
          lastErr = e;
          // 404 / 403 / 470 ⇒ 换通道也没用，直接抛（⛔ 不记 IP 记忆：这是签名问题不是 IP 问题）
          const f = fatalCode(e);
          if (f) throw e;
          if (ch.kind === 'direct' && ip) this.ipMem?.markBad(host, ip);
          console.log(
            `[dl] FAIL ${ch.id}/${ip ?? '-'} off=${offset} ${String((e as Error)?.message ?? e).slice(0, 90)}`,
          );
          // 记下已经落了多少，下次接着写
          // ⚠️ HTTP 416 = Range 起点超过文件长度（残留 .part 比源文件大 / 源文件换过）
          //    ⇒ 把进度归零重下，⛔ 否则后面每个 IP 都必然 416
          offset =
            e instanceof HttpStatusError && e.status === 416 ? 0 : await this.sizeOnDisk(filePath);
          continue;
        }
      }
      if (!anyNew) break; // 第二轮没拿到新 IP ⇒ 没必要再来
    }

    // 直连全灭 + 代理关闭 ⇒ 明确告知「是 IP 被封，不是下载坏了」，并给出可执行动作
    if (this.proxyMode() === 'off') throw new DirectBlockedError(directTried);
    throw lastErr ?? new Error('所有通道都失败了');
  }

  /**
   * ⭐ 解析域名的全部 IPv4（缓存 60 秒）
   *
   * ## 🔴 为什么要解析 5 轮 + 攒池子（2026-10-30 实测，别改回 1 轮）
   * `dns.resolve4()` **一次只返回 5 个**，而 `vdownload.hembed.com` 背后是
   * 一个大 IP 池（实测观测到 12+ 个），**同一时刻只有约 1/5 的 IP 能通**，
   * 其余 200~600ms 内 `ECONNRESET`。
   *
   * 只解析 1 轮 ⇒ 5 个里可能正好没有能用的 ⇒ 整集降级到代理（作者看到的那次）。
   * 更坑的是：**能用的 IP 会漂移**（12:15 是 .10 能跑 11MB/s，12:25 换成 .11），
   * 所以只信当次 DNS 结果不够 ⇒ 再叠一层 §90 的**持久化 IP 池**：
   * 把历史解析到的 IP 全攒起来，候选从 5 个变 20~30 个。
   */
  private async resolveIps(host: string, force = false): Promise<string[]> {
    if (!host) return [];
    const hit = this.ipCache.get(host);
    if (!force && hit && Date.now() - hit.at < 60_000) return hit.ips;
    const all = new Set<string>();
    await Promise.all(
      // ⭐ 12 轮并发（不是 5 轮）：串行解析会命中本地 DNS 缓存，8 轮也只拿到 5 个；
      //    并发打上游才拿得到不同子集 —— 实测同样 5 秒内，候选从 5 个变 11 个。
      Array.from({ length: 12 }, async () => {
        try {
          for (const ip of await resolve4(host)) all.add(ip);
        } catch {
          /* 单轮失败无所谓，其它轮还会试 */
        }
      }),
    );
    const raw = [...all];
    let ips = raw;
    // ⭐ 池子合并：候选 = 历史见过的所有 IP ∪ 本次解析（最近成功的排最前）
    if (this.ipMem) {
      const merged = this.ipMem.merge(host, raw);
      if (merged.length) ips = merged;
    }
    if (!ips.length && hit) ips = hit.ips; // 解析全失败 ⇒ 沿用上次
    if (ips.length) this.ipCache.set(host, { at: Date.now(), ips });
    return ips;
  }

  private async sizeOnDisk(filePath: string): Promise<number> {
    try {
      const st = await stat(filePath);
      return st.size;
    } catch {
      return 0;
    }
  }

  /** 建 dispatcher：直连（可钉死 IP）或用代理 */
  private async makeDispatcher(ch: ChannelSpec, ip: string | null) {
    const { Agent, ProxyAgent } = await import('undici');
    if (ch.kind === 'proxy' && ch.url) return new ProxyAgent(ch.url);
    if (!ip) return undefined; // 系统默认（autoSelectFamily 会自己挑 IPv4）
    // 🔴 把域名强制解析到指定 IP —— 用来绕过「CDN 对部分节点 RST」。
    //    undici 的 buildConnector 会把它透传给 net.connect/tls.connect。
    //    ⚠️ Node 的 LookupFunction 是「重载签名」，这里按最宽松的形状实现再断言。
    const lookup = ((_h: string, o: { all?: boolean }, cb: (...a: never[]) => void) => {
      if (o && o.all) return (cb as unknown as (e: null, a: unknown) => void)(null, [{ address: ip, family: 4 }]);
      return (cb as unknown as (e: null, a: string, f: number) => void)(null, ip, 4);
    }) as unknown as LookupFunction;
    return new Agent({
      connect: {
        lookup,
      },
    });
  }

  /**
   * ⭐ 拉一次（可能只拉到一部分，靠上层的 Range 续传补齐）。
   *
   * 🔴 三个关键点：
   * ① **流式**写盘（⛔ 不要 arrayBuffer() —— 一集 267MB 会 OOM）
   * ② 首字节超时（12 秒）—— 有些 IP 是把连接挂住不返回，不超时就会永远等
   * ③ 每 500ms 回一次进度（前端 1 秒轮询，太快没意义）
   */
  private async pullOnce(
    url: string,
    filePath: string,
    offset: number,
    ch: ChannelSpec,
    ip: string | null,
    onProgress?: ProgressCb,
  ): Promise<{ bytes: number; total: number | null; mbps: number }> {
    const { fetch: ufetch } = await import('undici');
    const t0 = Date.now();
    const dispatcher = await this.makeDispatcher(ch, ip);
    const ac = new AbortController();
    const firstByteMs = this.cfg.firstByteTimeoutMs ?? 12_000;
    const totalMs = this.cfg.totalTimeoutMs ?? 40 * 60_000;
    let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => ac.abort(), firstByteMs);
    const hardTimer = setTimeout(() => ac.abort(), totalMs);

    const headers: Record<string, string> = {};
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    try {
      const res = await ufetch(url, { headers, dispatcher, signal: ac.signal });
      if (res.status !== 200 && res.status !== 206) {
        throw new HttpStatusError(
          res.status,
          `HTTP ${res.status}${res.status === 403 ? '（签名失效或被限流）' : res.status === 470 ? '（需鉴权，签名无效）' : ''}`,
        );
      }
      const body = res.body;
      if (!body) throw new Error('响应没有 body');

      // 206 ⇒ 续传；200 且我们请求了 Range ⇒ 服务器不支持续传，只能从头写
      const append = res.status === 206 && offset > 0;
      if (!append) offset = 0;

      const cl = Number(res.headers.get('content-length') || 0);
      const cr = res.headers.get('content-range'); // bytes 100-999/1000
      let total: number | null = null;
      if (cr) {
        const m = /\/(\d+)$/.exec(cr);
        if (m) total = Number(m[1]);
      } else if (cl > 0) {
        total = cl + offset;
      }

      const ws = createWriteStream(filePath, { flags: append ? 'a' : 'w' });
      let bytes = offset;
      let lastTick = Date.now();
      let lastBytes = bytes;
      let got = 0;

      try {
        for await (const chunk of body) {
          if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
          bytes += (chunk as Buffer).length;
          got += (chunk as Buffer).length;
          if (!ws.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
              ws.once('drain', resolve);
              ws.once('error', reject);
            });
          }
          const now = Date.now();
          if (onProgress && now - lastTick >= 500) {
            const kbps = Math.round((bytes - lastBytes) / 1024 / ((now - lastTick) / 1000));
            onProgress({ bytes, total, kbps, channel: ch.id });
            lastTick = now;
            lastBytes = bytes;
          }
        }
        await new Promise<void>((resolve, reject) => {
          ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      } catch (e) {
        ws.destroy();
        throw e;
      }
      if (onProgress) {
        const now = Date.now();
        const kbps = Math.round((bytes - lastBytes) / 1024 / Math.max((now - lastTick) / 1000, 0.2));
        onProgress({ bytes, total, kbps: got > 0 ? kbps : 0, channel: ch.id });
      }
      return { bytes, total, mbps: +(got / 1048576 / Math.max((Date.now() - t0) / 1000, 0.2)).toFixed(2) };
    } finally {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      clearTimeout(hardTimer);
      // 释放连接（Agent/ProxyAgent 是每集新建的，不销毁会泄漏 socket）
      try {
        const d = dispatcher as { close?: () => Promise<void>; destroy?: () => Promise<void> } | undefined;
        if (d) await (d.close ? d.close() : d.destroy ? d.destroy() : Promise.resolve());
      } catch { /* 关不掉就算了 */ }
    }
  }

  // ── 审计写入（三态，同 work_want 的做法：⛔ 不 DELETE）────────────

  private markStart(t: DlTarget, filePath: string, quality: number | null, at: string): void {
    if (!this.has) return;
    const q = this.hasQueueCols;
    this.db
      .prepare(
        `INSERT INTO work_dl
           (vid, media_type, tmdb_id, season, episode, file_path, bytes, quality,
            error_msg, started_at, done_at, revoked_at${q ? ', progress_bytes, speed_kbps, beam_at' : ''})
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL${q ? ', 0, 0, ?' : ''})
         ON CONFLICT(vid) DO UPDATE SET
           media_type = excluded.media_type,
           tmdb_id    = excluded.tmdb_id,
           season     = excluded.season,
           episode    = excluded.episode,
           file_path  = excluded.file_path,
           quality    = excluded.quality,
           error_msg  = NULL,
           started_at = excluded.started_at,
           done_at    = NULL,
           revoked_at = NULL${q ? ',\n           progress_bytes = 0,\n           speed_kbps = 0,\n           beam_at = excluded.beam_at' : ''}`,
      )
      .run(
        ...(q
          ? [t.vid, t.mediaType, t.tmdbId, t.season, t.episode, filePath, quality, at, at]
          : [t.vid, t.mediaType, t.tmdbId, t.season, t.episode, filePath, quality, at]),
      );
  }

  /** ⭐ 运行中更新进度（worker 每 ~1 秒调一次） */
  beat(t: {
    vid: string; progressBytes: number; totalBytes: number | null;
    speedKbps: number; channel: string;
  }): void {
    if (!this.has || !this.hasQueueCols) return;
    try {
      this.db
        .prepare(
          `UPDATE work_dl
              SET progress_bytes = ?, total_bytes = ?, speed_kbps = ?, channel = ?, beam_at = ?
            WHERE vid = ?`,
        )
        .run(
          t.progressBytes, t.totalBytes, t.speedKbps, t.channel,
          new Date().toISOString(), t.vid,
        );
    } catch { /* 进度写不进去不该中断下载 */ }
  }

  private markDone(
    t: DlTarget, filePath: string, bytes: number,
    quality: number | null, channel?: string, attempts?: number,
  ): void {
    if (!this.has) return;
    if (this.hasQueueCols) {
      this.db
        .prepare(
          `UPDATE work_dl
              SET file_path = ?, bytes = ?, quality = ?, error_msg = NULL, done_at = ?,
                  progress_bytes = ?, speed_kbps = 0, channel = ?, beam_at = ?,
                  attempts = IFNULL(attempts,0) + ?
            WHERE vid = ?`,
        )
        .run(
          filePath, bytes, quality, new Date().toISOString(),
          bytes, channel ?? null, new Date().toISOString(), attempts ?? 1, t.vid,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE work_dl
            SET file_path = ?, bytes = ?, quality = ?, error_msg = NULL, done_at = ?
          WHERE vid = ?`,
      )
      .run(filePath, bytes, quality, new Date().toISOString(), t.vid);
  }

  private markFail(
    t: DlTarget,
    msg: string,
    filePath: string,
    quality: number | null,
    startedAt: string,
    channel?: string,
    attempts?: number,
  ): void {
    if (!this.has) return;
    if (this.hasQueueCols) {
      this.db
        .prepare(
          `UPDATE work_dl
              SET file_path = ?, quality = ?, error_msg = ?, started_at = ?, done_at = NULL,
                  speed_kbps = 0, channel = ?, attempts = IFNULL(attempts,0) + ?
            WHERE vid = ?`,
        )
        .run(
          filePath, quality, msg.slice(0, 500), startedAt,
          channel ?? null, attempts ?? 1, t.vid,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE work_dl
            SET file_path = ?, quality = ?, error_msg = ?, started_at = ?, done_at = NULL
          WHERE vid = ?`,
      )
      .run(filePath, quality, msg.slice(0, 500), startedAt, t.vid);
  }

  /** 人工作废（文件被手动删了）—— ⛔ 不 DELETE，只写 revoked_at */
  revoke(vid: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(`UPDATE work_dl SET revoked_at = ? WHERE vid = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), vid);
    return Number(r.changes) > 0;
  }
}
