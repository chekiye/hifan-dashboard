/**
 * 纯度检测 —— 找出「混进主库的真人剧/商业动画」
 *
 * ⭐ 起因（2026-10-14 18:20，用户反馈）：
 *   看板里出现大量根本不是里番的剧：��国老爹、瑞克和莫蒂、开心汉堡店、
 *   机器鸡、马男波杰克、英雄联盟：双城之战、Love Death & Robots...
 *
 * ⭐ 根因（实测确认，不是猜测）：
 *   v7 的 355 部里有 **264 部 discovery_srcs='tmdb'** —— 意思是
 *   **只有 TMDB 自己收录了它，没有任何片源（hanime/mteam）交叉验证过**。
 *   而 TMDB 的 hentai 关键词（id 198385）会误标大量主流商业动画。
 *
 *   对比：真正靠片源交叉确认的是 'hanime+tmdb'（31部）/ 'hanime+mteam+tmdb'（11部），
 *   这批的热度全部在 60 以下且题材一致。
 *
 * ⭐ 本脚本只做「取证」，不删数据：
 *   逐个拉 TMDB keywords + genres + overview，用多维证据给每条打分，
 *   产出 purity_report.json 供人工复核 —— 删除是破坏性动作，必须人来决定。
 *
 * 用法（容器内）：
 *   node --no-warnings dist/check_purity.js --only-v7
 *   node --no-warnings dist/check_purity.js --dry-run
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { MIGRATIONS } from '@hifan/core';

const DATA = process.env.HIFAN_DATA || '/app/data';
const DB_PATH = process.env.HIFAN_DB || `${DATA}/hifan.db`;
const API_KEY = process.env.TMDB_API_KEY || '';
const PROXY = process.env.TMDB_PROXY || '';
const RATE_MS = 300;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_V7 = args.includes('--only-v7');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || Infinity;

type V = string | number | bigint | null | Uint8Array;
const P = (o: Record<string, V>): Record<string, V> => o;

if (!API_KEY) {
  console.error('[致命] 缺少 TMDB_API_KEY');
  process.exit(1);
}

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS _migration (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT idx FROM _migration').all() as Array<{ idx: number }>).map((r) =>
      Number(r.idx),
    ),
  );
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (applied.has(i)) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO _migration (idx, applied_at) VALUES (?, ?)').run(
        i,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`[schema] migration #${i} 失败：${String(err)}`);
      process.exit(1);
    }
  }
  return db;
}

let agent: unknown = null;
async function getAgent(): Promise<unknown> {
  if (!PROXY) return null;
  if (agent) return agent;
  const undici = (await import('undici')) as unknown as { ProxyAgent: new (p: string) => unknown };
  agent = new undici.ProxyAgent(PROXY);
  return agent;
}

let lastAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastAt + RATE_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
}

async function api(path: string): Promise<Record<string, unknown> | null> {
  const dispatcher = await getAgent();
  const undici = (await import('undici')) as unknown as {
    request: (
      u: string,
      o: Record<string, unknown>,
    ) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;
  };
  await throttle();
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${path}${sep}api_key=${API_KEY}`;
  try {
    const res = await undici.request(url, {
      ...(dispatcher ? { dispatcher } : {}),
      headers: { accept: 'application/json' },
    });
    if (res.statusCode !== 200) return null;
    return JSON.parse(await res.body.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * ⭐ 里番题材词（分强弱两级，2026-10-14 二次校准）
 *
 * 🔴 上一版把 'erotic' / 'sexual' / 'male homosexuality' 和 'hentai' 平级，
 *    结果美式成人动画（Ren&Stimpy / Mating Season）全部拿到「里番加分」。
 *
 * 拆分依据：**日语作品才有的题材词才是硬证据**。
 * erotic / sexual / 18+ 在欧美成人动画里是通用词，只能当弱信号。
 */
