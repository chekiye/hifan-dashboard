/**
 * 补齐季集与逐集剧集名（v5 统一主库的第二步）
 *
 * ⭐ 为什么必须做：用户要的看板是
 *   「剧名、原名、季度/季信息、逐集编号与剧集名」都很完整。
 *   v7 提升进主库的 357 部只有作品级字段 + episodes 数字，
 *   没有 season / episode / ep_name → 详情页开出来是空的，
 *   等于「把抓来的 TMDB 数据变成只有标题的列表」。
 *
 * ⭐ 前提变化（2026-10-14 实测）：
 *   之前记录「detail 接口全部 404」已作废 —— 现已恢复：
 *     /3/tv/{id}          → 200
 *     /3/tv/{id}/season/1 → 200
 *     /3/movie/{id}       → 200
 *   （在容器内、带 TMDB_PROXY 代理实测）
 *   所以现在可以正式补 season / episode / ep_name。
 *
 * 设计要点：
 *  1. **幂等 + 断点续跑** —— 已有季集的作品默认跳过，--force 可重拉
 *  2. **三语言取名** —— zh-CN 取真中文名（ja-JP 返回的是罗马字，铁律），
 *     ja-JP / en-US 作为回退，最终落到 name_original / name_zh
 *  3. **只补不删** —— 绝不 DELETE 已有季集
 *  4. **失败不中断** —— 单部失败记账继续，最后统一报告，可反复重跑补齐
 *
 * 用法（容器内）：
 *   node --experimental-strip-types dist/fill_episodes.js
 *   node --experimental-strip-types dist/fill_episodes.js --force      # 重拉全部
 *   node --experimental-strip-types dist/fill_episodes.js --limit=20    # 试跑
 *   node --experimental-strip-types dist/fill_episodes.js --only-origin=v7_merge
 *   node --experimental-strip-types dist/fill_episodes.js --images     # 同时下封面
 */
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import { MIGRATIONS } from '@hifan/core';

/**
 * node:sqlite 具名参数的 TS 类型要求
 *
 * ⚠️ 运行时传裸对象完全合法（实测 node 22.22 通过），
 *    但类型签名要 Record<string, SQLInputValue>，不接受 unknown。
 *    所以这里用 SQLInputValue[] 收窄成具体类型再传，避免每次 as unknown as 强转。
 */
type V = string | number | bigint | null | Uint8Array;
const P = (o: Record<string, V>): Record<string, V> => o;

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;
const API_KEY = process.env.TMDB_API_KEY || '';
const PROXY = process.env.TMDB_PROXY || '';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const RATE_MS = 260;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const IMAGES = args.includes('--images');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || Infinity;
const ONLY_ORIGIN = (args.find((a) => a.startsWith('--only-origin=')) || '').split('=')[1] || '';

if (!API_KEY) {
  console.error('[致命] 缺少 TMDB_API_KEY 环境变量');
  process.exit(1);
}

// ── 迁移（沿用 _migration 表约定） ──────────────────────────────
function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migration (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
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
      console.error(`[schema] migration #${i} 失败：${String(err)}`);
      process.exit(1);
    }
  }
  return db;
}

