/**
 * 本地目录名 ↔ TMDB id 的解析工具。
 *
 * ⭐ 放在 core 而不是 scanner：入库检测（matcher）也要读同一份 raw id，
 *    两边各写一份正则必然漂移（feats 号不一致、漏全角括号）。
 */

/**
 * 从目录名提取 tmdbid —— 支持 `[tmdbid:X]` / `［tmdbid：X］` / `(tmdbid=X)`
 * 实测历史上有过 `[tmdbid:306519]`、`「tmdbid:306519」` 两种写法，
 * 且分隔符可能是半角也可能是全角，因此字符类两套都要覆盖。
 */
export function parseTmdbIdFromDir(dirName: string): number | null {
  const m = dirName.match(
    /[［\[【(（]?\s*tmdbid\s*[:=：]\s*(\d{2,8})\s*[］\]】)）]?/i,
  );
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

/** 目录名前缀的年份，如 `2004-作品名` → 2004；解析不出返回 null */
export function parseYearFromDir(dirName: string): number | null {
  const m = dirName.match(/^(\d{4})\s*[-–—\s]/);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/**
 * ⭐ §85（2026-10-29 实测发现）：从签名直链 URL 里抠出**源站写死的速率上限**。
 *
 * ## 现象
 * youjizz 的签名 URL 带一个 `rate=NNNNNN` 参数：
 *   `...-1280-720-949-h264.mp4?validfrom=..&validto=..&rate=316992&hash=..`
 * 实测下载速度**恰好卡在这个数**（150912 B/s ≈ 147 KB/s ⇒ 300MB 的集要下 30+ 分钟）。
 *
 * ## 为什么绕不过
 * `hash` 是对整个 query 做的签名 ⇒ 改 `rate` 的值 hash 就对不上 ⇒ 源站直接拒。
 * ⇒ **这是源站的硬限制，不是我们的 bug**，只能如实告知用户。
 *
 * ## 为什么放 core（0lx：同一判据不许两处实现）
 * - `packages/collector/src/link_pick.ts`（选链/重抓）与
 *   `packages/matcher/src/intake.ts`（看板展示）都要用它
 * - core 是零依赖纯包 ⇒ 两边都能引，不引入 undici 之类的重依赖
 *
 * @returns 字节/秒；URL 里没有 `rate` ⇒ null（不限速）
 */
export function rateLimitOf(url: string): number | null {
  const m = /[?&]rate=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}