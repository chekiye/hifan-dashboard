/**
 * ⭐ §92（2026-10-30）自研刮削入库 —— 把「识别 → 取 TMDB → 写 NFO → 下图片 → 改名落位」
 *    整套搬进 8848，**与 MoviePilot 完全分开**。
 *
 * ## 🔴 为什么改（蛙哥原话）
 * 「我不想你调用 MP 刮削，我想把 MP 那一套流程搬进去 8848 看板，和 MP 分开。」
 *
 * 上一版（§91）是**驱动 MP** 去做整理。产物对了，但代价是：
 * 看板的一条龙必须依赖 MP 在线、MP 的目录配置、MP 的 API_TOKEN，
 * 任何一环改了都要回头对；而且 MP 一升级接口就可能变。
 * ⇒ 现在把流程搬进来：自己打 TMDB、自己写 nfo、自己下图片、自己复制落位。
 *
 * ## ✅ 与 MP 产物的对齐依据（不是猜，是逐字节比出来的）
 * 2026-10-30 用 MP 跑过的那部（缘之空 / 1LDK）产物：
 * ```
 * 剧名 (年) [tmdbid=N]/
 *   tvshow.nfo  poster.jpg  fanart.jpg  backdrop.jpg  logo.png  clearlogo.png
 *   season01-poster.jpg  banner.jpg  landscape.jpg  thumb.jpg
 *   Season 1/
 *     season.nfo  poster.jpg
 *     剧名 - S01E10 - 鸟之穹鸣.mp4
 *     剧名 - S01E10 - 鸟之穹鸣.nfo
 *     剧名 - S01E10 - 鸟之穹鸣.jpg
 * ```
 * 本模块逐项复刻：目录名格式、文件名格式（` - SxxExx - 集名`）、
 * tvshow.nfo / season.nfo / episode.nfo 的字段集合与顺序（Emby 靠这些字段识别）。
 *
 * ## ⛔ 铁律
 * - nfo 里 plot/outline 用 CDATA，⛔ 不转义（否则换行变实体，Emby 显示成一坨）
 * - 视频先写 `.part` 再 rename ⇒ 中途失败不会留下「看起来完整」的半截文件
 * - **已有同尺寸目标文件就不重复复制**（一条龙点两次不该复制两遍）
 * - 集名缺失时用 `第 N 集`（与 MP 一致，⛔ 不写空）
 * - 图片失败**不算整集失败**（nfo+视频才是 Emby 识别的关键），只记 warning
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, join } from 'node:path';
/* §93 中文名判据复用采集器那一份（0lx：判据多处拷贝 ⇒ 同一函数共用） */
import { pickChineseName, Http } from '@hifan/collector';
/* §93 目录名 → tmdbid 的解析复用 core 那一份（它本来就兼容 {} / [] / 全角） */
import { parseTmdbIdFromDir } from '@hifan/core';
/* 🔴 F24：复制带「无进展」看护 —— 裸 pipeline 在 FUSE 卡住时永不 resolve */
import { copyWithStall } from './copy_stall.js';
import { config } from './config.js';
/* ⭐⭐ §135 外挂字幕：mteam 那条路的集多数是「视频 + 同目录同名 .ass」，
   不搬字幕 = Emby 里这集没字幕（实测 2154 个字幕里 2080 个是这种配法） */
import { findSubtitleFor } from './mt_source.js';

export interface ScrapeConfig {
  /** 媒体库根目录（容器内），如 /library/CloudDrive/影视/影视资源/大电影/里番 */
  libraryRoot: string;
  tmdb: {
    apiKey: string;
    baseUrl: string;
    /** 代理（大陆直连 TMDB 会超时）*/
    proxy: string;
    rateLimitMs: number;
    maxRetries: number;
    timeoutMs: number;
  };
  /** 图片基址，默认 https://image.tmdb.org/t/p */
  imageBase: string;
  /** 落库后通知 Emby 刷新该库（best-effort，失败不影响结果） */
  embyRefresh: boolean;
  /**
   * 🔴 F24：单集**复制阶段「无进展」超时**（毫秒）—— ⛔ 不是刮削总时长。
   *
   *   原来的 `timeoutMs` 注释写「单集刮削超时（含复制 250MB）」，但全代码**零消费**
   *   ⇒ 复制那行 `await pipeline(read(115挂载) → write(媒体库))` 根本没看护，
   *   FUSE 不响应时永不 resolve，而 worker 单并发 ⇒ 一集卡死整条队列停摆。
   *   现在真消费它：目标文件连续这么久「一点没长」就中断、抛 copy_stalled、释放 worker。
   *   见 `copy_stall.ts` 顶部注释（含「为什么不能按总时长判」）。
   */
  copyStallMs?: number;
  /**
   * 🔴 N2（2026-10-31 复核报告）：ENOENT 时用来判「这库到底是不是真的新的」。
   *   返回 true = 库里有过成功入库记录 ⇒ 媒体库**曾经存在过**
   *   ⇒ 现在库根读不出来只可能是挂载没就绪（⛔ 不是新库）。
   *
   *   ⚠️ 锚点必须用 `work_ingest` 的历史 done 计数，**⛔ 不能用 `tmdb_work` 计数**：
   *      看板库有 1635 部作品，与媒体目录是两回事，新部署时它同样非空 ⇒ 会把新库误杀。
   */
  libraryEverUsed?: () => boolean;
  /**
   * N2 的人工放行开关（`SCRAPE_ALLOW_NEW_ROOT=1`）。
   * 默认 false：库根不存在且有过入库历史 ⇒ 判为「疑似挂载未就绪」，抛错不新建。
   * 真要把库挪到新路径 / 重来一遍，用这个显式放行 —— ⛔ 别为此去删 work_ingest。
   */
  allowNewRoot?: boolean;
}

export interface ScrapeItem {
  /** 源文件（容器内路径）*/
  srcPath: string;
  tmdbId: number;
  season: number;
  episode: number;
  /**
   * 库里已存的**中文名**（`tmdb_work.name_zh`），有就优先用它命名目录/文件。
   *
   * 🔴 2026-10-30 §93 实测踩到：TMDB 对 `舞意間變成狗…`（195081）请求
   *    `language=zh-CN` 直接返回**日文原名** `犬になったら好きな人に拾われた。`
   *    —— 它的中文译名只挂在 `zh-TW` 下。
   *    而 `tmdb_work.name_zh` 是采集器用 `pickChineseName()`（含汉字+不含假名）
   *    校验过的，本来就是中文 ⇒ 有它就不用再赌 TMDB 的语言回落。
   */
  titleHint?: string | null;
}

/* ══════════════════════════════════════════════════════════════════
   ⭐ §93 刮削八步进度上报（2026-10-30 蛙哥：刮削要能在看板看到进度）

   ## 为什么需要
   本轮之前 `ingest()` 是个黑盒：调进去只有「成功 / 失败」两种回声。
   卡在「拉季详情」还是「复制 800MB 进 115 挂载」看不出来，只能等超时
   —— 而这恰恰是排查「为什么这部一直不入库」唯一需要知道的信息。

   ## 设计
   - `key` 稳定不变（前端据此点亮第几格），`label` 可以随时改文案
   - `sub` 是**步骤内部**的细分进度，只有真能细分的步骤才给：
       · images   9 张剧级图 → done/total = 第几张
       · copy     复制大文件 → done/total = 已复制字节
     ⛔ 不给的步骤（如「拉 TMDB 详情」）就是一次请求，硬造百分比等于造假。

   ## ⛔ 回调必须轻
   worker 在 onStep 里写库 + 更新内存状态。⛔ 不要在这里做 await 的 IO ——
   它夹在 pipeline / TMDB 请求之间，阻塞会直接拖慢刮削。
   ══════════════════════════════════════════════════════════════════ */