const HENTAI_STRONG = [
  'hentai', 'oppai', 'loli', '淫獣', '淫兽', '淫乱', '痴漢', '調教', '凌辱',
  '淫', '情色', '偷情', '痴女', '凌女', '人妻', '熟女',
];

/** 弱信号：成人向但不足以定性，仅小幅加分 */
const HENTAI_WEAK = ['ecchi', 'erotic', 'sexual', '18+', 'porn', 'voyeur', 'femdom', 'bdsm', 'nsfw'];

/** 主流商业动画/真人剧的强特征 —— 命中就扣分 */
const MAINSTREAM_HINTS = [
  'sitcom', 'comedy', 'cartoon network', 'adult swim', 'anime series',
  'kids', 'children', 'family', 'superhero', 'video game',
  'marvel', 'dc comics', 'league of legends', 'wrestling',
  'reality', 'news', 'talk show', 'documentary', 'cooking show',
  // 美式成人动画标志物（BoJack / The Boondocks 一类）
  'adult humor', 'adult swim', 'satire', 'anthropomorphism',
  'hollywood', 'existentialism', 'tv comedies',
];

/**
 * ⭐ 知名商业 IP 片名黑名单（2026-10-14 补）
 *
 * 判据：这些 IP 在**任何里番片源里都不可能出现**，
 * 所以片名命中就是独立的、非启发式的硬证据。
 *
 * ⚠️ 必须是精确的 IP 名，不要写「猫」「狗」这类通用词 ——
 *    里番片名再怪也还是日本语系作品，不会有 League of Legends。
 */
const MAINSTREAM_IP = [
  // 美漫改编
  'league of legends', 'arcane', 'marvel', 'dc comics', 'spider-man',
  'batman', 'superman', 'avengers', 'halloween', 'the boys',
  'invincible', 'arcane',
  // 日漫商业改编（少儿向主流动画）
  'pokemon', 'dragon ball', 'naruto', 'bleach', 'one piece',
  'boruto', 'demon slayer', 'kimetsu', 'my hero academia',
  'black clover', 'jujutsu kaisen', 'chainsaw man', 'one-piece',
  // 特摄 / 游戏改编
  'devil may cry', '仮面ライダー', 'kamen rider', 'godzilla',
  'pokémon', 'ark:', 'overwatch', 'final fantasy', 'genshin',
  'riot games', 'wWE', 'wwe',
  // 美式主流动画长青树
  'rick and morty', 'family guy', 'south park', 'simpsons',
  'bojack', 'futurama', 'american dad', 'archer',
  'rick and morty', 'robot chicken', 'sitting', 'king of the hill',
];

/**
 * ⭐ 第四类非里番信号：**日语商业作品**（特摄 / 少儿向 / 职场喜剧）
 *
 * 上一轮之后剩下的 10 条日语边界条目里，有 3 条确实不是里番：
 *   仮面ライダーウィザード  商业特摄（tokusatsu），标签 henshin heroes / magic ring
 *   夢喰いメリー             魔法少女小圆体系少儿向（标签 slapstick comedy）
 *   アグレッシブ烈子         职场喜剧（标签 anthropomorphism / office / pig）
 *
 * 它们躲过了语言判据（是日语），也躲过了题材词（没有 hentai 强标签）。
 * 但**题材维度**上它们有明确的非里番特征，且**绝不与真里番重叠** ——
 * 真里番不会有 henshin heroes，也不会有 anthropomorphism 动物职场喜剧。
 */
const JP_NON_HENTAI_HINTS = [
  'tokusatsu', 'henshin', 'superhero', 'magical girl', 'shoujo',
  'anthropomorphism', 'anthropomorphic animal', 'office', 'workplace',
  'sitcom', 'kids', 'children', 'school life', 'magical girl friendship',
];
const JP_NON_HENTAI_STRONG = ['tokusatsu', 'henshin', 'anthropomorphism', 'anthropomorphic animal'];

