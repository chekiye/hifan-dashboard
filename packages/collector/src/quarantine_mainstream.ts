/**
 * 隔离疑似非里番作品 —— 移出主看板，保留数据
 *
 * ⭐ 起因（2026-10-14 18:20，用户反馈「怎么有这么多根本不是里番的剧」）：
 *   按 popularity 排序即见端倪：美国老爹 225 / 瑞克和莫蒂 164 / 无敌少侠 105…
 *   而真里番热度几乎全部 < 60。
 *
 *   根因：v7 的 355 部里 **264 部 discovery_srcs='tmdb'** —— 只有 TMDB 自己收录，
 *   零片源验证。TMDB 的 hentai 关键词(198385) 误标了大量主流商业动画，
 *   而 v7 把「只有 TMDB 收录」也当成了确认条目提升进主库。
 *
 * ⭐ 判定来自 check_purity.ts 产出的 purity_report.json，
 *   且只取 verdict='likely_mainstream'（要求 ≥2 条独立硬证据）。
 *
 * ⭐ 隔离而非删除：
 *   - 库里的行、封面、季集**一行都不删**，只打一个标记
 *   - 看板上不显示（SQL 过滤），但随时能查回：UPDATE 去掉标记即恢复
 *   - 理由：这是「口径问题」，不是「数据错误」。删了万一判错就找不回来了。
 *
 * 用法（容器内）：
 *   node --no-warnings dist/quarantine_mainstream.js            # 按报告隔离
 *   node --no-warnings dist/quarantine_mainstream.js --apply    # 真写库
 *   node --no-warnings dist/quarantine_mainstream.js --restore  # 全部恢复
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from '@hifan/core';

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;
const REPORT = `${DATA}/purity_report.json`;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTORE = args.includes('--restore');

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

// ── 恢复模式 ──────────────────────────────────────────────────
if (RESTORE) {
  const n = db.prepare(`UPDATE tmdb_work SET is_quarantined = 0 WHERE is_quarantined = 1`).run();
  const left = db.prepare(`SELECT COUNT(*) n FROM tmdb_work WHERE is_quarantined = 1`).get() as {
    n: number;
  };
  console.log(`[恢复] 已解除隔离 ${n.changes} 条，剩余隔离 ${left.n} 条`);
  db.close();
  process.exit(0);
}

// ── 需要 is_quarantined 列 ────────────────────────────────────
const cols = (
  db.prepare(`SELECT name FROM pragma_table_info('tmdb_work')`).all() as Array<{ name: string }>
).map((r) => r.name);
if (!cols.includes('is_quarantined')) {
  db.exec(`ALTER TABLE tmdb_work ADD COLUMN is_quarantined INTEGER NOT NULL DEFAULT 0`);
  console.log('[schema] 已加 is_quarantined 列（0=正常 1=已隔离移出看板）');
}

/**
 * 🔴 人工豁免名单 —— 放这里 = **即使算法判成非里番也不隔离**。
 *
 * ⚠️ 2026-10-14 大幅精简：从 6 条降到 **0 条**（清空）。
 *
 * 为什么原来那 5 条老番（黑暗圣经/机械女警/Septem Charm/恋姫/红莲）不用豁免了？
 *   它们被误伤的原因是**关键词版规则**把「零热度 + 空简介 + 10759 标签」当非里番证据。
 *   换成语言学判据后 `name_original` 是日语（『La Blue Girl』『花と蛇』…）
 *   → 直接被 noJpEvidence 门禁挡住，根本进不了疑似主流池。
 *
 * ⭐ **豁免名单变短是规则变好的标志。**
 *   之前有一条 32726 开心汉堡店（带 hanime 验证却判非里番），
 *   实查是 **hanime 早年有美剧杂区**导致的片源污染 —— 它本来就该隔离，
 *   保留豁免反而是错的，已删除。
 *
 * ⚠️ 若将来确有「真里番被语言学判据误伤」的案例（应是极罕见，
 *    因为日语作品不可能是欧美商业动画），再往这里加，并写清理由。
 */
const MANUAL_KEEP = new Set<number>([]);

// ── 读报告 ───────────────────────────────────────────────────
let ids: number[] = [];
let kept: Array<{ id: number; name: string }> = [];
try {
  const rep = JSON.parse(readFileSync(REPORT, 'utf8')) as {
    results: Array<{ id: number; mediaType: string; name: string; year: number | null; popularity: number | null; verdict: string; reasons: string[] }>;
  };
  const flagged = rep.results.filter((r) => r.verdict === 'likely_mainstream');
  kept = flagged.filter((r) => MANUAL_KEEP.has(r.id));
  ids = flagged.filter((r) => !MANUAL_KEEP.has(r.id)).map((r) => r.id);
  console.log(`[报告] ${REPORT}`);
  console.log(`[判定] 疑似主流 ${flagged.length} 部，人工豁免 ${kept.length} 部，实际隔离 ${ids.length} 部`);
  if (kept.length) {
    console.log('\n[人工豁免 —— 确认是真里番，不隔离]');
    for (const k of kept) console.log(`  ${k.id} 「${k.name}」`);
  }
  console.log('\n[将隔离]');
  for (const r of flagged.filter((x) => !MANUAL_KEEP.has(x.id))) {
    console.log(`  ${r.id} ${String(r.year)} pop=${r.popularity?.toFixed(0) ?? '-'} 「${r.name}」`);
  }
} catch (err) {
  console.error(`[致命] 读不到 ${REPORT}：${String(err)}`);
  console.error('先跑 check_purity.js 生成报告');
  db.close();
  process.exit(1);
}

if (!ids.length) {
  console.log('[结果] 无需隔离');
  db.close();
  process.exit(0);
}

if (!APPLY) {
  console.log('\n[试运行] 加 --apply 才真正写库');
  db.close();
  process.exit(0);
}

// ── 写库 ─────────────────────────────────────────────────────
/**
 * ⚠️ node:sqlite 不允许传「SQL 中未使用」的具名参数，
 *    所以每条语句只能带它自己用到的键。
 */
const upd = db.prepare(`UPDATE tmdb_work SET is_quarantined = 1 WHERE id = $id`);

let marked = 0;
let skipped = 0;
db.exec('BEGIN');
try {
  for (const id of ids) {
    // 直接看 UPDATE 的 changes：0 说明库里没有这个 id（报告来自旧快照）
    const r = upd.run(P({ $id: id })) as unknown as { changes?: number };
    if (r.changes) marked++;
    else skipped++;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`[致命] 写库失败已回滚：${String(err)}`);
  db.close();
  process.exit(1);
}

const stat = db
  .prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN is_quarantined=1 THEN 1 ELSE 0 END) quarantined
     FROM tmdb_work`,
  )
  .get() as { total: number; quarantined: number | null };

console.log('\n[完成]');
console.log(`  标记隔离 ${marked} 条${skipped ? `（报告中 ${skipped} 条库里已不存在，跳过）` : ''}`);
console.log(`  库内总量 ${stat.total}，看板可见 ${stat.total - (stat.quarantined ?? 0)}`);
console.log('  ⚠️ 数据一行未删，恢复：node dist/quarantine_mainstream.js --restore');
db.close();