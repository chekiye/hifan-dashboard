/**
 * ⭐ 统一匹配层 v5 —— TS 移植版（用于服务端/容器内调用）
 *
 * 🔴🔴 **本文件是 `scripts/match_core.mjs` 的逐函数移植，不是重新实现。**
 *
 *   唯一事实来源仍是 `scripts/match_core.mjs`（历史绑定、审计脚本都基于它）。
 *   这里之所以要一份 TS，是因为服务端要在容器里跑判定，⛔ 不能 spawn 外部脚本
 *   （容器里没有 bash 环境依赖、也拿不到 scripts 目录的稳定路径）。
 *
 * 🔴 一致性由 `scripts/_verify_79_match_parity.mjs` 守：
 *   抽真实标题 + 合成边界样本，两边各跑一遍，断言
 *   `canon` / `dice` / `lev` / `judgeVariants` / `gradeMatch` **逐字节相同**。
 *   ⛔ 改任何一边都必须重跑对拍（0di 同代码 A/B 对拍）。
 *
 * ⛔ 严禁在这里「顺手优化」判据 —— 任何改动都会让线上绑定与历史审计结果不一致。
 *   要改就两边一起改，并重跑三回归（15 + 14 + 6）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as OpenCC from 'opencc-js';

// opencc-js 没有官方类型声明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONVERTER = (OpenCC as any).Converter({ from: 'tw', to: 'cn' }) as (s: string) => string;

/** 剥离规则 v5 —— 与 mjs 版逐条一致 */
const STRIP_RULES: Array<[RegExp, string]> = [
  [/\[[^\]]*\]/g, ' '], [/【[^】]*】/g, ' '],
  [/「[^」]*」/g, ' '], [/『[^』]*』/g, ' '],
  [/第\s*\d{1,3}\s*[話话集巻卷章編篇幕][^]*$/, ''],
  [/\b(Karte|Round|celebrity|Vol|STAGE|File|case|Episode|Part|Office|taboo)\b\.?\s*[-‐-―]?\s*\d{1,3}/gi, ' '],
  [/[#＃♯]\s*\d{1,3}/g, ' '],
  [/[‐-―\-]\s*[前後][編篇巻]\s*[‐-―\-]/g, ' '], [/[前後][編篇巻]/g, ' '], [/[上下][巻篇]/g, ' '],
  [/\bTHE\s+ANIMATION\b/gi, ' '], [/\bThe\s+Animation\b/g, ' '], [/\bAnime\s+(Edition|Edit)\b/gi, ' '],
  [/^(OVA|OAD|TV|映画|ドラマ|アニメ)\s*/i, ' '],
  [/\s+\d{1,3}\s*$/, ''], [/\s*[-‐-―]\s*\d{1,3}\s*$/, ''], [/\s*ー\s*$/, ''],
  [/[一二三四五六七八九十両]+目/g, ' '], [/[一二三四五六七八九十]+番(しぼり|搾り)/g, ' '],
  [/カルテ\s*\d{1,3}/g, ' '], [/\d{1,3}\s*号/g, ' '], [/\d{1,3}$/, ''],
  [/[：:]\s*$/, ' '], [/[！!？?、,]+$/, ' '], [/[・~〜]\s*$/, ' '],
];

/** 括号类：只在内容是集号/卷号时才剥 */
const BRACKET_KEEP_CHECK = (inner: string): boolean =>
  /第?\s*\d{1,3}\s*[話话集巻卷章編篇幕]|[#＃♯]\s*\d{1,3}|[前後上下]編|編$|巻$|章$|話$|幕$|終章|完結|ノ无论是/.test(inner) === false;

/** 波浪号：剥最后一组，但剥空则回退 */
function stripTilde(s: string): string {
  // 🔴 必须含 `〜`(U+301C WAVE DASH)。hanime 视频页日文原名极常用 `〜`。
  const parts = String(s).split(/[～~〜]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return s;
  return parts[0];
}

export function fullBody(s: string): string {
  let t = String(s || '');
  for (const [re, rp] of STRIP_RULES) t = t.replace(re, rp);
  /* 括号：逐个判断内容是不是集号 */
  t = t.replace(/\(([^)]*)\)/g, (m, inner: string) => (BRACKET_KEEP_CHECK(inner) ? ' ' : m));
  t = t.replace(/（([^）]*)）/g, (m, inner: string) => (BRACKET_KEEP_CHECK(inner) ? ' ' : m));
  /* 波浪号：剥最后一组副标题 */
  t = stripTilde(t);
  return t.replace(/[\s　]+/g, ' ').trim();
}

const EP_SUFFIX_RE = new RegExp(
  [
    '[第\\s]*\\d{1,3}\\s*[話话集巻卷章編篇幕]',
    '第[一二三四五六七八九十百零兩两]+[話话集巻卷章編篇幕]',
    '[前後上下]編',
    '[上下]巻',
    '[#＃♯]\\s*\\d{1,3}',
  ].join('|'),
  'g',
);

/** 剥掉逐集/分卷后缀，返回用于审计比对的作品基名。 */
export function workBaseName(s: string): string {
  const t = fullBody(s);
  if (!t) return '';
  const cut = t.replace(EP_SUFFIX_RE, ' ').replace(/[\s　]+/g, ' ').trim();
  // 剥完必须仍有实质内容（≥2 字符）才采信，否则回退
  return cut.length >= 2 ? cut : t;
}

const ORD_EP_RE =
  /\b(the\s+)?\d{1,3}(st|nd|rd|th)\b[\s\S]*$|\bepisode\s*\d{1,3}\b[\s\S]*$|\bvol\.?\s*\d{1,3}\b[\s\S]*$/i;
const FROM_EP_RE = /第\s*\d{1,3}\s*[話话集巻卷章編篇幕]|\s(?:前|後|上下)編|\s\d{1,3}\s*[話幕章]/;

/** ⚠️ 依赖 canon（函数提升），与 mjs 版同样的调用顺序 */
export function variants(s: string): string[] {
  const out: string[] = [];
  const push = (x: string): void => {
    const v = workBaseName(String(x || ''));
    if (!v || out.includes(v)) return;
    const cv = canon(v);
    if (cv.length < 2) return;
    out.push(v);
  };
  const raw = String(s || '');

  push(raw);
  if (!out.length) push(fullBody(raw));

  /* 波浪号两侧都可能是作品名 —— 每个段都作为独立变体 */
  for (const seg of raw.split(/[～~〜]/)) {
    const t = seg.trim();
    if (t.length >= 2) push(t);
  }

  // 切法 B：从「第N話/幕/巻/前後編」处截断
  const i2 = raw.search(FROM_EP_RE);
  const tB = i2 > 0 ? raw.slice(0, i2) : '';
  push(tB);
  // 切法 C：剥英文序数副标题
  const tC = raw.replace(ORD_EP_RE, ' ');
  push(tC);
  // 切法 D：拉丁段 / 片假名段单独成变体
  for (const piece of raw.split(/[\s　]+/)) {
    if (/[A-Za-z]{3,}/.test(piece)) push(piece);
    if (/[ァ-ヴー]{2,}/.test(piece)) push(piece);
  }
  // 两两组合
  for (const x of [tB, tC].filter(Boolean)) {
    for (const seg of x.split(/[～~〜]/)) {
      const t = seg.trim();
      if (t.length >= 2) push(t);
    }
    push(String(x).replace(FROM_EP_RE, ' '));
    push(String(x).replace(ORD_EP_RE, ' '));
  }
  return out;
}

/** 候选名的变体集 —— 与源侧同构，方向相反 */
export function candVariants(cands: string[]): string[] {
  const out = new Set<string>();
  const add = (x: string): void => {
    const v = String(x || '').replace(/[\s　]+/g, ' ').trim();
    if (v.length >= 2 && canon(v).length >= 2) out.add(v);
  };
  for (const c of cands || []) {
    add(c);
    add(fullBody(c));
    for (const seg of String(c || '').split(/[～~〜]/)) {
      const t = seg.trim();
      if (t.length >= 2) add(t);
    }
  }
  return [...out];
}

/* ── canon：简繁归一 + 浊音归一 + 去符号 ── */
const KANA: Record<string, string> = { じ: 'し', ず: 'す', ば: 'は', ぱ: 'は', ぢ: 'ち', づ: 'つ' };
const KANA_ONLY_RE = /[ぁ-ゖァ-ヴー]/g;
const KANA_STOP = new Set(['の', 'か', 'は', 'を', 'に', 'で', 'と', 'ゃ', 'ゅ', 'ょ']);

/** 抽取「有判别力的假名」 */
export function kanaOf(s: string): string {
  const arr = String(s || '').match(KANA_ONLY_RE) || [];
  const kept = arr.filter((c) => !KANA_STOP.has(c));
  return kept.length ? kept.join('') : arr.join('');
}

/** 真正的「假名」：只含假名字符本体（`・` 是标点，不算假名） */
const HAS_KANA_RE = /[ぁ-ゖァ-ヺ]/;
const SPLIT_KANA = /(?=[ぁ-ゖァ-ヺ])/;

export function canon(s: string): string {
  const base = fullBody(s).toLowerCase();
  const pre = base.replace(/[・･･]/g, ' ');
  let t = '';
  for (const seg of pre.split(SPLIT_KANA)) {
    if (!seg) continue;
    if (HAS_KANA_RE.test(seg)) {
      t += seg;
      continue;
    }
    try {
      t += CONVERTER(seg);
    } catch {
      t += seg;
    }
  }
  return t
    .replace(/[ぁ-ん]/g, (c) => KANA[c] || c)
    .replace(/[^\w぀-ヿ一-鿿]/g, '');
}

export function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0) as number[]]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** ✅ 字符 bigram Dice —— set 键只放 bigram 本身，不带索引 */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = bg(a);
  const B = bg(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / ((a.length - 1) + (b.length - 1));
}

