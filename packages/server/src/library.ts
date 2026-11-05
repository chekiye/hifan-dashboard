/**
 * 全量库 v7 数据 API（三源合一定稿）
 *
 * ⭐ 与 board.ts 完全独立、互不影响：
 *   board.ts      → 读 tmdb_work（1284 部，TMDB 自己收录的池，M2 时代）
 *   library.ts    → 读 library_work（1699 部，三源合一定稿，v7）
 *   两者集合不同、口径不同。**绝不能把 library_work 塞进 tmdb_work**，
 *   也不要把 board.ts 的 SQL 改成读 library_work ——
 *   那会让原看板的「TMDB 收录了多少」变成「三源合了多少」，两个口径都失真。
 *   用户明确要求过：原看板保留，新的用页签切换。
 *
 * 路由前缀 /api/library/*，前端用 /library 页签调用。
 */
import type { DB } from '@hifan/core';

export interface LibWorkBrief {
  id: number;
  mediaType: 'tv' | 'movie';
  nameZh: string | null;
  nameOriginal: string | null;
  year: number | null;
  episodes: number;
  posterPath: string | null;
  sources: string;
  /** ⭐ 证据链 —— 用户口径是「每条必须有二值结论，证据薄弱不可接受」 */
  evidence: string | null;
  typeEvidence: string | null;
  dice: number | null;
  exact: boolean;
  altNames: string | null;
  via: string | null;
  srcTitles: string | null;
}

export interface LibYearBucket {
  year: number;
  total: number;
  tv: number;
  movie: number;
  withPoster: number;
}

export interface LibStats {
  total: number;
  tv: number;
  movie: number;
  withPoster: number;
  noPoster: number;
  totalEpisodes: number;
  withEpisodes: number;
  /** 来源组合分布，如 'mteam+tmdb' */
  bySources: Array<{ sources: string; total: number }>;
  /** 双源交叉（可信度最高的一批） */
  dualSource: number;
  /** 逐字全同命中（alternative_titles 别名与源标题逐字一致） */
  exact: number;
  yearSpan: { from: number; to: number } | null;
  queueTotal: number;
  queueByKind: Array<{ kind: string; total: number; decided: number }>;
}

export class LibraryApi {
  constructor(private readonly db: DB) {}

  /** 全库统计 */
  stats(): LibStats {
    const r = this.db
      .prepare(
        `SELECT COUNT(*)                                                  AS total,
                SUM(CASE WHEN media_type='tv'    THEN 1 ELSE 0 END)       AS tv,
                SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END)       AS movie,
                SUM(CASE WHEN poster_path <> '' AND poster_path IS NOT NULL
                         THEN 1 ELSE 0 END)                               AS withPoster,
                COALESCE(SUM(episodes), 0)                                 AS totalEpisodes,
                SUM(CASE WHEN episodes > 0 THEN 1 ELSE 0 END)              AS withEpisodes,
                SUM(CASE WHEN exact = 1 THEN 1 ELSE 0 END)                AS exact,
                MIN(CASE WHEN year >= 2000 THEN year END)                  AS yearFrom,
                MAX(CASE WHEN year >= 2000 THEN year END)                  AS yearTo
         FROM library_work`,
      )
      .get() as Record<string, number | null>;

    const bySources = this.db
      .prepare(
        `SELECT sources, COUNT(*) AS total
         FROM library_work
         GROUP BY sources
         ORDER BY total DESC`,
      )
      .all() as Array<{ sources: string; total: number }>;

    const queueByKind = this.db
      .prepare(
        `SELECT kind,
                COUNT(*)                                                  AS total,
                SUM(CASE WHEN decided IS NOT NULL AND decided <> '' THEN 1 ELSE 0 END) AS decided
         FROM review_queue
         GROUP BY kind
         ORDER BY total DESC`,
      )
      .all() as Array<{ kind: string; total: number; decided: number }>;

    const total = r.total ?? 0;
    return {
      total,
      tv: r.tv ?? 0,
      movie: r.movie ?? 0,
      withPoster: r.withPoster ?? 0,
      noPoster: total - (r.withPoster ?? 0),
      totalEpisodes: r.totalEpisodes ?? 0,
      withEpisodes: r.withEpisodes ?? 0,
      exact: r.exact ?? 0,
      dualSource: bySources
        .filter((s) => s.sources.includes('+'))
        .reduce((sum, s) => sum + s.total, 0),
      bySources,
      yearSpan: r.yearFrom && r.yearTo ? { from: Number(r.yearFrom), to: Number(r.yearTo) } : null,
      queueTotal: queueByKind.reduce((s, q) => s + q.total, 0),
      queueByKind,
    };
  }

