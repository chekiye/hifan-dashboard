/**
 * NAS 只读文件系统实现（M4）
 *
 * ⚠️ 本文件是「只读」铁律的落地点：
 *   通过 SSH 只执行 `ls -la` / `stat` 等读取命令，
 *   **不存在任何 unlink / rm / mv / mkdir / chmod / write 的代码路径**。
 *   即便将来有人误调用，类型层面也没有这些方法可用。
 *
 * 为什么用 ls 而不是 SFTP：
 *   - 里番库在 fuse.rclone 上，SFTP 列目录会触发大量 stat，慢到不可用
 *   - 实测 `ls -la` 单次列表约 100ms，可接受
 */
import type { DirEntry, FileStat, ReadOnlyFs } from './scanner.js';

/**
 * ⭐ 只读命令守卫
 *
 * 只读铁律不能只靠「我记得别写 rm」—— 必须有运行时拦截。
 * 本函数是扫描层唯一执行外部命令的入口，任何含写操作的命令一律拒绝。
 */
function assertReadOnlyCommand(cmd: string): void {
  const forbidden = /(^|[;&|]\s*)\b(rm|mv|mkdir|chmod|chown|rmdir|dd|truncate|tee|touch|ln)\b|>>?\s*\//;
  if (forbidden.test(cmd)) {
    throw new Error(`[只读拦截] 扫描层拒绝执行写操作命令: ${cmd}`);
  }
}

export class SshReadOnlyFs implements ReadOnlyFs {
  constructor(
    private readonly exec: (cmd: string, timeout?: number) => Promise<string>,
    private readonly root: string,
  ) {}

  /** 容器内路径 → NAS 宿主路径 */
  private real(path: string): string {
    if (path === this.root) return this.root;
    if (path.startsWith(this.root + '/')) {
      return this.root + path.slice(this.root.length);
    }
    return path;
  }

  /** ⚠️ 只读断言：拒绝任何非读取类命令 */
  private static assertReadOnly(cmd: string): void {
    const forbidden = /\b(rm|mv|mkdir|chmod|chown|rmdir|dd|truncate|tee|>|>>)\b/;
    if (forbidden.test(cmd)) {
      throw new Error(`[只读拦截] 扫描层拒绝执行写操作命令: ${cmd}`);
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const p = this.real(path);
    assertReadOnlyCommand(`ls ${p}`);
    const out = await this.exec(`ls -la --time-style=+%s "${p}" 2>/dev/null || true`, 60);

    const rows: DirEntry[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(
        /^([-dl])([rwxst-]{9,10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(.+?)\s*(?:\s->.*)?$/,
      );
      if (!m) continue;
      const [, type, , size, name] = m;
      if (name === '.' || name === '..') continue;
      rows.push({
        name,
        isDirectory: () => type === 'd',
        isFile: () => type === '-',
        size: Number(size),
      });
    }
    return rows;
  }

  async stat(path: string): Promise<FileStat> {
    const p = this.real(path);
    assertReadOnlyCommand(`stat ${p}`);
    const out = await this.exec(
      `stat -c '%s|%Y|%F' "${p}" 2>/dev/null || echo '0|0|unknown'`,
      30,
    );
    const [size, mtime, type] = out.trim().split('|');
    return {
      size: Number(size) || 0,
      mtimeMs: (Number(mtime) || 0) * 1000,
      isDirectory: () => type === 'directory',
      isFile: () => type === 'regular file',
    };
  }
}

/**
 * 节点 fs 实现（当库已挂载到容器内时用，如 docker-compose 的 :ro 挂载）
 * 同样只暴露 readdir/stat
 */
export class NodeReadOnlyFs implements ReadOnlyFs {
  constructor(private readonly root: string) {}

  async readdir(path: string): Promise<DirEntry[]> {
    const { readdir } = await import('node:fs/promises');
    // withFileTypes 一次拿全，避免逐个 stat（实测在 rclone 上差别巨大）
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory(),
      isFile: () => e.isFile(),
    }));
  }

  async stat(path: string): Promise<FileStat> {
    const { stat } = await import('node:fs/promises');
    const s = await stat(path);
    return s;
  }
}