function hanzi(s: string): string[] {
  return [...new Set(s.match(/[\u4e00-\u9fff]/g) || [])];
}

/** 汉字覆盖率 —— 跨语言译名唯一可用的信号 */
export function cover2(a: string, b: string): number {
  const ha = hanzi(a);
  if (!ha.length) return 0;
  const sb = new Set(b);
  return ha.filter((c) => sb.has(c)).length / ha.length;
}

export function lcsRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best / Math.max(a.length, b.length);
}

export interface JudgeResult {
  dice: number;
  cover: number;
  coverBi: number;
  lcs: number;
  shared: number;
  yDiff: number | null;
  ok: boolean;
  weak: boolean;
  which: string;
  why: string;
}

/** 三判据取或 + 年份闸门 + 假名闸门 + 共享量下限 */
export function judgeSimilarity(
  srcCanon: string,
  candCanon: string,
  srcYear: number | string | null | undefined,
  tmdbYear: number | string | null | undefined,
): JudgeResult {
  const a = srcCanon || '';
  const b = candCanon || '';
  const d = dice(a, b);
  const c1 = cover2(a, b);
  const c2 = cover2(b, a);
  const l = lcsRatio(a, b);
  const sb = new Set(b);
  const sh = hanzi(a).filter((c) => sb.has(c)).length;
  const biDir = c1 >= 0.8 && c2 >= 0.6;

  const sy = srcYear ? Number(srcYear) : null;
  const ty = tmdbYear ? Number(tmdbYear) : null;
  const yDiff = sy !== null && ty !== null ? Math.abs(sy - ty) : null;
  const R: JudgeResult = {
    dice: d, cover: c1, coverBi: Math.min(c1, c2), lcs: l, shared: sh, yDiff,
    ok: false, weak: false, which: '', why: '',
  };

  /* 闸门①：年份反证 */
  if (yDiff !== null && yDiff > 2) return { ...R, why: `年份差${yDiff}（源${sy} vs TMDB${ty}）` };

  /* 闸门②：假名一致性 */
  const ka = kanaOf(a);
  const kb = kanaOf(b);
  if (ka.length >= 2 && kb.length >= 2 && dice(ka, kb) < 0.5)
    return { ...R, why: `假名不一致：「${ka}」≠「${kb}」（同系列不同作品）` };

  const yearOk = yDiff !== null && yDiff <= 1;

  if (d >= 0.6) return { ...R, ok: true, which: 'dice', why: `dice=${d.toFixed(3)}` };
  if (l >= 0.7 && a.length >= 4 && b.length >= 4)
    return { ...R, ok: true, which: 'lcs', why: `lcs=${l.toFixed(3)}` };
  if (biDir && sh >= 1)
    return { ...R, ok: true, weak: yDiff === 1, which: 'cover2', why: `双向覆盖=${c1.toFixed(2)}/${c2.toFixed(2)} 共享${sh}字` };

  /* 以下全是弱判据：共享量下限在此生效 */
  if (sh < 1) return { ...R, why: `dice=${d.toFixed(3)} 覆盖=${c1.toFixed(2)}/${c2.toFixed(2)}，且无共享汉字` };
  if (sh < 2 && !yearOk) return { ...R, why: `仅共享${sh}个汉字，年份不构成佐证` };
  if (yearOk && !(ka && kb) && (sh >= 3 ? d >= 0.25 : true))
    return { ...R, ok: true, weak: true, which: 'year+hanzi', why: `年份吻合(${sy}/${ty})+共享${sh}字+无假名冲突` };
  return { ...R, why: `dice=${d.toFixed(3)} 覆盖=${c1.toFixed(2)}/${c2.toFixed(2)} 共享${sh}字 均不足` };
}