export type ScrapeStepKey =
  | 'stat' | 'detail' | 'tvshow' | 'images' | 'season' | 'seasonnfo' | 'copy' | 'epnfo';

export interface ScrapeStep {
  key: ScrapeStepKey;
  /** 中文说明（看板直接显示这个） */
  label: string;
  /** 第几步（1 起） */
  idx: number;
  /** 共几步 */
  total: number;
  /** 步骤内部细分；没有就 null（⛔ 不硬造百分比） */
  sub?: { done: number; total: number; unit: '张' | 'B' } | null;
}

export type ScrapeStepFn = (e: ScrapeStep) => void;

/** 内部用的简写上报器（ingest 里按 key 报，自动补 label/idx/total） */
type StepAt = (key: ScrapeStepKey, sub?: ScrapeStep['sub']) => void;

/** 八步的固定清单 —— 看板拿这个画「未开始」的灰格 */
export const SCRAPE_STEPS: Array<{ key: ScrapeStepKey; label: string }> = [
  { key: 'stat', label: '读源文件' },
  { key: 'detail', label: '拉 TMDB 详情' },
  { key: 'tvshow', label: '写 tvshow.nfo' },
  { key: 'images', label: '下剧级图' },
  { key: 'season', label: '拉季详情' },
  { key: 'seasonnfo', label: '写 season.nfo' },
  { key: 'copy', label: '复制视频' },
  { key: 'epnfo', label: '写集 NFO + 剧照' },
];

export interface ScrapeResult {
  ok: boolean;
  /** 库里最终路径 */
  target?: string | null;
  /**
   * ⭐ §135 配套外挂字幕的落位路径。
   * null = 源侧这一集本来就没有外挂字幕（四成的集是内嵌字幕或本身无字幕）——
   * ⛔ 别把 null 当成「字幕丢了」，那是两件事（0cs）。
   */
  subTarget?: string | null;
  title?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  message?: string | null;
  /** scrape_failed / tmdb_offline / tmdb_notfound / copy_failed / src_missing */
  code?: string;
  retryable?: boolean;
  warnings?: string[];
  ms?: number;
}

/** 从 `剧名 - S01E12 - 集名.mp4` 拆集名（保留给旧数据用） */
export function episodeTitleOf(target: string | null | undefined): string | null {
  if (!target) return null;
  const base = target.split('/').pop() ?? '';
  const m = / - S\d{1,2}E\d{1,3} - (.+)\.[A-Za-z0-9]{2,5}$/.exec(base);
  return m ? m[1].trim() : null;
}

