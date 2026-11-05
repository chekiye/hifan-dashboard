/**
 * 批量复验 media_type —— 用 TMDB 详情接口逐个确认
 *
 * ⭐ 起因（2026-10-14，fill_episodes 试跑实测）：
 *   试跑 8 部里 5 部失败，全是 movie/xxx 详情返回 404：
 *     movie/12306、73021、81138、83621、84503
 *   说明 v7 的 media_type 有相当比例是**默认值而非判定值** ——
 *   实测 library_work 里 type_evidence 为空的：
 *     tv 1360 / movie 30，共 1390 条（占 90%）
 *   只有 157 条（tv 154 / movie 3）真正做过类型判定。
 *
 * ⭐ 判定规则（简单可靠，不猜）：
 *   逐个请求 /3/tv/{id} 与 /3/movie/{id}：
 *     只有 tv 200      → tv
 *     只有 movie 200   → movie
 *     两个都 200       → 罕见，按 season 数多的一方判（tv 有季集，更可能是剧集）
 *     两个都 404       → 两边都不存在（该 id 已从 TMDB 下架/合并），不改，记账
 *
 * ⚠️ 只改 library_work.media_type（证据档），**绝不删 tmdb_work 的行**。
 *   主库那 1284 部是关键词枚举抓的，类型可靠。
 *
 * ⚠️ 限流 260ms/请求，1390 条 × 最多 2 次 ≈ 12 分钟，用 --limit 可分段跑。
 *
 * 用法（容器内）：
 *   node --no-warnings .../verify_media_type.js --dry-run     # 只报告不改
 *   node --no-warnings .../verify_media_type.js --limit=100
 *   node --no-warnings .../verify_media_type.js --only-empty  # 只验没证据的
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

const DB_PATH = process.env.HIFAN_DB || `${process.env.HIFAN_DATA || '/app/data'}/hifan.db`;
const API_KEY = process.env.TMDB_API_KEY || '';
const PROXY = process.env.TMDB_PROXY || '';
const RATE_MS = 260;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_EMPTY = args.includes('--only-empty');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || Infinity;

type V = string | number | bigint | null | Uint8Array;
const P = (o: Record<string, V>): Record<string, V> => o;

if (!API_KEY) {
  console.error('[致命] 缺少 TMDB_API_KEY');
  process.exit(1);
}

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migration (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
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

let agent: unknown = null;
async function getAgent(): Promise<unknown> {
  if (!PROXY) return null;
  if (agent) return agent;
  const undici = (await import('undici')) as unknown as { ProxyAgent: new (p: string) => unknown };
  agent = new undici.ProxyAgent(PROXY);
  return agent;
}

let lastAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastAt + RATE_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
}

/** 返回该 id 在指定类型下是否有词条 */
async function exists(id: number, kind: 'tv' | 'movie'): Promise<{ ok: boolean; seasons: number; name: string }> {
  const dispatcher = await getAgent();
  const undici = (await import('undici')) as unknown as {
    request: (u: string, o: Record<string, unknown>) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;
  };
  await throttle();
  const url = `https://api.themoviedb.org/3/${kind}/${id}?language=zh-CN&api_key=${API_KEY}`;
  try {
    const r = await undici.request(url, {
      ...(dispatcher ? { dispatcher } : {}),
      headers: { accept: 'application/json' },
    });
    if (r.statusCode !== 200) return { ok: false, seasons: 0, name: '' };
    const d = JSON.parse(await r.body.text()) as Record<string, unknown>;
    return {
      ok: true,
      seasons: Number(d.number_of_seasons ?? 0),
      name: ((d.name as string) || (d.title as string) || '').trim(),
    };
  } catch {
    return { ok: false, seasons: 0, name: '' };
  }
}

interface Row {
  tmdb_id: number;
  media_type: string;
  name_zh: string | null;
  year: number | null;
  type_evidence: string | null;
}