/**
 * ⚠️ genres 的三个陷阱（2026-10-14 二次校准，全部实测踩到）
 *
 * ① 18 成人：TMDB 把「成人向」标成 18，但成人**喜剧**动画（马男波杰克）
 *    也带 18。→ 18 只有在**同时不含 35 喜剧、不含 10759 综艺**时才算加分。
 *
 * ② 10759 动作冒险 / 10765 科幻奇幻：这两个 ID 在 TMDB 是**跨类型通用标签**，
 *    TMDB 给海量日漫乱标（日式里番 吊带袜天使/暴狼/淫兽学园全都带 10759+10765）。
 *    原来的实现把它们当「真人剧」硬证据，直接误杀了 4 部真里番。
 *    → **单条 genres 永远不能定性**，只能与人名/简介交叉。
 *
 * ③ 16+35：美式商业动画与日式里番**都有**（草莓哀歌/地狱客栈都是 16+35）。
 *    → 只能当弱信号，必须叠加片名语言学证据。
 */
function genreBonus(gid: string[]): number {
  const has18 = gid.includes('18');
  if (!has18) return 0;
  if (gid.includes('35')) return 0; // 18 + 喜剧 = 成人喜剧动画，不是里番
  if (gid.includes('10759') || gid.includes('10751')) return 0;
  return 20;
}

/**
 * ⭐ 原创语言判据（本次校准最关键的一条）
 *
 * 用户要的是**日本里番**。而 `name_original` 字段就是 TMDB 记录的原文标题 ——
 * 日语作品一定是假名/汉字/长音符，欧美作品一定是 ASCII 拉丁字母。
 *
 * 这是**不依赖任何关键词**的语言学硬判据，比任何 hints 词表都可靠：
 *   日语 → 夢喰いメリー / 淫獣学園 La Blue Girl / 異種族レビュアーズ
 *   欧美 → Disenchantment / Hazbin Hotel / Peepoodo & The Super Fuck Friends
 *
 * ⚠️ 少数欧美作品也带假名（K-On! 之类），但那必是日漫改编，
 *    不会被标 hentai；反过来**里番不可能是 ASCII 原名**。
 */
function isJapaneseWork(nameOriginal: string | null): boolean {
  const s = String(nameOriginal ?? '').trim();
  if (!s) return false;
  // 平假名 / 片假名 / 日文汉字（々ヶ） / 长音符 / 全角句点
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F\u3005\u30FC]/.test(s);
}

interface Row {
  id: number;
  media_type: string;
  name_zh: string | null;
  name_original: string | null;
  year: number | null;
  popularity: number | null;
  work_origin: string | null;
  discovery_srcs: string | null;
}

interface Verdict {
  id: number;
  mediaType: string;
  name: string;
  /** 原文标题 —— 复核「是不是日语作品」的第一手证据 */
  nameOriginal: string | null;
  /** name_original 是否含日文字符（语言学硬判据） */
  isJapanese: boolean;
  year: number | null;
  popularity: number | null;
  sources: string | null;
  keywords: string[];
  genres: string[];
  overview: string;
  /** 正数 = 里番证据，负数 = 主流作品证据 */
  score: number;
  verdict: 'likely_hentai' | 'suspect' | 'likely_mainstream';
  /** 独立硬证据条数 —— 3 条以上基本可断定，2 条需人工确认 */
  hardEvidence: number;
  reasons: string[];
}

const db = open();
const where: string[] = [];
if (ONLY_V7) where.push(`work_origin = 'v7_merge'`);
const limitSql = Number.isFinite(LIMIT) ? ` LIMIT ${Math.floor(LIMIT)}` : '';

const rows = db
  .prepare(
    `SELECT id, media_type, name_zh, name_original, year, popularity, work_origin, discovery_srcs
     FROM tmdb_work
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY media_type, id${limitSql}`,
  )
  .all(P({})) as unknown as Row[];

