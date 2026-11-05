/**
 * ⭐ §90（2026-10-30）CDN 的 **IP 池 + 成败记忆**
 *
 * ## 为什么需要（这条是实测出来的，别删）
 * `vdownload.hembed.com` 背后是一个大 IP 池（已观测到 12+ 个 IPv4：
 * 143.244.51.x / 89.187.187.x）。**同一时刻只有约 1/5 的 IP 能通**，
 * 其余在 200~600ms 内 `ECONNRESET`。
 *
 * 两个关键实测事实（2026-10-30 12:15 / 12:25 两次复测，结论互相打架就是真因）：
 * ① `dns.resolve4()` **一次只给 5 个**，连续解析 5 轮也常常返回同一批
 *    ⇒ 光靠「解析一次 + 试这 5 个」有 1/3 概率全灭
 * ② **能用的 IP 会漂移**：12:15 是 `89.187.187.10` 能跑 11 MB/s，
 *    12:25 再测它已经不在解析结果里，换成 `89.187.187.11` 能通
 * ⇒ 结论：**不能只信当次 DNS 结果，要自己攒一个池子**
 *
 * ## 做法
 * 1. 每次解析到的新 IP 都往池子里并（`seen`）
 * 2. 下载时用「池子里全部 IP」而不是「当次解析的 5 个」⇒ 候选从 5 个变 20~30 个
 * 3. 按记忆排序：最近成功的排最前（一次命中），最近 RST 的排最后
 * 4. 30 分钟 TTL —— CDN 节点状态会变，不能永久相信
 *
 * ⚠️ 只降权不永久拉黑：RST 可能只是短暂限流。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 记忆有效期：30 分钟 */
const TTL_MS = 30 * 60 * 1000;
/** 池子里 IP 的记录保留期：7 天（再久就当没见过） */
const POOL_TTL_MS = 7 * 24 * 3600 * 1000;
/** 一次最多试多少个 IP —— 每个 RST 约 0.2~0.6 秒，30 个也就十几秒，但别再多了 */
const MAX_TRY = 30;

interface HostMem {
  /** ip -> 最后一次成功的信息（时间戳 + 实测速度） */
  ok: Record<string, { at: number; mbps: number }>;
  /** ip -> 最后一次失败的毫秒时间戳 */
  bad: Record<string, number>;
  /** ip -> 最后一次「DNS 解析到它」的毫秒时间戳（池子本体） */
  seen: Record<string, number>;
}

type MemFile = Record<string, HostMem>;

export class IpMemory {
  private data: MemFile = {};
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string) {}

  private load(): void {
    this.loaded = true;
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as MemFile;
      if (raw && typeof raw === 'object') this.data = raw;
    } catch {
      /* 坏了就当空的，最差退回「盲试」 */
    }
  }

  private host(host: string): HostMem {
    if (!this.loaded) this.load();
    const h = (this.data[host] ??= { ok: {}, bad: {}, seen: {} });
    h.ok ??= {};
    h.bad ??= {};
    h.seen ??= {};
    return h;
  }

  /**
   * ⭐ 把「本次解析到的 IP」并进池子，返回**整个池子**（按成功率排序）。
   *
   * @param fresh 本次 DNS 解析到的 IP（可能只有 5 个，甚至 0 个）
   */
  merge(host: string, fresh: string[]): string[] {
    if (!host) return fresh;
    const h = this.host(host);
    const now = Date.now();
    for (const ip of fresh) if (ip) h.seen[ip] = now;

    // 池子本体（过滤过期条目）
    const pool = Object.entries(h.seen)
      .filter(([, at]) => now - at < POOL_TTL_MS)
      .map(([ip]) => ip);

    if (!pool.length) return fresh;

    const score = (ip: string): number => {
      const okAt = h.ok[ip];
      if (okAt && now - okAt.at < TTL_MS) return 0; // 最近成功 ⇒ 最优先
      const badAt = h.bad[ip];
      if (badAt && now - badAt < TTL_MS) return 2; // 最近 RST ⇒ 最后
      return 1; // 未知 ⇒ 中间
    };
    // ⭐ 同档内再按**实测速度**降序 —— 实测过 11 MB/s 和 1.2 MB/s 的 IP 混在一个池子里，
    //    不按速度排就有一半概率去用慢节点（一集 500MB 差 6 分钟）。
    const speed = (ip: string): number => {
      const o = h.ok[ip];
      return o && now - o.at < TTL_MS ? o.mbps : 0;
    };
    // 稳定排序：同档同速时保持池子原顺序（先见过的大概率更好用）
    return [...pool]
      .sort((a, b) => score(a) - score(b) || speed(b) - speed(a))
      .slice(0, MAX_TRY);
  }

  markOk(host: string, ip: string, mbps = 0): void {
    if (!host || !ip) return;
    const h = this.host(host);
    h.ok[ip] = { at: Date.now(), mbps: Math.max(0, Number(mbps) || 0) };
    h.seen[ip] ??= Date.now();
    delete h.bad[ip];
    this.touch();
  }

  markBad(host: string, ip: string): void {
    if (!host || !ip) return;
    const h = this.host(host);
    h.bad[ip] = Date.now();
    h.seen[ip] ??= Date.now();
    delete h.ok[ip];
    this.touch();
  }

  /** 精简 + 防抖落盘（一集里可能调十几次，别每次都写盘） */
  private touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    // 别让这个定时器拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private flush(): void {
    try {
      const now = Date.now();
      // 清掉过期条目，别让文件无限长
      for (const [host, h] of Object.entries(this.data)) {
        for (const [ip, at] of Object.entries(h.ok)) if (now - at.at > TTL_MS * 4) delete h.ok[ip];
        for (const [ip, at] of Object.entries(h.bad)) if (now - at > TTL_MS * 4) delete h.bad[ip];
        for (const [ip, at] of Object.entries(h.seen)) if (now - at > POOL_TTL_MS) delete h.seen[ip];
        if (
          !Object.keys(h.ok).length &&
          !Object.keys(h.bad).length &&
          !Object.keys(h.seen).length
        ) {
          delete this.data[host];
        }
      }
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmp, this.path);
    } catch {
      /* 落盘失败不影响本次下载 */
    }
  }
}
