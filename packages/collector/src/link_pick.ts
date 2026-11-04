/**
 * ⭐ §85（2026-10-29）hanime 直链**选链规则**（唯一实现）
 *
 * ## 为什么要有这个模块
 * 源站一个 watch 页里会同时出现多个视频 URL，选错一个就是「点了下载报 HTTP 470」。
 * 实测三种形态（`scripts/hanime_linkmap_build.py` 的注释是**旧版**，这里已修正）：
 *
 * | 形态 | URL 样例 | 签名 | 画质 | 可下载 |
 * |---|---|---|---|---|
 * | A「hembed-sc」 | `vdownload.hembed.com/407587-sc-1080p.mp4?secure=xxx,1793314860` | ✅ | 1080 | ✅ |
 * | B「hembed-plain」 | `vdownload-7.hembed.com/37829-720p.mp4?token=xxx&expires=1793307171` | ✅ | 720/480 | ✅ |
 * | C1「youjizz 签名版」 | `cdne-mobile.youjizz.com/...-1280-720-949-h264.mp4?validfrom=..&validto=..&rate=..&hash=..` | ✅ | 720 | ✅ |
 * | C2「youjizz 无签名 1080」 | `abre-videos.youjizz.com/_hls/...-1920-1080-4132-h264.mp4` | ❌ | 1080 | ❌ **HTTP 470** |
 * | D「lajiao HLS」 | `cdn3.lajiao-bo.com/.../hls/index.m3u8` | — | — | ⛔ 本轮不做 |
 *
 * 🔴🔴 **本模块存在的唯一理由：修正一个真 bug**
 * 旧版选链规则是 `key = (is_m3u8, 画质, 过期时间)` 取最大
 *   ⇒ C2（无签名、1080p）战胜 C1（有签名、720p）
 *   ⇒ 165 条 youjizz 链接**全部下不了**，实测 HTTP 470 `Unauthorized!`
 *   ⇒ 而 C1 明明是可下载的，只是画质低一档。
 *
 * ## ⭐ 新规则（0lx：唯一实现，抓取与重抓共用）
 * **先按「能不能下」，再按画质**：
 *   1. 排除 m3u8（本轮不做 HLS）
 *   2. 排除无签名（⛔ 无签名 = 预览版 = CDN 必回 470）
 *   3. 剩下按 画质降序 → 过期时间降序
 *
 * 🔴 画质优先级：**可下载 > 高画质**。
 *    「1080p 但下不了」对用户等于 0，「720p 但能下」才是真价值。
 */

// 🔴 0lx：速率上限的解析在 core（matcher 也要用）⇒ 这里引进来
import { rateLimitOf } from '@hifan/core';

/** 一条候选直链 */
export interface LinkCandidate {
  url: string;
  quality: number;
  expiresAt: number | null;
  isM3u8: boolean;
  srcKind: 'hembed' | 'youjizz' | 'other';
  /** 是否带签名（= 是否真能下载） */
  signed: boolean;
}

/** 从 URL 里抠出画质数字 */
export function qualityOf(url: string): number {
  // A 型：`...-sc-1080p.mp4` / `...-720p.mp4`
  const mh = /-(?:sc-)?(\d{1,4})p\.mp4/.exec(url);
  if (mh) return Number(mh[1]);
  // C 型：`-1920-1080-4132-h264.mp4` ⇒ 取第二个数（宽高里的高）
  const my = /-(\d{3,4})-(\d{3,4})-\d+-h264/.exec(url);
  if (my) return Number(my[2]);
  const mm = /(\d{3,4})p/.exec(url);
  if (mm) return Number(mm[1]);
  return 0;
}

/**
 * 从 URL 里抠出签名过期时间（Unix 秒）。
 * - `secure=xxx,1793314860`  ⇒ 逗号后
 * - `expires=1793307171`
 * - `validto=1793354899`
 * - 都没有 ⇒ null（当作「未知」，不判过期）
 */
export function expiryOf(url: string): number | null {
  const mv = /validto=(\d+)/.exec(url);
  if (mv) return Number(mv[1]);
  const me = /[?&]expires=(\d+)/.exec(url);
  if (me) return Number(me[1]);
  const ms = /secure=[^,]*?,(\d+)/.exec(url);
  if (ms) return Number(ms[1]);
  return null;
}

/**
 * 判断 URL 是否带签名。
 *
 * 🔴 youjizz 的 C1 形态签名在 query 里（`validfrom`/`validto`/`hash`），
 *    C2 形态**完全没有 query** ⇒ 用「有没有任何签名类参数」来区分，
 *    ⛔ 不要用「有没有 `?`」——有些 CDN 的预览版也带无关 query。
 */
export function isSigned(url: string): boolean {
  return (
    /[?&]secure=/.test(url) ||
    /[?&]token=/.test(url) ||
    /[?&]expires=/.test(url) ||
    /[?&]hash=/.test(url) ||
    /[?&]validto=/.test(url)
  );
}

/** 判断源类型 */
export function srcKindOf(url: string): LinkCandidate['srcKind'] {
  if (url.includes('youjizz.com')) return 'youjizz';
  if (url.includes('hembed.com')) return 'hembed';
  return 'other';
}

/**
 * ⭐ §85（2026-10-29 实测发现）：从签名 URL 里抠出**源站写死的速率上限**。
 *
 * 🔴 0lx：唯一实现在 `@hifan/core` 的 `parse.ts`（collector 与 matcher 共用），
 *    这里只做转出，⛔ 不许再写一份。
 */
export { rateLimitOf };

/**
 * ⭐ 从候选 URL 列表里挑出「真能下载的那条」。
 *
 * @param rawCandidates 页面里抓到的原始 URL 列表（可能含 `&amp;` HTML 实体）
 * @returns 选中的候选；一个都没有 ⇒ null
 */
export function pickDownloadable(rawCandidates: string[]): LinkCandidate | null {
  const cands: LinkCandidate[] = [];
  for (const raw of rawCandidates) {
    const url = raw.replace(/&amp;/g, '&').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const isM3u8 = /\.m3u8(\?|$)/i.test(url);
    cands.push({
      url,
      quality: qualityOf(url),
      expiresAt: expiryOf(url),
      isM3u8,
      srcKind: srcKindOf(url),
      signed: isSigned(url),
    });
  }
  return pickFromCandidates(cands);
}

/** 从已解析好的候选里挑（便于测试与复用） */
export function pickFromCandidates(cands: LinkCandidate[]): LinkCandidate | null {
  // ① 排除 m3u8（本轮明确不做 HLS，蛙哥 2026-10-29：「暂不处理这部分」）
  const usable = cands.filter((c) => !c.isM3u8);
  if (!usable.length) return null;

  // ② ⭐ 排除无签名的预览版 —— 实测这类必然 HTTP 470
  const signed = usable.filter((c) => c.signed);
  const pool = signed.length ? signed : [];

  // ③ 一个能下的都没有 ⇒ 返回 null（⛔ 不要退而求其次给无签名的，
  //    让调用方明确知道「这集没链接」，而不是下到一半报 470）
  if (!pool.length) return null;

  // ④ 画质降序 → 过期时间降序
  const best = pool.slice().sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
  })[0];
  return best;
}

/** 从 watch 页 HTML 里抽出所有候选 URL（正则粗筛，最终靠 pickDownloadable 精挑） */
export function extractCandidates(html: string): string[] {
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>\\]*)?/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}
