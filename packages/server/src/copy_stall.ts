/**
 * 带「无进展看护」的文件复制 —— F24。
 *
 * 🔴🔴 为什么需要这个
 *   入库一集的最后一步是把视频从源目录（115 / CloudDrive FUSE 挂载）复制进媒体库：
 *     `await pipeline(createReadStream(src), createWriteStream(tmp))`
 *   这行在 **FUSE 不响应**时不会报错、不会失败，而是**永远挂着不 resolve**。
 *   而 ingest worker 是单并发（`if (this.status.busy) return`），一集卡住
 *   ⇒ busy 永不放 ⇒ 后面所有集永远排不到 ⇒ 看板整片冻住、日志一声不响、只能重启容器。
 *   2026-10-31 外部审查提的 F24 就是这条；当时 `SCRAPE_TIMEOUT_MS` 是个**死配置**
 *   （注释写「单集刮削超时含复制 250MB」，实际全代码零消费），所以等于完全没有看护。
 *
 * 🔴🔴 判据必须是「没进展」，⛔ 不是「总共多久」
 *   250MB 时期「单集超过 10 分钟就杀」勉强能用；§99 本地盘来源一上，单集变 1~2GB，
 *   在 115 限速下**合法地**跑 10 分钟以上很常见 ⇒ 按总时长判会把正常复制杀掉重来，
 *   白烧流量。所以只看「目标文件多久一点没长」（.part 语义复用 0r46）。
 *
 * ⚠️ 已知局限（如实写下来，别假装它更强）
 *   abort 会让 pipeline reject、worker 得以继续，但底层的 FUSE read 可能仍挂在
 *   内核里 —— 那个 fd 要等 FUSE 自己恢复才真正释放。也就是说本函数保证的是
 *   **「队列不被一集拖死」**，不保证「底层 IO 立刻干净」。
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface CopyStallOpts {
  /** 目标文件「多久一点没长」就判卡死（毫秒）。⛔ 不是复制总时长 */
  stallMs: number;
  /** 进度回调（done=已写字节，total=源大小，读流来源未知时为 0） */
  onProgress?: (done: number, total: number) => void;
  /** 轮询目标文件大小的间隔，默认 1000ms */
  pollMs?: number;
  /** 看护检查间隔，默认 min(5000, max(500, stallMs/10)) */
  checkMs?: number;
}

/** 复制卡住的专用错误码 —— scrape 外层 catch 会原样透传成 code，看板据此显示原因 */
export class CopyStalledError extends Error {
  code = 'copy_stalled';
  readonly idleMs: number;
  readonly wroteBytes: number;
  readonly totalBytes: number;
  constructor(idleMs: number, wroteBytes: number, totalBytes: number) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    /* 不足 10 秒时保留一位小数 —— 否则短阈值下会显示成「0 秒没有进展」，看着像 bug */
    const secs = idleMs >= 10_000 ? String(Math.round(idleMs / 1000)) : (idleMs / 1000).toFixed(1);
    super(
      `复制卡住：${secs} 秒没有任何进展`
      + `（已写 ${mb(wroteBytes)} MB`
      + `${totalBytes ? ` / 共 ${mb(totalBytes)} MB` : '，源大小未知'}）`
      + ' —— 多半是源/目标挂载没响应，已中断，下一轮重试',
    );
    this.name = 'CopyStalledError';
    this.idleMs = idleMs;
    this.wroteBytes = wroteBytes;
    this.totalBytes = totalBytes;
  }
}

/**
 * 把 source 复制到 dest，带「无进展」看护。
 *
 * @param source 源路径，或任意可读流（后者只为单测注入「卡住的流」，生产一律传路径）
 * @param dest   目标路径（调用方负责 rename，本函数失败时会把 dest 清掉）
 * @returns 写入字节数
 */
export async function copyWithStall(
  source: string | Readable,
  dest: string,
  opts: CopyStallOpts,
): Promise<number> {
  const stallMs = Number(opts.stallMs);
  if (!(stallMs > 0)) {
    /* 忘了传 = 退回 F24 那个 bug，必须当场炸而不是静默无看护 */
    throw new Error('copyWithStall: stallMs 必须 > 0（没有看护的复制就是 F24 本体）');
  }
  const pollMs = Math.max(20, opts.pollMs ?? 1000);
  const checkMs = Math.max(20, opts.checkMs ?? Math.min(5000, Math.max(500, Math.floor(stallMs / 10))));

  let total = 0;
  let rs: Readable;
  if (typeof source === 'string') {
    const st = await fsp.stat(source);
    total = Number(st.size);
    rs = createReadStream(source);
  } else {
    rs = source;
  }

  let lastSize = 0;
  let lastGrowAt = Date.now();
  let stalled = false;
  const ac = new AbortController();

  const spin = setInterval(() => {
    void fsp
      .stat(dest)
      .then((s) => {
        const n = Number(s.size);
        /* ⚠️ 用 `!==` 而不是 `>`：dest 若残留旧 .part，createWriteStream 的 truncate
           会让大小先掉下来 —— 那也是有动静，不该算进「没进展」。 */
        if (n !== lastSize) {
          lastSize = n;
          lastGrowAt = Date.now();
        }
        opts.onProgress?.(n, total);
      })
      .catch(() => {
        /* dest 还没建出来（open 还没返回）⇒ 不更新基线，超时到了照样判卡死 */
      });
  }, pollMs);

  const guard = setInterval(() => {
    if (stalled) return;
    const idle = Date.now() - lastGrowAt;
    if (idle >= stallMs) {
      stalled = true;
      ac.abort(new CopyStalledError(idle, lastSize, total));
    }
  }, checkMs);

  try {
    await pipeline(rs, createWriteStream(dest), { signal: ac.signal });
  } catch (e) {
    /* ⛔ 不 await 清理：目标端若已卡死，unlink 也会跟着卡住
       ⇒ 那就成了「看着护自己又卡死」，白改。让它自己烂在后台。 */
    void fsp.unlink(dest).catch(() => {});
    throw stalled ? (ac.signal.reason as Error) : e;
  } finally {
    clearInterval(spin);
    clearInterval(guard);
  }

  const final = await fsp.stat(dest).then((s) => Number(s.size)).catch(() => lastSize);
  opts.onProgress?.(final, total || final);
  return final;
}