export interface VariantJudgeResult {
  ok: boolean;
  weak: boolean;
  dice: number;
  which: string;
  why: string;
  via_variant: string;
  via_cand: string;
}

/**
 * 全对判据：变体 × 候选名，任一 ok 即 ok；全部 ok 则取 dice 最大者。
 *
 * ⚠️ `cands` 必须传**原始名**，⛔ 不要预先 canon（否则双重 canon 会让 dice 掉到 0）。
 */
export function judgeVariants(
  srcRaw: string,
  cands: string[],
  srcYear: number | string | null | undefined,
  tmdbYear: number | string | null | undefined,
): VariantJudgeResult {
  let best: VariantJudgeResult = {
    ok: false, weak: false, dice: 0, which: '', why: '无可用变体', via_variant: '', via_cand: '',
  };
  const rank = (j: VariantJudgeResult): number => (j.ok ? (j.weak ? 1 : 2) : 0) * 1000 + j.dice;
  let bestRank = rank(best);
  const vs = variants(srcRaw);
  if (!vs.length) return { ...best, why: '无可用变体（剥离后全空）' };
  for (const v of vs) {
    const cv = canon(v);
    if (!cv) continue;
    for (const c of candVariants(cands)) {
      const cc = canon(c);
      if (!cc) continue;
      const j = judgeSimilarity(cv, cc, srcYear, tmdbYear);
      if (rank({ ...best, ...j }) > bestRank) {
        best = { ...j, via_variant: v, via_cand: c };
        bestRank = rank(best);
      }
    }
  }
  if (!best.ok && best.dice === 0 && best.why === '无可用变体')
    best.why = '判据失效：源与目标跨文字系统（拉丁↔片假名），dice/覆盖恒 0';
  return best;
}

