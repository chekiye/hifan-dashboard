/**
 * 看板数据 API —— 8848 的主看板（项目的产品本身）
 *
 * ⭐ 产品定位（用户 2026-10-14 反复纠正，最高优先级）：
 *   8848 不是「全量库核对工具」，主线是
 *     「TMDB 2000+ 里番/成人动画 完整词条 → 本地文件匹配
 *       → 哪部没下 / 哪部下了缺集 / 哪部完整」
 *   所以本文件是唯一的主看板数据源，读 tmdb_work（统一主库）。
 *
 *   此前把 v7 的 1547 条塞进 library_work 并加了第三个页签
 *   「全量库 v7」，等于用核对结果页顶替了主看板 —— 用户明确否决
 *   （原话：「你这是倒反天乾」「这项目不就废了吗」）。
 *
 * ⭐ 统一主库 = tmdb_work ∪ (library_work 独有记录)
 *   实测（NAS 线上库 2026-10-14）：1284 + 357 = 1641 部。
 *   提升由 packages/collector/src/enrich_pool.ts 完成，本文件只读不写。
 *
 * ⭐ v7 证据链的定位：**详情抽屉里的次要信息**，不是卡面主内容。
 *   作品卡与列表保持纯 TMDB 作品形态（剧名/原名/季度/集数/封面），
 *   证据只在 openDetail 的「收录来源与核对依据」区块出现。
 */
import type { DB } from '@hifan/core';
/* ⭐ §87：逐集对照要挂下载链接 —— 复用 matcher 的唯一实现（按 vid 查 source_link） */
import { readEpisodeLinks } from '@hifan/matcher';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import type { HiddenService } from './hidden.js';
import { TagMark } from './tag_mark.js';
import {
  alignEpisodes,
  alignVol,
  type AlignItem,
  type AlignResult,
  type AlignSeason,
} from './align.js';

export interface WorkBrief {
  id: number;
  mediaType: 'tv' | 'movie';
  /** 原始标题（日文/罗马字/英文）—— schema v3 起字段名 name_original */
  nameOriginal: string | null;
  nameZh: string | null;
  year: number | null;
  firstAirDate: string | null;
  episodeTotal: number;
  seasonCount: number;
  popularity: number | null;
  sourceChannel: string;
  /**
   * 🔴🔴 **作品级**简介（2026-10-31 §107）
   *
   * 取自 TMDB 作品级接口（`/tv/{id}`、`/movie/{id}`）的 `overview`，
   * 只存**中文**（language=zh-CN）。
   *
   * 为什么必须单独存（不能只靠集级）：
   *   实测 #103258「姬辱 ~公主双人狩猎~」作品级有 274 字中文简介，
   *   而它的 3 集**集级 overview 全是空** ⇒ 老路径必然误报「TMDB 无简介」。
   *
   * `null` = TMDB 上确实没有中文简介（⛔ 不编、不回落成英文）。
   */
  overview: string | null;
  posterLocal: string | null;
  /**
   * 🔴 安全模式专用的**预生成模糊图**（2026-10-23）
   *
   * 为什么不用 CSS `filter: blur()`：CSS 模糊是「原图照传、屏幕上才挡」——
   * 旁边的人看 DevTools / 抓包就能拿到原图，对隐私毫无意义。
   * 预生成 ⇒ blur 档只请求这张，原图**根本不进网络**。
   * 对应文件：images/poster_blur/{type}/{id}.jpg
   */
  posterBlur: string | null;
  /**
   * ⭐ 全集入库（2026-10-27 §71，作者要求）
   *
   * 「再做一个全集入库的标识，直接在 8848 看板就能看到的，不用点进去二级菜单
   *   就看得出来，哪一部已经全集入库了」
   *
   * `embyEps` = Emby「动画里番」库里这部作品已收录的集数；
   * `null` 表示**还没同步过**（不知道 ≠ 0，0cs），前端不能画成「0 集」。
   */
  embyEps: number | null;
  /**
   * 分母：`tmdb_episode` 的实际分集行数（**排除已屏蔽的季**）。
   *
   * 🔴 为什么不用 `episodeTotal`：那是 TMDB 元数据快照，与分集行可能不一致；
   *    两个口径混用会出现「已入库 13 / 12 集」这种鬼数字（0ay）。
   */
  embyNeed: number | null;
  /** 是否**已全集入库** —— 卡面绿色勾标的唯一判据 */
  embyFull: boolean;
  /**
   * ⭐ 人工确认入库（2026-10-27 §73，作者）
   *
   * 「针对这些我知道都入库了，但系统无法判断的，我手动标记入库没问题」
   * 「人工标记后的效果和 ai 识别无问题的效果一样」
   *
   * ⇒ 为 true 时 `embyFull` 也为 true（与自动判定**结果一致、显示一致**）。
   *   ⛔ 这只代表「人判断过了」，不代表 Emby 里真收全了 —— 事实仍由 `embyEps/embyNeed` 表达。
   */
  embyVerified: boolean;
  /**
   * 确认之后数据变了（`snap_eps/snap_need` 与当前值不符）⇒ 卡面打 ⚠ 提示复核。
   *
   * 🔴 为什么要有这个：只存一个布尔「已确认」会变成永久假绿 ——
   *    今天确认「8 集收全」，三个月后删了 2 集，卡面还是绿的。快照就是防这个。
   * ⚠️ 快照未知（NULL）⇒ 一律 false（⛔ 不凭空判过期）。
   */
  embyVerifyStale: boolean;
  /**
   * ⭐ 被**集级**排除的集数（2026-10-27 §74）。
   *
   * 作者：「屏蔽本季感觉没用啊，要是遇到风纪委员与风俗活动这种只是缺集的，
   *        你把整季屏蔽了」⇒ 新增集级粒度。
   *
   * `embyNeed` 已扣掉这些集 ⇒ `embyFull` 能真正闭环。
   * 这个字段只用于 tooltip 说明「有效 8 集（已排除 2 集）」，⛔ 不参与判定。
   */
  embyExcluded: number;
  /**
   * ⭐ 待下 / 喜欢（2026-10-28 §80，作者）
   *
   * 「再加一个喜欢（待下，订阅）功能就是我点一下，这一部进入一个待下状态，
   *   空了我去补下载+入库」
   *
   * `true` = 在 `work_want` 里且未撤销（不管已收没收）⇒ 卡片画 ♥ + 可筛「只看待下」。
   * ⛔ 与入库判定完全无关：`embyFull` / `embyEps` 一个都不受影响。
   */
  wanted: boolean;
  /**
   * ⭐ §151 标签命中（2026-11-04 作者：「不想看伪娘、猎奇这种，高亮显示，
   * 让我一眼就看出来，然后避开下载」）
   *
   * §153 起四档：`l1` 避开 / `l2` 谨慎 / `l3` 喜欢 / `l4` 本命
   * （每个数组 = 该作品任一 hanime 源条目的标签里命中该档的标签）
   * ⚠️ 作品级 = 全部源条目标签的**并集**；没 hanime 源条目的作品永远是空（数据边界）。
   * ⛔ 空数组 ≠ 没有标签：只表示「没命中你标过的那些」。设置页「库内 N 部」据此统计。
   */
  tagHits: { l1: string[]; l2: string[]; l3: string[]; l4: string[] };
  /**
   * ⭐ 溯源（用户 2026-10-15 要求）：这条 TMDB 记录是从哪部片匹配出来的
   *
   * 口径：
   *   'both'    = M-TEAM 与 hanime 都指向这一部（互相印证，最可信）
   *   'mteam'   = 只有 M-TEAM 匹配出来
   *   'hanime'  = 只有 hanime 匹配出来
   *   null      = 无源（理论上不该出现，双源库里每条都必须有源）
   */
  srcKinds: Array<'mteam' | 'hanime'>;
  /** 卡面徽标文案 */
  srcBadge: string | null;
  /**
   * ⭐ 是否泡麵番（hanime 源站自标的短篇类型）。
   *
   * 用户 2026-10-15：「泡面番只有hanime有记录，所以泡面番可以独立标识出来，
   * 这样我就知道它只有hanime是对的」。
   *
   * 实测：泡麵番 **100% 只有 hanime 有**（双源且泡面番 = 0 部），
   * M-TEAM 根本不收短篇。所以「仅 hanime」对泡麵番是**正常**而非缺口。
   * 不标识出来的话，用户无法区分「正常的只有hanime」和「真缺口」。
   *
   * 口径：该作品的**全部** hanime 源都标泡麵番才算（混合标的不算）。
   */
  isPaomian: boolean;
}

/** 一条源作品引用（溯源明细） */
export interface SourceRef {
  /** 'mteam' | 'hanime' */
  src: string;
  /** MT 番号 / hanime 聚合 key */
  srcKey: string;
  /** 源站原始标题 —— 匹配错时这就是「它原本是哪部片」 */
  title: string;
  /** MT 厂牌 */
  brand: string | null;
  /** 源站年份（首播年） */
  year: number | null;
  /** 源站集数（= 源站收录的条目数，不是 TMDB 集数） */
  episodes: number | null;
  /**
   * ⭐ 源站**官方**集数（2026-10-21 加）
   *   = 这一行对应的那个 hanime 作品，在源站**作品播放列表页**上的官方集数
   *     （`#sidebar-video-count`）。
   *   · 行级口径：一行 = 一个 hanime 作品 ⇒ 一个 TMDB 作品可能对应多行
   *   · NULL = 还没核过（老数据，或没做过播放列表排查的作品）
   *   为什么要它：没有它，看板分不清「我们只抓到 1 集」（漏抓，可修）
   *              和「源站本来就只有 5 集」（TMDB 口径不同，是绑定问题）。
   */
  officialEpisodes: number | null;
  /** 作品级原名（hanime 视频页 playlist 链接的文字，日文）—— 迁移 #9 */
  workJa?: string | null;
  /** 匹配方式：lw_exact / pool_exact / fuzzy */
  matchBy: string | null;
  /** 匹配分值 */
  matchScore: number | null;
  /**
   * 源站年份跨度，如 [2024, 2025, 2026]。
   * 🔴 2026-10-15 新增：跨年续更的作品只看 first_year 会误判，
   *    溯源时要能看出「源站横跨几年」，才能和 TMDB 逐集播出日对上。
   */
  years: number[] | null;
  /**
   * 逐集明细（目前只有 hanime 有 —— MT 是按番号分条发布的，不存在「系列内集」）。
   * 每项含 vid / year / title / page，溯源时可以指到「第 4 集是哪个视频」。
   */
  entryDetail: SourceEntry[] | null;
  /**
   * hanime 源站自己标的类型，如「裏番」。
   * 🔴 线上存的是**纯字符串** `"裏番"`，不是 JSON 数组 → 必须容错解析。
   */
  genre: string | null;
}

/** 一条自动核对结论（看板溯源面板逐条显示） */
export interface CheckItem {
  /** 因子名，如「年份」「集数」 */
  factor: string;
  /** 'ok' 通过 / 'warn' 待确认 / 'bad' 反证 / 'unknown' 数据缺失无法判 */
  level: 'ok' | 'warn' | 'bad' | 'unknown';
  /** 结论一句话，直接给人看 */
  text: string;
}

/**
 * 六因子自动核对结论。
 *
 * ⭐ 用户 2026-10-16 的核心要求：
 *   「除了年份，标题，还有什么决定性因素，你都需要展示清楚，看的明白」
 *   → 这些因子数据全都在库里，能自动判的就不该让人眼去比。
 *
 * 🔴 只输出「客观事实的核对结果」，绝不输出「已确认」这种结论性判断。
 *   六项全绿也只说明「六项都不矛盾」，不等于同一部作品 —— 那是另一层事。
 */
export interface CrossCheck {
  items: CheckItem[];
  /** 汇总等级：任一 bad → bad；有 warn → warn；全 ok → ok；无判据 → unknown */
  level: 'ok' | 'warn' | 'bad' | 'unknown';
  /** ok/warn/bad 各几条，null 表示该级别为 0 */
  tally: { ok: number | null; warn: number | null; bad: number | null };
}

/** hanime 源站的单集明细 */
export interface SourceEntry {
  /** hanime 视频 id */
  vid: string;
  /** 该集年份 */
  year: number | null;
  /** 该集在源站的标题（通常带「1」「2」等集号） */
  title: string | null;
  /** 源站分类：裏番 / 泡麵番 */
  genre: string | null;
  /** 抓取时在第几页（可回溯抓取行为） */
  page: number | null;
  /**
   * 🔴 hanime **视频详情页**的日文原标题（2026-10-16 补采）。
   *
   * 为什么必须有：hanime 清单页对中译作品只给中文译名，
   *   `制服就這樣穿著` ↔ TMDB `穿着制服就直接上` 判据根本无从下手；
   *   而详情页才有 `制服は着たままで 前編` —— 与 TMDB name_original 完全同语言。
   *   库中 1477 条源记录里只有 3.9% 带假名，且那 3.9% 是作品本身日文标题
   *   （ちょいすじ / メゾフォルテ），**不是「偶尔抓到日文」**。
   *
   * ⚠️ 与 `title` 是**并存**关系，绝不互相覆盖：
   *   `title`    = 清单页中文译名（用户日常核对用）
   *   `title_ja` = 详情页日文原名（与 TMDB name_original 比对用）
   */
  title_ja?: string | null;
  /** 视频页 description 里的**中文标题**（2026-10-21 补抓） */
  title_zh?: string | null;
  /**
   * 🔴 **播放页**完整标题（2026-10-26 §67 补抓）。
   *
   * 为什么单独一列、而不是覆盖 `title`：
   *   作者指认「hanime 的**页面标题**和**播放页标题**不一样」——
   *   看板原来显示清单页短名（「淫魔妖女 5」），
   *   播放页才有完整标题（「淫魔妖女 5 「淫魔妖女Ⅴ ～弥弥～」 [中文字幕]」）。
   *
   * ⛔ **绝不能直接改 `title`**（2026-10-26 实测）：`title` 是 `alignVol()` 的输入，
   *   换成日文播放页标题后卷号提取失效 ⇒ 全库 withSource −26 / extra +64 / 14 部落位崩。
   *   ⇒ `title` 保持原样喂对齐；本字段**只用于显示**（前端 `title_page || title`）。
   */
  title_page?: string | null;
  /**
   * 🔴 源站**播放清单编号**（2026-10-21 补抓入库）。
   *
   * 视频详情页里 `playlist?list=NNNNNN` 的编号 —— 源站自己把它归到哪个合集。
   * 价值：它给「哪几集算同一部」提供了**客观编号**，不再只靠标题相似度推。
   * ⚠️ 但它不是作品硬边界（一个清单可装多部，实测 38 例），只能当辅助证据。
   */
  playlist_id?: string | null;
  /**
   * 🔴 **结构化卷号**（2026-10-24 批次16 标注）。
   *
   * 目前只有 mteam 侧会写：`mteam_extract.py` 展开「一个种子包里的多个视频文件」时
   * 逐个记下卷号（实测 `KSXA-53556` 的两条是 vol=3/vol=4 —— 是**全局卷号**，
   * 不是包内序号；`JDRA-55632` 的两条是 vol=2/vol=3）。
   *
   * ⭐ 为什么有用：`alignVol()` 只认 `vol/巻/第N巻/结尾裸数字/罗马数字`，
   *   对「前篇」「後篇」「第1話」这类**取不到号**（返回 0）。而本字段是入库时
   *   就确定的结构化事实 ⇒ 比从标题猜更硬，`board.ts` 在 `alignVol()` 为 0 时用它兜底。
   *   实例：`JDRA-55653` 前后篇共用同一番号（源站把两集塞进一个种子包），
   *   title 只有「前篇/後篇」⇒ 没有本字段时後篇永远无处可落。
   */
  vol?: number | null;
}

/** 详情抽屉里的次要信息：这条是怎么进主库的（v7 证据链） */
export interface WorkEvidence {
  /** 进主库的通道：'m2_keyword' | 'v7_merge' | null */
  workOrigin: string | null;
  /** v7 三源组合，如 'hanime,mteam,tmdb' */
  discoverySources: string | null;
  /** 人类可读摘要，如 'B · dice=0.92' */
  note: string | null;
  /** 完整证据链（源标题样例、官方别名、匹配方式、类型判定） */
  detail: Record<string, unknown> | null;
  /** ⭐ 溯源明细：这部作品是由哪些源作品匹配出来的 */
  sources: SourceRef[];
  /**
   * ⭐ 六因子自动核对（2026-10-16）。
   * 逐条列出「年份／双源互证／集数／源站类型／题材／匹配方式」的核对结论，
   * 每条给 ok / warn / bad / unknown，附一句人话结论。
   *
   * 🔴 口径：它只核对**数据之间是否矛盾**，不判断「是不是同一部作品」。
   *    六项全绿 = 没有矛盾，**不等于已确认**。
   */
  crossCheck?: CrossCheck;
}

export interface YearBucket {
  year: number;
  total: number;
  tv: number;
  movie: number;
  withSeasons: number;
}

