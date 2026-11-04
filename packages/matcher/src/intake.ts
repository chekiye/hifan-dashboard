/**
 * 入库检测（M5 核心）
 *
 * 把「TMDB 基准 ⇄ 本地实际」逐集比对，产出 MP 那种可展示的入库状态。
 *
 * ⭐ 核心概念：**格子 (season, episode)**
 *   - TMDB 侧声明应有哪几格
 *   - 本地侧实际有哪几格（从文件名解析出的 S/E）
 *   - 两者的差集就是缺集
 *
 * 三种作品级状态（与看板三色对应）：
 *   missing_work 完全没下 —— 池内有，本地无任何目录
 *   partial       下了但缺集 —— 目录在，逐格比对有缺口
 *   complete      已齐集     —— 目录在，且应有格子全有
 *   unlisted      TMDB 未收录 —— 本地有，池内无（反向缺口）
 *
 * ⚠️ 只读：本模块只 SELECT，不碰用户媒体库，也不 DELETE 任何数据
 *    （local_file 的清理由扫描器负责，那是项目自己的库）
 */
import type { DB } from '@hifan/core';
import { parseTmdbIdFromDir, parseYearFromDir, rateLimitOf } from '@hifan/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as OpenCC from 'opencc-js';

export type WorkStatus = 'missing_work' | 'partial' | 'complete' | 'unlisted';

/**
 * ⭐ §82：源站分集标题 → 集号。⛔ 解析不出返回 null，**绝不猜**（0dc：宁可空着也不编）。
 *
 * 实测两种来源，优先级从高到低：
 *   ① `title_ja` 里的「第N話 / 第N巻」（最可信，136 部有）
 *   ② 标题末尾的空格+数字，如「1LDK＋JK…初體驗!!? 8」（覆盖最多，
 *      1530 部有 entry_detail 的作品里 1142 部所有条目都能靠这条解出）
 */
function parseSrcEp(o: Record<string, unknown>): number | null {
  const ja = String(o.title_ja ?? '');
  const mJa = /第\s*(\d+)\s*[話话巻卷]/.exec(ja);
  if (mJa) return Number(mJa[1]);
  for (const key of ['title', 'title_zh'] as const) {
    const t = String(o[key] ?? '').trim();
    const mTail = /[\s　](\d{1,3})$/.exec(t);
    if (mTail) return Number(mTail[1]);
  }
  return null;
}

/**
 * ⭐ §85：落盘文件名（MP 可识别格式）—— `剧集名[tmdbid=xxx]-S01E02`
 *
 * 🔴 **判据唯一性（0lx）**：这个函数与 `server/src/download.ts` 的 `buildFileBase`
 *    必须产出**完全一致**的结果 ⇒ 这里是**唯一实现**，
 *    server 端改为 import 本函数，⛔ 不许再写一份。
 *
 * 实测（MP v3 容器内跑 `MetaInfo`）：
 *   `1LDK＋JK 突然间展开同居？[tmdbid=228367]-S01E08.mp4`
 *   ⇒ media_id=228367 / season=S01 / episode=E08 ✅
 */
export function buildLinkFileBase(
  nameZh: string | null,
  tmdbId: number,
  season: number,
  episode: number,
): string {
  const title = safeFilePart(nameZh || `tmdb-${tmdbId}`);
  const s = String(Math.max(0, season)).padStart(2, '0');
  const e = String(Math.max(0, episode)).padStart(2, '0');
  return `${title}[tmdbid=${tmdbId}]-S${s}E${e}`;
}

/** ⭐ §85：文件名安全化 —— ⛔ 不能出现路径分隔符与 Windows 非法字符 */
export function safeFilePart(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'untitled'
  );
}

/**
 * ⭐ §150（2026-11-04）：一个**可被源站占用的集位**。
 *   池 = 正篇那一季 ∪ S00（蛙哥：「S00E01 就是他的集号」）。
 *   `name/nameJa` 只用于「按集名认领」，⛔ 不参与其它判定。
 */
export interface SourceSlot {
  season: number;
  episode: number;
  name: string | null;
  nameJa: string | null;
}

/** 集名归一：繁→简 + NFKC + 小写 + 去空白/标点/符号
 *  （`～` `・` `：` 全去掉，只留字母数字与汉字假名）
 *  🔴 为什么必须繁简归一：实测 #307506 日在校园 H 版，TMDB 集名是简体「初体验 /
 *     如君所愿 / 二人的恋人」，源站标题是繁体「初體驗 / 如君所願 / 二人的戀人」
 *     ⇒ 不归一时一集都对不上，只能退回「按顺序猜」，六集里五集是错的。 */
const TW2CN = (OpenCC as unknown as { Converter: (o: Record<string, string>) => (s: string) => string })
  .Converter({ from: 'tw', to: 'cn' });
