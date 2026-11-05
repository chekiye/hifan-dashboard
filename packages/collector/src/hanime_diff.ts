/**
 * hanime 差集检测 —— 「什么算有更新」的核心判据
 *
 * 🔴🔴 判据铁律 1：**差集必须按「作品键 + 集号」，不能按 vid**
 *   2026-10-28 实测：泡麵番 2026 出现「新增 4 / 消失 3」。
 *   那 3 条「消失」（vid 408651 / 408655 / 408656）**不是删了**，
 *   而是**同一集在源站换了 vid 重发**。
 *   ⇒ 若按 vid 求差集，每天都会误报「源站删片」，
 *     久而久之没人信这个报告 ⇒ 更新检测就废了。
 *   ⇒ 正确判据：作品键对齐 → 比「集号集合」，vid 只当辅助信息。
 *
 * 🔴🔴 判据铁律 2：`norm()` 必须与 `scripts/hanime_dedup_all.py` **逐字一致**
 *   改一个字，新旧作品键就对不上，差异报告全是噪声。
 *   Python 版原文：
 *     s = re.sub(r'^\s*\[[^\]]{1,40}\]\s*', '', s)          # [厂牌]
 *     s = re.sub(r'【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）', '', s)
 *     s = re.sub(r'[-–—~～]?\s*[\d０-９]+\s*$', '', s)      # 结尾集数
 *     s = re.sub(r'\s*(part|ep|episode|no|vol|version|話|话|集|卷)\s*\.?\s*[\d０-９]+\s*$', '', s, flags=re.I)
 *     s = re.sub(r'[\s\-–—_~、,，。!！?？:：;；"\'“”‘’()（）\[\]【】*#＃♪]+', '', s)
 *     return s.lower()
 *
 * 更新四分类（与 §79 方案一致）：
 *   A 新收录作品 —— 作品键只在库里
 *   B 续更       —— 作品键两边都有，**集号集合变大**
 *   C vid 差集   —— 辅助信息（换 vid / 缺具体视频），⛔不作为「删除」判据
 *   D TMDB 新增  —— 在 tmdb_diff.ts 算
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HanimeItem } from './hanime_scan.js';

/** 🔴 与 hanime_dedup_all.py:norm 逐字一致（见文件头铁律 2） */
export function norm(t: string): string {
  let s = t;
  // [厂牌] —— 开头
  s = s.replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
  // 【】[]()（） 括号类
  s = s.replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, '');
  // 结尾集数（可带 -–—~～ 前缀）
  s = s.replace(/[-–—~～]?\s*[\d０-９]+\s*$/, '');
  // part/ep/episode/no/vol/version/話/话/集/卷 + 数字
  s = s.replace(
    /\s*(part|ep|episode|no|vol|version|話|话|集|卷)\s*\.?\s*[\d０-９]+\s*$/i,
    '',
  );
  // 符号与空白全剥
  s = s.replace(
    /[\s\-–—_~、,，。!！?？:：;；"'“”‘’()（）[\]【】*#＃♪]+/g,
    '',
  );
  return s.toLowerCase();
}

/**
 * 从标题里抽集号。
 * ⚠️ 集号抽取**只在作品键已对齐之后**用于比大小，不是身份字段。
 *   （铁律 0bm：集名单独没有区分力，不能当作品级身份字段。）
 * 覆盖：`第2话` / `第 2 話` / `第3集` / ` 2話` / `EP02` / `No.5` / `Vol.3`
 *      / 结尾裸数字（第2话已剥前） / `2ND SEASON`
 */
export function extractEpisodeNo(title: string): number | null {
  const t = title.trim();

  // 「第 N 话/話/集/期/幕」
  let m = t.match(/第\s*(\d+)\s*[話话集期幕]/);
  if (m) return Number(m[1]);

  // 「EP/Ep/ep/N o/Vol 」+ 数字
  //   ⚠️ 分隔符可能是空白 / 点 / 短横 ⇒ `vol.2` `vol-2` `ep07` 都要吃下
  m = t.match(/\b(?:ep|episode|vol|version|no)\s*[.\-]?\s*(\d+)\b/i);
  if (m) return Number(m[1]);

  // 「N話 / N集」不带「第」
  m = t.match(/[\s\-–—~～](\d+)\s*[話话集期幕]/);
  if (m) return Number(m[1]);

  // 🔴 结尾裸数字
  //   实测真实标题：「滑鼠游標…3」「不擅交際的未亡人雪女…4」「女友的朋友 4」
  //   「櫻春女學院的男優 1」「與暗黑召喚師秘密戀愛中 1」
  //   ⇒ 分隔符可能是 空格 / 省略号 / 全角省略号 / 波浪线 / 点，不止 -–—~～
  //   ⚠️ 必须要求「前缀非空」(.+?)，否则纯数字标题会被误当成集号；
  //      ⚠️ 前缀里也不能全是数字（否则「2026」这类会被当集号）。
  m = t.match(/(.+?)[\s\-–—~～.…、]+(\d+)\s*$/);
  if (m && !/^\d+$/.test(m[1])) return Number(m[2]);

  // 「第N季」不是集号
  return null;
}