export interface BoardStats {
  total: number;
  tv: number;
  movie: number;
  withPoster: number;
  withSeasons: number;
  totalEpisodes: number;
  fromKeyword: number;
  fromSeed: number;
  /** v7 提升进主库的数量（看板顶栏作为「已并入 v7 核对」提示） */
  fromV7: number;
  /**
   * ⭐ 人工确认入库的部数（2026-10-27 §73）。
   * 与「自动全集」**分开统计**：混在一起会让数字失真，
   * 作者需要能一眼看出「这里面有多少是我人工放的」。
   */
  embyVerified: number;
  /**
   * ⭐ 待下（喜欢但还没收）的部数（2026-10-28 §80）—— 顶栏 ♥ 角标 / 「待下清单」用。
   * 口径：`work_want` 未撤销 **且** `done_at IS NULL` **且** 该作品在看板可见集合里。
   * ⛔ 不含已收的（那些在清单里显示为「已收」，但不算待办）。
   */
  wantPending: number;
  yearSpan: { from: number; to: number } | null;
  /** 收录最少的年份（数据全面性体检） */
  thinYears: Array<{ year: number; total: number }>;
  /**
   * ⭐ 双源覆盖体检（用户 2026-10-15 要求能区分「正常只有hanime」和「真缺口」）。
   *
   * 口径：统计**全部在架可见作品**（🔴 2026-10-20 放开 2000 下限，与看板可见集合对齐 ——
   *   否则看板显示 1350 部、体检只算 2000+ 的，`coverage.total` 与看板总数对不上 = 量纲混用）。
   *   both      MT + hanime 都有
   *   onlyMt    只有 MT          ← 缺口
   *   onlyHnPaomian  只有 hanime 且泡麵番 ← ✅ 正常（M-TEAM 不收短篇）
   *   onlyHnRifan    只有 hanime 且裏番   ← ⚠️ 真缺口
   *   onlyHnUnknown  只有 hanime 且类型不明
   *   neither   都无
   */
  coverage: {
    both: number;
    onlyMt: number;
    onlyHnPaomian: number;
    onlyHnRifan: number;
    onlyHnUnknown: number;
    neither: number;
    total: number;
    /** 泡麵番作品总数（不分来源） */
    paomian: number;
  };
}

const POSTER_BASE = '/images/poster';
const STILL_BASE = '/images/still';

/**
 * 🔴 看板可见性过滤 —— 隔离疑似非里番作品
 *
 * 起因（2026-10-14 18:20，用户反馈「怎么有这么多根本不是里番的剧」）：
 *   主库里混进了美国老爹 / 瑞克和莫蒂 / 英雄联盟双城之战 等主流商业动画。
 *   根因是 v7 把「只有 TMDB 自己收录、零片源验证」的 264 部也当成确认条目提升进来了，
 *   而 TMDB 的 hentai 关键词(198385) 会误标大量商业作品。
 *
 * 为什么是「隔离」不是「删除」：
 *   判定可能有误（里番小众，TMDB 简介常年为空，判据不完美）。
 *   数据一行未删，只打标记；去掉标记即可恢复。
 *   详见 packages/collector/src/quarantine_mainstream.ts
 *
 * ⚠️ 所有看板可见的查询都必须带这个条件，否则隔离会失效。
 */
const VISIBLE = 'is_quarantined = 0';

/**
 * ⭐ 溯源 SQL 片段（用户 2026-10-15 要求）
 *
 * 为什么要做这个：
 *   旧库 1639 部是无源头的 TMDB 记录，匹配错了根本无从查起。
 *   双源建库后每条 tmdb_work 都由 source_work 反查得到，
 *   所以看板能直接回答「这条是哪部片匹配出来的」：
 *     both   = M-TEAM 与 hanime 双源互证
 *     mteam  = 只有 M-TEAM
 *     hanime = 只有 hanime
 *
 * ⚠️ 两张表的连接键是 **(media_type, work_id)**，不是 work_id 单列：
 *   TMDB 的 tv / movie 是两个独立 id 空间（记忆铁律），单列连接会串号。
 */
/* 🔴 2026-10-30（作者：「無意間變成狗 / 為漣蒼士獻上純潔 明明是泡麵番，怎么没标记」）：
   **是判据写错，不是数据缺。**
   `entry_detail` 是 json.dumps 用默认分隔符写出来的 ⇒ 库里实际存的是
   "genre": "泡麵番"（**冒号后面有一个空格**），而这里原来写死 "genre":"泡麵番"
   （无空格）⇒ LIKE 永远匹配不到。569 条泡麵番里只有 3 条（别处写入格式不同）能命中，
   其余全被当成「裏番」⇒ 卡面不出泡麵番徽标、筛选也筛不出来。
   ⇒ 用 REPLACE(entry_detail,' ','') 抹掉所有空格再比，两种写法都吃；
      再并上作品级 genres 列（老数据 entry_detail 可能为空 / 半截 JSON）。
   ⚠️ 改这里就够了 —— 这是全站唯一的口径来源（0lx），
      covStats() 的「泡麵番·仅 hanime」与卡面 isPaomian 都走这条 SQL。
   ⚠️ 本段是 **SQL 模板字符串内部** ⇒ 注释里⛔ 不能出现反引号（会把模板终止掉，0r33）。*/
const SRC_AGG_SQL = `
    SELECT work_id, media_type,
           GROUP_CONCAT(DISTINCT src)                        AS srcs,
           COUNT(*)                                          AS src_count,
           SUM(CASE WHEN src = 'hanime' THEN 1 ELSE 0 END)   AS hn_count,
           /* 泡麵番：见上方 TS 注释（冒号后空格 + genres 兜底） */
           SUM(CASE WHEN src = 'hanime'
                     AND (REPLACE(IFNULL(entry_detail,''), ' ', '') LIKE '%"genre":"泡麵番"%'
                          OR IFNULL(genres,'') LIKE '%泡麵番%')
                    THEN 1 ELSE 0 END)                       AS pm_count
    FROM source_work
    WHERE work_id IS NOT NULL AND status = 'matched'
    GROUP BY work_id, media_type`;

/**
 * 解析 JSON 数组列（source_work.years / source_work.entry_detail）。
 *
 * 🔴 这两列的历史写入不保证干净：可能是 NULL、空串、半截 JSON，
 *    也可能写进去一个对象而不是数组。**一律降级成 null，绝不让一条坏数据
 *    把整个详情接口打成 500** —— 溯源面板坏掉比少显示几行严重得多。
 */
/**
 * ⭐ 2026-10-23：**人工指定集号表**（`data/align_ep_override.json`，与 DB 同目录）
 *
 * 为什么需要：TMDB 一个词条收了**多部子作品**（合集）时，子作品的源站卷号
 *   与 TMDB 的全局集号天然不对应，任何启发式都判不出来 ——
 *   `episode1` 在它自己那部里确实是第 1 集。实例 #258103。
 *
 * 文件结构（一级键 = TMDB work id；二级键 = 源条目 id：
 *   hanime 用 `vid`、mteam 用番号 src_key）：
 *
 *   { "258103": { "MAMA-01": 1, "MAMA-02": 2, "SLDV-005": 4, "SLDV-006": 5 } }
 *
 * ⭐ 2026-10-23：**值也允许写成对象**，用于同时钉季号（源卷号跨季连续时必需）：
 *   { "126810": { "KSXA-53507": { "s": 2, "e": 1 } } }
 *   数字 = 只钉集号（季内）；对象 = 钉季号 s（TMDB season_number）+ 集号 e。
 *
 * ⚠️ 读不到 / 解析失败 ⇒ 返回空表（⛔ 绝不让它把详情接口打成 500）。
 * ⚠️ 带 mtime 缓存：改文件即时生效，不用重启容器。
 */
type EpOvVal =
  | number
  | {
      s?: number;
      e?: number | number[];
      season?: number;
      episode?: number | number[];
    };
/* ⭐ §109（2026-10-31 作者：「tmdb 剧集信息更新了，现在抓到的是被污染过的词条」）
 *
 * 实测：248428 直面无罪的 S01E01 在 TMDB 上被改成了
 *   「看打炮片网：448832𝟵.com Front Innocent」
 * 全库 `tmdb_episode` 6640 条集名里**只有这 1 条**中招（按域名/网址/广告词扫过一遍）
 * ⇒ 规则做**极窄**，⛔ 不做通用正则大扫除：
 *   ① 只认**标题开头**那一坨没有空格的「域名串」（`…xxx.com`），广告都塞在最前面；
 *   ② 只认常见 TLD，且**必须在开头 80 字符内**（正文里出现 `Ver.2`/`Karte.5` 不受影响）；
 *   ③ 剥掉后若剩空 ⇒ 原样返回（由调用方兜底成「第 N 集」，⛔ 不返回空字符串）。
 * ⚠️ 这是**展示层**清洗：`tmdb_episode.ep_name` 里的原值不动
 *   （对齐/匹配照旧用原值，因为广告串后面往往就跟着真集名，反而还能命中）。 */
function cleanEpName(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  const s = String(raw);
  const m = /^[^\s]{1,80}?\.(?:com|net|org|cc|xyz|top|vip|info|site|club)\b/i.exec(s);
  if (!m) return raw;
  const rest = s.slice(m[0].length).replace(/^[\s:：|｜,，、\-–—~～·]+/, '');
  return rest || raw;
}

let _epOvCache: { key: string; map: Record<string, Record<string, EpOvVal>> } | null = null;
function epOverrides(): Record<string, Record<string, EpOvVal>> {
  const p =
    process.env.ALIGN_EP_OVERRIDE ||
    resolve(dirname(config.dbPath), 'align_ep_override.json');
  try {
    if (!existsSync(p)) return {};
    const key = `${p}:${statSync(p).mtimeMs}`;
    if (_epOvCache && _epOvCache.key === key) return _epOvCache.map;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    const map =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, Record<string, EpOvVal>>)
        : {};
    _epOvCache = { key, map };
    return map;
  } catch {
    return _epOvCache?.map ?? {};
  }
}


/** ⭐ §115：逐集体积/画质对照的一行（见 detail() 的 `media` 字段说明） */
export type EpMediaView = {
  mt: {
    size: number; w: number | null; h: number | null; codec: string | null;
    mbps: number | null; sec: number | null; n: number | null;
    code: string | null; files: Array<Record<string, unknown>> | null;
  } | null;
  lib: {
    size: number; n: number | null;
    files: Array<Record<string, unknown>> | null;
    /* ⭐⭐ §127（2026-11-02）：`lib_*` 改成 **Emby 媒体库里那份**（实测体积/画质），
       不再是 10-14 的 `/library/已整理` 旧快照 ⇒ 和「入库判定」列同源、两边不再打架。
       ⇒ 画质字段（w/h/codec/sec/mbps）现在**真的有**，从 `lib_files[0]` 取。 */
    w: number | null; h: number | null; codec: string | null;
    sec: number | null; mbps: number | null;
  } | null;
  srcQuality: number | null;
  /** ⭐ §117 mteam 种子清单侧（含未落盘）：体积 + 文件名，⛔ 不含分辨率/编码（清单没这些字段） */
  mtList: {
    size: number; n: number | null;
    files: Array<Record<string, unknown>> | null;
  } | null;
  verdict: string | null;
  note: string | null;
};

function parseJsonArray<T>(raw: unknown): T[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? (parsed as T[]) : null;
}

/**
 * 归一化 source_work.genres。
 *
 * 🔴 线上实际存的是**纯字符串** `"裏番"`，不是 JSON 数组 `["裏番"]`
 *    （历史写入路径如此，不能想当然按数组解析 —— 2026-10-15 实测踩过）。
 *    三种形态都要兜住：纯字符串 / JSON 数组 / 逗号分隔串。
 *    解析不出来就返回 null，绝不抛异常把溯源面板打成 500。
 */
function normalizeGenre(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const asArr = parseJsonArray<string>(s);
  if (asArr && asArr.length) return asArr.join('/');
  // 纯字符串或逗号分隔
  return s.includes(',') ? s.split(',').map((x) => x.trim()).filter(Boolean).join('/') : s;
}

/** 把 'mteam,hanime' 拆成徽标 */
function srcBadgeOf(srcs: unknown): { kinds: Array<'mteam' | 'hanime'>; badge: string | null } {
  if (typeof srcs !== 'string' || !srcs) return { kinds: [], badge: null };
  const kinds = srcs
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is 'mteam' | 'hanime' => s === 'mteam' || s === 'hanime');
  if (kinds.length === 0) return { kinds: [], badge: null };
  const uniq = [...new Set(kinds)];
  if (uniq.length >= 2) return { kinds: ['mteam', 'hanime'], badge: 'MT+hanime' };
  return { kinds: uniq, badge: uniq[0] === 'mteam' ? '仅 MT' : '仅 hanime' };
}

/** 一条源记录的年份集合（years 优先，退化到 year） */
function yearsOf(s: SourceRef): number[] {
  const out = new Set<number>();
  for (const y of s.years ?? []) if (Number.isFinite(y)) out.add(y);
  if (s.year != null && Number.isFinite(s.year)) out.add(s.year);
  return [...out].sort((a, b) => a - b);
}

/**
 * 数值接近度：ok(≤2) / warn(≤5) / bad(>5)。
 * 年份用它是「差几年算可疑」；集数不用它（集数是比例判定，见 crossCheck 因子 3）。
 */
function yearLevel(
  srcYears: number[],
  tmdbYear: number | null,
): { level: CheckItem['level']; gap: number | null } {
  if (!srcYears.length || tmdbYear == null) return { level: 'unknown', gap: null };
  const gap = Math.min(...srcYears.map((y) => Math.abs(y - tmdbYear)));
  if (gap <= 2) return { level: 'ok', gap };
  if (gap <= 5) return { level: 'warn', gap };
  return { level: 'bad', gap };
}

/**
 * 六因子自动核对。
 *
 * ⭐ 只核对「客观数据之间是否矛盾」，不判断「是不是同一部作品」。
 *   六项全绿 = 没有矛盾，不等于已确认 —— 用户 2026-10-15 已明确纠正过这个混淆。
 *
 * 阈值与实测依据（2026-10-15 / 16 实测）：
 *   年份    ≤2 通过；3~5 待确认（Re:/续作常见）；>5 反证
 *           反例已被证实：源 2008 vs TMDB 2025、源 2015 vs TMDB 2025 全是错配
 *   集数    源/目标 <0.25 或 >4 判反证。错配实证：2↔294、6↔317、2↔149、2↔65
 *   源站类型 hanime 标「裏番」是强正向信号；纪录片/综艺/恐怖片是强反证
 *   题材    ⚠️ genres 在真里番上大量出现 10765/10759，判别力≈0，
 *           只把「真人秀/纪录/恐怖/惊悚/战争」当反证，其余一律 unknown
 */
