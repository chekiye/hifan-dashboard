/**
 * 人工绑定 API（2026-11-01 §124）
 *
 * 作者：「再加一个未匹配的筛选，我直接筛选未匹配，然后人工把未匹配的匹配上，
 *   我们这个全量名单就完整了」
 *
 * ## 三个接口
 * | 接口 | 干什么 | 需不需要 TMDB 网络 |
 * |---|---|---|
 * | `GET  /api/manual_bind` | 列出生效中的人工绑定（前端回显） | 否 |
 * | `GET  /api/manual_bind/candidates` | **库内**候选（按作品名/番号模糊） | 否 |
 * | `GET  /api/manual_bind/tmdb_search` | **TMDB 线上**候选（库里没有时去查） | 是 |
 * | `POST /api/manual_bind` | 写一条人工绑定 | 否 |
 * | `POST /api/manual_bind/revoke` | 作废一条（⛔ 不 DELETE，留审计） | 否 |
 *
 * ## ⛔ 为什么要「库内候选」和「TMDB 候选」两路
 * 71 条未匹配里有两类：
 *  · `L2 无候选` —— 库内**根本没有**这部作品 ⇒ 必须去 TMDB 查（还得先建 tmdb_work）
 *  · `L2 多候选` —— 库内**有**这部作品，只是名字撞了几个 ⇒ 直接在库内挑一个即可
 * ⇒ 只给 TMDB 搜索会让「多候选」这类最常见的场景绕远路。
 *
 * 🔴 TMDB 搜索只返回**候选**（id + 名字），⛔ 不自动建库 —— 建库要人工确认后
 *    走既有的建库链路，不能由一个搜索接口偷偷插 tmdb_work。
 */
import type { FastifyInstance } from 'fastify';
import type { DB } from '@hifan/core';
import { ManualBindService } from './manual_bind.js';

export interface ManualBindApiOptions {
  db: DB;
  /** TMDB 搜索回调（可为 null —— 没配 key 时降级成「只能从库里挑」） */
  tmdbSearch?: ((query: string, mediaType: 'tv' | 'movie') => Promise<unknown[]>) | null;
}

interface CandidateRow {
  id: number;
  name: string;
  nameOriginal: string | null;
  year: number | null;
  mediaType: string;
  episodeTotal: number | null;
  seasonCount: number | null;
}