/**
 * 🔴🔴 作品键（差集专用）—— 在 norm 之上再剥一层「集号后缀」
 *
 * 起因（2026-10-28 实测）：
 *   基线里有 `被寢取的巨乳人妻們2 第1話`（vid 408308），
 *   新抓的是 `被寢取的巨乳人妻們2 第2話`（vid 408309）。
 *   但 Python 版 norm 的剥除词表**没有「話」** ⇒
 *     norm('...第1話') = '被寢取的巨乳人妻們2第1話'
 *     norm('...第2話') = '被寢取的巨乳人妻們2第2話'
 *   ⇒ 两个 key 不同 ⇒ **第2话被误判成「新收录作品」**，而不是「续更」。
 *
 * ⛔ 为什么不改 Python 版 norm 本体：
 *   `norm()` 是全库作品键的**唯一事实来源**（hanime_dedup_all.py），
 *   改它会让整个历史库的作品键全部错位 ⇒ 全库对不上。
 *   ⇒ 这里只在**差集这一层**额外归一，不动本体。
 *   （这也是为什么本文件头的「norm 必须逐字一致」铁律依然成立。）
 *
 * ✅ 归一步骤：先抽集号（原始标题上抽），再把集号从标题里剥掉，
 *    最后做 norm。这样 `...第1話` 与 `...第2話` 归到同一个 key。
 */
export function workKey(title: string): string {
  const no = extractEpisodeNo(title);
  let t = title;
  if (no !== null) {
    // 剥掉「第N話」这类带标记的
    t = t.replace(/第\s*\d+\s*[話话集期幕]/g, ' ');
    // 剥掉结尾裸数字（前面留分隔符，避免把词粘在一起）
    t = t.replace(/[\s\-–—~～.…、]+\d+\s*$/, ' ');
  }
  const k = norm(t);
  // 🔴🔴 `__short__` 兜底 —— **用剥掉集号后的标题**
  //   起因：标题 `[el] 1` 剥完括号只剩「 1」⇒ 剥数字后**空串**
  //        ⇒ workKey 空 ⇒ bucketByWork 直接丢弃 ⇒ **分桶不守恒**（3547 ≠ 3549）
  //   ⭐ 为什么用剥后标题而不是原始标题：
  //     用原始标题 ⇒ `__short__[el] 1` 与 `__short__[el] 2` 是两个 key
  //     ⇒ 第2集每次都被误判成「新收录作品」（实测 8 个假阳性里的 6 个）
  //     用剥后标题 ⇒ `__short__[el]` ⇒ 第1/2集归同一部 ⇒ 判成「续更」✓
  //   ⚠️ 与库里的 `src_key`（`__short__[el] 1`，用原始标题）**不是同一个键**
  //     —— 这是**有意的**：src_key 是落库用的（norm 口径），workKey 是差集对齐用的。
  //     两者职责不同（见文件头铁律 1），⛔不要合并。
  if (k.length < 2) return `__short__${t.trim()}`;
  return k;
}

export interface WorkBucket {
  /** 作品键（归一化后的标题） */
  key: string;
  /** 原始标题（给人看） */
  title: string;
  /** 该作品下的条目 */
  items: HanimeItem[];
  /** 抽到的集号集合（升序） */
  episodeNos: number[];
  /** 抽不到集号时的条目数（用「数量」兜底判续更） */
  unknownCount: number;
}

export function bucketByWork(items: HanimeItem[]): Map<string, WorkBucket> {
  const map = new Map<string, WorkBucket>();
  for (const it of items) {
    // 🔴 用 workKey（norm + 集号后缀归一），⛔不是裸 norm
    const key = workKey(it.title);
    if (!key) continue;
    let b = map.get(key);
    if (!b) {
      b = { key, title: it.title, items: [], episodeNos: [], unknownCount: 0 };
      map.set(key, b);
    }
    b.items.push(it);
    // 标题保留最早一条作为展示标题
    if (it.title.length < b.title.length) b.title = it.title;
    const no = extractEpisodeNo(it.title);
    if (no !== null) b.episodeNos.push(no);
    else b.unknownCount++;
  }
  for (const b of map.values()) {
    b.episodeNos = [...new Set(b.episodeNos)].sort((a, z) => a - z);
  }
  return map;
}

