/**
 * 双通道采集器
 *
 * 通道 A · keyword 枚举：discover + with_keywords=hentai(198385)
 *   实测产出 1284 部（TV 1189 + MOVIE 95），2000–2026 全年份
 *
 * 通道 B · 已知 id 回补：把「本地库里已有但池内没有」的 tmdbid 逐个拉详情
 *   起因：实测漏检作品的 /tv/{id}/keywords 返回空数组
 *   → TMDB 里番标注靠人工运气，discover 注定抓不全，必须用本地已知 id 兜底
 *
 * 两条通道的结果合并去重后写入 tmdb_work，
 * source_channel 字段记录来源（keyword / local_seed / manual）。
 */
import type { DB } from '@hifan/core';
import type { TmdbClient } from './client.js';
import { pickChineseName } from './client.js';

export interface CollectOptions {
  /** 只采集这一条通道 */
  channel: 'keyword' | 'seed';
  /** 年份下限（实测 2000 起点） */
  yearFrom: number;
  /** hentai keyword id */
  keywordId: number;
  /** 是否拉季集元数据（较慢，约 1459 × 2 请求） */
  withEpisodes: boolean;
  /** 进度回调 */
  onProgress?: (p: Progress) => void;
}

export interface Progress {
  channel: 'keyword' | 'seed';
  phase: 'discover' | 'detail' | 'episodes' | 'done';
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  /** 最近一条错误信息（用于界面显示） */
  lastError?: string;
}

const JOB = {
  keyword: 'collect_keyword',
  seed: 'collect_seed',
} as const;

export class Collector {
  /** 🔴 因首播日期在未来而被跳过的作品（`mediaType/id`）—— 供调用方记日志/汇报 */
  readonly futureSkipped: string[] = [];

  constructor(
    private readonly db: DB,
    private readonly client: TmdbClient,
  ) {}

  // ── job_state 断点续跑 ───────────────────────────────────────

