/**
 * 登录认证 —— 照抄 SW（sync-watcher）的方案
 *
 * 起因（2026-10-15）：8848 通过 Lucky 反代暴露到公网后，
 * 1200+ 张里番封面与作品名**裸奔无认证**。用户要求「和 sw 一样加登录页」。
 *
 * 🔴 为什么不用 Lucky 的 WebAuth：Lucky 侧 `WebAuth=true` 会自己出登录页，
 *    但那是 Lucky 的通用页、样式与本项目完全无关；且配置一旦漏掉，
 *    整站就裸奔。**应用层做认证**，行为可控、与 SW 一致、离线可用。
 *
 * 设计要点（与 SW 对齐）：
 *   1. 密码存**环境变量**，不落盘、不进代码库
 *   2. `scrypt` 加盐哈希比对（SW 是 sha256+salt，这里用更强的 scrypt）
 *   3. **每次登录实时读环境变量** → 改密码后下次登录立刻生效，不用重启
 *   4. 内存 session：进程重启即失效，用户重新登录（与 SW 一致，够用）
 *   5. 失败限流：15 分钟窗口内 5 次失败锁 IP 15 分钟
 *
 * ⚠️ 内网直连（局域网IP:8848）**不设门槛** ——
 *    用户在局域网用 SunPanel 卡片点开不该被登录页拦。
 *    判定方式：看请求来源是否为内网地址段 / 是否经反代。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ── 配置 ─────────────────────────────────────────────────────────

export interface AuthConfig {
  /** 登录用户名；空 = 未启用登录（内网模式） */
  user: string;
  /** 登录密码；空 = 未启用登录 */
  pass: string;
  /** session cookie 名 */
  cookieName: string;
  /** session 有效期（毫秒），默认 7 天 */
  ttlMs: number;
}

export function readAuthConfig(): AuthConfig {
  return {
    user: (process.env.HIFAN_USER || '').trim(),
    pass: process.env.HIFAN_PASS || '',
    cookieName: process.env.HIFAN_COOKIE || 'hifan_session',
    ttlMs: Number(process.env.HIFAN_SESSION_TTL_MS || 7 * 24 * 3600 * 1000),
  };
}

// ── 哈希 ─────────────────────────────────────────────────────────

/**
 * 口令哈希。
 *
 * ⚠️ 为什么要 `scrypt(pass, salt + STATIC_SALT)` 而不是纯 scrypt：
 *   node:sqlite 之类场景不需要，但这里刻意混入一个固定的工程盐，
 *   让「通用密码表」在跨站复用时失效。SW 用的是 sha256+salt。
 */
const STATIC_SALT = 'hifan-dashboard';

export function hashPassword(pass: string, salt: string = STATIC_SALT): Buffer {
  return scryptSync(pass, salt, 32);
}

/** 定长比较，避免时序侧信道 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 字符串定长比较。
 * ⚠️ 不能直接 `timingSafeEqual(a, b)` —— 两者长度不等会抛异常。
 *    做法：各自哈希成定长再比，长度信息不会泄漏。
 */
function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ── session ──────────────────────────────────────────────────────

export interface Session {
  token: string;
  /** 过期时间戳（ms） */
  exp: number;
  /** 创建时的客户端 IP，仅用于日志 */
  ip: string;
}

export class AuthService {
  /** token -> session */
  private readonly sessions = new Map<string, Session>();
  /** ip -> 失败时间戳数组 */
  private readonly fails = new Map<string, number[]>();

  private static readonly FAIL_WINDOW = 15 * 60 * 1000;
  private static readonly FAIL_MAX = 5;
  private static readonly FAIL_LOCKOUT = 15 * 60 * 1000;

  constructor(private readonly cfg: AuthConfig) {
    // 定期清理过期 session，避免内存里堆积
    const t = setInterval(() => this.gc(), 10 * 60 * 1000);
    t.unref?.();
  }

