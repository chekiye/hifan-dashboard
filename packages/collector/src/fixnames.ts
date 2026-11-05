/**
 * 中文名回填 —— 逐部用 language=zh-CN 重取标题
 *
 * 起因（2026-10-13）：首轮采集用 ja-JP 拉详情，name_zh 里存的是罗马字。
 * 本命令按 id 逐个重新取，修正 name_zh / name_original，并回填 poster_path 等详情字段。
 *
 * 断点续跑：cursor 记录「已成功处理到的最大 id」，
 * 中断后重跑会跳过已处理的（可用 --force 重来）。
 *
 * 用法：
 *   node dist/cli.js fixnames            只修没修过的
 *   node dist/cli.js fixnames --force    全部重修
 *   node dist/cli.js fixnames --limit 20 试跑前 20 部
 */
import type { DB } from '@hifan/core';
import { TmdbClient } from './client.js';

const JOB = 'fix_names';

export async function fixNames(
  db: DB,
  client: TmdbClient,
  opts: { force?: boolean; limit?: number } = {},
): Promise<{ total: number; fixed: number; withChinese: number; failed: number }> {
  // cursor = 已处理到的最大 id
  const job = db
    .prepare('SELECT cursor FROM job_state WHERE job_name = ?')
    .get(JOB) as { cursor: string | null } | undefined;

  const since = !opts.force && job?.cursor ? Number(job.cursor) : 0;

  const rows = (
    opts.limit
      ? db
          .prepare(
            `SELECT id, media_type FROM tmdb_work WHERE id > ?
             ORDER BY id LIMIT ?`,
          )
          .all(since, opts.limit)
      : db
          .prepare('SELECT id, media_type FROM tmdb_work WHERE id > ? ORDER BY id')
          .all(since)
  ) as Array<{ id: number; media_type: 'tv' | 'movie' }>;

  console.log(
    `[fix] 待处理 ${rows.length} 部${since ? `（从 id>${since} 继续）` : '（全量）'}`,
  );

  db.prepare(
    `INSERT INTO job_state (job_name, status, processed, updated_at)
     VALUES (?, 'running', 0, ?)
     ON CONFLICT(job_name) DO UPDATE SET status='running', updated_at=excluded.updated_at`,
  ).run(JOB, new Date().toISOString());

  let fixed = 0;
  let withChinese = 0;
  let failed = 0;
  let maxId = since;

  const update = db.prepare(
    `UPDATE tmdb_work SET
       name_original = ?,
       /* 🔴 COALESCE：fetchTitles 现在在「TMDB 无中文」时返回 null，
          若这里直接覆盖会把已有的真中文名清空 ⇒ 必须保留旧值 */
       name_zh       = COALESCE(?, name_zh),
       poster_path   = COALESCE(?, poster_path),
       backdrop_path = COALESCE(?, backdrop_path),
       fetched_at    = ?
     WHERE media_type = ? AND id = ?`,
  );
  const setCursor = db.prepare(
    `UPDATE job_state SET cursor = ?, processed = ?, succeeded = ?,
       failed = ?, updated_at = ? WHERE job_name = ?`,
  );

  for (const r of rows) {
    try {
      const { original, zh, hasChinese } = await client.fetchTitles(r.media_type, r.id);
      update.run(
        original,
        zh,
        null, // poster_path 已在 discover 阶段拿到，无需重复回填
        null,
        new Date().toISOString(),
        r.media_type,
        r.id,
      );
      fixed++;
      if (hasChinese) withChinese++;
      maxId = r.id;
    } catch (err) {
      failed++;
      // 失败不推进游标之外的逻辑，但 id 仍记录以免卡在同一处反复重试
      if (failed <= 3) {
        console.error(`[fix] ${r.media_type}/${r.id} 失败: ${String(err).slice(0, 120)}`);
      }
    }

    if (fixed % 25 === 0 || failed % 25 === 0) {
      const done = fixed + failed;
      const pct = rows.length ? ((done / rows.length) * 100).toFixed(1) : '0';
      process.stdout.write(
        `\r[fix] ${done}/${rows.length} (${pct}%) 有中文${withChinese} 失败${failed}   `,
      );
      setCursor.run(
        String(maxId),
        done,
        fixed,
        failed,
        new Date().toISOString(),
        JOB,
      );
    }
  }

  setCursor.run(String(maxId), fixed + failed, fixed, failed, new Date().toISOString(), JOB);
  process.stdout.write('\n');

  const rate = rows.length ? ((withChinese / fixed) * 100).toFixed(1) : '0';
  console.log(
    `[fix] 完成：修正 ${fixed} 部，其中 ${withChinese} 部确认为中文（${rate}%）��失败 ${failed}`,
  );
  db.prepare(
    `UPDATE job_state SET status = 'done', finished_at = ? WHERE job_name = ?`,
  ).run(new Date().toISOString(), JOB);

  return { total: rows.length, fixed, withChinese, failed };
}

/** 抽样展示修正效果 */
export function sampleTitles(db: DB, n = 12): void {
  const rows = db
    .prepare(
      `SELECT id, name_original, name_zh, year FROM tmdb_work
       WHERE year IS NOT NULL ORDER BY year DESC LIMIT ?`,
    )
    .all(n) as Array<{ id: number; name_original: string; name_zh: string; year: number }>;

  console.log('\n=== 抽样对照（original vs zh-CN）===');
  for (const r of rows) {
    const same = r.name_original === r.name_zh;
    console.log(
      `  ${r.year}  ${String(r.name_zh).padEnd(20)} ` +
        `← ${String(r.name_original).padEnd(28)} ${same ? '(无中文翻译)' : ''}`,
    );
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN name_zh <> name_original THEN 1 ELSE 0 END) differ,
              SUM(CASE WHEN name_zh = name_original THEN 1 ELSE 0 END) same
       FROM tmdb_work`,
    )
    .get() as { total: number; differ: number; same: number };

  console.log(
    `\n  总计 ${stats.total} 部 → 有中文译名 ${stats.differ}，无中文（显示原名）${stats.same}`,
  );
}