/**
 * 人工核对标记服务（2026-10-24 作者）
 *
 * ## 来历
 * 作者：「8848 看板目前有屏蔽该部但是没有已核对之类的，就是我到时候如果确认
 *   这一部没问题，我可以在 8848 看板上直接标记我核对过，没问题的按钮」
 *
 * ## 与「逐件屏蔽」的关系（⛔ 别混）
 * | | 屏蔽 work_hidden | 核对 work_checked |
 * |---|---|---|
 * | 意图 | 不想看 ⇒ **藏起来** | 看过了没问题 ⇒ **留凭证** |
 * | 对列表 | 服务端过滤掉（visibleEx） | **照常显示**，只多一个 ✓ |
 * | 取消字段 | unhidden_at | unchecked_at |
 * | 统计 | 「已屏蔽 N 部」 | 「已核对 N / 1456」 |
 * 两者的默认视图行为**相反** ⇒ 必须独立成表（schema.ts #N 的注释里写了三条理由）。
 *
 * ## 设计要点
 * ① 状态存**服务端 DB**，⛔ 不存 localStorage —— 与屏蔽同理：换浏览器/手机一致，
 *    且助手能直接读库（未确定看板那轮踩过 0gh：只存 localStorage = 假闭环）。
 * ② 取消核对**不 DELETE**，写 unchecked_at 留审计（铁律 0）。
 * ③ 表不存在时（老库没跑 migration）**降级成「一部都没核过」**，⛔ 绝不让接口 500。
 */
import type { DB } from '@hifan/core';

export type CheckedScope = 'board';

export interface CheckedRow {
  scope: string;
  key: string;
  note: string | null;
  checked_by: string;
  checked_at: string;
  unchecked_at: string | null;
}

export class CheckedService {
  private _hasTable: boolean | undefined;

  constructor(private readonly db: DB) {}

  /** 表是否存在（懒探测一次）—— 老库没跑 migration 时降级 */
  private get has(): boolean {
    if (this._hasTable === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('work_checked')`)
          .all() as Array<{ name: string }>;
        this._hasTable = rows.length > 0;
      } catch {
        this._hasTable = false;
      }
    }
    return this._hasTable;
  }

  /** 当前生效的核对（`unchecked_at IS NULL`） */
  private activeWhere(): string {
    return `unchecked_at IS NULL`;
  }

  /** 某作用域下所有生效核对的 key 集合 */
  keys(scope: CheckedScope = 'board'): Set<string> {
    if (!this.has) return new Set();
    const rows = this.db
      .prepare(`SELECT key FROM work_checked WHERE scope = ? AND ${this.activeWhere()}`)
      .all(scope) as Array<{ key: string }>;
    return new Set(rows.map((r) => String(r.key)));
  }

  /**
   * 核对清单（附作品名/年份，省前端一次回查）
   *
   * 🔴 铁律 0at 的教训：**先查列再写 SQL**。
   *    `tmdb_work` 的列名是 `name_zh`（不是 name/nameZh），这里必须从库侧对一遍。
   */
  list(opts: { scope?: CheckedScope; includeUnchecked?: boolean } = {}): Array<
    CheckedRow & { nameZh: string | null; year: number | null }
  > {
    if (!this.has) return [];
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.scope) {
      where.push('c.scope = ?');
      args.push(opts.scope);
    }
    if (!opts.includeUnchecked) where.push(`c.${this.activeWhere()}`);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.db
      .prepare(
        `SELECT c.scope, c.key, c.note, c.checked_by, c.checked_at, c.unchecked_at,
                COALESCE(w.name_zh, w.name_original) AS nameZh,
                w.year AS year
         FROM work_checked c
         LEFT JOIN tmdb_work w ON CAST(w.id AS TEXT) = c.key AND c.scope = 'board'
         ${cond}
         ORDER BY c.checked_at DESC`,
      )
      .all(...(args as never[])) as never;
  }

  /** 标记已核对（或幂等重标 + 更新备注）；返回「是否首次标记」 */
  check(scope: CheckedScope, key: string, note?: string, by = 'wa'): boolean {
    if (!scope) throw new Error('scope 不能为空');
    if (!key) throw new Error('key 不能为空');
    if (!this.has) throw new Error('work_checked 表不存在（migration 未跑）');

    const existing = this.db
      .prepare(`SELECT key FROM work_checked WHERE scope = ? AND key = ?`)
      .get(scope, key) as { key: string } | undefined;

    const now = new Date().toISOString();
    if (existing) {
      // 之前取消过 ⇒ 复活；已生效 ⇒ 只更新备注/时间（幂等，不重复插）
      this.db
        .prepare(
          `UPDATE work_checked
              SET unchecked_at = NULL, checked_at = ?, checked_by = ?, note = ?
            WHERE scope = ? AND key = ?`,
        )
        .run(now, by, note ?? null, scope, key);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO work_checked (scope, key, note, checked_by, checked_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scope, key, note ?? null, by, now);
    return true;
  }

  /** 取消核对 —— ⛔ 不 DELETE，写 unchecked_at 留审计 */
  uncheck(scope: CheckedScope, key: string): boolean {
    if (!this.has) return false;
    const r = this.db
      .prepare(
        `UPDATE work_checked SET unchecked_at = ?
          WHERE scope = ? AND key = ? AND ${this.activeWhere()}`,
      )
      .run(new Date().toISOString(), scope, key);
    return Number(r.changes) > 0;
  }

  /** 统计（进度条用）：已核对 + 可核对总量（可见作品数） */
  stats(): { board: number; total: number; hasTable: boolean } {
    if (!this.has) return { board: 0, total: 0, hasTable: false };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM work_checked WHERE scope = 'board' AND ${this.activeWhere()}`,
      )
      .get() as { n: number } | undefined;
    // 分母口径 = 看板可见作品数（与首页 stats.total 同源，⛔ 不用 source_work 行数）
    let total = 0;
    try {
      const t = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tmdb_work WHERE is_quarantined = 0`,
        )
        .get() as { n: number } | undefined;
      total = Number(t?.n ?? 0);
    } catch {
      total = 0;
    }
    return { board: Number(row?.n ?? 0), total, hasTable: true };
  }
}