const db = open();
const where: string[] = [];
const params: Record<string, V> = {};
if (ONLY_EMPTY) where.push(`(type_evidence IS NULL OR type_evidence = '')`);
const limitSql = Number.isFinite(LIMIT) ? ` LIMIT ${Math.floor(LIMIT)}` : '';

const rows = db
  .prepare(
    `SELECT tmdb_id, media_type, name_zh, year, type_evidence
     FROM library_work
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY media_type, tmdb_id${limitSql}`,
  )
  .all(P(params)) as unknown as Row[];

console.log(
  `[范围] ${rows.length} 条${ONLY_EMPTY ? '（仅无判定依据的）' : '（全量复验）'}${DRY ? '，试运行不写库' : ''}`,
);
if (!rows.length) {
  db.close();
  process.exit(0);
}

const upd = db.prepare(
  `UPDATE library_work SET media_type = $mt, type_evidence = $ev
   WHERE tmdb_id = $id AND media_type = $old`,
);

let same = 0;
let changed = 0;
let missing = 0;
const changedList: Array<{ id: number; from: string; to: string; name: string }> = [];
const missingList: Array<{ id: number; mt: string; name: string }> = [];

for (const r of rows) {
  const id = Number(r.tmdb_id);
  const cur = String(r.media_type);
  const other = cur === 'tv' ? 'movie' : 'tv';

  const [a, b] = await Promise.all([exists(id, cur as 'tv' | 'movie'), exists(id, other as 'tv' | 'movie')]);

  let verdict: 'tv' | 'movie' | null = null;
  let ev = '';

  if (a.ok && !b.ok) {
    verdict = cur as 'tv' | 'movie';
    ev = `${cur} 详情接口实测命中，${other}/${id} 返回 404`;
  } else if (!a.ok && b.ok) {
    verdict = other as 'tv' | 'movie';
    ev = `${other} 详情接口实测命中（原判 ${cur}/${id} 返回 404）`;
  } else if (a.ok && b.ok) {
    // 两个类型都有词条：TMDB 里 tv/movie 独立 id 空间才可能，取季集多的
    verdict = a.seasons >= b.seasons ? (cur as 'tv' | 'movie') : (other as 'tv' | 'movie');
    ev = `tv(${a.seasons}季) 与 movie 均有词条，按季集多者判为 ${verdict}`;
  } else {
    missing++;
    missingList.push({ id, mt: cur, name: String(r.name_zh ?? '') });
    continue;
  }

  if (verdict === cur) {
    same++;
    if (!DRY && !r.type_evidence) {
      upd.run(P({ $mt: cur, $ev: ev, $id: id, $old: cur }));
    }
  } else {
    changed++;
    changedList.push({ id, from: cur, to: verdict, name: String(r.name_zh ?? '') });
    if (!DRY) upd.run(P({ $mt: verdict, $ev: ev, $id: id, $old: cur }));
  }

  const n = same + changed;
  if (n % 100 === 0) {
    console.log(`  [进度] ${n}/${rows.length} 一致 ${same} 改动 ${changed} 两边都无 ${missing}`);
  }
}

console.log('\n[结果]');
console.log(`  判定与原值一致 ${same}`);
console.log(`  需要改类型     ${changed}`);
console.log(`  两边都 404     ${missing}（TMDB 已无此词条，需人工）`);
if (changedList.length) {
  console.log('\n[改类型明细]');
  for (const c of changedList.slice(0, 40)) {
    console.log(`  ${c.id}: ${c.from} → ${c.to}  「${c.name}」`);
  }
  if (changedList.length > 40) console.log(`  … 另有 ${changedList.length - 40} 条`);
}
if (missingList.length) {
  console.log('\n[两边都 404]');
  for (const m of missingList.slice(0, 25)) console.log(`  ${m.id} (${m.mt}) 「${m.name}」`);
  if (missingList.length > 25) console.log(`  … 另有 ${missingList.length - 25} 条`);
}
console.log(DRY ? '\n（试运行，未写库）' : '\n（已写库）');

db.close();