function crossCheck(
  sources: SourceRef[],
  tmdbYear: number | null,
  episodeTotal: number,
  genres: string | null,
  mediaType: 'tv' | 'movie',
  /** ⭐ 0da（2026-10-23）：该 work 分集 air_date 的年份集合（空数组 = 未知）。 */
  episodeYears: number[] = [],
  /** ⭐ 0el（2026-10-24）：对齐层实测的「有源集数」（落在集上的行数）。 */
  withSourceEps: number | null = null,
  /** ⭐ 0el：源条目总数（对齐层展开后的项数，含 extra）。 */
  sourceItems: number | null = null,
): CrossCheck {
  const items: CheckItem[] = [];

  // ── 因子 1：各源年份 vs TMDB 年份 ──
  //
  // 🔴🔴🔴 2026-10-16 实测证伪了第一版判据（这是本项目最贵的一个教训）：
  //
  //   第一版：逐条源算 gap，任一条 >5 年就判 bad。
  //   → 立刻抓到 98 部「bad」，但抽样复核发现**前 4 部全是误报**：
  //       対魔忍アサギ  MT 2007 / hn 2007 / TMDB 2007  ← 差 0 年，却被判 bad（差13年）
  //       ディシプリン  MT 2003 / hn 2003 / TMDB 2003  ← 差 0 年，却被判 bad（差7年）
  //       魔界騎士イングリッド MT 2009 / hn 2009       ← 差 0 年，却被判 bad（差9年）
  //       それでも妻を愛してる MT 2011 / hn 2011       ← 差 0 年，却被判 bad（差7年）
  //   病因：这些作品**挂了续作/外传/OVA/Re**（`対魔忍淺蔥3` `Re` `OVA…2` `妻中寢3`），
  //        续作年份当然离首播年远 —— 但那**恰恰证明是同一部作品**，
  //        不是错配。我把「系列内最晚的年份」当成了「作品的年份」。
  //
  //   修正后的判据（这才是对的）：
  //     · 只要**有任何一条源**的年份与 TMDB 吻合（≤2 年）→ 不算年份反证
  //     · 只有当**全部源**都对不上（最小 gap 仍 >5 年）→ 才判 bad
  //     · 真正的错配样本正是这个形态：
  //         《六姊妹》源 2008 / TMDB 2025（全部源都对不上）
  //         《不能説的秘密》源 2015,2016 / TMDB 2025（全部源都对不上）
  //
  //   ⭐ 一句话：**对不上的是「全部」，不是「某一条」。**
  //
  //   所以先算全局：所有源年份里，与 TMDB 最接近的那一对差多少。
  const allYears = [...new Set(sources.flatMap(yearsOf))].sort();
  const best = yearLevel(allYears, tmdbYear);
  // 全局有任一年份吻合 → 后面每条源的差异都只当 warn，绝不判 bad
  const globallyOk = best.level === 'ok';

  // ⭐⭐ 0da（2026-10-23）：**源年 ∈ 该 work 分集 air_date 年份集合** ⇒ 同一部，不是错配。
  //   起因：TMDB 用「季」切分、源站用「年份/前缀」切分 ⇒ 源站 year 是**逐集配信年**，
  //   续季首播年 / 外传年都落在同一 work 的分集年份集合里。
  //   实测全库只有 2 部触发「年份反证 bad」，且 **2/2 全是误报**（误报率 100%）
  //   ⇒ 这个闸门只会误伤、从不命中 ⇒ 命中集合则降为 warn。
  //   🔴 判据只认「落在集合内」，⛔ 不能反过来当闸门用（源year − work.year 不成立）。
  const epYearSet = new Set(episodeYears);
  const inEpisodeYears = (ys: number[]) => ys.some((y) => epYearSet.has(y));
  const globallySeasonOk = inEpisodeYears(allYears);

  for (const s of sources) {
    const ys = yearsOf(s);
    const who = s.src === 'mteam' ? 'M-TEAM' : 'hanime';
    if (!ys.length) {
      items.push({ factor: `${who} 年份`, level: 'unknown', text: '源站没给年份，无法用年份核对' });
      continue;
    }
    const { level, gap } = yearLevel(ys, tmdbYear);
    const ytxt = ys.join('/');
    if (tmdbYear == null) {
      items.push({ factor: `${who} 年份`, level: 'unknown', text: `源站 ${ytxt}（TMDB 年份未知）` });
    } else if (level === 'ok') {
      items.push({ factor: `${who} 年份`, level: 'ok', text: `${ytxt} 与 TMDB ${tmdbYear} 一致` });
    } else if (level === 'warn') {
      items.push({
        factor: `${who} 年份`,
        level: 'warn',
        text: `${ytxt} 与 TMDB ${tmdbYear} 差 ${gap} 年，可能是 Re:/续作/外伝`,
      });
    } else if (globallyOk) {
      // 🔴 本条对不上，但**别的源对得上** → 不是年份反证。
      //    （対魔忍アサギ：MT 2007 完美吻合，挂在同一部上的 対魔忍淺蔥3 是 2016）
      items.push({
        factor: `${who} 年份`,
        level: 'warn',
        text: `${ytxt} 与 TMDB ${tmdbYear} 差 ${gap} 年 —— 但本作品已有源年份与 TMDB 吻合，判为系列续作/外伝，非错配`,
      });
    } else if (globallySeasonOk) {
      // ⭐ 0da：源年落在**该 work 分集 air_date 年份集合**内 ⇒ 逐集配信年 / 续季首播年。
      items.push({
        factor: `${who} 年份`,
        level: 'warn',
        text: `${ytxt} 与 TMDB ${tmdbYear} 差 ${gap} 年 —— 但源年落在本作品分集年份集合（${[...epYearSet].sort().join('/')}）内，属逐集配信年/续季首播年，非错配`,
      });
    } else {
      items.push({
        factor: `${who} 年份`,
        level: 'bad',
        text: `${ytxt} 与 TMDB ${tmdbYear} 差 ${gap} 年 —— 全部源年份都对不上，年份反证`,
      });
    }
  }

  // 汇总一条整体年份结论（把上面逐条的结论收口，避免看板上重复三遍）
  if (tmdbYear != null && allYears.length) {
    items.push({
      factor: '年份总判',
      level: best.level === 'bad' && globallySeasonOk ? 'warn' : best.level,
      text: `源站年份 ${allYears.join('/')} ↔ TMDB ${tmdbYear}：最接近的一对差 ${best.gap} 年${
        best.level === 'ok'
          ? '，年份维度通过'
          : best.level === 'warn'
            ? '，仅续作/外伝可解释'
            : globallySeasonOk
              ? '，源年落在分集年份集合内（0da），属逐集配信年/续季首播年'
              : '，全部对不上'
      }`,
    });
  }

  // ── 因子 2：双源年份互证 ──
  const mtY = [...new Set(sources.filter((s) => s.src === 'mteam').flatMap(yearsOf))].sort();
  const hnY = [...new Set(sources.filter((s) => s.src === 'hanime').flatMap(yearsOf))].sort();
  if (mtY.length && hnY.length) {
    // 🔴 与年份总判同一个道理：两边只要**各有一个年份彼此接近**就算互证通过。
    //    续作年份把整体年份集撑得很开不代表两源矛盾。
    const cross = mtY.some((a) => hnY.some((b) => Math.abs(a - b) <= 2));
    items.push({
      factor: '双源互证',
      level: cross ? 'ok' : globallyOk ? 'warn' : 'bad',
      text: cross
        ? `M-TEAM ${mtY.join('/')} ≈ hanime ${hnY.join('/')} —— 两个源站独立指向同一年份`
        : globallyOk
          ? `M-TEAM ${mtY.join('/')} 与 hanime ${hnY.join('/')} 无近似年份，但两源都指向本作品 —— 差异来自各自的续作收录`
          : `M-TEAM ${mtY.join('/')} 与 hanime ${hnY.join('/')} 年份对不上 —— 至少有一源挂错`,
    });
  } else {
    items.push({
      factor: '双源互证',
      level: 'unknown',
      text: '只有一个源站，无法互证',
    });
  }

  // ── 因子 3：源条目数 vs TMDB 集数 ──
  // 🔴🔴 关键口径（2026-10-16 实测踩过）：
  //     mteam 的 episodes 是**番号条数**，几乎恒为 0 或 1
  //       （ACPDL-1026/1034/1048 各 1 条 → sum=3，但那是「三个分卷」不是「三集」）
  //     hanime 的 episodes 才是**清单内视频数**，等于集数
  //     → **逐源单独比是错的**：WAVER 3 集挂 2 条 mteam(各1) + 3 条 hanime(各1)，
  //        单看每条都是 1/3=0.33 → 全判 warn，纯属噪音。
  //     → 必须**同源内求和**后再比：mteam 求和 = 3、hanime 求和 = 3 → 3/3=1 吻合。
  //     且 M-TEAM 求和只能当**弱参考**（分卷数 ≠ 集数），不作为反证来源。
  //
  // 🔴🔴🔴 0el（2026-10-24 页面实测揪出，修「只算 hanime」的致命缺陷）：
  //     旧口径**分子只统计 hanime 的 episodes** ⇒ 纯 mteam 作品（hnSum=0）
  //     一律落到 unknown，mteam 侧完全失声。
  //     实测误报两例（0eu 页面实测 + 全库审计）：
  //       #258103 秘密动画系列：1 条 hanime(ep=1) + 8 个 mteam 番号（ep 恒 0）
  //                     ⇒ 旧口径 1/9=0.11 ⇒ **判 bad**（页面直接显示
  //                       「存在硬矛盾，几乎可以判定不是同一部作品」）——
  //                       而这部是本轮人工用 ANN 官方 anthology 编号逐条实证过的合集！
  //       #98973 / #247944：hnSum=1 vs TMDB 8/5 集 ⇒ 旧口径判 bad，
  //                       实测源站官方就只收了 1 集 ⇒ 同样是误报。
  //
  // ✅ **正确分子 = max(有源集数 withSource, 源站内容集数 Σ)**，其中
  //     Σ = hanime 行级 episodes 之和 + **mteam 的 entryDetail 展开项数**
  //     （mteam 一个种子常含多集 ⇒ 展开项数才是集数；源行数 ≠ 集数）。
  //     为什么取 max（逐条实证）：
  //       · #79641 黑暗圣经 外传：源站官方 6+2+6=14 集，TMDB 只收 2 集
  //         ⇒ 只用 withSource(2) 会 2/2=1.0 ⇒ ok ⇒ **掩盖「TMDB 漏收录 12 集」**
  //         ⇒ 取 max(16, 2)=16 ⇒ 16/2=8 ⇒ bad ✔ 保留真信号
  //       · #103248 皮草侠：5 个 mteam 源，对齐只落 1 集（extra=4）
  //         ⇒ 只用 withSource(1) 会 1/6=0.17 ⇒ bad ✘ 误报（对齐落位问题该由 extra 表达）
  //         ⇒ Σ=5 ⇒ 5/6=0.83 ⇒ warn ✔
  //     withSource=0（源一条都没落到集上）⇒ 那是**对齐层失败**，不是「集数」反证
  //     ⇒ 回退旧口径，不产出新结论。
  if (!episodeTotal || episodeTotal <= 0) {
    items.push({ factor: '集数', level: 'unknown', text: 'TMDB 未收录集数，无法比对' });
  } else {
    // 同源求和；mteam 只记录、不参与判定
    const hnSum = sources
      .filter((s) => s.src === 'hanime')
      .reduce((a, s) => a + (s.episodes && s.episodes > 0 ? s.episodes : 0), 0);
    const mtSum = sources
      .filter((s) => s.src === 'mteam')
      .reduce((a, s) => a + (s.episodes && s.episodes > 0 ? s.episodes : 0), 0);
    const mtCnt = sources.filter((s) => s.src === 'mteam').length;

    // 🔴 mteam 的**内容集数** = entryDetail 展开项数（一个种子可能含多集）
    const mtItems = sources
      .filter((s) => s.src === 'mteam')
      .reduce((a, s) => a + (s.entryDetail ?? []).length, 0);

    // 🔴 有源集数（对齐层实测）—— 优先用它，因为它反映「真正落到集上的集数」
    const withSource = typeof withSourceEps === 'number' ? withSourceEps : null;

    // 🔴 源条目总数（对齐层展开后的项数，**含 extra**）—— 最完整的口径：
    //    `entry_detail` 只有 33 行 mteam 有数据（库里的历史缺口），
    //    而对齐层是按 entry_detail 展开的 ⇒ 它的 sourceItems 才是全量。
    const srcItems = typeof sourceItems === 'number' ? sourceItems : null;

    // 源站内容集数 Σ（hanime 行级 episodes + mteam 展开项数）
    const srcEps = srcItems != null && srcItems > 0 ? srcItems : hnSum + mtItems;
    // 分子：max(有源集数, 源站内容集数)；withSource=0 ⇒ 回退旧口径
    const useNew = withSource != null && withSource > 0 && srcEps > 0;
    const numerator = useNew ? Math.max(withSource as number, srcEps) : hnSum;
    const ratio = numerator / episodeTotal;

    if (numerator <= 0) {
      items.push({
        factor: '集数',
        level: 'unknown',
        text: mtCnt
          ? `hanime 未给条目数；M-TEAM ${mtCnt} 个番号（番号数≠集数，不作判据）`
          : '源站未给条目数，无法比对',
      });
    } else {
      // 🔴🔴 0el：差值必须和文案里展示的数字**对得上**（否则用户看不懂）
      //   文案同时给两个数：源站内容集数 srcEps、已落位集数 withSource
      //   ⇒ 差值给两个：落位差（withSource vs TMDB）= 真正反映「我们缺几集」
      //                  源站差（srcEps vs TMDB）= 反映「源站/TMDB 收录口径差」
      const gPlaced = useNew ? Math.abs((withSource as number) - episodeTotal) : Math.abs(numerator - episodeTotal);
      const gSrc = Math.abs(srcEps - episodeTotal);
      const g = gPlaced;
      // 🔴 文案要说清「分子是什么」—— 用户在页面上看到的是这个数字
      const numDesc = useNew
        ? `源站 ${srcEps} 集 / 已落位 ${withSource} 集`
        : `源站共 ${numerator} 条`;
      // 🔴 落位与源站差得远 ⇒ 说明是**对齐/落位**问题（extra 或漏落），不是「集数口径差」
      const placedDiffers = useNew && gSrc !== gPlaced;
      if (ratio < 0.25 || ratio > 4) {
        items.push({
          factor: '集数',
          level: 'bad',
          // 🔴🔴 0el（2026-10-24）：文案语义修正 —— 「量级不符」**不等于**「不是同一部」。
          //   实测三例（正侧，逐条实证）：
          //     #97866 淫妖虫：源站只有 1 个 mteam 番号，TMDB 9 集 ⇒ 源站只收了 1 集
          //     #98792 小千开发日记：源站官方 6+2=8 集，TMDB 只收 2 集 ⇒ **TMDB 漏收录**
          //     #115290 奶油柠檬：源站官方 2 集，TMDB 44 集 ⇒ 源站只收了 2 集
          //   三部都是**真信号**，但真实成因是「一方收录不全」，**不是**「绑错了作品」。
          //   ⛔ 旧文案「疑似不是同一部作品」会让人白查一轮绑定（0dc：先分清
          //      「真没有」vs「判据写错」的同族坑 —— 这里要分清「量级不符」vs「不是同一部」）。
          //   ✅ 新文案只陈述事实 + 给出两种可能方向，不下「不是同一部」的结论。
          text: `${numDesc} vs TMDB ${episodeTotal} 集 —— 量级不符（落位差 ${gPlaced}、源站差 ${gSrc}）：`
            + `可能源站只收录了部分、也可能 TMDB 收录不全；请结合「抓取完整性」与源站实际条数核对`,
        });
      } else if (ratio < 0.5 || ratio > 2) {
        items.push({
          factor: '集数',
          level: 'warn',
          // ⚠️ 2026-10-21 改文案：原来写「可能只抓到部分」——
          //    那是**漏抓**的说法；2026-10-21 起源站条目已按官方播放列表补全，
          //    这里的差值多数是「TMDB 把上下卷/OVA 算成两集」的口径差，
          //    再说「只抓到部分」会让人以为又漏抓了。
          // 🔴 0el：落位差 ≠ 源站差 时（源站条目多、但只落了一部分）⇒
          //    那是**落位/extra** 问题，该看「未配上源」清单，不是「两源口径不同」。
          text: placedDiffers
            ? `${numDesc} vs TMDB ${episodeTotal} 集（落位差 ${gPlaced}、源站差 ${gSrc}）—— `
              + `已落位部分与 TMDB 接近，但源站还有条目没落到集上（多为多集包/extra），请看「未配上源」`
            : `${numDesc} vs TMDB ${episodeTotal} 集（差 ${g}）—— 两源口径不同（TMDB 常把上下卷/OVA 算成两集），请核对是否同一部`,
        });
      } else {
        items.push({
          factor: '集数',
          level: 'ok',
          text: `${numDesc} vs TMDB ${episodeTotal} 集 —— 吻合${mtCnt ? `（另有 ${mtCnt} 个 MT 番号）` : ''}`,
        });
      }
    }
  }

  // ── 因子 3b：抓取完整性（我们入库 vs 源站官方集数）──
  //
  // ⭐ 2026-10-21 新增（作者数据完整性专项）。
  //   「集数」因子比的是**源站 vs TMDB**；本因子比的是**我们 vs 源站**。
  //   两者必须分开，否则作者在看板上分不清：
  //     · 集数 差得多 → 绑定/口径问题
  //     · 抓取完整性 差得多 → **我们漏抓了**（要补抓）
  //
  //   official_episodes 是**行级**的（一行 = 一个 hanime 作品 = 一个播放列表），
  //   一个 TMDB 作品可能对应多个 hanime 作品（合集/系列）⇒ 这里按作品求和。
  {
    const hnRows = sources.filter((s) => s.src === 'hanime');
    const known = hnRows.filter((s) => s.officialEpisodes != null);
    const unverified = hnRows.length - known.length;
    if (!known.length) {
      items.push({
        factor: '抓取完整性',
        level: 'unknown',
        text: '还没核过源站官方集数（未做播放列表排查）',
      });
    } else {
      // ⚠️ **逐行比，不跨行求和**：
      //   一个 TMDB 条目可能对应多个 hanime 作品（合集/系列），
      //   库里也会把同一部的「第1話」「第2話」拆成两行 ——
      //   跨行 SUM 官方数会**重复计数**，把「已抓齐」误报成「漏抓」。
      //   逐行比才是行级真相：这一行在源站官方 N 集，我们这一行入了 M 条。
      const short: string[] = [];
      let okRows = 0;
      for (const r of known) {
        const ed = (r.entryDetail ?? []).length;
        const mine = ed > 0 ? ed : (r.episodes ?? 0);
        if ((r.officialEpisodes ?? 0) > mine) {
          short.push(`${r.srcKey}：源站官方 ${r.officialEpisodes} 集 / 我们只入 ${mine} 条`);
        } else {
          okRows += 1;
        }
      }
      if (!short.length) {
        items.push({
          factor: '抓取完整性',
          level: 'ok',
          text: `逐行核对：${okRows} 条源记录都与源站官方集数一致${
            unverified ? `，另有 ${unverified} 条未核` : ''}`,
        });
      } else {
        items.push({
          factor: '抓取完整性',
          level: 'bad',
          text: `${short.length} 条源记录没抓齐 —— ${short[0]}`,
        });
      }
    }
    const detailSum = hnRows.reduce((a, s) => a + ((s.entryDetail ?? []).length), 0);
    const countSum = hnRows.reduce(
      (a, s) => a + (s.episodes && s.episodes > 0 ? s.episodes : 0), 0);
    if (detailSum !== countSum && detailSum > 0) {
      items.push({
        factor: '明细一致',
        level: 'warn',
        text: `明细条数 ${detailSum} 与计数 ${countSum} 不一致 —— 行账对不上`,
      });
    }
  }

  // ── 因子 4：源站类型（hanime 自标類型是最强信号之一） ──
  //
  // 🔴 2026-10-15 实测：hanime 源记录的顶层 `genres` 列**大量为 NULL**
  //    （nocturnal / 回春 / dropout / 冤罪 四条全是 NULL），
  //    真正的类型写在 `entry_detail[].genre`（=「裏番」）。
  //    只读顶层列会让这个因子对一半以上的源失效 → 永远显示「源站未标类型」。
  //    → 必须 entry_detail 兜底，否则等于没有这个因子。
  const hnGenres = [
    ...new Set(
      sources
        .filter((s) => s.src === 'hanime')
        .flatMap((s) => [
          ...(s.genre ? [s.genre] : []),
          ...(s.entryDetail ?? []).map((e) => e.genre).filter(Boolean),
        ]),
    ),
  ] as string[];
  if (!hnGenres.length) {
    items.push({ factor: '源站类型', level: 'unknown', text: '源站未标类型' });
  } else {
    const isHentai = hnGenres.some((g) => g.includes('裏番'));
    const isLive = hnGenres.some((g) => /综艺|紀錄|紀実|恐怖|驚悚|戰爭/.test(g));
    if (isLive) {
      items.push({ factor: '源站类型', level: 'bad', text: `源站类型 ${hnGenres.join('/')} —— 综艺/纪录片/恐怖片不可能是里番` });
    } else if (isHentai) {
      items.push({ factor: '源站类型', level: 'ok', text: `源站自标 ${hnGenres.join('/')} —— 与里番主库口径一致` });
    } else {
      items.push({ factor: '源站类型', level: 'warn', text: `源站类型 ${hnGenres.join('/')} —— 非「裏番」，需看标题确认` });
    }
  }

  // ── 因子 4b：作品形态（里番是「多集动画」，不是「单条真人短片」） ──
  // 🔴 2026-10-15 用户截图《Nocturnal》触发的新判据。
  //    三部错配全是同一形态：hanime 源是**多集裏番系列**（episodes≥2），
  //    却被绑到 TMDB 上一条**单集 movie**（episode_total≤1）的真人短片。
  //    ⚠️ 不能单独当反证：冤罪(2004)/回春(2023)/dropout(2022) 里
  //       「冤罪」就是合法的 2 集里番绑 movie（TMDB 把两集并成一条电影条目）。
  //    所以这里只判 **warn**，提示「形态可疑，需看语言/片长」，由人工或其他因子定夺。
  if (mediaType === 'movie' && episodeTotal <= 1) {
    const hnEps = sources
      .filter((s) => s.src === 'hanime')
      .reduce((a, s) => a + (s.episodes && s.episodes > 0 ? s.episodes : 0), 0);
    if (hnEps >= 2) {
      items.push({
        factor: '作品形态',
        level: 'warn',
        text: `源是 ${hnEps} 集系列，TMDB 是单条 movie —— 里番系列通常对应 tv 而非 movie（也可能是 TMDB 把多集并成一条电影，需结合语言/片长确认）`,
      });
    }
  }

  // ── 因子 5：题材反证（⚠️ genres 判别力≈0，只认这几种强反证类型） ──
  const g = genres ?? '';
  const LIVE = /真人秀|紀錄|紀錄片|纪录|恐怖|驚悚|惊悚|戰爭|战争/;
  if (!g) {
    items.push({ factor: '题材', level: 'unknown', text: 'TMDB 无题材数据' });
  } else if (LIVE.test(g)) {
    items.push({ factor: '题材', level: 'bad', text: `TMDB 题材含「${g.match(LIVE)?.[0]}」—— 与里番不符` });
  } else {
    items.push({
      factor: '题材',
      level: 'unknown',
      text: `TMDB 题材 ${g} —— 动画/动作类标签在真里番上也大量出现，不能作为判据`,
    });
  }

  // ── 因子 6：匹配方式（高分 ≠ 正确，只提示证据强度） ──
  const rebinds = sources.filter((s) => s.matchBy === 'audit_rebind');
  const noScore = sources.filter((s) => s.matchScore == null);
  if (rebinds.length) {
    items.push({
      factor: '匹配方式',
      level: 'ok',
      text: `${rebinds.length} 条为人工审计改绑（正解已在主库），可信度高于自动匹配`,
    });
  } else if (noScore.length === sources.length && sources.length) {
    items.push({ factor: '匹配方式', level: 'warn', text: '全部为无分值来源，需人工确认' });
  } else {
    items.push({
      factor: '匹配方式',
      level: 'unknown',
      text: `自动匹配（${[...new Set(sources.map((s) => s.matchBy).filter(Boolean))].join('/')}）—— 分值只代表标题字面相似，不代表同一部作品`,
    });
  }

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const ok = items.filter((i) => i.level === 'ok').length;
  const level: CrossCheck['level'] =
    bad > 0 ? 'bad' : warn > 0 ? 'warn' : ok > 0 ? 'ok' : 'unknown';

  return {
    items,
    level,
    tally: { ok: ok || null, warn: warn || null, bad: bad || null },
  };
}


