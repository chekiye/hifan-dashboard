/**
 * ⭐⭐ §135（2026-11-02）mteam 本地视频作为「可选来源」—— 取文件、选文件、配字幕
 *
 * ## 蛙哥需求原话
 * 「新增一个指定集数，比如我第一集打算从 hanime 下，第二集打算直接调取
 *   mteam 的本地视频，就是可以给我手动选择，哪一集我想要哪个资源，
 *   然后新增一个下载按钮，我选好之后点击下载，就可以走完下载，改名，刮削，入库」
 *
 * ## 🔴 核心事实：mteam 那一条**不需要下载**
 * mteam 全量库的宿主目录是 `/本地下载盘/mteam里番全量库`，
 * 而 compose 已经挂了 `/本地下载盘:/downloads`
 * ⇒ 容器内就是 `/downloads/mteam里番全量库/<相对路径>`，**直接可读，0 秒**。
 * ⇒ 「选 mteam」= 直接把刮削的 srcPath 指过去，走同一条
 *    `IngestWorker → Scraper.ingest() → CMS → Emby` 链路。
 *    hanime 那条才真的要进下载队列。
 *
 * ## ⛔ 为什么数据源是 `ep_media.mt_files` 而不是 `data/mt_disk_matched.json`
 * - `ep_media` 是**线上库自己的表**（看板详情页那三块数据就来自它），
 *   随 `sync_ep_media.py` 更新，容器内 `/app/data/hifan.db` 直接查得到；
 * - json 文件得另外上传、还会跟库不同步（0r139：两份事实不许合并，也不许各说各话）。
 * - `mt_files` 里已经是 `{name,size,w,h,codec,mbps,sec,path}`，
 *   **path 就是相对 MT_ROOT 的路径** ⇒ 拼一下就是容器内绝对路径。
 *
 * ## 🔴 语言标记只在**文件名**里（实测 2026-11-02，200 个多文件集）
 * `sync_ep_media` 没搬 `lang` 字段，但三种写法都真实存在：
 *   `xxx.chs.mp4` / `xxx_cht.mp4` / `[魔人] ○○交配 前編.mkv`（裸名=原版）/ `～-raw [FWD-0051].mkv`
 * 实测 200 个多文件集里 84 个带语言标记、30 个是「同基名仅格式不同」。
 * ⇒ 排序权重 CHS > CHT > 裸名 > RAW（蛙哥 11-02 确认「语言优先度没问题」）。
 *
 * ## ⚠️ 多文件 ≠ 多语言（必须知道，否则选错会张冠李戴）
 * 另有相当一部分多文件是**同一番号装了多巻**（`第一章/第二章`、`D1-1/D1-2`），
 * 那是集位错位，两个文件**内容不同集**。这种只能靠人工选，机器不可猜
 * ⇒ 前端在选择器上标 ⚠，选了就等于人工确认。
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import type { DB } from '@hifan/core';
import { loadZip, findZipEntry } from './mt_zip.js';

/** 容器内 mteam 全量库根（compose: /下载盘/.../hanime里番下载:/downloads） */
export const MT_ROOT_DEFAULT = '/downloads/mteam里番全量库';

/** 视频扩展名（与 build_mt_disk_index.py 的 find 口径一致） */
export const MT_VIDEO_EXT = [
  '.mp4', '.mkv', '.avi', '.wmv', '.rmvb', '.rm', '.mov', '.ts',
  '.m2ts', '.flv', '.webm', '.mpg', '.mpeg', '.m4v',
];

/** 字幕扩展名（实测 mteam 库里 2154 个：ass 1814 / ssa 257 / srt 77 / sub 4 / idx 2） */
export const MT_SUB_EXT = ['.ass', '.ssa', '.srt', '.sub', '.vtt'];

/** 语言档：数字越小越优先 */
export type MtLang = 'chs' | 'cht' | 'plain' | 'raw';

