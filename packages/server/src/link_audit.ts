/**
 * ⭐ §86（2026-10-30）**链接覆盖对账** —— 回答「后期抓的剧集和链接是不是真的落地了」
 *
 * ## 🔴 为什么需要这个模块（这是蛙哥的核心诉求）
 *
 * 蛙哥原话（2026-10-30）：
 * > 「hanime 还是一直在更新的，所以 hanime 的剧集和下载链接后期还需要继续抓，
 * >   我需要确定后期抓的剧集和下载链接是真的落地到看板」
 *
 * ⇒ 光「把链接挂在剧集旁边」不够，还要能**验收**：
 *   1. **分母对不对** —— 源站（hanime）到底收录了多少集？链接表里有多少条？
 *   2. **缺口在哪** —— 哪几个 vid 没有链接？（不是「全部都在」就万事大吉）
 *   3. **新鲜度** —— 最后一次抓链接是什么时候？最近这轮新增了多少条？
 *   4. **可用性** —— 有多少条签名已经过期（明天 05:01 集体过期）？
 *
 * ## 🔴🔴 关键设计：分母从 `source_work.entry_detail` 现算，⛔ 不另存一份
 *
 * 源侧 vid 的**唯一事实源**是 `source_work.entry_detail`（§79 的续更落库会往里加条目）。
 * ⇒ 「源侧有多少集」必须现算，不能信任何缓存数字。
 * ⇒ 链接表 `source_link` 与源侧按 **vid** JOIN（0lx 铁律：⛔ 不另写第二份集号解析）。
 *
 * ## ⛔ 口径必须讲出来（0cs 铁律：接口缺字段要兜底说明，别让人猜）
 * - `srcTotal` = 源侧 entry_detail 里**有 vid 的条目数**（去重后）
 * - `linked` = 其中能在 `source_link` 里找到链接的
 * - `missing` = 源侧有、链接表没有 ⇒ **真缺口**
 * - `orphans` = 链接表有、源侧没有 ⇒ 孤儿（源站删了/换 vid 重发）
 * - `expired` = 链接表的 `expires_at` 已过 ⇒ 明天集体过期就是这个数
 * - `noExpiry` = 没有 `expires_at` ⇒ 不知道会不会过期
 */
import type { DB } from '@hifan/core';

export interface LinkAuditSummary {
  /** 源侧（hanime entry_detail）去重后的 vid 数 —— 覆盖率分母 */
  srcTotal: number;
  /** 其中已有链接的 */
  linked: number;
  /** 源侧有、链接表没有 ⇒ 真缺口 */
  missing: number;
  /** 覆盖率 0~1 */
  coverage: number;
  /** 链接表总条数（可能 > srcTotal，因为有孤儿） */
  linkRows: number;
  /** 链接表里有、源侧没有的孤儿数 */
  orphans: number;
  /**
   * 🔴 §89 新增：**真能下的**条数（源侧有 + 有链接 + 不是 m3u8 + 不是 youjizz）
   *
   * 为什么必须单列：`linked` 只回答「链接表里有没有这一条」，
   * 但 youjizz 的 165 条**必然下不动**（域名被污染 + 470 鉴权），
   * 拿它算覆盖率 ⇒ 看板报 99.9%，实际点下载一片失败 = **自证指标**。
   */
  downloadable: number;
  /** 有链接但下不动的（m3u8 / youjizz）⇒ 覆盖率的「水分」在这里 */
  undownloadable: number;
  /** 真可下载覆盖率 0~1（downloadable / srcTotal） */
  coverageDownloadable: number;
  /** 按不可下原因拆开（给前端解释「为什么少了这些」） */
  undownloadableBy: { youjizz: number; m3u8: number; other: number };
  /** 签名已过期 */
  expired: number;
  /** 签名 2 小时内到期（预警） */
  expiringSoon: number;
  /**
   * ⭐ §89：**最早那一批还有多少分钟过期**（-1 = 全都没写 expires_at）
   *
   * 🔴 hembed 的签名 TTL 只有 ~11 小时，而且 3548 条是**同一批抓的**
   *    ⇒ 它们会在同一分钟集体失效。看板必须能喊出「还有 90 分钟全过期」，
   *    而不是等过期了才显示一片红。
   */
  expireInMin: number;
  /** 没有 expires_at（不知道会不会过期） */
  noExpiry: number;
  /** m3u8（本轮不支持下载） */
  m3u8: number;
  /** 最早一次抓取时间（ISO） */
  firstFetchedAt: string | null;
  /** 最后一次抓取时间（ISO） */
  lastFetchedAt: string | null;
  /** 抓取天数（distinct 日期数） */
  fetchDays: number;
}