  /** 按年份分桶 —— 与 board.byYear 同口径，但只算 2000+ */
  byYear(): LibYearBucket[] {
    return this.db
      .prepare(
        `SELECT year,
                COUNT(*)                                                    AS total,
                SUM(CASE WHEN media_type='tv'    THEN 1 ELSE 0 END)        AS tv,
                SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END)        AS movie,
                SUM(CASE WHEN poster_path <> '' AND poster_path IS NOT NULL
                         THEN 1 ELSE 0 END)                                AS withPoster
         FROM library_work
         WHERE year >= 2000
         GROUP BY year
         ORDER BY year DESC`,
      )
      .all() as LibYearBucket[];
  }

  /**
   * 作品列表
   * @param year  年份；'0' 或空 = 不限
   * @param media 'tv' | 'movie' | '' = 不限
   * @param limit 分页上限
   * @param offset 偏移
   */
  works(
    opts: { year?: string; media?: string; limit?: number; offset?: number } = {},
  ): { total: number; items: LibWorkBrief[] } {
    /* ⚠️ node:sqlite 的 prepare().all() **不支持** `...args` 位置参数展开
       （实测 ERR_INVALID_STATE: Unknown named parameter '0'），用具名参数。
       ⚠️ 而且**不能传 SQL 里没用到的具名参数** —— 多传一个也会报
       Unknown named parameter。所以 COUNT 与列表两条查询必须各用各的参数集。 */
    const cond: string[] = [];
    const filter: Record<string, string | number> = {};

    const year = opts.year ? Number(opts.year) : 0;
    if (year > 0) { cond.push('year = $year'); filter.year = year; }
    if (opts.media === 'tv' || opts.media === 'movie') {
      cond.push('media_type = $media'); filter.media = opts.media;
    }
    const clause = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM library_work ${clause}`).get(filter) as
        | { n: number }
        | undefined
    )?.n ?? 0;

    const rows = this.db
      .prepare(
        `SELECT tmdb_id, media_type, name_zh, name_original, year, episodes, poster_path,
                sources, evidence, type_evidence, dice, exact, alt_names, via, src_titles
         FROM library_work ${clause}
         ORDER BY year DESC, tmdb_id ASC
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        ...filter,
        limit: Math.min(Math.max(opts.limit ?? 120, 1), 1000),
        offset: Math.max(opts.offset ?? 0, 0),
      }) as Array<Record<string, unknown>>;

    return { total, items: rows.map((r) => this.row2brief(r)) };
  }

  /** 单部详情 —— 含全部官方别名与源标题 */
  detail(mediaType: string, id: number): (LibWorkBrief & { genres?: string }) | null {
    const r = this.db
      .prepare(
        `SELECT tmdb_id, media_type, name_zh, name_original, year, episodes, poster_path,
                sources, evidence, type_evidence, dice, exact, alt_names, via, src_titles
         FROM library_work
         WHERE media_type = ? AND tmdb_id = ?`,
      )
      .get(mediaType, id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.row2brief(r);
  }

  private row2brief(r: Record<string, unknown>): LibWorkBrief {
    return {
      id: Number(r.tmdb_id),
      mediaType: (r.media_type as 'tv' | 'movie') ?? 'tv',
      nameZh: (r.name_zh as string) || null,
      nameOriginal: (r.name_original as string) || null,
      year: r.year ? Number(r.year) : null,
      episodes: Number(r.episodes) || 0,
      posterPath: (r.poster_path as string) || null,
      sources: (r.sources as string) || '',
      evidence: (r.evidence as string) || null,
      typeEvidence: (r.type_evidence as string) || null,
      dice: r.dice != null ? Number(r.dice) : null,
      exact: Number(r.exact) === 1,
      altNames: (r.alt_names as string) || null,
      via: (r.via as string) || null,
      srcTitles: (r.src_titles as string) || null,
    };
  }
}