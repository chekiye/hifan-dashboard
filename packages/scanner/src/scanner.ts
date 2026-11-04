/**
 * NAS 只读扫描器（M4）
 *
 * ⚠️ 严格只读铁律（docs/开发文档.md §5.1）：
 *   本模块只使用 readdir / stat / 文件读取。
 *   绝不含 unlink / rename / mkdir / chmod / write 任何用户数据的代码路径。
 *
 * 实测的库结构（NAS 2026-10-13 探测）：
 *   /library/媒体目录/
 *     已整理/                                    ← 811 个作品目录，真正要扫的
 *       1999-スパイラル・オーヴァ[tmdbid=306519]/
 *         poster.jpg                             ← 附属，忽略
 *         Season 01/
 *           xxx - S01E01 - [ハニービット] ... [FWD-0018].mkv
 *
 * ⭐ 好消息：文件名里带 `S01E01`，可直接解析季集号，不必猜。
 *
 * 其他顶层目录（外字幕/待删除/待整理/视频/已改名…）不是 TMDB 标准结构，
 * 默认不扫（可通过 includeTopDirs 配置），避免把非基准内容算进缺口。
 */
import type { DB } from '@hifan/core';
import { parseTmdbIdFromDir } from '@hifan/core';

export interface ScanOptions {
  /** 库根路径（容器内为 /library） */
  libraryRoot: string;
  /** 要扫描的顶层子目录，默认只扫「已整理」 */
  includeTopDirs: string[];
  /** 必须排除的目录名（防递归进云挂载） */
  excludeDirs: string[];
  /** 是否跨文件系统（false = 不跨，默认安全） */
  crossDevice: boolean;
  /** 只读断言：传入的函数只能提供只读能力 */
  fs: ReadOnlyFs;
  onProgress?: (p: { works: number; files: number; errors: number }) => void;
}

/**
 * 只读文件系统接口
 *
 * 刻意**不暴露**任何写方法 —— 用类型系统保证扫描层无法写入用户数据。
 * 这是「只读」最可靠的实现方式：不是靠自觉，是靠接口里根本没有那个方法。
 */
export interface ReadOnlyFs {
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
}

export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  /** 条目大小（字节）；不保证所有实现都提供 */
  size?: number;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.flv', '.ts', '.m4v', '.rmvb']);

/**
 * tmdbid 解析实现在 @hifan/core —— matcher 也要读同一份，
 * 两处各写一份正则必然漂移（全角冒号、括号种类）。
 */
export { parseTmdbIdFromDir };

/** 从目录名提取 4 位年份（可能错写成 tmdbid，需谨慎） */
export function parseYearFromDir(dirName: string): number | null {
  const m = dirName.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1980 && y <= 2035 ? y : null;
}

