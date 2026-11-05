/**
 * ⭐ §79-3 TMDB 判定器 —— 「hanime 发现了新东西，TMDB 那边是什么情况？」
 *
 * 🔴🔴 方向铁律（作者 2026-10-28 明确）：
 *   **hanime 是唯一的新番发现源。TMDB 不是发现源，只做判定与补元数据。**
 *
 *   旧实现（已废弃）是 `TMDB keyword discover → 塞进库`，
 *   后果是不断把 TMDB 上有、hanime 上没有的作品拉进来
 *   （实测孤儿 191 部），而且 202 · 年那种「未来首播」也照收。
 *   ⇒ 现在只回答一个问题：**hanime 给的这条，是「已有番剧出新集」还是「全新番剧」**。
 *
 * 🔴 判定分两条路，走哪条取决于**库里有没有绑定**：
 *
 *   | 情形 | 判定方式 | 为什么不用搜索 |
 *   |---|---|---|
 *   | `work_id` 已绑定 | 直接比集数（hanime 集数 vs TMDB 收录集数） | 已经知道是哪部了，再搜一遍只会引入新错误 |
 *   | `work_id` 未绑定 | 用 hanime 中文标题搜 TMDB，走 `judgeVariants` 判据 | 只能靠字面 + 年份 |
 *
 * 🔴 铁律：**判定只产结论，⛔ 不自动写 `source_work.work_id`**
 *   作者拍板「事实字段自动落 + 新建/匹配留人工」⇒ 匹配决策必须人来做。
 *   本模块只把「建议绑定到哪个 work」写进结论，⛔ 不落库。
 *
 * 🔴 铁律：**「新番」和「旧番漏匹配」必须分开报**
 *   用户要看的是「新出的番剧」。一部 2015 年的老番本周第一次进库，
 *   它不是新番，是漏匹配 —— 混在一起报会让「新番」这个数字失去意义。
 *   ⇒ 判据：TMDB `first_air_date` 年份与本年度相差 ≤1 才算新番。
 */

import type { DB } from '@hifan/core';
import { TmdbClient, judgeVariants, fullBody } from '@hifan/collector';

/**
 * 🔴 生成「搜索用标题」的阶梯 —— 从最保守到最激进，逐个试直到有候选。
 *
 * 🔴🔴 铁律：**⛔ 不能用 `workKey()` 当搜索词**。
 *   `workKey` 返回的是 `norm()` 的**规范化键**（小写、去空格、去符号），
 *   用途是「差集对齐」，不是给人看、更不能拿去搜 TMDB：
 *     `DARK SHELL 監中之艷 2` → `darkshell監中之艷`  ← 搜这个必然 0 条
 *   实证（容器内真跑）：`NUKITASHI 住在拔作島上的我該如何是好？ EX04`
 *   原串带 `EX04`，TMDB 上的名字没有 ⇒ 必须剥掉才能搜到。
 *
 * 阶梯顺序（先保守后激进，命中即停 —— 省请求）：
 *   ① 只剥「明显集号」：EX04 / 第N話 / 结尾裸数字 ⇒ 最接近原名
 *   ② `fullBody()`：额外剥括号、波浪号副标题 ⇒ 覆盖「副标题挡住作品名」
 *   ③ 原串兜底
 */
