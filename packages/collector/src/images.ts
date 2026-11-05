/**
 * 图片采集 —— 封面图 + 剧集剧照(still)
 *
 * 为什么必须下载到本地（而不是看板直连 TMDB 图床）：
 *   1. TMDB 图片 CDN 需要 image CDN key，裸路径返回 401
 *   2. 直连图床会让看板完全依赖外网，看板打开就是 9~22 秒白屏
 *   3. 1459 部 × 封面 = 约 1459 张，直连图床会反复请求同一资源
 *   落地后看板只读本地静态文件，快且可离线。
 *
 * 存储布局（data 目录下，与 sqlite 同盘）：
 *   images/poster/{media_type}/{id}.jpg        竖版封面（2:3）
 *   images/still/{id}_s{season}_e{ep}.jpg     剧集剧照（16:9）
 *
 * ⚠️ 只写项目自己的 data 目录，绝不写用户媒体库。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, access, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface ImageFetcherOptions {
  /** TMDB 图片基址 */
  imageBase: string;
  /** 图片 CDN key（不含 key 时图片接口返回 401） */
  imageApiKey: string;
  /** 落地根目录（项目 data 下） */
  rootDir: string;
  /** 请求超时 */
  timeoutMs: number;
  /** 限流间隔 */
  rateLimitMs: number;
}

export interface ImageStats {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

export class ImageFetcher {
  private lastAt = 0;
  stats: ImageStats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };

  constructor(private readonly opts: ImageFetcherOptions) {}

  /** 完整图片 URL。size 用 TMDB 标准规格，避免下载超大原图。 */
  buildUrl(pathOrNull: string | null, kind: 'poster' | 'still'): string | null {
    if (!pathOrNull) return null;
    const p = pathOrNull.startsWith('/') ? pathOrNull : `/${pathOrNull}`;
    const size = kind === 'poster' ? 'w500' : 'w500';
    const base = this.opts.imageBase.endsWith('/') ? this.opts.imageBase : `${this.opts.imageBase}/`;
    return `${base}${size}${p}`;
  }

  /** 目标本地路径 */
  targetFor(
    mediaType: 'tv' | 'movie',
    id: number,
    kind: 'poster' | 'still',
    season = 0,
    episode = 0,
  ): string {
    const base = resolve(this.opts.rootDir, 'images', kind);
    return kind === 'poster'
      ? join(base, mediaType, `${id}.jpg`)
      : join(base, `${id}_s${season}_e${episode}.jpg`);
  }

  /**
   * 下载一张图（已存在则跳过）
   * @returns 'downloaded' | 'skipped' | 'failed' | 'noop'
   */
  async fetch(
    pathOrNull: string | null,
    mediaType: 'tv' | 'movie',
    id: number,
    kind: 'poster' | 'still',
    season = 0,
    episode = 0,
  ): Promise<'downloaded' | 'skipped' | 'failed' | 'noop'> {
    const url = this.buildUrl(pathOrNull, kind);
    if (!url) return 'noop';

    const dest = this.targetFor(mediaType, id, kind, season, episode);

    // 已存在且非空 → 跳过（断点续跑的关键）
    try {
      const st = await stat(dest);
      if (st.size > 0) {
        this.stats.skipped++;
        return 'skipped';
      }
    } catch {
      /* 不存在则继续下载 */
    }

    // 限流
    const wait = this.opts.rateLimitMs - (Date.now() - this.lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();

    // 写临时文件再改名，避免中断产生半张图
    const tmp = `${dest}.tmp`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: { accept: 'image/*' },
      });
      if (!res.ok || !res.body) {
        this.stats.failed++;
        return 'failed';
      }

      await mkdir(dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      await unlink(dest).catch(() => {});
      const { rename } = await import('node:fs/promises');
      await rename(tmp, dest);

      this.stats.downloaded++;
      return 'downloaded';
    } catch {
      this.stats.failed++;
      await unlink(tmp).catch(() => {});
      return 'failed';
    }
  }

  /** 批量下载封面（并发受限，避免打爆 CDN） */
  async fetchPosters(
    list: Array<{ id: number; mediaType: 'tv' | 'movie'; posterPath: string | null }>,
    concurrency = 4,
    onEach?: (r: { id: number; ok: boolean }) => void,
  ): Promise<ImageStats> {
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < list.length) {
        const item = list[idx++];
        const r = await this.fetch(item.posterPath, item.mediaType, item.id, 'poster');
        onEach?.({ id: item.id, ok: r === 'downloaded' || r === 'skipped' });
      }
    });
    await Promise.all(workers);
    return this.stats;
  }
}