export interface GradeResult {
  grade: 'A' | 'B' | 'C' | 'D';
  dice: number;
  lev: number;
  exact: boolean;
  yDiff: number | null;
  why: string;
}

/** 分级判定 v5 */
export function gradeMatch(
  srcCanon: string,
  names: string[],
  srcYear: number | string | null | undefined,
  tmdbYear: number | string | null | undefined,
): GradeResult {
  const y = tmdbYear ? Number(tmdbYear) : null;
  const sy = srcYear ? Number(srcYear) : null;
  const yDiff = y !== null && sy !== null ? Math.abs(y - sy) : null;

  let best = { s: 0, l: 999, n: '' };
  let exact = false;
  for (const n of names) {
    if (!n) continue;
    if (n === srcCanon) exact = true;
    const s = dice(srcCanon, n);
    const l = lev(srcCanon, n);
    if (s > best.s || (s === best.s && l < best.l)) best = { s, l, n };
  }

  /* ③ 年份硬门槛：差 >1 直接不可信 */
  if (yDiff !== null && yDiff > 1)
    return { grade: 'D', dice: best.s, lev: best.l, exact, yDiff, why: `年份差${yDiff}` };
  /* 官方无年份：只能靠字面 */
  if (yDiff === null) {
    if (exact) return { grade: 'B', dice: 1, lev: 0, exact: true, yDiff: null, why: '字面全同，官方无年份' };
    if (best.s >= 0.75 || best.l <= 2)
      return { grade: 'B', dice: best.s, lev: best.l, exact: false, yDiff: null, why: '字面强，官方无年份' };
    return { grade: 'C', dice: best.s, lev: best.l, exact: false, yDiff: null, why: '字面弱，官方无年份' };
  }

  if (exact) return { grade: 'A', dice: 1, lev: 0, exact: true, yDiff, why: '字面全同' };
  if (best.s >= 0.5 || best.l <= 3)
    return { grade: 'B', dice: best.s, lev: best.l, exact: false, yDiff, why: '字面强' };
  return { grade: 'C', dice: best.s, lev: best.l, exact: false, yDiff, why: '字面弱' };
}