function searchBases(title: string): string[] {
  const raw = String(title || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (s: string): void => {
    const v = String(s || '').replace(/[\s　]+/g, ' ').trim();
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };

  // ① 只剥明显集号
  const t1 = raw
    .replace(/\bEX\s*\d{1,3}\b/gi, ' ')
    .replace(/第\s*\d{1,3}\s*[話话集期幕]/g, ' ')
    .replace(/[\s\-–—~～.…、]+\d{1,3}\s*$/, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim();
  add(t1);

  // ② 更激进：fullBody（剥括号 / 波浪号副标题）
  try {
    add(fullBody(raw));
  } catch {
    /* fullBody 异常不影响主流程 */
  }

  // ③ 原串兜底
  add(raw);
  return out;
}

/** 一条待判定输入（由 hanime 扫描产出） */
export interface JudgeItem {
  /** hanime 侧 src_key（用于回查 source_work） */
  srcKey: string;
  /** hanime 侧中文标题（判据的源串） */
  title: string;
  /** 作品首播年 */
  year: number;
  /** hanime 侧集数 */
  episodes: number;
  /** 本次新增的集号（续更为具体集号；新收录为全部集号） */
  addedEps: number[];
  /** 'new' = 库里此前没有这个作品键；'continued' = 已有但集数变多 */
  kind: 'new' | 'continued';
  /** 已绑定的 TMDB work id（未绑定为 null） */
  workId: number | null;
}

export type Verdict =
  /** 分集更新，且 TMDB 也已收录到同等集数 */
  | 'episode_update_confirmed'
  /** 分集更新，但 TMDB 还落后（hanime 更快） */
  | 'episode_update_ahead'
  /** 已同步（两边集数一致） */
  | 'in_sync'
  /** 全新番剧（TMDB 有此作品，且是近期首播 ⇒ 也属「新出的番」） */
  | 'new_anime'
  /** 老番漏匹配（TMDB 有此作品，但首播是往年 ⇒ 不是新番） */
  | 'old_anime'
  /** TMDB 完全搜不到 */
  | 'unmatched'
  /** 多个候选分不清 */
  | 'ambiguous';

export interface JudgeOutcome {
  item: JudgeItem;
  verdict: Verdict;
  /** 命中的 TMDB work id（未命中为 null） */
  workId: number | null;
  /** 看板显示名（中文优先） */
  workName: string | null;
  /** TMDB 该作品收录的集数 */
  tmdbEpisodes: number | null;
  /** TMDB 首播日期 */
  firstAirDate: string | null;
  /** 判据得分 */
  confidence: number;
  why: string;
  /** 实际发出的搜索词（🔴 `[]` = **没搜**，不是「无词条」） */
  queries: string[];
  /** 候选列表（ambiguous 时给人工参考） */
  candidates: Array<{ id: number; mediaType: string; name: string; year: number | null; dice: number }>;
}

function yearOf(date: unknown): number | null {
  const s = String(date ?? '');
  if (!/^\d{4}/.test(s)) return null;
  return Number(s.slice(0, 4));
}

/** 读 TMDB 该作品已收录的集数 —— 取「缓存字段」与「实际分集表」的较大值 */
function tmdbEpisodeCount(db: DB, workId: number): number {
  const w = db.prepare(`SELECT episode_total FROM tmdb_work WHERE id = ?`).get(workId) as
    | { episode_total: number | null }
    | undefined;
  const cached = Number(w?.episode_total ?? 0) || 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tmdb_episode WHERE work_id = ?`)
    .get(workId) as { n: number };
  // 🔴 取较大值：episode_total 可能是旧缓存，tmdb_episode 才是实际拉到的
  return Math.max(cached, Number(row?.n ?? 0));
}

/** 读库里已有作品的显示信息 */
function loadWork(
  db: DB,
  workId: number,
): { id: number; name: string; firstAirDate: string | null } | null {
  const r = db
    .prepare(
      `SELECT id, name_zh, name_original, first_air_date FROM tmdb_work WHERE id = ?`,
    )
    .get(workId) as
    | { id: number; name_zh: string | null; name_original: string | null; first_air_date: string | null }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    // 🔴 中文优先；中文为空才回退原名（绝不把原名当"中文"写回，见 §79-4）
    name: (r.name_zh && r.name_zh.trim()) || r.name_original || `#${r.id}`,
    firstAirDate: r.first_air_date,
  };
}

/**
 * 判定单条。
 *
 * ⚠️ `nowYear` 显式传入而不是内部 `new Date().getFullYear()` ——
 *   便于测试里固定时间（否则每年跨年那天断言会飘）。
 */
export async function judgeOne(
  db: DB,
  client: TmdbClient,
  item: JudgeItem,
  nowYear: number,
  onLog?: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<JudgeOutcome> {
  const log = onLog ?? (() => {});
  const base: JudgeOutcome = {
    item,
    verdict: 'unmatched',
    workId: null,
    workName: null,
    tmdbEpisodes: null,
    firstAirDate: null,
    confidence: 0,
    why: '',
    queries: [],
    candidates: [],
  };

  // ── 路线 A：已绑定 ⇒ 只比集数，不搜索 ──
  if (item.workId !== null) {
    const w = loadWork(db, item.workId);
    if (!w) {
      return { ...base, why: `绑定的 tmdb_work #${item.workId} 已不存在` };
    }
    const tmdbEps = tmdbEpisodeCount(db, item.workId);
    const common = {
      ...base,
      workId: w.id,
      workName: w.name,
      tmdbEpisodes: tmdbEps,
      firstAirDate: w.firstAirDate,
      confidence: 1,
    };
    if (item.kind === 'continued') {
      if (tmdbEps >= item.episodes) {
        const extra = tmdbEps - item.episodes;
        // 🔴 文案必须区分「齐平」与「TMDB 更全」——
        //   实测 work#336654：hanime 4 集、TMDB 12 集，
        //   旧文案写「12 集与 4 集齐平」自相矛盾。
        return {
          ...common,
          verdict: 'episode_update_confirmed',
          why:
            extra > 0
              ? `TMDB 收录 ${tmdbEps} 集，覆盖 hanime 这 ${item.episodes} 集（另有 ${extra} 集 hanime 侧没有）`
              : `TMDB 收录 ${tmdbEps} 集，与 hanime 齐平`,
        };
      }
      return { ...common, verdict: 'episode_update_ahead', why: `hanime 已到 ${item.episodes} 集，TMDB 只收录 ${tmdbEps} 集` };
    }
    // 已绑定却出现在「新收录」里 ⇒ hanime 侧历史数据曾经缺失，现在补齐了
    if (tmdbEps >= item.episodes) {
      return { ...common, verdict: 'in_sync', why: `已绑定作品，TMDB ${tmdbEps} 集 ≥ hanime ${item.episodes} 集` };
    }
    return { ...common, verdict: 'episode_update_ahead', why: `已绑定作品，TMDB ${tmdbEps} 集 < hanime ${item.episodes} 集` };
  }

  // ── 路线 B：未绑定 ⇒ 搜索 + 判据 ──
  const queries: string[] = [];
  const raw: Array<Record<string, unknown> & { media_type: 'tv' | 'movie' }> = [];

  /**
   * 🔴 搜索词按阶梯试（见 searchBases 注释）：
   *   先「只剥集号」的保守版，没候选再上 fullBody，最后原串。
   *   ⛔ 不用 workKey —— 那是规范化键，搜 TMDB 必 0 条。
   */
  const bases = searchBases(item.title);

  for (const base of bases) {
    for (const mt of ['tv', 'movie'] as const) {
      queries.push(`${mt}:${base}`);
      try {
        const rs = await client.search(mt, base);
        for (const r of rs.slice(0, 8)) raw.push({ ...r, media_type: mt });
      } catch (err) {
        log('TMDB 搜索失败', { media_type: mt, query: base, err: String(err) });
      }
    }
    // 🔴 这一档已经出结果 ⇒ 不必再往更激进的档试（省请求，也避免噪声候选）
    if (raw.length) break;
  }

  if (!raw.length) {
    return {
      ...base,
      queries,
      // 🔴 区分「搜了但没词条」与「压根没搜」—— 前者才是真·无匹配
      why: queries.length ? `TMDB 无词条（已搜 ${queries.length} 次）` : '未发出搜索（标题为空）',
    };
  }

  interface Scored {
    id: number;
    mediaType: 'tv' | 'movie';
    name: string;
    year: number | null;
    dice: number;
    weak: boolean;
    why: string;
  }
  const scored: Scored[] = [];

  for (const c of raw) {
    const id = Number(c.id);
    if (!Number.isFinite(id)) continue;
    const nm = String(c.name ?? c.original_name ?? '');
    if (!nm) continue;
    const ty = yearOf(c.first_air_date ?? c.release_date);

    // 第一轮只用 name / original_name 判（省一次别名请求）
    const names1 = [c.name, c.original_name].map((x) => String(x ?? '')).filter(Boolean);
    const j1 = judgeVariants(item.title, names1, item.year, ty);
    if (!j1.ok) continue;

    // 第一轮通过 ⇒ 补别名再判一次（别名里常有正确日文名，能提高分并减少 ambiguous）
    let best = { dice: j1.dice, weak: j1.weak, why: j1.why };
    try {
      const alt = await client.alternativeTitles(c.media_type, id);
      if (alt.length) {
        const j2 = judgeVariants(item.title, [...names1, ...alt], item.year, ty);
        if (j2.ok && j2.dice >= best.dice) best = { dice: j2.dice, weak: j2.weak, why: j2.why };
      }
    } catch {
      /* 别名拉不到不影响结论 */
    }

    scored.push({ id, mediaType: c.media_type, name: nm, year: ty, dice: best.dice, weak: best.weak, why: best.why });
  }

  if (!scored.length) {
    return { ...base, queries, why: `TMDB 有 ${raw.length} 个候选，但判据全部不通过（已搜 ${queries.length} 次）` };
  }

  scored.sort((a, b) => b.dice - a.dice || (b.weak ? 0 : 1) - (a.weak ? 0 : 1));
  const best = scored[0];
  const second = scored[1];

  const candidates = scored.slice(0, 5).map((s) => ({
    id: s.id,
    mediaType: s.mediaType,
    name: s.name,
    year: s.year,
    dice: Number(s.dice.toFixed(3)),
  }));

  // 🔴 分不清就交人工 —— ⛔ 不猜（规则 C 的同一条原则）
  if (second && !best.weak && !second.weak && best.dice - second.dice < 0.1) {
    return {
      ...base,
      verdict: 'ambiguous',
      workId: best.id,
      workName: best.name,
      firstAirDate: best.year ? String(best.year) : null,
      confidence: best.dice,
      queries,
      candidates,
      why: `两个候选分不清（dice ${best.dice.toFixed(3)} vs ${second.dice.toFixed(3)}）`,
    };
  }

  // 命中的 TMDB id 库里已经有 ⇒ 这是「已有作品」，不是凭空新番
  const exist = db.prepare(`SELECT id FROM tmdb_work WHERE id = ?`).get(best.id) as
    | { id: number }
    | undefined;
  const w = exist ? loadWork(db, best.id) : null;
  const airYear = best.year ?? yearOf(w?.firstAirDate);
  const isRecent = airYear !== null && Math.abs(nowYear - airYear) <= 1;

  if (exist) {
    return {
      ...base,
      verdict: isRecent ? 'new_anime' : 'old_anime',
      workId: best.id,
      workName: w?.name ?? best.name,
      tmdbEpisodes: tmdbEpisodeCount(db, best.id),
      firstAirDate: w?.firstAirDate ?? (best.year ? String(best.year) : null),
      confidence: best.dice,
      queries,
      candidates,
      why: isRecent
        ? `TMDB 已有此作品（${airYear} 首播），属新番`
        : `TMDB 已有此作品（${airYear} 首播），是往年作品漏匹配，不是新番`,
    };
  }

  // 库里没有 ⇒ TMDB 侧是新词条
  return {
    ...base,
    verdict: isRecent ? 'new_anime' : 'old_anime',
    workId: best.id,
    workName: best.name,
    tmdbEpisodes: null,
    firstAirDate: best.year ? String(best.year) : null,
    confidence: best.dice,
    queries,
    candidates,
    why: isRecent
      ? `TMDB 新词条（${airYear} 首播），建议新建作品`
      : `TMDB 新词条（${airYear} 首播），往年作品漏收，不是新番`,
  };
}

/** 批量判定（串行 —— TMDB 有速率限制，并发只会一起被 429） */
export async function judgeBatch(
  db: DB,
  client: TmdbClient,
  items: JudgeItem[],
  nowYear: number,
  onLog?: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<JudgeOutcome[]> {
  const log = onLog ?? (() => {});
  const out: JudgeOutcome[] = [];
  let i = 0;
  for (const it of items) {
    i++;
    try {
      out.push(await judgeOne(db, client, it, nowYear, log));
    } catch (err) {
      out.push({
        item: it,
        verdict: 'unmatched',
        workId: null,
        workName: null,
        tmdbEpisodes: null,
        firstAirDate: null,
        confidence: 0,
        why: `判定异常：${(err as Error).message}`,
        queries: [],
        candidates: [],
      });
    }
    if (i % 10 === 0) log('判定进度', { done: i, total: items.length });
  }
  return out;
}

export interface JudgeSummary {
  /** 分集更新（含 confirmed / ahead） */
  episodeUpdates: JudgeOutcome[];
  /** 新番 */
  newAnime: JudgeOutcome[];
  /** 往年作品漏匹配 */
  oldAnime: JudgeOutcome[];
  /** 已同步，无需动作 */
  inSync: JudgeOutcome[];
  /** 待人工（无匹配 / 分不清） */
  needsManual: JudgeOutcome[];
}

export function summarize(outcomes: JudgeOutcome[]): JudgeSummary {
  const s: JudgeSummary = { episodeUpdates: [], newAnime: [], oldAnime: [], inSync: [], needsManual: [] };
  for (const o of outcomes) {
    switch (o.verdict) {
      case 'episode_update_confirmed':
      case 'episode_update_ahead':
        s.episodeUpdates.push(o);
        break;
      case 'new_anime':
        s.newAnime.push(o);
        break;
      case 'old_anime':
        s.oldAnime.push(o);
        break;
      case 'in_sync':
        s.inSync.push(o);
        break;
      default:
        s.needsManual.push(o);
    }
  }
  return s;
}

/** 生成企微报告正文（分「分集更新」「新番」「待人工」三块） */
export function formatJudgeReport(
  s: JudgeSummary,
  durationMs: number,
  linkSync?: { attempted: number; succeeded: number; failed: number; pendingLeft: number } | null,
): string {
  const L: string[] = [];
  const sec = (n: number): string => `${Math.round(n / 1000)}s`;

  L.push(`【里番库更新】hanime 扫描 + TMDB 判定 用时 ${sec(durationMs)}`);
  L.push('');

  if (s.episodeUpdates.length) {
    L.push(`📺 分集更新 ${s.episodeUpdates.length} 部`);
    for (const o of s.episodeUpdates.slice(0, 25)) {
      const it = o.item;
      const eps = it.addedEps.length ? `第 ${it.addedEps.join('、')} 话` : `${it.episodes} 集`;
      const tag = o.verdict === 'episode_update_confirmed' ? 'TMDB 已收录 ✅' : `TMDB 只到 ${o.tmdbEpisodes} 集 ⏳`;
      L.push(`· ${it.title}：新增 ${eps}｜${tag}`);
    }
    if (s.episodeUpdates.length > 25) L.push(`· …另有 ${s.episodeUpdates.length - 25} 部`);
    L.push('');
  }

  if (s.newAnime.length) {
    L.push(`🆕 新番 ${s.newAnime.length} 部`);
    for (const o of s.newAnime.slice(0, 25)) {
      const it = o.item;
      const tm = o.workId ? `TMDB: ${o.workName ?? '-'}（${o.firstAirDate ?? '无日期'}）` : 'TMDB 无匹配 ⚠️';
      L.push(`· ${it.title}（${it.year}，${it.episodes} 集）｜${tm}`);
    }
    if (s.newAnime.length > 25) L.push(`· …另有 ${s.newAnime.length - 25} 部`);
    L.push('');
  }

  if (s.oldAnime.length) {
    L.push(`📼 往年作品新收录 ${s.oldAnime.length} 部（不是新番，是历史漏匹配）`);
    for (const o of s.oldAnime.slice(0, 10)) {
      L.push(`· ${o.item.title}（${o.item.year}）｜TMDB: ${o.workName ?? '-'}`);
    }
    if (s.oldAnime.length > 10) L.push(`· …另有 ${s.oldAnime.length - 10} 部`);
    L.push('');
  }

  if (s.needsManual.length) {
    L.push(`⚠️ 需人工处理 ${s.needsManual.length} 部`);
    for (const o of s.needsManual.slice(0, 10)) {
      L.push(`· ${o.item.title}（${o.item.year}）｜${o.why}`);
    }
    if (s.needsManual.length > 10) L.push(`· …另有 ${s.needsManual.length - 10} 部`);
    L.push('');
  }

  if (!s.episodeUpdates.length && !s.newAnime.length && !s.oldAnime.length) {
    L.push('本期无新增内容。');
  }

  /* 🔴 §86（2026-10-30）：链接同步结果要出现在报告里 ——
   * 作者要的是「后期抓的剧集和下载链接是真的落地」，
   * ⇒ 推送里必须能看到「这轮补了多少条链接、还剩多少没补」。
   */
  if (linkSync && linkSync.attempted > 0) {
    L.push('');
    L.push(
      `🔗 下载链接 ${linkSync.succeeded}/${linkSync.attempted} 已补` +
        (linkSync.failed ? `（失败 ${linkSync.failed}）` : '') +
        (linkSync.pendingLeft > 0 ? `，还有 ${linkSync.pendingLeft} 个留到下轮` : ''),
    );
  }

  L.push(`（同步 ${s.inSync.length} 部无变化）`);
  return L.join('\n');
}
