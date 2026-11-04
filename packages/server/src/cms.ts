/**
 * CMS（cloud-media-sync）客户端 —— 触发一次**增量同步**。
 *
 * ## 为什么必须有这一步（§93-3，2026-10-30 实测定论）
 *
 * 入库是**两步**，我们的刮削只做完第一步：
 * | 步骤 | 谁做 | 位置 |
 * |---|---|---|
 * | ① 真文件 + nfo + 图片 → 115 | 本项目的 Scraper | `115挂载/CloudDrive/…` |
 * | ② 生成 `.strm`（115 直链）+ 元数据 | **CMS** | `strm库/…` |
 *
 * **Emby 读的是第 ② 步那个库**。`.strm` 内容是
 * `https://cms.example.com:16666/d/<115 fileid>.mkv` —— 那个 fileid 得靠 CMS
 * 用 115 API 拿，本项目自己造不出来（§92 因此卡住，一度以为无解）。
 *
 * 结论：**不需要自己生成 strm，只要触发 CMS 跑一次增量同步**。
 *
 * ## 接口事实（来自 NAS 上 `sync-watcher/app/cms_client.py`，已实测复核）
 * - CMS 真 API 在 **9528**（5000=前端静态页 / 3000·9527=nginx，都不通）
 * - 触发：`GET /api/sync/lift` ← **是 GET**，不是 POST
 * - ⛔ `/api/sync/full`（全量同步）**绝对不要碰**
 * - 鉴权：先 `POST /api/auth/login {username,password}`，拿 `data.token`，7 天有效
 * - 账号在 CMS 容器的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（SQLite 里是 hash，反推不了）
 * - CMS 没有任务状态查询接口 ⇒ 只能靠触发后观察结果
 *
 * ## 网络（§93-3 实测）
 * CMS 是 `network_mode=host`、监听 `0.0.0.0:9528`。
 * 看板容器里：`127.0.0.1:9528` ❌（那是容器自己的 netns）；
 * `172.17.0.1:9528` / `NAS局域网IP:9528` / `host.docker.internal:9528` ✅ 都通。
 * ⇒ 默认用 `172.17.0.1`（docker0 网桥宿主侧，不依赖 NAS 的 LAN IP 是否变化）。
 *
 * ⚠️ 踩过的坑：别用 `sh -c 'echo > /dev/tcp/…'` 测连通 —— busybox sh 不支持
 * `/dev/tcp`，会报「不通」而实际完全通（本轮被骗过一次）。
 */

export interface CmsConfig {
  /** 例：http://172.17.0.1:9528 */
  baseUrl: string;
  user: string;
  pass: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

export interface CmsResult {
  ok: boolean;
  /** 给人看的一句话（失败原因 / CMS 原文） */
  message: string;
  /** 毫秒 */
  ms: number;
}

export class CmsClient {
  private readonly base: string;
  private token: string | null = null;
  private tokenExpireAt = 0;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: CmsConfig) {
    this.base = String(cfg.baseUrl ?? '').replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
    this.timeoutMs = Math.max(3000, cfg.timeoutMs ?? 15_000);
  }

  /** 配了没有（没配就别在入库收尾时报错，安静跳过） */
  get configured(): boolean {
    return Boolean(this.base && this.cfg.user && this.cfg.pass);
  }

  /** 以 `demo` 方式显示当前打的是哪台（日志用，不含凭据） */
  get endpoint(): string {
    return this.base || '(未配置)';
  }

  private async login(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpireAt - 600_000) return this.token;

    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.user, password: this.cfg.pass }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`CMS 登录 HTTP ${res.status}：${text.slice(0, 160)}`);

    let data: any = null;
    try {
      data = JSON.parse(text)?.data ?? null;
    } catch {
      throw new Error(`CMS 登录返回不是 JSON：${text.slice(0, 160)}`);
    }
    const token = data?.token ? String(data.token) : '';
    if (!token) throw new Error(`CMS 登录没返回 token：${text.slice(0, 160)}`);

    /* 后端给了有效期就用后端的（秒 / 天两种都见过），否则按 7 天 */
    let ttlMs = 7 * 86_400_000;
    for (const k of ['expires_in', 'expire', 'expires']) {
      const v = Number(data?.[k]);
      if (!Number.isFinite(v) || v <= 0) continue;
      ttlMs = v > 3600 ? v * 1000 : v * 86_400_000;
      break;
    }
    this.token = token;
    this.tokenExpireAt = Date.now() + ttlMs;
    return token;
  }

  private async get(path: string, retryAuth = true): Promise<any> {
    const token = await this.login();
    const res = await fetch(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if ((res.status === 401 || res.status === 403) && retryAuth) {
      this.token = null;
      await this.login(true);
      return this.get(path, false);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 400) };
    }
  }

  /**
   * 触发一次**增量**同步（重读 115 生活事件 → 生成 strm / nfo / 海报），
   * 并顺带让 CMS 提交一次 Emby 媒体库刷新（它自己会做，实测有日志）。
   *
   * ⚠️ 这是**创建一次独立任务**，不改 CMS 自己的 01:00 调度。
   */
  async triggerSync(): Promise<CmsResult> {
    const t0 = Date.now();
    if (!this.configured) {
      return { ok: false, message: 'CMS 未配置（缺 CMS_BASE_URL / CMS_USER / CMS_PASS）', ms: 0 };
    }
    try {
      const r = await this.get('/api/sync/lift');
      const code = Number(r?.code ?? 0);
      const msg = String(r?.msg ?? r?.message ?? '');
      const ok = code === 200 || /成功/.test(msg);
      return { ok, message: msg || (ok ? '已触发' : JSON.stringify(r).slice(0, 160)), ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
  }

  /** 测连通（只登录 + 读一个轻量接口，不触发同步） */
  async probe(): Promise<CmsResult> {
    const t0 = Date.now();
    if (!this.configured) {
      return { ok: false, message: 'CMS 未配置（缺 CMS_BASE_URL / CMS_USER / CMS_PASS）', ms: 0 };
    }
    try {
      this.token = null;
      await this.login(true);
      return { ok: true, message: `CMS 登录成功（${this.endpoint}）`, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
  }
}
