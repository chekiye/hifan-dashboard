/**
 * 提升 v7 已确认作品 → tmdb_work 统一主库
 *
 * ⭐ 为什么需要这一步（2026-10-14 产品结构纠正）：
 *   8848 看板是本项目的产品本身，主线 =「TMDB 2000+ 完整词条 → 本地文件匹配
 *   → 未下载 / 缺集 / 完整」。而 10-14 之前把 v7 的 1547 条塞进 library_work
 *   并加了第三个页签「全量库 v7」—— 那是把支线当主线，用户明确否决
 *   （原话：「你这是倒反天乾」「这项目不就废了吗」）。
 *
 *   本脚本把 library_work 里**已确认**（有唯一 tmdbId + mediaType）的作品
 *   写进 tmdb_work，让它们以**原本 TMDB 看板的形态**出现在 8848 上。
 *   library_work 保留为「证据档」，不再作为看板数据源。
 *
 * 实测集合关系（NAS 线上库，2026-10-14）：
 *   tmdb_work 1284 / library_work 1547 / 重叠 1190
 *   仅 library_work  357  ← 本脚本提升的就是这批
 *   仅 tmdb_work      94  ← v7 未覆盖但仍是 TMDB 收录，全 movie，一律保留
 *   → 统一主库 1284 + 357 = 1641
 *
 * 设计要点：
 *  1. **幂等** —— ON CONFLICT(media_type, id) DO UPDATE，重跑不重复
 *  2. **只增不删** —— tmdb_work 里 v7 没覆盖的 94 部绝不动
 *  3. **不覆盖已有更好数据** —— tmdb_work 已有 season/episode/poster_local 的
 *     字段一律保留；v7 只补它没有的（work_origin/discovery_srcs/证据链），
 *     以及 name_zh/name_original 为空时的兜底填充
 *  4. **证据链降级为辅助字段** —— 存进 evidence_json，不参与主看板展示形态
 *
 * 用法（容器内）：
 *   node --experimental-strip-types dist/enrich_pool.js
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;

interface LibRow {
  tmdb_id: number;
  media_type: string;
  name_zh: string | null;
  name_original: string | null;
  year: number | null;
  episodes: number;
  poster_path: string | null;
  sources: string | null;
  src_titles: string | null;
  evidence: string | null;
  dice: number | null;
  exact: number;
  alt_names: string | null;
  via: string | null;
  type_evidence: string | null;
}

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // ⚠️ 迁移追踪用 `_migration` 表（core/src/db.ts 的既有约定），
  //    不是 PRAGMA user_version —— 我一开始写错了，读的是 user_version，
  //    结果在已迁移过的库上会重复执行 ALTER TABLE 而报「duplicate column」。
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migration (
       idx        INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(
    (db.prepare('SELECT idx FROM _migration').all() as Array<{ idx: number }>).map((r) => Number(r.idx)),
  );
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (applied.has(i)) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO _migration (idx, applied_at) VALUES (?, ?)').run(i, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`[schema] 已应用 migration #${i}`);
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`[schema] migration #${i} 失败并已回滚：${String(err)}`);
      process.exit(1);
    }
  }
  return db;
}

function main(): void {
  const db = open();
  console.log(`[schema] migration 索引 = ${MIGRATIONS.length}`);

  // ── 审计：先看清要动什么，再动 ────────────────────────────────
  const before = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tmdb_work) AS tw,
         (SELECT COUNT(*) FROM library_work) AS lw,
         (SELECT COUNT(*) FROM tmdb_work w WHERE EXISTS(
            SELECT 1 FROM library_work l WHERE l.tmdb_id=w.id AND l.media_type=w.media_type)) AS overlap,
         (SELECT COUNT(*) FROM library_work l WHERE NOT EXISTS(
            SELECT 1 FROM tmdb_work w WHERE l.tmdb_id=w.id AND l.media_type=w.media_type)) AS lib_only,
         (SELECT COUNT(*) FROM tmdb_work w WHERE NOT EXISTS(
            SELECT 1 FROM library_work l WHERE l.tmdb_id=w.id AND l.media_type=w.media_type)) AS tw_only`,
    )
    .get() as Record<string, number>;
  console.log('[审计] 提升前', JSON.stringify(before));
  console.log(`[审计] 预期统一主库 = ${before.tw} + ${before.lib_only} = ${before.tw + before.lib_only}`);

  // ── 取待提升的 357 条 ────────────────────────────────────────
  const rows = db
    .prepare(
      `SELECT l.tmdb_id, l.media_type, l.name_zh, l.name_original, l.year, l.episodes,
              l.poster_path, l.sources, l.src_titles, l.evidence, l.dice, l.exact,
              l.alt_names, l.via, l.type_evidence
       FROM library_work l
       WHERE NOT EXISTS (
         SELECT 1 FROM tmdb_work w WHERE l.tmdb_id=w.id AND l.media_type=w.media_type)
       ORDER BY l.year, l.tmdb_id`,
    )
    .all() as unknown as LibRow[];

  console.log(`[提升] 待写入 tmdb_work：${rows.length} 部`);
  if (!rows.length) {
    console.log('[提升] 无需操作（可能已提升过）');
    finish(db, before);
    return;
  }

  // ⚠️ 这里必须「先 UPDATE 后 INSERT」，不能用 ON CONFLICT —— 与 collector.ts 同因：
  //   tmdb_work.id 是 INTEGER PRIMARY KEY（物理主键），同时又有 UNIQUE(media_type, id)；
  //   SQLite 对这种「主键 + 复合唯一」组合的 ON CONFLICT(media_type, id) 解析失败：
  //     ERR_SQLITE_ERROR: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
  //   （collector.ts 里早有同样注释，这是第二次撞同一个坑）
  const upd = db.prepare(
    `UPDATE tmdb_work SET
       name_original    = COALESCE(name_original, $name_original),
       name_zh          = COALESCE(name_zh, $name_zh),
       first_air_date   = COALESCE(first_air_date, $first_air_date),
       year             = COALESCE(year, $year),
       episode_total    = CASE WHEN episode_total > 0 THEN episode_total ELSE $episodes END,
       poster_path      = COALESCE(poster_path, $poster_path),
       work_origin      = COALESCE(work_origin, 'v7_merge'),
       discovery_srcs   = COALESCE(discovery_srcs, $discovery_srcs),
       evidence_note    = COALESCE(evidence_note, $evidence_note),
       evidence_json    = COALESCE(evidence_json, $evidence_json)
     WHERE media_type = $media_type AND id = $id`,
  );
  const ins = db.prepare(
    `INSERT INTO tmdb_work (
       id, media_type, name_original, name_zh, first_air_date, year,
       episode_total, season_count, popularity, adult, genres,
       source_channel, work_origin, discovery_srcs,
       poster_path, evidence_note, evidence_json, fetched_at
     ) VALUES (
       $id, $media_type, $name_original, $name_zh, $first_air_date, $year,
       $episodes, 0, NULL, 1, $genres,
       'v7_merge', 'v7_merge', $discovery_srcs,
       $poster_path, $evidence_note, $evidence_json, $fetched_at
     )`,
  );

  const now = new Date().toISOString();
  let ok = 0;
  const fail: Array<{ id: number; mt: string; err: string }> = [];

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const srcTitles = (r.src_titles || '').split(' | ').filter(Boolean).slice(0, 12);
      const alts = (r.alt_names || '').split(' | ').filter(Boolean).slice(0, 20);
      const evidenceJson = JSON.stringify({
        sources: r.sources,
        srcTitles,
        evidence: r.evidence,
        dice: r.dice,
        exact: !!r.exact,
        altNames: alts,
        via: r.via,
        typeEvidence: r.type_evidence,
      });
      const evidenceNote = [
        r.evidence,
        r.dice != null ? `dice=${r.dice}` : null,
        r.exact ? '别名逐字全同' : null,
        r.via,
      ]
        .filter(Boolean)
        .join(' · ');

      try {
        // ⚠️ node:sqlite 不允许传「SQL 中未使用」的具名参数
        //    （ERR_INVALID_STATE: Unknown named parameter），
        //    所以 UPDATE 与 INSERT 必须各用自己的参数集。
        const common = {
          $id: r.tmdb_id,
          $media_type: r.media_type,
          $name_original: r.name_original,
          $name_zh: r.name_zh,
          $first_air_date: r.year ? `${r.year}-01-01` : null,
          $year: r.year,
          $episodes: r.episodes || 0,
          $discovery_srcs: r.sources,
          $poster_path: r.poster_path,
          $evidence_note: evidenceNote,
          $evidence_json: evidenceJson,
        } as Record<string, string | number | null>;
        const changed = upd.run(common).changes;
        if (changed === 0) {
          ins.run({ ...common, $genres: JSON.stringify(['Animation']), $fetched_at: now });
        }
        ok++;
      } catch (err) {
        fail.push({ id: r.tmdb_id, mt: r.media_type, err: String(err) });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[提升] 事务回滚：', String(err));
    process.exit(1);
  }

  console.log(`[提升] 成功 ${ok}，失败 ${fail.length}`);
  for (const f of fail.slice(0, 10)) console.log(`  ✗ ${f.mt}/${f.id}：${f.err}`);

  finish(db, before);
}

function finish(db: DatabaseSync, before: Record<string, number>): void {
  const after = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN media_type='tv' THEN 1 ELSE 0 END)    AS tv,
         SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END) AS movie,
         SUM(CASE WHEN work_origin='v7_merge' THEN 1 ELSE 0 END) AS merged,
         SUM(CASE WHEN season_count>0 THEN 1 ELSE 0 END)    AS withSeasons,
         SUM(CASE WHEN poster_local IS NOT NULL THEN 1 ELSE 0 END) AS posterLocal,
         COALESCE(SUM(episode_total),0)                      AS totalEpisodes,
         MIN(year) AS minYear, MAX(year) AS maxYear
       FROM tmdb_work`,
    )
    .get() as Record<string, number>;

  console.log('\n[提升后] tmdb_work =', JSON.stringify(after));
  console.log(`[验收] 统一主库 ${before.tw} → ${after.total}（增量 ${after.total - before.tw}）`);
  console.log(`[验收] 年份跨度 ${after.minYear} ~ ${after.maxYear}`);
  const noYear = db
    .prepare('SELECT COUNT(*) AS n FROM tmdb_work WHERE year IS NULL')
    .get() as { n: number };
  const pre2000 = db
    .prepare('SELECT COUNT(*) AS n FROM tmdb_work WHERE year < 2000')
    .get() as { n: number };
  console.log(`[验收] 无年份 ${noYear.n}，year<2000 ${pre2000.n}（口径应为 0）`);

  const orphan = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tmdb_episode e
       WHERE NOT EXISTS (SELECT 1 FROM tmdb_work w WHERE w.id = e.work_id AND w.media_type = e.media_type)`,
    )
    .get() as { n: number };
  console.log(`[验收] 孤儿季集 ${orphan.n}（media_type 不在 tmdb_episode 中，为预期）`);
  db.close();
}

main();