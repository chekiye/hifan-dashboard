/**
 * 数据库连接与迁移管理
 *
 * ⚠️ 位置铁律（docs/开发文档.md §2.4）：
 *    SQLite 禁止放在 /下载盘/（cifs 不支持 POSIX 文件锁、fuse.rclone 会断连）。
 *    生产环境必须落在 /your/local/dir/data/
 *
 * 💡 为什么用 node:sqlite 而不是 better-sqlite3（2026-10-13 实测决策）：
 *    better-sqlite3 是原生模块，Windows 开发机无 Visual Studio C++ 工具链时
 *    编译失败（实测 ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED）。
 *    Node 22 内置的 node:sqlite 无需任何编译，能力已实测对齐：
 *      WAL ✅ / 外键 ✅ / UNIQUE ✅ / 事务 ✅ / 中文 ✅ / SQLite 3.51.2
 *    对 Docker 部署额外收益：镜像无需编译工具链，构建零原生依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATIONS, CURRENT_MIGRATION_INDEX } from './schema.js';

/**
 * node:sqlite 的 DatabaseSync 与 better-sqlite3 API 高度相似，
 * 此处按本项目实际用到的能力定义最小接口面，避免类型过度约束。
 */
export interface DB {
  exec(sql: string): void;
  prepare(sql: string): DBStatement;
  close(): void;
  /**
   * PRAGMA 读取
   *
   * ⚠️ node:sqlite 没有 better-sqlite3 的 pragma() 方法，
   *    此方法是本项目自建的兼容封装（写入走 exec，读取走 query）。
   */
  pragma(text: string, opts?: { simple?: boolean }): unknown;
}

export interface DBStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * 违规路径检测：防止有人把 DB 放到网络挂载上
 *
 * ⚠️ 必须同时匹配 POSIX 风格（生产 NAS 内）与 Windows 风格（本地开发/测试）。
 *    早期实现只用 startsWith('/vol02')，在 Windows 上 resolve('C:\\vol02\\x.db')
 *    得到的绝对路径以盘符开头，前缀匹配失效 —— 冒烟测试实测捕获此缺陷。
 */