export class BoardApi {
  /**
   * 🔴 2026-10-20 12:5x：注入 HiddenService，让**服务端也过滤**被屏蔽的作品。
   *
   * ⭐ 为什么必须服务端过滤（之前只有前端过滤，是**半个功能**）：
   *   ① 换浏览器/手机/收藏夹打开 ⇒ 客户端 `HIDDEN.board` 是空的 ⇒ 被屏蔽的部**照样出现**；
   *   ② `stats.total` / `byYear` / `coverage` **仍把被屏蔽的算进去** ⇒
   *      眼睛看到的和数字对不上 = 量纲混用（铁律 0ay 的教训）。
   *   作者原话：「不需要的我直接屏蔽」⇒ 屏蔽了就该**真的看不见**。
   *
   * ⛔ **详情页 `work/:id` 不过滤** —— 否则屏蔽后连「恢复」入口都没了（死锁）。
   */
  constructor(
    private readonly db: DB,
    private readonly hidden?: HiddenService,
  ) {
    this.tagMark = new TagMark(db);
  }

  /** §151：标签档位（避开/喜欢）。作品级命中原样挂进 WorkBrief，前端直接画。 */
  private readonly tagMark: TagMark;

  /** 给外部（设置面板接口）复用同一份实例，保证 workHits 的缓存不会分裂成两份 */
  get tagMarks(): TagMark {
    return this.tagMark;
  }

  /**
   * 判断库里有没有 is_quarantined 列 —— 首次部署（还没跑隔离脚本）时为 false，
   * 此时所有查询退回不过滤，保证老库也能正常展示。
   */
  private get hasQuarantine(): boolean {
    if (this._hasQuarantine === undefined) {
      const cols = (
        this.db
          .prepare(`SELECT name FROM pragma_table_info('tmdb_work')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      this._hasQuarantine = cols.includes('is_quarantined');
    }
    return this._hasQuarantine;
  }

  private _hasQuarantine: boolean | undefined;

  /**
   * ⭐ 溯源 JOIN —— 老库没有 source_work 表时降级成空片段，保证不 500
   *
   * 新双源库里每条 tmdb_work 都由 source_work 反查得到；老库（keyword 时代）
   * 没有这张表，此时看板照常展示，只是没有徽标。
   */
  private get srcAgg(): string {
    return this.hasSourceTable
      ? `LEFT JOIN (${SRC_AGG_SQL}) sa ON sa.work_id = w.id AND sa.media_type = w.media_type`
      : '';
  }

  /** 老库降级时把 sa.* 塞成 NULL，避免列数不匹配 */
  private get srcCols(): string {
    return this.hasSourceTable
      ? 'sa.srcs, sa.src_count, sa.hn_count, sa.pm_count'
      : 'NULL AS srcs, NULL AS src_count, NULL AS hn_count, NULL AS pm_count';
  }

  /** source_work 表是否存在 */
  private get hasSourceTable(): boolean {
    if (this._hasSourceTable === undefined) {
      const t = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='source_work'`)
        .all() as Array<{ name: string }>;
      this._hasSourceTable = t.length > 0;
    }
    return this._hasSourceTable;
  }

  /** emby_episode 表是否存在（2026-10-27 §70 新增；老库没有 ⇒ 卡面不显示入库标） */
  private get hasEmbyTable(): boolean {
    if (this._hasEmbyTable === undefined) {
      const t = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='emby_episode'`)
        .all() as Array<{ name: string }>;
      this._hasEmbyTable = t.length > 0;
    }
    return this._hasEmbyTable;
  }

  private _hasEmbyTable: boolean | undefined;

  /** work_hidden 表是否存在（季级屏蔽要用；没有就跳过屏蔽条件） */
  private get hasHiddenTable(): boolean {
    if (this._hasHiddenTable === undefined) {
      const t = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_hidden'`)
        .all() as Array<{ name: string }>;
      this._hasHiddenTable = t.length > 0;
    }
    return this._hasHiddenTable;
  }

  private _hasHiddenTable: boolean | undefined;

  /**
   * 「本作品被屏蔽的季号」相关子查询（依赖外层别名 `w`）。
   *
   * 🔴 屏蔽的季必须**分子分母同时剔除**：否则 #118067 屏掉 S02 之后，
   *    卡面会永远显示「5 / 7 集」= 差 2 集，明明已经收全了（0oe 的延伸）。
   *
   * 🔴🔴 2026-10-27（§74）必加 `instr(h.key, ':E') = 0`（0pd）：
   *    集级 key 形如 `284897:S1:E3`，`substr(key, instr(key,':S')+2)` = `'1:E3'`
   *    ⇒ `CAST(... AS INTEGER)` = **1** ⇒ 会把整个 S1 当成「季级屏蔽」剔掉。
   *    少了这个条件，加一条集级排除就悄悄删掉一整季的分母（且全绿看不出）。
   */
  private get hiddenSeasonSub(): string {
    return `(SELECT CAST(substr(h.key, instr(h.key, ':S') + 2) AS INTEGER)
               FROM work_hidden h
              WHERE h.scope = 'season' AND h.unhidden_at IS NULL
                AND instr(h.key, ':E') = 0
                AND substr(h.key, 1, instr(h.key, ':') - 1) = CAST(w.id AS TEXT))`;
  }

  /**
   * 「某一集是否被**集级**排除」的 SQL 条件片段（依赖外层别名 `w`，2026-10-27 §74）。
   *
   * ✅ 用 **key 全等**（`<id>:S<季>:E<集>`）而不是「切串再比」，两个理由：
   *    ① 不依赖 `instr` 切分的正确性 ⇒ 少一处可能切错的地方（0lx 口径只有一处）；
   *    ② `work_hidden.key` 上有索引 ⇒ 能走索引，比字符串切割再比较快。
   *
   * 🔴 `alias` 只接受白名单（`te` / `ee`）—— 千万别把它做成外部传入的裸字符串，
   *    那就是 SQL 注入口子。
   */
  private hiddenEpGuard(alias: 'te' | 'ee'): string {
    if (!this.hasHiddenTable) return '';
    return ` AND NOT EXISTS (
               SELECT 1 FROM work_hidden h
                WHERE h.scope = 'episode' AND h.unhidden_at IS NULL
                  AND h.key = CAST(w.id AS TEXT) || ':S' || CAST(${alias}.season AS TEXT)
                          || ':E' || CAST(${alias}.episode AS TEXT))`;
  }

  /**
   * ⭐ 卡面「全集入库」两列（2026-10-27 §71）
   *
   * 口径必须与 `detail()` 完全一致，三条：
   *   1. 只认**当前那一次同步**（`synced_at = last_sync`）—— 历史行自动出局（0or）
   *   2. 屏蔽的季分子分母同时剔除
   *   3. 分母是 `tmdb_episode` 实际行数，⛔ 不是 `w.episode_total`
   *
   * 老库（没跑 migration #12）⇒ 两列都给 NULL，前端按「未同步」处理，页面照常可用。
   */
  private get embyCols(): string {
    // ⭐ 2026-10-27（§73）人工确认入库：三列永远一起出现，缺表时全给「没人确认过」
    const verifyCols = this.hasEmbyVerifyTable
      ? `(SELECT 1 FROM work_emby_verified v
            WHERE v.tmdb_id = w.id AND v.media_type = w.media_type
              AND v.revoked_at IS NULL LIMIT 1) AS emby_verified,
         (SELECT v.snap_eps FROM work_emby_verified v
            WHERE v.tmdb_id = w.id AND v.media_type = w.media_type
              AND v.revoked_at IS NULL LIMIT 1) AS emby_snap_eps,
         (SELECT v.snap_need FROM work_emby_verified v
            WHERE v.tmdb_id = w.id AND v.media_type = w.media_type
              AND v.revoked_at IS NULL LIMIT 1) AS emby_snap_need`
      : `0 AS emby_verified, NULL AS emby_snap_eps, NULL AS emby_snap_need`;

    if (!this.hasEmbyTable) {
      return `NULL AS emby_eps, NULL AS emby_need, ${verifyCols}, 0 AS emby_excluded`;
    }
    const seasonGuard = this.hasHiddenTable
      ? ` AND (te.season IS NULL OR te.season NOT IN ${this.hiddenSeasonSub})`
      : '';
    const epGuard = this.hasHiddenTable
      ? ` AND (ee.season IS NULL OR ee.season NOT IN ${this.hiddenSeasonSub})`
      : '';
    /* ⭐ §74 集级排除：分子分母同时减（与季级同语义）⇒ 排除假集后能真正闭环 */
    const seasonEpGuard = this.hiddenEpGuard('te');
    const embyEpGuard = this.hiddenEpGuard('ee');
    /* 被**集级**排除的集数 —— 给卡面 tooltip 写「有效 8 集（已排除 2 集）」
       用，⛔ 不参与 `embyFull` 判定（判定只看 emby_eps / emby_need）。 */
    const excludedCol = this.hasHiddenTable
      ? `, (SELECT COUNT(*) FROM tmdb_episode te
             WHERE te.work_id = w.id AND te.media_type = w.media_type
               AND EXISTS (SELECT 1 FROM work_hidden h
                            WHERE h.scope = 'episode' AND h.unhidden_at IS NULL
                              AND h.key = CAST(w.id AS TEXT) || ':S' || CAST(te.season AS TEXT)
                                      || ':E' || CAST(te.episode AS TEXT)))
             AS emby_excluded`
      : `, 0 AS emby_excluded`;
    return `(SELECT COUNT(*) FROM emby_episode ee
              WHERE ee.tmdb_id = w.id
                AND ee.synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')${epGuard}${embyEpGuard})
              AS emby_eps,
            (SELECT COUNT(*) FROM tmdb_episode te
              WHERE te.work_id = w.id AND te.media_type = w.media_type${seasonGuard}${seasonEpGuard})
              AS emby_need,
            ${verifyCols}${excludedCol}`;
  }