  private setJob(job: string, patch: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const keys = Object.keys(patch);
    const vals = keys.map((k) => patch[k]);

    const exists = this.db
      .prepare('SELECT job_name FROM job_state WHERE job_name = ?')
      .get(job) as { job_name: string } | undefined;

    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO job_state (job_name, status, processed, succeeded, failed, updated_at)
           VALUES (?, 'running', 0, 0, 0, ?)`,
        )
        .run(job, now);
      return;
    }

    this.db
      .prepare(
        `UPDATE job_state SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE job_name = ?`,
      )
      .run(...vals, now, job);
  }

  private getJob(job: string): { status: string; cursor: string | null; processed: number } | undefined {
    return this.db
      .prepare('SELECT status, cursor, processed FROM job_state WHERE job_name = ?')
      .get(job) as { status: string; cursor: string | null; processed: number } | undefined;
  }

  // ── 写入 ─────────────────────────────────────────────────────

  /**
   * 🔴 取中文名 —— **委托给 `pickChineseName()`，判据只有一份**（0lx）。
   *
   * 判据：含汉字 + 不含假名才算中文译名。
   * 反例（都会返回 null，⛔ 不写进 name_zh）：
   *   `Deco x Deco` / `Hamehara` / `Muchuu no Tou` / `69`
   *   `お嬢様はHがお好き`（有汉字「嬢様」但是日文原名）
   */
  private static cnNameOnly(v: unknown): string | null {
    return pickChineseName(v);
  }


  /**
   * upsert 一部作品
   *
   * channel 优先级：manual > local_seed > keyword
   * （同一作品被多通道发现时，保留更强的来源标记，便于评估通道价值）
   */
  private upsertWork(
    mediaType: 'tv' | 'movie',
    d: Record<string, unknown>,
    channel: 'keyword' | 'local_seed' | 'manual',
  ): void {
    const id = Number(d.id);
    if (!Number.isFinite(id)) return;

    const date =
      (d.first_air_date as string) ?? (d.release_date as string) ?? '';
    const year = date.slice(0, 4) ? Number(date.slice(0, 4)) : null;

    /* 🔴🔴 闸门：**首播日期晚于今天 ⇒ 直接不入库**
     *
     * 实证（2026-10-28 作者指出）：库里出现 `賢者タイムのスッキリ人妻冒険記` /
     * `ママぼっくい` 两部首播 2027-01-29 的作品，而 **hanime 侧一行都没有**。
     * 资源还没出的东西进看板 = 纯噪声，用户会以为库里真有这些番。
     *
     * ⚠️ 只拦「未来日期」，⛔ 不拦「日期为空」（TMDB 常有未填日期的条目，
     *    拦了会误杀一大批正常作品）。
     */
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const today = new Date().toISOString().slice(0, 10);
      if (date > today) {
        if (!this.futureSkipped.includes(`${mediaType}/${id}`)) {
          this.futureSkipped.push(`${mediaType}/${id}`);
        }
        return;
      }
    }

    const genres = Array.isArray(d.genre_ids)
      ? JSON.stringify((d.genre_ids as number[]))
      : JSON.stringify([]);

    const existing = this.db
      .prepare('SELECT source_channel FROM tmdb_work WHERE media_type = ? AND id = ?')
      .get(mediaType, id) as { source_channel: string } | undefined;

    const PRIORITY = { manual: 3, local_seed: 2, keyword: 1 } as const;
    const finalChannel =
      existing && PRIORITY[existing.source_channel as keyof typeof PRIORITY] > PRIORITY[channel]
        ? existing.source_channel
        : channel;

    // ⚠️ 这里用「先 UPDATE 后 INSERT」而非 UPSERT：
    //   tmdb_work 的 id 是 INTEGER PRIMARY KEY，同时又有 UNIQUE(media_type, id)；
    //   SQLite 对这种「主键 + 复合唯一」组合的 ON CONFLICT(media_type, id) 解析失败：
    //     ERR_SQLITE_ERROR: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
    //   （实测 2026-10-13 首次跑采集即触发）
    //   分两步写行为明确、可读，且完全避免方言差异。
    const updated = this.db
      .prepare(
        `UPDATE tmdb_work SET
           name_original  = ?,
           name_zh        = COALESCE(?, name_zh),
           first_air_date = ?,
           year           = ?,
           popularity     = ?,
           adult          = ?,
           genres         = ?,
           source_channel = ?,
           fetched_at     = ?,
           overview       = COALESCE(?, overview)
         WHERE media_type = ? AND id = ?`,
      )
      .run(
        (d.original_name as string) ?? (d.original_title as string) ?? null,
        Collector.cnNameOnly((d.name as string) ?? (d.title as string)),
        date || null,
        year,
        typeof d.popularity === 'number' ? d.popularity : null,
        d.adult ? 1 : 0,
        genres,
        finalChannel,
        new Date().toISOString(),
        /* 🔴🔴 2026-10-31：作品级简介（TMDB /tv/{id}、/movie/{id} 的 overview）
           以前**拿���了却没落库** ⇒ 看板只能退回取集级简介，而这批作品的
           集级简介在 TMDB 上**真的是空的** ⇒ 855/1635 部误报「TMDB 无简介」。
           ⚠️ 用 COALESCE(?, overview)：本次请求没带简介时**不覆盖**已有值
              （避免用空值把之前回填好的中文简介抹掉）。 */
        (typeof d.overview === 'string' && d.overview.trim() ? d.overview : null),
        mediaType,
        id,
      );

    // UPDATE 未命中 → 插入
    if (updated.changes === 0) {
      this.db
        .prepare(
          `INSERT INTO tmdb_work
             (id, media_type, name_original, name_zh, first_air_date, year,
              episode_total, season_count, popularity, adult, genres,
              source_channel, fetched_at, poster_path, backdrop_path, logo_path,
              overview)
           VALUES (?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          mediaType,
          (d.original_name as string) ?? (d.original_title as string) ?? null,
          Collector.cnNameOnly((d.name as string) ?? (d.title as string)),
          date || null,
          year,
          typeof d.popularity === 'number' ? d.popularity : null,
          d.adult ? 1 : 0,
          genres,
          finalChannel,
          new Date().toISOString(),
          (d.poster_path as string) ?? null,
          (d.backdrop_path as string) ?? null,
          (d.logo_path as string) ?? null,
          /* 🔴 2026-10-31：作品级简介（详见上面 UPDATE 处的说明） */
          (typeof d.overview === 'string' && d.overview.trim() ? d.overview : null),
        );
    } else {
      // 已存在时补齐图片路径（首次采集时可能没有，拉详情后才拿到）
      this.db
        .prepare(
          `UPDATE tmdb_work SET
             poster_path  = COALESCE(?, poster_path),
             backdrop_path= COALESCE(?, backdrop_path),
             logo_path    = COALESCE(?, logo_path)
           WHERE media_type = ? AND id = ?`,
        )
        .run(
          (d.poster_path as string) ?? null,
          (d.backdrop_path as string) ?? null,
          (d.logo_path as string) ?? null,
          mediaType,
          id,
        );
    }
  }

  /** 写入某部作品的季集元数据 */
  /**
   * 🔴 强制重拉某个作品的季集元数据（§79 兜底维护用）。
   *
   * `fillEpisodes` 只补 `season_count = 0` 的作品（从没拉过的），
   * 但「hanime 出了新集、TMDB 也补了」这种情况，`season_count` 早就非 0 ⇒ 永远补不到。
   * ⇒ 需要一个「不管补没补过，重拉一遍」的入口。
   *
   * ⚠️ 每次调用 = 1 次 seasonsOf + N 次 season detail 请求 ⇒ 调用方必须限流/限量。
   */
  async refetchEpisodes(mediaType: 'tv' | 'movie', id: number): Promise<number> {
    return this.upsertEpisodes(mediaType, id);
  }

  private async upsertEpisodes(
    mediaType: 'tv' | 'movie',
    id: number,
  ): Promise<number> {
    const seasons = await this.client.seasonsOf(mediaType, id);
    let epCount = 0;
    let seasonCount = 0;

    const findEp = this.db.prepare(
      'SELECT work_id FROM tmdb_episode WHERE work_id = ? AND season = ? AND episode = ?',
    );
    const updateEp = this.db.prepare(
      `UPDATE tmdb_episode SET
         ep_name = ?, air_date = ?, runtime = ?, still_path = ?, overview = ?
       WHERE work_id = ? AND season = ? AND episode = ?`,
    );
    const insertEp = this.db.prepare(
      `INSERT INTO tmdb_episode
         (work_id, season, episode, ep_name, air_date, runtime, still_path, overview)
       VALUES (?,?,?,?,?,?,?,?)`,
    );

    for (const s of seasons) {
      seasonCount++;
      for (const e of s.episodes) {
        if (!e.episode) continue;
        // 同上：主键复合 upsert 在 SQLite 上不可靠，先查后写
        if (findEp.get(id, s.season, e.episode)) {
          updateEp.run(e.name, e.airDate, e.runtime, e.stillPath, e.overview, id, s.season, e.episode);
        } else {
          insertEp.run(id, s.season, e.episode, e.name, e.airDate, e.runtime, e.stillPath, e.overview);
        }
        epCount++;
      }
    }

    this.db
      .prepare('UPDATE tmdb_work SET episode_total = ?, season_count = ? WHERE media_type = ? AND id = ?')
      .run(epCount, seasonCount, mediaType, id);

    return epCount;
  }

  // ── 通道 A：keyword 枚举 ─────────────────────────────────────

  async collectByKeyword(opts: CollectOptions): Promise<void> {
    const job = JOB.keyword;
    const dateGte = `${opts.yearFrom}-01-01`;
    const prev = this.getJob(job);

    let succeeded = 0;
    let failed = 0;

    this.setJob(job, { status: 'running', started_at: new Date().toISOString() });

    for (const mediaType of ['tv', 'movie'] as const) {
      let page = 1;
      let totalPages = 1;
      let totalResults = 0;
      const seen = new Set<string>();

      // 断点：若上次已跑完某媒体类型，跳过枚举但继续补详情
      const resumeKey = `${mediaType}`;
      const cursor = prev?.cursor;

      if (cursor?.startsWith(resumeKey)) {
        const parts = cursor.split(':');
        page = Number(parts[1] ?? 1);
        totalResults = Number(parts[2] ?? 0);
        totalPages = Number(parts[3] ?? 1);
        console.log(`[collect] 断点续跑：${mediaType} 从第 ${page} 页继续（已处理 ${totalResults}）`);
      }

      while (page <= totalPages) {
        let batch: PagedResultT;
        try {
          batch = await this.client.discoverByKeyword(mediaType, opts.keywordId, dateGte, page);
        } catch (err) {
          console.error(`[collect] ${mediaType} 第 ${page} 页失败：${String(err)}`);
          failed++;
          this.setJob(job, {
            cursor: `${resumeKey}:${page}:${totalResults}:${totalPages}`,
            failed,
            last_error: String(err),
          });
          break;
        }

        totalPages = Math.min(batch.total_pages ?? 1, 1000);
        totalResults = batch.total_results ?? 0;

        for (const item of batch.results ?? []) {
          const key = `${mediaType}:${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          this.upsertWork(mediaType, item, 'keyword');
          succeeded++;
        }

        opts.onProgress?.({
          channel: 'keyword',
          phase: 'discover',
          processed: succeeded + failed,
          total: totalResults,
          succeeded,
          failed,
        });

        // 断点游标
        this.setJob(job, {
          cursor: `${resumeKey}:${page + 1}:${totalResults}:${totalPages}`,
          succeeded,
          failed,
        });

        page++;
      }

      console.log(`[collect] ${mediaType} 枚举完成，共 ${totalResults} 部`);
    }

    this.setJob(job, { status: 'done', cursor: null, succeeded, failed, finished_at: new Date().toISOString() });

    if (opts.withEpisodes) {
      await this.fillEpisodes('keyword', opts);
    }

    opts.onProgress?.({ channel: 'keyword', phase: 'done', processed: succeeded + failed, total: succeeded, succeeded, failed });
  }

  // ── 季集元数据补全 ───────────────────────────────────────────

  /**
   * 为尚未拉过季集的作品补数据
   * channel: 只补该来源的作品，或 'all'
   */
  async fillEpisodes(
    channel: 'keyword' | 'local_seed' | 'all',
    opts: CollectOptions,
  ): Promise<void> {
    const rows = (
      channel === 'all'
        ? this.db
            .prepare('SELECT id, media_type FROM tmdb_work WHERE season_count = 0 ORDER BY id')
            .all()
        : this.db
            .prepare(
              'SELECT id, media_type FROM tmdb_work WHERE season_count = 0 AND source_channel = ? ORDER BY id',
            )
            .all(channel)
    ) as Array<{ id: number; media_type: 'tv' | 'movie' }>;

    console.log(`[collect] 待补季集元数据：${rows.length} 部`);
    let done = 0;
    let failed = 0;

    for (const r of rows) {
      try {
        await this.upsertEpisodes(r.media_type, r.id);
        done++;
      } catch (err) {
        failed++;
        if (failed <= 5) {
          console.error(`[collect] 季集拉取失败 ${r.media_type}/${r.id}: ${String(err)}`);
        }
      }

      if (done % 20 === 0) {
        opts.onProgress?.({
          channel: 'keyword',
          phase: 'episodes',
          processed: done + failed,
          total: rows.length,
          succeeded: done,
          failed,
        });
        console.log(`[collect] 季集进度 ${done + failed}/${rows.length}`);
      }
    }

    console.log(`[collect] 季集元数据完成：成功 ${done}，失败 ${failed}`);
  }

  // ── 通道 B：已知 id 回补 ─────────────────────────────────────

  /**
   * 从 local_work 里取出所有已有 tmdbid，
   * 逐个拉详情补进 tmdb_work（源标记 local_seed）
   *
   * 这一步是「双通道」的关键：它把本地已知但 keyword 池漏掉的作品补回来。
   */
  async collectBySeed(opts: CollectOptions): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tmdb_id FROM local_work
         WHERE tmdb_id IS NOT NULL
           AND tmdb_id NOT IN (SELECT id FROM tmdb_work WHERE media_type = 'tv')
           AND tmdb_id NOT IN (SELECT id FROM tmdb_work WHERE media_type = 'movie')
         ORDER BY tmdb_id`,
      )
      .all() as Array<{ tmdb_id: number }>;

    console.log(`[collect] 通道 B：待回补 ${rows.length} 部（本地有但池内无）`);

    let done = 0;
    let failed = 0;

    for (const r of rows) {
      // 逐个尝试 tv / movie，先 tv 后 movie（实测里番绝大多数在 tv）
      let ok = false;
      for (const mediaType of ['tv', 'movie'] as const) {
        try {
          const d = await this.client.detail(mediaType, r.tmdb_id);
          this.upsertWork(mediaType, d, 'local_seed');
          ok = true;
          if (opts.withEpisodes) {
            try {
              await this.upsertEpisodes(mediaType, r.tmdb_id);
            } catch (e) {
              console.error(`[collect] 回补季集失败 ${mediaType}/${r.tmdb_id}: ${String(e)}`);
            }
          }
          break;
        } catch {
          // 404 换另一种类型重试
        }
      }
      if (ok) done++;
      else failed++;

      if ((done + failed) % 20 === 0) {
        opts.onProgress?.({
          channel: 'seed',
          phase: 'detail',
          processed: done + failed,
          total: rows.length,
          succeeded: done,
          failed,
        });
      }
    }

    this.setJob(JOB.seed, {
      status: 'done',
      processed: rows.length,
      succeeded: done,
      failed,
      finished_at: new Date().toISOString(),
    });

    console.log(`[collect] 通道 B 完成：补回 ${done} 部，失败 ${failed} 部`);
    opts.onProgress?.({
      channel: 'seed',
      phase: 'done',
      processed: rows.length,
      total: rows.length,
      succeeded: done,
      failed,
    });
  }

  /** 已入库作品统计 */
  stats(): Record<string, number> {
    const r = this.db
      .prepare(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(CASE WHEN media_type='tv' THEN 1 ELSE 0 END)      AS tv,
           SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END)   AS movie,
           SUM(CASE WHEN source_channel='keyword' THEN 1 ELSE 0 END)    AS fromKeyword,
           SUM(CASE WHEN source_channel='local_seed' THEN 1 ELSE 0 END) AS fromSeed,
           SUM(CASE WHEN season_count > 0 THEN 1 ELSE 0 END)      AS withSeasons,
           SUM(episode_total)                                     AS totalEpisodes
         FROM tmdb_work`,
      )
      .get() as Record<string, number>;
    return r;
  }
}

interface PagedResultT {
  page: number;
  total_pages: number;
  total_results: number;
  results: Array<Record<string, unknown>>;
}