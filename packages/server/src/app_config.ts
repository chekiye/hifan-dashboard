/**
 * ⭐ §157（2026-11-05）配置中心 API —— 看板设置页「系统设置」的后端
 * ⭐ §158 扩面：路径 / 行为开关 / 推送 / 访问认证 全部纳入
 * ⭐ §159 重构成卡片模型：新增批量探活 + 目录浏览
 *
 * ## 接口
 * - GET  /api/app-config         全部受管键 + 当前生效值（secret 只回「已设置」布尔）
 * - POST /api/app-config         保存 { values: {key: value} }；secret 留空 = 不覆盖；
 *                                填 `-` = 清除覆盖（回落 env/默认）
 * - POST /api/app-config/test    { key } 单键真·探活
 * - POST /api/app-config/status  批量探活（每张卡一条）→ 卡片状态灯
 * - GET  /api/fs/list            目录浏览（设置页选路径用；根白名单 + 越界防护）
 *
 * ## 生效
 * 保存 → setOverride() → 内存 Map 更新 ⇒ 所有 getter 立即读到新值，不重启容器。
 * ⚠️ 标了 restart 的键（路径类）虽然值立刻进内存，但**进程启动时已绑定**的消费方
 *    要等重建容器才吃到新值 —— 前端会显示「需重建容器」，别骗用户。
 */
import { accessSync, constants as fsConst, statSync } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@hifan/core';
import {
  CARDS,
  CONFIG_KEYS,
  type CardMeta,
  getOverride,
  hasOverride,
  isTestable,
  setOverride,
} from './config_overrides.js';
import { config } from './config.js';

/** secret 值绝不回传前端；用「已设置（值来自哪一层）」代替 */
function valueSource(key: string, envKey: string): 'override' | 'env' | 'default' {
  if (hasOverride(key)) return 'override';
  if (process.env[envKey]?.trim()) return 'env';
  return 'default';
}

/** 每张卡的「算不算配好了」判据 —— 决定卡片显示灰点（未配置）还是去探活 */
const CARD_READY: Record<string, () => boolean> = {
  network: () => Boolean(config.tmdb.proxy || config.hanime.proxy || config.download.proxy || config.hanime.flaresolverr),
  tmdb: () => Boolean(config.tmdb.apiKey),
  emby: () => Boolean(config.emby.base),
  cms: () => Boolean(config.cms.baseUrl),
  dir_library: () => Boolean(config.scrape.libraryRoot),
  dir_download: () => Boolean(config.download.root),
  dir_strm: () => Boolean(config.scrape.strmRoot),
  wecom: () => Boolean(config.wecom.relayUrl),
  filter: () => Boolean(config.cms.filterToken || config.cms.webhookUrl),
  auth: () => Boolean(config.auth.user && config.auth.pass),
};

