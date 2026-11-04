/**
 * 喜欢 / 待下 / 订阅 服务（2026-10-28 §80 蛙哥）
 *
 * ## 来历
 * 蛙哥：「再加一个喜欢（待下，订阅）功能就是我点一下，这一部进入一个待下状态，
 *        空了我去补下载+入库。这功能也要做批量，我可以批量选择喜欢的片」
 *
 * ## 与另外三张表的关系（⛔ 四个维度，别混）
 * | | work_hidden | work_checked | work_emby_verified | work_want |
 * |---|---|---|---|---|
 * | 意图 | 不想看⇒藏起来 | 三方信息核对过 | 入库收全了 | 我想收⇒待下 |
 * | 对列表 | 过滤掉 | 照常显示+✓ | 照常显示，徽章变绿 | 照常显示+♥ |
 * | 对判定 | 无 | 无 | `embyFull` 变 true | 无（纯标记） |
 * | 取消 | unhidden_at | unchecked_at | revoked_at | revoked_at |
 *
 * ## 三态（一张表 + 时间戳，⛔ 不 DELETE —— 铁律 0）
 *   ① want_at 有值 / done_at NULL / revoked_at NULL  → **待下中**
 *   ② done_at 有值                                   → **已收**（仍留在清单，可回看）
 *   ③ revoked_at 有值                                → **出局**（审计仍在）
 *
 * ## 设计要点
 * ① 状态存服务端 DB，⛔ 不存 localStorage（0gh：只存 localStorage = 假闭环）。
 * ② 表不存在（老库没跑 migration）⇒ 降级成「一部都没喜欢」，⛔ 绝不让接口 500。
 * ③ 批量走**一条 SQL 事务**，⛔ 不逐部 toggle（N 部 = N 次往返）。
 * ④ `done_at` 可被**扫 Emby 自动闭环**（见 index.ts `/api/emby/scan`）——
 *    判据是「加入时的快照 + 当前 Emby 已收全集」，⛔ 不是「Emby 里有这部」。
 */
import type { DB } from '@hifan/core';

export type WantState = 'want' | 'done' | 'revoked';

export interface WantRow {
  media_type: string;
  tmdb_id: number;
  note: string | null;
  want_by: string;
  want_at: string;
  done_at: string | null;
  revoked_at: string | null;
  snap_eps: number | null;
  snap_need: number | null;
}

/** 前端 / 接口统一 key 形态：`tv:207840`（tv / movie 的 id 是两个空间，必须带类型） */
export function wantKey(mediaType: string, tmdbId: number | string): string {
  return `${mediaType}:${tmdbId}`;
}

/** `tv:207840` → `{ mediaType:'tv', tmdbId:207840 }`；坏 key 返回 null（⛔ 不抛） */
export function parseWantKey(key: string): { mediaType: string; tmdbId: number } | null {
  const i = String(key ?? '').indexOf(':');
  if (i <= 0) return null;
  const mt = key.slice(0, i);
  const id = Number(key.slice(i + 1));
  if (mt !== 'tv' && mt !== 'movie') return null;
  if (!Number.isFinite(id) || id <= 0) return null;
  return { mediaType: mt, tmdbId: Math.trunc(id) };
}

export class WantService {
  private _hasTable: boolean | undefined;

  constructor(private readonly db: DB) {}

