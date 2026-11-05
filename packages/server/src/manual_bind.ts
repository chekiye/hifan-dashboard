/**
 * 人工绑定服务（2026-11-01 §124 作者）
 *
 * ## 来历
 * 作者：「再加一个未匹配的筛选，我直接筛选未匹配，然后人工把未匹配的匹配上，
 *   我们这个全量名单就完整了」
 *
 * ## ⭐ 为什么人工事实要单独一张表（0r159）
 * `source_work` 是**匹配层的产物** —— `build_mt_disk_match.py` / `mteam_extract.py`
 * 每次重跑都可能重写它。把人工判定直接写进 `source_work`，下一次重跑就被机器逻辑
 * **静默吃掉**，人工白干。
 * ⇒ 人工事实放进 `manual_bind`（只增不改、有审计），
 *   匹配引擎读它并**优先采用** ⇒ 等价于「人工覆盖机器」，但机器改不动人工。
 *
 * ## ⛔ 关键区分：作品级绑定 vs 集位级钉死
 * | | 本表（`manual_bind`） | `align_ep_override.json` |
 * |---|---|---|
 * | 钉什么 | 「这个源文件归到哪**部作品**」 | 「这个源归到第几**季第几集**」 |
 * | 谁在用 | `build_mt_disk_match.py` | 服务端 `alignEpisodes` |
 * | 场景 | 整部作品没匹配上 | 作品对了但集号错了 |
 * 两表**互补不重叠**：本表定作品，集位 override 定集号。
 *
 * ## 安全边界（⛔ 全部硬校验，不接受前端透传）
 * · `src_key` 必须是「mteam 番号」或「_T_ 作品名」两种形态之一，长度受限
 * · `work_id` 必须是**库内真实存在的** `tmdb_work.id`（防绑到不存在的作品）
 * · `media_type` 只能是 `tv` / `movie`
 * · 集号可选；给了就必须落在该作品的实际季集范围内
 * · 改绑 = 旧行标 `superseded_by` + 新行插入，⛔ 不 DELETE、不覆盖（留审计）
 */
import type { DB } from '@hifan/core';

export interface ManualBindRow {
  id: number;
  src: string;
  srcKey: string;
  workId: number;
  mediaType: string;
  season: number | null;
  episode: number | null;
  fileName: string | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

/**
 * 番号形态：与 `scripts/_mt_code.py`（0lx 唯一事实源）**保持一致**。
 * ⚠️ §124b：位数不能卡太死 —— 库里明明有 `JVDW-6`（1 位）/ `RJ01007082`（8 位）/
 *    `MJAD091`（3 位），卡死会让这些键**存不进去**。
 */
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,20}\d{1,8}$/;
const CODE_RE2 = /^[A-Za-z]{2,7}\d{3,8}$/;
/** 月度合集的作品名键：`_T_` + 作品名 */
const TITLE_KEY_RE = /^_T_.{1,120}$/;

export class ManualBindService {
  private _hasTable: boolean | undefined;

  constructor(private readonly db: DB) {}

  /** 表是否存在（懒探测一次）—— 老库没跑 migration 时降级成「没有人工绑定」 */
  private get has(): boolean {
    if (this._hasTable === undefined) {
      try {
        const rows = this.db
          .prepare(`SELECT name FROM pragma_table_info('manual_bind')`)
          .all() as Array<{ name: string }>;
        this._hasTable = rows.length > 0;
      } catch {
        this._hasTable = false;
      }
    }
    return this._hasTable;
  }

  /**
   * 源键归一 + 校验。
   *
   * ⛔ 番号一律**大写**（mteam 番号大小写不敏感，库里也是大写）；
   *    `_T_` 作品名键**保留原样**（作品名有大小写语义，不归一）。
   */
  static normalizeKey(raw: unknown): string {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    if (s.startsWith('_T_')) return s;
    return s.toUpperCase();
  }

  /** 校验源键形态；不合法返回空串 */
  static validateKey(raw: unknown): string {
    const s = ManualBindService.normalizeKey(raw);
    if (!s) return '';
    if (s.length > 140) return '';
    if (TITLE_KEY_RE.test(s)) return s;
    if (CODE_RE.test(s) || CODE_RE2.test(s)) return s;
    return '';
  }

  /** 全部生效中的人工绑定（`superseded_by IS NULL`） */
  list(): ManualBindRow[] {
    if (!this.has) return [];
    const rows = this.db
      .prepare(
        `SELECT id, src, src_key, work_id, media_type, season, episode,
                file_name, note, decided_by, decided_at, created_at
           FROM manual_bind
          WHERE superseded_by IS NULL
          ORDER BY id`,
      )
      .all() as never;
    return rows as unknown as ManualBindRow[];
  }

  /** 生效中的绑定：源键 → 绑定内容 */
  byKey(): Map<string, ManualBindRow> {
    const m = new Map<string, ManualBindRow>();
    for (const r of this.list()) m.set(`${r.src}:${r.srcKey}`, r);
    return m;
  }

