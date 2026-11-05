/**
 * 逐件屏蔽服务（2026-10-20 作者：「不是一刀切没」）
 *
 * ## 设计要点
 * ① **独立表 `work_hidden`**，⛔ 不复用 `tmdb_work.is_quarantined`
 *    —— 隔离混了三种语义（2000 前下线 / TMDB 重复副本 / 理由不明），
 *    而屏蔽是高频可逆的逐件操作，两者生命周期完全不同。
 * ② **两侧分开存**（作者拍板）：`scope='board'` 存 tmdb_id；
 *    `scope='unconfirmed'` 存 source_work.src_key（一源 = 一集）。
 * ③ **取消屏蔽不 DELETE**：写 `unhidden_at` 保留审计（铁律 0：禁 DELETE）。
 * ④ ⭐ 2026-10-26（§69 ⑥ 作者：「壳中的小鸟的S02可以屏蔽不显示」）新增
 *    `scope='season'` —— **季级屏蔽**。key 格式 `<tmdb_id>:S<季号>`（如 `118067:S2`）。
 *    ⚠️ 为什么 key 里带 workId：同一个季号在不同作品里含义完全不同，
 *       ⛔ 不能只存 `S2`（那会把全库所有作品的第 2 季一起屏掉）。
 *    ⚠️ 为什么不复用 `scope='board'`：作品级屏蔽会让整部消失，
 *       而这里的诉求是「同一部里的一季不显示，其余季照常」。
 *
 * ## 兼容性
 * 线上库可能还没跑 migration #6（表不存在）⇒ 所有方法先探测表是否存在，
 * 缺失时**降级成「没屏蔽任何东西」**，⛔ 绝不让接口 500。
 */
import type { DB } from '@hifan/core';

export type HiddenScope = 'board' | 'unconfirmed' | 'season' | 'episode';

export interface HiddenRow {
  scope: string;
  key: string;
  reason: string | null;
  hidden_by: string;
  hidden_at: string;
  unhidden_at: string | null;
}

const SCOPES: HiddenScope[] = ['board', 'unconfirmed', 'season', 'episode'];

/** 季级 key 的格式：`<tmdb_id>:S<season>` */
export const SEASON_KEY_RE = /^(\d+):S(\d{1,3})$/;

export function makeSeasonKey(workId: number | string, season: number): string {
  return `${workId}:S${season}`;
}

/**
 * 集级 key 的格式：`<tmdb_id>:S<season>:E<episode>`（2026-10-27 §74）
 *
 * 🔴 为什么必须独立 scope，⛔ 不能用季级凑：
 *    作者原话「屏蔽本季感觉没用啊，要是遇到风纪委员与风俗活动这种只是缺集的，
 *    你把整季屏蔽了」—— 缺 1 集却要屏掉整季 8 集，粒度过粗。
 *
 * 🔴 与季级 key 的**唯一区别**是多了 `:E<集>`。因此所有按季号切割 key 的地方
 *    都必须先排除集级 key（`instr(key, ':E') = 0`），否则
 *    `substr('284897:S1:E3', instr(…,':S')+2)` = `'1:E3'` ⇒ CAST 成 `1`
 *    ⇒ **误把整个 S1 当季级屏蔽**（0pd）。
 */
export const EPISODE_KEY_RE = /^(\d+):S(\d{1,3}):E(\d{1,4})$/;

export function makeEpisodeKey(
  workId: number | string,
  season: number,
  episode: number,
): string {
  return `${workId}:S${season}:E${episode}`;
}

/** 集级 key 在作品内部的表示：`<season>-<episode>`（前端 localMap / stillMap 同款） */
export function epPair(season: number, episode: number): string {
  return `${season}-${episode}`;
}


export class HiddenService {
  private _hasTable: boolean | undefined;

  constructor(private readonly db: DB) {}

