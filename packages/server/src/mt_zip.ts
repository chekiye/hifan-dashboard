/**
 * ⭐⭐ §136（2026-11-02）月度合集的字幕在 **Subs.zip 里**，⛔ 不散落在视频旁边
 *
 * ## 蛙哥报的现象（他抽查截图那部时发现的）
 * 「为什么大小对不上」—— 顺手查出来字幕这条链在合集目录上**整批失效**：
 *   · mteam 全量库实测：视频 3471 个、散落字幕 2148 个（都在 `Hentai/` 树下）
 *   · 但 `2026年XX月合集/` 这 9 个目录里：视频 246 个、**散落字幕 0 个**，
 *     字幕全部打包在每个月的 `Subs.zip` 里（14~22 条/zip）
 *   ⇒ `findSubtitleFor()` 只扫「视频同目录」⇒ 合集目录的集**永远找不到字幕**。
 *
 * ## 🔴 为什么不能直接 `unzip`
 * 1. 容器里只有 **busybox unzip**，解出来的文件名是**乱码**（实测 `[260828][?????ޤϊZ???...`）：
 *    - zip 内文件名是 **Shift_JIS**（`flag=0x0000`，没有 UTF-8 标志位）；
 *    - busybox 不做编码转换，直接把原始字节当 UTF-8 显示 ⇒ 全变问号；
 *    - 宿主 `unzip` 能正确解（Info-ZIP 会按 CP932 猜），但**容器里没有 python3**、
 *      `unzip` 又是 busybox 版 ⇒ 只能自己在 Node 里解。
 * 2. 真解出来了名字也对不上：zip 里的名字是**原始作品名**
 *    （`[260828][nur]サレ妻は奪われたい …….chs.ass`），
 *    而视频文件名也是原始作品名 ⇒ **基名逐字相同** ⇒ 能直接配。
 *    ⚠️ 但视频在 `CHS/` 子目录、字幕在 zip 根 ⇒ 不是「同目录」，是「同月度包」。
 *
 * ## ✅ 正确解法：Node 自己解 zip
 * - 读 **中央目录**（End of Central Directory → Central Directory Header）
 * - 文件名优先取 **Info-ZIP Unicode Path extra 字段（header id = 0x7075）**，
 *   那里存的是**正确的 UTF-8 名字** ⇒ 不依赖任何编码猜测，也不用解 Shift_JIS。
 *   实测每个条目都带这个字段（extra 176 字节里含 0x7075）。
 * - 数据段用 `zlib.inflateRawSync` 解（method 8 = deflate；method 0 = 存）。
 * - 只取需要的条目 ⇒ 不整包解压到磁盘。
 *
 * ## 铁律
 * - ⛔ 只读、⛔ 不改 mteam 库、⛔ 不解压整包到盘（zip 在 cifs 挂载上，写它没意义）。
 * - 缓存：zip 内容按 mtime 缓存（改了 zip 要能失效）⇒ 同一个 zip 只解一次。
 */
import { open, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** 正确的 UTF-8 文件名（优先 Info-ZIP Unicode Path，其次原始字节） */
  name: string;
  /** 原始字节解出来的文件名（Shift_JIS 之类，可能是乱码） */
  rawName: string;
  /** 压缩后大小 */
  compressedSize: number;
  /** 解压后大小 */
  size: number;
  /** 压缩方式：0=stored, 8=deflate */
  method: number;
  /** 局部头偏移 */
  localOffset: number;
}

/** EOCD 签名 */
const EOCD_SIG = 0x06054b50;
/** 中央目录条目签名 */
const CD_SIG = 0x02014b50;
/** 本地文件头签名 */
const LFH_SIG = 0x04034b50;
/** Info-ZIP Unicode Path extra header id */
const UP_EXTRA_ID = 0x7075;