console.log(`[范围] ${rows.length} 条${ONLY_V7 ? '（仅 v7 来源）' : ''}${DRY ? '，试运行' : ''}`);
if (!rows.length) {
  db.close();
  process.exit(0);
}

const results: Verdict[] = [];

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const mt = String(r.media_type);
  const base = mt === 'tv' ? `/tv/${r.id}` : `/movie/${r.id}`;

  const [detail, kw] = await Promise.all([
    api(`${base}?language=zh-CN`),
    api(`${base}/keywords`),
  ]);

  const keywords = Array.isArray((kw?.results as Array<{ name: string }> | undefined))
    ? ((kw!.results as Array<{ name: string }>).map((x) => String(x.name).toLowerCase()))
    : [];

  const genres = Array.isArray(detail?.genres)
    ? ((detail!.genres as Array<{ id: number; name: string }>).map((g) => `${g.id}:${g.name}`))
    : Array.isArray(detail?.genre_ids)
      ? ((detail!.genre_ids as number[]).map((g) => String(g)))
      : [];

  const overview = String(detail?.overview ?? '').toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // ⚠️ 简介为空 = 没有信息，**不是**「不是里番」的证据。
  //    实测 47 部被误判的原因就在这：里番小众，TMDB 简介常年空着，
  //    而主流剧一定有简介。空简介必须按「未知」处理，不能进扣分项。
  const hasOverview = overview.trim().length > 20;

  // ① 片源交叉验证：最强信号。
  //    hanime / mteam 是真实片源站，收录本身就是「有人下过在看」的直接证据；
  //    只有 TMDB 自己收录 = 靠 TMDB 的 hentai 关键词猜的，而那个关键词误标了大量商业动画。
  const srcs = String(r.discovery_srcs ?? '');
  const srcCross = /hanime|mteam/.test(srcs);
  if (srcCross) {
    score += 55;
    reasons.push(`片源交叉验证（${srcs}）`);
  } else if (srcs.trim() === 'tmdb') {
    score -= 25;
    reasons.push('仅 TMDB 自行收录，无片源验证');
  }

  // ② TMDB keywords 里的里番标记 —— 强弱分档（见 HENTAI_STRONG / HENTAI_WEAK）
  const kwStrong = keywords.filter((k) => HENTAI_STRONG.some((h) => k.includes(h)));
  const kwWeak = keywords.filter((k) => HENTAI_WEAK.some((h) => k.includes(h)));
  if (kwStrong.length) {
    score += 25;
    reasons.push(`里番强关键词：${kwStrong.join(', ')}`);
  }
  if (kwWeak.length) {
    score += 8;
    reasons.push(`里番弱关键词：${kwWeak.slice(0, 4).join(', ')}`);
  }
  const mainHits = keywords.filter((k) => MAINSTREAM_HINTS.some((h) => k.includes(h)));
  if (mainHits.length) {
    score -= 20;
    reasons.push(`主流作品关键词：${mainHits.join(', ')}`);
  }
  /** 日语作品的非里番题材词（特摄/少儿向/职场喜剧）—— 语言判据失效后的补充维度 */
  const jpNonHits = keywords.filter((k) => JP_NON_HENTAI_HINTS.some((h) => k.includes(h)));
  const jpNonStrong = keywords.filter((k) =>
    JP_NON_HENTAI_STRONG.some((h) => k.includes(h)),
  );
  if (jpNonStrong.length) {
    score -= 20;
    reasons.push(`日语非里番题材词：${jpNonStrong.join(', ')}`);
  }

  // ③ genres —— **单独任何一条都不足以定性**（见 genreBonus 注释里的三个陷阱）
  const gid = genres.map((g) => g.split(':')[0]);
  const g18 = genreBonus(gid);
  if (g18 > 0) {
    score += g18;
    reasons.push('genres 含成人(18) 且无喜剧/综艺 → 成人向可信');
  }
  if (gid.includes('10765') || gid.includes('10759') || gid.includes('10751')) {
    // ⚠️ 10759/10765 是 TMDB 跨类型通用标签，日式里番也大量带
    //    （吊带袜天使/暴狼/淫兽学园 全都带 10759+10765）。
    //    → 只留痕，**不扣分、不作为硬证据**。
    reasons.push('genres 含 10759/10765（TMDB 通用标签，不单独定性）');
  }
  if (gid.includes('16') && gid.includes('35')) {
    score -= 8;
    reasons.push('genres 16动画+35喜剧（弱信号，美式商业动画常见）');
  }

  // ④ overview 文本 —— 只在有简介时才判，空简介一律跳过
  const ovStrong = hasOverview ? HENTAI_STRONG.filter((h) => overview.includes(h)) : [];
  const ovWeak = hasOverview ? HENTAI_WEAK.filter((h) => overview.includes(h)) : [];
  const ovMain = hasOverview ? MAINSTREAM_HINTS.filter((h) => overview.includes(h)) : [];
  if (ovStrong.length) {
    score += 18;
    reasons.push(`简介含里番强特征：${ovStrong.slice(0, 3).join(', ')}`);
  }
  if (ovWeak.length) {
    score += 6;
    reasons.push(`简介含：${ovWeak.slice(0, 3).join(', ')}`);
  }
  if (ovMain.length) {
    score -= 14;
    reasons.push(`简介含主流特征：${ovMain.slice(0, 3).join(', ')}`);
  }
  if (!hasOverview) {
    reasons.push('TMDB 无简介（无信息，不作判据）');
  }

  // ⑤ 热度：主流作品在 TMDB 热度远高于里番。
  //    实测真里番几乎全部 < 60（地味变 63.9、私人诊所 56.2 已属少数），
  //    破百的基本都是家喻户晓的商业作品。
  const pop = Number(r.popularity ?? 0);
  if (pop >= 100) {
    score -= 25;
    reasons.push(`热度 ${pop.toFixed(0)} 异常高（里番极少破 60）`);
  } else if (pop >= 60) {
    score -= 8;
    reasons.push(`热度 ${pop.toFixed(0)} 偏高`);
  }

  // ⚠️ 判「非里番」要求**至少两条独立证据**（阈值见文末 verdict 处）。
  //    单条信号会误伤黑之断章/吊带袜天使这类真里番 ——
  //    它们没有片源收录、TMDB 简介也是空的，但确实是里番。
  //
  // ⭐ 知名商业 IP 直接命中（马男波杰克 / 英雄联盟：双城之战 / Devil May Cry /
  //    假面骑士Wizard）—— 这些名字在任何里番片源里都不可能出现。
  const titleText = (
    String(r.name_zh ?? '') + ' ' + String(r.name_original ?? '')
  ).toLowerCase();
  const ipHit = MAINSTREAM_IP.some((ip) => titleText.includes(ip));
  if (ipHit) {
    score -= 30;
    reasons.push(`片名含知名商业 IP：${ipHit}`);
  }

  /**
   * ⭐⭐ 原创语言判据（本次校准的核心，取代上一版的 WESTERN_ADULT_HINTS）
   *
   * 上一版拿 `adult animation` / `erotic` 当「欧美成人动画」标记词，实测三种误伤：
   *   吊带袜天使 パンティ＆ストッキング   → 误伤（日语作品，也挂 adult animation）
   *   異種族レビュアーズ                    → 误伤（只因命中 erotic）
   *   魔王イブロギアに身を捧げよ            → 误伤（只因命中 erotic）
   * 根因：`adult animation` 是 TMDB 对**成人向动画的通用标签**，日式 ecchi 一样挂；
   *       `erotic` 更是全球通用词。
   *
   * → 改用**语言学硬判据**：`name_original` 是否含日文字符。
   *    用户要的是**日本里番**，而里番一定是日语作品 →
   *    「原名是纯拉丁字母」就是最强的非里番证据。
   */
  const isJP = isJapaneseWork(r.name_original);
  const jpThemeHit = kwStrong.length > 0 || ovStrong.length > 0;
  const noJpEvidence = !isJP && !jpThemeHit;
  if (noJpEvidence) {
    score -= 25;
    reasons.push(`原名为非日语（${r.name_original}）且无任何日语题材词`);
  } else if (isJP) {
    reasons.push(`原名为日语作品（${r.name_original}）`);
  }

  /**
   * 🔴 硬证据只统计**指向非里番**的信号（2026-10-14 反向误伤教训）
   *
   * 上一版把片源交叉验证算 3 条硬证据，结果判反了：
   * 有片源验证的条目 hardEvidence 恒 ≥3，而 verdict 又**先判 hardEvidence**，
   * → 75 部明确带 hanime/mteam 的日语里番全被判成「疑似主流」
   *   （異世界ヤリサー / 妻ネトリ / 最終痴漢電車 / 魔将の贄3 / 異種族レビュアーズ…）
   *
   * 片源交叉验证是**正向证据**，只能加分，绝不能计入「非里番」证据。
   */
  const hardEvidence =
    (mainHits.length > 0 ? 1 : 0) +
    (pop >= 100 ? 1 : 0) +
    (gid.includes('16') && gid.includes('35') ? 1 : 0) +
    (ipHit ? 1 : 0) +
    (noJpEvidence ? 1 : 0) +
    // ⭐ 日语作品专用：特摄/少儿向/职场喜剧题材词与真里番**零重叠**，
    //   所以它可以作为日语作品的独立硬证据（语言判据在这里失效了）
    (jpNonStrong.length > 0 ? 1 : 0);

  /**
   * ⭐⭐ 判定阈值（四轮实测校准）
   *
   * 一轮：关键词版 → 误伤 15 部真里番（拿 adult animation / erotic 当地域判据）
   * 二轮：语言判据 + 片源加权 → **反向误伤 75 部**（片源算成硬证据）
   * 三轮：必要条件 + hardEvidence≥3 → 隔离干净，但**留下 103 条边界**
   * 四轮：**按原名语言分档**（当前实现）
   *
   * 三轮的问题：用户看到看板还有 93 部欧美动画没清掉。
   * 原因是把「原名非日语的 93 条」和「原名日语的 10 条」混在一起，
   * 全都按 hardEvidence≥2 的保守线放行 → 但这两类的**可信度完全不同**：
   *
   *   原名非日语（93 条）：语言判据**已足够定性**。
   *     里番一定是日语作品，这是零例外规律。
   *     实测逐条核对：Blue Bloods / Disenchantment / The Boondocks /
   *     Happy Tree Friends / Central Park / Krapopolis / Free! …
   *     **无一例外全是欧美商业动画或真人剧**，零误伤。
   *     → 硬证据降到 2 条即可隔离。
   *
   *   原名日语（10 条）：语言判据**失效**，必须逐条人工判断。
   *     实测这 10 条里 7 部是真里番（带 hentai 标签）：
   *       漾出 / 家庭餐厅战士布丁 / 红莲 / 胸部王者48 / 妈妈候补！？ /
   *       像色情漫画一样的恋爱吧 / 变成黑皮辣妹后和朋友做了
   *     另 3 部确实不是里番（但都是日语商业作品）：
   *       假面骑士Wizard（tokusatsu 商业特摄）
   *       食梦者玛莉（.Looking for Magical Doremi 体系少儿向）
   *       职场小烈（Aggressive Retsuko，职场喜剧）
   *     → 一律**不自动隔离**，进 review_queue 由人判。
   *
   * ⭐ 教训延续上一轮：**必要条件不能靠加权抵消**。
   *   区别在于日语作品连「必要条件」都不成立，此时必须交人。
   */
  const isBorderlineNonJp = noJpEvidence && hardEvidence >= 2;
  /**
   * 日语作品的独立通道：语言判据失效，只能靠题材词。
   * 阈值 3 条（比非日语多一条）—— 实测 7 部真里番（漾出/红莲/胸部王者48…）
   * 拿到 2 条，唯一 3 条的那部是真里番时要靠人工豁免兜底。
   */
  const isJpCommercial = !noJpEvidence && jpNonStrong.length > 0 && hardEvidence >= 3;
  const verdict: Verdict['verdict'] =
    isBorderlineNonJp
      ? 'likely_mainstream'
      : isJpCommercial
        ? 'likely_mainstream'
        : score >= 20
          ? 'likely_hentai'
          : 'suspect';

  results.push({
    id: r.id,
    mediaType: mt,
    name: String(r.name_zh ?? r.name_original ?? ''),
    nameOriginal: r.name_original,
    isJapanese: isJP,
    year: r.year,
    popularity: pop,
    sources: srcs,
    keywords,
    genres,
    overview: String(detail?.overview ?? '').slice(0, 240),
    score,
    verdict,
    hardEvidence,
    reasons,
  });

  if ((i + 1) % 20 === 0) {
    const nMain = results.filter((x) => x.verdict === 'likely_mainstream').length;
    console.log(`  [进度] ${i + 1}/${rows.length}  疑似主流 ${nMain}`);
  }
}

