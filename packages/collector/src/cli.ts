/**
 * 采集 CLI —— 独立于 server 运行，便于分步验证
 *
 * 用法：
 *   node dist/cli.js keyword           仅通道A（keyword 枚举）
 *   node dist/cli.js keyword --episodes 附带季集元数据
 *   node dist/cli.js seed              仅通道B（已知id回补）
 *   node dist/cli.js all               两通道 + 季集
 *   node dist/cli.js stats             查看当前库存
 *   node dist/cli.js byyear            按年份看收录分布（数据全面性体检）
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDb, type DB } from '@hifan/core';
import { TmdbClient } from './client.js';
import { Collector, type CollectOptions } from './collector.js';
import { ImageFetcher } from './images.js';
import { fixNames, sampleTitles } from './fixnames.js';

/**
 * 极简 .env 加载（避免为一个功能引入额外依赖）
 * 依次尝试：.env.local（本地开发，真值）/ .env（容器内由 compose 注入）
 */
function loadEnvFile(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(dir, name);
      if (!existsSync(p)) continue;
      try {
        for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
          if (!m) continue;
          const [, k, raw] = m;
          if (process.env[k] !== undefined) continue; // 真实环境变量优先
          process.env[k] = raw.replace(/^["']|["']$/g, '');
        }
      } catch {
        /* 读不到就跳过 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function env(key: string, def = ''): string {
  return process.env[key]?.trim() || def;
}

async function main(): Promise<void> {
  loadEnvFile();
  const cmd = process.argv[2] ?? 'stats';
  const withEpisodes = process.argv.includes('--episodes');
  const yearFrom = Number(
    process.argv.find((a) => a.startsWith('--from='))?.split('=')[1] ?? 2000,
  );

  const dbPath = env('DB_PATH', './data/dashboard.db');
  const apiKey = env('TMDB_API_KEY');
  const proxy = env('TMDB_PROXY');

  if (!apiKey) {
    console.error(
      '缺少 TMDB_API_KEY。\n' +
        '  临时使用: TMDB_API_KEY=xxx node dist/cli.js keyword\n' +
        '  或复制 .env.example 为 .env 并填写。',
    );
    process.exit(1);
  }

  const db: DB = openDb({ path: dbPath });
  const client = new TmdbClient({
    apiKey,
    baseUrl: env('TMDB_BASE_URL', 'https://api.themoviedb.org/3'),
    proxy,
    rateLimitMs: Number(env('TMDB_RATE_LIMIT_MS', '250')),
    maxRetries: Number(env('TMDB_MAX_RETRIES', '3')),
  });

  console.log(`[cli] 数据库 ${dbPath}`);
  console.log(`[cli] 代理 ${proxy || '(未设置，可能超时)'}`);
  console.log(`[cli] 连通性: ${(await client.ping()) ? 'OK' : '失败'}`);
  if (!(await client.ping())) {
    console.error('[cli] TMDB 不可达，终止。检查 TMDB_PROXY 是否正确。');
    process.exit(1);
  }

  const collector = new Collector(db, client);
  const base: CollectOptions = {
    channel: 'keyword',
    yearFrom,
    keywordId: Number(env('TMDB_HENTAI_KEYWORD_ID', '198385')),
    withEpisodes,
    onProgress: (p) => {
      const pct = p.total ? ((p.processed / p.total) * 100).toFixed(1) : '0';
      process.stdout.write(`\r[${p.channel}/${p.phase}] ${p.processed}/${p.total} (${pct}%) 成功${p.succeeded} 失败${p.failed}   `);
      if (p.phase === 'done') process.stdout.write('\n');
    },
  };

  switch (cmd) {
    case 'keyword':
      await collector.collectByKeyword({ ...base, channel: 'keyword' });
      break;
    case 'seed':
      await collector.collectBySeed({ ...base, channel: 'seed' });
      break;
    case 'episodes':
      await collector.fillEpisodes('all', { ...base, channel: 'keyword' });
      break;
    case 'all':
      await collector.collectByKeyword({ ...base, channel: 'keyword', withEpisodes: true });
      await collector.collectBySeed({ ...base, channel: 'seed', withEpisodes: true });
      break;
    case 'stats':
      break;
    case 'fixnames': {
      const force = process.argv.includes('--force');
      const limitArg = process.argv.find((a) => a.startsWith('--limit='));
      const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
      await fixNames(db, client, { force, limit });
      sampleTitles(db);
      db.close();
      return;
    }
    case 'byyear':
      printByYear(db);
      db.close();
      return;
    case 'images': {
      // 封面下载：已存在则跳过，可反复执行
      const root = env('IMAGE_ROOT', './data');
      const fetcher = new ImageFetcher({
        imageBase: env('TMDB_IMAGE_BASE', 'https://image.tmdb.org/t/p'),
        imageApiKey: apiKey,
        rootDir: root,
        timeoutMs: 25_000,
        rateLimitMs: Number(env('IMAGE_RATE_LIMIT_MS', '120')),
      });

      // discover 枚举时已带 poster_path，这里直接读库
      const rows = db
        .prepare(
          `SELECT id, media_type, poster_path FROM tmdb_work
           WHERE poster_path IS NOT NULL AND poster_path <> ''
           ORDER BY id`,
        )
        .all() as Array<{ id: number; media_type: 'tv' | 'movie'; poster_path: string }>;

      console.log(`[images] 待处理封面 ${rows.length} 张，落盘到 ${root}/images`);
      let n = 0;
      const st = await fetcher.fetchPosters(
        rows.map((r) => ({ id: r.id, mediaType: r.media_type, posterPath: r.poster_path })),
        6,
        ({ id, ok }) => {
          n++;
          if (n % 50 === 0) console.log(`[images] ${n}/${rows.length}  下载${fetcher.stats.downloaded} 跳过${fetcher.stats.skipped} 失败${fetcher.stats.failed}`);
          if (!ok) return;
          // 回填本地相对路径，供看板引用
          db.prepare('UPDATE tmdb_work SET poster_local = ? WHERE id = ?')
            .run(`poster/${rows.find((r) => r.id === id)?.media_type}/${id}.jpg`, id);
        },
      );
      console.log(`[images] 完成：下载 ${st.downloaded}，跳过 ${st.skipped}，失败 ${st.failed}`);
      printByYear(db);
      db.close();
      return;
    }
    default:
      console.error(`未知命令: ${cmd}`);
      console.error('可用: keyword | seed | episodes | all | images | fixnames | stats | byyear');
      db.close();
      process.exit(1);
  }

  console.log('\n=== 当前库存 ===');
  const s = collector.stats();
  console.log(`  总计      ${s.total ?? 0} 部`);
  console.log(`  TV        ${s.tv ?? 0}`);
  console.log(`  MOVIE     ${s.movie ?? 0}`);
  console.log(`  来自关键词 ${s.fromKeyword ?? 0}`);
  console.log(`  来自id回补 ${s.fromSeed ?? 0}`);
  console.log(`  已有季集  ${s.withSeasons ?? 0}`);
  console.log(`  总集数    ${s.totalEpisodes ?? 0}`);
  console.log(`  请求统计  ${client.stats.requests} 次，失败 ${client.stats.failures}`);

  db.close();
}

/** 按年份打印收录分布 —— 这是「数据全面性」的核心体检表 */
function printByYear(db: DB): void {
  const rows = db
    .prepare(
      `SELECT year,
              COUNT(*) AS n,
              SUM(CASE WHEN media_type='tv' THEN 1 ELSE 0 END) AS tv,
              SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END) AS mv,
              SUM(CASE WHEN season_count>0 THEN 1 ELSE 0 END) AS withEp
       FROM tmdb_work
       WHERE year IS NOT NULL
       GROUP BY year
       ORDER BY year`,
    )
    .all() as Array<{ year: number; n: number; tv: number; mv: number; withEp: number }>;

  if (!rows.length) {
    console.log('库中暂无数据。请先运行: node dist/cli.js keyword');
    return;
  }

  const max = Math.max(...rows.map((r) => r.n));
  console.log('\n=== 按年份收录分布（数据全面性体检）===\n');
  for (const r of rows) {
    const bar = '#'.repeat(Math.round((r.n / max) * 40));
    const flag = r.n < 30 ? '  ⚠️ 偏少' : '';
    console.log(
      `${r.year}  ${String(r.n).padStart(4)} 部  ` +
        `tv:${String(r.tv).padStart(3)} mv:${String(r.mv).padStart(3)} ` +
        `有季集:${String(r.withEp).padStart(3)}  ${bar}${flag}`,
    );
  }

  const total = rows.reduce((s, r) => s + r.n, 0);
  const thin = rows.filter((r) => r.n < 30).map((r) => r.year);
  console.log(`\n合计 ${total} 部，跨 ${rows.length} 个年份（${rows[0].year}–${rows[rows.length - 1].year}）`);
  if (thin.length) {
    console.log(`⚠️  收录偏少的年份（<30 部），可能是 TMDB 收录不全或该年确实产量低：`);
    console.log(`    ${thin.join(', ')}`);
  } else {
    console.log('✅ 各年份收录量均在 30 部以上，分布均匀');
  }
}

main().catch((err) => {
  console.error('\n[cli] 执行失败:', err);
  process.exit(1);
});