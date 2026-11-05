/**
 * 企业微信推送客户端（看板侧）
 *
 * 🔴🔴 网络拓扑（2026-10-28 实测，这是本文件存在的全部理由）：
 *
 *   hifan-dashboard 容器 ──┐
 *     网段 172.20.0.0/16   │  ① 连不上
 *                          ▼
 *   宿主 NAS              ② 连得上（docker 网关 host.docker.internal）
 *     网段 172.31.0.0/16 ◄─┘
 *     │
 *     │  ③ 连得上（宿主有到 172.31 网段的路由）
 *     ▼
 *   immortal 容器（共享 netns）
 *     └─ sync-watcher-wecom-pusher 监听 172.31.0.3:9097
 *          └─ 调企微官方 API（跑在这个网络身份里，60.204 反代只认这个 IP）
 *
 * ⚠️ 看板容器 → 172.31.0.3:9097 **超时**（两个 docker 网段不互通）。
 * ⇒ 所以需要**宿主侧转发**：宿主监听 0.0.0.0:9098，转发到 172.31.0.3:9097/push。
 *   转发器脚本见 `scripts/wecom_relay.py`。
 *
 * 🔴 为什么不直接用 sync-watcher-web 的 `/api/test-push`：
 *   它要登录态（`Depends(require_auth)`）⇒ 看板要带 cookie ⇒ 多一份凭证依赖。
 *   直连 pusher + 共享 token 更干净。
 *
 * 🔴 复用 sync-watcher 那套企微应用（作者拍板）：
 *   同一个企微应用 ⇒ 不需要新申请 corp id / secret / agent id。
 *   token 由宿主转发器从 sync-watcher 的 compose 环境里读取并注入。
 */

export interface WecomConfig {
  /** 转发器地址（宿主） */
  relayUrl: string;
  /** 是否启用推送 */
  enabled: boolean;
  /**
   * 🔴 转发器共享密钥（X-Relay-Token 头）
   *
   * 转发器要求带这个头，否则 403 —— 没有它任何能访问 9098 的人
   * 都能借企微身份发消息（安全边界）。
   *
   * ⛔ 只从环境变量读，⛔ 不写进配置文件、不进 git。
   */
  relayToken?: string;
}

export interface PushResult {
  ok: boolean;
  /** 企微返回体（errcode/errmsg） */
  detail: unknown;
  error?: string;
}

/**
 * 推送一条文本。
 *
 * 🔴 铁律：**推送失败不许打断主流程**。
 *   扫描已经做完、事实字段已经落库了，推送挂了只是「你不知道有更新」，
 *   ⛔ 绝不能因为推送失败把整个扫描标记成 failed（那会让看板显示红色，
 *   让人以为数据有问题，实际数据是对的）。
 */
export async function pushWecom(
  cfg: WecomConfig,
  content: string,
  timeoutMs = 15_000,
): Promise<PushResult> {
  if (!cfg.enabled) {
    return { ok: false, detail: null, error: '推送已关闭' };
  }
  if (!cfg.relayUrl) {
    return { ok: false, detail: null, error: '未配置转发器地址' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 🔴 必须带共享密钥，否则转发器 403（安全边界，不是可选项）
    if (cfg.relayToken) headers['X-Relay-Token'] = cfg.relayToken;
    const res = await fetch(cfg.relayUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      /* 不是 JSON 就保留原文 */
    }
    if (!res.ok) {
      return { ok: false, detail, error: `转发器返回 HTTP ${res.status}` };
    }
    // 转发器会回传企微的原始响应（errcode=0 才是真成功）
    const d = detail as { errcode?: number; errmsg?: string } | null;
    if (d && typeof d.errcode === 'number' && d.errcode !== 0) {
      return { ok: false, detail, error: `企微返回 errcode=${d.errcode} ${d.errmsg ?? ''}` };
    }
    return { ok: true, detail };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      detail: null,
      error: e.name === 'AbortError' ? `推送超时（${timeoutMs}ms）` : `${e.name}: ${e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成更新报告文本。
 *
 * 🔴 只在**真有更新**时才推（无更新不打扰）—— 作者拍板。
 */
export function formatUpdateReport(r: {
  task: string;
  newWorks: number;
  continued: number;
  newItems: number;
  durationMs: number;
  details?: string[];
  problem?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`【里番看板 · ${r.task}更新】`);

  if (r.problem) {
    lines.push(`⚠️ ${r.problem}`);
    lines.push('');
    lines.push(r.details?.length ? r.details.join('\n') : '');
    return lines.filter((l) => l !== '').join('\n');
  }

  lines.push(
    `新增作品 ${r.newWorks} 部 · 续更 ${r.continued} 部 · 新增条目 ${r.newItems} 条 · 耗时 ${Math.round(
      r.durationMs / 1000,
    )} 秒`,
  );
  if (r.details?.length) {
    lines.push('');
    lines.push(...r.details);
  }
  return lines.join('\n');
}