  /** 表是否存在（懒探测一次）—— 老库没跑 migration 时降级 */
  private get has(): boolean {
    if (this._hasTable === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_want')`)
          .all() as Array<{ name: string }>;
        this._hasTable = rows.length > 0;
      } catch {
        this._hasTable = false;
      }
    }
    return this._hasTable;
  }

  /**
   * `ep_media` 表在不在（2026-11-01 迁移 #23）。
   * 老库没跑 migration ⇒ 待下清单不带画质汇总，⛔ 不能让接口 500。
   */
  private _hasEpMedia: boolean | undefined;
  private get hasEpMedia(): boolean {
    if (this._hasEpMedia === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ep_media'`)
          .all() as Array<{ name: string }>;
        this._hasEpMedia = t.length > 0;
      } catch {
        this._hasEpMedia = false;
      }
    }
    return this._hasEpMedia;
  }

  /** 生效 = 没被撤销 */
  private activeWhere(): string {
    return `revoked_at IS NULL`;
  }

  /** 所有生效的待下（含已收）key 集合 —— 前端卡片画 ♥ 用 */
  keys(opts: { pendingOnly?: boolean } = {}): Set<string> {
    if (!this.has) return new Set();
    const cond = opts.pendingOnly ? ` AND done_at IS NULL` : '';
    const rows = this.db
      .prepare(`SELECT media_type, tmdb_id FROM work_want WHERE ${this.activeWhere()}${cond}`)
      .all() as Array<{ media_type: string; tmdb_id: number }>;
    return new Set(rows.map((r) => wantKey(r.media_type, Number(r.tmdb_id))));
  }

  /** 「已收」的 key 集合（卡片画成绿色♥、清单里划线）—— 与 keys() 同源同口径 */
  doneKeys(): Set<string> {
    if (!this.has) return new Set();
    const rows = this.db
      .prepare(
        `SELECT media_type, tmdb_id FROM work_want
          WHERE ${this.activeWhere()} AND done_at IS NOT NULL`,
      )
      .all() as Array<{ media_type: string; tmdb_id: number }>;
    return new Set(rows.map((r) => wantKey(r.media_type, Number(r.tmdb_id))));
  }

  /**
   * 待下清单（附作品名/年份/封面，省前端一次回查）
   * 🔴 先查列再写 SQL：`tmdb_work` 的中文名列是 `name_zh`（0at 的教训）。
   */
  list(
    opts: { includeDone?: boolean; includeRevoked?: boolean; pendingOnly?: boolean } = {},
  ): Array<WantRow & {
    nameZh: string | null; nameOriginal: string | null; year: number | null;
    posterLocal: string | null; state: WantState;
    /* ⭐ §115 画质汇总：mteam 已落盘集数/总字节/最高纵向分辨率 + 库内集数 */
    mtEps: number | null; mtBytes: number | null; mtMaxH: number | null;
    libEps: number | null; mediaEps: number | null; tmdbEps: number | null;
    /* ⭐ §115 复盘：把「还在下」和「全量库根本没有」分开 —— 前者值得等，后者等不来 */
    mtPendEps: number | null; mtNoneEps: number | null;
    mediaAt: string | null;
  }> {
    if (!this.has) return [];
    const where: string[] = [];
    if (!opts.includeRevoked) where.push('w.revoked_at IS NULL');
    // 默认（不传 includeDone）= 只给「待下中」；includeDone=true 才把「已收」也带上
    if (!opts.includeDone) where.push('w.done_at IS NULL');
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // ⭐ §115：待下清单要能「一眼看出这部的 mteam 已经落了几集、最高多少 p」——
    //    否则待下页只有「加入时间」，等于每次都要点进抽屉才知道该不该下。
    //    子查询按 work_id 聚合，⚠️ 只涉及 ep_media，⛔ 不碰 local_* 口径。
    const mc = this.hasEpMedia
      ? `,
                (SELECT COUNT(*) FROM ep_media m WHERE m.work_id = w.tmdb_id AND m.mt_size IS NOT NULL) AS mtEps,
                (SELECT SUM(m.mt_size) FROM ep_media m WHERE m.work_id = w.tmdb_id AND m.mt_size IS NOT NULL) AS mtBytes,
                (SELECT MAX(m.mt_h) FROM ep_media m WHERE m.work_id = w.tmdb_id) AS mtMaxH,
                (SELECT COUNT(*) FROM ep_media m WHERE m.work_id = w.tmdb_id AND m.lib_size IS NOT NULL) AS libEps,
                (SELECT COUNT(*) FROM ep_media m WHERE m.work_id = w.tmdb_id) AS mediaEps,
                /* 🔴 分母必须是「这部作品 TMDB 上有几集」，⛔ 不是「我们算过几集」——
                   否则「mteam 已落盘 2/2 集」会让人以为整部都下完了（实际可能只下了 2/6）。 */
                (SELECT COUNT(*) FROM tmdb_episode e
                  WHERE e.work_id = w.tmdb_id AND e.media_type = w.media_type) AS tmdbEps,
                /* ⭐ §115 复盘：「mteam 待落盘」和「mteam 全量库没有」必须分开数。
                   · mt_pending = 全量种子清单里有这集、盘上还没下完 ⇒ 值得等
                   · only_lib   = 全量种子清单里压根没这集 ⇒ 等也等不来
                   原来一律显示「mteam 还没落盘」，实测 953 条里 85 条其实等不来。 */
                (SELECT COUNT(*) FROM ep_media m WHERE m.work_id = w.tmdb_id AND m.verdict = 'mt_pending') AS mtPendEps,
                (SELECT COUNT(*) FROM ep_media m WHERE m.work_id = w.tmdb_id AND m.verdict = 'only_lib') AS mtNoneEps,
                (SELECT MAX(m.updated_at) FROM ep_media m WHERE m.work_id = w.tmdb_id) AS mediaAt`
      : '';
    const rows = this.db
      .prepare(
        `SELECT w.media_type, w.tmdb_id, w.note, w.want_by, w.want_at, w.done_at,
                w.revoked_at, w.snap_eps, w.snap_need,
                COALESCE(t.name_zh, t.name_original) AS nameZh,
                t.name_original AS nameOriginal,
                t.year AS year,
                t.poster_local AS posterLocal${mc}
           FROM work_want w
           LEFT JOIN tmdb_work t
                  ON t.id = w.tmdb_id AND t.media_type = w.media_type
           ${cond}
           ORDER BY w.want_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      media_type: String(r.media_type),
      tmdb_id: Number(r.tmdb_id),
      note: (r.note as string | null) ?? null,
      want_by: String(r.want_by ?? 'wa'),
      want_at: String(r.want_at ?? ''),
      done_at: (r.done_at as string | null) ?? null,
      revoked_at: (r.revoked_at as string | null) ?? null,
      snap_eps: r.snap_eps == null ? null : Number(r.snap_eps),
      snap_need: r.snap_need == null ? null : Number(r.snap_need),
      nameZh: (r.nameZh as string | null) ?? null,
      nameOriginal: (r.nameOriginal as string | null) ?? null,
      year: r.year == null ? null : Number(r.year),
      posterLocal: (r.posterLocal as string | null) ?? null,
      state: (r.revoked_at ? 'revoked' : r.done_at ? 'done' : 'want') as WantState,
      /* ⭐ §115 画质汇总（没有 ep_media 表 ⇒ 全 null，前端不画） */
      mtEps: r.mtEps == null ? null : Number(r.mtEps),
      mtBytes: r.mtBytes == null ? null : Number(r.mtBytes),
      mtMaxH: r.mtMaxH == null ? null : Number(r.mtMaxH),
      libEps: r.libEps == null ? null : Number(r.libEps),
      mediaEps: r.mediaEps == null ? null : Number(r.mediaEps),
      tmdbEps: r.tmdbEps == null ? null : Number(r.tmdbEps),
      mtPendEps: r.mtPendEps == null ? null : Number(r.mtPendEps),
      mtNoneEps: r.mtNoneEps == null ? null : Number(r.mtNoneEps),
      mediaAt: (r.mediaAt as string | null) ?? null,
    }));
  }

  /**
   * 加入待下（幂等：已在待下里只更新备注，⛔ 不重复插）
   * `snapEps` / `snapNeed` = 点♥那一刻界面上的数字（语义是「我看到的是 3/9」），
   * 传 null 表示拿不到 ⇒ 日后不做过期校验，⛔ 不编造。
   */
  add(
    tmdbId: number,
    mediaType: string,
    opts: { note?: string; by?: string; snapEps?: number | null; snapNeed?: number | null } = {},
  ): { ok: boolean; isNew: boolean } {
    if (!this.has) throw new Error('work_want 表不存在（migration 未跑）');
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error('tmdb_id 非法');
    if (mediaType !== 'tv' && mediaType !== 'movie') throw new Error('media_type 非法');

    const existing = this.db
      .prepare(`SELECT tmdb_id FROM work_want WHERE media_type = ? AND tmdb_id = ?`)
      .get(mediaType, tmdbId) as { tmdb_id: number } | undefined;

    const now = new Date().toISOString();
    const se = opts.snapEps == null ? null : Number(opts.snapEps);
    const sn = opts.snapNeed == null ? null : Number(opts.snapNeed);
    // 无论是首次 / 复活 / 重复点，都走同一条 UPSERT —— 避免多条路径写出不同字段集
    /* 🔴 `done_at = NULL` 这一句是**必须**的（2026-10-29 实测踩到）：
       流程「点♥加入 → 点已下好 → 取消待下 → 又想要，再点♥」里，
       若 UPSERT 保留旧 done_at，这部一加回来就是「已收」状态 ⇒
       清单里直接划线、待下计数不加、扫 Emby 也不会再去追它 = **假闭环**。
       `add()` 只会在「当前不在待下里」时被调用（不在时前端才走 toggle），
       ⇒ 清 done_at 不会误伤「已收但仍在清单」的部。 */
    this.db
      .prepare(
        `INSERT INTO work_want
           (media_type, tmdb_id, note, want_by, want_at, done_at, revoked_at, snap_eps, snap_need)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
           note       = excluded.note,
           want_by    = excluded.want_by,
           want_at    = excluded.want_at,
           done_at    = NULL,
           revoked_at = NULL,
           snap_eps   = excluded.snap_eps,
           snap_need  = excluded.snap_need`,
      )
      .run(mediaType, tmdbId, opts.note ?? null, opts.by ?? 'wa', now, se, sn);

    return { ok: true, isNew: !existing };
  }

  /** 取消待下 —— ⛔ 不 DELETE，写 revoked_at 留审计 */
  remove(tmdbId: number, mediaType: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_want SET revoked_at = ?
          WHERE media_type = ? AND tmdb_id = ? AND ${this.activeWhere()}`,
      )
      .run(new Date().toISOString(), mediaType, tmdbId);
    return Number(r.changes) > 0;
  }

  /** 标记「已下载/已入库」（幂等；revoked 的会先复活） */
  markDone(tmdbId: number, mediaType: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_want SET done_at = ?, revoked_at = NULL
          WHERE media_type = ? AND tmdb_id = ?`,
      )
      .run(new Date().toISOString(), mediaType, tmdbId);
    return Number(r.changes) > 0;
  }

  /** 取消「已下载」（点错了往回退；⛔ 不清 want_at） */
  unmarkDone(tmdbId: number, mediaType: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_want SET done_at = NULL
          WHERE media_type = ? AND tmdb_id = ? AND ${this.activeWhere()}`,
      )
      .run(mediaType, tmdbId);
    return Number(r.changes) > 0;
  }

  /**
   * 批量切换（一条事务，⛔ 不逐部往返）
   *
   * `on=true`  = 加入待下（已在的复活，⛔ course 不改 done_at —— 已收的部再点♥不该退回未收）
   * `on=false` = 取消待下
   * 返回 `{count, newly}`：count = 本次实际生效条数，newly = 其中真新增的
   */
  bulk(
    keys: string[],
    on: boolean,
    opts: { by?: string; note?: string } = {},
  ): { count: number; newly: number; invalid: number } {
    if (!this.has) throw new Error('work_want 表不存在（migration 未跑）');
    const parsed = keys.map(parseWantKey);
    const ok = parsed.filter((x): x is { mediaType: string; tmdbId: number } => x !== null);
    const invalid = keys.length - ok.length;
    if (!ok.length) return { count: 0, newly: 0, invalid };

    const now = new Date().toISOString();
    let newly = 0;
    this.db.exec('BEGIN');
    try {
      for (const p of ok) {
        if (on) {
          const ex = this.db
            .prepare(`SELECT tmdb_id FROM work_want WHERE media_type = ? AND tmdb_id = ?`)
            .get(p.mediaType, p.tmdbId) as { tmdb_id: number } | undefined;
          if (!ex) newly++;
          this.db
            .prepare(
              `INSERT INTO work_want
                 (media_type, tmdb_id, note, want_by, want_at, done_at, revoked_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL)
               ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
                 revoked_at = NULL,
                 want_at    = CASE WHEN work_want.revoked_at IS NOT NULL
                                   THEN excluded.want_at ELSE work_want.want_at END,
                 note       = COALESCE(excluded.note, work_want.note)`,
            )
            .run(p.mediaType, p.tmdbId, opts.note ?? null, opts.by ?? 'wa', now);
        } else {
          this.db
            .prepare(
              `UPDATE work_want SET revoked_at = ?
                WHERE media_type = ? AND tmdb_id = ? AND ${this.activeWhere()}`,
            )
            .run(now, p.mediaType, p.tmdbId);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { count: ok.length, newly, invalid };
  }

  /** 统计：待下中 / 已收 / 合计 */
  stats(): { want: number; done: number; total: number; hasTable: boolean } {
    if (!this.has) return { want: 0, done: 0, total: 0, hasTable: false };
    try {
      const r = this.db
        .prepare(
          `SELECT SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) AS want,
                  SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
                  COUNT(*) AS total
             FROM work_want WHERE ${this.activeWhere()}`,
        )
        .get() as { want: number | null; done: number | null; total: number } | undefined;
      return {
        want: Number(r?.want ?? 0),
        done: Number(r?.done ?? 0),
        total: Number(r?.total ?? 0),
        hasTable: true,
      };
    } catch {
      return { want: 0, done: 0, total: 0, hasTable: true };
    }
  }
}
