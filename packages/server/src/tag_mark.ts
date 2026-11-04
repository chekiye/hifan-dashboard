/**
 * ⭐ §151 标签档位（2026-11-04 蛙哥）
 *
 * 原话：「把 hanime 的所有视频标签都抓出来，汇总去重，我后续需要单独设置高亮，
 *        比如我不想看伪娘、猎奇这种，我可能就会把这部分高亮显示，让我一眼就看出来，
 *        然后避开下载……因为我可能会不定期增加会删减标签，可以让我自己手动选择
 *        标签的高亮就好了」
 * 追问后定稿（两档，不是三档）：
 *   「我选了喜欢和避开，其实剩下的就是不关心」⇒ ⛔ 不给「不关心」第三种颜色，
 *   没选的保持原来的灰。红只出现在真要避开的地方，红色才有警示作用。
 *
 * ## 设计要点
 * ① **独立表 `tag_mark`**，一行一个标签。⛔ 不改 `video_tag`（那是抓取产物，
 *    重抓会整片覆盖 —— 和 §114 译文那条铁律同理：人工事实不能存在会被覆盖的表里）。
 * ② **取消不做 DELETE**：写 `level=0`（蛙哥的项目铁律「禁 DELETE」），
 *    读的时候只看 `level>0`。好处是可审计、可反悔，且不用碰 nas_apply_sql 白名单。
 * ③ **标签来自 hanime 的 `video_tag.tags`**（3549 个 vid / 65765 条关联 / 249 个标签）。
 *    ⇒ 没有 hanime 源条目的作品不会有标记，这是数据边界，⛔ 不假装有。
 * ④ 作品级命中 = 该作品**所有 hanime 源条目**的标签并集 ∩ 已标记标签。
 *    ⚠️ 为什么按作品算而不是按集算：蛙哥要的是「海报墙扫一眼就该跳过」，
 *       按集标记在海报墙上根本看不见（一集一个标签，8 集要摊开 8 份）。
 *       逐集 chip 上色另做一份（同一套 marks，前端 chip 直接按标签查）。
 * ⑤ 表不存在（线上还没建）⇒ 全部降级成「没有任何标记」，⛔ 绝不让接口 500。
 */
import type { DB } from '@hifan/core';

/** 档位（§153 四档）：
 *  1 = 避开（红，强警示）· 2 = 谨慎（琥珀，能看但要提防）·
 *  3 = 喜欢（绿）· 4 = 本命（紫，特别喜欢）· 0 = 曾经标过、现已取消（不参与任何展示） */
export type TagLevel = 0 | 1 | 2 | 3 | 4;

/** 四档的语义名（后端只在注释/错误文案里用，前端自己有一份写死的按钮文案） */
export const TAG_LEVELS = {
  1: '避开',
  2: '谨慎',
  3: '喜欢',
  4: '本命',
} as const;

export interface TagStat {
  /** 标签原文（与 `video_tag.tags` 数组里的字符串**逐字相同**，⛔ 不归一化） */
  tag: string;
  /** 关联视频数（同一 vid 只算一次） */
  n: number;
}

export interface TagMarkView {
  /** 全库标签清单（按关联视频数降序）—— 设置面板直接铺这个 */
  tags: TagStat[];
  /** 当前档位：只含 level>0 的（§153 四档 1/2/3/4） */
  marks: Record<string, 1 | 2 | 3 | 4>;
  /** 标签种类数 */
  total: number;
}

export class TagMark {
  constructor(private db: DB) {}

  /** 表存在吗（线上可能还没跑建表；缺失时全部降级为空） */
  private hasTable(): boolean {
    try {
      return Boolean(
        this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tag_mark'`)
          .get(),
      );
    } catch {
      return false;
    }
  }

  /** 当前档位（level>0，§153 四档 1/2/3/4） */
  marks(): Record<string, 1 | 2 | 3 | 4> {
    const out: Record<string, 1 | 2 | 3 | 4> = {};
    if (!this.hasTable()) return out;
    try {
      const rows = this.db
        .prepare(`SELECT tag, level FROM tag_mark WHERE level IN (1,2,3,4)`)
        .all() as Array<{ tag: string; level: number }>;
      for (const r of rows) {
        const lv = Number(r.level);
        if (lv === 1 || lv === 2 || lv === 3 || lv === 4) out[String(r.tag)] = lv as 1 | 2 | 3 | 4;
      }
    } catch {
      // 读失败 ⇒ 当作没标记（降级不崩）
    }
    return out;
  }