export function registerAppConfigApi(app: FastifyInstance, db?: DB): void {
  /* ── GET：全部受管键 ─────────────────────────────────────── */
  app.get('/api/app-config', async () => {
    const items = CONFIG_KEYS
      /* hidden = 死配置/待删 —— ⛔ 不要为了「统一」把它们塞回界面 */
      .filter((d) => !d.hidden)
      .map((d) => {
        const live = ov(d.key);
        const base = {
          ...d,
          type: d.type ?? (d.secret ? 'password' : 'text'),
          testable: isTestable(d.key),
          advanced: Boolean(d.advanced),
          source: valueSource(d.key, d.envKey),
        };
        if (d.secret) {
          return { ...base, set: live !== '' };
        }
        return { ...base, value: live };
      });
    /* 卡片元数据也一并回传：前端不再硬编码分组表（加卡只改后端一处） */
    return { ok: true, items, cards: CARDS };
  });

  /* ── POST：保存 ──────────────────────────────────────────── */
  app.post('/api/app-config', async (req, reply) => {
    const body = (req.body ?? {}) as { values?: Record<string, string> };
    const values = body.values ?? {};
    const saved: string[] = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const d of CONFIG_KEYS) {
      if (!(d.key in values)) continue;
      if (d.hidden) continue;
      let v = String(values[d.key] ?? '').trim();
      if (d.secret && v === '') continue; // secret 留空 = 保持现状
      if (v === '-') v = ''; // 显式清除覆盖
      /* 数值/布尔做一次规范化：免得把 "abc" 塞进库里，读的时候静默回落让人困惑 */
      if (v !== '') {
        if (d.type === 'number') {
          if (!Number.isFinite(Number(v))) {
            errors.push({ key: d.key, error: `${d.label}：不是合法数字（${v}）` });
            continue;
          }
          const n = Number(v);
          if (d.min !== undefined && n < d.min) {
            errors.push({ key: d.key, error: `${d.label}：不能小于 ${d.min}` });
            continue;
          }
          if (d.max !== undefined && n > d.max) {
            errors.push({ key: d.key, error: `${d.label}：不能大于 ${d.max}` });
            continue;
          }
          v = String(n);
        }
        if (d.type === 'boolean') v = v === 'true' || v === '1' ? 'true' : 'false';
      }
      try {
        setOverride(d.key, v);
        saved.push(d.key);
      } catch (e) {
        errors.push({ key: d.key, error: (e as Error).message });
      }
    }
    if (errors.length) return reply.code(500).send({ ok: false, errors });
    return { ok: true, saved };
  });

  /* ── POST：测试连接（真探活）────────────────────────────── */
  app.post('/api/app-config/test', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string };
    const key = String(body.key ?? '');
    const def = CONFIG_KEYS.find((d) => d.key === key);
    if (!def) return reply.code(400).send({ ok: false, error: `未知配置键 ${key}` });
    if (!isTestable(key)) return reply.code(400).send({ ok: false, error: `该键没有探活实现：${key}` });

    const t0 = Date.now();
    try {
      const message = await probe(def.key);
      return { ok: true, key, ms: Date.now() - t0, message };
    } catch (e) {
      const f = friendlyError(e);
      return { ok: false, key, ms: Date.now() - t0, error: f.error, hint: f.hint,
        soft: e instanceof SoftFail };
    }
  });

  /* ── POST：批量探活（卡片状态灯）──────────────────────────
     🔴 与「测试连接」的区别：这里一次把所有卡都探一遍，页面一打开就知道
        哪张卡是好的、哪张坏了 —— 不用用户逐个点。
     ⚠️ 失败不抛错，返回 ok:false + error，前端画红点。 */
  app.post('/api/app-config/status', async () => {
    const probed = CARDS.filter((c) => c.probeKey);
    const results = await Promise.all(
      probed.map(async (c) => {
        const ready = CARD_READY[c.id] ? CARD_READY[c.id]() : true;
        /* 🔴 一张卡可能有多个候选键：挑第一个真正有值的去探。
           （网络卡同时管三处代理，代理全空时不该报「失败」，那是直连） */
        const key = probeKeyFor(c);
        if (!ready || !key) {
          return [c.id, { configured: false, ok: false, ms: 0 }] as const;
        }
        const t0 = Date.now();
        try {
          const message = await probe(key);
          return [c.id, { configured: true, ok: true, ms: Date.now() - t0, message }] as const;
        } catch (e) {
          const f = friendlyError(e);
          return [
            c.id,
            { configured: true, ok: false, soft: e instanceof SoftFail,
              ms: Date.now() - t0, error: f.error, hint: f.hint },
          ] as const;
        }
      }),
    );

    const cards: Record<string, unknown> = {};
    for (const [id, st] of results) cards[id] = st;

    /* 本地索引类信息（不是探活，是「数据有多新」）—— 单独一块，别混进探活结果 */
    return {
      ok: true,
      cards,
      local: {
        mteam: mteamStatus(db),
        db: dbStatus(db),
      },
    };
  });

  /* ── GET：目录浏览（设置页选路径）──────────────────────────
     🔴 安全：只允许在「白名单根」内浏览。白名单 = 常见挂载点 + 当前已配置的目录顶层。
        防三类逃逸：`..` 穿越（resolve 后判断）、符号链接跳出（realpath 后判断）、
        无权限目录（access 探测后标记，前端灰掉但仍列出）。
     ⚠️ 只列目录，不列文件 —— 选路径的场景不需要看到视频文件。 */
  app.get('/api/fs/list', async (req, reply) => {
    const q = (req.query ?? {}) as { path?: string; filter?: string };
    const raw = String(q.path ?? '/').trim() || '/';
    const filter = String(q.filter ?? '').trim().toLowerCase();

    /* 1) 必须绝对路径（Linux 以 / 开头；本地调试允许盘符路径） */
    const isWinAbs = /^[A-Za-z]:[\\/]/.test(raw);
    if (!raw.startsWith('/') && !isWinAbs) {
      return reply.code(400).send({ ok: false, error: '必须是绝对路径（容器内路径，以 / 开头）' });
    }
    const wanted = resolve(raw);
    const roots = browseRoots();

    /* 2) 根路径：只列「允许浏览的挂载点」
       🔴 不是把 / 全列出来 —— 那样用户会点到 /etc、/proc 这类进不去的目录，
          点了才报 403，等于把坑摆在他脚边。根级只给能进的门。
       ⚠️ 用 raw 判断而不是 resolve 后的值（Windows 下 resolve('/') 会变成盘符） */
    if (raw === '/' || raw === '' || wanted === '/') {
      const dirs = await listRoots(roots, filter);
      return { ok: true, path: '/', resolved: '/', parent: null, roots, dirs };
    }

    /* 3) 越界判断：realpath 之后必须落在白名单根里 */
    let real: string;
    try {
      real = await realpath(wanted);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reply.code(404).send({ ok: false, error: `目录不存在：${raw}` });
      if (code === 'EACCES') return reply.code(403).send({ ok: false, error: `没有权限：${raw}` });
      return reply.code(400).send({ ok: false, error: `${code ?? '打不开'}：${raw}` });
    }
    if (!inRoots(real, roots)) {
      /* 🔴 提示里只列**真实存在**的白名单根 —— 原样把 roots 全丢出来，
         用户会看到一堆本机根本没有的路径（Linux 预设跑在 Windows 上时尤其离谱），
         越看越不知道自己错在哪。 */
      const exist = await listRoots(roots, '');
      const names = exist.map((d) => d.path).join('、') || '（暂无可用目录）';
      return reply.code(403).send({
        ok: false,
        error: `这个目录不在允许范围内。可浏览：${names}`,
      });
    }

    let st;
    try {
      st = await stat(real);
    } catch {
      return reply.code(404).send({ ok: false, error: `目录不存在：${raw}` });
    }
    if (!st.isDirectory()) return reply.code(400).send({ ok: false, error: '这不是目录' });

    const dirs = await listDirs(real, real, filter);
    const parent = real === '/' ? '/' : real.slice(0, real.lastIndexOf(sep)) || '/';
    return { ok: true, path: wanted, resolved: real, parent, roots, dirs };
  });
}