/** 从 Season 目录名取季号：Season 01 / Season 00 都支持 */
export function parseSeasonFromDirName(dirName: string): number | null {
  const m = dirName.match(/season\s*(\d{1,2})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从文件名解析集号
 *
 * 优先级（实测文件名形态）：
 *   1. `S01E01` 标准写法 —— 最可靠
 *   2. `第3話` / `第03話` 日文话数
 *   3. `＃3` / `#3` 全角半角井号集号 —— 实测 129 个文件（GLOD 系列 OVA）
 *   4. `E01` 单独
 *   5. `Vol.1` / `Round 2` 等卷次（作为兜底，会标记低置信）
 */
export function parseEpisodeFromFile(
  fileName: string,
  seasonFromDir: number | null,
): { season: number; episode: number; confidence: 'high' | 'low' } | null {
  const noExt = fileName.replace(/\.[^.]+$/, '');

  // 1. S01E01 / s1e1 / S01 E01
  const m = noExt.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
  if (m) {
    return { season: Number(m[1]), episode: Number(m[2]), confidence: 'high' };
  }

  // 2. 第N話（汉字数字先转阿拉伯）
  const cn = noExt.match(/第\s*([0-9０-９一二三四五六七八九十百]+)\s*[話话]/);
  if (cn) {
    const n = cnToNumber(cn[1]);
    if (n) return { season: seasonFromDir ?? 1, episode: n, confidence: 'high' };
  }

  // 3. ＃N / #N / #N话
  //    实测：`OVA 夢見ル乙女 ＃3 [GLOD-0373].mkv` 全用全角井号表示分集，
  //    旧版漏掉这批 → 129 个文件 season/episode 全 NULL，
  //    表现为「目录在但一集都没匹配上」（owned=0 却列在缺集里）。
  const hash = noExt.match(/[＃#]\s*([0-9０-９]{1,3})/);
  if (hash) {
    const n = cnToNumber(hash[1]);
    if (n) return { season: seasonFromDir ?? 1, episode: n, confidence: 'high' };
  }

  // 4. 单独 E01
  const me = noExt.match(/\bE(\d{1,3})\b/i);
  if (me) {
    return { season: seasonFromDir ?? 1, episode: Number(me[1]), confidence: 'high' };
  }

  // 5. Vol.1 / Round.2 / Part.3 —— 低置信，可能与 TMDB 集号不对齐
  const mv = noExt.match(/\b(?:vol|round|part|stage)\s*[.・]?\s*(\d{1,3})\b/i);
  if (mv) {
    return { season: seasonFromDir ?? 1, episode: Number(mv[1]), confidence: 'low' };
  }

  return null;
}

function cnToNumber(s: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  // 全角数字
  if (/^[０-９]+$/.test(s)) {
    const v = Number(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  // 纯阿拉伯
  if (/^\d+$/.test(s)) {
    const v = Number(s);
    return v > 0 ? v : null;
  }
  // 汉字十位（十、十二、二十一…）
  if (/^[一二三四五六七八九十]+$/.test(s)) {
    if (s === '十') return 10;
    const idx = s.indexOf('十');
    if (idx >= 0) {
      const tens = idx === 0 ? 1 : map[s[idx - 1]] ?? 1;
      const ones = idx === s.length - 1 ? 0 : map[s[idx + 1]] ?? 0;
      return tens * 10 + ones;
    }
    let total = 0;
    for (const ch of s) total = total * 10 + (map[ch] ?? 0);
    return total || null;
  }
  return null;
}

export interface ScanStats {
  works: number;
  files: number;
  episodesResolved: number;
  lowConfidenceEpisodes: number;
  skippedNoTmdbId: number;
  /** 目录里有 tmdbid 但主库没这条（本地有、主库无 —— 重要的缺口信号） */
  tmdbIdNotInPool: number;
  errors: number;
  /** 顶层各目录的作品数（诊断用） */
  topDirCounts: Record<string, number>;
}

export class LibraryScanner {
  private stats: ScanStats = {
    works: 0, files: 0, episodesResolved: 0, lowConfidenceEpisodes: 0,
    skippedNoTmdbId: 0, tmdbIdNotInPool: 0, errors: 0, topDirCounts: {},
  };

  constructor(private readonly opts: ScanOptions) {}

  /** ⭐ 校验扫描根路径不落在云挂载的写法上（防止误配导致灾难性扫描） */
  private assertSafeRoot(): void {
    const root = this.opts.libraryRoot;
    for (const bad of ['CloudDrive', '115网盘挂载', '/downloads/']) {
      if (root.includes(bad) && !root.includes('1000-1-')) {
        throw new Error(
          `[扫描拦截] 扫描根 ${root} 疑似云挂载路径（含 "${bad}"）。\n` +
            `为避免触发大量无意义 IO，默认拒绝。请显式确认后调整配置。`,
        );
      }
    }
  }

  async scan(db: DB): Promise<ScanStats> {
    this.assertSafeRoot();

    const upsertWork = db.prepare(
      `INSERT INTO local_work (dir_path, dir_name, tmdb_id, media_type, parsed_title, parsed_year, scan_status, scanned_at)
       VALUES (?,?,?,?,?,?,'ok',?)
       ON CONFLICT(dir_path) DO UPDATE SET
         dir_name=excluded.dir_name, tmdb_id=excluded.tmdb_id,
         parsed_title=excluded.parsed_title, parsed_year=excluded.parsed_year,
         scan_status='ok', scan_error=NULL, scanned_at=excluded.scanned_at`,
    );
    // ON CONFLICT(dir_path) 命中 UNIQUE 约束，实测可用
    const getWorkId = db.prepare('SELECT id FROM local_work WHERE dir_path = ?');
    const delFiles = db.prepare('DELETE FROM local_file WHERE work_id = ?');
    const insFile = db.prepare(
      `INSERT INTO local_file (work_id, file_path, file_name, file_size, season, episode, extension)
       VALUES (?,?,?,?,?,?,?)`,
    );

/**
 * 主库里存在哪些 tmdb id —— 一次性载入 Set，避免每个目录查一次库。
 * 810 个目录 × 一次查询在 fuse 挂载上会很慢。
 *
 * ⚠️ is_quarantined 可能不存在（隔离机制是后加的）→ pragma 探测后降级。
 */
const poolIds = (() => {
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('tmdb_work')`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const visible = cols.includes('is_quarantined') ? 'WHERE is_quarantined = 0' : '';
  return new Set(
    (db.prepare(`SELECT id FROM tmdb_work ${visible}`).all() as Array<{ id: number }>).map((r) =>
      Number(r.id),
    ),
  );
})();
const tmdbExists = (id: number): boolean => poolIds.has(id);
console.log(`[scan] 主库可见 id ${poolIds.size} 个（用于外键校验）`);

    for (const top of this.opts.includeTopDirs) {
      const topPath = `${this.opts.libraryRoot}/${top}`;
      let entries: DirEntry[];
      try {
        entries = await this.opts.fs.readdir(topPath);
      } catch {
        continue; // 顶层目录不存在
      }

      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.isExcluded(entry.name)) continue;

        try {
          const n = await this.scanWork(db, `${topPath}/${entry.name}`, entry.name,
            upsertWork, getWorkId, delFiles, insFile, tmdbExists);
          if (n > 0) count++;
        } catch (err) {
          this.stats.errors++;
          if (this.stats.errors <= 5) {
            console.error(`[scan] ${entry.name} 失败: ${String(err).slice(0, 120)}`);
          }
        }
      }
      this.stats.topDirCounts[top] = count;
      console.log(`[scan] ${top} → ${count} 个作品`);
    }

    return this.stats;
  }

  private async scanWork(
    db: DB,
    dirPath: string,
    dirName: string,
    upsertWork: unknown,
    getWorkId: unknown,
    delFiles: { run(id: number): unknown },
    insFile: { run(...a: unknown[]): unknown },
    tmdbExists: (id: number) => boolean,
  ): Promise<number> {
    const rawId = parseTmdbIdFromDir(dirName);

    // 没有 tmdbid 的目录：记录但不参与缺口判定（避免污染基准）
    if (!rawId) {
      this.stats.skippedNoTmdbId++;
      return 0;
    }

    /**
     * 🔴 外键陷阱（实测第一个目录就踩到）
     *
     * `local_work.tmdb_id` 有 `FOREIGN KEY REFERENCES tmdb_work(id)`，
     * 而库里大量目录的 tmdbid **不在主库**：
     *   `1999-スパイラル・オーヴァ[tmdbid=306519]` → 1999 年，
     *   主库口径是 year >= 2000，这条本来就不该在库里
     * 直接写入会 `FOREIGN KEY constraint failed`，整批扫描全废。
     *
     * ⚠️ 这类目录**恰恰是最重要的信息** —— 它就是「本地有、主库没有」，
     *    正是产品要回答的问题之一，绝不能因为外键约束丢掉。
     *
     * → 做法：外键存 NULL，另用 `dir_name` 里解析出的原始 id 记在
     *    `scan_error` 之外的地方… 但表里没有这列，
     *    所以先记 `parsed_title`，并把原始 id 挂在 `dir_name`（本来就带着）。
     *    匹配阶段用 parseTmdbIdFromDir(dir_name) 复原，不依赖外键。
     */
    const tmdbId = tmdbExists(rawId) ? rawId : null;
    if (!tmdbId) {
      this.stats.tmdbIdNotInPool++;
    }

    const year = parseYearFromDir(dirName);
    const title = dirName
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[［］【】]/g, '')
      .replace(/^\d{4}[-\s_]*/, '')
      .trim();

    (upsertWork as { run(...a: unknown[]): unknown }).run(
      dirPath, dirName, tmdbId, 'tv', title, year, new Date().toISOString(),
    );

    const workId = (getWorkId as { get(p: string): { id: number } }).get(dirPath)?.id;
    if (!workId) return 0;

    // 重扫前清掉旧文件记录（这是唯一 DELETE，只作用于自己的库）
    delFiles.run(workId);

    // 遍历子项
    let children: DirEntry[];
    try {
      children = await this.opts.fs.readdir(dirPath);
    } catch {
      return 0;
    }

    let fileCount = 0;

    // 情况一：视频直接放在作品目录下（无 Season 层）
    const loose: string[] = [];
    // 情况二：有 Season 层
    const seasonDirs: Array<{ name: string; path: string; season: number | null }> = [];

    for (const ch of children) {
      if (this.isExcluded(ch.name)) continue;
      if (ch.isDirectory()) {
        const sn = parseSeasonFromDirName(ch.name);
        seasonDirs.push({ name: ch.name, path: `${dirPath}/${ch.name}`, season: sn });
      } else if (this.isVideo(ch.name)) {
        loose.push(ch.name);
      }
    }

/**
     * 登记一个视频文件。
     *
     * ⚠️ baseDir 必须由调用方传入 —— 季目录下的文件真实路径是
     *    `<作品目录>/Season 01/xxx.mkv`，而不是 `<作品目录>/xxx.mkv`。
     *    之前这里写死 `${dirPath}/${fileName}`，导致季目录里所有文件
     *    的 file_path 全部指回作品根目录（路径不存在），stat 也取不到大小。
     */
    const handle = async (fileName: string, seasonHint: number | null, baseDir: string) => {
      const fullPath = `${baseDir}/${fileName}`;
      let size = 0;
      try {
        size = (await this.opts.fs.stat(fullPath)).size;
      } catch {
      /* 取不到大小不影响入库 */
      }
      const parsed = parseEpisodeFromFile(fileName, seasonHint);

      insFile.run(
        workId,
        fullPath,
        fileName,
        size,
        parsed?.season ?? null,
        parsed?.episode ?? null,
        fileName.includes('.') ? `.${fileName.split('.').pop()}` : '',
      );
      if (parsed) {
        this.stats.episodesResolved++;
        if (parsed.confidence === 'low') this.stats.lowConfidenceEpisodes++;
      }
      this.stats.files++;
      fileCount++;
    };

    for (const f of loose) {
      await handle(f, null, dirPath);
    }

    for (const sd of seasonDirs) {
      let inner: DirEntry[];
      try {
        inner = await this.opts.fs.readdir(sd.path);
      } catch {
        continue;
      }
      for (const ch of inner) {
        if (ch.isDirectory() || this.isExcluded(ch.name)) continue;
        if (!this.isVideo(ch.name)) continue;
        await handle(ch.name, sd.season, sd.path);
      }
    }

    // 只登记了路径但完全解析不出集号的作品，不计入 works
    if (fileCount > 0) {
      this.stats.works++;
      return 1;
    }
    // 无视频的目录也记录，但不算一部作品
    this.stats.works++;
    return 0;
  }

  private isExcluded(name: string): boolean {
    return this.opts.excludeDirs.includes(name)
      || name.startsWith('.')
      || name.startsWith('@');
  }

  private isVideo(name: string): boolean {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return VIDEO_EXT.has(name.slice(dot).toLowerCase());
  }
}