const FORBIDDEN_MOUNTS = [
  // POSIX 绝对路径（NAS 容器内生产环境）
  { pattern: /^\/vol02(\/|$)/, label: '/vol02' },
  { pattern: /^\/mnt\//, label: '/mnt' },
  { pattern: /^\/media\//, label: '/media' },
  // UNC 网络共享
  { pattern: /^\/\/[^/]+\//, label: 'UNC 网络路径' },
  { pattern: /^\\\\[^\\]+\\/, label: 'UNC 网络路径' },
  // Windows 盘符下的同名目录（如 C:\vol02\...）—— 视为不安全
  { pattern: /^[A-Za-z]:\\vol02(\\|$)/i, label: 'Windows \\vol02' },
  { pattern: /^[A-Za-z]:\\mnt(\\|$)/i, label: 'Windows \\mnt' },
];

export function assertDbPathSafe(dbPath: string): void {
  const abs = resolve(dbPath);
  const bad = FORBIDDEN_MOUNTS.find((m) => m.pattern.test(abs));
  if (bad) {
    throw new Error(
      `[安全拦截] 数据库路径 ${abs} 命中不安全挂载（${bad.label}）。\n` +
        `cifs/fuse 不支持 POSIX 文件锁，会导致 "database is locked" 或数据库文件损坏。\n` +
        `请改用本地卷，例如 /your/local/dir/data/dashboard.db`,
    );
  }
}

export interface OpenDbOptions {
  /** 数据库文件绝对路径，或 ':memory:' */
  path: string;
  /** 是否开启 WAL（生产建议 true；:memory: 时自动跳过） */
  wal?: boolean;
}

export function openDb(opts: OpenDbOptions): DB {
  const isMem = opts.path === ':memory:';
  if (!isMem) assertDbPathSafe(opts.path);

  if (!isMem) mkdirSync(dirname(opts.path), { recursive: true });

  const raw = new DatabaseSync(opts.path);
  const db = raw as unknown as DB;

  // pragma 兼容层：node:sqlite 原生不支持，这里封装出来
  //
  // ⚠️ 陷阱：node:sqlite 返回的 row 是 null-prototype 对象，
  //    不能直接 JSON.stringify / 模板字符串隐式转换（会抛
  //    "Cannot convert object to primitive value"）。冒烟测试实测捕获。
  //    因此这里统一转成普通对象再返回。
  db.pragma = function (text: string, o?: { simple?: boolean }): unknown {
    const sql = `PRAGMA ${text}`;
    const plain = (r: unknown): unknown =>
      r && typeof r === 'object' ? { ...(r as Record<string, unknown>) } : r;

    if (o?.simple) return plain(raw.prepare(sql).get());
    return (raw.prepare(sql).all() as unknown[]).map(plain);
  };

  // 关键 PRAGMA —— 长驻服务的稳定性靠这三行
  db.exec('PRAGMA foreign_keys = ON');
  if (!isMem) {
    // WAL: 读写并发不互斥，避免采集器写入时看板查询被拒
    if (opts.wal !== false) db.exec('PRAGMA journal_mode = WAL');
    // 5 秒拿不到锁就报错，避免无限等待造成的假死
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec('PRAGMA synchronous = NORMAL');

  preflightColumnCompat(db);
  migrate(db);
  return db;
}

/**
 * 迁移前置兼容层：修历史遗留的列名漂移
 *
 * ⚠️ 背景（2026-10-14，冒烟测试 scripts/smoke_v5.mjs 实测抓到）：
 *   schema v1 的建表 DDL 里写的是 name_original，而 v3 的 migration 却是
 *   `RENAME COLUMN name_ja TO name_original` —— 两者矛盾。
 *   线上库没暴露这个问题，是因为 v3 早被 _migration 标记为「已执行」，
 *   那条 RENAME 从未真正跑过；全新库则会直接报 `no such column: "name_ja"`。
 *
 *   SQLite 的 RENAME COLUMN 没有 IF EXISTS 语义，没法在 migration 文件里
 *   自判「有才改」。所以放在迁移之前做一次幂等的列名对齐：
 *     有 name_ja 且无 name_original → 改名（历史遗留库的真实需求）
 *     两者都有（极端情况）        → 搬数据后删旧列
 *     只有 name_original          → 不动（当前 schema 的正常路径）
 *
 *   这也是全项目唯一一处对 append-only 的破例，已在 schema.ts v3 处留档说明。
 */
function preflightColumnCompat(db: DB): void {
  const cols = new Set(
    (db
      .prepare(`SELECT name FROM pragma_table_info('tmdb_work')`)
      .all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (cols.size === 0) return; // 表还没建，交给 migration

  const hasJa = cols.has('name_ja');
  const hasOrig = cols.has('name_original');
  if (hasJa && !hasOrig) {
    db.exec('ALTER TABLE tmdb_work RENAME COLUMN name_ja TO name_original');
  } else if (hasJa && hasOrig) {
    db.exec(
      `UPDATE tmdb_work SET name_original = name_ja
       WHERE (name_original IS NULL OR name_original = '') AND name_ja IS NOT NULL`,
    );
    // SQLite 3.35+ 支持 DROP COLUMN；老版本则由 migration 建新表兜底
    try {
      db.exec('ALTER TABLE tmdb_work DROP COLUMN name_ja');
    } catch {
      /* SQLite < 3.35 不支持 DROP COLUMN，保留旧列无害 */
    }
  }
}

/** 执行未跑过的 migration。幂等 —— 重复调用安全。 */
export function migrate(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS _migration (
    idx        INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT idx FROM _migration').all() as Array<{ idx: number }>).map((r) => r.idx),
  );

  let count = 0;

  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (applied.has(i)) continue;
    // node:sqlite 无内建 transaction() 包装，手动管理保证原子性
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO _migration (idx, applied_at) VALUES (?, ?)').run(
        i,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      count++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration #${i} 失败并已回滚：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return count;
}

/** 查询已应用的 migration 数量，用于健康检查 */
export function getMigrationState(db: DB): { applied: number; expected: number; upToDate: boolean } {
  const row = db.prepare('SELECT COUNT(*) AS n FROM _migration').get() as { n: number };
  return {
    applied: row.n,
    expected: CURRENT_MIGRATION_INDEX,
    upToDate: row.n === CURRENT_MIGRATION_INDEX,
  };
}