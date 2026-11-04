/**
 * 把纯度检测的边界条目送入 review_queue（人工审核）
 *
 * ⭐ 为什么边界条目要进审核队列，而不是隔离？
 *
 *   check_purity 的门槛是「原名非日语 且 ≥3 条非里番硬证据」。
 *   2 条硬证据的条目卡在门槛线下 —— 算法不敢定，只能人来判。
 *   实测这批 95 条里混着两类：
 *     · 明确的欧美动画（幻灭 Disenchantment / 欢乐树的朋友们 / 克里夫兰秀）
 *     · 明确不是里番的商业改编（假面骑士Wizard / Free!男子游泳部）
 *   它们**仍留在主看板**（不隔离=不误删），但需要一个待办清单让用户过一遍。
 *
 * kind='purity' 是新类型，语义与已有三类都不同：
 *   no_entry / review / attached —— 「这条源作品有没有对上 TMDB」
 *   purity                      —— 「这条**已经在库**的作品是不是里番」
 *
 * 用法（容器内）：
 *   node --no-warnings dist/queue_purity_review.js          # 试运行
 *   node --no-warnings dist/queue_purity_review.js --apply  # 写库
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from '@hifan/core';

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;
const REPORT = `${DATA}/purity_report.json`;

const APPLY = process.argv.includes('--apply');

type V = string | number | bigint | null | Uint8Array;
const P = (o: Record<string, V>): Record<string, V> => o;

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS _migration (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT idx FROM _migration').all() as Array<{ idx: number }>).map((r) =>
      Number(r.idx),
    ),
  );
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (applied.has(i)) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO _migration (idx, applied_at) VALUES (?, ?)').run(
        i,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`[schema] migration #${i} 失败：${String(err)}`);
      process.exit(1);
    }
  }
  return db;
}

const db = open();

interface Row {
  id: number;
  name: string;
  nameOriginal: string | null;
  year: number | null;
  popularity: number | null;
  score: number;
  hardEvidence: number;
  reasons: string[];
  keywords: string[];
}

let rows: Row[];
try {
  const rep = JSON.parse(readFileSync(REPORT, 'utf8')) as {
    results: Array<{
      id: number;
      name: string;
      nameOriginal: string | null;
      year: number | null;
      popularity: number | null;
      score: number;
      hardEvidence: number;
      reasons: string[];
      keywords: string[];
      verdict: string;
    }>;
  };
  // 边界 = 待人工确认（suspect）里硬证据正好 2 条的
  rows = rep.results.filter((r) => r.verdict === 'suspect' && r.hardEvidence === 2);
} catch (err) {
  console.error(`[致命] 读不到 ${REPORT}：${String(err)}`);
  db.close();
  process.exit(1);
}

console.log(`[报告] ${REPORT}`);
console.log(`[边界条目] ${rows.length} 部（2 条硬证据，算法不敢定）`);

// 已隔离的（likely_mainstream）不该再出现在待办里
const quarantined = new Set(
  (db.prepare(`SELECT id FROM tmdb_work WHERE is_quarantined = 1`).all() as Array<{
    id: number;
  }>).map((r) => Number(r.id)),
);

const items = rows.filter((r) => !quarantined.has(r.id));
if (quarantined.size) {
  console.log(`[跳过] ${rows.length - items.length} 部已在隔离池中，不重复入队`);
}

if (!items.length) {
  console.log('[结果] 无需入队');
  db.close();
  process.exit(0);
}

for (const r of items.slice(0, 15)) {
  console.log(`  ${r.id} ${String(r.year)} pop=${r.popularity?.toFixed(0) ?? '-'} 「${r.name}」[${r.nameOriginal}]`);
}
if (items.length > 15) console.log(`  … 另 ${items.length - 15} 部`);

if (!APPLY) {
  console.log('\n[试运行] 加 --apply 才真正写库');
  db.close();
  process.exit(0);
}

/**
 * ⚠️ node:sqlite 不允许传「SQL 中未使用」的具名参数。
 *    UNIQUE(src, src_title, kind) 做幂等 —— 重复跑不会产生重复行。
 */
const ins = db.prepare(
  `INSERT INTO review_queue
     (kind, src, src_title, root_title, year, candidate_id, candidate_name,
      dice, evidence, queries_json, decided)
   VALUES ($kind, $src, $srcTitle, $rootTitle, $year, $candId, $candName,
           $dice, $evidence, $queries, NULL)
   ON CONFLICT (src, src_title, kind) DO UPDATE SET evidence = $evidence`,
);

let n = 0;
db.exec('BEGIN');
try {
  for (const r of items) {
    ins.run(
      P({
        $kind: 'purity',
        $src: `tmdb:${r.id}`,
        $srcTitle: `${r.name} [${r.nameOriginal ?? '-'}]`,
        $rootTitle: r.nameOriginal ?? '',
        $year: r.year ?? 0,
        $candId: r.id,
        $candName: r.name,
        $dice: null,
        $evidence:
          `纯度边界：硬证据 ${r.hardEvidence} 条 / 打分 ${r.score} / pop ${r.popularity?.toFixed(0) ?? '-'}｜` +
          r.reasons.join('；'),
        $queries: JSON.stringify(r.keywords.slice(0, 10)),
      }),
    );
    n++;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`[致命] 写库失败已回滚：${String(err)}`);
  db.close();
  process.exit(1);
}

const total = db.prepare(`SELECT COUNT(*) n FROM review_queue WHERE kind = 'purity'`).get() as {
  n: number;
};
console.log('\n[完成]');
console.log(`  本次入队 ${n} 条，purity 类累计 ${total.n} 条`);
db.close();