// ── HTTP（走代理，复用 collector 的做法） ───────────────────────
let agent: unknown = null;
async function getAgent() {
  if (!PROXY) return null;
  if (agent) return agent;
  const undici = (await import('undici')) as unknown as {
    ProxyAgent: new (p: string) => unknown;
  };
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

interface TmdbResp {
  status: number;
  body: Record<string, unknown>;
}

async function api(path: string): Promise<TmdbResp | null> {
  const dispatcher = await getAgent();
  const undici = (await import('undici')) as unknown as {
    request: (u: string, o: Record<string, unknown>) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;
  };
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${path}${sep}api_key=${API_KEY}`;
  await throttle();
  try {
    const res = await undici.request(url, {
      ...(dispatcher ? { dispatcher } : {}),
      headers: { accept: 'application/json' },
    });
    const text = await res.body.text();
    if (res.statusCode !== 200) return { status: res.statusCode, body: {} };
    return { status: 200, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return null;
  }
}

async function download(url: string, dest: string): Promise<boolean> {
  const dispatcher = await getAgent();
  const undici = (await import('undici')) as unknown as {
    request: (u: string, o: Record<string, unknown>) => Promise<{ statusCode: number; body: { arrayBuffer(): Promise<ArrayBuffer> } }>;
  };
  try {
    const res = await undici.request(url, dispatcher ? { dispatcher } : {});
    if (res.statusCode !== 200) return false;
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (buf.length < 512) return false;
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

// ── 主流程 ─────────────────────────────────────────────────────
interface Work {
  id: number;
  media_type: string;
  name_original: string | null;
  name_zh: string | null;
  year: number | null;
  episode_total: number;
  season_count: number;
  poster_path: string | null;
  poster_local: string | null;
  work_origin: string | null;
}

const db = open();

const where: string[] = [];
const params: Record<string, V> = {};
if (!FORCE) {
  // 只补没有季集的作品
  where.push(
    `NOT EXISTS (SELECT 1 FROM tmdb_episode e
                 WHERE e.work_id = w.id AND e.media_type = w.media_type)`,
  );
}
if (ONLY_ORIGIN) {
  where.push('w.work_origin = $origin');
  params.origin = ONLY_ORIGIN;
}
const limitSql = Number.isFinite(LIMIT) ? ' LIMIT ' + Math.floor(LIMIT) : '';

const works = db
  .prepare(
    `SELECT w.id, w.media_type, w.name_original, w.name_zh, w.year,
            w.episode_total, w.season_count, w.poster_path, w.poster_local, w.work_origin
     FROM tmdb_work w
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY w.media_type, w.id${limitSql}`,
  )
  .all(P(params)) as unknown as Work[];

console.log(
  `[范围] 待处理 ${works.length} 部${FORCE ? '（--force 全量重拉）' : '（仅缺季集）'}` +
    `${ONLY_ORIGIN ? `，来源=${ONLY_ORIGIN}` : ''}${IMAGES ? '，含封面下载' : ''}`,
);

// ⚠️ 全部用具名参数（$xxx），不与 ? 混用 ——
//    node:sqlite 不支持同一条语句里混用位置参数与具名参数，
//    且不允许传「SQL 中未使用」的具名参数。
const updWork = db.prepare(
  `UPDATE tmdb_work SET
     name_original   = COALESCE($name_original, name_original),
     name_zh         = COALESCE($name_zh, name_zh),
     first_air_date  = COALESCE($first_air_date, first_air_date),
     year            = COALESCE($year, year),
     episode_total   = CASE WHEN $episodes > 0 THEN $episodes ELSE episode_total END,
     season_count    = CASE WHEN $seasons > 0 THEN $seasons ELSE season_count END,
     poster_path     = COALESCE($poster_path, poster_path),
     backdrop_path   = COALESCE($backdrop_path, backdrop_path),
     popularity      = COALESCE($popularity, popularity),
     adult           = COALESCE(adult, $adult),
     genres          = COALESCE($genres, genres),
     fetched_at      = $fetched_at
   WHERE id = $id AND media_type = $mt`,
);

const updEp = db.prepare(
  `INSERT INTO tmdb_episode
     (work_id, media_type, season, episode, ep_name, air_date, runtime, still_path, overview)
   VALUES ($work_id, $media_type, $season, $episode, $ep_name, $air_date, $runtime, $still_path, $overview)
   ON CONFLICT(media_type, work_id, season, episode) DO UPDATE SET
     ep_name    = COALESCE(excluded.ep_name, tmdb_episode.ep_name),
     air_date   = COALESCE(excluded.air_date, tmdb_episode.air_date),
     runtime    = COALESCE(excluded.runtime, tmdb_episode.runtime),
     still_path = COALESCE(excluded.still_path, tmdb_episode.still_path),
     overview   = COALESCE(excluded.overview, tmdb_episode.overview)`,
);

const updPosterLocal = db.prepare(
  `UPDATE tmdb_work SET poster_local = $local
   WHERE id = $id AND media_type = $mt AND poster_local IS NULL`,
);

const { join } = await import('node:path');

let done = 0;
let epTotal = 0;
let namedEp = 0;
let imgOk = 0;
let imgSkip = 0;
const failures: Array<{ id: number; mt: string; why: string }> = [];

for (const w of works) {
  const mt = w.media_type as 'tv' | 'movie';
  const base = mt === 'tv' ? `/tv/${w.id}` : `/movie/${w.id}`;

  // ① 三语言详情：zh-CN 真中文名 + 原名 + 日期 + 集数
  const [dZh, dJa, dEn] = await Promise.all([
    api(`${base}?language=zh-CN`),
    api(`${base}?language=ja-JP`),
    api(`${base}?language=en-US`),
  ]);
  if (!dZh || dZh.status !== 200) {
    failures.push({ id: w.id, mt, why: `详情 ${dZh ? dZh.status : '网络失败'}` });
    continue;
  }

  const dz = dZh.body;
  const dj = dJa?.status === 200 ? dJa.body : {};
  const de = dEn?.status === 200 ? dEn.body : {};

  const orig =
    (dz.original_name as string) ||
    (dz.original_title as string) ||
    (dj.original_name as string) ||
    (dj.original_title as string) ||
    (de.original_name as string) ||
    w.name_original;

  // ⭐ 铁律：只有 zh-CN 请求返回的才是中文名；
  //    ja-JP 返回的是罗马字，绝不能写进 name_zh。
  const zh =
    (dz.name as string) || (dz.title as string) || w.name_zh || null;

  const date =
    (dz.first_air_date as string) || (dz.release_date as string) || w.year
      ? ((dz.first_air_date as string) ||
         (dz.release_date as string) ||
         (w.year ? `${w.year}-01-01` : null))
      : null;

  const totalEp =
    mt === 'tv'
      ? Number(dz.number_of_episodes ?? dz.number_of_seasons ? 0 : 0) || w.episode_total || 0
      : w.episode_total || 0;
  const nSeasons = Number(dz.number_of_seasons ?? 0);

  const genres = Array.isArray(dz.genres)
    ? JSON.stringify((dz.genres as Array<{ id: number }>).map((g) => g.id))
    : Array.isArray(dz.genre_ids)
      ? JSON.stringify(dz.genre_ids)
      : null;

  updWork.run(
    P({
      $id: w.id,
      $mt: mt,
      $name_original: orig ?? null,
      $name_zh: zh,
      $first_air_date: date,
      $year: date ? Number(date.slice(0, 4)) : (w.year ?? null),
      $episodes: totalEp,
      $seasons: nSeasons,
      $poster_path: (dz.poster_path as string) ?? null,
      $backdrop_path: (dz.backdrop_path as string) ?? null,
      $popularity: typeof dz.popularity === 'number' ? dz.popularity : null,
      $adult: dz.adult ? 1 : 0,
      $genres: genres,
      $fetched_at: new Date().toISOString(),
    }),
  );

  // ② 季集：tv 逐季拉 season 详情（才有逐集 ep_name）
  let epCount = 0;
  if (mt === 'tv') {
    for (let s = 1; s <= Math.max(nSeasons, 1); s++) {
      const sd = await api(`/tv/${w.id}/season/${s}?language=zh-CN`);
      // 中文名拿不到时回退英文（TMDB 剧集名常有中文翻译）
      const sdEn = sd?.status === 200 ? await api(`/tv/${w.id}/season/${s}?language=en-US`) : null;
      if (!sd || sd.status !== 200) continue;
      const eps = (sd.body.episodes as Array<Record<string, unknown>>) || [];
      const epsEn = (sdEn?.status === 200
        ? ((sdEn.body.episodes as Array<Record<string, unknown>>) || [])
        : []) as Array<Record<string, unknown>>;

      for (let i = 0; i < eps.length; i++) {
        const e = eps[i];
        const en = epsEn.find((x) => Number(x.episode_number) === Number(e.episode_number)) || {};
        // 逐集剧集名：中文优先 → 英文 → 空（用户明确要「剧集名」）
        const epName =
          (e.name as string) || (en.name as string) || (e.original_name as string) || null;
        updEp.run(
          P({
            $work_id: w.id,
            $media_type: mt,
            $season: s,
            $episode: Number(e.episode_number ?? i + 1),
            $ep_name: epName,
            $air_date: (e.air_date as string) || null,
            $runtime: typeof e.runtime === 'number' ? e.runtime : null,
            $still_path: (e.still_path as string) || null,
            $overview: (e.overview as string) || null,
          }),
        );
        epCount++;
        if (epName) namedEp++;
      }
    }
  } else if (mt === 'movie') {
    // 剧场版按「单集」记，跟原 M2 口径一致
    const movieName = (dz.title as string) || (dz.original_title as string) || orig || null;
    if (movieName) {
      updEp.run(
        P({
          $work_id: w.id,
          $media_type: mt,
          $season: 1,
          $episode: 1,
          $ep_name: movieName,
          $air_date: date,
          $runtime: typeof dz.runtime === 'number' ? dz.runtime : null,
          $still_path: (dz.poster_path as string) || null,
          $overview: (dz.overview as string) || null,
        }),
      );
      epCount++;
      if (movieName) namedEp++;
    }
  }

  // ③ 封面落地（只下库里的 project 目录，绝不碰媒体库）
  if (IMAGES) {
    const pp = (dz.poster_path as string) ?? w.poster_path;
    if (pp && !w.poster_local) {
      const rel = `poster/${mt}/${w.id}.jpg`;
      const url = `${IMAGE_BASE}/w500${pp.startsWith('/') ? pp : `/${pp}`}`;
      const okImg = await download(url, join(DATA, 'images', rel));
      if (okImg) {
        updPosterLocal.run(P({ $local: rel, $id: w.id, $mt: mt }));
        imgOk++;
      } else imgSkip++;
    } else if (w.poster_local) {
      imgSkip++;
    }
  }

  done++;
  epTotal += epCount;
  if (done % 20 === 0) {
    console.log(
      `  [进度] ${done}/${works.length} 季集累计 ${epTotal}（有剧集名 ${namedEp}）` +
        `${IMAGES ? ` 封面 ${imgOk}` : ''} 失败 ${failures.length}`,
    );
  }
}

db.close();

console.log('\n[完成]');
console.log(`  作品 ${done}/${works.length}`);
console.log(`  季集写入 ${epTotal}，其中有剧集名 ${namedEp}（${epTotal ? ((namedEp / epTotal) * 100).toFixed(1) : '0'}%）`);
if (IMAGES) console.log(`  封面下载 ${imgOk}，跳过/失败 ${imgSkip}`);
console.log(`  失败 ${failures.length}`);
for (const f of failures.slice(0, 15)) console.log(`   ✗ ${f.mt}/${f.id}：${f.why}`);
if (failures.length > 15) console.log(`   … 另有 ${failures.length - 15} 条`);