export interface MtFile {
  name: string;
  size: number;
  w: number | null;
  h: number | null;
  codec: string | null;
  mbps: number | null;
  sec: number | null;
  /** 相对 MT_ROOT 的路径（ep_media.mt_files[].path 原样） */
  path: string;
  /** 容器内绝对路径 */
  abs: string;
  /** 从文件名解析出的语言档 */
  lang: MtLang;
  /** 同目录下配到的字幕（容器内绝对路径）；null = 这集没有外挂字幕 */
  sub: string | null;
  /** 字幕是「同基名精确命中」/「剥语言标记后命中」/「在月度合集 Subs.zip 里」——排查用 */
  subHow: 'exact' | 'norm' | 'zip' | null;
}

/** mteam 库根目录（可用 MT_ROOT 覆盖，方便换盘） */
export function mtRoot(env: NodeJS.ProcessEnv = process.env): string {
  const v = String(env.MT_ROOT ?? '').trim();
  return v || MT_ROOT_DEFAULT;
}

/**
 * 从文件名判语言档。
 *
 * 🔴 只在**词边界**上认，⛔ 不能裸 includes('chs')：
 *    番号、社团名里出现 chs 三个字母的概率不低，误判会把 RAW 排到 CHS 前面。
 */
export function mtLangOf(name: string): MtLang {
  const stem = name.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  /* 词边界 = 前面是 . _ - 空格 [ ( ，后面是 . _ - 空格 ] ) 或结尾 */
  const hit = (w: string) =>
    new RegExp(`(?:^|[._\\-\\s\\[(])${w}(?=$|[._\\-\\s\\])])`, 'i').test(stem);
  if (hit('chs') || hit('sc') || hit('简')) return 'chs';
  if (hit('cht') || hit('tc') || hit('繁')) return 'cht';
  /* `～瞳裸外伝～-C [FWD-0051]` —— mteam 的 -C 就是中文字幕版（实测样例） */
  if (/(?:^|[\s[\]])-[Cc](?=$|[\s\]])/.test(stem)) return 'chs';
  if (hit('raw') || hit('jpn')) return 'raw';
  return 'plain';
}

const LANG_RANK: Record<MtLang, number> = { chs: 0, cht: 1, plain: 2, raw: 3 };

/** 剥掉文件名尾部的语言/来源标记（用于字幕配视频、以及并排对比） */
export function stripLangSuffix(stem: string): string {
  let b = stem;
  for (let i = 0; i < 4; i++) {
    const n = b.replace(
      /[._\-\s]+(chs|cht|sc|tc|raw|jpn|jp|chi|zh|eng|en|简|繁|简体|繁体)$/i,
      '',
    );
    if (n === b) break;
    b = n;
  }
  return b;
}

/**
 * 排序：语言档 → 分辨率 → 码率 → 体积。
 *
 * ⛔ 不丢任何文件：用户可能就是要选那个「分辨率低但带内嵌字幕」的版本。
 */
export function rankMtFiles(files: MtFile[]): MtFile[] {
  return [...files].sort((a, b) => {
    const r = LANG_RANK[a.lang] - LANG_RANK[b.lang];
    if (r) return r;
    if ((b.h ?? 0) !== (a.h ?? 0)) return (b.h ?? 0) - (a.h ?? 0);
    if ((b.mbps ?? 0) !== (a.mbps ?? 0)) return (b.mbps ?? 0) - (a.mbps ?? 0);
    return (b.size ?? 0) - (a.size ?? 0);
  });
}