/** XML 文本转义（⛔ plot/outline 不走这里，它们用 CDATA） */
function xesc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CDATA 包裹（`]]>` 必须断开，否则 XML 直接坏） */
function cdata(s: unknown): string {
  const t = String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${t}]]>`;
}

/**
 * 判「这算不算导演」。
 *
 * ## 实测基准（缘之空 / 68005，2026-10-30）
 * | 来源 | job | 算不算 |
 * |---|---|---|
 * | 剧级 crew | `Series Director` 高桥丈夫 | ✅ |
 * | 剧级 crew | `Sound Director` 岩浪美和 | ⛔ 音响监督 |
 * | 剧级 crew | `Director of Photography` 大和田亨 | ⛔ 摄影 |
 * | 剧级 crew | `Art Direction` 小濱俊裕 | ⛔ 美术 |
 * | 集级 crew | `Director` 三瓶圣 | ✅ |
 * | 集级 crew | `Animation Director` ×3 | ⛔ **作画监督**，不是导演 |
 * | 集级 crew | `Supervising Animation Director` | ⛔ **总作画监督** |
 * MP 的 episode.nfo 恰好就是「高桥丈夫 + 三瓶圣」两个 ⇒ 证明它也只认精确的 Director。
 *
 * ## 🔴 剧级刻意不复刻 MP
 * MP 的 tvshow.nfo 写的是 山中隆弘 / 川﨑とも子 / 平木大辅 ——
 * 这三个在 TMDB 是 **Producer / Associate Producer**，真导演高桥丈夫反倒没写。
 * 照抄等于让 Emby 的「导演」字段显示制片人 ⇒ 不复刻这个 bug。
 */
function isDirector(x: any): boolean {
  const job = String(x?.job ?? '').trim();
  if (!job) return false;
  if (/Animation|Animator|Sound|Photography|Art Direction|Assistant|Casting/i.test(job)) return false;
  return job === 'Director' || job === 'Series Director' || job === 'Episode Director';
}

/**
 * 文件名净化。
 *
 * 🔴 只处理**文件系统层面**的非法字符（`/` 与 NUL），
 *    `？＋～` 这类全角符号**必须保留** —— 现有一千多部库里就有
 *    「1LDK＋JK 突然间展开同居？」，改掉就与 MP 时代的历史目录对不上，
 *    Emby 会当成两部不同的剧。
 */
export function safeName(s: string, fallback = '未命名'): string {
  const t = String(s ?? '').replace(/[/\u0000]/g, '_').replace(/\s+/g, ' ').trim();
  return t || fallback;
}

/**
 * 从**已有目录名**里取回「剧名」部分（去掉 `(年)` 与 `[tmdbid=N]` / `{tmdbid=N}`）。
 *
 * 用途：沿用历史目录时，里面的文件都是按这个前缀命名的
 * （例如 `少女波子汽水 - S01E01 - 第1话 …`），新落的那一集必须用同一个前缀，
 * 否则同一部剧里会出现两种片名。
 *
 * ⚠️ 括号里的内容也一并去掉：`少女波子汽水 (2016) {tmdbid=85174}` → `少女波子汽水`
 */
export function titleOfDirName(dirName: string): string {
  return String(dirName ?? '')
    .replace(/\s*[[{]tmdbid\s*[:=]\s*\d{2,8}[\]}]\s*$/i, '')
    .replace(/\s*[（(]\s*\d{4}\s*[)）]\s*$/, '')
    .trim();
}

/**
 * 新建作品目录名：`剧名 (年) [tmdbid=N]` —— **方括号**。
 *
 * 🔴 为什么是方括号（2026-10-30 §93-3 蛙哥定「[] 才是标准」）
 *  这是 **Emby 官方文档的 ID 标签写法**，MoviePilot 也照这个来。
 *  老库 429 / 461 个目录是 `{tmdbid=N}`（蛙哥早年整理脚本产的）——
 *  Emby 两种都认（实测都能读到 Tmdb），但标准只有一个。
 *
 *  蛙哥原话：「[]，才是标准命名…后续按照[]为准」
 *  ⇒ 新建一律方括号。老目录要不要全量改，另行决定（429 部是另一件事）。
 *
 * ⚠️ 已有目录**永远优先沿用**（见 `findExistingDir`）—— 这里只决定"没有时新建叫什么"。
 *    所以老库那 429 个花括号目录不会被这个改动动到。
 */
export function buildDirName(title: string, year: number | null, tmdbId: number): string {
  const y = year ? ` (${year})` : '';
  return `${safeName(title)}${y} [tmdbid=${tmdbId}]`;
}

const COUNTRY: Record<string, string> = {
  JP: 'Japan', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', KR: 'South Korea',
  US: 'United States of America', GB: 'United Kingdom', FR: 'France', DE: 'Germany',
};

const GENRE_ZH: Record<number, string> = {
  16: '动画', 18: '剧情', 35: '喜剧', 10749: '爱情', 12: '冒险', 14: '奇幻',
  27: '恐怖', 53: '惊悚', 9648: '悬疑', 10765: '科幻奇幻', 99: '纪录',
};

/**
 * TMDB 客户端（只读）。
 *
 * 🔴 用 undici 的 `ProxyAgent` 走代理 —— 实测大陆直连 api.themoviedb.org 超时；
 *    容器内代理可用（§88/§90 已验）。
 */
class TmdbApi {
  private lastAt = 0;
  private dispatcher: unknown;
  /** ⭐ §157：dispatcher/Http 都是按「当时的代理」建的 —— 代理在看板改了必须重建 */
  private dispatcherFor: string | undefined;
  /** ⭐ §126：走 collector 的 `Http`（内含 DNS 污染兜底：固定 CloudFront IP + SNI） */
  private http: Http;

  constructor(
    private readonly cfg: ScrapeConfig['tmdb'],
    /** 图片基址，如 https://image.tmdb.org/t/p */
    readonly imageBase: string,
  ) {
    this.http = new Http(cfg.proxy);
    this.httpProxyMirror = cfg.proxy;
  }

  private async get(): Promise<any> {
    if (this.dispatcher !== undefined && this.dispatcherFor === this.cfg.proxy) {
      return this.dispatcher;
    }
    this.dispatcherFor = this.cfg.proxy;
    if (!this.cfg.proxy) {
      this.dispatcher = null;
      return null;
    }
    try {
      const { ProxyAgent } = await import('undici');
      this.dispatcher = new ProxyAgent(this.cfg.proxy);
    } catch {
      this.dispatcher = null;
    }
    return this.dispatcher;
  }

  /** ⭐ §157：代理变化时同步重建 Http（DNS 污染兜底客户端也持有代理） */
  private httpProxyMirror: string;
  private httpFor(): Http {
    if (this.httpProxyMirror !== this.cfg.proxy) {
      this.http = new Http(this.cfg.proxy);
      this.httpProxyMirror = this.cfg.proxy;
    }
    return this.http;
  }

  async json(path: string, params: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams({ ...params, api_key: this.cfg.apiKey }).toString();
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}?${qs}`;
    const dispatcher = await this.get();
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      // 限流（TMDB 容忍 0.25 秒/请求）
      const wait = this.cfg.rateLimitMs - (Date.now() - this.lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      try {
        const { fetch: ufetch } = await import('undici');
        const res = await ufetch(url, {
          ...(dispatcher ? { dispatcher: dispatcher as never } : {}),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        if (res.status === 404) {
          const e = new Error(`TMDB 404: ${path}`) as Error & { code?: string };
          e.code = 'tmdb_notfound';
          throw e;
        }
        if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        const code = (e as { code?: string }).code;
        if (code === 'tmdb_notfound') throw e;
        if (attempt === this.cfg.maxRetries) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    // ── §126 兜底：代理 / 直连都挂了 ⇒ 走「DNS 污染绕过」
    //    病根：api.themoviedb.org 的 DNS 被污染到 Twitter/Facebook 段，
    //    域名怎么解析都到不了；代理那台 7890 的 CONNECT 隧道能建但握手后立刻 EOF。
    //    collector 的 `Http` 里实现了「固定 CloudFront IP + SNI 仍为真域名」的兜底。
    if (this.cfg.baseUrl.includes('api.themoviedb.org')) {
      try {
        return await this.httpFor().fetchJson(url, this.cfg.timeoutMs);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'tmdb_notfound') throw e;
        lastErr = e;
      }
    }
    const err = new Error(
      `TMDB 取不到 ${path}：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    ) as Error & { code?: string };
    err.code = 'tmdb_offline';
    throw err;
  }

  /** 图片下载（走同一代理；⛔ 图床不需要 api_key） */
  async image(relPath: string, dest: string, size = 'original'): Promise<number> {
    const base = this.imageBase.replace(/\/+$/, '');
    const full = `${base}/${size === 'original' ? 'original' : size}${relPath}`;
    const dispatcher = await this.get();
    const { fetch: ufetch } = await import('undici');
    const res = await ufetch(full, {
      ...(dispatcher ? { dispatcher: dispatcher as never } : {}),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
      headers: { accept: 'image/*' },
    });
    if (!res.ok || !res.body) throw new Error(`图片 HTTP ${res.status}`);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    await pipeline(
      (await import('node:stream')).Readable.fromWeb(res.body as never),
      createWriteStream(tmp),
    );
    await unlink(dest).catch(() => {});
    await rename(tmp, dest);
    const st = await stat(dest);
    return st.size;
  }

}

/** 小工具：把相对路径拼成 TMDB 图床完整 URL（nfo 里写绝对 URL 给 Emby 用） */
function imgUrl(imageBase: string, size: string, rel: string): string {
  return `${imageBase.replace(/\/+$/, '')}/${size}${rel}`;
}

/**
 * 刮削器 —— 一集一次，串行执行（由 IngestWorker 调度）。
 *
 * ⛔ 不做并发下载图片：一集要拿 ~6 张图，12 集并发会打爆图床并被限流。
 */
export class Scraper {
  private cache = new Map<string, { at: number; data: any }>();
  /** `${tmdbId}:${season}` → 库里已有的目录名（null = 确实没有） */
  private dirOf = new Map<string, string | null>();
  /** 媒体库根目录列表的 60 秒快照（一个 tmdbId 可能对应多个目录，历史遗留重复） */
  private listCache: { at: number; byId: Map<number, string[]> } | null = null;

  private readonly api: TmdbApi;

  constructor(private readonly cfg: ScrapeConfig) {
    this.api = new TmdbApi(this.cfg.tmdb, this.cfg.imageBase);
  }

  private async cached(path: string, params: Record<string, string>): Promise<any> {
    const key = `${path}?${JSON.stringify(params)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const data = await this.api.json(path, params);
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  /** 新建时的目录名。实现见模块级 `buildDirName()`（导出以便断言，0lx 判据只留一份） */
  private dirNameOf(title: string, year: number | null, tmdbId: number): string {
    return buildDirName(title, year, tmdbId);
  }

  /**
   * 这部作品在库里**已经**有目录了吗？有就返回目录名（不带父路径）。
   *
   * 🔴 为什么必须找（2026-10-30 §93 实测踩到，最贵的一个坑）
   *  老库 **429 / 461** 个目录是 `{tmdbid=N}`（花括号，你的整理脚本产的），
   *  只有 32 个是 `[tmdbid=N]`（MP 与我这套上午产的）。
   *  我第一版只用 `/\[tmdbid=(\d+)\]/` 去找 ⇒ 花括号目录全部漏掉 ⇒
   *  把**已经有 6 集**的《少女波子汽水》当成"纯新增"，又建了一个只有 1 集的目录
   *  ⇒ Emby / CMS 里同一部剧出现两条。
   *
   *  解析走 `parseTmdbIdFromDir`（core 里的**唯一实现**，它本来就兼容
   *  `[tmdbid:X]` / `｛tmdbid：X｝` / `(tmdbid=X)` 以及全角括号）。
   *  ⛔ 不要在这里再写一份正则 —— 那正是"判据多处拷贝"的老路。
   *
   * ⚠️ readdir 结果按 60 秒 TTL 缓存：一集刮削会查一次，但连续刮整部时别每次都
   *    readdir 462 个 FUSE 目录（那盘是 CloudDrive，读目录不是零成本）。
   */
  private async findExistingDir(tmdbId: number, season: number): Promise<string | null> {
    const root = this.cfg.libraryRoot;
    const key = `${tmdbId}:${season}`;
    /* 本次运行里已经查过 / 刚建过 ⇒ 直接用，⛔ 不重复 readdir */
    if (this.dirOf.has(key)) return this.dirOf.get(key) ?? null;

    const now = Date.now();
    const fresh = this.listCache && now - this.listCache.at < 60_000;
    if (!fresh) {
      try {
        const names = (await readdir(root)).filter((n) => !n.startsWith('.'));
        const map = new Map<number, string[]>();
        for (const n of names) {
          const id = parseTmdbIdFromDir(n);
          if (id == null) continue;
          const arr = map.get(id);
          if (arr) arr.push(n);
          else map.set(id, [n]);
        }
        this.listCache = { at: now, byId: map };
      } catch (e) {
        /* 🔴🔴 F1（2026-10-31 代码审查）：读不到媒体库时**绝不能**当成「没有已有目录」。
         *
         *   原实现写的是 `listCache = 空 Map`（"至少不会崩"），但它接着在下面
         *   `dirOf.set(key, null)` —— 而 `dirOf` **没有 TTL**（入口 :411 永久短路）。
         *   ⇒ 一次 FUSE 抖动 / 容器先于 NAS 挂载启动，这部作品在**进程整个生命周期**里
         *     都"没有目录" ⇒ 新建 `剧名 (年) [tmdbid=N]`，而老库 93% 是 `{tmdbid=N}`
         *   ⇒ 同一部剧两个目录、Emby 两条 —— 正是 §93 自称"最贵的一个坑"的静默复燃。
         *
         *   ⚠️ 但 **ENOENT 是合法的**：首次运行 libraryRoot 还不存在（mkdir 在后面才建）。
         *     一律抛错会让新库永远起不来 ⇒ 必须按错误码区分（0r38：说清在什么条件下）。
         */
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          /* 🔴🔴 N2（2026-10-31 复核报告）：在这台机器上 **ENOENT ≠ 新库**。
           *
           *   SCRAPE_LIBRARY_ROOT = `/library/CloudDrive/影视/...`，而 `CloudDrive`
           *   是 CloudDrive2 的 **FUSE 挂载点**（compose 只挂父目录 /115挂载父目录）。
           *   NAS 重启后 FUSE 没恢复时，`/library/CloudDrive` 只是一个**空普通目录**
           *   ⇒ 往下 readdir 必 ENOENT ⇒ 若当成「全新空库」就会 `mkdir -p` 把整棵树
           *     建在**挂载点底下的真实 ext4** 里 ⇒ 文件写进去、work_ingest 记 done，
           *     而 FUSE 挂回来之后这些文件被**遮蔽** ⇒ Emby/CMS 永远看不到，静默数据损失。
           *
           *   ⚠️ 这不是假想：compose 注释里记着 2026-10-28 13:04 真实发生过
           *      「NAS 重启 → 115 的 rclone 挂载没自动恢复」。
           *
           *   判据：库里有过成功入库（`work_ingest.done_at` 非空）⇒ 媒体库曾经存在
           *   ⇒ 现在读不出来只可能是挂载问题 ⇒ 抛 retryable，看板红着等挂载恢复。
           *   真·新库（计数 0）完全不受影响。
           */
          if (!this.cfg.allowNewRoot && this.cfg.libraryEverUsed?.()) {
            const err = new Error(
              `媒体库根目录读不到（ENOENT），但库里有历史入库记录 ⇒ 疑似 115/CloudDrive ` +
                `挂载未就绪，⛔ 不新建目录（否则文件会写进挂载点底下的真实目录、挂载恢复后被遮蔽）：` +
                `${root} —— 挂载恢复后会自动重试；确认是要把库挪到新路径，设 SCRAPE_ALLOW_NEW_ROOT=1`,
            ) as NodeJS.ErrnoException;
            err.code = 'library_unmounted';
            throw err;
          }
          this.listCache = { at: now, byId: new Map() };
        } else {
          /* 抛错 ⇒ `ingest()` 外层 catch 转成 retryable 失败（code 保留 EIO/EACCES…）
             ⇒ 看板上这一集红着、下轮重试。⛔ 不缓存、⛔ 不新建目录。 */
          const err = new Error(
            `读不到媒体库根目录，无法判断是否已有目录（⛔ 不新建，避免重复目录）：${root} — ${(e as Error).message}`,
          ) as NodeJS.ErrnoException;
          err.code = code ?? 'EIO';
          throw err;
        }
      }
    }
    const hits = this.listCache!.byId.get(tmdbId) ?? [];
    let pick: string | null = null;
    if (hits.length === 1) {
      pick = hits[0];
    } else if (hits.length > 1) {
      /* 🔴 同一部作品有多个目录（历史遗留：{tmdbid=N} 和 [tmdbid=N] 并存）。
         按【该季已有文件数】挑最全的那个 —— 字典序会选中 `[`（0x5B < 0x7B），
         结果把新集写进只有 1 集的新目录，而放着 6 集的历史目录不管（85174 实测踩到）。
         并列时再看顶层文件数，再并列才按名字顺序（保证可复现）。 */
      const scored: Array<{ n: string; s: number; t: number }> = [];
      for (const n of hits) {
        let s = 0;
        try {
          s = (await readdir(join(root, n, `Season ${season}`))).length;
        } catch {
          /* 没有这一季 */
        }
        let t = 0;
        try {
          t = (await readdir(join(root, n))).length;
        } catch {
          /* 读不到 */
        }
        scored.push({ n, s, t });
      }
      scored.sort((a, b) => b.s - a.s || b.t - a.t || a.n.localeCompare(b.n));
      pick = scored[0].n;
      console.log(
        `[scrape] ⚠️ work ${tmdbId} 有 ${hits.length} 个目录，选「${pick}」` +
          `（各季文件数 ${scored.map((x) => `${x.n}=${x.s}`).join(' / ')}）`,
      );
    }
    /* ⚠️ 这里连 null 一起缓存是**故意**的（一部作品 12 集，别每集 readdir 一遍 462 个 FUSE 目录）。
       F1 修完后这么写才安全：能走到这里，说明上面那次 readdir **确实成功过**
       （或者确实是 ENOENT 新库），失败已经在 catch 里抛出去了 ⇒ null 是「真没有」，不是「没查成」。 */
    this.dirOf.set(key, pick);
    return pick;
  }

  /**
   * 定标题。优先级：**库里的中文名 → TMDB zh-CN → TMDB zh-TW → 原名**。
   *
   * 🔴 为什么要四级（2026-10-30 实测踩到，§93）
   *  TMDB 对 195081 请求 `language=zh-CN` **返回日文原名**
   *  `犬になったら好きな人に拾われた。`（该条目的中文译名只挂在 zh-TW），
   *  于是目录被建成日文名 —— 而库里 `tmdb_work.name_zh` 明明有中文
   *  `無意間變成狗，被喜歡的女生撿回家。`。
   *
   *  判"是不是中文"必须用 `pickChineseName()`（含汉字 **且** 不含假名）：
   *  只看有没有汉字会把 `お嬢様はHがお好き` 当中文收下。
   *
   * ⚠️ 历史库里有 11 部**确实只有日文名**（TMDB 全语言都没中文），
   *    所以最后仍要回落到原名 —— ⛔ 不能因为没有中文就报错。
   */
  private async resolveTitle(detail: any, hint: string | null | undefined, tmdbId: number): Promise<string> {
    const fromHint = pickChineseName(hint);
    if (fromHint) return fromHint;

    const fromCn = pickChineseName(detail?.name);
    if (fromCn) return fromCn;

    /* zh-CN 没译名 ⇒ 单独回查一次 zh-TW（只有这时才多花一次请求） */
    try {
      const tw = await this.cached(`/tv/${tmdbId}`, { language: 'zh-TW' });
      const fromTw = pickChineseName(tw?.name);
      if (fromTw) return fromTw;
    } catch {
      /* 查不到就算了，下面回落原名 */
    }

    return String(detail?.name ?? '').trim() || String(detail?.original_name ?? '').trim() || `tmdb-${tmdbId}`;
  }

  /** 写文件（内容不变就不写，省 FUSE IO） */
  private async writeIfChanged(path: string, content: string): Promise<boolean> {
    try {
      const old = await (await import('node:fs/promises')).readFile(path, 'utf8');
      if (old === content) return false;
    } catch {
      /* 不存在 */
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return true;
  }

  /**
   * 刮一集：写 nfo + 下图片 + 复制视频。
   *
   * 🔴 顺序讲究：先建目录 → 写剧级 nfo/图（Emby 靠它识别整部）
   *    → 复制视频 → 写集级 nfo/图。视频放中间，
   *    是因为只要视频到位 + tvshow.nfo 在，Emby 就能出条目；
   *    集级 nfo 晚一步也不影响识别。
   */
  async ingest(item: ScrapeItem, onStep?: ScrapeStepFn): Promise<ScrapeResult> {
    const t0 = Date.now();
    const warnings: string[] = [];
    const { srcPath, tmdbId, season, episode } = item;

    /* 步骤上报（缺省是空函数 —— 单集手刮/测试脚本可以不传） */
    const TOTAL = SCRAPE_STEPS.length;
    const at = (key: ScrapeStepKey, sub?: ScrapeStep['sub']) => {
      const meta = SCRAPE_STEPS.find((s) => s.key === key);
      onStep?.({ key, label: meta?.label ?? key, idx: (meta ? SCRAPE_STEPS.indexOf(meta) : 0) + 1, total: TOTAL, sub: sub ?? null });
    };

    try {
      at('stat');
      const st = await stat(srcPath).catch(() => null);
      if (!st || st.size <= 0) {
        return {
          ok: false, code: 'src_missing', retryable: false,
          message: `源文件不存在或为空：${srcPath}`, ms: Date.now() - t0,
        };
      }

      /* ① 剧详情（zh-CN 优先；中文名另有兜底，见 resolveTitle） */
      at('detail');
      const detail = await this.cached(`/tv/${tmdbId}`, {
        language: 'zh-CN',
        append_to_response: 'external_ids,credits,images',
        /* ⭐ §154e：加 ja —— 里番的 TMDB logo 常是日文专属（实测小女ラムネ 85174
           有 ja logo），不含 ja 会漏抓，MP 却能拿到 ⇒ 蛙哥对比时就是「MP 有我没有」 */
        include_image_language: 'zh,en,ja,null',
      });

      const title = await this.resolveTitle(detail, item.titleHint, tmdbId);
      const year = Number(String(detail.first_air_date ?? '').slice(0, 4)) || null;

      /* 🔴🔴 先找「这部是不是已经有目录了」—— 有就沿用它，⛔ 绝不新建第二个。
         实测踩到：老库 429 个目录用 `{tmdbid=N}`（花括号），MP 那批用 `[tmdbid=N]`。
         只按方括号找 ⇒ 把已有作品当"纯新增" ⇒ 85174 落了两个目录（Emby 会当成两部剧）。
         解析复用 core 的 `parseTmdbIdFromDir`（唯一实现，⛔ 别在这儿再写一份正则）。 */
      const existing = await this.findExistingDir(tmdbId, season);
      const dir = existing
        ? join(this.cfg.libraryRoot, existing)
        : join(this.cfg.libraryRoot, this.dirNameOf(title, year, tmdbId));
      /* 文件名前缀：沿用已有目录的剧名部分（里面既有的文件都是这个前缀，
         用别的会在一部剧里出现两种片名）*/
      const namePrefix = existing ? titleOfDirName(existing) : safeName(title);
      const seasonDir = join(dir, `Season ${season}`);

      if (!existing) {
        /* 刚建的目录记进缓存 ⇒ 同一部后续几集不用再 readdir 一遍 */
        const made = this.dirNameOf(title, year, tmdbId);
        this.dirOf.set(`${tmdbId}:${season}`, made);
        if (this.listCache) {
          const arr = this.listCache.byId.get(tmdbId);
          if (arr) arr.push(made);
          else this.listCache.byId.set(tmdbId, [made]);
        }
      }
      if (existing && titleOfDirName(existing) !== safeName(title)) {
        warnings.push(`沿用已有目录「${existing}」的剧名（TMDB 现在给的译名是「${title}」）`);
      }

      await mkdir(seasonDir, { recursive: true });

      /* ② 剧级 nfo */
      at('tvshow');
      await this.writeIfChanged(join(dir, 'tvshow.nfo'), this.buildTvNfo(detail, title, year));

      /* ③ 剧级图片（失败只记 warning —— 没封面也还能入库，Emby 会自己补） */
      await this.grabShowImages(detail, dir, warnings, at);
      /* ④ 季详情（要集名/剧照/首播日） */
      at('season');
      let seasonDetail: any = null;
      try {
        seasonDetail = await this.cached(`/tv/${tmdbId}/season/${season}`, {
          language: 'zh-CN',
          append_to_response: 'credits,images',
          include_image_language: 'zh,en,ja,null',
        });
      } catch (e) {
        warnings.push(`季详情取不到：${e instanceof Error ? e.message : String(e)}`);
      }

      const ep = (seasonDetail?.episodes ?? []).find(
        (x: any) => Number(x.episode_number) === Number(episode),
      );
      const epTitleRaw = String(ep?.name ?? '').trim();
      /* ⛔ 不写空集名：Emby 会显示成一个空白行，而且排序会乱 */
      const epTitle = safeName(epTitleRaw || `第 ${episode} 集`);

      /* ⑤ 季级 nfo + 季封面 */
      if (seasonDetail) {
        at('seasonnfo');
        await this.writeIfChanged(
          join(seasonDir, 'season.nfo'),
          this.buildSeasonNfo(seasonDetail, season, year),
        );
        await this.grabSeasonPoster(seasonDetail, dir, seasonDir, season, warnings, at);
      }

      /* ⑥ 复制视频（同尺寸已存在就跳过 —— 一条龙点两次不该复制两遍） */
      const ext = (srcPath.match(/\.[A-Za-z0-9]{2,5}$/) ?? ['.mp4'])[0].toLowerCase();
      const baseName = `${namePrefix} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${epTitle}`;
      const destVideo = join(seasonDir, `${baseName}${ext}`);

      const exist = await stat(destVideo).catch(() => null);
      if (!exist || exist.size !== st.size) {
        at('copy', { done: 0, total: st.size, unit: 'B' });
        const tmp = `${destVideo}.part`;
        /* 🔴 F24：复制必须带「无进展」看护。
           原实现是裸 `await pipeline(...)` —— FUSE 不响应时它永不 resolve，
           worker 单并发（busy 锁）⇒ 这一集卡住 = 后面全排不到、日志无报错、只能重启容器。
           判据用「目标文件多久没长大」而不是「总共跑了多久」：1~2GB 在 115 限速下
           合法超过默认 5 分钟很常见，按总时长判会杀掉正常复制、白烧流量。
           进度仍靠轮询 .part 大小（⛔ 不包 stream 的 data 事件：pipeline 已消费，
           外面再挂监听会拿到 0 或重复消费）—— 这段逻辑现在收进 copyWithStall 一处。 */
        await copyWithStall(srcPath, tmp, {
          stallMs: this.cfg.copyStallMs ?? 300_000,
          onProgress: (done, total) => at('copy', { done, total: total || st.size, unit: 'B' }),
        });
        await unlink(destVideo).catch(() => {});
        await rename(tmp, destVideo);
        at('copy', { done: st.size, total: st.size, unit: 'B' });
      } else {
        at('copy', { done: st.size, total: st.size, unit: 'B' });
      }
      const after = await stat(destVideo).catch(() => null);
      if (!after || after.size !== st.size) {
        return {
          ok: false, code: 'copy_failed', retryable: true,
          message: `复制后大小不符：源 ${st.size} / 目标 ${after?.size ?? 0}`, ms: Date.now() - t0,
        };
      }

      /* ⑥-b ⭐⭐ §135（2026-11-02）**外挂字幕一起搬**
         ---------------------------------------------------------------
         🔴 为什么必须有（蛙哥 11-02：「之前很多是外挂字幕的，你打算怎么处理」）
         实测 NAS 全量扫描：mteam 库 3590 个视频 / 2154 个字幕
         （ass 1814 / ssa 257 / srt 77 / sub 4 / idx 2），
         其中 **2080 个是「和视频同名同目录」的裸 .ass** ⇒ 视频搬走、字幕不搬，
         这集在 Emby 里就是没字幕（而 hanime 那条下载的源本身内嵌字幕，所以以前没暴露）。

         🔴 名字必须**和视频逐字同基名**：`剧名 - S01E02 - 集名.mkv` ↔ `剧名 - S01E02 - 集名.ass`。
            Emby 认同名字幕（也认 `同名.chs.ass` 这种带语言标记的，但同名最保险）。
            这条规则已经在库里验过：strm 库现有 525 个 .ass 全是这个命名。

         ⚠️ 字幕失败**不算整集失败** —— 视频+nfo 才是 Emby 识别的关键，
            没字幕顶多是这集没字幕，不该把已经复制成功的视频判成失败重来一遍。
            所以只记 warning（与「集剧照下载失败」同口径）。

         ⚠️ 没有外挂字幕的集占四成（内嵌字幕或原本就没有）⇒ 静默跳过，不写 warning。 */
      let subTarget: string | null = null;
      /* 🔴 §136：字幕可能来自月度合集 Subs.zip（findSubtitleFor 会把 zip 条目
         落到容器 /tmp 的临时文件）⇒ 用完必须删，否则 /tmp 会越积越多。
         ⛔ 只删自己造的临时文件（tmpDir 下、名字以 sub_ 开头）。 */
      let subTmp: string | null = null;
      try {
        const found = await findSubtitleFor(srcPath);
        if (found.sub) {
          if (found.how === 'zip') subTmp = found.sub;
          const subExt = extname(found.sub).toLowerCase();
          const destSub = join(seasonDir, `${baseName}${subExt}`);
          const ss = await stat(found.sub).catch(() => null);
          const ds = await stat(destSub).catch(() => null);
          if (ss && ss.size > 0 && (!ds || ds.size !== ss.size)) {
            /* 🔴🔴 必须用**流复制**，⛔ 不能用 `fs.copyFile()`。
               2026-11-02 首次实测（136392「我的做鸡生活」）踩到：
                 EPERM: operation not permitted, copyfile
                   '/downloads/mteam里番全量库/…/x.ass'
                 → '/library/CloudDrive/…/x.ass'
               原因：`copyFile` 走 `copy_file_range` 系统调用，**跨文件系统**时不被支持，
               而这里正好是 cifs(/downloads) → rclone FUSE(/library) 两个挂载点。
               ⇒ 视频那边一直用 `copyWithStall`（读流→写流）所以从没暴露，
                  字幕图省事写成 copyFile 就中了 —— 同一类坑（0r96 也是 FUSE 不支持某些操作）。
               字幕只有几十 KB，不需要 stall 看护，但**必须走流**、且先 .part 再 rename，
               否则 115 上可能留下半截字幕文件（Emby 读它会是空字幕）。 */
            const tmpSub = `${destSub}.part`;
            await pipeline(createReadStream(found.sub), createWriteStream(tmpSub));
            await unlink(destSub).catch(() => {});
            await rename(tmpSub, destSub);
          }
          const got = await stat(destSub).catch(() => null);
          if (got && got.size > 0) {
            subTarget = destSub;
          } else {
            warnings.push(`字幕没能落位：${found.sub} → ${destSub}`);
          }
        }
      } catch (e) {
        warnings.push(`字幕处理异常：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (subTmp) await unlink(subTmp).catch(() => {});
      }

      /* ⑦ 集级 nfo + 集剧照 */
      at('epnfo');
      await this.writeIfChanged(
        join(seasonDir, `${baseName}.nfo`),
        this.buildEpNfo(ep, season, episode, epTitle, year, seasonDetail, detail),
      );
      const still = ep?.still_path ? String(ep.still_path) : null;
      if (still) {
        const p = join(seasonDir, `${baseName}.jpg`);
        const got = await stat(p).catch(() => null);
        if (!got) {
          try {
            /* 🔴 original，⛔ w780：实测 MP 的集剧照 215746 字节、w780 只有 59402（差 3.6 倍），
               在剧集列表里横向铺满时 w780 明显发虚。 */
            await this.api.image(still, p, 'original');
          } catch (e) {
            warnings.push(`集剧照下载失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      /* ⑧ 通知 Emby 刷新 —— 🔴 **不在这里做**。
         一集刷一次 = 12 集把整个 458 部的库递归重扫 12 遍，Emby 会卡到没法用。
         改由 IngestWorker 在该作品队列清空后调一次 `refreshLibrary()`。 */

      return {
        ok: true,
        target: destVideo,
        /** ⭐ §135 配套字幕落位路径（null = 这集源侧本来就没有外挂字幕） */
        subTarget,
        title, year, season, episode, episodeTitle: epTitle,
        message: null, warnings, ms: Date.now() - t0,
      };
    } catch (e) {
      const err = e as Error & { code?: string };
      return {
        ok: false,
        code: err.code ?? 'scrape_failed',
        message: err.message,
        retryable: err.code !== 'tmdb_notfound',
        warnings,
        ms: Date.now() - t0,
      };
    }
  }

  /* ── 剧级图片：poster / fanart / backdrop / banner / thumb / landscape / logo / clearlogo / clearart ──
     🔴 尺寸全用 original：MP 产物 poster.jpg 就是 778 KB 的原图，
        用 w780 会明显糊（4K 电视上能看出来），而且与历史 458 部不一致。
     🔴 season01-poster.jpg **不在这里** —— 它必须是**季海报**（TMDB 的季有独立 poster_path），
        实测 MP 的 season01-poster.jpg 与 Season 1/poster.jpg 字节数完全相同（944487），
        用剧海报凑会与 Emby 里显示的季封面不符（0r2 同类：别拿上层的东西填下层）。 */
  private async grabShowImages(
    detail: any, dir: string, warnings: string[], at?: StepAt,
  ): Promise<void> {
    const posterPath: string | null = detail.poster_path ?? null;
    const backdrops: string[] = (detail.images?.backdrops ?? [])
      .map((x: any) => String(x.file_path ?? ''))
      .filter(Boolean);
    const backdropPath: string | null = detail.backdrop_path ?? backdrops[0] ?? null;
    const secondBackdrop: string | null = backdrops.find((p) => p !== backdropPath) ?? backdropPath;

    const logos: any[] = detail.images?.logos ?? [];
    /* ⭐ §154e：挑选顺序 zh → ja → en → 第一张 —— 里番的 logo 基本是日文标题，
       与播放页/作品名一致（MP 同款行为）；zh 只在 TMDB 有人上传中文 logo 时命中 */
    const logoPath: string | null =
      (logos.find((l) => l.iso_639_1 === 'zh') ??
        logos.find((l) => l.iso_639_1 === 'ja') ??
        logos.find((l) => l.iso_639_1 === 'en') ??
        logos[0])?.file_path ?? null;

    const jobs: Array<{ rel: string; dest: string; size: string }> = [];
    const add = (rel: string | null, name: string, size = 'original') => {
      if (rel) jobs.push({ rel, dest: join(dir, name), size });
    };
    add(posterPath, 'poster.jpg');
    add(backdropPath, 'fanart.jpg');
    add(backdropPath, 'backdrop.jpg');
    add(backdropPath, 'banner.jpg');
    add(secondBackdrop, 'thumb.jpg');
    add(secondBackdrop, 'landscape.jpg');
    add(logoPath, 'logo.png');
    add(logoPath, 'clearlogo.png');
    /* clearart.png：TMDB 没有 clearart 这种图（那是 fanart.tv 的资产），
       但 Emby 的目录规范里有它、MP 产物也有 ⇒ 用 logo 顶上，
       视觉上与 clearlogo 一致，⛔ 不为了「文件齐全」去下不相干的图。 */
    add(logoPath, 'clearart.png');

    at?.('images', { done: 0, total: jobs.length, unit: '张' });
    let i = 0;
    for (const j of jobs) {
      i++;
      /* 第几张 / 共几张 —— 9 张图要 10~30 秒，是「下图」这步唯一有意义的进度 */
      at?.('images', { done: i, total: jobs.length, unit: '张' });
      const got = await stat(j.dest).catch(() => null);
      if (got && got.size > 0) continue; // 已有就不重复下
      try {
        await this.api.image(j.rel, j.dest, j.size);
      } catch (e) {
        warnings.push(`${j.dest.split('/').pop()} 下载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 季封面 —— 同一个季海报写两处（Emby 两处都认，MP 产物也是两份）：
   *   `剧目录/season01-poster.jpg`（Emby「季海报」主用这个，文件名带两位季号）
   *   `Season N/poster.jpg`（Kodi 系约定）
   * 🔴 数据源是**季自己的 poster_path**（`/tv/{id}/season/{n}` 返回），
   *    ⛔ 不是剧级 poster_path —— 实测两者文件不同，混用会让季封面变成整部剧的封面。
   */
  private async grabSeasonPoster(
    seasonDetail: any, showDir: string, seasonDir: string, season: number,
    warnings: string[], at?: StepAt,
  ): Promise<void> {
    const rel = seasonDetail?.poster_path ? String(seasonDetail.poster_path) : null;
    if (!rel) return;
    const targets = [
      join(seasonDir, 'poster.jpg'),
      join(showDir, `season${String(season).padStart(2, '0')}-poster.jpg`),
    ];
    let i = 0;
    for (const dest of targets) {
      i++;
      /* 季封面 2 张，挂在「写 season.nfo」这一步后面（它俩是同一批动作） */
      at?.('seasonnfo', { done: i, total: targets.length, unit: '张' });
      const got = await stat(dest).catch(() => null);
      if (got && got.size > 0) continue;
      try {
        await this.api.image(rel, dest, 'original');
      } catch (e) {
        warnings.push(`${dest.split('/').pop()} 下载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /* ── tvshow.nfo（字段集合与顺序照 MP 产物）── */
  private buildTvNfo(d: any, title: string, year: number | null): string {
    const L: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<tvshow>'];
    L.push(`  <tmdbid>${d.id}</tmdbid>`);
    L.push(`  <uniqueid type="tmdb" default="${d.external_ids?.tvdb_id ? 'false' : 'true'}">${d.id}</uniqueid>`);
    if (d.external_ids?.tvdb_id) {
      L.push(`  <tvdbid>${d.external_ids.tvdb_id}</tvdbid>`);
      L.push(`  <uniqueid type="tvdb">${d.external_ids.tvdb_id}</uniqueid>`);
    }
    if (d.external_ids?.imdb_id) {
      L.push(`  <imdbid>${xesc(d.external_ids.imdb_id)}</imdbid>`);
      L.push(`  <uniqueid type="imdb" default="true">${xesc(d.external_ids.imdb_id)}</uniqueid>`);
    }
    const plot = String(d.overview ?? '').trim();
    if (plot) {
      L.push(`  <plot>${cdata(plot)}</plot>`);
      L.push(`  <outline>${cdata(plot)}</outline>`);
    }
    for (const c of (d.credits?.crew ?? []).filter(isDirector)) {
      L.push(`  <director tmdbid="${c.id}">${xesc(c.name)}</director>`);
    }
    for (const a of (d.credits?.cast ?? []).slice(0, 15)) {
      L.push('  <actor>');
      L.push(`    <name>${xesc(a.name)}</name>`);
      L.push('    <type>Actor</type>');
      if (a.character) L.push(`    <role>${xesc(a.character)}</role>`);
      L.push(`    <tmdbid>${a.id}</tmdbid>`);
      if (a.profile_path) L.push(`    <thumb>${imgUrl(this.cfg.imageBase, 'original', a.profile_path)}</thumb>`);
      L.push(`    <profile>https://www.themoviedb.org/person/${a.id}</profile>`);
      L.push('  </actor>');
    }
    for (const g of d.genres ?? []) {
      L.push(`  <genre>${xesc(g.name ?? GENRE_ZH[g.id] ?? '')}</genre>`);
    }
    if (d.vote_average) L.push(`  <rating>${Number(d.vote_average).toFixed(1)}</rating>`);
    /* 🔴 固定 TV-MA —— ⛔ 不是按 `d.adult` 判。
       2026-10-30 实测：TMDB 对 68005（缘之空）返回 `adult=false`，
       而 MP 时代的 tvshow.nfo 明确写着 `<mpaa>TV-MA</mpaa>`
       ⇒ MP 是按**分类规则**给的（这个库就是里番库），不是读字段。
       照字段判会让 400+ 部已刮削的产物在这一项上与本模块产物不一致。 */
    L.push('  <mpaa>TV-MA</mpaa>');
    for (const s of (d.production_companies ?? []).slice(0, 3)) {
      L.push(`  <studio>${xesc(s.name)}</studio>`);
    }
    for (const c of d.origin_country ?? []) {
      L.push(`  <country>${xesc(COUNTRY[c] ?? c)}</country>`);
    }
    L.push(`  <title>${xesc(title)}</title>`);
    if (d.original_name) L.push(`  <originaltitle>${xesc(d.original_name)}</originaltitle>`);
    if (d.first_air_date) L.push(`  <premiered>${xesc(d.first_air_date)}</premiered>`);
    if (year) L.push(`  <year>${year}</year>`);
    /* MP 产物就是 -1/-1（表示「不固定」）—— 照抄，别自作聪明填总集数 */
    L.push('  <season>-1</season>');
    L.push('  <episode>-1</episode>');
    L.push('</tvshow>');
    return L.join('\n') + '\n';
  }

  /* ── season.nfo ── */
  private buildSeasonNfo(s: any, season: number, year: number | null): string {
    const L: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<season>'];
    const plot = String(s.overview ?? '').trim();
    if (plot) {
      L.push(`  <plot>${cdata(plot)}</plot>`);
      L.push(`  <outline>${cdata(plot)}</outline>`);
    }
    L.push(`  <title>第 ${season} 季</title>`);
    const air = s.air_date ?? s.episodes?.[0]?.air_date ?? null;
    if (air) {
      L.push(`  <premiered>${xesc(air)}</premiered>`);
      L.push(`  <releasedate>${xesc(air)}</releasedate>`);
    }
    if (year) L.push(`  <year>${year}</year>`);
    L.push(`  <seasonnumber>${season}</seasonnumber>`);
    L.push('</season>');
    return L.join('\n') + '\n';
  }

  /* ── episode.nfo ── */
  private buildEpNfo(
    ep: any, season: number, episode: number, epTitle: string,
    year: number | null, seasonDetail: any, showDetail: any,
  ): string {
    const L: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<episodedetails>'];
    if (ep?.id) {
      L.push(`  <uniqueid type="tmdb" default="true">${ep.id}</uniqueid>`);
      L.push(`  <tmdbid>${ep.id}</tmdbid>`);
    }
    L.push(`  <title>${xesc(epTitle)}</title>`);
    const plot = String(ep?.overview ?? '').trim();
    if (plot) {
      L.push(`  <plot>${cdata(plot)}</plot>`);
      L.push(`  <outline>${cdata(plot)}</outline>`);
    }
    if (ep?.air_date) {
      L.push(`  <aired>${xesc(ep.air_date)}</aired>`);
      const y = Number(String(ep.air_date).slice(0, 4));
      if (y) L.push(`  <year>${y}</year>`);
    } else if (year) {
      L.push(`  <year>${year}</year>`);
    }
    L.push(`  <season>${season}</season>`);
    L.push(`  <episode>${episode}</episode>`);
    if (ep?.vote_average) L.push(`  <rating>${Number(ep.vote_average).toFixed(1)}</rating>`);

    /* 集级导演 = **剧级导演（Series Director）+ 该集导演**，剧级在前。
       🔴 实测 MP 的 S01E01 写的是「高桥丈夫（Series Director）+ 三瓶圣（该集 Director）」，
          而 `/tv/{id}/season/{n}` 的 episode.crew 里只有三瓶圣
          ⇒ 只取集级会漏掉系列导演，必须把剧级补进来。
       ⚠️ `ep.crew ?? 剧级crew` 用 `??` 是错的：空数组不会触发回落（老坑），
          这里显式判断长度。 */
    const dirs: any[] = [];
    const seenDir = new Set<number>();
    for (const list of [showDetail?.credits?.crew, (ep?.crew?.length ? ep.crew : seasonDetail?.credits?.crew)]) {
      for (const c of list ?? []) {
        if (!isDirector(c)) continue;
        const id = Number(c.id);
        if (seenDir.has(id)) continue;
        seenDir.add(id);
        dirs.push(c);
      }
    }
    for (const c of dirs) {
      L.push(`  <director tmdbid="${c.id}">${xesc(c.name)}</director>`);
    }
    const cast = (ep?.guest_stars ?? []).length ? ep.guest_stars : (seasonDetail?.credits?.cast ?? []);
    for (const a of cast.slice(0, 8)) {
      L.push('  <actor>');
      L.push(`    <name>${xesc(a.name)}</name>`);
      L.push('    <type>Actor</type>');
      /* 🔴 集级**刻意不写 `<role>`** —— MP 的 episode.nfo 就没有（实测缘之空 S01E01：
         guest_stars 里三个演员都带 character，产物里一个 role 都没有），
         而剧级 tvshow.nfo 是写 role 的。这里照 MP 的做法，保持一致。 */
      L.push(`    <tmdbid>${a.id}</tmdbid>`);
      if (a.profile_path) L.push(`    <thumb>${imgUrl(this.cfg.imageBase, 'original', a.profile_path)}</thumb>`);
      L.push(`    <profile>https://www.themoviedb.org/person/${a.id}</profile>`);
      L.push('  </actor>');
    }
    L.push('</episodedetails>');
    return L.join('\n') + '\n';
  }

  /**
   * 通知 Emby 刷新里番库（best-effort）。
   *
   * 🔴 由 IngestWorker 在**该作品队列清空时调一次**，⛔ 不是每集调：
   *    Emby 的 `Refresh?Recursive=true` 会把 458 个目录整个重扫，
   *    12 集连刷 12 次会让 Emby 长时间不可用。
   */
  async refreshLibrary(): Promise<{ ok: boolean; message?: string }> {
    if (!this.cfg.embyRefresh) return { ok: true, message: '已关闭（SCRAPE_EMBY_REFRESH=false）' };
    /* ⭐ §157 配置中心：走 config.emby（app_config > env > 默认），看板可改立即生效 */
    const base = config.emby.base;
    const key = config.emby.apiKey;
    const lib = config.emby.libId;
    if (!key) return { ok: false, message: '未配置 Emby API Key（设置页 → 系统设置）' };
    try {
      const res = await fetch(
        `${base}/emby/Items/${lib}/Refresh?Recursive=true&ImageRefreshMode=Default&MetadataRefreshMode=Default&api_key=${encodeURIComponent(key)}`,
        { method: 'POST', signal: AbortSignal.timeout(8000) },
      );
      return res.ok ? { ok: true } : { ok: false, message: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