/**
 * 一张卡实际该探哪个键。
 * 🔴 网络卡同时管三处代理，没有单一的「主键」—— 挑第一个真有值的去探；
 *    三个都空就是「直连模式」，报 configured:false（灰点），⛔ 不是失败。
 */
function probeKeyFor(card: CardMeta): string | null {
  if (card.id === 'network') {
    for (const k of ['tmdb.proxy', 'hanime.proxy', 'download.proxy', 'hanime.flaresolverr']) {
      if (ov(k)) return k;
    }
    return null;
  }
  return card.probeKey ?? null;
}

/** 允许浏览的根：常见挂载点 + 当前已配置目录的顶层 + env 自定义（兼容自定义挂载） */
function browseRoots(): string[] {
  const preset = [
    '/library', '/media', '/downloads', '/strm', '/data',
    '/mnt', '/vol1', '/vol2', '/volume1', '/volume2', '/files', '/share',
  ];
  const configured = [config.scrape.libraryRoot, config.scrape.strmRoot, config.download.root]
    .filter(Boolean)
    .map((p) => resolve(p))
    /* 取顶层（/下载盘/x/y → /vol02），这样同盘的其他目录也能选到 */
    .map((p) => '/' + p.split(sep).filter(Boolean)[0])
    .filter((p) => p !== '/');
  /* 🔴 逃生口：挂到非标准路径的自建用户，用 FS_BROWSE_ROOTS 指定（逗号分隔绝对路径） */
  const extra = (process.env.FS_BROWSE_ROOTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  /* 🔴 全部 resolve 成同一套绝对路径再比较。
     ⛔ 别一半用原始字符串（/library）、一半用 realpath（C:\library）——
        那样根级能列出来，点进去却判越界（实测踩过）。 */
  const all = [...preset, ...configured, ...extra].map((p) => resolve(p));
  return [...new Set(all)];
}

/**
 * 路径是否落在白名单内。
 * 🔴 Windows / macOS 文件系统大小写不敏感（realpath 会还成磁盘上的真实大小写，
 *    比如 /downloads → C://Downloads），Linux 敏感 —— 按平台决定要不要折叠大小写，
 *    ⛔ 不要一律 toLowerCase（Linux 上 /Library 与 /library 是两个目录）。
 */
const CASE_INSENSITIVE_FS = process.platform !== 'linux';

function inRoots(real: string, roots: string[]): boolean {
  const norm = CASE_INSENSITIVE_FS ? (s: string) => s.toLowerCase() : (s: string) => s;
  const target = norm(real);
  return roots.some((r) => {
    const root = norm(r);
    return target === root || target.startsWith(root + sep);
  });
}

/** 根级：只列白名单里真实存在的挂载点 */
async function listRoots(
  roots: string[],
  filter: string,
): Promise<Array<{ name: string; path: string; readable: boolean; writable: boolean }>> {
  const out: Array<{ name: string; path: string; readable: boolean; writable: boolean }> = [];
  for (const r of roots) {
    let real: string;
    try {
      real = await realpath(r);
    } catch {
      continue; // 没挂载 / 不存在就跳过，不占位
    }
    let st;
    try {
      st = await stat(real);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const name = real.split(sep).filter(Boolean).pop() || real;
    if (filter && !name.toLowerCase().includes(filter)) continue;
    const [rd, wr] = await Promise.all([can(real, fsConst.R_OK), can(real, fsConst.W_OK)]);
    /* path 用 realpath：和 browseRoots 的比较空间保持一致 */
    out.push({ name, path: real, readable: rd, writable: wr });
  }
  return out;
}

/** 列目录（只列目录；带 readable/writable 标记） */
async function listDirs(
  abs: string,
  allowCheck: string | null,
  filter: string,
): Promise<Array<{ name: string; path: string; readable: boolean; writable: boolean }>> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const picked = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .filter((e) => !filter || e.name.toLowerCase().includes(filter))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .slice(0, 300);

  const out: Array<{ name: string; path: string; readable: boolean; writable: boolean }> = [];
  for (const e of picked) {
    const p = abs === '/' ? `/${e.name}` : `${abs}/${e.name}`;
    /* 符号链接要确认指向目录，且不能跳出白名单 */
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      continue;
    }
    if (allowCheck) {
      if (!inRoots(real, browseRoots())) continue;
    }
    let st;
    try {
      st = await stat(real);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const [r, w] = await Promise.all([can(real, fsConst.R_OK), can(real, fsConst.W_OK)]);
    out.push({ name: e.name, path: p, readable: r, writable: w });
  }
  return out;
}

async function can(p: string, mode: number): Promise<boolean> {
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

/** mteam 本地索引：有多少番号真的有文件、最后更新在什么时候 */
function mteamStatus(db?: DB): { count: number; updatedAt: string | null } {
  if (!db) return { count: 0, updatedAt: null };
  try {
    const row = db
      .prepare(
        "SELECT COUNT(DISTINCT mt_code) AS n, MAX(updated_at) AS t FROM ep_media " +
          "WHERE mt_code IS NOT NULL AND mt_code <> ''",
      )
      .get() as { n?: number; t?: string } | undefined;
    return { count: Number(row?.n ?? 0), updatedAt: row?.t ?? null };
  } catch {
    return { count: 0, updatedAt: null };
  }
}

/** 数据库概览（系统页「关于」用）—— 🔴 表名是 tmdb_work / tmdb_episode，别写成 work */
function dbStatus(db?: DB): { works: number; episodes: number } {
  if (!db) return { works: 0, episodes: 0 };
  try {
    const w = db.prepare('SELECT COUNT(*) AS n FROM tmdb_work').get() as { n?: number } | undefined;
    const e = db.prepare('SELECT COUNT(*) AS n FROM tmdb_episode').get() as { n?: number } | undefined;
    return { works: Number(w?.n ?? 0), episodes: Number(e?.n ?? 0) };
  } catch {
    return { works: 0, episodes: 0 };
  }
}

/** 按键读当前生效值（config 的 getter 已实现 覆盖>env>默认），统一成字符串 */
function ov(key: string): string {
  switch (key) {
    /* 代理 */
    case 'tmdb.proxy': return config.tmdb.proxy;
    case 'hanime.proxy': return config.hanime.proxy;
    case 'download.proxy': return config.download.proxy;
    case 'hanime.flaresolverr': return config.hanime.flaresolverr;
    /* TMDB */
    case 'tmdb.apiKey': return config.tmdb.apiKey;
    case 'tmdb.baseUrl': return config.tmdb.baseUrl;
    case 'tmdb.rateLimitMs': return String(config.tmdb.rateLimitMs);
    /* Emby */
    case 'emby.base': return config.emby.base;
    case 'emby.apiKey': return config.emby.apiKey;
    case 'emby.libId': return config.emby.libId;
    case 'emby.adminUid': return config.emby.adminUid;
    /* CMS */
    case 'cms.baseUrl': return config.cms.baseUrl;
    case 'cms.user': return config.cms.user;
    case 'cms.pass': return config.cms.pass;
    case 'cms.autoSync': return String(config.cms.autoSync);
    case 'cms.webhookUrl': return config.cms.webhookUrl;
    case 'cms.filterToken': return config.cms.filterToken;
    case 'cms.nsfwPaths': return config.cms.nsfwPaths;
    /* 存储路径 */
    case 'scan.libraryRoot': return config.scan.libraryRoot;
    case 'scan.excludeDirs': return config.scan.excludeDirs.join(',');
    case 'scrape.libraryRoot': return config.scrape.libraryRoot;
    case 'scrape.strmRoot': return config.scrape.strmRoot;
    case 'download.root': return config.download.root;
    case 'download.subdir': return config.download.subdir;
    /* 行为 */
    case 'download.directFirst': return String(config.download.directFirst);
    case 'download.minFreeGb': return String(config.download.minFreeGb);
    case 'download.maxAttempts': return String(config.download.maxAttempts);
    case 'scrape.maxAttempts': return String(config.scrape.maxAttempts);
    case 'scrape.copyStallMs': return String(config.scrape.copyStallMs);
    case 'scrape.embyRefresh': return String(config.scrape.embyRefresh);
    case 'scrape.allowNewRoot': return String(config.scrape.allowNewRoot);
    case 'download.workerAutoStart': return String(config.download.workerAutoStart);
    case 'scrape.workerAutoStart': return String(config.scrape.workerAutoStart);
    /* 推送 */
    case 'wecom.enabled': return String(config.wecom.enabled);
    case 'wecom.relayUrl': return config.wecom.relayUrl;
    case 'wecom.relayToken': return config.wecom.relayToken;
    /* 认证 */
    case 'auth.user': return config.auth.user;
    case 'auth.pass': return config.auth.pass;
    default: return getOverride(key) ?? '';
  }
}

/**
 * 把底层错误翻译成人话 —— 拆成「短标签 + 详细建议」两段。
 * 🔴 卡片上只放短标签（「连接超时」），否则一句话撑成三行，卡片高度全乱；
 *    详细怎么修放 hint，点开卡片才看 —— 需要细节时才占地方。
 * ⛔ 别把 Error.message 原样丢给界面（The operation was aborted due to timeout 等于没说）。
 */
function friendlyError(e: unknown): { error: string; hint?: string } {
  const err = e as Error & { cause?: { code?: string } };
  const raw = err?.message || String(e);
  const code = err?.cause?.code || raw.match(/\bE[A-Z]{3,}\b/)?.[0] || '';

  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw)) {
    return { error: '连不上', hint: '对方端口没有开放 —— 服务没启动，或地址/端口填错了' };
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(raw)) {
    return { error: '域名解析失败', hint: '地址拼错了，或这台机器上不了外网' };
  }
  if (code === 'EAI_AGAIN') return { error: 'DNS 暂时不通', hint: '过一会儿再试' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { error: '网络不通', hint: '到对方的链路断了，检查网段和防火墙' };
  }
  if (code === 'ETIMEDOUT' || /timeout|aborted due to timeout/i.test(raw)) {
    return { error: '连接超时', hint: '8 秒内没有响应 —— 检查地址和端口；走代理的话确认代理可用' };
  }
  if (/fetch failed/i.test(raw)) {
    return { error: '连不上', hint: '请求没发出去 —— 地址/端口/代理检查一遍' };
  }
  return { error: raw.slice(0, 40), hint: raw.length > 40 ? raw : undefined };
}