const order = { likely_mainstream: 0, suspect: 1, likely_hentai: 2 } as const;
results.sort((a, b) => order[a.verdict] - order[b.verdict] || a.score - b.score);

const main = results.filter((r) => r.verdict === 'likely_mainstream');
const suspect = results.filter((r) => r.verdict === 'suspect');
const ok = results.filter((r) => r.verdict === 'likely_hentai');

/**
 * 已隔离的 id —— 写进报告供 build_review_board 跳过，避免同一条既隔离又进待办。
 * ⚠️ 必须在 db.close() 之前查。
 */
const quarantinedIds = main
  .map((m) => Number(m.id))
  .filter((id) => {
    const r = db.prepare(`SELECT is_quarantined q FROM tmdb_work WHERE id = $id`).get(
      P({ $id: id }),
    ) as { q: number | null } | undefined;
    return Number(r?.q ?? 0) === 1;
  });

db.close();

/** 边界条目：2 条硬证据，卡在阈值线下，交给人工而不是算法拍板 */
const borderline = suspect.filter((r) => r.hardEvidence === 2);

console.log('\n[判定汇总]');
console.log(`  ✅ 判定为里番      ${ok.length}`);
console.log(`  ⚠️ 待人工确认      ${suspect.length}（其中硬证据 2 条的边界条目 ${borderline.length}）`);
console.log(`  ❌ 疑似主流非里番  ${main.length}（≥3 条硬证据）`);

if (main.length) {
  console.log('\n[疑似主流作品（建议移出主看板）]');
  for (const m of main.slice(0, 60)) {
    console.log(
      `  ${m.id} ${String(m.year)} pop=${m.popularity?.toFixed(0)} 「${m.name}」` +
        ` [${m.nameOriginal}] HE=${m.hardEvidence} score=${m.score}`,
    );
  }
}
if (borderline.length) {
  console.log('\n[边界条目 —— 2 条硬证据，算法不敢定，留人工]');
  for (const b of borderline.slice(0, 40)) {
    console.log(
      `  ${b.id} ${String(b.year)} pop=${b.popularity?.toFixed(0)} 「${b.name}」[${b.nameOriginal}]`,
    );
  }
}

const out = `${DATA}/purity_report.json`;
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      total: results.length,
      counts: {
        likely_hentai: ok.length,
        suspect: suspect.length,
        likely_mainstream: main.length,
        /** 疑似主流里已在隔离池中的 id —— 生成审核看板时要跳过 */
        quarantined: quarantinedIds,
      },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n[输出] ${out}`);