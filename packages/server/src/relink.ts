/**
 * ⭐ §85（2026-10-29）hanime 签名**重抓**服务
 *
 * ## 为什么必须有这个模块（不是锦上添花，是刚需）
 * - hembed 签名 TTL ≈ **11 小时**（`secure=xxx,<ts>`）
 * - youjizz 签名 TTL ≈ **23~48 小时**（`validto=<ts>`）
 * ⇒ 本次抓取出来的链接**明天 05:01 就全面过期**。
 *   没有重抓能力 ⇒ 下载功能第二天就全废，前端只能一直显示「需重抓」。
 *
 * ## 🔴 取链通道：FlareSolverr（不是 CDP，也不是浏览器）
 * 2026-10-29 实测三条路：
 * | 通道 | 结果 |
 * |---|---|
 * | 容器内直连 hanime watch 页 | ❌ HTTP 403（CF） |
 * | 宿主 CDP（飞牛浏览器） | ✅ 能取，但要 socat 转发 16002→16003，依赖浏览器常驻 |
 * | ⭐ **FlareSolverr（宿主 28191）** | ✅ 能取，**容器内直连即可**，无额外进程 |
 * ⇒ 选 FlareSolverr：容器内 `172.20.0.1:28191` 直连（§79 定期扫描已在用同一条路）。
 *
 * ## 🔴 选链规则不在这里写
 * ⛔ 唯一实现在 `@hifan/collector` 的 `link_pick.ts`（0lx），
 *    抓取脚本 `scripts/hanime_linkmap_build.py` 与本模块共用同一套判据。
 */
import type { DB } from '@hifan/core';
import { extractCandidates, pickDownloadable, type LinkCandidate } from '@hifan/collector';

export interface RelinkConfig {
  /**
   * FlareSolverr 地址（容器内走宿主网关）。
   * 🔴 配置项 `hanime.flaresolverr` **已含 `/v1` 后缀** ⇒ 这里直接拼 `/v1` 会变成 `/v1/v1`。
   */
  flaresolverr: string;
  /** 下载代理（FlareSolverr 需要代理才能过 CF） */
  proxy: string;
}

export interface RelinkResult {
  vid: string;
  ok: boolean;
  /** 选中的新链接（成功时） */
  link?: LinkCandidate;
  /** ⭐ §116 这次 HEAD 问到的字节数；null = 没问到（会保留库里旧值） */
  size?: number | null;
  /** 失败原因 */
  error?: string;
}

export class RelinkService {
  constructor(private readonly db: DB, private readonly cfg: RelinkConfig) {}

  /**
   * ⭐ 取一个 vid 的 watch 页，解析出可下载直链。
   *
   * 🔴 FlareSolverr 会真的开浏览器解 CF，**很慢**（实测 8~20 秒一集）
   *    ⇒ 调用方必须串行 + 限流，⛔ 不能并发轰。
   */
  async fetchWatchLinks(vid: string): Promise<LinkCandidate | null> {
    const html = await this.fetchWatchHtml(vid);
    if (!html) return null;
    return pickDownloadable(extractCandidates(html));
  }

  /** FlareSolverr 的 v1 端点（配置里可能已带 `/v1`，也可能没带 ⇒ 两种都兜住） */
  private flareEndpoint(): string {
    const base = this.cfg.flaresolverr.replace(/\/+$/, '');
    return base.endsWith('/v1') ? base : `${base}/v1`;
  }

