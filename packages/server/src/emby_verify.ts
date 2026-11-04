/**
 * 人工确认入库服务（2026-10-27 §73 蛙哥）
 *
 * ## 来历
 * 蛙哥：「针对这些我知道都入库了，但系统无法判断的，我手动标记入库没问题，
 *        这种交给我人工判断会好很多」
 *       「人工标记后的效果和 ai 识别无问题的效果一样」
 *
 * ## 与另外两张表的关系（⛔ 三个维度，别混）
 * | | work_hidden | work_checked | work_emby_verified |
 * |---|---|---|---|
 * | 意图 | 不想看 ⇒ 藏起来 | 三方信息核对过 ⇒ 留凭证 | 入库收全了 ⇒ 放行检测 |
 * | 对列表 | **过滤掉** | 照常显示 + ✓ | 照常显示，集数徽章变绿标 |
 * | 对判定 | 无 | 无 | **`embyFull` 变 true** |
 * | 取消字段 | unhidden_at | unchecked_at | revoked_at |
 *
 * ## 设计要点
 * ① 状态存**服务端 DB**，⛔ 不存 localStorage（0gh：只存 localStorage = 假闭环）。
 * ② 取消**不 DELETE**，写 `revoked_at` 留审计（铁律 0）。
 * ③ 表不存在（老库没跑 migration）⇒ 降级成「一部都没确认」，⛔ 绝不让接口 500。
 * ④ **必须存快照**（`snap_eps` / `snap_need`）：否则确认过的部永远是绿的，
 *    日后 Emby 删了集也发现不了 —— 那就是假闭环。
 */
import type { DB } from '@hifan/core';

export interface EmbyVerifyRow {
  tmdb_id: number;
  media_type: string;
  note: string | null;
  verified_by: string;
  verified_at: string;
  revoked_at: string | null;
  snap_eps: number | null;
  snap_need: number | null;
}

/** 前端用的 key 形态：`tv:207840`（tv / movie 的 id 是两个空间，必须带类型） */
export function verifyKey(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export class EmbyVerifyService {
  private _hasTable: boolean | undefined;

  constructor(private readonly db: DB) {}

  /** 表是否存在（懒探测一次）—— 老库没跑 migration 时降级 */
  private get has(): boolean {
    if (this._hasTable === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_emby_verified')`)
          .all() as Array<{ name: string }>;
        this._hasTable = rows.length > 0;
      } catch {
        this._hasTable = false;
      }
    }
    return this._hasTable;
  }

  /** 当前生效的确认（`revoked_at IS NULL`） */
  private activeWhere(): string {
    return `revoked_at IS NULL`;
  }

  /** 所有生效确认的 key 集合（`tv:207840`） */
  keys(): Set<string> {
    if (!this.has) return new Set();
    const rows = this.db
      .prepare(`SELECT media_type, tmdb_id FROM work_emby_verified WHERE ${this.activeWhere()}`)
      .all() as Array<{ media_type: string; tmdb_id: number }>;
    return new Set(rows.map((r) => verifyKey(r.media_type, Number(r.tmdb_id))));
  }

  /**
   * 确认清单（附作品名/年份，省前端一次回查）
   * 🔴 先查列再写 SQL：`tmdb_work` 的中文名列是 `name_zh`（0at 的教训）。
   */
  list(opts: { includeRevoked?: boolean } = {}): Array<
    EmbyVerifyRow & { nameZh: string | null; year: number | null }
  > {
    if (!this.has) return [];
    const cond = opts.includeRevoked ? '' : `WHERE v.${this.activeWhere()}`;
    return this.db
      .prepare(
        `SELECT v.tmdb_id, v.media_type, v.note, v.verified_by, v.verified_at,
                v.revoked_at, v.snap_eps, v.snap_need,
                COALESCE(w.name_zh, w.name_original) AS nameZh,
                w.year AS year
           FROM work_emby_verified v
           LEFT JOIN tmdb_work w
                  ON w.id = v.tmdb_id AND w.media_type = v.media_type
           ${cond}
           ORDER BY v.verified_at DESC`,
      )
      .all() as never;
  }

  /**
   * 标记「已全集入库」（幂等：已确认过的只更新快照与备注）
   *
   * `snapEps` / `snapNeed` 由调用方传入**当前界面看到的数字** ——
   * 语义就是「你点头的时候看到的是 8 / 10」，不是事后回查。
   * 传 null 表示这次拿不到数字（旧接口）⇒ 日后不做过期校验，⛔ 不编造。
   */
  verify(
    tmdbId: number,
    mediaType: string,
    opts: { note?: string; by?: string; snapEps?: number | null; snapNeed?: number | null } = {},
  ): { ok: boolean; isNew: boolean } {
    if (!this.has) throw new Error('work_emby_verified 表不存在（migration 未跑）');
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error('tmdb_id 非法');
    if (mediaType !== 'tv' && mediaType !== 'movie') throw new Error('media_type 非法');

    const now = new Date().toISOString();
    const by = opts.by ?? 'wa';
    const note = opts.note ?? null;
    const se = opts.snapEps == null ? null : Number(opts.snapEps);
    const sn = opts.snapNeed == null ? null : Number(opts.snapNeed);

    const existing = this.db
      .prepare(
        `SELECT tmdb_id FROM work_emby_verified
          WHERE media_type = ? AND tmdb_id = ? AND ${this.activeWhere()}`,
      )
      .get(mediaType, tmdbId) as { tmdb_id: number } | undefined;

    // 无论是首次还是复活，都走同一条 UPSERT —— 避免两条路径写出不同字段集
    this.db
      .prepare(
        `INSERT INTO work_emby_verified
           (tmdb_id, media_type, note, verified_by, verified_at, revoked_at, snap_eps, snap_need)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
           note        = excluded.note,
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           revoked_at  = NULL,
           snap_eps    = excluded.snap_eps,
           snap_need   = excluded.snap_need`,
      )
      .run(tmdbId, mediaType, note, by, now, se, sn);

    return { ok: true, isNew: !existing };
  }

  /** 取消确认 —— ⛔ 不 DELETE，写 revoked_at 留审计 */
  revoke(tmdbId: number, mediaType: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_emby_verified SET revoked_at = ?
          WHERE media_type = ? AND tmdb_id = ? AND ${this.activeWhere()}`,
      )
      .run(new Date().toISOString(), mediaType, tmdbId);
    return Number(r.changes) > 0;
  }

  /** 统计（首页角标 / 拆分显示用） */
  stats(): { verified: number; total: number; hasTable: boolean } {
    if (!this.has) return { verified: 0, total: 0, hasTable: false };
    let verified = 0;
    let total = 0;
    try {
      const v = this.db
        .prepare(`SELECT COUNT(*) AS n FROM work_emby_verified WHERE ${this.activeWhere()}`)
        .get() as { n: number } | undefined;
      verified = Number(v?.n ?? 0);
      const t = this.db
        .prepare(`SELECT COUNT(*) AS n FROM tmdb_work WHERE is_quarantined = 0`)
        .get() as { n: number } | undefined;
      total = Number(t?.n ?? 0);
    } catch {
      /* 降级：返回 0，⛔ 不让接口 500 */
    }
    return { verified, total, hasTable: true };
  }
}
