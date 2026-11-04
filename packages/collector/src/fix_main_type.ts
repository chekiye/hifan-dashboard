/**
 * 复验并修正 **tmdb_work**（主库）的 media_type
 *
 * ⭐ 起因（2026-10-14 17:45，fill_episodes 全量试跑失败）：
 *   verify_media_type.ts 只 UPDATE library_work（证据档），
 *   **从没改过 tmdb_work** —— 而看板只读 tmdb_work。
 *   结果：v7 提升进来的 355 部里仍有 30 部标成 movie，
 *   详情接口按 movie 请求直接 404 → 季集一条都拉不到。
 *
 *   实测差异：
 *     tmdb_work    v7 来源：tv 325 / movie 30
 *     library_work v7 来源：tv  ... / movie 13   ← 已被上一个脚本改对
 *
 * ⭐ 判定规则（不猜，逐个实测）：
 *   /3/tv/{id} 与 /3/movie/{id} 各请求一次：
 *     只有 tv 200      → tv
 *     只有 movie 200   → movie
 *     两个都 200       → 按 number_of_seasons 多者判（tv 才有季集）
 *     两个都 404       → 不自动改，记账进人工清单
 *
 * ⚠️ media_type 是 tmdb_episode 的主键组成部分，
 *    改类型前必须把该 id 在另一种类型下的季集行删掉，
 *    否则会留下「孤儿季集」（work_id 相同、media_type 不同）。
 *
 * ⚠️ 只 UPDATE media_type，**绝不 DELETE tmdb_work 的行**。
 *
 * 用法（容器内）：
 *   node --no-warnings dist/fix_main_type.js --dry-run
 *   node --no-warnings dist/fix_main_type.js --only-v7
 *   node --no-warnings dist/fix_main_type.js --limit=50
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

const DB_PATH = process.env.HIFAN_DB || `${process.env.HIFAN_DATA || '/app/data'}/hifan.db`;
const API_KEY = process.env.TMDB_API_KEY || '';
const PROXY = process.env.TMDB_PROXY || '';
const RATE_MS = 260;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_V7 = args.includes('--only-v7');
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

/** 该 id 在指定类型下是否有词条 */
async function probe(
  id: number,
  kind: 'tv' | 'movie',
): Promise<{ ok: boolean; seasons: number; name: string }> {
  const dispatcher = await getAgent();
  const undici = (await import('undici')) as unknown as {
    request: (
      u: string,
      o: Record<string, unknown>,
    ) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;
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
  id: number;
  media_type: string;
  name_zh: string | null;
  name_original: string | null;
  year: number | null;
  work_origin: string | null;
}

const db = open();

const where: string[] = [];
const params: Record<string, V> = {};
if (ONLY_V7) where.push(`work_origin = 'v7_merge'`);
const limitSql = Number.isFinite(LIMIT) ? ` LIMIT ${Math.floor(LIMIT)}` : '';

const rows = db
  .prepare(
    `SELECT id, media_type, name_zh, name_original, year, work_origin
     FROM tmdb_work
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY media_type, id${limitSql}`,
  )
  .all(P(params)) as unknown as Row[];

console.log(
  `[范围] tmdb_work ${rows.length} 条${ONLY_V7 ? '（仅 v7 来源）' : '（全量复验）'}` +
    `${DRY ? '，试运行不写库' : ''}`,
);
if (!rows.length) {
  db.close();
  process.exit(0);
}

/**
 * ⭐ type_evidence 列只存在于 library_work（证据档），tmdb_work 里没有这一列。
 *   主库只承载「这条作品是什么」，不承载「凭什么这么判」——
 *   判定理由统一写进 library_work，主看板与详情页都不需要它。
 */
const upd = db.prepare(`UPDATE tmdb_work SET media_type = $mt WHERE id = $id AND media_type = $old`);

/** 判定理由写进证据档 library_work —— 主库不存这种内部信息 */
const updLib = db.prepare(`UPDATE library_work SET type_evidence = $ev WHERE tmdb_id = $id`);

/** ⚠️ media_type 是 tmdb_episode 主键的一部分 —— 换类型前必须清掉旧类型的季集行 */
const delEp = db.prepare(`DELETE FROM tmdb_episode WHERE work_id = $id AND media_type = $old`);

let same = 0;
let changed = 0;
let missing = 0;
const changedList: Array<{ id: number; from: string; to: string; name: string }> = [];
const missingList: Array<{ id: number; mt: string; name: string }> = [];

for (const r of rows) {
  const id = Number(r.id);
  const cur = String(r.media_type);
  const other = cur === 'tv' ? 'movie' : 'tv';

  const [a, b] = await Promise.all([probe(id, cur as 'tv' | 'movie'), probe(id, other as 'tv' | 'movie')]);

  let verdict: 'tv' | 'movie' | null = null;
  let ev = '';

  if (a.ok && !b.ok) {
    verdict = cur as 'tv' | 'movie';
    ev = `${cur} 详情实测命中，${other}/${id} 返回 404`;
  } else if (!a.ok && b.ok) {
    verdict = other as 'tv' | 'movie';
    ev = `${other} 详情实测命中（原判 ${cur}/${id} 返回 404）`;
  } else if (a.ok && b.ok) {
    // 两个类型都有词条：tv 才有季集，取季集多的一方
    verdict = a.seasons >= b.seasons ? (cur as 'tv' | 'movie') : (other as 'tv' | 'movie');
    ev = `tv(${a.seasons}季) 与 movie 均有词条，按季集多者判为 ${verdict}`;
  } else {
    missing++;
    missingList.push({ id, mt: cur, name: String(r.name_zh ?? r.name_original ?? '') });
    continue;
  }

  if (verdict === cur) {
    same++;
    if (!DRY) {
      // 幂等写回（no-op 也无害），顺带把判定理由记进证据档
      upd.run(P({ $mt: cur, $id: id, $old: cur }));
      updLib.run(P({ $ev: ev, $id: id }));
    }
  } else {
    changed++;
    changedList.push({ id, from: cur, to: verdict, name: String(r.name_zh ?? r.name_original ?? '') });
    if (!DRY) {
      // 先删旧类型季集（否则留下 media_type 对不上的孤儿行），再换类型
      delEp.run(P({ $id: id, $old: cur }));
      upd.run(P({ $mt: verdict, $id: id, $old: cur }));
      updLib.run(P({ $ev: ev, $id: id }));
    }
  }

  if ((same + changed) % 25 === 0) {
    console.log(
      `  [进度] ${same + changed}/${rows.length} 一致 ${same} 改动 ${changed} 两边都404 ${missing}`,
    );
  }
}

db.close();

console.log('\n[结果]');
console.log(`  判定与原值一致 ${same}`);
console.log(`  需要改类型     ${changed}`);
console.log(`  两边都 404     ${missing}（TMDB 已无此词条，需人工）`);
if (changedList.length) {
  console.log('\n[已改动明细]');
  for (const c of changedList) console.log(`  ${c.id}: ${c.from} → ${c.to}  「${c.name}」`);
}
if (missingList.length) {
  console.log('\n[两边都 404 —— 需人工]');
  for (const m of missingList) console.log(`  ${m.id} ${m.mt} 「${m.name}」`);
}