  /** 是否启用登录（没配 HIFAN_USER/HIFAN_PASS 就不拦） */
  get enabled(): boolean {
    return Boolean(this.cfg.user && this.cfg.pass);
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (s.exp < now) this.sessions.delete(k);
    }
  }

  /** 该 IP 是否处于锁定期 */
  locked(ip: string): { locked: boolean; retryAfterSec: number } {
    const arr = (this.fails.get(ip) || []).filter((t) => now0() - t < AuthService.FAIL_WINDOW);
    this.fails.set(ip, arr);
    if (arr.length < AuthService.FAIL_MAX) return { locked: false, retryAfterSec: 0 };
    const oldest = arr[0];
    const remain = AuthService.FAIL_LOCKOUT - (now0() - oldest);
    if (remain > 0) return { locked: true, retryAfterSec: Math.ceil(remain / 1000) };
    // 锁定期已过，清零重算
    this.fails.delete(ip);
    return { locked: false, retryAfterSec: 0 };
  }

  recordFail(ip: string): number {
    const arr = this.fails.get(ip) || [];
    arr.push(now0());
    this.fails.set(ip, arr);
    return AuthService.FAIL_MAX - arr.length;
  }

  clearFails(ip: string): void {
    this.fails.delete(ip);
  }

  /**
   * 校验账号密码。
   * 🔴 每次都重算 hash —— 这样改环境变量里的密码后下次登录立即生效，不用重启。
   */
  verify(user: string, pass: string): boolean {
    if (!safeEqualStr(user, this.cfg.user)) {
      // 用户名不对时也走一次哈希，避免用响应时间区分「用户不存在」
      hashPassword(pass);
      return false;
    }
    return safeEqual(hashPassword(pass), hashPassword(this.cfg.pass));
  }

  create(ip: string): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, exp: now0() + this.cfg.ttlMs, ip });
    return token;
  }

  verifyToken(token: string | undefined | null): boolean {
    if (!token || !this.enabled) return !this.enabled;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (s.exp < now0()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  // ── cookie ────────────────────────────────────────────────────

  /**
   * 下发 session cookie。
   *
   * HttpOnly   —— JS 读不到，防 XSS 窃取
   * SameSite=Lax —— 反代跳转后仍能带回 cookie，但不会被第三方站点当跨站请求自动携带
   * Secure     —— ⚠️ **不能无条件加**。局域网是 http://局域网IP:8848，
   *              加了 Secure 浏览器直接不回传，内网会变成「登录了还进不去」。
   *              公网经 Lucky 反代时应用侧看到的是 http（反代终止 TLS），
   *              只能靠 X-Forwarded-Proto 判断浏览器那侧是不是 https。
   */
  setCookie(reply: FastifyReply, token: string, secure: boolean): void {
    const maxAge = Math.floor(this.cfg.ttlMs / 1000);
    const parts = [
      `${this.cfg.cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ];
    if (secure) parts.push('Secure');
    reply.header('Set-Cookie', parts.join('; '));
  }

  clearCookie(reply: FastifyReply, secure: boolean): void {
    const parts = [
      `${this.cfg.cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (secure) parts.push('Secure');
    reply.header('Set-Cookie', parts.join('; '));
  }
}

/**
 * 浏览器那侧是不是 HTTPS。
 *
 * Lucky 终止 TLS 再回源 http，所以应用永远看到 http；
 * 公网访问必须读 X-Forwarded-Proto，否则公网 cookie 不带 Secure。
 */
export function isSecureRequest(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  return proto === 'https';
}

function now0(): number {
  return Date.now();
}

// ── 内网判定 ─────────────────────────────────────────────────────

/**
 * 判断请求是否来自内网直连（而非公网反代）。
 *
 * 内网直连不该被登录页拦住 —— 用户在 NAS 局域网里用 SunPanel 点开
 * 要能直接看到看板，这是既有习惯。
 *
 * 判定（按可靠性排序）：
 *   1. X-Forwarded-For 的第一个 IP 是内网段 → 反代来的也放过？
 *      ❌ 不行 —— 公网经 Lucky 反代同样会带 XFF。
 *      → 所以**不看 XFF**，只看 socket 真实来源。
 *   2. socket 地址是 127.0.0.1 / 172.16-31.x / 192.168.x / 10.x
 *      （Lucky 与容器同机，反代过来的请求 socket 也是内网）
 *      ⚠️ 这一条会把「公网经 Lucky 反代」也判成内网 —— 所以必须排除。
 *
 * → 最终判定：**socket 地址是内网 + Host 头是内网 IP 或 localhost** 才算内网直连。
 *   公网反代时 Host 是 `hifan.example.com`，不会误判。
 */
export function isLanRequest(req: FastifyRequest): boolean {
  const host = String(req.headers.host || '').split(':')[0];
  return isLanIp(host);
}

function isLanIp(ip: string): boolean {
  if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA
  return false;
}