  /**
   * 写入一条人工绑定。
   *
   * ⛔ 幂等 + 留审计：同键已存在 ⇒ 旧行标 `superseded_by`（不改内容），
   *    新行插入 ⇒ 「改绑一次就多一条历史」，谁在什么时候绑的、绑到哪，全在表里。
   */
  bind(input: {
    src?: string;
    srcKey: string;
    workId: number;
    mediaType?: string;
    season?: number | null;
    episode?: number | null;
    fileName?: string | null;
    note?: string | null;
    by?: string;
  }): { ok: true; row: ManualBindRow; replaced: boolean } {
    if (!this.has) throw new Error('manual_bind 表不存在（migration #26 未跑）');

    const src = (input.src || 'mteam').trim();
    if (src !== 'mteam' && src !== 'hanime') throw new Error(`src 非法：${src}`);

    const key = ManualBindService.validateKey(input.srcKey);
    if (!key) throw new Error(`src_key 形态非法：${String(input.srcKey ?? '').slice(0, 60)}`);

    const workId = Number(input.workId);
    if (!Number.isInteger(workId) || workId <= 0) throw new Error('work_id 必须是正整数');

    const mediaType = (input.mediaType || 'tv').trim();
    if (mediaType !== 'tv' && mediaType !== 'movie') throw new Error(`media_type 非法：${mediaType}`);

    // ⛔ 必须绑定到**库内真实存在**的作品 —— 否则看板打不开、链接点过去是空的
    const w = this.db
      .prepare(`SELECT id, media_type FROM tmdb_work WHERE id = ?`)
      .get(workId) as { id: number; media_type: string | null } | undefined;
    if (!w) throw new Error(`work_id ${workId} 在 tmdb_work 里不存在`);

    // 集号可选；给了就必须落在该作品的实际季集范围内
    let season: number | null = null;
    let episode: number | null = null;
    const s = input.season === null || input.season === undefined ? null : Number(input.season);
    const e = input.episode === null || input.episode === undefined ? null : Number(input.episode);
    if (s !== null) {
      if (!Number.isInteger(s) || s < 0 || s > 99) throw new Error('season 必须是 0..99 的整数');
      season = s;
    }
    if (e !== null) {
      if (!Number.isInteger(e) || e < 0 || e > 999) throw new Error('episode 必须是 0..999 的整数');
      episode = e;
    }
    if (episode !== null) {
      const eps = this.db
        .prepare(`SELECT season, episode FROM tmdb_episode WHERE work_id = ?`)
        .all(workId) as Array<{ season: number; episode: number }>;
      const hit = eps.some((x) => x.episode === episode && (season === null || x.season === season));
      if (!hit) {
        throw new Error(
          `该作品没有 S${season ?? '*'}E${episode} 这一集（库里集数对不上，请先核对 TMDB 集数）`,
        );
      }
    }

    const now = new Date().toISOString();
    const by = (input.by || 'wa').slice(0, 40);
    const fileName = input.fileName ? String(input.fileName).slice(0, 240) : null;
    const note = input.note ? String(input.note).slice(0, 500) : null;

    const prev = this.db
      .prepare(`SELECT id FROM manual_bind WHERE src = ? AND src_key = ? AND superseded_by IS NULL`)
      .get(src, key) as { id: number } | undefined;

    let replaced = false;
    if (prev) {
      replaced = true;
    }

    const ins = this.db
      .prepare(
        `INSERT INTO manual_bind
           (src, src_key, work_id, media_type, season, episode,
            file_name, note, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(src, key, workId, mediaType, season, episode, fileName, note, by, now, now);

    const newId = Number(ins.lastInsertRowid);

    if (prev) {
      // ⛔ 旧行不改内容，只标失效指针 —— 历史可回溯，也避免「谁在什么时候绑的」丢失
      this.db.prepare(`UPDATE manual_bind SET superseded_by = ? WHERE id = ?`).run(newId, prev.id);
    }

    const row = this.db
      .prepare(
        `SELECT id, src, src_key, work_id, media_type, season, episode,
                file_name, note, decided_by, decided_at, created_at
           FROM manual_bind WHERE id = ?`,
      )
      .get(newId) as unknown as ManualBindRow;

    return { ok: true, row, replaced };
  }

  /** 撤销一条人工绑定 —— ⛔ 不 DELETE（留审计），标 `superseded_by = -1` 表示作废 */
  revoke(src: string, srcKey: string): boolean {
    if (!this.has) return false;
    const key = ManualBindService.normalizeKey(srcKey);
    const r = this.db
      .prepare(
        `UPDATE manual_bind SET superseded_by = -1
          WHERE src = ? AND src_key = ? AND superseded_by IS NULL`,
      )
      .run(src, key);
    return Number(r.changes) > 0;
  }

  /** 全部历史（含被改绑/作废的），供审计查看 */
  history(): ManualBindRow[] {
    if (!this.has) return [];
    return this.db
      .prepare(
        `SELECT id, src, src_key, work_id, media_type, season, episode,
                file_name, note, decided_by, decided_at, created_at
           FROM manual_bind ORDER BY id`,
      )
      .all() as unknown as ManualBindRow[];
  }
}