/** 带超时的 fetch */
async function tfetch(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) } as RequestInit);
}

/** 走代理的 fetch（undici ProxyAgent；无代理值则原样直连） */
async function pfetch(
  url: string,
  proxy: string,
  ms = 8000,
  headers?: Record<string, string>,
): Promise<Response> {
  if (!proxy) return tfetch(url, { headers }, ms);
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent(proxy);
  return fetch(url, {
    headers,
    dispatcher: agent as never,
    signal: AbortSignal.timeout(ms),
  } as never) as unknown as Response;
}

/**
 * 「没配也不影响用」的探活失败。
 *
 * 🔴 红点和灰点是两种话：红点=你配错了，得去修；灰点=这项你没启用，不影响用。
 *    /strm 校验目录是可选的（compose 里那行挂载默认是注释掉的），
 *    没挂载就画红点，等于天天对着一个「你不用它也没事」的功能报警。
 */
class SoftFail extends Error {}

/** 同步探测容器内路径：存在 / 是目录 / 可读（扫描）/ 可写（落盘） */
function probePath(key: string, p: string): string {
  if (!p) throw new Error('路径为空');
  let st;
  try {
    st = statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      /* strm 目录是可选功能 —— 没挂就是「没启用」，不是「配错了」 */
      if (key === 'scrape.strmRoot') {
        throw new SoftFail(`没挂载 ${p} · 不做 strm 校验可以忽略`);
      }
      throw new Error(`目录不存在：${p}（容器内路径；挂载没就绪也会这样）`);
    }
    if (code === 'EACCES') throw new Error(`无权限访问：${p}`);
    throw new Error(`${code ?? 'stat 失败'}：${p}`);
  }
  if (!st.isDirectory()) throw new Error(`存在但不是目录：${p}`);
  const ro = key === 'scan.libraryRoot' || key === 'scrape.strmRoot';
  try {
    accessSync(p, ro ? fsConst.R_OK : fsConst.R_OK | fsConst.W_OK);
  } catch {
    throw new Error(ro ? `目录不可读：${p}` : `目录不可写（入库会失败）：${p}`);
  }
  return `目录就绪（${ro ? '只读校验' : '可读写'}）`;
}

