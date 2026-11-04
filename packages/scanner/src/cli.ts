/**
 * 扫描 CLI —— 在 NAS 上直接跑（容器内 lib 已只读挂载）
 *
 * 用法：
 *   node dist/cli.js                      # 扫描默认顶层目录
 *   node dist/cli.js --top=已整理,待整理   # 指定顶层目录
 *   node dist/cli.js --root=/library      # 指定库根
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDb, type DB } from '@hifan/core';
import { LibraryScanner } from './scanner.js';
import { NodeReadOnlyFs } from './fs.js';

function loadEnvFile(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(dir, name);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadEnvFile();

async function main(): Promise<void> {
  const root = process.env.SCAN_LIBRARY_ROOT || '/library';
  const tops = (process.env.SCAN_TOP_DIRS || '已整理')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = (process.env.SCAN_EXCLUDE_DIRS || 'CloudDrive,115网盘挂载,@eaDir')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`[scan] 库根: ${root}`);
  console.log(`[scan] 顶层: ${tops.join(', ')}`);
  console.log(`[scan] 排除: ${exclude.join(', ')}`);

  const dbPath = process.env.DB_PATH || './data/hifan.db';
  const db: DB = openDb({ path: dbPath });

  const before = db
    .prepare('SELECT COUNT(*) n FROM local_work WHERE tmdb_id IS NOT NULL')
    .get() as { n: number };
  console.log(`[scan] 扫描前本地已登记作品: ${before.n}`);

  const scanner = new LibraryScanner({
    libraryRoot: root,
    includeTopDirs: tops,
    excludeDirs: exclude,
    crossDevice: false,
    fs: new NodeReadOnlyFs(root),
    onProgress: (p) => {
      process.stdout.write(
        `\r[scan] 作品 ${p.works} · 文件 ${p.files} · 错误 ${p.errors}   `,
      );
    },
  });

  const stats = await scanner.scan(db);
  process.stdout.write('\n\n');

  console.log('=== 扫描结果 ===');
  console.log(`  登记作品      ${stats.works}`);
  console.log(`  视频文件      ${stats.files}`);
  console.log(`  解析出季集号  ${stats.episodesResolved}`);
  console.log(`  低置信(卷次推) ${stats.lowConfidenceEpisodes}`);
  console.log(`  跳过(无tmdbid) ${stats.skippedNoTmdbId}`);
  console.log(`  ⚠️ tmdbid 不在主库 ${stats.tmdbIdNotInPool}  ← 本地有、主库没有`);
  console.log(`  错误          ${stats.errors}`);
  console.log('  各顶层:', JSON.stringify(stats.topDirCounts));

  const after = db
    .prepare(
      `SELECT COUNT(*) works,
              (SELECT COUNT(*) FROM local_file) files,
              (SELECT COUNT(*) FROM local_file WHERE episode IS NOT NULL) withEp
       FROM local_work WHERE tmdb_id IS NOT NULL`,
    )
    .get() as { works: number; files: number; withEp: number };
  console.log(`\n  库内确认: 作品 ${after.works} · 文件 ${after.files} · 有集号 ${after.withEp}`);

  db.close();
}

main().catch((err) => {
  console.error('\n[scan] 失败:', err);
  process.exit(1);
});