  /** work_emby_verified 表是否存在（§73；老库没跑 migration 就降级） */
  private get hasEmbyVerifyTable(): boolean {
    if (this._hasEmbyVerifyTable === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_emby_verified'`)
          .all() as Array<{ name: string }>;
        this._hasEmbyVerifyTable = t.length > 0;
      } catch {
        this._hasEmbyVerifyTable = false;
      }
    }
    return this._hasEmbyVerifyTable;
  }

  private _hasEmbyVerifyTable: boolean | undefined;

  /**
   * ⭐ 待下标（2026-10-28 §80）
   *
   * 口径：`work_want` 里存在且 `revoked_at IS NULL`（已收没收都算「喜欢过」）。
   * 🔴 写成 getter 只此一份，三处 SELECT（worksByYear / allWorks / detail）共用
   *    ⇒ 卡面与详情页的 ♥ 必然一致（0lx：判据多处拷贝 ⇒ 同一函数共用）。
   */
  private get wantCol(): string {
    return this.hasWantTable
      ? `(SELECT 1 FROM work_want ww
            WHERE ww.tmdb_id = w.id AND ww.media_type = w.media_type
              AND ww.revoked_at IS NULL LIMIT 1) AS wanted`
      : `0 AS wanted`;
  }

  /** work_want 表是否存在（老库没跑 migration 就降级） */
  private get hasWantTable(): boolean {
    if (this._hasWantTable === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='work_want'`)
          .all() as Array<{ name: string }>;
        this._hasWantTable = t.length > 0;
      } catch {
        this._hasWantTable = false;
      }
    }
    return this._hasWantTable;
  }

  private _hasWantTable: boolean | undefined;

  /**
   * 解析 JSON 列（years / entry_detail）。
   *
   * 🔴 这些列可能为 NULL、空串、或历史写入的脏值 —— 一律降级成 null，
   *    绝不让一条坏数据把整个溯源面板 500 掉。
   */
  private get sourceColCache(): Set<string> {
    if (this._srcCols === undefined) {
      this._srcCols = new Set(
        (this.db
          .prepare(`SELECT name FROM pragma_table_info('source_work')`)
          .all() as Array<{ name: string }>).map((r) => r.name),
      );
    }
    return this._srcCols;
  }

  private _srcCols?: Set<string>;
  private _hasSourceTable: boolean | undefined;

  /**
   * tmdb_episode 有没有 `ep_name_ja` 列（2026-10-22 迁移 #10 才加的）。
   * 老库/未跑 migration 的库没有这一列 ⇒ 日文集名通道降级成「不启用」，
   * ⛔ 不能让详情页 500。
   */
  private get hasEpNameJa(): boolean {
    if (this._hasEpNameJa === undefined) {
      try {
        const c = this.db
          .prepare(`SELECT name FROM pragma_table_info('tmdb_episode')`)
          .all() as Array<{ name: string }>;
        this._hasEpNameJa = c.some((r) => r.name === 'ep_name_ja');
      } catch {
        this._hasEpNameJa = false;
      }
    }
    return this._hasEpNameJa;
  }

  private _hasEpNameJa?: boolean;

  /**
   * tmdb_episode 有没有 `overview_zh` 列（2026-11-01 迁移 #22 才加的）。
   *
   * §114：分集简介有 1455 条只有英文/日文，译文单独存这一列，⛔ 不覆盖 `overview`。
   * 老库/未跑 migration 的库没有这一列 ⇒ 降级成「只用原文」，⛔ 不能让详情页 500。
   */
  private get hasEpOverviewZh(): boolean {
    if (this._hasEpOverviewZh === undefined) {
      try {
        const c = this.db
          .prepare(`SELECT name FROM pragma_table_info('tmdb_episode')`)
          .all() as Array<{ name: string }>;
        this._hasEpOverviewZh = c.some((r) => r.name === 'overview_zh');
      } catch {
        this._hasEpOverviewZh = false;
      }
    }
    return this._hasEpOverviewZh;
  }

  private _hasEpOverviewZh?: boolean;

  /**
   * `ep_media` 表在不在（2026-11-01 迁移 #23 才加的）。
   * 老库/未跑 migration ⇒ 画质对比整块降级成「没有数据」，⛔ 不能让详情页 500。
   */
  private get hasEpMedia(): boolean {
    if (this._hasEpMedia === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ep_media'`)
          .all() as Array<{ name: string }>;
        this._hasEpMedia = t.length > 0;
      } catch {
        this._hasEpMedia = false;
      }
    }
    return this._hasEpMedia;
  }

  private _hasEpMedia?: boolean;

  /**
   * tmdb_season 表在不在（2026-10-21 迁移 #8 才加的）。
   * 老库/未跑 migration 的库没有这张表 ⇒ 季级对齐降级成「只用集名」，不能让详情页 500。
   */
  private get hasSeasonTable(): boolean {
    if (this._hasSeasonTable === undefined) {
      try {
        const t = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tmdb_season'`)
          .all() as Array<{ name: string }>;
        this._hasSeasonTable = t.length > 0;
      } catch {
        this._hasSeasonTable = false;
      }
    }
    return this._hasSeasonTable;
  }
  private _hasSeasonTable: boolean | undefined;

  /**
   * TMDB 季名 —— 季级对齐的第一级依据。
   *
   * ⭐ 2026-10-21 作者指正：「理论上的匹配顺序不应该先核对季名和数量，
   *   然后再核对季里剧集的分集名」。
   *   之前只拿「集名（剧情名）」对「源站卷标题」，在多子作品合集上必然错位。
   */
  seasonsOf(id: number, mediaType: 'tv' | 'movie'): AlignSeason[] {
    const out: AlignSeason[] = [];
    const have = new Set<number>();
    if (this.hasSeasonTable) {
      try {
        const rows = this.db
          .prepare(
            `SELECT season, name, name_ja, ep_count, air_date
               FROM tmdb_season WHERE work_id = ? AND media_type = ?
              ORDER BY season`,
          )
          .all(id, mediaType) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const sn = Number(r.season);
          have.add(sn);
          out.push({
            season: sn,
            name: (r.name as string) ?? null,
            nameJa: (r.name_ja as string) ?? null,
            epCount: r.ep_count == null ? null : Number(r.ep_count),
            airDate: (r.air_date as string) ?? null,
          });
        }
      } catch {
        /* 季名表读不到 ⇒ 走下面的兜底 */
      }
    }
    // ⚠️ **兜底：tmdb_season 缺哪一季，就从 tmdb_episode 补一季出来**。
    //    季名表是后补的（迁移 #8，只抓到 1507 个季），
    //    很多作品在表里**一行都没有** ⇒ 对齐器拿不到季 ⇒ 整部 0 配上
    //    （实测 96444「異種族レビュアーズ」：13 个源条目 / 13 集，0 配上；
    //      95785「都市伝説シリーズ」：12 个源条目 / 6 集，0 配上）。
    //    从 tmdb_episode 自己就能推出「季号 + 集数 + 首播年」——
    //    季名可能没有，但**年份**是季归属最常用的判据，不能缺。
    try {
      const rows = this.db
        .prepare(
          `SELECT season, count(*) AS n, min(air_date) AS first_air
             FROM tmdb_episode WHERE work_id = ? AND media_type = ?
            GROUP BY season ORDER BY season`,
        )
        .all(id, mediaType) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const sn = Number(r.season);
        if (have.has(sn)) continue;
        out.push({
          season: sn,
          name: null,
          nameJa: null,
          epCount: Number(r.n),
          airDate: (r.first_air as string) ?? null,
        });
      }
    } catch {
      /* 没有分集数据就真的没有季 */
    }
    out.sort((a, b) => a.season - b.season);
    return out;
  }

  /** 看板可见条件 */
  private get visible(): string {
    return this.hasQuarantine ? VISIBLE : '1=1';
  }

  /**
   * 🔴 2026-10-20：可见条件 + 排除「已屏蔽」的作品（服务端过滤）。
   *
   * ⭐ 判据设计：
   *   ① 用 **`NOT EXISTS` 子查询**而不是 `id NOT IN (...)` ——
   *      后者遇到 NULL 会整条查询返 0 行（`NOT IN` 的经典坑）。
   *   ② 屏蔽 key 存在 `work_hidden.key` 里是**字符串**（tmdb_id 转文本）⇒ 必须 `CAST(w.id AS TEXT) = h.key`。
   *   ③ ⛔ **别名**：调用方有的用裸表名（`FROM tmdb_work`），有的用 `w.`（`FROM tmdb_work w`）
   *      ⇒ 由参数 `alias` 决定，`default` 时用裸列名。
   *   ④ 表不存在（老库没跑 migration #6）⇒ `hidden.keys()` 返回空集 ⇒ 条件恒真 ⇒ 天然兼容。
   */
  private visibleEx(alias = ''): string {
    const base = this.visible;
    if (!this.hidden) return base;
    const keys = this.hidden.keys('board');
    if (!keys.size) return base;
    const idCol = alias ? `${alias}.id` : 'id';
    // ⛔ NOT IN 有 NULL 坑 ⇒ 用 NOT EXISTS（所以不把 keys 拼成 IN 列表）
    return `(${base}) AND NOT EXISTS (
      SELECT 1 FROM work_hidden h
      WHERE h.scope='board' AND h.unhidden_at IS NULL AND CAST(${idCol} AS TEXT) = h.key
    )`;
  }

  /** 全库统计 */
  stats(): BoardStats {
    /* ⭐ §73 人工确认计数 —— 表不存在（老库）就给 0，⛔ 不让整个 stats 500 */
    const vCol = this.hasEmbyVerifyTable
      ? `, (SELECT COUNT(*) FROM work_emby_verified v WHERE v.revoked_at IS NULL) AS emby_verified`
      : `, 0 AS emby_verified`;
    /* ⭐ §80 待下计数 —— 只算「未撤销 + 未收 + 在看板可见集合里」，
       ⛔ 不把已隔离/已屏蔽的算进角标（否则点进去数不上） */
    const wCol = this.hasWantTable
      ? `, (SELECT COUNT(*) FROM work_want ww
             JOIN tmdb_work t2 ON t2.id = ww.tmdb_id AND t2.media_type = ww.media_type
            WHERE ww.revoked_at IS NULL AND ww.done_at IS NULL
              AND t2.is_quarantined = 0${
                this.hasHiddenTable
                  ? ` AND NOT EXISTS (SELECT 1 FROM work_hidden h
                                       WHERE h.scope = 'board' AND h.unhidden_at IS NULL
                                         AND CAST(t2.id AS TEXT) = h.key)`
                  : ''
              }) AS want_pending`
      : `, 0 AS want_pending`;
    const r = this.db
      .prepare(
        `SELECT
           COUNT(*)                                                AS total,
           SUM(CASE WHEN media_type='tv' THEN 1 ELSE 0 END)       AS tv,
           SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END)    AS movie,
           SUM(CASE WHEN poster_local IS NOT NULL THEN 1 ELSE 0 END) AS withPoster,
           SUM(CASE WHEN season_count > 0 THEN 1 ELSE 0 END)      AS withSeasons,
           COALESCE(SUM(episode_total), 0)                        AS totalEpisodes,
           SUM(CASE WHEN source_channel='keyword' THEN 1 ELSE 0 END)    AS fromKeyword,
           SUM(CASE WHEN source_channel='local_seed' THEN 1 ELSE 0 END) AS fromSeed,
           SUM(CASE WHEN source_channel='v7_merge' THEN 1 ELSE 0 END)  AS fromV7,
           MIN(year)                                             AS yearFrom,
           MAX(year)                                              AS yearTo
           ${vCol}
           ${wCol}
         FROM tmdb_work
         WHERE ${this.visibleEx()}`,
      )
      .get() as Record<string, number | null>;

    const years = this.byYear();
    return {
      total: r.total ?? 0,
      tv: r.tv ?? 0,
      movie: r.movie ?? 0,
      withPoster: r.withPoster ?? 0,
      withSeasons: r.withSeasons ?? 0,
      totalEpisodes: r.totalEpisodes ?? 0,
      fromKeyword: r.fromKeyword ?? 0,
      fromSeed: r.fromSeed ?? 0,
      fromV7: r.fromV7 ?? 0,
      embyVerified: r.emby_verified ?? 0,
      wantPending: Number(r.want_pending ?? 0),
      yearSpan:
        r.yearFrom && r.yearTo ? { from: Number(r.yearFrom), to: Number(r.yearTo) } : null,
      thinYears: years.filter((y) => y.total < 30).map((y) => ({ year: y.year, total: y.total })),
      coverage: this.coverage(),
    };
  }

  /**
   * ⭐⭐ §125（2026-11-01）：`ep_media` 判定分布 + **待落盘样本**。
   *
   * 为什么要有这个接口：验收脚本要在**线上**找一部「还有集在待落盘」的作品当样本，
   * 但这个状态**会消失** —— 作者把 mteam 种子包全下完之后 `mt_pending` 归 0
   * ⇒ 写死的候选全部失效（§124b 踩过一次，§125 又踩一次）。
   * ⇒ 让脚本自己问线上「现在还有没有」，有就给样本、没有就验「确实一条都不剩」。
   *
   * ⛔ `ep_media` 表不存在（老库没跑 migration #23）⇒ 返回空分布，不 500。
   */
  mediaStats(): {
    verdict: Record<string, number>;
    // ⭐ §126c：带 `media_type` —— tv/movie 是两个 id 空间，脚本要按对的类型打开详情
    pendingSamples: {
      work_id: number;
      season: number;
      episode: number;
      mt_list_size: number | null;
      media_type: string;
    }[];
    onlyLibSamples: { work_id: number; eps: number; media_type: string }[];
    total: number;
  } {
    const empty = { verdict: {}, pendingSamples: [], onlyLibSamples: [], total: 0 };
    try {
      const rows = this.db
        .prepare(
          `SELECT verdict, COUNT(*) AS n FROM ep_media GROUP BY verdict`,
        )
        .all() as { verdict: string | null; n: number }[];
      const verdict: Record<string, number> = {};
      for (const r of rows) verdict[String(r.verdict ?? 'none')] = Number(r.n);

      // ⭐ §126c：样本带 `media_type` —— tv/movie 是**两个 id 空间**，
      //   验收脚本要按对的媒体类型打开详情，否则 movie 作品打不开（404「作品不存在」）。
      const pendingSamples = this.db
        .prepare(
          `SELECT m.work_id, m.season, m.episode, m.mt_list_size,
                  COALESCE(w.media_type, 'tv') AS media_type
             FROM ep_media m
             LEFT JOIN tmdb_work w ON w.id = m.work_id
            WHERE m.verdict = 'mt_pending'
            ORDER BY (m.mt_list_size IS NULL), m.mt_list_size DESC
            LIMIT 20`,
        )
        .all() as {
        work_id: number;
        season: number;
        episode: number;
        mt_list_size: number | null;
        media_type: string;
      }[];

      const onlyLibSamples = this.db
        .prepare(
          `SELECT m.work_id, COUNT(*) AS eps,
                  COALESCE(w.media_type, 'tv') AS media_type
             FROM ep_media m
             LEFT JOIN tmdb_work w ON w.id = m.work_id
            WHERE m.verdict = 'only_lib'
            GROUP BY m.work_id HAVING eps >= 3 ORDER BY eps DESC LIMIT 10`,
        )
        .all() as { work_id: number; eps: number; media_type: string }[];

      const total = Object.values(verdict).reduce((a, b) => a + b, 0);
      return { verdict, pendingSamples, onlyLibSamples, total };
    } catch {
      return empty;
    }
  }

  /**
   * 双源覆盖体检。
   *
   * ⭐ 用户 2026-10-15：「泡面番只有hanime有记录，所以泡面番可以独立标识出来，
   *    这样我就知道它只有hanime是对的」。
   *    → 必须把「仅 hanime」拆成泡麵番（正常）和裏番（真缺口），
   *      否则 51 部正常的会被当成缺口，用户永远追着一个不存在的目标。
   */
  private coverage(): BoardStats['coverage'] {
    const empty = {
      both: 0, onlyMt: 0, onlyHnPaomian: 0, onlyHnRifan: 0, onlyHnUnknown: 0,
      neither: 0, total: 0, paomian: 0,
    };
    if (!this.hasSourceTable) return empty;
    const rows = this.db
      .prepare(
        `SELECT w.id, w.media_type,
                CASE WHEN sa.srcs LIKE '%mteam%' THEN 1 ELSE 0 END   AS has_mt,
                CASE WHEN sa.srcs LIKE '%hanime%' THEN 1 ELSE 0 END  AS has_hn,
                COALESCE(sa.hn_count, 0)                             AS hn_count,
                CASE WHEN COALESCE(sa.hn_count,0) > 0
                      AND sa.pm_count = sa.hn_count THEN 1 ELSE 0 END AS is_pm
         FROM tmdb_work w
         LEFT JOIN (${SRC_AGG_SQL}) sa ON sa.work_id = w.id AND sa.media_type = w.media_type
         WHERE ${this.visibleEx('w')}`,
      )
      .all() as Array<Record<string, number>>;

    const c = { ...empty, total: rows.length };
    for (const r of rows) {
      if (r.is_pm) c.paomian++;
      if (r.has_mt && r.has_hn) c.both++;
      else if (r.has_mt) c.onlyMt++;
      else if (r.has_hn) {
        if (r.is_pm) c.onlyHnPaomian++;
        else if (r.hn_count > 0) c.onlyHnRifan++;
        else c.onlyHnUnknown++;
      } else c.neither++;
    }
    return c;
  }

  /** 按年份分桶 —— 看板的主轴 */
  /**
   * 年份轨道 —— 🔴 2026-10-20 放开 2000 下限（作者 10-20 10:4x 指令「2000年前的也先展示出来」）
   *
   * ⭐ 历史（这里曾按 2000+ 过滤，是 10-19 21:45 B 方案的遗留）：
   *   `WHERE year >= 2000` 让在架的 2000 年前作品**数据在库、列表能搜到，
   *   但按年份分组的前端会整段漏掉** —— 那轮已解隔离、恢复了展示，漏了这一处。
   *   配套要改的还有 stats 的 `yearFrom`（原 `MIN(CASE WHEN year>=2000 ...)`）。
   *
   * ⭐ 为什么在 API 层不删数据：
   *   早于 2000 的真作品（热带侦探 1991、淫兽学园 1992、臭作 1999、黑之断章 1999…）
   *   是**真实存在的作品**，不是错配。删数据等于丢掉真词条，把口径问题变成数据缺失。
   *   现在改成全量展示，**要排除某一年以后改成前端筛选/逐件屏蔽**（`work_hidden`），
   *   不要再在这里写死年份门槛。
   */
  byYear(): YearBucket[] {
    return this.db
      .prepare(
        `SELECT year,
                COUNT(*)                                           AS total,
                SUM(CASE WHEN media_type='tv' THEN 1 ELSE 0 END)   AS tv,
                SUM(CASE WHEN media_type='movie' THEN 1 ELSE 0 END) AS movie,
                SUM(CASE WHEN season_count>0 THEN 1 ELSE 0 END)     AS withSeasons
         FROM tmdb_work
         WHERE year IS NOT NULL AND ${this.visibleEx()}
         GROUP BY year
         ORDER BY year DESC`,
      )
      .all() as unknown as YearBucket[];
  }

  /** 按年取作品列表 */
  worksByYear(
    year: number,
    opts: { mediaType?: 'tv' | 'movie'; limit?: number; offset?: number } = {},
  ): WorkBrief[] {
    const where: string[] = ['w.year = ?', this.visibleEx('w')];
    const params: Array<number | string> = [year];
    if (opts.mediaType) {
      where.push('w.media_type = ?');
      params.push(opts.mediaType);
    }
    const limit = Math.min(opts.limit ?? 200, 1000);
    const offset = opts.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT w.id, w.media_type, w.name_original, w.name_zh, w.first_air_date, w.year,
                w.episode_total, w.season_count, w.popularity, w.source_channel, w.poster_local,
                ${this.embyCols},
                ${this.wantCol},
                ${this.srcCols}
         FROM tmdb_work w ${this.srcAgg}
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(w.popularity, 0) DESC, w.name_zh, w.name_original
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return rows.map(mapWork);
  }

  /** 全部作品（看板网格用，按年份倒序） */
  allWorks(opts: { mediaType?: 'tv' | 'movie'; withPosterOnly?: boolean } = {}): WorkBrief[] {
    const where: string[] = [this.visibleEx('w')];
    const params: string[] = [];
    if (opts.mediaType) {
      where.push('w.media_type = ?');
      params.push(opts.mediaType);
    }
    if (opts.withPosterOnly) {
      where.push('w.poster_local IS NOT NULL');
    }

    const rows = this.db
      .prepare(
        `SELECT w.id, w.media_type, w.name_original, w.name_zh, w.first_air_date, w.year,
                w.episode_total, w.season_count, w.popularity, w.source_channel, w.poster_local,
                ${this.embyCols},
                ${this.wantCol},
                ${this.srcCols}
         FROM tmdb_work w ${this.srcAgg}
         WHERE ${where.join(' AND ')}
         ORDER BY w.year DESC, COALESCE(w.popularity, 0) DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const list = rows.map(mapWork);
    /* ⭐ §151：作品级标签命中一次性批量补（JOIN 只跑一次，⛔ 不在 mapWork 里逐部查）。
       ⚠️ 没标任何标签时 workHits() 直接返回空对象，这条路径零成本。 */
    const hits = this.tagMark.workHits();
    if (Object.keys(hits).length) {
      for (const w of list) {
        const h = hits[w.id];
        if (h && (h.l1.length || h.l2.length || h.l3.length || h.l4.length)) w.tagHits = h;
      }
    }
    return list;
  }

  /**
   * ⭐ 溯源明细：这部作品是由哪些源作品匹配出来的
   *
   * 用户 2026-10-15：「错了我也能直接在面板上看到他原本的片是哪一部」
   * → 返回每条源记录的**原始标题 + 番号 + 厂牌**，而不是只有数量。
   */
  sourcesOf(id: number, mediaType: 'tv' | 'movie'): SourceRef[] {
    if (!this.hasSourceTable) return [];
    // 🔴 years / entry_detail 是 2026-10-15 加的列，老库没有。
    //    直接 SELECT 会 ERR_SQL_LOGIC（不是返回 NULL），必须动态降级。
    //    列集合缓存在类字段上，避免每次打开抽屉都打一次 pragma。
    const cols = this.sourceColCache;
    const hasYears = cols.has('years');
    const hasDetail = cols.has('entry_detail');
    // 🔴 official_episodes 是 2026-10-21 加的列（源站官方集数），
    //    老库/未跑 migration 的库没有 ⇒ 同样要动态降级。
    const hasOfficial = cols.has('official_episodes');
    // 🔴 work_ja 是迁移 #9（2026-10-21）加的列：hanime 的**作品级原名**
    //    （视频页 playlist 链接的文字，日文）。老库没有 ⇒ 动态降级。
    const hasWorkJa = cols.has('work_ja');

    const rows = this.db
      .prepare(
        `SELECT src, src_key, title, brand, year, episodes, match_by, match_score, genres
                ${hasYears ? ', years' : ''}
                ${hasDetail ? ', entry_detail' : ''}
                ${hasOfficial ? ', official_episodes' : ''}
                ${hasWorkJa ? ', work_ja' : ''}
         FROM source_work
         WHERE work_id = ? AND media_type = ? AND status = 'matched'
         ORDER BY src, src_key`,
      )
      .all(id, mediaType) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      src: String(r.src ?? ''),
      srcKey: String(r.src_key ?? ''),
      title: String(r.title ?? ''),
      brand: (r.brand as string) ?? null,
      year: r.year == null ? null : Number(r.year),
      episodes: r.episodes == null ? null : Number(r.episodes),
      // ⭐ 源站官方集数（这一行对应的那个 hanime 作品在播放列表里的官方条数）。
      //    NULL = 还没核过。行级口径：一个 TMDB 作品可能对应多个 hanime 作品
      //    （合集/系列），看板上要按作品 SUM。
      officialEpisodes:
        hasOfficial && r.official_episodes != null ? Number(r.official_episodes) : null,
      // 作品级原名（日文）—— 对齐时的第三个作品名，核对时也直接显示
      workJa: hasWorkJa ? ((r.work_ja as string) ?? null) : null,
      // 🔴 genres 是 hanime 源站自己标的类型（裏番等）。
      //    ⚠️ 实测线上存的是**纯字符串** `"裏番"`，不是 JSON 数组
      //    （历史写入路径决定的，不能想当然按数组解析）。
      //    所以先试 JSON，失败就当纯字符串用；绝不让一条脏数据把面板打成 500。
      genre: normalizeGenre(r.genres),
      matchBy: (r.match_by as string) ?? null,
      matchScore: r.match_score == null ? null : Number(r.match_score),
      years: hasYears ? parseJsonArray<number>(r.years as string) : null,
      entryDetail: hasDetail
        ? parseJsonArray<SourceEntry>(r.entry_detail as string)
        : null,
    }));
  }

  /** 单部作品详情 + 季集 + 溯源明细 */
  detail(
    id: number,
    mediaType: 'tv' | 'movie' = 'tv',
  ): {
    work: WorkBrief;
    episodes: Array<Record<string, unknown>>;
    evidence: WorkEvidence & { crossCheck: CrossCheck };
    /** 逐集对照（TMDB 分季分集 × 源站每条视频） */
    alignment: AlignResult;
    /**
     * ⭐ §87（2026-10-30）：逐集对照的「源站条目 ⇄ 下载链接」对账数。
     *
     * 作者要的是「**集对集**地看 hanime 和下载链接」，不是一份全站覆盖率报表。
     * 分母（srcItems）现算 = 这部作品在源站有几个 vid（去重），
     * ⛔ 不认缓存数字（0r31：认缓存 = 自证指标）。
     * 每条源条目自己的链接挂在 `alignment.rows[].hanime[].link` 上。
     */
    dlSource: {
      /** 源站条目数（按 vid 去重）—— 分母 */
      srcItems: number;
      /** 其中有链接的条数 —— 分子 */
      withLink: number;
      /** 签名已过期的条数（需重抓） */
      expired: number;
      /** HLS(m3u8) 条数 —— 本轮不支持下载 */
      m3u8: number;
      /** 源站有、链接表没有 ⇒ 真缺口 */
      missing: number;
    };
    /**
     * ⭐ §108（2026-10-31 作者）：vid → {标签, hanime 预览图}。
     *
     * 作者：「hanime 的每一集都把他的标签抓下来放到对应的集数」+
     *       「TMDB 剧集无图的，抓 hanime 的预览图做剧集海报」。
     * `key` = `alignment.rows[].hanime[].id`（就是 vid，也就是前端显示的「番號」）。
     *
     * ⛔ 不在 map 里的 vid = **没抓到**（video_tag 无行 / 表不存在 / 老库）——
     *    前端据此不画标签、不回退封面，而不是画空壳（0cs）。
     * ⚠️ cover 是**落盘后的本地相对 URL**（`/images/still_hn/<vid>.jpg`），
     *    ⛔ 不是源站带签名的外链（两周后会集体裂图）。
     */
    videoMeta: Record<string, { tags: string[]; cover: string | null }>;
    /**
     * ⭐ §115（2026-11-01）：逐集体积/画质对照，key = `season-episode`（如 `1-3`）。
     *
     * 三块口径分开给，⛔ 前端不许合成一个「大小」：
     *   · `mt`  = mteam **盘上原始文件**（ffprobe 实测：有真分辨率/编码/码率/时长）
     *   · `lib` = 库内**已整理**文件（115 上，只有大小 —— FUSE 读不到头，Emby 是 strm）
     *   · `srcQuality` = hanime 源侧**最高可下档**（1080/720/480）
     * ⚠️ `lib` **不是 hanime**：库内混着 mteam 的文件。
     *
     * ⛔ 不在 map 里 = 这一集既没有 mteam 文件也没有库内文件（不是「没算」）。
     * ⛔ 表不存在 / 查询失败 ⇒ **空对象**，前端据此不画这一列（0cs）。
     */
    media: Record<string, EpMediaView>;
    /**
     * 画质对照数据的快照时间（`ep_media.updated_at` 最大值）。
     * ⛔ 空对象时必须是 `null`，⛔ 不许兜底成当前时间 —— 那等于自证指标。
     */
    mediaSnapshotAt: string | null;
    /** 入库状态（2026-10-22 建，2026-10-27 判据换成 Emby）
     *  episodes 按 (season, episode) 逐集给；season/episode 为 null 的只算「作品级已入库」。
     *  🔴 2026-10-27：数据源由 `local_file/local_work`（本地文件扫描）改为
     *     `emby_episode`（Emby「动画里番」库 196470）。作者定调：Emby 里有才算入库。
     *     理由见 localEps 处的长注释（两批内容几乎不重叠 + /library 不在任何 Emby 库里）。 */
    local: {
      /** 这部在 **Emby 里番库** 里有没有任何一集 */
      hasWork: boolean;
      /** 判据来源，恒为 'emby'（前端据此改文案；旧版是本地文件扫描，已废弃） */
      source: 'emby';
      /** Emby 库**同步过没有**。false ⇒ `hasWork:false` 只代表「没同步」，⛔ 不是「没入库」。
       *  （0cs：接口缺字段不许兜底成「没有」；这里给显式标志让前端区分两种空。） */
      ready: boolean;
      episodes: Array<{ season: number | null; episode: number | null; fileName: string | null }>;
    };
    /** ⭐ 2026-10-26（§69 ⑥）：这部被**季级屏蔽**掉的季号（升序）。
     *  ⚠️ 空数组 = 没有任何季被屏（绝大多数作品）。前端据此显示「S02 已屏蔽（可恢复）」。
     *  ⛔ 不给默认值 / 不兜底成 null —— 「没屏」是明确的空集，「不知道」才该缺字段（0cs）。 */
    hiddenSeasons: number[];
    /**
     * 被**集级排除**的集（§74，2026-10-27）。
     *
     * 这些集**已从 `episodes` 与 `alignment` 里剔除**（与季级屏蔽同构），
     * 只在这里回传一份，供前端显示「已排除 S1E3 [恢复]」——
     * ⛔ 不回传就是死锁：那行凭空消失，用户找不到恢复入口（0cs）。
     */
    hiddenEpisodes: Array<{ season: number; episode: number; name: string | null }>;
  } | null {
    const w = this.db
      .prepare(
        `SELECT w.id, w.media_type, w.name_original, w.name_zh, w.first_air_date, w.year,
                w.episode_total, w.season_count, w.popularity, w.source_channel, w.poster_local,
                w.genres, w.work_origin, w.discovery_srcs, w.evidence_note, w.evidence_json,
                w.overview,
                ${this.srcCols},
                ${this.embyCols},
                ${this.wantCol}
         FROM tmdb_work w ${this.srcAgg}
         WHERE w.media_type = ? AND w.id = ? AND ${this.visible.replace(/\bis_quarantined\b/g, 'w.is_quarantined')}`,
         // 🔴 2026-10-20：这里**故意不过滤已屏蔽的作品**（⛔ 不用 visibleEx）。
         //    理由：详情页是「屏蔽这部 / ✓ 已屏蔽（点此恢复）」按钮的**唯一入口** ——
         //    一旦过滤掉，屏蔽后就再也打不开这部、无法恢复 = 死锁。
         //    详情是「按 id 精确查」，被屏蔽的部不在列表里但仍可直达详情，这是可接受的。
      )
      .get(mediaType, id) as Record<string, unknown> | undefined;

    if (!w) return null;

    /* 🔴🔴 2026-10-26（§69 ⑥ 作者：「壳中的小鸟的S02可以屏蔽不显示」）：
       **季级屏蔽** —— 在 `eps` 这一层过滤掉被屏蔽的季。
       
       ⭐ 为什么过滤点只选这里（一处改动覆盖全部下游）：
          · `episodes`（返回给前端的集列表）← 直接来自 eps
          · `alignment`（逐集对齐）← `alignEpisodes(eps, …)`
          · 前端季标签 `bySeason` ← 由 `d.episodes` 自己分组（web/index.html:2065）
         ⇒ 三个视图**同源**，过滤 eps 就同时生效，不会出现「表里没了、季标签还在」。
       
       ⚠️ 不过滤 `tmdb_work.season_count` / `episode_total`：
          那两个是 **TMDB 元数据快照**，不是「我们展示的集」。
          改了它们会让 `stats()`（全库口径）与 `detail()` 分裂 ⇒ 违反 0ay
          （解口径限制必须全部同口径一起放开）。
          取而代之：返回值带 `hiddenSeasons`，前端显式提示「S02 已屏蔽（可恢复）」
          ⇒ 用户知道是自己屏的，不会被误读成「数据丢了」（0cs：⛔ 兜底成「没有」）。
       
       ⚠️ 表不存在 / 没屏过 ⇒ `seasonKeys()` 返空集 ⇒ SQL 完全不变（零行为变化）。 */
    const hiddenSeasons = this.hidden
      ? [...this.hidden.seasonKeys(id)].filter((sn) => Number.isFinite(sn))
      : [];
    const seasonFilter = hiddenSeasons.length
      ? ` AND season NOT IN (${hiddenSeasons.map(() => '?').join(',')})`
      : '';

    /* ⭐ 2026-10-27（§74 作者：「屏蔽本季感觉没用啊，要是遇到风纪委员与风俗活动这种
       只是缺集的，你把整季屏蔽了」）—— **集级排除**。
       
       🔴 语义与季级屏蔽**完全同构**：被排除的集从 `eps` 里剔除 ⇒
          `episodes` / `alignment` / 前端分季 三个视图同时生效（过滤点只有这一处）。
          剔除后如果剩余集全在 Emby 里 ⇒ `embyNeed` 也跟着降 ⇒ 卡面立刻绿标（闭环）。
       🔴 与季级屏蔽的唯一差别：**粒度到集**，所以不需要动 `tmdb_episode` 表。
       ⚠️ 返回 `hiddenEpisodes` 让前端显示「已排除 S1E3 [恢复]」——
          否则用户点了排除，那行凭空消失、找不到恢复入口（= 死锁，0cs）。 */
    const hiddenEpPairs = this.hidden ? [...this.hidden.episodeKeys(id)] : [];
    const hiddenEpSet = new Set(hiddenEpPairs);

    const eps = (
      this.db
        .prepare(
          `SELECT season, episode, ep_name, air_date, runtime, still_path, still_local, overview
                  ${this.hasEpNameJa ? ', ep_name_ja' : ''}
                  ${this.hasEpOverviewZh ? ', overview_zh' : ''}
           FROM tmdb_episode
           WHERE work_id = ? AND media_type = ?${seasonFilter}
           ORDER BY season, episode`,
        )
        .all(id, mediaType, ...hiddenSeasons) as Array<Record<string, unknown>>
    ).filter((e) => !hiddenEpSet.has(`${Number(e.season)}-${Number(e.episode)}`));

    // 被集级排除的集要带回「集名」—— 前端「已排除 S1E3 第 3 集 [恢复]」要用
    let hiddenEpisodeRows: Array<{
      season: number;
      episode: number;
      name: string | null;
    }> = [];
    if (hiddenEpPairs.length) {
      const allEps = this.db
        .prepare(
          `SELECT season, episode, ep_name FROM tmdb_episode
            WHERE work_id = ? AND media_type = ?${seasonFilter}
            ORDER BY season, episode`,
        )
        .all(id, mediaType, ...hiddenSeasons) as Array<Record<string, unknown>>;
      hiddenEpisodeRows = allEps
        .filter((e) => hiddenEpSet.has(`${Number(e.season)}-${Number(e.episode)}`))
        .map((e) => ({
          season: Number(e.season),
          episode: Number(e.episode),
          name: (e.ep_name as string) ?? null,
        }));
    }

    /* ⭐ 2026-10-27（§70）：**入库状态（按集）** —— 二级看板「入库判定」列的数据源。
       🔴🔴 判据已换：作者定调「有没有在这个 emby 库里，这才是里番的入库判定标准」。
          ⇒ 从 `local_file → local_work`（扫 /library/已整理 的本地文件）
            改为 `emby_episode`（Emby「动画里番」库 196470 的同步快照）。
       🔴 为什么必须换：实测两批内容**几乎完全不重叠** ——
          Emby 457 部 ∩ 本地 622 部 = 仅 3 部；看板 1323 部里
          Emby 命中 432 部 / 本地命中 605 部，而 Emby 的 17 个库
          **没有任何一个挂 /library** ⇒ 旧判据说「已入库」的部，作者在 Emby 里点不开。
       ⚠️ `synced_at = last_sync` 这个条件**不能省**：同步是全量 `INSERT OR REPLACE`
          不删旧行（铁律禁 DELETE），已从 Emby 移除的条目只能靠时间戳出局。
       🔴 旧链路存档（⛔ 别再用）：`local_file.work_id → local_work.id → local_work.tmdb_id`
          两跳；`local_file.work_id` 不是 tmdb id。实测 local_file 1529 行 / 对上 607 部。 */
    // Emby 库到底同步过没有 —— ⛔ 别把「没同步」当成「没入库」（0cs）
    const embyReady = Boolean(
      this.db.prepare(`SELECT 1 AS x FROM emby_sync_meta WHERE key = 'last_sync'`).get(),
    );

    const localEps = this.db
      .prepare(
        `SELECT season, episode, path AS file_name
           FROM emby_episode
          WHERE tmdb_id = ?
            AND synced_at = (SELECT value FROM emby_sync_meta WHERE key = 'last_sync')
            ${seasonFilter}
          ORDER BY season, episode`,
      )
      .all(id, ...hiddenSeasons) as Array<{
      season: number | null;
      episode: number | null;
      file_name: string | null;
    }>;

    let evDetail: Record<string, unknown> | null = null;
    if (typeof w.evidence_json === 'string' && w.evidence_json) {
      try {
        evDetail = JSON.parse(w.evidence_json) as Record<string, unknown>;
      } catch {
        evDetail = null; // 证据链损坏不应让详情页 500
      }
    }

    const sources = this.sourcesOf(id, mediaType);

    // ⭐ 逐集对齐（2026-10-21 作者提议）：
    //   「tmdb 上不是已经有完整的分季分集吗，我们只要把 hanime 和 mteam 对应的数据
    //     放它下面，这样不是一眼就看出来对不对，有没有缺少吗」
    //   ⇒ 把 TMDB 的分季分集当骨架，把源站每条视频对齐到对应集，
    //     缺源的集、多出来的源条目，一眼可见。
    const alignItems: AlignItem[] = [];
    for (const s of sources) {
      if (s.src === 'hanime') {
        for (const e of s.entryDetail ?? []) {
          const t = e.title ?? '';
          const tj = e.title_ja ?? null;
          alignItems.push({
            kind: 'hanime',
            id: String(e.vid ?? ''),
            title: t,
            titleJa: tj,
            // §67：播放页完整标题**只给前端显示**，⛔ 不参与 alignVol（见接口注释）
            titlePage: e.title_page ?? null,
            // 源站播放清单编号：同一清单 = 源站认为的同一部作品（辅助证据）
            playlistId: e.playlist_id ?? null,
            year: e.year ?? null,
            srcKey: s.srcKey,
            // ⚠️ 卷号要**标题和日文原名都看**：
            //   「ミセスジャンキー ボリューム1」这类卷号只写在日文原名里
            //   （中文清单页那栏是「人妻上癮者 1」，译名，卷号形式也变了）。
            vol: alignVol(t) || alignVol(tj),
          });
        }
      } else {
        /* ⭐ 2026-10-22（作者：「因为缺数据，所以很多没填上」）：
           mteam 侧原先**一行只压成 1 条对齐项**（`s.title` 是种子名），
           而 MT 一个种子常常是「两集合一包」——
           实测 `KSXA54361` 里有 第1話+第2話、`KSXA54362` 里有 第3話+第4話。
           于是包里只有排在第一个的那集（第1話/第3話）能被 vol 挂上，
           第2話/第4話 的 mteam 列永远是空的 —— **不是源站缺集，是我们没展开**。
           全库口径：3218 行 mteam 里 75 行属于这种多集包，覆盖 40 部作品。

           ⇒ 有 `entryDetail` 就按条展开（与 hanime 分支同构）；
             没有就退回老行为（1 行 1 条），保证其余 3143 行行为**完全不变**。
           ⚠️ 同一番号会产出多条 `id` 相同的 AlignItem —— alignEpisodes 用
             **下标**（`usedItem: Set<number>`）记账，不按 id 去重，所以安全。 */
        const det = s.entryDetail ?? [];
        if (det.length) {
          for (const e of det) {
            const t = e.title ?? '';
            /* 🔴 2026-10-24（批次16）：**卷号取不到时用 entry_detail 的结构化 `vol` 兜底**。
               
               根因（作者：「淫獣～ねらわれた花嫁～ 前篇对应 122284，有前篇就有后篇，
               我没看到你抓到后篇」）：
               源站把**前后篇塞进同一个种子包、共用同一个番号** `JDRA-55653`，
               而 `mteam_extract.py` 按番号 `code` 去重（`works.setdefault(code, …)`）
               ⇒ 后篇被合并吞掉，库里只剩「前篇」一条。
               
               ⇒ 数据侧：给这条补 `entryDetail` 两条（前篇 vol=1 / 後篇 vol=2）。
               ⇒ 但 `alignVol()` **只认 `vol/巻/第N巻/结尾裸数字/罗马数字`**，
                 「前篇」「後篇」它取不到（返回 0）⇒ `alignItems.sort` 两条都是 0，
                 vol 档 `vol === episode` 也不成立 ⇒ 後篇照样无处可落。
               
               ⭐ `entry_detail[].vol` 本来就是**结构化卷号**（与 `第N話` 同级的事实，
                 不是从标题猜的），比 `alignVol(title)` 更硬。实测 68 个展开项里
                 30 项两者一致、38 项 `alignVol=0`（标题只有「第1話/第一章/前篇」）。
               
               ⚠️ **闸门必须窄**：`alignVol(t) || e.vol` —— 标题里显式写了卷号就以标题为准
                 （0ec：新判据不得挤掉原本正确的证据）；只有标题取不到才用结构化 vol。
                 实测这样只改 37 项，且全部是「原本 vol=0、只能靠 marker 落位」的条目。 */
            const vTitle = alignVol(t);
            const vDetail =
              typeof e.vol === 'number' && e.vol >= 1 && e.vol <= 99 ? e.vol : 0;
            alignItems.push({
              kind: 'mteam',
              id: s.srcKey,
              title: t,
              titleJa: e.title_ja ?? null,
              year: e.year ?? s.year ?? null,
              srcKey: s.srcKey,
              vol: vTitle || vDetail,
            });
          }
        } else {
          const t = s.title ?? '';
          alignItems.push({
            kind: 'mteam',
            id: s.srcKey,
            title: t,
            titleJa: null,
            year: s.year ?? null,
            srcKey: s.srcKey,
            vol: alignVol(t),
          });
        }
      }
    }
    alignItems.sort((a, b) => a.vol - b.vol || a.id.localeCompare(b.id));
    /* ⭐ 2026-10-23：注入人工指定集号/季号（合集里子作品卷号 ≠ TMDB 全局集号）
       ⚠️ 必须在 sort 之后 —— 排序只看 vol，epOverride 不参与排序。
       ⭐ 值为对象时同时钉季号（源卷号跨季连续 / year 是售卖年 ⇒ 必须钉）。 */
    const ovMap = epOverrides()[String(id)];
    if (ovMap) {
      for (const it of alignItems) {
        const v = ovMap[it.id];
        if (typeof v === 'number') {
          if (v >= 1) it.epOverride = v;
        } else if (v && typeof v === 'object') {
          const s = Number(v.s ?? v.season);
          const eRaw = v.e ?? v.episode;
          if (Number.isFinite(s) && s >= 0) it.epSeason = s;
          /* ⭐ 2026-10-28（§79-z-3）：`"e": [1,2]` = **这一条源同时覆盖多集**
             （源站合并发售，如「真章・幻夢館 Epilogue 第1+2話」）。
             数组时 epOverride 取首项（兼容只读单值的旧路径），
             epOverrideAll 交给 align 的 override 档逐集挂。 */
          if (Array.isArray(eRaw)) {
            const arr = eRaw
              .map((x) => Number(x))
              .filter((x) => Number.isFinite(x) && x >= 1);
            if (arr.length) {
              it.epOverride = arr[0];
              it.epOverrideAll = arr;
            }
          } else {
            const e = Number(eRaw);
            if (Number.isFinite(e) && e >= 1) it.epOverride = e;
          }
        }
      }
    }
    /* ⭐ §142（2026-11-03 作者「这两个文件是 S1E01 和 S01E02，你怎么都匹配到同一集」）
       同一个番号下挂了**两个不同集**的文件时（DWPA-103 = 星にお願い / スペシャルプライス、
       JDXA-57444 = 夢物語 / 完結編），番号级 override 只能钉一个集号 ⇒ 两个文件都落到同一集。
       `align_ep_override.json` 的作品下可写 `_files: [{code, match, s, e}]`，
       这里按**条目标题子串**把每条源条目钉到自己那一集（与匹配引擎 §142 同一份规则，0lx）。 */
    const _ovRaw = epOverrides()[String(id)] as unknown as
      | { _files?: Array<{ code?: string; match?: string; s?: number; e?: number | number[] }> }
      | undefined;
    const _fileOv = Array.isArray(_ovRaw?._files) ? _ovRaw!._files! : [];
    if (_fileOv.length) {
      for (const it of alignItems) {
        if (it.kind !== 'mteam') continue;
        for (const r of _fileOv) {
          const code = String(r.code || '').toUpperCase();
          if (code && code !== String(it.id).toUpperCase()) continue;
          if (r.match && typeof it.title === 'string' && it.title.includes(r.match)) {
            const es = Number(r.s);
            if (Number.isFinite(es) && es >= 0) it.epSeason = es;
            /* ⭐ §154：`e` 可为数组（一个文件装两集，対魔忍アサギ2 #01+#02 = ZIZD-007）
               ⇒ 与番号级 override 的 `e:[1,2]` 同义，逐集挂。 */
            if (Array.isArray(r.e)) {
              const arr = (r.e as number[])
                .map((x) => Number(x))
                .filter((x) => Number.isFinite(x) && x >= 1);
              if (arr.length) {
                it.epOverride = arr[0];
                it.epOverrideAll = arr;
              }
            } else {
              const ee = Number(r.e);
              if (Number.isFinite(ee) && ee >= 1) it.epOverride = ee;
            }
            break;
          }
        }
      }
    }
    const alignment = alignEpisodes(
      eps.map((e) => ({
        season: Number(e.season),
        episode: Number(e.episode),
        // §109：同一个清洗函数（0lx 一处判据）—— 逐集对照表显示的就是这里
        ep_name: cleanEpName(e.ep_name as string),
        air_date: (e.air_date as string) ?? null,
        // ⭐ 日文集名（migration #10）—— 老库没这列 ⇒ null ⇒ 通道自动降级关闭
        ep_name_ja: cleanEpName(e.ep_name_ja as string),
      })),
      alignItems,
      // ⭐ 季名 —— 季级对齐的第一级依据（2026-10-21 作者指正）
      this.seasonsOf(id, mediaType),
      // 作品名 —— 残差匹配要靠它把「作品名 + 卷号 + 集标题」剥成可比部分
      //   （实测 103247「女忍学园忍法帖」：TMDB 集名是中文、源标题是日文，
      //    两边剥掉各自的作品名之后残差逐字相等）
      // 作品级原名（hanime 视频页 playlist 链接文字）也一并算作作品名 ——
      //   它是**未翻译**的那一份，剥掉它残差才干净。
      [
        w.name_zh as string | null,
        w.name_original as string | null,
        ...sources.map((s) => s.workJa).filter((x): x is string => !!x),
      ],
    );

    /* ⭐ §87（2026-10-30，作者：「我要看的是**集对集**的 hanime 和下载链接，
         哪里缺集了、hanime 更新了没、对应下载链接抓到了吗」）：
         逐集对照表里，每一条 hanime 源条目都要带出「它的下载链接」。
       🔴 复用 matcher 的 `readEpisodeLinks()`（全站唯一实现，按 vid 查）——
          ⛔ 不在这里另写一份 `source_link` SQL（0lx：同一问题两份判据必漂移）。
       ⚠️ 链接挂在**源条目**上（vid 级），不挂 TMDB 格子 ——
          同一格挂两条源（合并发售）时，两条各自的链接都要能分别看到。
       ⛔ 完整 URL 不进这个接口（签名串上百字符、还会被 HTML 转义弄坏）⇒
          前端点画质徽章时走 `/api/dl/link/:vid` 单独取。 */
    const dlSource = (() => {
      const vids: string[] = [];
      for (const r of alignment.rows) {
        for (const it of r.hanime) if (it && it.id) vids.push(String(it.id));
      }
      const uniq = [...new Set(vids)];
      const map = readEpisodeLinks(this.db, uniq);
      const now = Math.floor(Date.now() / 1000);
      let withLink = 0, expired = 0, m3u8 = 0;
      for (const v of uniq) {
        const L = map.get(v);
        if (!L) continue;
        withLink++;
        if (L.expiresAt != null && L.expiresAt <= now) expired++;
        if (L.isM3u8) m3u8++;
      }
      /* 挂到每一行上（含「未对上任何集」的 extra 之外那些 —— extra 没 vid 索引，
         不在这里挂；它们本来就不参与逐集对照） */
      for (const r of alignment.rows) {
        for (const it of r.hanime) {
          if (!it) continue;
          const L = it.id ? map.get(String(it.id)) : undefined;
          it.link = L
            ? {
                quality: L.quality,
                isM3u8: L.isM3u8,
                expiresAt: L.expiresAt,
                srcKind: L.srcKind,
                rateLimit: L.rateLimit,
                /* ⭐ §116：⚠️ 这是**白名单**式挑选，漏一个字段前端就永远拿不到。
                   2026-11-01 就因为没加这行，库里 size 明明有值、看板上却一条不显示。 */
                size: L.size,
              }
            : null;
        }
      }
      return {
        /** 源站条目数（按 vid 去重）—— 分母 */
        srcItems: uniq.length,
        /** 其中有链接的条数 —— 分子 */
        withLink,
        /** 签名已过期的条数 */
        expired,
        /** HLS 条数（本轮不支持下载） */
        m3u8,
        /** 源站有、链接表没有 ⇒ 真缺口 */
        missing: Math.max(0, uniq.length - withLink),
      };
    })();

    /* ⭐ §108（2026-10-31 作者两条需求）：
         ① 「TMDB 剧集无图的、但有 hanime 的，抓取 hanime 的预览图做剧集海报」
         ④ 「hanime 的每一集都把他的标签抓下来放到对应的集数，看标签就知道类型」
       ⇒ 两者都挂在 **vid** 上（`video_tag` 表，一张 vid 一行），
         由前端按 hanime 条目的 id 自己去取 —— ⛔ 不塞进 alignment 行（那是纯函数产出，
         本模块的职责只是把「vid → 标签/封面」这一层查出来）。
       🔴 批量查（和上面 dlSource 同款），⛔ 不逐行查：一集最多挂 3 条源、几十行表。
       ⛔ 表不存在（老库没跑 migration）⇒ 返回空对象 ⇒ 前端不画标签（0cs：别崩、别谎报） */
    const videoMeta = (() => {
      const vids: string[] = [];
      for (const r of alignment.rows) {
        for (const it of r.hanime) if (it && it.id) vids.push(String(it.id));
      }
      const uniq = [...new Set(vids)];
      const out: Record<string, { tags: string[]; cover: string | null }> = {};
      if (!uniq.length) return out;
      try {
        const has = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='video_tag'`)
          .get();
        if (!has) return out;
        const ph = uniq.map(() => '?').join(',');
        const rows = this.db
          .prepare(`SELECT vid, tags, cover_local FROM video_tag WHERE vid IN (${ph})`)
          .all(...uniq) as Array<{ vid: string; tags: string | null; cover_local: string | null }>;
        for (const r of rows) {
          let tags: string[] = [];
          if (r.tags) {
            try {
              const a = JSON.parse(r.tags) as unknown;
              if (Array.isArray(a)) tags = a.map((x) => String(x)).filter(Boolean);
            } catch {
              // 脏 JSON ⇒ 当没标签（⛔ 不编、不猜）
            }
          }
          out[String(r.vid)] = {
            tags,
            cover: typeof r.cover_local === 'string' && r.cover_local
              ? `/images/${r.cover_local}`
              : null,
          };
        }
      } catch {
        // 查询失败 ⇒ 空对象（降级不崩）
      }
      return out;
    })();

    /* ⭐ §115（2026-11-01 作者）：「一眼看出我应该下哪一个，哪一个质量更高」
       ⇒ 逐集带出「mteam 盘上实测 / 库内已整理 / 源侧最高可下档 / 判定」。
       🔴 三个口径**必须分开**，⛔ 不许合成一个「大小」：
          · mt_*        = mteam 盘上**原始文件**（ffprobe 实测，有真分辨率/编码/码率）
          · lib_*       = 库内**已整理**文件（115 上，只有大小）
          · src_quality = hanime 源侧**最高可下档**（source_link.quality）
       ⚠️ lib_* **不是 hanime**：库内混着 mteam 的文件（实测 75 集字节完全相同）。
       🔴 数据由 `scripts/sync_ep_media.py` 离线算好落库 —— ffprobe 扫全盘要 3 分钟，
          挂在接口上必然超时；接口只读快照。刷新 = 重跑那条脚本，⛔ 不用重建镜像。
       ⛔ 表不存在 ⇒ 空对象 + null 快照时间 ⇒ 前端不画这一列（0cs：别崩、别谎报） */
    const media: Record<string, EpMediaView> = {};
    let mediaAt: string | null = null;
    if (this.hasEpMedia) {
      try {
        const mrows = this.db
          .prepare(
            `SELECT season, episode, mt_size, mt_w, mt_h, mt_codec, mt_mbps, mt_sec,
                    mt_n, mt_code, mt_files, lib_size, lib_n, lib_files,
                    src_quality, verdict, note, updated_at,
                    mt_list_size, mt_list_n, mt_list_files
               FROM ep_media WHERE work_id = ?`,
          )
          .all(id) as Array<Record<string, unknown>>;
        for (const m of mrows) {
          const k = `${Number(m.season)}-${Number(m.episode)}`;
          media[k] = {
            mt: m.mt_size == null
              ? null
              : {
                  size: Number(m.mt_size),
                  w: m.mt_w == null ? null : Number(m.mt_w),
                  h: m.mt_h == null ? null : Number(m.mt_h),
                  codec: (m.mt_codec as string) ?? null,
                  mbps: m.mt_mbps == null ? null : Number(m.mt_mbps),
                  sec: m.mt_sec == null ? null : Number(m.mt_sec),
                  n: m.mt_n == null ? null : Number(m.mt_n),
                  code: (m.mt_code as string) ?? null,
                  files: parseJsonArray<Record<string, unknown>>(m.mt_files),
                },
            /* ⭐⭐ §127（2026-11-02）：`lib_*` 改成 **Emby 媒体库里那份**（实测体积/画质），
               不再是 10-14 的 `/library/已整理` 旧快照 ⇒ 和「入库判定」列同源、两边不再打架。
               ⭐ 分辨率/编码从 `lib_files[0]` 里取（那数组现在带 w/h/codec/sec/mbps）。 */
            lib: (() => {
              if (m.lib_size == null) return null;
              const fs = parseJsonArray<Record<string, unknown>>(m.lib_files) ?? [];
              const f0 = fs[0];
              const num = (v: unknown): number | null =>
                v == null ? null : Number(v);
              return {
                size: Number(m.lib_size),
                n: m.lib_n == null ? null : Number(m.lib_n),
                files: fs,
                w: f0 ? num(f0.w) : null,
                h: f0 ? num(f0.h) : null,
                codec: f0 && typeof f0.codec === 'string' ? f0.codec : null,
                sec: f0 ? num(f0.sec) : null,
                mbps: f0 ? num(f0.mbps) : null,
              };
            })(),
            srcQuality: m.src_quality == null ? null : Number(m.src_quality),
            /* ⭐ §117（2026-11-01 作者「hanime 和 mteam 的视频信息是 8848 全库都要做」）：
               mteam **清单**侧 —— 种子清单里写着的那一份（含没落盘的）。
               ⚠️ 与 `mt` 是两份事实，⛔ 不合并：`mt` 是「已经在盘上、ffprobe 量过」，
                  `mtList` 是「清单里有、可能还在下」，分辨率/编码只有盘上那份才有。 */
            mtList: m.mt_list_size == null
              ? null
              : {
                  size: Number(m.mt_list_size),
                  n: m.mt_list_n == null ? null : Number(m.mt_list_n),
                  files: parseJsonArray<Record<string, unknown>>(m.mt_list_files),
                },
            verdict: (m.verdict as string) ?? null,
            note: (m.note as string) ?? null,
          };
          const at = (m.updated_at as string) ?? null;
          if (at && (!mediaAt || at > mediaAt)) mediaAt = at;
        }
      } catch {
        // 查询失败（表结构不对 / 库被锁）⇒ 整块降级，⛔ 不让详情页 500
      }
    }

    /* ⭐⭐ §146（2026-11-03 作者「mt 的匹配全错」）：
       逐集对照表里 mteam 那一格挂的是**哪条源作品**，靠 `alignEpisodes()` 的标题判据；
       标题里没有集号/卷号时只能按 `vol→id 字典序` 补位 ⇒ 顺序 ≠ 集序就整体错位。
       实测 154396 けものっ娘通信 四集：条目按番号排成
       `RJ-01147437(鳥娘) < RJ-01390111(狸娘) < RJ-363732(牛娘) < RJ01000458(猫娘)`，
       于是牛娘那行显示成鳥娘的标题 —— 而 `ep_media.mt_code`（离线匹配引擎
       `build_mt_disk_match.py` 按番号/字节算出来的硬事实）是对的。
       ⇒ 冲突时**以 mt_code 为准重排**（与 0r203「独立页集位只来自 mt_full_matched」同一口径）。
       🔴 只做**纯置换**：① 每条都能查到目标集 ② 目标集互不重复
          ③ 目标集集合 == 当前集集合。三条不满足就一个字都不动（⛔ 不猜、不丢条目）。 */
    if (this.hasEpMedia) {
      /* 番号归一：`_T_` 前缀（manual_bind 的作品名键）/ 末尾 `#2`（撞号后的第二条）
         ⛔ 都只是库内记账用的后缀，不是番号的一部分 ⇒ 比较前剥掉（0r196）。 */
      const normCode = (s: unknown): string =>
        String(s ?? '').toUpperCase().replace(/^_T_/, '').replace(/#\d+$/, '').trim();
      const wantByCode = new Map<string, string[]>(); // 番号 → 它对应的 `season-episode`（可能 0/1/多条）
      for (const [k, v] of Object.entries(media)) {
        const c = normCode(v.mt?.code);
        if (!c) continue;
        const arr = wantByCode.get(c);
        if (arr) arr.push(k);
        else wantByCode.set(c, [k]);
      }
      const rowIdxOf = new Map<string, number>();
      alignment.rows.forEach((r, ri) => rowIdxOf.set(`${r.season}-${r.episode}`, ri));

      /* ⭐⭐ §147（2026-11-03 作者「番号没有参考意义，标题才是唯一正解」）
         ------------------------------------------------------------------
         以前这里做「纯置换」，要求**目标行集合 == 当前行集合**。实测 #156926 奸染
         整体错一格（每条都往后挪了一格）⇒ 集合天然差一格 ⇒ 闸门必然失败 ⇒ 一个字都不动
         （#73278 同理：特典那条掉进 S1E1）。这类作品在页面上就一直挂着错的标题。
         根因是 ep_media 的集位以前也来自「番号/发布先后排序」，两边都不可信，只能互相
         迁就。现在 `build_mt_disk_match` 的集位由**集名**定（title 判据），是全库唯一
         事实源 ⇒ 页面直接按 `mt_code` **落位**，不再要求集合相等。
         🔴 三道保护（都是「这条不动」，⛔ 不是整部放弃、更不是猜）：
            ① 该条目没有番号 / 番号在 ep_media 里查不到 ⇒ 留在原行
            ② 番号对应多集（两集共用一个番号）⇒ 留在原行（0ay：Σ分组 == 总量）
            ③ 目标行被「留原行」的条目占着 ⇒ 这条也不动
         ✅ 落位后校验条目总数不变（不等就整段恢复快照，⛔ 宁可不动也不丢条目） */
      const movable: Array<{ to: number; item: AlignItem }> = [];
      const fixedOnes: Array<{ ri: number; item: AlignItem }> = [];
      alignment.rows.forEach((row, ri) => {
        for (const it of row.mteam) {
          const c = normCode(it.id);
          const keys = c ? wantByCode.get(c) : null;
          const tri = keys && keys.length === 1 ? (rowIdxOf.get(keys[0]) ?? -1) : -1;
          if (tri < 0) {
            fixedOnes.push({ ri, item: it });
            continue;
          }
          movable.push({ to: tri, item: it });
        }
      });
      const fixedRows = new Set(fixedOnes.map((f) => f.ri));
      const keep = movable.filter((m) => !fixedRows.has(m.to));
      const stay = movable.filter((m) => fixedRows.has(m.to));
      const moves = keep.filter((m, i) => {
        /* 已经在对的行就不折腾（避免无意义的清空重建） */
        const curRow = alignment.rows.findIndex((r) => r.mteam.includes(m.item));
        return curRow !== m.to;
      });
      if (moves.length) {
        const snapshot = alignment.rows.map((r) => r.mteam.slice());
        const before = snapshot.reduce((n, r) => n + r.length, 0);
        alignment.rows.forEach((r) => { r.mteam = []; });
        for (const f of fixedOnes) alignment.rows[f.ri].mteam.push(f.item);
        for (const s of stay) {
          const curRow = snapshot.findIndex((r) => r.includes(s.item));
          if (curRow >= 0) alignment.rows[curRow].mteam.push(s.item);
        }
        for (const m of keep) alignment.rows[m.to].mteam.push(m.item);
        const after = alignment.rows.reduce((n, r) => n + r.mteam.length, 0);
        if (after !== before) {
          /* 守恒破了 ⇒ 整段退回（⛔ 宁可显示旧顺序，也不能丢条目） */
          alignment.rows.forEach((r, ri) => { r.mteam = snapshot[ri]; });
        }
      }
    }

    return {
      work: mapWork(w),
      episodes: eps.map((e) => ({
        season: Number(e.season),
        episode: Number(e.episode),
        name: cleanEpName(e.ep_name as string),
        airDate: (e.air_date as string) ?? null,
        runtime: e.runtime == null ? null : Number(e.runtime),
        still: typeof e.still_local === 'string' ? `/images/${e.still_local}` : null,
        // 同上：安全模式 blur 档只吃模糊图，悬停也不解模糊
        stillBlur: typeof e.still_local === 'string'
          ? `/images/${blurPath(e.still_local)}`
          : null,
        overview: (e.overview as string) ?? null,
        /* §114：中文译文（⛔ 与 overview 分开返回，前端自己决定用哪个 ——
           这样「TMDB 原文」与「我们翻的」在接口层就能区分，不会被误当成原文） */
        overviewZh: (e.overview_zh as string) ?? null,
      })),
      alignment,
      /* ⭐ §87：逐集对照用的「源站条目 ⇄ 下载链接」对账数（分母现算，⛔ 不认缓存） */
      dlSource,
      /* ⭐ §108：vid → {标签, 封面}（key = hanime 条目的 id）
         ⛔ 只含本次涉及的 vid；不在表里的 vid 就是「没抓到」，前端不画 */
      videoMeta,
      /* ⭐ §115：逐集体积/画质对照（key = `season-episode`） */
      media,
      mediaSnapshotAt: mediaAt,
      local: {
        hasWork: localEps.length > 0,
        source: 'emby' as const,
        ready: embyReady,
        episodes: localEps.map((l) => ({
          season: l.season == null ? null : Number(l.season),
          episode: l.episode == null ? null : Number(l.episode),
          /* ⚠️ 字段名仍叫 fileName 是为兼容前端（原来放本地文件名）；
             现在放的是 Emby 里那条 strm 的完整路径。 */
          fileName: l.file_name ?? null,
        })),
      },
      // §69 ⑥：被季级屏蔽掉的季号（已按升序；空数组 = 没屏任何季）
      hiddenSeasons: [...hiddenSeasons].sort((a, b) => a - b),
      // §74：被**集级**排除的集（已按季/集升序；空数组 = 没排除任何集）
      hiddenEpisodes: hiddenEpisodeRows.sort(
        (a, b) => a.season - b.season || a.episode - b.episode,
      ),
      evidence: {
        workOrigin: (w.work_origin as string) ?? null,
        discoverySources: (w.discovery_srcs as string) ?? null,
        note: (w.evidence_note as string) ?? null,
        detail: evDetail,
        sources,
        // ⭐ 六因子自动核对（2026-10-16）。
        //    用户要求「除了年份标题还有什么决定性因素都要展示清楚」——
        //    这些因子数据全在库里，能自动判的就不该让人眼去比。
        //    ⚠️ 它只核对「数据之间是否矛盾」，**不判断是不是同一部作品**。
        crossCheck: crossCheck(
          sources,
          w.year == null ? null : Number(w.year),
          Number(w.episode_total ?? 0),
          (w.genres as string) ?? null,
          mediaType,
          // ⭐ 0da：分集 air_date 的年份集合（源年落在集合内 ⇒ 逐集配信年，非错配）
          [...new Set(
            eps
              .map((e) => e.air_date)
              .filter((d): d is string => typeof d === 'string' && d.length >= 4)
              .map((d) => Number(d.slice(0, 4)))
              .filter((y) => Number.isFinite(y)),
          )].sort((a, b) => a - b),
          // ⭐ 0el（2026-10-24）：对齐层实测的「有源集数」——
          //   「集数」因子的分子要靠它，否则纯 mteam 作品会被误判 bad。
          alignment.summary.withSource,
          // ⭐ 0el：源条目总数（展开后，含 extra）—— 最完整的分子候选
          alignment.summary.sourceItems,
        ),
      },
    };
  }

  /** 一次性导出看板全量数据（单文件看板用，避免 N 次请求） */
  exportAll(): { stats: BoardStats; years: YearBucket[]; works: WorkBrief[] } {
    return {
      stats: this.stats(),
      years: this.byYear(),
      works: this.allWorks(),
    };
  }
}