  /**
   * 全库标签清单 + 频次 + 当前档位（设置面板的一次性数据源）。
   *
   * ⚠️ 频次用 `COUNT(DISTINCT vt.vid)` —— 同一个视频在 JSON 数组里理论上不会重复，
   *    但脏数据里出现过，⛔ 不去重会把次数虚高（用户按次数排序就会觉得数据不对）。
   */
  view(): TagMarkView {
    const marks = this.marks();
    const tags: TagStat[] = [];
    try {
      const hasVt = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='video_tag'`)
        .get();
      if (hasVt) {
        const rows = this.db
          .prepare(
            `SELECT CAST(j.value AS TEXT) AS tag, COUNT(DISTINCT vt.vid) AS n
               FROM video_tag vt, json_each(vt.tags) j
              WHERE vt.tags IS NOT NULL AND json_valid(vt.tags)
              GROUP BY 1
              ORDER BY n DESC, tag ASC`,
          )
          .all() as Array<{ tag: string; n: number }>;
        for (const r of rows) {
          const t = String(r.tag ?? '').trim();
          if (!t) continue;
          tags.push({ tag: t, n: Number(r.n) || 0 });
        }
      }
    } catch {
      // 脏 JSON / 表缺失 ⇒ 返回空清单（面板显示「还没有标签数据」）
    }
    return { tags, marks, total: tags.length };
  }

  /** 设置/取消一个标签的档位。level=0 表示取消（⛔ 不 DELETE 行，留审计）。 */
  set(tag: string, level: TagLevel): boolean {
    const t = String(tag ?? '').trim();
    if (!t) throw new Error('tag 不能为空');
    if (![0, 1, 2, 3, 4].includes(level)) throw new Error('level 只能是 0/1/2/3/4');
    if (!this.hasTable()) throw new Error('tag_mark 表不存在（还没建表）');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tag_mark (tag, level, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(tag) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      )
      .run(t, level, now);
    return true;
  }

  /**
   * 作品级命中：`work_id → { l1: [...], l2: [...], l3: [...], l4: [...] }`
   * （§153：1 避开 / 2 谨慎 / 3 喜欢 / 4 本命）
   *
   * 🔴 只在**有标记时**才跑那条大 JOIN（全库 1500 源 × 3549 vid × 65765 关联）。
   *    没有标记时（绝大多数情况）直接返回空对象 —— 海报墙每次刷新都调，不能白算。
   * ⚠️ 一条源条目可能挂多个 vid（一个 src_key 一个 vid，本库是一对一，但别假设）。
   */
  workHits(): Record<number, { l1: string[]; l2: string[]; l3: string[]; l4: string[] }> {
    const marks = this.marks();
    const markTags = Object.keys(marks);
    const out: Record<number, { l1: string[]; l2: string[]; l3: string[]; l4: string[] }> = {};
    if (!markTags.length) return out;
    if (!this.hasTable()) return out;

    // 缓存键 = 标记的「指纹」：标签数 + 最大更新时间。改了任何一格就会变。
    const fp = (() => {
      try {
        const r = this.db
          .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS t FROM tag_mark WHERE level IN (1,2,3,4)`)
          .get() as { n: number; t: string } | undefined;
        return `${r?.n ?? 0}|${r?.t ?? ''}`;
      } catch {
        return '';
      }
    })();
    if (this.cache && this.cache.fp === fp) return this.cache.hits;

    try {
      const ph = markTags.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT DISTINCT sw.work_id AS wid, CAST(jt.value AS TEXT) AS tag
             FROM source_work sw,
                  json_each(CASE WHEN json_valid(sw.entry_detail)
                                 THEN sw.entry_detail ELSE '[]' END) je,
                  video_tag vt,
                  json_each(vt.tags) jt
            WHERE sw.src = 'hanime'
              AND vt.vid = CAST(json_extract(je.value, '$.vid') AS TEXT)
              AND vt.tags IS NOT NULL AND json_valid(vt.tags)
              AND CAST(jt.value AS TEXT) IN (${ph})`,
        )
        .all(...markTags) as Array<{ wid: number; tag: string }>;
      for (const r of rows) {
        const wid = Number(r.wid);
        if (!Number.isFinite(wid)) continue;
        const tag = String(r.tag);
        const lv = marks[tag];
        if (!lv) continue;
        const bucket = (out[wid] ||= { l1: [], l2: [], l3: [], l4: [] });
        const arr = lv === 1 ? bucket.l1 : lv === 2 ? bucket.l2 : lv === 3 ? bucket.l3 : bucket.l4;
        if (!arr.includes(tag)) arr.push(tag);
      }
      // 稳定输出顺序：按标签在源站的原始顺序不做保证（并集无顺序语义）⇒ 按名称排，
      // 前端只画前两个 + `+N`，顺序固定才不会每次刷新跳来跳去。
      for (const v of Object.values(out)) {
        v.l1.sort(); v.l2.sort(); v.l3.sort(); v.l4.sort();
      }
    } catch {
      // JOIN 失败（老库结构差异）⇒ 空标记，⛔ 不影响看板其它列
    }
    this.cache = { fp, hits: out };
    return out;
  }

  private cache: {
    fp: string;
    hits: Record<number, { l1: string[]; l2: string[]; l3: string[]; l4: string[] }>;
  } | null = null;
}