function u16(b: Buffer, o: number): number {
  return b.readUInt16LE(o);
}
function u32(b: Buffer, o: number): number {
  return b.readUInt32LE(o);
}

/**
 * 解析 zip 中央目录。
 * @param buf 整个 zip 文件内容
 */
export function readZipCentralDirectory(buf: Buffer): ZipEntry[] {
  /* ① 从尾部找 EOCD（可能有注释，最后 64KB 内扫） */
  const maxBack = Math.min(buf.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (u32(buf, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  const total = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);

  /* ② 逐条读中央目录 */
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length) break;
    if (u32(buf, p) !== CD_SIG) break;
    const method = u16(buf, p + 10);
    const compressedSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nlen = u16(buf, p + 28);
    const elen = u16(buf, p + 30);
    const clen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nlen);

    /* ③ 找 Info-ZIP Unicode Path（0x7075）：里面有**正确的 UTF-8 名字** */
    let uniName: string | null = null;
    let q = p + 46 + nlen;
    const extraEnd = q + elen;
    while (q + 4 <= extraEnd && q + 4 <= buf.length) {
      const hid = u16(buf, q);
      const dlen = u16(buf, q + 2);
      if (hid === UP_EXTRA_ID) {
        const payload = buf.subarray(q + 4, q + 4 + dlen);
        if (payload.length >= 5) {
          /* payload: ver(1) + nameCRC(4) + UTF-8 name */
          const name = payload.subarray(5).toString('utf8');
          /* 🔴 有些打包器会在这里塞 NUL 结尾 / 多个路径，用第一个非空 */
          const clean = name.replace(/\0+$/, '');
          if (clean) uniName = clean;
        }
        break;
      }
      q += 4 + dlen;
    }

    out.push({
      name: uniName ?? nameBuf.toString('utf8'),
      rawName: nameBuf.toString('latin1'),
      compressedSize,
      size,
      method,
      localOffset,
    });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** 从整包 buffer 里取出某个条目的解压后内容 */
export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const lo = e.localOffset;
  if (lo + 30 > buf.length || u32(buf, lo) !== LFH_SIG) {
    throw new Error(`zip 局部头损坏：${e.name}`);
  }
  const nlen = u16(buf, lo + 26);
  const elen = u16(buf, lo + 28);
  const dataStart = lo + 30 + nlen + elen;
  const data = buf.subarray(dataStart, dataStart + e.compressedSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`不支持的压缩方式 ${e.method}：${e.name}`);
}

/** zip 内容缓存（按路径 + mtime + size） */
interface CacheItem {
  mtimeMs: number;
  size: number;
  entries: ZipEntry[];
  buf: Buffer;
}
const zipCache = new Map<string, CacheItem>();

/** 读 zip（带缓存：同一 zip 只解析一次；改了就按 mtime 失效） */
export async function loadZip(path: string): Promise<CacheItem | null> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    zipCache.delete(path);
    return null;
  }
  const hit = zipCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;

  let buf: Buffer;
  try {
    const fh = await open(path, 'r');
    try {
      buf = Buffer.alloc(st.size);
      await fh.read(buf, 0, st.size, 0);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  let entries: ZipEntry[];
  try {
    entries = readZipCentralDirectory(buf);
  } catch {
    return null;
  }
  const item: CacheItem = { mtimeMs: st.mtimeMs, size: st.size, entries, buf };
  zipCache.set(path, item);
  return item;
}

/**
 * 归一化：把**装饰性字符**全去掉，只留下可比较的内容。
 *
 * 🔴 为什么要这一步（实测 2026-11-02）：
 *   视频文件名被 mteam **清洗过**：`260904メリー・ジェーン小女ラムネ_第8話_リトルラバーズ_chs.mp4`
 *   zip  里是**原始名**：`[260904][メリー・ジェーン]小女ラムネ 第8話 リトルラバーズ.chs.ass`
 *   ⇒ 括号、下划线、间隔号全被去掉了 ⇒ **逐字匹配必然失败**（漏配）。
 *   ⇒ 只保留「数字、字母、CJK」三类实质字符再比 ⇒ 两边能对上。
 *
 * ⚠️ 归一化会**丢掉语义**（`前編` vs `後編` 里 `編` 保留，但数字顺序会变），
 *    所以只用它做**兜底**，且命中后要保证是唯一候选（多个候选时宁可不配）。
 */
export function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[^\p{Letter}\p{Number}]/gu, '');
}