/**
 * 同目录下这一集配到的字幕（读一次目录，按基名匹配）。
 *
 * 🔴 实测依据（2026-11-02 NAS 全量扫描）：mteam 库 3590 视频 / 2154 字幕，
 *    其中 **2080 个是「和视频同名同目录」的裸 .ass**，对不上的只有 70 个
 *    （全在补丁目录、对应 0 字节假视频）。所以「同基名命中」就是主路径，
 *    剥语言标记那条是给 `xxx.chs.mp4` ← `xxx.ass` 这种情况兜底的。
 *
 * 🔴🔴 §136（2026-11-02）：**月度合集目录的字幕不在同目录，在 `Subs.zip` 里**。
 *    实测：`Hentai/` 树下有 2148 个散落字幕，但 `2026年XX月合集/` 这 9 个目录里
 *    视频 246 个、**散落字幕 0 个**，字幕全打包在每月一个 `Subs.zip`（14~22 条）。
 *    ⇒ 只扫同目录的话，合集目录的集**永远没字幕**。
 *    ⇒ 这里补上：同目录没找到 ⇒ 去**视频所在月度包的 `Subs.zip`** 里找。
 */
export async function findSubtitleFor(
  videoAbs: string,
): Promise<{ sub: string | null; how: 'exact' | 'norm' | 'zip' | null }> {
  const dir = dirname(videoAbs);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const vBase = basename(videoAbs, extname(videoAbs));
  const vNorm = stripLangSuffix(vBase).toLowerCase();
  const subs = names.filter((n) => MT_SUB_EXT.includes(extname(n).toLowerCase()));

  if (subs.length) {
    /* ① 同基名精确命中（实测 2080/2154 是这种） */
    const exact = subs.find((n) => basename(n, extname(n)).toLowerCase() === vBase.toLowerCase());
    if (exact) return { sub: join(dir, exact), how: 'exact' };

    /* ② 剥掉语言标记后命中（`xxx.chs.mp4` ← `xxx.ass`） */
    const normed = subs.filter((n) => stripLangSuffix(basename(n, extname(n))).toLowerCase() === vNorm);
    if (normed.length) {
      /* 多个候选时同样语言优先：chs > 无标记 > cht > raw */
      const picked = normed.sort((a, b) => LANG_RANK[mtLangOf(a)] - LANG_RANK[mtLangOf(b)])[0];
      return { sub: join(dir, picked), how: 'norm' };
    }
  }

  /* ③ §136：月度合集 ⇒ 字幕在同一个月度包的 Subs.zip 里 */
  const zipHit = await findSubtitleInZip(videoAbs, vBase);
  if (zipHit) return zipHit;

  return { sub: null, how: null };
}

/**
 * §136：在**月度合集包**的 `Subs.zip` 里找这一集的字幕。
 *
 * 🔴 zip 内文件名是 Shift_JIS（flag 无 UTF-8 位），但每个条目都带
 *    Info-ZIP Unicode Path extra（0x7075）⇒ 直接拿那里的 UTF-8 名，
 *    ⛔ 不用解 Shift_JIS、⛔ 不用猜编码（容器里 busybox unzip 解出来是乱码）。
 */
async function findSubtitleInZip(
  videoAbs: string,
  vBase: string,
): Promise<{ sub: string | null; how: 'zip' | null }> {
  /* 视频路径形如 /downloads/mteam里番全量库/2026年08月合集/CHS/xxx.chs.mp4
     ⇒ 月度包目录 = 往上一级（CHS 的父目录） */
  const dir = dirname(videoAbs);
  const parent = dirname(dir);
  const packDir = basename(parent);
  if (!/合集|月|collection/i.test(packDir)) return { sub: null, how: null };

  const zipPath = join(parent, 'Subs.zip');
  const zip = await loadZip(zipPath);
  if (!zip) return { sub: null, how: null };

  /* zip 里的名字是**原始作品名**（与视频同名），但：
     视频 RAW 裸名 `[260828][nur]タイトル.mkv`  ⇔  zip 条目 `[260828][nur]タイトル.chs.ass`
     ⇒ 逐字不等（一边有 .chs 一边没有）⇒ **两边都剥语言标记再比**（stripLang 注入）。 */
  const cands = [vBase, stripLangSuffix(vBase)];
  for (const c of cands) {
    const hit = findZipEntry(zip, c, MT_SUB_EXT, (n) => LANG_RANK[mtLangOf(n)], stripLangSuffix);
    if (hit) {
      /* 🔴 zip 在 cifs 挂载上、⛔ 不写它；把内容落到容器 /tmp 的临时文件，
         再由 scrape.ts 走流复制进 115。 */
      const tmp = join(tmpDir(), `sub_${hashName(hit.entry.name)}_${Date.now()}${extname(hit.entry.name) || '.ass'}`);
      try {
        await writeFile(tmp, hit.data);
        return { sub: tmp, how: 'zip' };
      } catch {
        return { sub: null, how: null };
      }
    }
  }
  return { sub: null, how: null };
}

