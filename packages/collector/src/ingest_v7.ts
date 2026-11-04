/**
 * 灌库 v7 定稿 → library_work + review_queue
 *
 * 用法（在容器内）：
 *   node --experimental-strip-types dist/ingest_v7.js
 * 或直接：
 *   npm run ingest:v7
 *
 * 设计要点：
 *  1. **幂等** —— 用 INSERT ... ON CONFLICT DO UPDATE，重复跑不会重复插入
 *  2. **保留人工决定** —— review_queue.decided 不覆盖，重跑不丢审核结果
 *  3. **不碰 tmdb_work** —— 那是 M2 的旧池（1284 部），口径不同，物理隔离
 *
 * ⚠️ 为什么必须单独建表而不是复用 tmdb_work：
 *   tmdb_work 是「TMDB 自己收录的池」，UNIQUE(media_type, id)；
 *   library_work 是「三源合一定稿」，多了 sources/证据链/源标题。
 *   塞一起会让「全库统计」既不等于 TMDB 池也不等于全量库，两个口径都失真。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;

interface LibWork {
  tmdbId: number;
  mediaType?: string;
  nameZh?: string;
  nameOriginal?: string;
  year?: string | number;
  episodes?: number;
  poster?: string;
  genres?: string[];
  sources?: string;
  srcTitles?: string;
  evidence?: string;
  dice?: number | null;
  exact?: number;
  altNames?: string[];
  via?: string;
  typeEvidence?: string;
}
interface QueueItem {
  kind: 'no_entry' | 'review' | 'attached' | 'type_und';
  src?: string;
  srcTitle: string;
  rootTitle?: string;
  year?: number | string;
  attachTo?: number | null;
  attachName?: string;
  candidateId?: string | number;
  candidateName?: string;
  dice?: number | null;
  evidence?: string;
  queries?: string[];
  id?: number;
  why?: string;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf-8'));

function main(): void {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  /* 建表（幂等） */
  for (const m of MIGRATIONS) {
    try { db.exec(m); } catch { /* 已存在则忽略 */ }
  }

  const lib = readJson<LibWork[]>(`${DATA}/FINAL_full_library_2000plus.json`);
  const queue = readJson<QueueItem[]>(`${DATA}/FINAL_review_queue.json`);
  /* 类型判不出的条目单独并入队列 —— media_type 不确定 = 实体不确定，必须清零
   ⚠️ src 用 `tmdb:{id}` 而不是 'library'：
     type_und 的天然身份是 tmdbId —— 不同作品可能标题完全相同
     （实测 4 组：`御神楽探偵団` / `催眠学園` / `女兒損壞的心` / `300円のおつきあい Anime Edition`），
     若用统一 src='library'，UNIQUE(src, src_title, kind) 会把两部不同作品合并成一条。 */
  const undecidable: QueueItem[] = [];
  for (const w of lib) {
    if (w.mediaType) continue;
    undecidable.push({
      kind: 'type_und', src: `tmdb:${w.tmdbId}`,
      srcTitle: w.nameOriginal || w.nameZh || String(w.tmdbId),
      rootTitle: w.nameZh || '', year: Number(w.year) || 0,
      id: w.tmdbId, why: '多语言搜索未命中，media_type 判不出',
    });
  }
  const allQueue = [...queue, ...undecidable];

  /* ── library_work ── */
  const insLib = db.prepare(`
    INSERT INTO library_work
      (tmdb_id, media_type, name_zh, name_original, year, episodes, poster_path,
       sources, src_titles, evidence, dice, exact, alt_names, via, type_evidence, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
      name_zh       = COALESCE(NULLIF(excluded.name_zh, ''), library_work.name_zh),
      name_original = COALESCE(NULLIF(excluded.name_original, ''), library_work.name_original),
      year          = COALESCE(NULLIF(excluded.year, 0), library_work.year),
      episodes      = MAX(library_work.episodes, excluded.episodes),
      poster_path   = COALESCE(NULLIF(excluded.poster_path, ''), library_work.poster_path),
      sources       = excluded.sources,
      src_titles    = excluded.src_titles,
      evidence      = COALESCE(NULLIF(excluded.evidence, ''), library_work.evidence),
      dice          = COALESCE(excluded.dice, library_work.dice),
      exact         = MAX(library_work.exact, excluded.exact),
      alt_names     = excluded.alt_names,
      via           = COALESCE(NULLIF(excluded.via, ''), library_work.via),
      type_evidence = COALESCE(NULLIF(excluded.type_evidence, ''), library_work.type_evidence),
      ingested_at   = excluded.ingested_at
  `);
  const now = new Date().toISOString();
  let nLib = 0;
  let skippedNoType = 0;
  db.exec('BEGIN');
  try {
    for (const w of lib) {
      /* ⚠️ media_type 缺失的不能默认填 tv —— 主键是 (media_type, tmdb_id)，
         默认值会把「类型未知」伪装成「确定是 tv」，直接毁掉主键的可信度。
         这类条目只进 review_queue，等人工定。 */
      if (!w.mediaType) { skippedNoType++; continue; }
      insLib.run(
        w.tmdbId,
        w.mediaType,
        w.nameZh || '',
        w.nameOriginal || '',
        Number(w.year) || 0,
        Number(w.episodes) || 0,
        w.poster || '',
        w.sources || '',
        w.srcTitles || '',
        w.evidence || '',
        w.dice ?? null,
        w.exact ? 1 : 0,
        (w.altNames || []).join(' | '),
        w.via || '',
        w.typeEvidence || '',
        now,
      );
      nLib++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  /* ── review_queue ──
     ⭐ decided 不在更新列里：人工审核结果必须能扛住重跑 */
  const insQ = db.prepare(`
    INSERT INTO review_queue
      (kind, src, src_title, root_title, year, attach_to, attach_name,
       candidate_id, candidate_name, dice, evidence, queries_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(src, src_title, kind) DO UPDATE SET
      root_title      = excluded.root_title,
      year            = excluded.year,
      attach_to       = excluded.attach_to,
      attach_name     = excluded.attach_name,
      candidate_id    = excluded.candidate_id,
      candidate_name  = excluded.candidate_name,
      dice            = excluded.dice,
      evidence        = excluded.evidence,
      queries_json    = excluded.queries_json
  `);
  let nQ = 0;
  const byKind: Record<string, number> = {};
  db.exec('BEGIN');
  try {
    for (const q of allQueue) {
      insQ.run(
        q.kind,
        q.src || '',
        q.srcTitle,
        q.rootTitle || '',
        Number(q.year) || 0,
        q.attachTo ?? null,
        q.attachName || '',
        q.candidateId ? Number(q.candidateId) : (q.id ?? null),
        q.candidateName || '',
        q.dice ?? null,
        q.evidence || q.why || '',
        JSON.stringify(q.queries || []),
      );
      nQ++;
      byKind[q.kind] = (byKind[q.kind] || 0) + 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  /* ── 校验 ── */
  const cnt = (t: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
  const dup = db.prepare(`
    SELECT tmdb_id, media_type, COUNT(*) AS n FROM library_work
    GROUP BY tmdb_id, media_type HAVING n > 1
  `).all();
  const uniqId = db.prepare(`SELECT COUNT(DISTINCT tmdb_id) AS n FROM library_work`).get() as { n: number };
  const withEvidence = db.prepare(
    `SELECT COUNT(*) AS n FROM library_work WHERE exact = 1 OR evidence <> ''`
  ).get() as { n: number };
  const yRange = db.prepare(
    `SELECT MIN(year) AS lo, MAX(year) AS hi FROM library_work WHERE year > 0`
  ).get() as { lo: number; hi: number };

  console.log('═══════════════════════════════════════════');
  console.log('  灌库完成');
  console.log('═══════════════════════════════════════════\n');
  console.log(`  library_work    写入 ${nLib}，库内 ${cnt('library_work').n}`);
  console.log(`  review_queue    写入 ${nQ}，库内 ${cnt('review_queue').n}  ${JSON.stringify(byKind)}`);
  console.log(`  唯一 tmdbId     ${uniqId.n}（重复 ${dup.length} 组）`);
  console.log(`  类型待定条目    ${skippedNoType} → 已转 review_queue(type_und)`);
  console.log(`  带证据条目      ${withEvidence.n}/${cnt('library_work').n}`);
  console.log(`  年份范围        ${yRange.lo}~${yRange.hi}`);
  const noPoster = db.prepare(`SELECT COUNT(*) AS n FROM library_work WHERE poster_path = ''`).get() as { n: number };
  console.log(`  无封面          ${noPoster.n}（需补拉）`);
  db.close();
}

main();