/**
 * 在 zip 里找一个条目（按 base 名匹配，忽略大小写）。
 *
 * 🔴 匹配分三层，逐层放宽：
 *    ① 逐字相同（视频名与 zip 名完全一致 —— Hentai 树里那批「裸同名 .ass」走不到这，
 *       但月度合集 RAW 目录有时确实逐字相同）
 *    ② 两边都剥语言标记后相同（`xxx.mkv` ⇔ `xxx.chs.ass`）
 *    ③ **归一化后相同**（去掉括号/下划线/间隔号等装饰字符）—— 清洗过文件名的必备兜底
 *
 * @param base      视频的 base 名（不含扩展名）
 * @param exts      允许的字幕扩展名
 * @param langRank  语言优先级：chs > cht > 裸名 > raw（与 mt_source 的语言档一致）
 * @param stripLang 剥语言后缀的函数（由调用方注入，避免循环依赖）
 */
export function findZipEntry(
  zip: CacheItem,
  base: string,
  exts: string[],
  langRank: (name: string) => number,
  stripLang?: (s: string) => string,
): { entry: ZipEntry; data: Buffer } | null {
  const want = base.toLowerCase();
  const wantNorm = (stripLang ? stripLang(base) : base).toLowerCase();
  const wantKey = normKey(base);

  const cands = zip.entries.filter((e) => {
    const n = e.name;
    const dot = n.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = n.slice(dot).toLowerCase();
    if (!exts.includes(ext)) return false;
    const stem = n.slice(0, dot);
    if (stem.toLowerCase() === want) return true;
    if (stripLang) {
      const sn = stripLang(stem).toLowerCase();
      if (sn === wantNorm) return true;
    }
    return false;
  });

  /* ③ 归一化兜底 —— 只在前面两层都没命中时用。
     ⚠️ 归一化键必须**先剥语言后缀再归一化**：
        zip 条目 stem = `...リトルラバーズ.chs`（扩展名被切掉了，但语言标记还在 stem 里）
        视频 base    = `...リトルラバーズ`
        ⇒ 不剥 `.chs` ⇒ 键差一个 chs ⇒ 永远配不上（实测 9 个清洗名只中 1 个）。 */
  let pool = cands;
  if (!pool.length) {
    const keyOf = (stem: string) => {
      const s1 = stripLang ? stripLang(stem) : stem;
      return normKey(s1);
    };
    pool = zip.entries.filter((e) => {
      const n = e.name;
      const dot = n.lastIndexOf('.');
      if (dot < 0) return false;
      const ext = n.slice(dot).toLowerCase();
      if (!exts.includes(ext)) return false;
      const stem = n.slice(0, dot);
      return keyOf(stem) === wantKey;
    });
    /* ⚠️ 归一化后多个候选 ⇒ 分不清是哪个 ⇒ 宁可不配（0dc：先分「真没有」vs「判据写错」） */
    if (pool.length > 1) {
      const keys = new Set(pool.map((e) => {
        const dot = e.name.lastIndexOf('.');
        return keyOf(e.name.slice(0, dot));
      }));
      if (keys.size > 1) return null;
    }
  }
  if (!pool.length) return null;

  const picked = [...pool].sort((a, b) => langRank(a.name) - langRank(b.name))[0];
  try {
    return { entry: picked, data: readZipEntry(zip.buf, picked) };
  } catch {
    return null;
  }
}
