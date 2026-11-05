/**
 * hanime 定期扫描器（Node 版）
 *
 * 🔴 为什么重写成 Node 而不是直接跑 `scripts/hanime_recrawl.py`：
 *   看板容器（hifan-dashboard）里**只有 node v22，没有 python**
 *   ⇒ 定期扫描要能在容器内自主执行，抓取逻辑必须是 Node。
 *   （FlareSolverr 在宿主 28191，容器内走 host.docker.internal:28191 已验证可达。）
 *
 * 🔴 为什么不能照抄 Python 版的「已有文件就跳过」：
 *   `hanime_recrawl.py` 的 `⏭ 已有 N 条，跳过` 是**补抓思维**（一次性把缺口补齐）。
 *   定期扫描恰恰相反 —— **每次必须重抓**，否则永远看不到番的更新。
 *   ⇒ 这里默认全量重抓；`skipExisting` 仅供人工补跑时用。
 *
 * 🔴 三个必须保留的 Python 版铁律（踩过的坑，不能丢）：
 *   1. **CF 拦截页绝不能当末页** —— 拦截页正则匹配 0 条，
 *      旧版 `if not new: break` 会静默把整年当末页（真实历史 bug）。
 *      ⇒ 这里靠 `isBlocked()` 识别 + 重试 + 如实记 verdict。
 *   2. **翻页判据双通道** —— `pageLinks()`（HTML 实体还原后匹配 `[?&]page=(\d+)`）
 *      与 `totalPages()`（`<li class="page-item">` 内最大数字）。
 *      hanime 的分页链接是**相对路径**且用 `&amp;` 分隔，
 *      旧正则要求前面是 `https://...` ⇒ 一个都匹配不上 ⇒ 只抓第 1 页。
 *   3. **0 条也要留痕** —— 每次尝试都写 `_attempts.jsonl`（含 verdict），
 *      否则「源站真的没有」与「根本没爬」在产物上无法区分
 *      （历史上泡麵番 7 个整年在产物里完全消失）。
 *
 * 输出目录：`data/hanime_recrawl/<genre>_<year>.jsonl` + `_attempts.jsonl`
 *   ⚠️ 路径与 Python 版一致（`data/`），但 `hanime_recrawl_diff.py` /
 *      `hanime_rebuild_source.py` 读的是 `research/hanime_recrawl/` ⇒
 *      那是历史遗留的不一致，本模块统一写到 `data/`，
 *      并在 §79 的实施里把 diff/rebuild 改成读同一目录。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HANIME_GENRES = ['裏番', '泡麵番'] as const;
export type HanimeGenre = (typeof HANIME_GENRES)[number];

export interface HanimeItem {
  vid: string;
  title: string;
  year: number;
  genre: string;
  page: number;
}

export interface AttemptRecord {
  genre: string;
  year: number;
  rows: number;
  pages_ok: number;
  pages_empty: number;
  pages_blocked: number;
  pages_walked: number;
  verdict: 'OK' | 'EMPTY_ON_SOURCE' | 'BLOCKED_BY_CF';
  ts: string;
}

export interface ScanOptions {
  /** FlareSolverr 地址。容器内走宿主网关 host.docker.internal:28191 */
  flaresolverr?: string;
  /** 代理（FlareSolverr 侧使用） */
  proxy?: string;
  /** 输出目录 */
  outDir: string;
  years: number[];
  genres?: string[];
  /** 每页之间等待毫秒（默认 1200，与 Python 版一致） */
  sleepMs?: number;
  /** 单页最大重试次数（CF 拦截时） */
  retries?: number;
  /** 人工补跑时用：跳过已有非空文件。定期扫描**必须**为 false */
  skipExisting?: boolean;
  onLog?: (msg: string) => void;
}

const MAX_PAGES = 40;

/** 🔴 CF 拦截特征（照抄 Python 版，⛔不可凭记忆改写） */
const CF_MARKERS = [
  'Attention Required',
  'Just a moment',
  'cf-browser-verification',
  'challenge-platform',
  'Enable JavaScript and cookies',
];

const ITEM_RE =
  /href="https:\/\/hanime1\.me\/watch\?v=(\d+)"[^>]*>.*?class="home-rows-videos-title">(.*?)<\/div>/gs;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTML 实体还原（Python 版用 html.unescape） */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 🔴 拦截页判定：出现任一标记 ⇒ 这一页无效，绝不能当末页 */