/** 读一个目录下的所有 <genre>_<year>.jsonl */
export function loadJsonlDir(dir: string): HanimeItem[] {
  const out: HanimeItem[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
    const text = readFileSync(join(dir, f), 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as HanimeItem;
        if (o && o.vid && o.title) out.push(o);
      } catch {
        /* 坏行跳过，不让一行坏数据毁掉整轮 */
      }
    }
  }
  return out;
}

export interface NewWork {
  key: string;
  title: string;
  genre: string;
  year: number;
  count: number;
  episodeNos: number[];
  vids: string[];
}

export interface ContinuedWork {
  key: string;
  title: string;
  genre: string;
  year: number;
  oldCount: number;
  newCount: number;
  oldEps: number[];
  newEps: number[];
  /** 新增的集号 */
  addedEps: number[];
  /** 新增条目（取最新一条作展示） */
  addedSamples: Array<{ vid: string; title: string }>;
}

/**
 * 🔴🔴 落库定位 —— 「这个新条目该写进库里哪一行？」
 *
 * ⛔ 为什么这事这么难（2026-10-28 实测全库 1542 行后量化）：
 *   库里**同时存在两种行结构**：
 *     · **聚合行**（999 行）—— 一部作品一行，entry_detail 里装全部集
 *       例：`15美少女漂流記` → eps=3，条目「…1 / …2 / …3」
 *     · **单集行**（543 行）—— 一集一行
 *       例：`被寢取的巨乳人妻們2第1話` → eps=1
 *   ⇒ **同一部作品可能既有聚合行又有单集行**
 *     （实测「自宅警備員」：聚合行 eps=4 + 单集行第1~8話 共 9 行）
 *   ⇒ 按 workKey 查会命中多行 ⇒ 自动落库会写错行（写错行 = 污染 TMDB 绑定）
 *
 * ⭐ 消歧规则 C（实测歧义率 0.00%，1164 个 workKey 全命中）：
 *   ① 排除 `status='dup'` 的行（重复行，⛔不往里写）
 *   ② 若候选中有 `src_key === workKey` 的行 ⇒ 选它（那是聚合主行）
 *   ③ 否则选「该 workKey 下最大集号」的行
 *      （新集必然是当前最大集号+1 ⇒ 它属于最新那一行）
 *   ④ 若仍并列 ⇒ 返回 null，交给人工（⛔不猜）
 *
 * 🔴 铁律：歧义时**宁可不动**，也不能猜着写 —— 写错行比不写更糟。
 */
export interface RowRef {
  id: number;
  src_key: string;
  title: string;
  status: string;
  episodes: number | null;
  entry_detail: string | null;
  year: number | null;
  years: string | null;
}

export interface PickResult {
  row: RowRef | null;
  reason: string;
}

/** 从行明细里算该 workKey 下的最大集号（抽不到集号返回 -1） */
export function maxEpisodeNoOf(details: Array<Record<string, unknown>>, wk: string): number {
  let mx = -1;
  for (const d of details) {
    if (workKey(String(d.title ?? '')) !== wk) continue;
    const no = extractEpisodeNo(String(d.title ?? ''));
    if (no !== null && no > mx) mx = no;
  }
  return mx;
}

/**
 * 选落库目标行。
 * @param rows 该 workKey 下的所有候选行
 */
export function pickTargetRow(wk: string, rows: RowRef[]): PickResult {
  if (rows.length === 0) return { row: null, reason: '库里没有对应作品' };

  // ① 排除 dup 行
  const nonDup = rows.filter((r) => r.status !== 'dup');
  const pool = nonDup.length > 0 ? nonDup : rows;
  if (nonDup.length === 0) {
    return { row: null, reason: '候选全是 dup 行，不自动写' };
  }

  // ② src_key === workKey ⇒ 聚合主行
  const exact = pool.filter((r) => r.src_key === wk);
  if (exact.length === 1) return { row: exact[0], reason: 'src_key 精确匹配' };
  if (exact.length > 1) {
    // 多个 src_key 精确匹配 ⇒ 再按最大集号
    return pickByMaxEpisode(wk, exact);
  }

  // ③ 按最大集号
  return pickByMaxEpisode(wk, pool);
}