/**
 * 真·探活：每个键发一条真实的最小请求。
 * 🔴 判「通」的口径要宽 —— 401/403 也算通（链路到了，只是鉴权问题，另报）。
 */
async function probe(key: string): Promise<string> {
  switch (key) {
    /* ── 代理组：借 gstatic 204 探节点可达性（哪个分组都通用）── */
    case 'tmdb.proxy':
    case 'hanime.proxy':
    case 'download.proxy': {
      const proxy = ov(key);
      if (!proxy) throw new Error('代理为空 = 直连模式，无需测试');
      const res = await pfetch('https://www.gstatic.com/generate_204', proxy, 8000);
      if (res.status === 204 || res.ok) return `节点可达（HTTP ${res.status}）`;
      throw new Error(`节点响应异常 HTTP ${res.status}`);
    }

    case 'hanime.flaresolverr': {
      const base = ov(key).replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      if (!base) throw new Error('FlareSolverr 地址为空');
      const res = await tfetch(`${base}/health`, {}, 8000);
      const j = (await res.json().catch(() => null)) as { status?: string } | null;
      if (res.ok) return `FlareSolverr 在线（status=${j?.status ?? res.status}）`;
      throw new Error(`HTTP ${res.status}`);
    }

    /* ── 容器内路径（部署最常错的地方：挂载没挂上 / 路径拼错）── */
    case 'scan.libraryRoot':
    case 'scrape.libraryRoot':
    case 'scrape.strmRoot':
    case 'download.root':
      return probePath(key, ov(key));

    /* ── TMDB ── */
    case 'tmdb.apiKey': {
      const k = config.tmdb.apiKey.trim();
      if (!k) throw new Error('TMDB API Key 未设置');
      const base = config.tmdb.baseUrl.replace(/\/+$/, '');
      /* 🔴 原来这里请求的是裸 `/configuration`，压根没把 key 发出去 ——
         目标就是「验 key 有没有效」，结果 TMDB 对匿名请求一律 401，
         于是**任何 key 都被报成「被拒」，包括完全正确的那把**（1.2.0 线上实测踩到）。
         TMDB 有两套凭据，认错一种同样会 401：v3 API Key 走 ?api_key=，
         v4 Read Access Token（eyJ 开头的 JWT）走 Authorization: Bearer。 */
      const isV4 = k.startsWith('eyJ');
      const url = isV4
        ? `${base}/configuration`
        : `${base}/configuration?api_key=${encodeURIComponent(k)}`;
      const res = await pfetch(url, config.tmdb.proxy, 10000,
        isV4 ? { authorization: `Bearer ${k}` } : undefined);
      if (res.status === 401) {
        throw new Error(isV4
          ? 'v4 令牌被拒（401）—— 确认复制的是 Read Access Token 且没过期'
          : 'Key 被拒（401）—— 检查是否复制完整；v4 令牌要 eyJ 开头');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return 'TMDB Key 有效';
    }
    case 'tmdb.baseUrl': {
      const base = config.tmdb.baseUrl.replace(/\/+$/, '');
      if (!base) throw new Error('接口地址为空');
      const res = await pfetch(`${base}/configuration`, config.tmdb.proxy, 10000);
      /* 401 = 地址对了但没带 key，也算链路通 */
      if (res.status === 401) return '地址可达（401 = 需要 key，属正常）';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `地址可达（HTTP ${res.status}）`;
    }

    /* ── Emby ── */
    case 'emby.base': {
      const res = await tfetch(`${config.emby.base}/emby/System/Info/Public`, {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json().catch(() => null)) as { ServerName?: string; Version?: string } | null;
      return `Emby 在线：${j?.ServerName ?? '?'}（${j?.Version ?? '?'}）`;
    }
    case 'emby.apiKey': {
      const k = config.emby.apiKey;
      if (!k) throw new Error('Emby API Key 未设置');
      const res = await tfetch(`${config.emby.base}/emby/System/Info?api_key=${encodeURIComponent(k)}`, {}, 8000);
      if (res.status === 401) throw new Error('Key 被拒（401）');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return 'Emby API Key 有效';
    }
    case 'emby.libId':
    case 'emby.adminUid': {
      if (!config.emby.apiKey) throw new Error('先配好 Emby API Key 再测');
      const res = await tfetch(
        `${config.emby.base}/emby/Library/VirtualFolders?api_key=${encodeURIComponent(config.emby.apiKey)}`,
        {}, 8000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const folders = (await res.json().catch(() => [])) as Array<{ ItemId?: string; Name?: string }>;
      if (key === 'emby.libId') {
        const hit = folders.find((f) => f.ItemId === config.emby.libId);
        if (hit) return `库「${hit.Name}」存在`;
        return `找到 ${folders.length} 个库，但没有 ID = ${config.emby.libId} 的（检查库 ID）`;
      }
      return config.emby.adminUid
        ? `管理员 UID 已设置（${config.emby.adminUid.slice(0, 6)}…）`
        : '管理员 UID 为空';
    }

    /* ── CMS ── */
    case 'cms.baseUrl': {
      const base = config.cms.baseUrl.replace(/\/+$/, '');
      const res = await tfetch(`${base}/api/health`, {}, 8000)
        .catch(async () => tfetch(base, {}, 8000));
      return `CMS 可达（HTTP ${res.status}）`;
    }
    case 'cms.user':
    case 'cms.pass': {
      if (!config.cms.user || !config.cms.pass) throw new Error('CMS 账号/密码未配全');
      const res = await tfetch(`${config.cms.baseUrl.replace(/\/+$/, '')}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: config.cms.user, password: config.cms.pass }),
      }, 8000);
      if (res.status === 401 || res.status === 400) throw new Error('登录被拒 —— 检查账号密码');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json().catch(() => null)) as { data?: { token?: string } } | null;
      return j?.data?.token ? '登录成功，拿到 token' : '登录成功';
    }
    case 'cms.webhookUrl': {
      const u = config.cms.webhookUrl;
      if (!u) return '未设置（用内置默认 /api/emby/webhook 同源地址）';
      const res = await tfetch(u, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }, 8000);
      return `上游可达（HTTP ${res.status}）`;
    }

    /* ── 企微转发器 ── */
    case 'wecom.relayUrl': {
      const u = config.wecom.relayUrl;
      if (!u) throw new Error('转发器地址为空（= 不推送）');
      const origin = new URL(u).origin;
      const res = await tfetch(origin, {}, 5000).catch(() => null);
      if (!res) throw new Error(`连不上转发器：${origin}`);
      /* 任意响应都算链路通（转发器可能只认 POST /push） */
      return `转发器可达（HTTP ${res.status}）`;
    }

    default:
      throw new Error(`该键没有探活实现：${key}`);
  }
}