  /** 表是否存在（懒探测一次）—— 老库没跑 migration #6 时降级 */
  private get has(): boolean {
    if (this._hasTable === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_hidden')`)
          .all() as Array<{ name: string }>;
        this._hasTable = rows.length > 0;
      } catch {
        this._hasTable = false;
      }
    }
    return this._hasTable;
  }

  /** 当前生效的屏蔽（`unhidden_at IS NULL`） */
  private activeWhere(): string {
    return `unhidden_at IS NULL`;
  }

  /** 某作用域下所有生效屏蔽的 key 集合 */
  keys(scope: HiddenScope): Set<string> {
    if (!this.has) return new Set();
    const rows = this.db
      .prepare(
        `SELECT key FROM work_hidden WHERE scope = ? AND ${this.activeWhere()}`,
      )
      .all(scope) as Array<{ key: string }>;
    return new Set(rows.map((r) => String(r.key)));
  }

  /**
   * ⭐ 2026-10-26（§69 ⑥）：**某作品被屏蔽的季号集合**。
   *
   * 🔴 为什么要单独一个方法而不是 `keys('season')` 之后自己 filter：
   *   1. `keys()` 每次返回**全库**所有季级 key（现在少，但会长）；
   *      详情页是高频接口，按作品精确查能走 key 的前缀索引。
   *   2. 返回 `Set<number>` 直接就是 `season NOT IN (...)` 需要的形态，
   *      调用方不用再解析字符串 ⇒ 解析口径只有**一处**（0lx）。
   *
   * ⚠️ 降级：表不存在 / 老库没这 scope 的行使 ⇒ 返回空集 ⇒ 详情页不过滤。
   */
  seasonKeys(workId: number | string): Set<number> {
    if (!this.has) return new Set();
    const prefix = `${workId}:S`;
    const rows = this.db
      .prepare(
        `SELECT key FROM work_hidden
          WHERE scope = 'season' AND ${this.activeWhere()} AND key LIKE ?`,
      )
      .all(`${prefix}%`) as Array<{ key: string }>;
    const out = new Set<number>();
    for (const r of rows) {
      const m = SEASON_KEY_RE.exec(String(r.key));
      if (m) out.add(Number(m[2]));
    }
    return out;
  }

  /** 全部生效的季级屏蔽 —— 给「屏蔽列表」页按作品分组用 */
  allSeasonKeys(): Array<{ workId: number; season: number; key: string }> {
    if (!this.has) return [];
    const rows = this.db
      .prepare(
        `SELECT key FROM work_hidden WHERE scope = 'season' AND ${this.activeWhere()}`,
      )
      .all() as Array<{ key: string }>;
    const out: Array<{ workId: number; season: number; key: string }> = [];
    for (const r of rows) {
      const m = SEASON_KEY_RE.exec(String(r.key));
      if (!m) continue; // 脏 key 直接跳过，⛔ 不让它把接口打成 500
      out.push({ workId: Number(m[1]), season: Number(m[2]), key: String(r.key) });
    }
    return out;
  }

  /**
   * 某作品被**集级**排除的集（2026-10-27 §74）。
   *
   * 返回 `Set<'<season>-<episode>'>`，与前端 `localMap` / `stillMap` 的 key 同款，
   * 调用方不用再拼字符串 ⇒ 解析口径只有一处（0lx）。
   */
  episodeKeys(workId: number | string): Set<string> {
    if (!this.has) return new Set();
    const rows = this.db
      .prepare(
        `SELECT key FROM work_hidden
          WHERE scope = 'episode' AND ${this.activeWhere()} AND key LIKE ?`,
      )
      .all(`${workId}:S%`) as Array<{ key: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      const m = EPISODE_KEY_RE.exec(String(r.key));
      if (m) out.add(epPair(Number(m[2]), Number(m[3])));
    }
    return out;
  }

  /** 全部生效的集级排除 —— 给「屏蔽列表」页用 */
  allEpisodeKeys(): Array<{
    workId: number;
    season: number;
    episode: number;
    key: string;
  }> {
    if (!this.has) return [];
    const rows = this.db
      .prepare(
        `SELECT key FROM work_hidden WHERE scope = 'episode' AND ${this.activeWhere()}`,
      )
      .all() as Array<{ key: string }>;
    const out: Array<{
      workId: number;
      season: number;
      episode: number;
      key: string;
    }> = [];
    for (const r of rows) {
      const m = EPISODE_KEY_RE.exec(String(r.key));
      if (!m) continue;
      out.push({
        workId: Number(m[1]),
        season: Number(m[2]),
        episode: Number(m[3]),
        key: String(r.key),
      });
    }
    return out;
  }

  /** 两边全部生效屏蔽 —— 看板列表用（附作品名，省一次回查） */
  list(opts: { scope?: HiddenScope; includeUnhidden?: boolean } = {}): Array<
    HiddenRow & { nameZh: string | null; year: number | null }
  > {
    if (!this.has) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.scope) {
      where.push('h.scope = ?');
      args.push(opts.scope);
    }
    if (!opts.includeUnhidden) where.push(`h.${this.activeWhere()}`);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // ⭐ 屏蔽列表要能看到「屏的是什么」⇒ LEFT JOIN 作品名。
    //    ⚠️ unconfirmed 侧的 key 是 src_key，作品名要从 source_work 回查。
    // 🔴🔴 铁律 0at 的又一次实证：本轮先写成 `s.title_zh`，
    //    实测 source_work **没有 title_zh 列**（24 列里只有 `title`）⇒ `no such column`。
    //    ✅ 正解：**先查列再写 SQL**；这里用 `s.title`（源站原标题，本来就最该显示）。
    // ⭐ 2026-10-26（§69 ⑥）：season 侧 key 是 `<tmdb_id>:S<季号>` ⇒
    //    要用 `substr/instr` 拆出 workId 才能回查作品名。
    //    ⚠️ `instr` 找不到分隔符时返回 0 ⇒ `substr(key,1,-1)` 会得到空串 ⇒
    //       JOIN 命中不到 ⇒ nameZh 为 NULL（脏 key 自然降级，不会 500）。
    return this.db
      .prepare(
        `SELECT h.scope, h.key, h.reason, h.hidden_by, h.hidden_at, h.unhidden_at,
                COALESCE(w.name_zh, s.title, w2.name_zh) AS nameZh,
                COALESCE(w.year, w2.year) AS year
         FROM work_hidden h
         LEFT JOIN tmdb_work w
                ON h.scope = 'board' AND CAST(w.id AS TEXT) = h.key
         LEFT JOIN source_work s
                ON h.scope = 'unconfirmed' AND s.src_key = h.key
         LEFT JOIN tmdb_work w2
                ON h.scope IN ('season', 'episode')
               AND CAST(w2.id AS TEXT) = substr(h.key, 1, instr(h.key, ':') - 1)
         ${cond}
         ORDER BY h.hidden_at DESC`,
      )
      .all(...(args as never[])) as never;
  }

  /** 屏蔽（或幂等重屏） */
  hide(scope: HiddenScope, key: string, reason?: string, by = 'wa'): boolean {
    if (!SCOPES.includes(scope)) throw new Error(`未知 scope: ${scope}`);
    if (!key) throw new Error('key 不能为空');
    if (!this.has) throw new Error('work_hidden 表不存在（migration 未跑）');

    const existing = this.db
      .prepare(
        `SELECT key, unhidden_at FROM work_hidden WHERE scope = ? AND key = ?`,
      )
      .get(scope, key) as { key: string; unhidden_at: string | null } | undefined;

    const now = new Date().toISOString();
    if (existing) {
      // 之前取消过 ⇒ 复活并更新理由；已生效 ⇒ 只更新理由
      this.db
        .prepare(
          `UPDATE work_hidden
              SET unhidden_at = NULL, hidden_at = ?, hidden_by = ?, reason = ?
            WHERE scope = ? AND key = ?`,
        )
        .run(now, by, reason ?? null, scope, key);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO work_hidden (scope, key, reason, hidden_by, hidden_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scope, key, reason ?? null, by, now);
    return true;
  }

  /** 取消屏蔽 —— ⛔ 不 DELETE，写 unhidden_at 留审计 */
  unhide(scope: HiddenScope, key: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_hidden SET unhidden_at = ?
          WHERE scope = ? AND key = ? AND ${this.activeWhere()}`,
      )
      .run(new Date().toISOString(), scope, key);
    return Number(r.changes) > 0;
  }

  /** 统计（前端角标用） */
  stats(): {
    board: number;
    unconfirmed: number;
    season: number;
    episode: number;
    hasTable: boolean;
  } {
    if (!this.has) {
      return { board: 0, unconfirmed: 0, season: 0, episode: 0, hasTable: false };
    }
    const rows = this.db
      .prepare(
        `SELECT scope, COUNT(*) AS n FROM work_hidden
          WHERE ${this.activeWhere()} GROUP BY scope`,
      )
      .all() as Array<{ scope: string; n: number }>;
    const m: Record<string, number> = {};
    for (const r of rows) m[r.scope] = Number(r.n);
    return {
      board: m.board ?? 0,
      unconfirmed: m.unconfirmed ?? 0,
      season: m.season ?? 0,
      episode: m.episode ?? 0,
      hasTable: true,
    };
  }
}