function pickByMaxEpisode(wk: string, pool: RowRef[]): PickResult {
  const scored = pool.map((r) => {
    let details: Array<Record<string, unknown>> = [];
    try {
      details = r.entry_detail ? (JSON.parse(r.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      details = [];
    }
    return { r, mx: maxEpisodeNoOf(details, wk) };
  });
  const best = Math.max(...scored.map((s) => s.mx));
  const winners = scored.filter((s) => s.mx === best);
  if (winners.length === 1) {
    return { row: winners[0].r, reason: `最大集号 ${best === -1 ? '(无)' : best}` };
  }
  return {
    row: null,
    reason: `${winners.length} 行并列最大集号 ${best === -1 ? '(无)' : best}，需人工判断`,
  };
}

export interface VidDiff {
  key: string;
  title: string;
  /** 只在旧库 */
  onlyOld: string[];
  /** 只在新库 */
  onlyNew: string[];
}

export interface DiffResult {
  newWorks: NewWork[];
  continued: ContinuedWork[];
  /** 辅助信息：vid 差集（⛔不作为删除判据） */
  vidDiff: VidDiff[];
  oldTotal: number;
  newTotal: number;
  oldWorkCount: number;
  newWorkCount: number;
  /** ⚠️ 只有作品键变了、但集号无法对比的（需人工看） */
  needsManual: Array<{ key: string; title: string; reason: string }>;
}

/**
 * 比对新旧两个作品库。
 * @param oldItems 库里已有的（基线）
 * @param newItems 新抓到的
 */
export function diffWorks(oldItems: HanimeItem[], newItems: HanimeItem[]): DiffResult {
  const oldMap = bucketByWork(oldItems);
  const newMap = bucketByWork(newItems);

  const newWorks: NewWork[] = [];
  const continued: ContinuedWork[] = [];
  const vidDiff: VidDiff[] = [];
  const needsManual: DiffResult['needsManual'] = [];

  for (const [key, nb] of newMap) {
    const ob = oldMap.get(key);
    if (!ob) {
      // A. 新收录作品
      newWorks.push({
        key,
        title: nb.title,
        genre: nb.items[0]?.genre ?? '',
        year: nb.items[0]?.year ?? 0,
        count: nb.items.length,
        episodeNos: nb.episodeNos,
        vids: nb.items.map((i) => i.vid),
      });
      continue;
    }

    // B. 续更判定 —— 按集号集合，不按 vid
    const oldSet = new Set(ob.episodeNos);
    const newSet = new Set(nb.episodeNos);
    const addedEps = nb.episodeNos.filter((e) => !oldSet.has(e));
    const removedEps = ob.episodeNos.filter((e) => !newSet.has(e));

    // 集号可比（两边都抽到集号）⇒ 按集号判
    if (ob.episodeNos.length > 0 && nb.episodeNos.length > 0) {
      if (addedEps.length > 0) {
        const addedSamples = nb.items
          .filter((i) => {
            const no = extractEpisodeNo(i.title);
            return no !== null && addedEps.includes(no);
          })
          .map((i) => ({ vid: i.vid, title: i.title }));
        continued.push({
          key,
          title: nb.title,
          genre: nb.items[0]?.genre ?? '',
          year: nb.items[0]?.year ?? 0,
          oldCount: ob.items.length,
          newCount: nb.items.length,
          oldEps: ob.episodeNos,
          newEps: nb.episodeNos,
          addedEps,
          addedSamples,
        });
      }
      // 集号变少 = 源站下架/换号，⛔ 不当作「删除」，只进 vidDiff
      if (removedEps.length > 0) {
        vidDiff.push({
          key,
          title: nb.title,
          onlyOld: ob.items.map((i) => i.vid),
          onlyNew: nb.items.map((i) => i.vid),
        });
      }
      continue;
    }

    // 抽不到集号 ⇒ 只能比条目数
    if (nb.items.length > ob.items.length) {
      needsManual.push({
        key,
        title: nb.title,
        reason: `条目数 ${ob.items.length} → ${nb.items.length}，但抽不到集号，无法确认是续更还是换 vid`,
      });
    }
  }

  // vid 差集（辅助）
  for (const [key, nb] of newMap) {
    const ob = oldMap.get(key);
    if (!ob) continue;
    const oldVids = new Set(ob.items.map((i) => i.vid));
    const newVids = new Set(nb.items.map((i) => i.vid));
    const onlyOld = ob.items.map((i) => i.vid).filter((v) => !newVids.has(v));
    const onlyNew = nb.items.map((i) => i.vid).filter((v) => !oldVids.has(v));
    if (onlyOld.length > 0 || onlyNew.length > 0) {
      if (!vidDiff.some((d) => d.key === key)) {
        vidDiff.push({ key, title: nb.title, onlyOld, onlyNew });
      }
    }
  }

  return {
    newWorks,
    continued,
    vidDiff,
    oldTotal: oldItems.length,
    newTotal: newItems.length,
    oldWorkCount: oldMap.size,
    newWorkCount: newMap.size,
    needsManual,
  };
}