export function registerManualBindApi(app: FastifyInstance, opts: ManualBindApiOptions): void {
  const { db } = opts;
  const svc = new ManualBindService(db);

  /** 生效中的人工绑定 */
  app.get('/api/manual_bind', async () => {
    const rows = svc.list();
    return { ok: true, count: rows.length, binds: rows };
  });

  /** 全部历史（含改绑/作废）—— 审计用 */
  app.get('/api/manual_bind/history', async () => {
    const rows = svc.history();
    return { ok: true, count: rows.length, binds: rows };
  });

  /**
   * 库内候选：按「作品名 / 番号 / id」模糊找 `tmdb_work`。
   *
   * ⛔ 只读库内已有的作品 —— 前端「选一个已有作品」走这条，**不碰 TMDB 网络**。
   */
  app.get('/api/manual_bind/candidates', async (req, reply) => {
    const q = String((req.query as Record<string, string>)?.q ?? '').trim();
    const mt = (req.query as Record<string, string>)?.media ?? 'tv';
    const mediaType = mt === 'movie' ? 'movie' : 'tv';

    if (!q) {
      return reply.code(400).send({ ok: false, error: 'q 不能为空' });
    }
    const lim = Math.min(Number((req.query as Record<string, string>)?.limit) || 20, 50);

    // 数字 id 直接精确查 —— 人工最常干的事就是「我知道 id，直接填」
    if (/^\d+$/.test(q)) {
      const rows = db
        .prepare(
          `SELECT id, COALESCE(name_zh, name_original) AS name,
                  name_original AS nameOriginal, year, media_type,
                  episode_total, season_count
             FROM tmdb_work WHERE id = ?`,
        )
        .all(Number(q)) as unknown as CandidateRow[];
      return { ok: true, source: 'db', count: rows.length, candidates: rows };
    }

    // 文本：作品名（中/日/原名）+ 源侧番号都能命中
    // 🔴⚠️ 必须**同时查 name_zh 与 name_original**（各自 LIKE 一次），
    //    ⛔ 不能只查 COALESCE(name_zh, name_original) ——
    //    实测「特別授業」的 name_zh 是「特別授課」、name_original 才是「特別授業」，
    //    只查前者 ⇒ 搜日文原名 0 条（作者明明知道这部片，候选却是空的）。
    //
    // 🔴🔴 ESCAPE 用 **`!`** 而不是反斜杠：SQLite 里 `'\'` 会被当转义单引号处理
    //    ⇒ ESCAPE 表达式不是单字符 ⇒ 直接报 "ESCAPE expression must be a single character"
    //    或整条查询静默失效（实测搜「特別授業」返回 0 条就是这个）。
    const like = `%${q.replace(/[%_!]/g, (m) => '!' + m)}%`;
    const rows = db
      .prepare(
        `SELECT DISTINCT w.id AS id,
                COALESCE(w.name_zh, w.name_original) AS name,
                w.name_original AS nameOriginal, w.year, w.media_type,
                w.episode_total, w.season_count
           FROM tmdb_work w
           LEFT JOIN source_work s ON s.work_id = w.id AND s.media_type = w.media_type
          WHERE w.media_type = ?
            AND (COALESCE(w.name_zh, '') LIKE ? ESCAPE '!'
              OR COALESCE(w.name_original, '') LIKE ? ESCAPE '!'
              OR COALESCE(s.src_key, '') LIKE ? ESCAPE '!'
              OR COALESCE(s.title, '') LIKE ? ESCAPE '!'
              OR COALESCE(s.work_ja, '') LIKE ? ESCAPE '!')
          ORDER BY w.year DESC NULLS LAST, w.id DESC
          LIMIT ?`,
      )
      .all(mediaType, like, like, like, like, like, lim) as unknown as CandidateRow[];

    return { ok: true, source: 'db', count: rows.length, candidates: rows };
  });

  /**
   * TMDB 线上候选 —— 库里没有这部作品时用。
   *
   * ⛔ 只读 TMDB，⛔ 不写库。返回 id / 名字 / 年份 / 集数，供人工挑。
   */
  app.get('/api/manual_bind/tmdb_search', async (req, reply) => {
    const q = String((req.query as Record<string, string>)?.q ?? '').trim();
    const mt = (req.query as Record<string, string>)?.media ?? 'tv';
    const mediaType = mt === 'movie' ? 'movie' : 'tv';

    if (!q) return reply.code(400).send({ ok: false, error: 'q 不能为空' });
    if (!opts.tmdbSearch) {
      return reply.code(501).send({
        ok: false,
        error: '服务端没配 TMDB 客户端 —— 只能从库内已有作品里挑',
      });
    }
    try {
      const raw = await opts.tmdbSearch(q, mediaType);
      const candidates = (Array.isArray(raw) ? raw : []).slice(0, 20).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const id = Number(o.id);
        return {
          id: Number.isFinite(id) ? id : 0,
          name: String(o.name ?? o.original_name ?? ''),
          originalName: String(o.original_name ?? ''),
          year: Number(o.first_air_date ?? o.release_date ?? 0) || null,
          mediaType,
          overview: String(o.overview ?? '').slice(0, 200),
        };
      });
      return { ok: true, source: 'tmdb', count: candidates.length, candidates };
    } catch (err) {
      // ⭐ §124b：代理不通时 raw error 是 "fetch failed" —— 作者看不懂，
      //   也不知道「搜 TMDB」这条路是不是坏了。翻译成人话 + 给出可行的下一步。
      const raw = err instanceof Error ? err.message : String(err);
      const netFail = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket/i.test(raw);
      return reply.code(502).send({
        ok: false,
        error: netFail
          ? '连不上 TMDB（代理或网络不通）。库里已有的作品用「搜库内」照样能绑 —— ' +
            '库里没有的那几部，等代理恢复后再补。'
          : `TMDB 搜索失败：${raw}`,
        raw,
      });
    }
  });

  /** 写一条人工绑定 */
  app.post('/api/manual_bind', async (req, reply) => {
    const b = (req.body ?? {}) as {
      src?: string;
      src_key?: string;
      work_id?: number;
      media_type?: string;
      season?: number | null;
      episode?: number | null;
      file_name?: string | null;
      note?: string | null;
      by?: string;
    };
    try {
      const r = svc.bind({
        src: b.src,
        srcKey: b.src_key ?? '',
        workId: Number(b.work_id),
        mediaType: b.media_type,
        season: b.season,
        episode: b.episode,
        fileName: b.file_name,
        note: b.note,
        by: b.by,
      });
      return { ok: true, replaced: r.replaced, bind: r.row };
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** 作废一条人工绑定（⛔ 不 DELETE，留审计） */
  app.post('/api/manual_bind/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as { src?: string; src_key?: string };
    const src = (b.src || 'mteam').trim();
    const key = ManualBindService.normalizeKey(b.src_key);
    if (!key) return reply.code(400).send({ ok: false, error: 'src_key 不能为空' });
    const ok = svc.revoke(src, key);
    return { ok, action: ok ? 'revoked' : 'noop', src, src_key: key };
  });
}