/** 容器内临时目录（/tmp 可写，跨文件系统复制用流，所以临时中转没问题） */
export function tmpDir(): string {
  return process.env.TMPDIR || '/tmp';
}

/** 文件名 → 稳定短哈希（避免临时文件名带日文/特殊字符） */
function hashName(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 查「这一集在 mteam 盘上有哪些文件」。
 *
 * @returns 已按语言/画质排序（[0] 就是默认建议的那个），每项都带字幕
 */
export async function listMtFiles(
  db: DB,
  workId: number,
  season: number,
  episode: number,
  root: string = mtRoot(),
): Promise<MtFile[]> {
  let raw: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT mt_files FROM ep_media
          WHERE work_id = ? AND season = ? AND episode = ? LIMIT 1`,
      )
      .get(workId, season, episode) as { mt_files?: string | null } | undefined;
    raw = row?.mt_files ?? null;
  } catch {
    /* 老库无 ep_media ⇒ 当没有 mteam 源（⛔ 不猜） */
    return [];
  }
  if (!raw) return [];

  let arr: Array<Record<string, unknown>>;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: MtFile[] = [];
  for (const f of arr) {
    const rel = String(f.path ?? '').trim();
    if (!rel) continue;
    const abs = join(root, rel);
    const { sub, how } = await findSubtitleFor(abs);
    out.push({
      name: String(f.name ?? basename(rel)),
      size: Number(f.size ?? 0),
      w: f.w == null ? null : Number(f.w),
      h: f.h == null ? null : Number(f.h),
      codec: (f.codec as string | null) ?? null,
      mbps: f.mbps == null ? null : Number(f.mbps),
      sec: f.sec == null ? null : Number(f.sec),
      path: rel,
      abs,
      lang: mtLangOf(String(f.name ?? rel)),
      sub,
      subHow: how,
    });
  }
  return rankMtFiles(out);
}

/** 按相对路径取单个文件（人工指定了具体哪一个） */
export async function mtFileByPath(
  db: DB,
  workId: number,
  season: number,
  episode: number,
  relPath: string,
  root: string = mtRoot(),
): Promise<MtFile | null> {
  const all = await listMtFiles(db, workId, season, episode, root);
  const key = relPath.trim();
  return all.find((f) => f.path === key) ?? all.find((f) => f.name === key) ?? null;
}

/**
 * 逐集「这一集该用哪个源」—— 默认策略的唯一实现（⛔ 前后端不许各写一份）。
 *
 * | 情况 | 默认 |
 * |---|---|
 * | 人工选过 | 听人工（work_ep_src 生效行） |
 * | mteam 盘上有文件 | mteam（不用等下载、不花流量） |
 * | 没有 mteam，但 hanime 有直链 | hanime |
 * | 都没有 | none（前端标「无源」，⛔ 不假装在跑） |
 */
export type SrcPick = 'hanime' | 'mteam';
export interface EpSrcRow {
  season: number;
  episode: number;
  /** 人工选择（NULL = 没选过，走默认） */
  manual: { src: SrcPick; hanimeVid: string | null; mtPath: string | null; note: string | null; pickedAt: string } | null;
  /** 默认建议 */
  suggest: SrcPick | 'none';
  suggestWhy: string;
  /** mteam 候选（已排序，[0] 为默认） */
  mt: MtFile[];
  /** hanime 候选（vid + 画质 + 体积），从 source_link 来 */
  hn: Array<{ vid: string; quality: number | null; size: number | null; expired: boolean }>;
}