export interface LinkAuditMissing {
  vid: string;
  /** 源站标题（entry_detail 里的） */
  title: string | null;
  /** 所属作品在看板上的 tmdb_id（可为空 = 还没匹配上） */
  workId: number | null;
  /** 源站作品标题 */
  workTitle: string | null;
}

export interface LinkAuditResult {
  summary: LinkAuditSummary;
  /** 缺链接的 vid（限量返回，前端分页/筛选） */
  missing: LinkAuditMissing[];
  /** 孤儿链接的 vid */
  orphans: string[];
  /** 按天统计的抓取条数（时间线） */
  timeline: Array<{ day: string; n: number }>;
  /** 抓取时刻的明细（最近 N 次） */
  recentFetches: Array<{ vid: string; fetchedAt: string; quality: number | null }>;
}

/**
 * ⭐ 把 `fetched_at` 解析成可比较的时间戳（毫秒）。
 *
 * 🔴🔴 为什么要这个函数（2026-10-30 实测踩到）：
 *   线上 `source_link.fetched_at` **混了两种时区格式**：
 *     · 3541 条 = `2026-10-29T17:21:13.077379`（本地时间，**无时区标识**）
 *     ·    7 条 = `2026-10-29T11:39:50.470Z`（UTC，带 Z）
 *   ⇒ **字符串排序会把首末算反**（"2026-10-29T1..." < "2026-10-29T1..." 但 Z 版实际更早）
 *   ⇒ 实测「首次抓取」显示得比「上次抓链接」还晚。
 *
 * 🔴 修法（读取端加固，⛔ 不改历史数据）：
 *   - 带 Z / 有偏移 ⇒ 按 UTC 解析
 *   - 无时区标识 ⇒ 当作**本地时间**解析（与写入方的 `datetime.now()` 一致）
 *   ⇒ 两种格式混排也能排出正确的先后
 */
function tsOf(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // 无时区标识的 ISO（`2026-10-29T17:21:13.077379`）—— Date.parse 在部分实现里会当成 UTC
  // ⇒ 补一个本地偏移再解析
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s.trim());
  if (m) {
    const t2 = new Date(m[1]).getTime();
    if (!Number.isNaN(t2)) return t2;
  }
  return 0;
}

/** 取源侧全部 vid（去重）+ 每个 vid 的上下文 */
interface SrcVidRow {
  vid: string;
  title: string | null;
  work_id: number | null;
  work_title: string | null;
}

function loadSourceVids(db: DB): SrcVidRow[] {
  // ⛔ 用 json_each 展平 entry_detail（SQLite 内建 JSON1，线上已验证可用）
  // 🔴 关联 work_id：source_work.work_id → tmdb_work.id（0da：别用 tmdb_id 列名）
  const rows = db
    .prepare(
      `SELECT sw.id AS sw_id, sw.work_id, sw.title AS work_title, sw.entry_detail
         FROM source_work sw
        WHERE sw.src = 'hanime' AND sw.entry_detail IS NOT NULL AND sw.entry_detail != ''`,
    )
    .all() as Array<{
    sw_id: number;
    work_id: number | null;
    work_title: string | null;
    entry_detail: string | null;
  }>;

  const out: SrcVidRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let details: Array<Record<string, unknown>> = [];
    try {
      details = r.entry_detail ? (JSON.parse(r.entry_detail) as Array<Record<string, unknown>>) : [];
    } catch {
      details = [];
    }
    for (const d of details) {
      const vid = d.vid != null ? String(d.vid) : '';
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      out.push({
        vid,
        title: d.title != null ? String(d.title) : null,
        work_id: r.work_id,
        work_title: r.work_title,
      });
    }
  }
  return out;
}

/**
 * ⭐ 对账主函数。
 *
 * @param missingLimit 缺口清单最多返回多少条（⛔ 别一次吐几千条）
 */