export function isBlocked(html: string): boolean {
  if (!html) return true;
  const head = html.slice(0, 4000);
  return CF_MARKERS.some((m) => head.includes(m));
}

/** 从 HTML 抽条目（与 Python 版 ITEM_RE 语义一致） */
export function extractItems(html: string): Array<{ vid: string; title: string }> {
  const out: Array<{ vid: string; title: string }> = [];
  ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(html)) !== null) {
    const title = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (title) out.push({ vid: m[1], title });
  }
  return out;
}

/**
 * 🔴 翻页通道 A：页面上所有分页页码。
 *   hanime 的分页链接是相对路径 `?genre=...&amp;date=2026%20%E5%B9%B4&amp;page=2`
 *   ⇒ 必须先还原 HTML 实体，再匹配 `[?&]page=(\d+)`。
 */
export function pageLinks(html: string): number[] {
  const h = unescapeHtml(html);
  const out = new Set<number>();
  for (const m of h.matchAll(/[?&]\s*page\s*=\s*(\d+)/g)) out.add(Number(m[1]));
  if (out.size === 0) {
    for (const m of h.matchAll(/<a[^>]+href="[^"]*page\s*=\s*(\d+)"/g)) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 🔴 翻页通道 B：分页栏里**可点链接**的最大页码。
 *
 * ⚠️ 2026-10-28 实测发现的真 bug（Python 版 `hanime_recrawl.py` 同样有）：
 *   末页时**当前页不再是链接**，而是
 *     `<li class="page-item active"><span class="page-link">3</span></li>`
 *   ⇒ 如果从 `<li class="page-item">` 里取所有数字的 max，
 *     末页（第 3 页）只能看到 1 和 2 ⇒ **总页数被算成 2**（实际 3 页）。
 *   ⇒ 日志会打出「已是末页（共 2 页）」这种自相矛盾的话。
 *
 * ✅ 正确判据：**只看分页栏 `<ul class="pagination">` 里的 `<a href="...page=N">`**，
 *   这些是**真正可点的页码**（含 rel=prev/next 箭头，它也指向真实页码）。
 *   - 第 1 页：链接 max = 3 > 1 ⇒ 继续
 *   - 第 2 页：链接 max = 3 > 2 ⇒ 继续
 *   - 第 3 页：链接 max = 2 ≤ 3 ⇒ 末页 ✓
 */
export function paginationMaxLink(html: string): number {
  const h = unescapeHtml(html);
  let max = 0;
  for (const ul of h.matchAll(/<ul[^>]*class="[^"]*pagination[^"]*"[\s\S]*?<\/ul>/g)) {
    for (const a of ul[0].matchAll(/<a[^>]+href="[^"]*[?&]page\s*=\s*(\d+)"/g)) {
      const n = Number(a[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

/** 当前页页码（`<li class="page-item active">` 里的数字） */
export function activePage(html: string): number {
  const h = unescapeHtml(html);
  const m = h.match(/<li[^>]*class="[^"]*page-item[^"]*active[^"]*"[^>]*>([\s\S]{0,200}?)<\/li>/);
  if (!m) return 0;
  const n = m[1].match(/(\d+)/);
  return n ? Number(n[1]) : 0;
}

/**
 * 🔴 翻页通道 C：页面上显示的最大页码（`<li class="page-item">` 内数字）。
 *   ⚠️ 仅作**日志显示**用，⛔不可作末页判据（见 paginationMaxLink 的坑）。
 */
export function totalPages(html: string): number {
  const h = unescapeHtml(html);
  let max = 0;
  for (const m of h.matchAll(
    /<li class="page-item[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*(\d+)\s*(?:<\/a>)?/g,
  )) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** 经 FlareSolverr 取页面。失败返回空串（调用方负责判定） */
async function solve(
  url: string,
  fs: string,
  proxy: string | undefined,
  retries: number,
  onLog?: (m: string) => void,
): Promise<{ html: string; note: string }> {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 200_000);
      const res = await fetch(fs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url,
          proxy: proxy ? { url: proxy } : undefined,
          maxTimeout: 150_000,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = (await res.json()) as {
        status?: string;
        message?: string;
        solution?: { response?: string };
      };
      if (data.status === 'ok') {
        return { html: data.solution?.response ?? '', note: 'ok' };
      }
      onLog?.(`      [重试 ${i + 1}/${retries}] ${(data.message ?? 'unknown').slice(0, 80)}`);
    } catch (err) {
      onLog?.(
        `      [重试 ${i + 1}/${retries}] ${(err as Error).name}:${String((err as Error).message).slice(0, 70)}`,
      );
    }
    await sleep(4000 + i * 3000);
  }
  return { html: '', note: 'exhausted' };
}

export interface CrawlResult {
  items: HanimeItem[];
  pagesOk: number;
  pagesEmpty: number;
  pagesBlocked: number;
  pagesWalked: number;
  blocked: boolean;
}

/** 抓一个 (genre, year) 组合 */
export async function crawlOne(
  genre: string,
  year: number,
  opts: Required<Pick<ScanOptions, 'flaresolverr' | 'proxy' | 'sleepMs' | 'retries'>> & {
    outDir: string;
    skipExisting: boolean;
    onLog?: (m: string) => void;
  },
): Promise<CrawlResult> {
  const fp = join(opts.outDir, `${genre}_${year}.jsonl`);
  const existingCount = countJsonl(fp);
  if (opts.skipExisting && existingCount !== null) {
    opts.onLog?.(`  ⏭  ${genre} ${year}: 已有 ${existingCount} 条，跳过`);
    return {
      items: [],
      pagesOk: 0,
      pagesEmpty: 0,
      pagesBlocked: 0,
      pagesWalked: 0,
      blocked: false,
    };
  }

  const items: HanimeItem[] = [];
  const seen = new Set<string>();
  let pagesOk = 0;
  let pagesEmpty = 0;
  let pagesBlocked = 0;
  let consecutiveEmpty = 0;
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `https://hanime1.me/search?genre=${encodeURIComponent(genre)}&date=${encodeURIComponent(`${year} 年`)}&page=${page}`;
    let { html, note } = await solve(url, opts.flaresolverr, opts.proxy, opts.retries, opts.onLog);

    if (isBlocked(html)) {
      pagesBlocked++;
      opts.onLog?.(`      page ${page}: 被 CF 拦截/失败（${note}）→ 重试一次`);
      ({ html, note } = await solve(url, opts.flaresolverr, opts.proxy, opts.retries, opts.onLog));
      if (isBlocked(html)) {
        opts.onLog?.(`      page ${page}: 重试仍失败，**停止并如实记录**`);
        break;
      }
    }
    pagesOk++;

    const fresh = extractItems(html).filter((x) => !seen.has(x.vid));
    if (fresh.length === 0) {
      pagesEmpty++;
      consecutiveEmpty++;
      // 🔴 连续两页空才算真末页；单页空可能是加载异常
      if (consecutiveEmpty >= 2) break;
      page++;
      await sleep(opts.sleepMs);
      continue;
    }

    consecutiveEmpty = 0;
    for (const x of fresh) {
      seen.add(x.vid);
      items.push({ ...x, year, genre, page });
    }
    opts.onLog?.(`      page ${page}: +${fresh.length} (累计 ${items.length})`);

    const nxt = pageLinks(html);
    const linkMax = paginationMaxLink(html);
    const shownMax = totalPages(html);
    const cur = activePage(html);
    if (nxt.length === 0 && linkMax === 0) {
      opts.onLog?.(`      page ${page}: 找不到分页信息，按末页处理`);
      break;
    }
    // 🔴 末页判据用「可点链接的最大页码」，⛔不用 page-item 里的数字 max
    //    （末页时当前页是 <span> 不是 <a> ⇒ 那个 max 会少 1）
    if (linkMax > 0 && page >= linkMax) {
      opts.onLog?.(`      page ${page}: 已是末页（可点链接 max=${linkMax} · 当前页=${cur || page}）`);
      break;
    }
    if (linkMax === 0 && shownMax > 0 && page >= shownMax && cur === page) {
      opts.onLog?.(`      page ${page}: 已是末页（共 ${shownMax} 页）`);
      break;
    }
    if (nxt.length > 0 && Math.max(...nxt) <= page && linkMax === 0) break;
    page++;
    await sleep(opts.sleepMs);
  }

  const verdict: AttemptRecord['verdict'] =
    pagesBlocked > 0 && items.length === 0
      ? 'BLOCKED_BY_CF'
      : items.length === 0
        ? 'EMPTY_ON_SOURCE'
        : 'OK';

  mkdirSync(opts.outDir, { recursive: true });
  if (items.length > 0) {
    writeFileSync(
      fp,
      items.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
    opts.onLog?.(
      `  ${verdict === 'OK' ? '✅' : '⚠️ '} ${genre} ${year}: ${items.length} 条 / 翻 ${pagesOk} 页 (成功 ${pagesOk} · 空页 ${pagesEmpty} · 被拦 ${pagesBlocked})`,
    );
  } else {
    opts.onLog?.(`  ❌ ${genre} ${year}: 0 条（成功页 ${pagesOk} · 被拦 ${pagesBlocked}）`);
  }

  // 🔴 每次尝试都留痕（哪怕 0 条）—— 否则「源站真没有」与「根本没爬」无法区分
  const rec: AttemptRecord = {
    genre,
    year,
    rows: items.length,
    pages_ok: pagesOk,
    pages_empty: pagesEmpty,
    pages_blocked: pagesBlocked,
    pages_walked: pagesOk,
    verdict,
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  appendFileSync(join(opts.outDir, '_attempts.jsonl'), JSON.stringify(rec) + '\n', 'utf-8');

  return {
    items,
    pagesOk,
    pagesEmpty,
    pagesBlocked,
    pagesWalked: Math.max(0, page - 1),
    blocked: pagesBlocked > 0,
  };
}

/** 读已有 jsonl 行数（无 python 的环境下替代 os.path.getsize 判断） */
function countJsonl(fp: string): number | null {
  try {
    const text = readFileSync(fp, 'utf-8');
    if (!text.trim()) return null;
    return text.split('\n').filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

export interface ScanSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  genres: string[];
  years: number[];
  perCombo: Array<{
    genre: string;
    year: number;
    rows: number;
    pagesOk: number;
    pagesEmpty: number;
    pagesBlocked: number;
    verdict: AttemptRecord['verdict'];
  }>;
  totalRows: number;
  blockedCombos: string[];
  zeroCombos: string[];
}

/** 扫描一个年份范围的全部 genre */
export async function scanHanime(opts: ScanOptions): Promise<ScanSummary> {
  const fs = opts.flaresolverr ?? process.env.FLARESOLVERR ?? 'http://host.docker.internal:28191/v1';
  const proxy = opts.proxy ?? process.env.HANIME_PROXY ?? '';
  const genres = opts.genres ?? [...HANIME_GENRES];
  const outDir = opts.outDir;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  mkdirSync(outDir, { recursive: true });

  const perCombo: ScanSummary['perCombo'] = [];
  for (const g of genres) {
    for (const y of opts.years) {
      opts.onLog?.(`\n── ${g} ${y} ──`);
      const r = await crawlOne(g, y, {
        flaresolverr: fs,
        proxy,
        sleepMs: opts.sleepMs ?? 1200,
        retries: opts.retries ?? 3,
        outDir,
        skipExisting: opts.skipExisting ?? false,
        onLog: opts.onLog,
      });
      perCombo.push({
        genre: g,
        year: y,
        rows: r.items.length,
        pagesOk: r.pagesOk,
        pagesEmpty: r.pagesEmpty,
        pagesBlocked: r.pagesBlocked,
        verdict:
          r.pagesBlocked > 0 && r.items.length === 0
            ? 'BLOCKED_BY_CF'
            : r.items.length === 0
              ? 'EMPTY_ON_SOURCE'
              : 'OK',
      });
    }
  }

  const blockedCombos = perCombo
    .filter((x) => x.verdict === 'BLOCKED_BY_CF')
    .map((x) => `${x.genre}_${x.year}`);
  const zeroCombos = perCombo
    .filter((x) => x.verdict === 'EMPTY_ON_SOURCE')
    .map((x) => `${x.genre}_${x.year}`);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    genres,
    years: opts.years,
    perCombo,
    totalRows: perCombo.reduce((a, b) => a + b.rows, 0),
    blockedCombos,
    zeroCombos,
  };
}
