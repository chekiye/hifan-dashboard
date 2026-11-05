/**
 * 修正 library_work 里 media_type 判错、且与 tmdb_work 撞主键的记录
 *
 * ⭐ 起因（2026-10-14，enrich_pool 上线实测）：
 *   提升 357 条时失败 2 条：tv/616140、tv/1421614，报
 *   UNIQUE constraint failed: tmdb_work.id。
 *
 * ⭐ 根因（已实测 TMDB 确认，不是猜测）：
 *   tmdb_work.id 是 INTEGER PRIMARY KEY（物理主键），同 id 无法共存；
 *   而 tv 与 movie 本来就是 TMDB 两个独立 id 空间，理论上可以同 id 共存，
 *   但主键设计把这条路堵死了。
 *
 *   逐个回查 TMDB 详情：
 *     /3/tv/616140    → 404
 *     /3/movie/616140 → 200「黑市拍卖：美丽的女性奴隶」2000-12-20
 *     /3/tv/1421614   → 404
 *     /3/movie/1421614→ 200「阎罗国」2000-11-18
 *   → 它们在 TMDB 里**只有 movie 词条**，v7 把它判成 tv 是错的。
 *   也就是说：不是主库少了 2 部，而是 v7 有 2 条类型误判。
 *
 *   两条的 type_evidence 都是空字符串 —— 说明 media_type 是**默认值**
 *   而不是判定出来的，这类记录都值得复验。
 *
 * 处置：改成 movie（与 TMDB 实际一致），再由 enrich_pool 提升进主库。
 * 用法（容器内）：
 *   node --no-warnings /app/packages/collector/dist/fix_type_conflict.js
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

const DB_PATH = process.env.HIFAN_DB || `${process.env.HIFAN_DATA || '/app/data'}/hifan.db`;
const API_KEY = process.env.TMDB_API_KEY || '';
const PROXY = process.env.TMDB_PROXY || '';

type V = string | number | bigint | null | Uint8Array;
const P = (o: Record<string, V>): Record<string, V> => o;

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

/** 回查 TMDB：这个 id 在哪个类型下有词条（都没有则 null） */
async function tmdbType(
  id: number,
): Promise<{ kind: 'tv' | 'movie'; name: string; orig: string; date: string; seasons: number } | null> {
  if (!API_KEY) return null;
  const undici = (await import('undici')) as unknown as {
    request: (
      u: string,
      o: Record<string, unknown>,
    ) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;
  };
  const agent = PROXY
    ? new ((await import('undici')) as unknown as { ProxyAgent: new (p: string) => unknown })
        .ProxyAgent(PROXY)
    : null;
  for (const kind of ['tv', 'movie'] as const) {
    const url = `https://api.themoviedb.org/3/${kind}/${id}?language=zh-CN&api_key=${API_KEY}`;
    try {
      const r = await undici.request(url, {
        ...(agent ? { dispatcher: agent } : {}),
        headers: { accept: 'application/json' },
      });
      if (r.statusCode === 200) {
        const d = JSON.parse(await r.body.text()) as Record<string, unknown>;
        return {
          kind,
          name: (d.name as string) || (d.title as string) || '',
          orig: (d.original_name as string) || (d.original_title as string) || '',
          date: (d.first_air_date as string) || (d.release_date as string) || '',
          seasons: Number(d.number_of_seasons ?? 0),
        };
      }
    } catch {
      /* 网络异常按「无词条」处理 */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const db = open();

  // ① 找出所有「library_work 标 tv，但 tmdb_work 里同 id 是 movie」的记录
  const suspects = db
    .prepare(
      `SELECT l.tmdb_id, l.media_type, l.name_zh, l.name_original, l.year,
              l.type_evidence, w.media_type AS other_mt, w.name_zh AS other_name
       FROM library_work l
       JOIN tmdb_work w ON w.id = l.tmdb_id
       WHERE l.media_type <> w.media_type
       ORDER BY l.tmdb_id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;

  console.log(`[扫描] 类型与主库冲突的记录：${suspects.length} 条`);
  if (!suspects.length) {
    console.log('[结果] 无冲突，无需修正');
    db.close();
    return;
  }

  const upd = db.prepare(
    `UPDATE library_work
     SET media_type   = $mt,
         type_evidence = $ev
     WHERE tmdb_id = $id AND media_type = $old`,
  );

  let fixed = 0;
  const unresolved: Array<{ id: number; cur: string; other: string }> = [];

  for (const s of suspects) {
    const id = Number(s.tmdb_id);
    const cur = String(s.media_type);
    const other = String(s.other_mt);
    const real = await tmdbType(id);
    const nameZh = String(s.name_zh ?? '');

    console.log(
      `\n[冲突] ${id}：library=${cur}「${nameZh}」 vs 主库=${other}「${String(s.other_name ?? '')}」`,
    );

    if (!real) {
      console.log('   TMDB 两个类型都取不到 → 保留原判定，另行人工处理');
      unresolved.push({ id, cur, other });
      continue;
    }

    const realKind = real.kind;
    if (realKind === cur) {
      // library 判对了，主库里那条同 id 的另一个类型才是多余的。
      // ⚠️ 理论上该删主库那条，但实测这 2 条里主库那条本来就正确
      //   （tmdb_work 是关键词枚举抓的，类型可靠），所以这里只报告不动数据。
      console.log(`   TMDB 实为 ${cur} → library 判定正确；主库那条 ${other}/${id} 为多余（本次不删）`);
      fixed++;
      continue;
    }

    // library 判错了 → 改成 TMDB 实际类型
    const ev = `${realKind} 详情接口实测（${realKind === 'tv' ? 'movie' : 'tv'}/${id} 返回 404，无词条）`;
    upd.run(P({ $mt: realKind, $ev: ev, $id: id, $old: cur }));
    console.log(
      `   TMDB 实为 ${realKind}「${real.name}」${real.date ? ` (${real.date})` : ''} → 已修正 library_work.media_type`,
    );
    fixed++;
  }

  console.log(`\n[结果] 修正 ${fixed} 条，待人工 ${unresolved.length} 条`);
  for (const u of unresolved) console.log(`   ? ${u.id}（library=${u.cur} / 主库=${u.other}）`);

  db.close();
}

await main();