const normCache = new Map<string, string>();
function normEpTitle(s: string): string {
  const hit = normCache.get(s);
  if (hit != null) return hit;
  const out = TW2CN(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
  if (normCache.size > 20000) normCache.clear();
  normCache.set(s, out);
  return out;
}

/** 「第1集 / 第1話 / 第 2 话 / Episode 3」这类通用集名不具备辨识度，⛔ 不拿它认领 */
const GENERIC_EP_NAME = /^第?\d+[集話话]$|^episode\d+$/;

/**
 * ⭐ 2026-10-29（§82 蛙哥：「我想看到 hanime 有没有对应的集数」）：
 *   源站（hanime）侧的一条播放记录 —— 来自 `source_work.entry_detail` 的 JSON 数组。
 *
 * 🔴 为什么存在这里而不是新开一张表：`entry_detail` 已经是增量合并过的权威快照
 *    （§79 铁律），全库 1530/1544 部有内容，且「数组条数 == episodes 字段」0 例外。
 *    再抓一次或再存一份就是第二份判据（0lx）。
 */
export interface SourceEpisode {
  /** 源站侧集号（从「第N話」或标题末尾数字解析，解析不出为 null） */
  ep: number | null;
  /** hanime 视频 id，拼成 https://hanime1.me/watch?v=<vid> */
  vid: string;
  titleJa: string | null;
  titleZh: string | null;
  /** 播放页直链 */
  url: string;
  /**
   * ⭐ 2026-10-29（§83）：这一集的集号不是从标题里解析出来的，而是**按空缺推出的**。
   *
   * 🔴 为什么需要它：hanime 有一批独立视频的标题**完全不带集号**
   *    （实测 228360 第 3 集「so_low ～傲嬌妹妹的失誤～」，vid 407593，
   *      标题、日文标题、播放页标题里都没有「第N話」也没有末尾数字）。
   *    旧实现有「只有一条就补 1」的兜底，但 `source_work` 是**一个视频一行**，
   *    每行 arr 恒为 1 条 ⇒ 三条都被补成第 1 集 ⇒ 后两条被去重丢掉 ⇒ 第 3 集永远空着
   *    （蛙哥：「这个第三集其实出了」）。
   *
   * ⇒ 现在改成：显式集号优先；剩下的按「该季还没被占的已播集号」1:1 配对，
   *    配上的打 `guessed` 标记，UI 显示「第N話?」让蛙哥人工确认，⛔ 不静默当权威。
   */
  guessed: boolean;
}

/**
 * ⭐ 2026-10-29（§85 蛙哥：「我希望下载链接也在看板上呈现，和剧集一一对应」）：
 *   这一集在 `source_link` 表里的下载链接信息。
 *
 * 🔴 关键设计：**链接按 vid 挂，不按集号挂**
 *   - `source_link` 的主键是 vid；`source_work.entry_detail` 里也有 vid
 *   - ⇒ 两边按 vid JOIN 即可，⛔ **不需要第二份集号解析**（0lx 铁律）
 *   - 集号落位仍由 `sourceInfo()` 独家负责（§83 的 guessed 逻辑），链接只是「跟着走」
 *
 * ⛔ `expires_at` 必须一起给前端 —— 签名 11~12 小时就过期，
 *    前端要能显示「已过期」并提示重抓，否则用户点了下载才发现下不了。
 */
export interface EpisodeLink {
  vid: string;
  /** 最高画质直链（带签名） */
  url: string;
  /** 1080 / 720 / 480 */
  quality: number | null;
  /** hembed / youjizz / other */
  srcKind: string | null;
  /** 1 = HLS（本轮不支持下载） */
  isM3u8: boolean;
  /** 签名过期 Unix 秒；null = 未知 */
  expiresAt: number | null;
  /**
   * ⭐ §116（2026-11-01 蛙哥「hanime 下载页那个下载按钮无法获取视频大小吗」）：
   * **源侧这一集的真实字节数**，由抓链接时对 CDN 直链发 HEAD 取 content-length。
   *
   * 🔴 为什么值得单独存：链接签名 11~35 小时就过期、过期后 HEAD 回 410 Gone，
   *    **但文件大小永远不会变** ⇒ 抓到一次，此后链接烂了也不影响这个数。
   *    这正是蛙哥要的「对比哪个质量更好」的另一半 —— 只有档位（1080p）没有体积，
   *    没法跟 mteam 比。
   * ⚠️ 粒度是 **vid（= 一集）**，⛔ 不是作品级：同一部不同集差得很远。
   * null = 没抓到（老数据 / HEAD 失败）—— 前端不许拿 0 顶。
   */
  size: number | null;
  /**
   * ⭐ §85（2026-10-29 实测发现）：**源站写死的速率上限**（字节/秒）。
   *
   * youjizz 的签名 URL 带 `rate=NNNNNN`，实测下载速度恰好卡在这个数。
   * 🔴 绕不过（hash 对整个 query 签名，改 rate 就失效）⇒ 只能如实告诉用户预期速度，
   *    否则「一直下不完」会被误以为是看板卡死。
   * null = 该源不限速（如 hembed，实测 11~58 MB/s）。
   */
  rateLimit: number | null;
  /** 落盘用的文件名（不含扩展名）—— MP 可识别格式 */
  fileBase: string;
}

/**
 * ⭐ 2026-10-30（§87 蛙哥：「我要看的是**集对集**的 hanime 和下载链接，
 *   哪里缺集了、hanime 更新了没、对应链接抓到没有」）：
 *   按 vid 批量读 `source_link` —— **全站唯一实现**。
 *
 * 🔴 为什么提成模块级导出函数（原来是 `IntakeChecker` 的私有方法）：
 *   现在有**两个**调用方 ——
 *     ① 入库检测（`workIntake()` → `sourceInfo()`），逐格挂链接；
 *     ② 看板详情（`BoardApi.detail()` → 逐集对照表），按行挂链接。
 *   两处各写一份 SQL 就是在同一个问题上留两份判据，迟早漂移（0lx）。
 *   ⇒ 一个函数、两个调用方，字段也完全相同。
 *
 * 🔴 按 **vid** 查，不按集号查：集号落位是 `sourceInfo()` 的独家职责，
 *   链接只要跟着 vid 走就行，⛔ 绝不另写一份集号解析。
 *
 * ⛔ 表不存在（老库没跑 migration #15）⇒ 返回空 Map，静默降级，⛔ 不许 500。
 */
export function readEpisodeLinks(db: DB, vids: string[]): Map<string, EpisodeLink> {
  const out = new Map<string, EpisodeLink>();
  if (!vids || !vids.length) return out;
  try {
    const marks = vids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT vid, url, quality, src_kind, is_m3u8, expires_at, size
           FROM source_link WHERE vid IN (${marks})`,
      )
      .all(...vids) as Array<{
        vid: string; url: string; quality: number | null;
        src_kind: string | null; is_m3u8: number | null; expires_at: number | null;
        size: number | null;
      }>;
    for (const r of rows) {
      out.set(r.vid, {
        vid: r.vid,
        url: r.url,
        quality: r.quality == null ? null : Number(r.quality),
        srcKind: r.src_kind,
        isM3u8: Number(r.is_m3u8) === 1,
        expiresAt: r.expires_at == null ? null : Number(r.expires_at),
        // 🔴 §116：老库没这列（migration #24 之前）⇒ undefined，统一成 null
        size: r.size == null ? null : Number(r.size),
        // 🔴 0lx：速率上限的解析唯一实现在 core（collector 共用）
        rateLimit: rateLimitOf(r.url),
        // ⛔ fileBase 在这里**不填** —— 它需要 TMDB 作品名 + 落位集号，
        //    那是 EpisodeCell 层才知道的（§85：由 workIntake 循环里补）。
        fileBase: '',
      });
    }
  } catch {
    /* 表还没建 ⇒ 当作没有链接 */
  }
  return out;
}

export interface EpisodeCell {
  season: number;
  episode: number;
  /** TMDB 单集名 */
  name: string | null;
  airDate: string | null;
  still: string | null;
  /**
   * ⭐ §83：剧照的**预生成模糊版**（`still/tv/x.jpg` → `still_blur/tv/x.jpg`）。
   * 与 `board.ts` 的对齐表同一套（blur 档只吃糊图，原图不进网络）。
   */
  stillBlur: string | null;
  /** 本地是否已入库 */
  owned: boolean;
  /** 命中的本地文件名（owned=true 时有值） */
  fileName: string | null;
  filePath: string | null;
  /**
   * ⭐ 2026-10-29（蛙哥 #3）：这一格被**人工排除**（`work_hidden` scope=episode/season）。
   *   「S00 那两集没有资源」——排除后既不算缺集、也不算应有集数，
   *   但仍留在列表里（灰掉+可恢复），⛔ 不静默消失（否则蛙哥以为丢了）。
   */
  excluded: boolean;
  /**
   * ⭐ 2026-10-29（§82）：源站（hanime）这一集的播放记录，没有则 null。
   *   SQL 不 JOIN，由 `sourceInfo()` 解析 `entry_detail` 后按集号挂上来。
   *   ⚠️ 多季作品的集号**不挂**（源站集号是线性的，跨季无法唯一落位）⇒ 恒为 null。
   */
  src: SourceEpisode | null;
  /**
   * ⭐ 2026-10-29（§85）：这一集在 `source_link` 表里的下载链接。
   *   没有源站记录、或源站没收录 ⇒ null。
   *   ⚠️ 由 `sourceInfo()` 按 **vid** 挂上（⛔ 不另写集号解析，0lx）。
   */
  link: EpisodeLink | null;
  /**
   * ⭐ 2026-10-29（§85）：这一集的下载状态（已下 / 下载中 / 失败）。
   *   由 `work_dl` 表提供；没下过 ⇒ null。
   */
  dl: {
    state: 'done' | 'running' | 'failed';
    filePath: string | null;
    bytes: number | null;
    error: string | null;
  } | null;
  /**
   * ⭐ 2026-10-29（§82）：播出日在未来 ⇒ 还没播，⛔ **不算缺集**。
   *   实测全库 21 集 / 11 部属于这类（如 228360 so_low E4 明天才播），
   *   原来一律报「缺」，把入库率白白拉低。
   */
  future: boolean;
}

export interface SeasonGroup {
  season: number;
  name: string;
  isSpecials: boolean;
  /** 有效集数（已扣掉被排除的集与未播出的集） */
  total: number;
  owned: number;
  missing: number[];
  /** 本季被排除的集数 */
  excluded: number;
  /** ⭐ §82：本季「还没播出」的集数（不计入缺集） */
  future: number;
  episodes: EpisodeCell[];
}

/** ⭐ §82：源站供给汇总（作品级） */
export interface SourceSupply {
  hanime: {
    /** entry_detail 里的播放记录条数 */
    total: number;
    /** 成功落到某一集上的条数（含推定） */
    resolved: number;
    /** 其中靠「空缺配对」推定的条数（标题里没有集号，⛔ 不是解析出来的） */
    guessed: number;
    /**
     * 源站集号能不能精确落到某一集上。
     * `false` = 多季作品（源站集号线性、TMDB 按季切）⇒ 只报条数，不逐集挂。
     */
    mappable: boolean;
  } | null;
  /** mteam 侧发布条数（一集一条，但标题集号解析率仅 11% ⇒ 只做参考，⛔ 不参与判定） */
  mteamCount: number;
}

export interface WorkIntake {
  workId: number;
  status: WorkStatus;
  nameZh: string | null;
  nameOriginal: string | null;
  year: number | null;
  mediaType: 'tv' | 'movie';
  posterLocal: string | null;
  /** ⭐ §82：模糊封面（安全模式 blur 档用，与看板同一套路径） */
  posterBlur: string | null;
  /** TMDB 声明的季集格子总数（已扣排除与未播出） */
  totalEpisodes: number;
  /** 本地实际有的集数 */
  ownedEpisodes: number;
  missingEpisodes: number[];
  /** 带季号的缺集标记，多季作品不会重复显示（S02E01 而非又一个 E01） */
  missingLabeled: string[];
  /** ⭐ 被人工排除的集（S00E01 这种带季号），只做展示，不计入缺集与总数 */
  excludedLabeled: string[];
  /** 被人工排除的集数 */
  excludedEpisodes: number;
  /** ⭐ §82：未播出的集（带季号）——不算缺集 */
  futureLabeled: string[];
  /** ⭐ §82：未播出的集数 */
  futureEpisodes: number;
  /** ⭐ §82：源站供给汇总 */
  source: SourceSupply;
  /** 解析不出集号的文件数（无法判定，单独报出而非猜测） */
  unparsedFiles: number;
  /** 本地目录（用于展示路径） */
  localDir: string | null;
  seasons: SeasonGroup[];
}

export class IntakeChecker {
  /**
   * ⭐ §154d（2026-11-04 蛙哥「抓到hanime说无来源」×2）：
   *    **对齐引擎的落位事实**（`data/hn_ep_map.json`，vid → [work_id, season, episode]）。
   *    由 server 层加载注入（matcher 不碰文件系统/配置）。
   *
   * 🔴 为什么要注入：sourceInfo() 自带的落位只支持「单季作品」，
   *    多季作品（0da）整部不落位 ⇒ `/api/dl/pick` 来源列全「H 无」——
   *    实测 85147 対魔忍アサギ（S0/S1/S2/S3 四季 11 集，hanime 明明有 VOL.01-04 等 9 条）。
   *    而 306171 我的妈妈是「2 个配音版本 vs 1 个格子」，2≠1 整批放弃（0ac 宁空不猜）。
   *    这两种情况抽屉 hanime 列（对齐引擎）都落对了 ⇒ 落位判据不能有两份（0lx）：
   *    **map 命中的 vid 直接权威落位**，自带逻辑只对 map 没覆盖的条目兜底。
   *    map 里的落位与抽屉同源（build_hn_ep_map.py 从看板接口导出），
   *    ⇒ 抽屉、全部片名、来源列、下载执行四处永远一致（0r239 的教训）。
   */
  constructor(
    private readonly db: DB,
    private readonly hnEpMap?: Map<string, [number, number, number]> | null,
  ) {}

  /**
   * 🔴 看板可见性过滤 —— 必须与 board.ts 用同一条件，否则两处数字对不上。
   *
   * 隔离的是「疑似非里番」（美国老爹 / 瑞克和莫蒂 这类主流商业动画）。
   * 它们混进主库是 v7 提升时的口径错误，隔离标记见
   * packages/collector/src/quarantine_mainstream.ts。
   *
   * 兼容旧库：没这列时不过滤（hasQuarantine 与 board.ts 同一套判断）。
   */
  private get visible(): string {
    if (this._hasQuarantine === undefined) {
      const cols = (
        this.db
          .prepare(`SELECT name FROM pragma_table_info('tmdb_work')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      this._hasQuarantine = cols.includes('is_quarantined');
    }
    return this._hasQuarantine ? 'is_quarantined = 0' : '1=1';
  }

  private _hasQuarantine: boolean | undefined;

  /**
   * 已生效的屏蔽集合（2026-10-20 蛙哥「逐件屏蔽」）。
   *
   * 🔴 铁律 0ad 的同族坑：`work_hidden` 表可能还不存在（migration 未跑）
   *    ⇒ 必须先探列，缺失时返回**空集**（= 没屏蔽任何东西），
   *    ⛔ 绝不能让接口 500。
   *
   * @param scope 'board'（tmdb_id）或 'unconfirmed'（src_key）
   */
  private hiddenKeys(scope: 'board' | 'unconfirmed'): Set<string> {
    try {
      const cols = (
        this.db
          .prepare(`SELECT name FROM pragma_table_info('work_hidden')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      if (!cols.includes('scope')) return new Set();
      const rows = this.db
        .prepare(
          `SELECT key FROM work_hidden
            WHERE scope = ? AND unhidden_at IS NULL`,
        )
        .all(scope) as Array<{ key: string }>;
      return new Set(rows.map((r) => String(r.key)));
    } catch {
      return new Set();
    }
  }

  /**
   * 缺集清单要跳过已屏蔽的作品（蛙哥：「核对时可以直接跳过我屏蔽的」）。
   *
   * ⭐ 口径说明：只在**缺集清单**里跳过，⛔ 不改 `tmdb_work.is_quarantined`
   *    —— 屏蔽是「我不想看」，不是「库里有问题」，两者语义必须分开。
   */
  hiddenWorkCount(): number {
    return this.hiddenKeys('board').size;
  }

  /* ══════════════════════════════════════════════════════════════════════
     ⭐⭐ 2026-10-29（§81 蛙哥 #3）：**集级 / 季级排除必须进入库检测**

     蛙哥原话：「后宫露营…S00 的两集是没有资源的，我已经手动屏蔽了，
                但为什么这里还显示缺集」

     根因：`work_hidden` 里 scope='episode' 的排除（看板「逐集对照」里点的
           「排除」）**只有 board.ts 认**，intake.ts 一行都没读 ⇒
           入库检测仍按 TMDB 全量格子算缺集 ⇒ 排除过的假集天天报缺。

     🔴 判定语义必须与 board.ts 完全一致（0lx：同一判据只写一份，两处不许各算）：
        `h.scope='episode' AND h.key = '<id>:S<季>:E<集>'`
        `h.scope='season'  AND h.key = '<id>:S<季>'`
        且都要求 `unhidden_at IS NULL`（恢复后立刻重新计入）。
        分子分母**同时减**（被排除的格即使 Emby 里有，也不算入库）。
     ══════════════════════════════════════════════════════════════════════ */

  /** work_hidden 表是否存在（老库没跑 migration 就降级成「什么都没排除」） */
  private get hasHiddenTable(): boolean {
    if (this._hasHiddenTable === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_hidden'`)
          .all() as Array<{ name: string }>;
        this._hasHiddenTable = t.length > 0;
      } catch {
        this._hasHiddenTable = false;
      }
    }
    return this._hasHiddenTable;
  }
  private _hasHiddenTable: boolean | undefined;

  /**
   * 单部作品被排除的格子。
   * @returns `eps` 形如 `'0:1'`（季:集，**不带** id 前缀）；`seasons` 是整季被排除的季号
   */
  private hiddenCells(workId: number): { eps: Set<string>; seasons: Set<number> } {
    const eps = new Set<string>();
    const seasons = new Set<number>();
    if (!this.hasHiddenTable) return { eps, seasons };
    try {
      const rows = this.db
        .prepare(
          `SELECT scope, key FROM work_hidden
            WHERE unhidden_at IS NULL
              AND scope IN ('episode','season')
              AND key LIKE ?`,
        )
        .all(`${workId}:%`) as Array<{ scope: string; key: string }>;
      for (const r of rows) {
        // key = `<id>:S<季>` 或 `<id>:S<季>:E<集>`
        const parts = String(r.key).split(':');
        const sn = Number(String(parts[1] ?? '').replace(/^S/i, ''));
        if (!Number.isFinite(sn)) continue;
        if (r.scope === 'season') {
          seasons.add(sn);
        } else if (r.scope === 'episode') {
          const ep = Number(String(parts[2] ?? '').replace(/^E/i, ''));
          if (Number.isFinite(ep)) eps.add(`${sn}:${ep}`);
        }
      }
    } catch {
      /* 结构异常 ⇒ 当成没排除（⛔ 不让接口 500，0ad） */
    }
    return { eps, seasons };
  }

  /**
   * 「已入库集数」的 SQL 片段 —— overview() 与 shortageList() 必须用同一份，
   * 否则两处数字对不上（用户会先怀疑数据，再怀疑产品）。
   *
   * 🔴🔴 2026-10-27（§70）**判据已换**：蛙哥定调
   *    「有没有在这个 emby 库里，这才是里番的入库判定标准」。
   *    原实现查 `local_file / local_work`（扫 `/library/已整理` 的本地文件），
   *    实测那批文件 **Emby 根本看不到**（Emby 17 个库没有一个挂 `/library`），
   *    两批内容交集只有 3 部 ⇒ 旧判据在 Emby 里点不开，是假「已入库」。
   *
   * ⚠️ 原来的「单文件兜底」（目录里只有 1 个视频且集号解析不出就按 E01 计）
   *    在 Emby 侧**不需要** —— Emby 自己就给了 ParentIndexNumber/IndexNumber。
   * ⚠️ `synced_at = last_sync` 这个条件**不能省**：同步是全量 `INSERT OR REPLACE`
   *    且不删旧行（写库铁律禁 DELETE），已从 Emby 移除的条目只能靠时间戳出局。
   * 🔴 2026-10-29（§81）：加两道排除守卫 —— 被排除的格即使 Emby 里有也不计入分子。
   */
  private get localEps(): string {
    if (!this.hasHiddenTable) {
      return `(SELECT COUNT(*) FROM emby_episode e
        WHERE e.tmdb_id = w.id
          AND e.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync'))`;
    }
    return `(SELECT COUNT(*) FROM emby_episode e
        WHERE e.tmdb_id = w.id
          AND e.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')
          AND NOT EXISTS (SELECT 1 FROM work_hidden h
                           WHERE h.scope = 'episode' AND h.unhidden_at IS NULL
                             AND h.key = CAST(w.id AS TEXT) || ':S' || CAST(e.season AS TEXT)
                                     || ':E' || CAST(e.episode AS TEXT))
          AND NOT EXISTS (SELECT 1 FROM work_hidden h
                           WHERE h.scope = 'season' AND h.unhidden_at IS NULL
                             AND h.key = CAST(w.id AS TEXT) || ':S' || CAST(e.season AS TEXT)))`;
  }

  /** 每部作品被排除的「TMDB 声明格子」数（一次聚合查出来，⛔ 不要按部循环） */
  /** ⭐ §82：今天（本地时区 YYYY-MM-DD）—— 判「未播出」的唯一口径 */
  private get today(): string {
    // ⚠️ 容器时区可能是 UTC ⇒ 必须显式指定，否则跨零点前后会差一天（0qb）。
    //    en-CA 的输出格式恰好是 YYYY-MM-DD，可以直接与 tmdb_episode.air_date 比字符串。
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }

  /**
   * ⭐ 2026-10-29（§82 蛙哥：「我希望看到 hanime 有没有对应的集数」）
   *   源站供给：hanime 的分集数组（`source_work.entry_detail`）+ mteam 发布条数。
   *
   * 🔴 为什么在 JS 里解析 JSON 而不在 SQL 里 `json_each`：
   *    库由 node:sqlite 打开，JSON1 函数不一定编译进去；而这里一部最多 1~2 行、
   *    几十个条目，JS 解析既稳又快。⛔ 不要为了「一条 SQL 到底」去赌扩展可用。
   *
   * @param ctx 落位上下文；多季作品传 null ⇒ 只报条数、不逐集挂
   *            （源站集号线性，跨季无法唯一落位，0da）
   *   - `season`   唯一的正篇季号（显式集号默认落这一季）
   *   - `slots`    该作品**能被源站占用的集位池** = 正篇那一季 ∪ S00，
   *               只收「已播出的集 ∪ 已入库的集」。
   *               未播出的集不参与配对 —— 源站不可能有还没播的那一集，
   *               把它算进空缺会让「条数 3 vs 空缺 4」配不上（0af 假空位）。
   *               ⭐ §150：池里带 S00（蛙哥「S00E01 就是他的集号」）。
   */
  /**
   * ⭐ §85：查 `work_dl` 表里的下载状态。
   *
   * 🔴 三态（与 work_want 同款思路，⛔ 不 DELETE）：
   *   - `done_at` 有值     → 已下好
   *   - `error_msg` 有值  → 失败（可重试）
   *   - 其它               → 进行中
   * ⛔ `revoked_at` 有值（人工作废）⇒ 不算已下。
   * ⛔ 表不存在 ⇒ 空 Map，静默降级，⛔ 不许 500。
   */
  private dlStatus(
    vids: string[],
  ): Map<string, { state: 'done' | 'running' | 'failed'; filePath: string | null; bytes: number | null; error: string | null }> {
    const out = new Map<string, { state: 'done' | 'running' | 'failed'; filePath: string | null; bytes: number | null; error: string | null }>();
    if (!vids.length) return out;
    try {
      const marks = vids.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT vid, file_path, bytes, error_msg, started_at, done_at, revoked_at
             FROM work_dl WHERE vid IN (${marks})`,
        )
        .all(...vids) as Array<{
          vid: string; file_path: string | null; bytes: number | null;
          error_msg: string | null; started_at: string | null;
          done_at: string | null; revoked_at: string | null;
        }>;
      for (const r of rows) {
        if (r.revoked_at) continue;
        const state: 'done' | 'running' | 'failed' =
          r.done_at ? 'done' : r.error_msg ? 'failed' : 'running';
        out.set(r.vid, {
          state,
          filePath: r.file_path,
          bytes: r.bytes == null ? null : Number(r.bytes),
          error: r.error_msg,
        });
      }
    } catch {
      /* 表还没建 ⇒ 当作没下过 */
    }
    return out;
  }

  /**
   * ⭐ §85：查 `source_link` 表里这些 vid 的链接信息。
   *
   * 🔴 **按 vid 查，不按集号查** —— 这是本设计最关键的一点：
   *   集号落位由 `sourceInfo()` 独家负责（§83 的 guessed 逻辑）；
   *   链接只要跟着 vid 走就行，⛔ **绝不另写一份集号解析**（0lx 铁律）。
   *
   * ⛔ 表不存在（老库没跑 migration #15）⇒ 返回空 Map，静默降级，⛔ 不许 500。
   */
  private linkInfo(vids: string[]): Map<string, EpisodeLink> {
    /* 🔴 §87：实现已提成模块级 `readEpisodeLinks()` —— 看板详情那条路也要用，
       两处各写一份 SQL 必然漂移（0lx）。这里只剩转调。 */
    return readEpisodeLinks(this.db, vids);
  }

  private sourceInfo(
    workId: number,
    ctx: { season: number; slots: SourceSlot[] } | null,
  ): { supply: SourceSupply; byEp: Map<string, SourceEpisode>; links: Map<string, EpisodeLink> } {
    const byEp = new Map<string, SourceEpisode>();
    const links = new Map<string, EpisodeLink>();
    const empty: SourceSupply = { hanime: null, mteamCount: 0 };

    let rows: Array<{ src: string; entry_detail: string | null }>;
    try {
      rows = this.db
        .prepare(
          `SELECT src, entry_detail FROM source_work
            WHERE work_id = ? AND src IN ('hanime','mteam')`,
        )
        .all(workId) as Array<{ src: string; entry_detail: string | null }>;
    } catch {
      // 老库没有 source_work / entry_detail 列 ⇒ 静默降级为「无源站数据」，⛔ 不许 500
      return { supply: empty, byEp, links };
    }

    let total = 0;
    let mteamCount = 0;
    let sawHanime = false;
    /** 全部源站条目（含解析不出集号的），落位在循环之后统一做 */
    const items: SourceEpisode[] = [];

    for (const r of rows) {
      // mteam 是**一集一条**（发布组按集发），行数即发布数
      if (r.src === 'mteam') {
        mteamCount++;
        continue;
      }
      sawHanime = true;
      let arr: Array<Record<string, unknown>> = [];
      try {
        const parsed = JSON.parse(r.entry_detail || '[]');
        if (Array.isArray(parsed)) arr = parsed as Array<Record<string, unknown>>;
      } catch {
        arr = []; // 脏 JSON 当作没抓过，⛔ 不让它把整部作品判崩
      }
      total += arr.length;
      for (const o of arr) {
        const vid = String(o.vid ?? '').trim();
        if (!vid) continue;
        items.push({
          ep: parseSrcEp(o), // ⛔ 这里不许补 1（见下方「落位」注释）
          vid,
          titleJa: (o.title_ja as string) ?? null,
          titleZh: ((o.title_zh ?? o.title) as string) ?? null,
          url: `https://hanime1.me/watch?v=${encodeURIComponent(vid)}`,
          guessed: false,
        });
      }
    }

    /* ── 落位（§83 重写）─────────────────────────────────────────────
       🔴 旧实现的两个坑，都是蛙哥这轮抓到的：
       (1) 「`arr.length === 1` 就补成第 1 集」——`source_work` 是**一个视频一行**，
           每行 arr 恒为 1 条 ⇒ 一部作品有几个独立视频，就有几条被补成「第1集」，
           后两条在 `if (!byEp.has(ep))` 处被去重丢掉。实测 228360 第 3 集
           （vid 407593「so_low ～傲嬌妹妹的失誤～」）就这样被吃掉（蛙哥：『这个第三集其实出了』）。
       (2) 只看集号不看季 ⇒ S00 与 S01 抢同一批「第1話/第2話」（三射面谈、房东小姐）。

       ⇒ 现在分四步：
         ① 显式集号（第N話 / 末尾数字）直接占位，重复保留第一条；
         ② ⭐ §150（2026-11-04 蛙哥「S00E01 就是他的集号」）：
            **集位池 = 正篇那一季 ∪ S00**，键改成 `季:集`。
            旧实现键只有集号、池只有正篇季 ⇒ S00 永远抢不到，而 S00E01 本身
            就是个合法集位（97718 生吃萝莉 Re 的第一话就放在 S00E01）。
         ③ 剩下的「无集号」条目，**先按集名**去比对池里没被占的格子
            （0r214：集位判据 = 集名；这里把 §147 对 mteam 文件的判据推广到源站），
            归一后 ≥4 字符、同池**唯一命中**才落位，`guessed=false`；
            实测 228360 vid 407593「so_low ～生意気ツン妹粗相～」⇔ S01E03
            「～生意気ツン妹粗相～」逐字命中（旧实现因「空位 2 ≠ 未落位 1」整批放弃）。
         ④ 还剩下的，与池里**还没被占的格子**做 1:1 配对
            （数量必须相等，否则一个都不配 —— ⛔ 宁可空着也不瞎填，0ac）；
            配上的打 `guessed=true`，UI 显示「第N話?」交给蛙哥人工确认；
         ⑤ 多季作品（ctx === null）不落位，只报条数。                       */
    /* ⚠️ 整个作品只有**一条**源站记录、标题里又没有集号 ⇒ 认作第 1 集。
       这是旧「arr.length===1 补 1」规则收窄后的正确形态：
       旧写法是**每行**判断，而 `source_work` 一个视频一行 ⇒ 一部作品有几个独立
       视频就有几条被补成第 1 集（228360 三条全补 1，正是蛙哥「第三集其实出了」的坑）。
       现在只在整个作品仅此一条时补 —— 单视频作品（如 97730「Anime Edition」）照旧。 */
    const slotKey = (s: number, e: number) => `${s}:${e}`;

    /* ⭐ §154d：map 权威落位 —— 必须放在一切猜测之前。
       map 来自对齐引擎（与抽屉 hanime 列同源），命中的 vid 直接落 季:集：
       - 多季作品不再被 0da 规则整部清空（85147 实测四季 11 集全部落对）；
       - 「2 个版本 vs 1 个格子」的作品落第一条（306171 泰/日配音），不再 2≠1 整批放弃。 */
    const mapPlaced = new Set<SourceEpisode>();
    if (this.hnEpMap && this.hnEpMap.size) {
      for (const it of items) {
        const hit = this.hnEpMap.get(it.vid);
        if (!hit || hit[0] !== workId) continue;
        const k = slotKey(hit[1], hit[2]);
        if (!byEp.has(k)) {
          byEp.set(k, it);
          mapPlaced.add(it);
        }
      }
    }

    if (
      items.length === 1 &&
      items[0].ep == null &&
      !mapPlaced.has(items[0]) &&
      ctx != null &&
      ctx.slots.some((s) => s.season === ctx.season && s.episode === 1)
    ) {
      items[0].ep = 1;
    }

    const unplaced: SourceEpisode[] = [];
    for (const it of items) {
      if (mapPlaced.has(it)) continue; // ⭐ §154d：map 已落位，⛔ 不再进猜测通道
      if (it.ep == null || ctx == null) {
        unplaced.push(it);
        continue;
      }
      const k = slotKey(ctx.season, it.ep);
      const inPool = ctx.slots.some((s) => slotKey(s.season, s.episode) === k);
      if (inPool && !byEp.has(k)) byEp.set(k, it);
      // 池外的显式集号（还没播 / 被人工排除）与重复条目一律不落位（与旧行为一致）
    }

    const mappable = ctx != null && total > 0;
    let titleHit = 0;
    if (!mappable) {
      /* ⭐ §154d：多季作品（0da）照旧不跑猜测通道，但 map 权威落位**保留** ——
         map 是对齐引擎的正式落位（与抽屉同源），不是猜测。 */
      for (const [k, it] of [...byEp]) {
        if (!mapPlaced.has(it)) byEp.delete(k);
      }
    } else {
      /* ③ 无集号条目先按**集名**认领（0r214 的判据推广到源站） */
      let rest = unplaced;
      const byTitle: SourceEpisode[] = [];
      for (const it of rest) {
        const mine = [it.titleJa, it.titleZh]
          .filter((x): x is string => Boolean(x))
          .map(normEpTitle)
          .filter((x) => x.length >= 4);
        if (!mine.length) {
          byTitle.push(it);
          continue;
        }
        const hit = ctx!.slots.filter((s) => {
          if (byEp.has(slotKey(s.season, s.episode))) return false;
          return [s.nameJa, s.name]
            .filter((x): x is string => Boolean(x))
            .map(normEpTitle)
            .filter((x) => x.length >= 4 && !GENERIC_EP_NAME.test(x))
            .some((en) => mine.some((n) => n.includes(en)));
        });
        if (hit.length === 1) {
          byEp.set(slotKey(hit[0].season, hit[0].episode), it);
          titleHit++;
        } else {
          byTitle.push(it); // 0 命中或命中多格 ⇒ 交回下一步，⛔ 不猜
        }
      }
      rest = byTitle;

      /* ④ 剩下的按「剩余格子」1:1 配对（数量不等 ⇒ 一个都不配）
         🔴 §150 实测 #77656 漆黑的射干：S00 入池后「剩余格子」变成 {S1E4, S00E1} 两个，
            rest 只有 1 条 ⇒ 2≠1 整批放弃，把原本落对的 S1E4(NO.14169 DIRECTOR 版) 弄丢了。
         ⇒ **分两段**：先只看正篇空位（与旧行为一致），正篇没有空位了才用 S00 空位。
           这样「正篇优先」的既有结果一格不动，S00 只在正篇真的满了时才接。 */
      const isZero = (s: SourceSlot) => s.season === 0;
      const freePos = ctx!.slots
        .filter((s) => !isZero(s) && !byEp.has(slotKey(s.season, s.episode)))
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      const freeZero = ctx!.slots
        .filter((s) => isZero(s) && !byEp.has(slotKey(s.season, s.episode)))
        .sort((a, b) => a.episode - b.episode);
      const free = freePos.length > 0 ? freePos : freeZero;
      if (free.length > 0 && free.length === rest.length) {
        for (let i = 0; i < rest.length; i++) {
          const it = rest[i];
          it.guessed = true;
          byEp.set(slotKey(free[i].season, free[i].episode), it);
        }
      }
    }

    let guessed = 0;
    for (const it of byEp.values()) if (it.guessed) guessed++;
    const resolved = byEp.size;
    void titleHit;

    /* ⭐ §85：把链接按 vid 挂上。
       🔴 关键：**落位成功与有没有链接是两件事** ——
          - 落位失败的条目（unplaced）也可以有链接（源站确实有这一条视频，
            只是配不上 TMDB 集号）⇒ 链接挂在 vid 上，不受落位影响。
          - 多季作品 `byEp.clear()` 了，但链接照旧有 ⇒ 前端仍能显示「源站有这些集」，
            只是不标到具体格子上。 */
    const linkMap = this.linkInfo(items.map((it) => it.vid));

    return {
      supply: {
        hanime: sawHanime ? { total, resolved, guessed, mappable } : null,
        mteamCount,
      },
      byEp,
      links: linkMap,
    };
  }

  /**
   * ⭐ 2026-10-29（§82）：一次聚合算出「该从分母里扣掉」的两类集 —— 按 work_id。
   *
   *   - `excluded`：人工排除的格（`work_hidden` scope=episode/season）
   *   - `future`  ：还没有播出的格（`air_date` > 今天，且 Emby 里没有）
   *
   * 🔴 为什么合成一个方法：`overview()` 和 `shortageList()` 都要同一口径。
   *    拆成两个方法，迟早出现「总览扣了、缺集清单没扣」⇒ 两个页签数字对不上（0lx）。
   * ⚠️ `workIntake()` 不用它 —— 它本来就逐格渲染，在循环里现算（那是逐集页的真相源）。
   * ⚠️ 老库没有 `work_hidden` 表时 excluded 返回空集，⛔ 不许 500。
   */
  private deductions(): {
    excluded: Map<number, number>;
    future: Map<number, number>;
  } {
    const excluded = new Map<number, number>();
    const future = new Map<number, number>();

    if (this.hasHiddenTable) {
      try {
        const rows = this.db
          .prepare(
            `SELECT te.work_id AS wid, COUNT(*) AS n
               FROM tmdb_episode te
              WHERE EXISTS (SELECT 1 FROM work_hidden h
                             WHERE h.scope = 'episode' AND h.unhidden_at IS NULL
                               AND h.key = CAST(te.work_id AS TEXT) || ':S' || CAST(te.season AS TEXT)
                                       || ':E' || CAST(te.episode AS TEXT))
                 OR EXISTS (SELECT 1 FROM work_hidden h
                             WHERE h.scope = 'season' AND h.unhidden_at IS NULL
                               AND h.key = CAST(te.work_id AS TEXT) || ':S' || CAST(te.season AS TEXT))
              GROUP BY te.work_id`,
          )
          .all() as Array<{ wid: number; n: number }>;
        for (const r of rows) excluded.set(Number(r.wid), Number(r.n));
      } catch {
        /* 降级：当作没有排除 */
      }
    }

    try {
      /* ⚠️ 必须显式排掉被抓出来已排除的格 —— ⛔ 不能用「未来数 − 排除数」去凑，
         那样一旦有「已播出的集被排除」，两边会互相抵消，把真实的未来集算没了。 */
      const hidGuard = this.hasHiddenTable
        ? `AND NOT EXISTS (SELECT 1 FROM work_hidden h
                            WHERE h.scope = 'episode' AND h.unhidden_at IS NULL
                              AND h.key = CAST(te.work_id AS TEXT) || ':S' || CAST(te.season AS TEXT)
                                      || ':E' || CAST(te.episode AS TEXT))
           AND NOT EXISTS (SELECT 1 FROM work_hidden h
                            WHERE h.scope = 'season' AND h.unhidden_at IS NULL
                              AND h.key = CAST(te.work_id AS TEXT) || ':S' || CAST(te.season AS TEXT))`
        : '';
      // 已入库的不算未播出（真出现在 Emby 里就是有资源）
      const rows = this.db
        .prepare(
          `SELECT te.work_id AS wid, COUNT(*) AS n
             FROM tmdb_episode te
            WHERE te.air_date IS NOT NULL AND te.air_date > ?
              AND NOT EXISTS (SELECT 1 FROM emby_episode ee
                               WHERE ee.tmdb_id = te.work_id
                                 AND ee.season = te.season AND ee.episode = te.episode
                                 AND ee.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync'))
              ${hidGuard}
            GROUP BY te.work_id`,
        )
        .all(this.today) as Array<{ wid: number; n: number }>;
      for (const r of rows) future.set(Number(r.wid), Number(r.n));
    } catch {
      /* 老库没有 emby_episode / air_date ⇒ 当作没有未播出的集 */
    }

    return { excluded, future };
  }

  /** 全局统计（看板顶部读数） */
  overview(): {
    poolTotal: number;
    owned: number;
    complete: number;
    partial: number;
    missingWork: number;
    unlisted: number;
    totalEpisodes: number;
    ownedEpisodes: number;
    episodeCoveragePct: number;
    /** ⭐ 被人工排除的集数（已从 totalEpisodes 分母里扣掉） */
    excludedEpisodes: number;
    /** ⭐ §82：还没播出的集数（已从 totalEpisodes 分母里扣掉） */
    futureEpisodes: number;
  } {
    const pool = this.db
      .prepare(`SELECT COUNT(*) n, COALESCE(SUM(episode_total),0) eps FROM tmdb_work WHERE ${this.visible}`)
      .get() as { n: number; eps: number };

    const local = this.db
      .prepare('SELECT COUNT(DISTINCT tmdb_id) n FROM local_work WHERE tmdb_id IS NOT NULL')
      .get() as { n: number };
    void local; // 仅用于排障，生产数字一律用下面的 ownedIds

    // 🔴 ownedIds 必须与 pool 用**同一个可见性条件**。
    // 否则被隔离作品（is_quarantined=1）会被算进 owned，
    // 它又不在 pool.n 里 → missingWork 被凭空压低，缺口少报。
    // ⭐ 2026-10-27（§70）：数据源由 local_work 换成 emby_series（Emby 里番库同步快照）。
    const ownedIds = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT s.tmdb_id AS tmdb_id
             FROM emby_series s
             JOIN tmdb_work w ON w.id = s.tmdb_id
             WHERE s.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')
               AND w.${this.visible}`,
          )
          .all() as Array<{ tmdb_id: number }>
      ).map((r) => Number(r.tmdb_id)),
    );

    // 齐集：TMDB 有集数声明，且本地有该 tmdbid 且格子数不少于声明值
    //
    // ⚠️ localEps 必须与 workIntake() 用**同一条规则**算，否则总览和逐集对不上。
    const LOCAL_EPS_SQL = this.localEps;

    /* 🔴 2026-10-29（§81）：被排除的集要从**分母**里扣掉，否则「排除过假集」的
       作品永远差那么几集 ⇒ 永远算 partial ⇒ 永远挂在缺集清单上（蛙哥 #3 的根因之一）。
       ⭐ §82：未播出的集同理 —— 播出日还在下个月，凭什么算「你没下」？ */
    const { excluded: excludedMap, future: futureMap } = this.deductions();

    const matched = this.db
      .prepare(
        `SELECT w.id, w.episode_total, ${LOCAL_EPS_SQL} AS localEps
         FROM tmdb_work w WHERE w.${this.visible}`,
      )
      .all() as Array<{ id: number; episode_total: number; localEps: number }>;

    let complete = 0;
    let partial = 0;
    let ownedEps = 0;
    let excludedEpsTotal = 0;
    let futureEpsTotal = 0;

    for (const m of matched) {
      const ex = excludedMap.get(Number(m.id)) ?? 0;
      const fu = futureMap.get(Number(m.id)) ?? 0;
      excludedEpsTotal += ex;
      futureEpsTotal += fu;
      if (!ownedIds.has(m.id)) continue;
      ownedEps += m.localEps;
      const declared = Math.max(0, Number(m.episode_total || 0) - ex - fu);
      if (declared > 0 && m.localEps >= declared) complete++;
      else partial++;
    }

    const missingWork = pool.n - ownedIds.size;

    // 🔴 反向缺口：本地有、看板主库无。
    //
    // 扫描器遇到目录名里的 tmdbid 不在 tmdb_work 时，会把 local_work.tmdb_id
    // 写成 NULL（外键约束），原始 id **只存在于 dir_name**。
    // 所以这里绝不能只查 `tmdb_id IS NOT NULL` —— 那样恒为 0，
    // 恰恰把最该被看见的那批「本地有、主库没有」全漏掉。
    // 必须从 dir_name 复原 raw id 再比对。
    //
    // 同时过滤掉「只因被隔离而不计入」的目录：那不是真缺口，
    // 是纯度判定的结果，属于另一件事。
    const unlistedRows = (
      this.db
        .prepare(
          `SELECT lw.id, lw.dir_name, lw.tmdb_id
           FROM local_work lw
           WHERE NOT EXISTS (
             SELECT 1 FROM tmdb_work w
              WHERE w.id = lw.tmdb_id AND w.${this.visible}
           )`,
        )
        .all() as Array<{ id: number; dir_name: string; tmdb_id: number | null }>
    ).filter((r) => {
      if (r.tmdb_id != null) return false;
      const raw = parseTmdbIdFromDir(r.dir_name);
      if (raw == null) return false;
      // 主库有这条但被隔离 → 是「隔离」不是「漏收」，不计入反向缺口
      const inPool = this.db
        .prepare('SELECT is_quarantined FROM tmdb_work WHERE id = ?')
        .get(raw) as { is_quarantined: number | null } | undefined;
      return !inPool || Number(inPool.is_quarantined) !== 1;
    });

    const unlisted = unlistedRows.length;

    return {
      poolTotal: pool.n,
      owned: ownedIds.size,
      complete,
      partial,
      missingWork: Math.max(0, missingWork),
      unlisted,
      /* 🔴 分母同样要扣掉被排除的格 —— 否则覆盖率永远到不了 100%，
         「集在 Emby」那条进度条会永远差一截（蛙哥 #3 的同一根因）。
         ⭐ §82：未播出的集同样扣（分母 = 真正该有的集）。 */
      totalEpisodes: Math.max(0, pool.eps - excludedEpsTotal - futureEpsTotal),
      ownedEpisodes: ownedEps,
      episodeCoveragePct:
        pool.eps - excludedEpsTotal - futureEpsTotal > 0
          ? Number(
              (
                (ownedEps / (pool.eps - excludedEpsTotal - futureEpsTotal)) *
                100
              ).toFixed(1),
            )
          : 0,
      excludedEpisodes: excludedEpsTotal,
      futureEpisodes: futureEpsTotal,
    };
  }

  /** 逐集状态（单部作品）—— MP 详情页的数据源 */
  workIntake(workId: number): WorkIntake | null {
    const w = this.db
      .prepare(
        `SELECT id, media_type, name_zh, name_original, year, episode_total, poster_local
         FROM tmdb_work WHERE id = ? AND ${this.visible}`,
      )
      .get(workId) as
      | {
          id: number; media_type: 'tv' | 'movie'; name_zh: string | null;
          name_original: string | null; year: number | null;
          episode_total: number; poster_local: string | null;
        }
      | undefined;

    if (!w) return null;

    // ⭐ 2026-10-27（§70）：逐集入库判据也换成 **Emby 里番库**。
    //    `emby_episode` 直接给 (season, episode)，⛔ 不再需要「从文件名解析集号、
    //    解析不出再单文件兜底」那一整套猜测逻辑 —— Emby 自己已经给准了。
    const seriesRow = this.db
      .prepare(
        `SELECT path FROM emby_series
          WHERE tmdb_id = ?
            AND synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')`,
      )
      .get(workId) as { path: string | null } | undefined;

    const embyRows = this.db
      .prepare(
        `SELECT season, episode, path AS file_path
           FROM emby_episode
          WHERE tmdb_id = ?
            AND synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')
          ORDER BY season, episode`,
      )
      .all(workId) as Array<{
        season: number | null; episode: number | null; file_path: string | null;
      }>;

    const localFiles = embyRows.map((r) => ({
      dir_path: seriesRow?.path ?? '',
      file_name: r.file_path ? (r.file_path.split('/').pop() ?? null) : null,
      file_path: r.file_path ?? '',
      season: r.season,
      episode: r.episode,
    }));

    const dirSet = new Set(localFiles.map((f) => f.dir_path).filter(Boolean));
    const unparsed = localFiles.filter((f) => f.episode == null).length;

    // 🔴 2026-10-27（§70）：原来这里有一整套「目录里只有一个文件且集号解析不出 ⇒
    //    按 E01 计入」的兜底（实测 46 部单本 OVA 属这类）。换成 Emby 判据后
    //    **整段删掉** —— Emby 的 `IndexNumber` 就是权威集号，不存在「解析不出」，
    //    留着只会让人误以为还有这层猜测（0lx：判据不许有第二份拷贝）。

    // 建格子索引：season:episode -> 文件
    const cellMap = new Map<string, { name: string | null; path: string | null }>();
    for (const f of localFiles) {
      if (f.season == null || f.episode == null) continue;
      const k = `${f.season}:${f.episode}`;
      // 同一格多个文件时保留第一个（用户偏好「多版本不擅自合并」）
      if (!cellMap.has(k)) {
        cellMap.set(k, { name: f.file_name, path: f.file_path });
      }
    }

    // TMDB 侧应有的格子
    // ⚠️ 必须带 media_type：schema v5 起 tmdb_episode 主键含 media_type，
    //    只按 work_id 查会把同 id 的 tv/movie 季集混在一起。
    const eps = this.db
      .prepare(
        `SELECT season, episode, ep_name, ep_name_ja, air_date, still_local
         FROM tmdb_episode
         WHERE work_id = ? AND media_type = ?
         ORDER BY season, episode`,
      )
      .all(workId, w.media_type) as Array<{
        season: number; episode: number; ep_name: string | null; ep_name_ja: string | null;
        air_date: string | null; still_local: string | null;
      }>;

    const bySeason = new Map<number, EpisodeCell[]>();
    const missingBySeason = new Map<number, number[]>();
    let ownedCount = 0;
    // ⚠️ 缺集必须带季号。多季作品的 E01 在每一季都可能出现，
    //    只平铺集号会出现「缺 E01 E02 E03 E01 E02 E03 E04 E05」这种重复串
    //    （实测 2024「梦见的少女」就是这样）。
    const allMissing: number[] = [];
    const missingLabeled: string[] = [];
    /* 🔴 2026-10-29（§81 蛙哥 #3）：被人工排除的格 —— ⛔ 不算缺集、⛔ 不算应有集数，
       但**留在列表里**（灰掉 + 显示「已排除」），否则蛙哥会以为数据丢了。 */
    const hid = this.hiddenCells(workId);
    const excludedLabeled: string[] = [];
    let excludedCount = 0;

    /* ⭐ 2026-10-29（§82）：源站供给 —— hanime 分集能不能落到 TMDB 的格子上。
       🔴 只有「正篇只有一季」的作品才能落：源站集号是线性的，TMDB 按季切，
          多季作品硬挂必然错位（0da）。多季时 byEp 为空，只报条数。 */
    /* ⭐ §146（2026-11-03 蛙哥「明明 hanime 有信息，为什么来源会没有 hanime」）：
       被人工屏蔽的季（`work_hidden` scope=season）已经从集数/入库判定里扣掉了，
       ⛔ 却仍参与这里的「单季判定」——
       实测 98973：屏蔽 TMDB 脏季 S2 后只剩 S1 五集，判据仍当「多季」⇒
       `singleSeason = null` ⇒ 整部作品的逐集 H 源全空（来源列全「H 无」），
       而 hanime 明明有 1080p 233MB。
       ⇒ 季集合只看**没被屏蔽的季**（与「排除的集不计分母」同一口径，0lx）。 */
    const liveEps = eps.filter((e) => !hid.seasons.has(e.season));
    const posSeasonSet = new Set(liveEps.map((e) => e.season).filter((s) => s > 0));
    const allSeasonSet = new Set(liveEps.map((e) => e.season));
    const singleSeason =
      posSeasonSet.size === 1
        ? [...posSeasonSet][0]
        : posSeasonSet.size === 0 && allSeasonSet.size === 1
          ? [...allSeasonSet][0]
          : null;
    const todayStr = this.today;

    /* ⭐ §83：能落位的集位池 —— 该季里**已经可能出片**的集：
       已入库的（Emby 里有就是出了）+ 播出日已到的。
       ⚠️ 未播出的集不算：源站不可能有还没播的那一集，算进去会让
          「源站 3 条 vs 空缺 4 个」永远配不上（0af 假空位）。
       ⚠️ 全都配不上时退化成该季全部集号，避免「元数据没 air_date ⇒ 一条都挂不上」。

       ⭐ §150（蛙哥「S00E01 就是他的集号」）：池里**加上 S00**。
       旧实现 `allowEps` 只收正篇季的集号 ⇒ S00E01 永远拿不到源，
       而 TMDB 把第一话放进 S00E01 的作品不少（97718 生吃萝莉 Re）。 */
    let slots: SourceSlot[] = [];
    if (singleSeason != null) {
      const inPool = eps.filter((e) => e.season === singleSeason || e.season === 0);
      const ready = inPool.filter(
        (e) =>
          cellMap.has(`${e.season}:${e.episode}`) ||
          (e.air_date != null && String(e.air_date) <= todayStr),
      );
      const pick = ready.length > 0 ? ready : inPool;
      slots = pick.map((e) => ({
        season: e.season,
        episode: e.episode,
        name: e.ep_name,
        nameJa: e.ep_name_ja,
      }));
    }

    const { supply, byEp: srcByEp, links: linkMap } = this.sourceInfo(
      workId,
      singleSeason == null ? null : { season: singleSeason, slots },
    );

    /* ⭐ §85：下载状态（`work_dl` 表）—— 前端要显示「已下 / 下载中 / 失败」。
       🔴 口径：与 `source_link` 同一张「下载相关」的表族，
          matcher 一并读，避免 server 层再二次注入（少一层映射 = 少一处对不上）。
       ⚠️ 取 vid 集合要**全部**（含未落位的）—— 未落位的也可能下过。 */
    const dlState = this.dlStatus([...linkMap.keys()]);

    const futureLabeled: string[] = [];
    let futureCount = 0;

    for (const e of eps) {
      const k = `${e.season}:${e.episode}`;
      const hit = cellMap.get(k);
      const isExcluded = hid.seasons.has(e.season) || hid.eps.has(k);
      // 排除的格即使 Emby 里有也不算出库（分子分母同时减，与 board.ts 同语义）
      const owned = Boolean(hit) && !isExcluded;
      /* ⭐ §83 季守卫（§150 修订 / §154d 再修订）：
         旧实现「源站集号只能挂正篇那一季、S00 一律不挂」——
         理由是 S00 与 S01 的集号都是 1、2，不判季就会把同一批「第1話/第2話」挂两遍。
         ⭐ 现在 `byEp` 的键是 `季:集`，一个源条目只会落进**一个**格子，
         天然不会挂两遍 ⇒ S00 可以正常参与（蛙哥：「S00E01 就是他的集号」）。
         多季作品（singleSeason == null）原只报条数（0da）——
         ⭐ §154d：map 权威落位（对齐引擎同源）给多季作品也填了精确 季:集，
            ⇒ 改成**直接按键取**，不再按「是不是单季」放行。 */
      const srcCell = srcByEp.get(`${e.season}:${e.episode}`) ?? null;
      /* ⭐ §82「未播出」：Emby 里没有 + 播出日还没到 ⇒ 不是缺集。
         ⚠️ 已入库的不算未播出（真出现在 Emby 里就是有资源，元数据的日期不作数）。
         ⭐ §83：源站已有资源也不算未播出 —— 元数据日期是小道消息，源站挂出来了就是出了。 */
      const isFuture =
        !owned && !isExcluded && !srcCell && e.air_date != null && String(e.air_date) > todayStr;
      if (isExcluded) {
        excludedCount++;
        excludedLabeled.push(
          `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`,
        );
      } else if (owned) {
        ownedCount++;
      } else if (isFuture) {
        futureCount++;
        futureLabeled.push(
          `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`,
        );
      } else {
        allMissing.push(e.episode);
        // ⭐ 所有季都带前缀。Specials(season=0) 尤其必须带：
        //   实测 272955「梦见的少女」有 S00E01-03 + S01E01-05，
        //   不带前缀就会显示成「缺 E01 E02 E03 E01 E02 E03 E04 E05」——
        //   E01~E03 出现两次是对的（Specials 与正篇各一组），
        //   但用户看到的一定以为重复了。
        missingLabeled.push(
          `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`,
        );
        if (!missingBySeason.has(e.season)) missingBySeason.set(e.season, []);
        missingBySeason.get(e.season)!.push(e.episode);
      }

      if (!bySeason.has(e.season)) bySeason.set(e.season, []);
      bySeason.get(e.season)!.push({
        season: e.season,
        episode: e.episode,
        name: e.ep_name,
        airDate: e.air_date,
        still: e.still_local ? `/images/${e.still_local}` : null,
        /* ⚠️ 与 board.ts 的 `blurPath()` 同一式（只替换首段目录名，文件名里的
           poster/still 字样不能动）—— 对齐表和入库检测的剧照必须同一份糊图，
           否则同一集在两个页签里一个能看一个看不清。 */
        stillBlur: e.still_local
          ? `/images/${e.still_local.replace(/^(poster|still)\//, (_m, d: string) => `${d}_blur/`)}`
          : null,
        owned,
        fileName: hit?.name ?? null,
        filePath: hit?.path ?? null,
        excluded: isExcluded,
        // ⭐ §83：只有正篇季才挂源站记录（Special 恒为 null，见上方 srcCell 注释）
        src: srcCell,
        /* ⭐ §85：下载链接 —— 跟着 **vid** 走。
           🔴 链接挂在 srcCell 上（源站记录里才有 vid），
              所以「没有源站记录 ⇒ 没有链接」是自洽的。
           ⚠️ fileBase 在这里补上（需要 TMDB 作品名 + 季集号，§85 落盘命名用）。 */
        link: srcCell
          ? (() => {
              const l = linkMap.get(srcCell.vid);
              if (!l) return null;
              const fileBase = buildLinkFileBase(w.name_zh, w.id, e.season, e.episode);
              return { ...l, fileBase };
            })()
          : null,
        /* ⭐ §85：下载状态 —— 由 server 层二次注入（matcher 不读 work_dl） */
        dl: srcCell ? (dlState.get(srcCell.vid) ?? null) : null,
        future: isFuture,
      });
    }

    const seasons: SeasonGroup[] = [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sn, list]) => {
        const missing = missingBySeason.get(sn) ?? [];
        /* ⭐ §82：`live` = 真正该有的集 = 排除的不算、未播出的也不算。
           否则「播出日还在下个月」的集会把这一季的分母撑大、永远差几集。 */
        const live = list.filter((x) => !x.excluded && !x.future);
        return {
          season: sn,
          name: sn === 0 ? 'Specials' : `Season ${sn}`,
          isSpecials: sn === 0,
          total: live.length,
          owned: live.filter((x) => x.owned).length,
          missing,
          excluded: list.filter((x) => x.excluded).length,
          future: list.filter((x) => x.future).length,
          episodes: list,
        };
      });

    // ⚠️ 本地有但 TMDB 没声明的格子（如 TMDB 少标了集数）→ 单独报出，不混进缺集
    const declaredKeys = new Set(eps.map((e) => `${e.season}:${e.episode}`));
    const extra = [...cellMap.entries()]
      .filter(([k]) => !declaredKeys.has(k))
      .map(([k]) => k);

    /* 🔴 2026-10-29（§81）：判定要用**扣掉排除后的应有集数**。
       原实现拿 `w.episode_total` 直接比 ⇒ 后宫露营 S00 被排除后
       10 集里永远只收得到 8 ⇒ 永远 complete 不了、永远挂在缺集清单上。
       ⭐ §82：未播出的集同样要扣 —— 它本来就不该「现在就在本地」。 */
    const declaredRaw = Number(w.episode_total || 0) || eps.length;
    const declared = Math.max(0, declaredRaw - excludedCount - futureCount);

    const status: WorkStatus =
      dirSet.size === 0 ? 'missing_work'
      : declared > 0 && ownedCount >= declared ? 'complete'
      : allMissing.length > 0 ? 'partial'
      : ownedCount > 0 ? 'complete'
      : 'partial';

    return {
      workId: w.id,
      status,
      nameZh: w.name_zh,
      nameOriginal: w.name_original,
      year: w.year,
      mediaType: w.media_type,
      posterLocal: w.poster_local ? `/images/${w.poster_local}` : null,
      /* ⭐ §82：模糊封面 —— 与 board.ts 的 blurPath() 同一套「只换首段目录名」规则。
         matcher 包不依赖 server 包，所以这里写一份等价映射，改一边要同步另一边。 */
      posterBlur: w.poster_local
        ? `/images/${w.poster_local.replace(/^poster\//, 'poster_blur/')}`
        : null,
      totalEpisodes: declared,
      ownedEpisodes: ownedCount,
      missingEpisodes: allMissing,
      missingLabeled,
      excludedLabeled,
      futureLabeled,
      futureEpisodes: futureCount,
      source: supply,
      excludedEpisodes: excludedCount,
      unparsedFiles: unparsed,
      localDir: dirSet.size ? [...dirSet][0] : null,
      seasons,
      // 附加：TMDB 未声明但本地有的格子（数量）
      ...(extra.length ? {} : {}),
    };
  }

  /**
   * 全局缺集清单（补货用）
   * 按作品聚合，每部一行：缺哪几集一目了然
   */
  shortageList(opts: { limit?: number; onlyMissing?: boolean; includeHidden?: boolean } = {}): Array<{
    workId: number; nameZh: string | null; year: number | null;
    total: number; owned: number; missing: string;
  }> {
    // ⭐ 逐件屏蔽：默认跳过已屏蔽的作品（蛙哥 2026-10-20）。
    //    🔴 **必须在 SQL 里过滤**，⛔ 不能在 JS 里 filter 后再 slice(limit)
    //       —— 否则 limit 会在过滤前截断 ⇒ 漏掉本该出现的条目。
    // 🔴🔴 本轮实测踩到：占位符数与参数个数必须**严格相等**。
    //    守卫为空串（includeHidden=true 或没屏蔽任何东西）时，
    //    若照样传 hiddenArgs ⇒ `column index out of range`。
    //    ✅ 正解：hiddenArgs 只在守卫非空时才填。
    const hidden = this.hiddenKeys('board');
    const useGuard = !opts.includeHidden && hidden.size > 0;
    const hiddenArgs: string[] = useGuard ? [...hidden] : [];
    const hiddenGuard = useGuard
      ? `AND CAST(w.id AS TEXT) NOT IN (${hiddenArgs.map(() => '?').join(',')})`
      : '';
    const rows = this.db
      .prepare(
        `SELECT w.id, w.name_zh, w.year, w.episode_total,
                (SELECT COUNT(*) FROM tmdb_episode e
                  WHERE e.work_id = w.id AND e.media_type = w.media_type) AS eps,
                ${this.localEps} AS localEps
         FROM tmdb_work w
         WHERE EXISTS (SELECT 1 FROM emby_series s
                        WHERE s.tmdb_id = w.id
                          AND s.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync'))
           ${hiddenGuard}
         ORDER BY w.year DESC`,
      )
      // 🔴 hiddenGuard 里有 ? 占位符 ⇒ 参数必须跟着传（铁律 0p-③：字面量 vs 占位符）
      .all(...(hiddenArgs as never[])) as Array<{
        id: number; name_zh: string | null; year: number | null;
        episode_total: number; eps: number; localEps: number;
      }>;

    // ⭐ 排除的格 + 未播出的格，都要从应有集数里扣（与 overview / workIntake 同一口径）
    const { excluded: exMap, future: fuMap } = this.deductions();

    const out: Array<{
      workId: number; nameZh: string | null; year: number | null;
      total: number; owned: number; missing: string;
    }> = [];

    for (const r of rows) {
      const declared = Math.max(
        0,
        Number(r.episode_total || 0) - (exMap.get(Number(r.id)) ?? 0) - (fuMap.get(Number(r.id)) ?? 0),
      );
      if (opts.onlyMissing && r.localEps >= declared) continue;
      const missing = this.workIntake(r.id);
      if (!missing || missing.missingEpisodes.length === 0) continue;
      out.push({
        workId: r.id,
        nameZh: r.name_zh,
        year: r.year,
        total: missing.totalEpisodes,
        owned: missing.ownedEpisodes,
        missing: missing.missingLabeled.join(' '),
      });
    }

    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * 反向缺口明细：本地有、看板主库无的作品。
   *
   * ⭐ 这是产品要回答的第二个问题（「我下了但 TMDB 基准里没有」）。
   *    这类目录的 tmdb_id 因外键写成 NULL，只能从 dir_name 复原。
   *    排除被隔离作品 —— 那是纯度判定的事，不是「主库漏收」。
   */
  unlistedList(opts: { limit?: number; includeHidden?: boolean } = {}): Array<{
    rawId: number;
    dirName: string;
    dirPath: string;
    fileCount: number;
    parsedEpisodes: number;
    yearHint: number | null;
  }> {
    // ⭐ 逐件屏蔽（蛙哥 2026-10-20）：反向缺口的实体是**本地目录**，
    //    它没有 src_key（那是 source_work 的键）⇒ 用「已屏蔽源记录的番号/title」
    //    做 dir_name 子串匹配，命中即跳过。
    //    ⚠️ 这是**近似**：目录名里通常带番号，所以命中率很高，但不是精确主键。
    const hiddenSrc = this.hiddenKeys('unconfirmed');
    const hiddenArgs: string[] = [];
    let hiddenUnlistedGuard = '';
    if (!opts.includeHidden && hiddenSrc.size > 0) {
      // 🔴 一条源一个 LIKE ⇒ 参数化，⛔ 不用字符串拼接（防注入）
      const likes = [...hiddenSrc].map((k) => {
        hiddenArgs.push('%' + k + '%');
        return 'lw.dir_name LIKE ?';
      });
      hiddenUnlistedGuard = `AND NOT (${likes.join(' OR ')})`;
    }

    const rows = this.db
      .prepare(
        `SELECT lw.id, lw.dir_name, lw.dir_path,
                (SELECT COUNT(*) FROM local_file f WHERE f.work_id = lw.id) AS fileCount,
                (SELECT COUNT(*) FROM local_file f
                  WHERE f.work_id = lw.id AND f.episode IS NOT NULL) AS parsedEpisodes
         FROM local_work lw
         WHERE lw.tmdb_id IS NULL
           ${hiddenUnlistedGuard}
         ORDER BY lw.dir_name`,
      )
      .all(...(hiddenArgs as never[])) as Array<{
        id: number; dir_name: string; dir_path: string;
        fileCount: number; parsedEpisodes: number;
      }>;

    const quarantine = new Set(
      (
        this.db
          .prepare('SELECT id FROM tmdb_work WHERE is_quarantined = 1')
          .all() as Array<{ id: number }>
      ).map((r) => Number(r.id)),
    );

    const out = rows
      .map((r) => {
        const rawId = parseTmdbIdFromDir(r.dir_name);
        if (rawId == null) return null;
        if (quarantine.has(rawId)) return null;
        return {
          rawId,
          dirName: r.dir_name,
          dirPath: r.dir_path,
          fileCount: Number(r.fileCount),
          parsedEpisodes: Number(r.parsedEpisodes),
          yearHint: parseYearFromDir(r.dir_name),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return opts.limit ? out.slice(0, opts.limit) : out;
  }
}