/**
 * 原图相对路径 → 模糊图相对路径。
 * `poster/tv/123.jpg`  → `poster_blur/tv/123.jpg`
 * `still/tv/1_1_1.jpg` → `still_blur/tv/1_1_1.jpg`
 *
 * ⚠️ 只替换**首段**目录名，文件名里的 poster/still 字样不能动。
 */
function blurPath(rel: string): string {
  return rel.replace(/^(poster|still)\//, (_m, d: string) => `${d}_blur/`);
}

function mapWork(r: Record<string, unknown>): WorkBrief {
  const mediaType = (r.media_type as 'tv' | 'movie') ?? 'tv';
  const posterLocal = typeof r.poster_local === 'string' ? r.poster_local : null;
  const { kinds, badge } = srcBadgeOf(r.srcs);
  return {
    id: Number(r.id),
    mediaType,
    nameOriginal: (r.name_original as string) ?? null,
    nameZh: (r.name_zh as string) ?? null,
    year: r.year == null ? null : Number(r.year),
    firstAirDate: (r.first_air_date as string) ?? null,
    episodeTotal: Number(r.episode_total ?? 0),
    seasonCount: Number(r.season_count ?? 0),
    popularity: r.popularity == null ? null : Number(r.popularity),
    sourceChannel: (r.source_channel as string) ?? 'keyword',
    /* 🔴🔴 §107（2026-10-31）：**作品级**简介（tmdb_work.overview）。
       作者报「看板好多提示 TMDB 无简介，但我去看是有的」⇒ 根因是
       老代码只存了**集级** overview，而这批作品的集级在 TMDB 上真的是空的
       （实测 #103258 作品级 274 字中文，集级 3 集全空）。
       ⚠️ 这里返回 null 表示「TMDB 上确实没简介」，⛔ 不编、不回落成「没有」。 */
    overview: (r.overview as string) ?? null,
    // 库里存的是 poster/{type}/{id}.jpg，对外暴露 /images/poster/{type}/{id}.jpg
    posterLocal: posterLocal ? `/images/${posterLocal}` : null,
    posterBlur: posterLocal ? `/images/${blurPath(posterLocal)}` : null,
    srcKinds: kinds,
    srcBadge: badge,
    // ⭐ 全集入库（2026-10-27 §71）：NULL = 还没同步过 ⇒ 前端不画入库标（0cs）
    embyEps: r.emby_eps == null ? null : Number(r.emby_eps),
    embyNeed: r.emby_need == null ? null : Number(r.emby_need),
    embyFull: (() => {
      // ⭐ §73：人工确认 ≡ 判定通过（作者：「效果和 ai 识别无问题的效果一样」）
      if (Number(r.emby_verified ?? 0) === 1) return true;
      const need = r.emby_need == null ? null : Number(r.emby_need);
      const have = r.emby_eps == null ? null : Number(r.emby_eps);
      return need != null && have != null && need > 0 && have >= need;
    })(),
    embyVerified: Number(r.emby_verified ?? 0) === 1,
    /* §74：被**集级**排除的集数（0 = 没排除）。只用于 tooltip 说明
       「有效 8 集（已排除 2 集）」，⛔ 不参与 `embyFull` 判定。 */
    embyExcluded: r.emby_excluded == null ? 0 : Number(r.emby_excluded),
    // ⭐ §80 待下：表不存在时 wantCol 恒返 0 ⇒ false（⛔ 不崩）
    wanted: Number(r.wanted ?? 0) === 1,
    /* §151：默认空 —— 纯映射函数里不查库（每部一条 SQL 会拖垮海报墙）。
       真正的命中由 `allWorks()` 一次性批量填进去（见该方法）。 */
    tagHits: { l1: [], l2: [], l3: [], l4: [] },
    embyVerifyStale: (() => {
      if (Number(r.emby_verified ?? 0) !== 1) return false;
      const se = r.emby_snap_eps == null ? null : Number(r.emby_snap_eps);
      const sn = r.emby_snap_need == null ? null : Number(r.emby_snap_need);
      const have = r.emby_eps == null ? null : Number(r.emby_eps);
      const need = r.emby_need == null ? null : Number(r.emby_need);
      // 快照未知 ⇒ 不判过期（⛔ 不凭空判断，0cs）
      if (se == null || sn == null || have == null || need == null) return false;
      return se !== have || sn !== need;
    })(),
    // 泡麵番：全部 hanime 源都标泡麵番才算（混合标注的不算，避免误标）
    isPaomian: (() => {
      const hn = r.hn_count == null ? 0 : Number(r.hn_count);
      const pm = r.pm_count == null ? 0 : Number(r.pm_count);
      return hn > 0 && pm === hn;
    })(),
  };
}