  /** 取 watch 页 HTML（走 FlareSolverr 解 CF） */
  private async fetchWatchHtml(vid: string): Promise<string | null> {
    const url = `https://hanime1.me/watch?v=${encodeURIComponent(vid)}`;
    const body = JSON.stringify({
      cmd: 'request.get',
      url,
      maxTimeout: 60000,
      ...(this.cfg.proxy ? { proxy: { url: this.cfg.proxy } } : {}),
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(this.flareEndpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        status?: string;
        message?: string;
        solution?: { response?: string };
      };
      if (j.status !== 'ok') return null;
      const html = j.solution?.response ?? '';
      return html || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ⭐ 重抓一集并写回 `source_link`。
   *
   * 🔴 铁律：
   * - **UPSERT，不 DELETE**（禁 DELETE 铁律）
   * - 只 UPDATE 事实字段（url / quality / src_kind / is_m3u8 / expires_at / fetched_at）
   * - 失败**不动**旧行（宁可让旧链接保留着显示「需重抓」，也别写成空）
   */
  async relinkOne(vid: string): Promise<RelinkResult> {
    let link: LinkCandidate | null = null;
    try {
      link = await this.fetchWatchLinks(vid);
    } catch (e) {
      return { vid, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!link) {
      return { vid, ok: false, error: '源站没解析出可下载直链（无签名 / 被 CF 拦）' };
    }
    /* ⭐ §116：抓到新鲜链接后**立刻** HEAD 一次拿真实字节数。
       🔴 必须紧挨着抓链做：链接 11~35 小时就过期，过两天再补就全 410 了。
       🔴 HEAD 失败 ⇒ size 为 null ⇒ UPSERT 走 COALESCE 保留旧值，⛔ 不清空。 */
    const size = await this.probeSize(link.url);
    this.upsertLink(vid, link, size);
    return { vid, ok: true, link, size };
  }

  /**
   * ⭐ §116（2026-11-01 蛙哥「hanime 下载页那个下载按钮无法获取视频大小吗」）：
   * 对 CDN 直链发 **HEAD** 取 content-length。
   *
   * 实测（vid 101432，2026-11-01）：
   *   1080p 108,698,622 B / 720p 63,841,215 B / 480p 44,165,681 B
   * 站点自己那栏写 N/A，但 CDN 是老实回了长度的 ⇒ 大小一直是可得的，只是没人问。
   *
   * ⚠️ 只发 HEAD，⛔ 不 GET（一集上百 MB，只为问一句大小不值得）。
   * ⚠️ 返回 null 表示「没问到」，⛔ 不许用 0 或估算值顶（0cs：别谎报）。
   */
  private async probeSize(url: string): Promise<number | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
      if (!res.ok) return null;
      const cl = res.headers.get('content-length');
      const n = cl == null ? NaN : Number(cl);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 写回链接（UPSERT） */
  private upsertLink(vid: string, link: LinkCandidate, size: number | null): void {
    this.db
      .prepare(
        `INSERT INTO source_link
           (vid, url, quality, src_kind, is_m3u8, expires_at, size, title, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(vid) DO UPDATE SET
           url         = excluded.url,
           quality     = excluded.quality,
           src_kind    = excluded.src_kind,
           is_m3u8     = excluded.is_m3u8,
           expires_at  = excluded.expires_at,
           -- 🔴 §116：体积是永久事实 ⇒ 这次没问到（null）就**保留旧值**，
           --    否则一次网络抖动就把已经花流量问到的数抹掉了。
           size        = COALESCE(excluded.size, source_link.size),
           fetched_at  = excluded.fetched_at`,
      )
      .run(
        vid,
        link.url,
        link.quality,
        link.srcKind,
        link.isM3u8 ? 1 : 0,
        link.expiresAt,
        size,
        new Date().toISOString(),
      );
  }

  /**
   * ⭐ 找出**已过期**的链接（签名到期）。
   *
   * @param limit 一次最多重抓多少条（FlareSolverr 很慢，⛔ 别一次几百条）
   * @param onlyExpired true = 只抓已过期的；false = 抓全部（人工全量刷新用）
   */
  async relinkExpired(limit: number, onlyExpired = true): Promise<RelinkResult[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.db
      .prepare(
        onlyExpired
          ? `SELECT vid FROM source_link
              WHERE is_m3u8 = 0 AND expires_at IS NOT NULL AND expires_at <= ?
              ORDER BY expires_at ASC LIMIT ?`
          : `SELECT vid FROM source_link
              WHERE is_m3u8 = 0 ORDER BY expires_at ASC LIMIT ?`,
      )
      .all(nowSec, limit) as Array<{ vid: string }>;

    const out: RelinkResult[] = [];
    for (const r of rows) {
      // 🔴 串行 + 每条之间喘口气（FlareSolverr 开真浏览器，连打会被源站限流）
      out.push(await this.relinkOne(r.vid));
      await new Promise<void>((res) => setTimeout(res, 1200));
    }
    return out;
  }
}