export function auditLinks(db: DB, missingLimit = 200): LinkAuditResult {
  const src = loadSourceVids(db);
  const srcVids = new Set(src.map((r) => r.vid));

  // 链接表全量（3548 条量级，一次读进内存完全 OK）
  const links = db
    .prepare(
      `SELECT vid, url, quality, src_kind, is_m3u8, expires_at, fetched_at
         FROM source_link`,
    )
    .all() as Array<{
    vid: string;
    url: string;
    quality: number | null;
    src_kind: string | null;
    is_m3u8: number | null;
    expires_at: number | null;
    fetched_at: string | null;
  }>;

  const nowSec = Math.floor(Date.now() / 1000);
  const linkByVid = new Map<string, (typeof links)[number]>();
  const orphanList: string[] = [];
  let expired = 0;
  let expiringSoon = 0;
  let noExpiry = 0;
  let m3u8 = 0;
  /* ⭐ §89：可下载性分桶 —— 覆盖率必须按「真能下」算，不能按「表里有」算 */
  const und: { youjizz: number; m3u8: number; other: number } = { youjizz: 0, m3u8: 0, other: 0 };
  /** 最早过期时刻（秒），用来喊「还有 N 分钟集体过期」 */
  let earliestExp: number | null = null;

  for (const l of links) {
    const vid = String(l.vid);
    linkByVid.set(vid, l);
    if (!srcVids.has(vid)) orphanList.push(vid);
    if (Number(l.is_m3u8) === 1) m3u8++;
    if (l.expires_at == null) {
      noExpiry++;
    } else {
      if (l.expires_at <= nowSec) expired++;
      else if (l.expires_at <= nowSec + 7200) expiringSoon++;
      if (earliestExp == null || l.expires_at < earliestExp) earliestExp = l.expires_at;
    }
    /* 不可下载分桶（互斥、优先级：m3u8 > youjizz）
       🔴 youjizz 为什么算不可下：域名被污染，容器直连必 ECONNRESET；
          走代理也只有 ~300KB/s 或直接 470 ⇒ 不能计入可下载覆盖率。 */
    if (Number(l.is_m3u8) === 1) und.m3u8++;
    else if (String(l.src_kind ?? '') === 'youjizz') und.youjizz++;
  }

  // 缺口 = 源侧有、链接表没有
  const missingRows: LinkAuditMissing[] = [];
  let linked = 0;
  let downloadable = 0;
  for (const s of src) {
    const l = linkByVid.get(s.vid);
    if (l) {
      linked++;
      /* 🔴 §89：有链接 ≠ 能下。m3u8 / youjizz 单独刨掉，否则覆盖率是假的 */
      const notDl = Number(l.is_m3u8) === 1 || String(l.src_kind ?? '') === 'youjizz';
      if (!notDl) downloadable++;
    } else {
      missingRows.push({
        vid: s.vid,
        title: s.title,
        workId: s.work_id,
        workTitle: s.work_title,
      });
    }
  }

  // 抓取时间线（按天）
  // 🔴 用 tsOf 换算成本地日期 ⇒ 混时区格式也不会把同一天算成两天
  const dayMap = new Map<string, number>();
  for (const l of links) {
    const t = tsOf(l.fetched_at);
    if (!t) continue;
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }
  const timeline = [...dayMap.entries()]
    .map(([day, n]) => ({ day, n }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const recentFetches = [...links]
    .sort((a, b) => tsOf(b.fetched_at) - tsOf(a.fetched_at))
    .slice(0, 50)
    .map((l) => ({ vid: String(l.vid), fetchedAt: l.fetched_at ?? '', quality: l.quality }));

  // 🔴 首末抓取时间 —— 按**解析后的时间戳**排（⛔ 不能字符串排，见 tsOf 的注释）
  const times = links.map((l) => ({ s: l.fetched_at ?? '', t: tsOf(l.fetched_at) })).filter((x) => x.t > 0);
  times.sort((a, b) => a.t - b.t);
  const srcTotal = src.length;
  const summary: LinkAuditSummary = {
    srcTotal,
    linked,
    missing: srcTotal - linked,
    coverage: srcTotal > 0 ? Math.round((linked / srcTotal) * 10000) / 10000 : 0,
    linkRows: links.length,
    orphans: orphanList.length,
    downloadable,
    undownloadable: und.youjizz + und.m3u8 + und.other,
    coverageDownloadable: srcTotal > 0 ? Math.round((downloadable / srcTotal) * 10000) / 10000 : 0,
    undownloadableBy: und,
    expired,
    expiringSoon,
    /* -1 = 没有一条写过 expires_at（老 youjizz 那批就是这样） */
    expireInMin: earliestExp == null ? -1 : Math.round((earliestExp - nowSec) / 60),
    noExpiry,
    m3u8,
    firstFetchedAt: times.length ? times[0].s : null,
    lastFetchedAt: times.length ? times[times.length - 1].s : null,
    fetchDays: dayMap.size,
  };

  return {
    summary,
    missing: missingRows.slice(0, missingLimit),
    orphans: orphanList.slice(0, missingLimit),
    timeline,
    recentFetches,
  };
}
