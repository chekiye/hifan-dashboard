/**
 * ⭐ §157（2026-11-05）配置中心 API —— 看板设置页「系统设置」的后端
 *
 * ## 接口
 * - GET  /api/app-config        全部受管键 + 当前生效值（secret 只回「已设置」布尔）
 * - POST /api/app-config        保存 { values: {key: value} }；secret 留空 = 不覆盖；
 *                               填 `-` = 清除覆盖（回落 env/默认）
 * - POST /api/app-config/test   { key } 真·探活（不走 mock）：按键所属分组发真实请求
 *
 * ## 生效
 * 保存 → setOverride() → 内存 Map 更新 ⇒ 所有 getter 立即读到新值，不重启容器。
 */
import type { FastifyInstance } from 'fastify';
import { CONFIG_KEYS, getOverride, hasOverride, setOverride } from './config_overrides.js';
import { config } from './config.js';

/** secret 值绝不回传前端；用「已设置（值来自哪一层）」代替 */
function valueSource(key: string, envKey: string): 'override' | 'env' | 'default' {
  if (hasOverride(key)) return 'override';
  if (process.env[envKey]?.trim()) return 'env';
  return 'default';
}

export function registerAppConfigApi(app: FastifyInstance): void {
  /* ── GET：全部受管键 ─────────────────────────────────────── */
  app.get('/api/app-config', async () => {
    const items = CONFIG_KEYS.map((d) => {
      const live = ov(d.key);
      if (d.secret) {
        return { ...d, set: live !== '', source: valueSource(d.key, d.envKey) };
      }
      return { ...d, value: live, source: valueSource(d.key, d.envKey) };
    });
    return { ok: true, items };
  });

  /* ── POST：保存 ──────────────────────────────────────────── */
  app.post('/api/app-config', async (req, reply) => {
    const body = (req.body ?? {}) as { values?: Record<string, string> };
    const values = body.values ?? {};
    const saved: string[] = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const d of CONFIG_KEYS) {
      if (!(d.key in values)) continue;
      let v = String(values[d.key] ?? '').trim();
      if (d.secret && v === '') continue; // secret 留空 = 保持现状
      if (v === '-') v = ''; // 显式清除覆盖
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

    // 代理/FlareSolverr/Emby/CMS 的探活都读「当前生效值」
    const t0 = Date.now();
    try {
      const message = await probe(def.key);
      return { ok: true, key, ms: Date.now() - t0, message };
    } catch (e) {
      return { ok: false, key, ms: Date.now() - t0, error: (e as Error).message };
    }
  });
}

/** 按键读当前生效值（config 的 getter 已实现 覆盖>env>默认） */
function ov(key: string): string {
  switch (key) {
    case 'tmdb.apiKey': return config.tmdb.apiKey;
    case 'tmdb.proxy': return config.tmdb.proxy;
    case 'hanime.proxy': return config.hanime.proxy;
    case 'hanime.flaresolverr': return config.hanime.flaresolverr;
    case 'download.proxy': return config.download.proxy;
    case 'emby.base': return config.emby.base;
    case 'emby.apiKey': return config.emby.apiKey;
    case 'emby.libId': return config.emby.libId;
    case 'emby.adminUid': return config.emby.adminUid;
    case 'cms.baseUrl': return config.cms.baseUrl;
    case 'cms.user': return config.cms.user;
    case 'cms.pass': return config.cms.pass;
    case 'cms.webhookUrl': return config.cms.webhookUrl;
    case 'cms.nsfwPaths': return config.cms.nsfwPaths;
    default: return getOverride(key) ?? '';
  }
}

/** 带超时的 fetch */
async function tfetch(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) } as RequestInit);
}

/** 走代理的 fetch（undici ProxyAgent；无代理值则原样直连） */
async function pfetch(url: string, proxy: string, ms = 8000): Promise<Response> {
  if (!proxy) return tfetch(url, {}, ms);
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent(proxy);
  return fetch(url, {
    dispatcher: agent as never,
    signal: AbortSignal.timeout(ms),
  } as never) as unknown as Response;
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

    /* ── TMDB ── */
    case 'tmdb.apiKey': {
      const k = config.tmdb.apiKey;
      if (!k) throw new Error('TMDB API Key 未设置');
      const res = await pfetch(
        `${config.tmdb.baseUrl}/configuration`, config.tmdb.proxy, 10000,
      );
      if (res.status === 401) throw new Error('Key 被拒（401）—— 检查是否复制完整');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return 'TMDB Key 有效';
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
        return `找到 ${folders.length} 个库，但 none 的 ID = ${config.emby.libId}（检查库 ID）`;
      }
      return config.emby.adminUid
        ? `管理员 UID 已设置（${config.emby.adminUid.slice(0, 6)}…）`
        : '管理员 UID 为空';
    }

    /* ── CMS ── */
    case 'cms.baseUrl': {
      const res = await tfetch(`${config.cms.baseUrl.replace(/\/+$/, '')}/api/health`, {}, 8000)
        .catch(async () => tfetch(config.cms.baseUrl.replace(/\/+$/, ''), {}, 8000));
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
      const res = await tfetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 8000);
      return `上游可达（HTTP ${res.status}）`;
    }
    case 'cms.nsfwPaths':
      return `关键词：${config.cms.nsfwPaths.split(',').map((s) => s.trim()).filter(Boolean).join(' · ') || '（空 = 不过滤）'}`;

    default:
      throw new Error(`该键没有探活实现：${key}`);
  }
}
