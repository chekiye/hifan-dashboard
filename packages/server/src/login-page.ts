/**
 * 登录页 HTML —— 与看板同一套视觉（亮色，用户反感黑底）
 *
 * 照 SW 的做法（独立登录页 + `next` 回跳），但样式跟本项目而不是 SW 的品牌。
 * 刻意单文件内联：不引外部 CSS/字体，登录前不加载任何外部资源。
 */

export function loginPage(opts: {
  /** 原始请求路径，登录后回跳 */
  next: string;
  /** 错误文案（URL 传进来） */
  error: string;
  /** 锁定剩余秒数 > 0 时展示 */
  retryAfterSec: number;
}): string {
  const { next, error, retryAfterSec } = opts;
  const locked = retryAfterSec > 0;

  const errBox = error
    ? `<div class="err">${escapeHtml(error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>登录 · 里番缺口看板</title>
<style>
:root{
  --canvas:#F6F7F9; --solid:#FFF; --line:#E4E7EC; --line2:#D0D5DD;
  --ink:#101828; --ink2:#475467; --ink3:#98A2B3;
  --c1:#378ADD; --c1b:#185FA5; --c1s:#E6F1FB;
  --c3:#D85A30; --c3b:#993C1D; --c3s:#FAECE7;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--sans); background:var(--canvas); color:var(--ink);
  min-height:100vh; display:flex; align-items:center; justify-content:center;
  padding:24px; -webkit-font-smoothing:antialiased;
}
.box{
  width:100%; max-width:380px; background:var(--solid);
  border:1px solid var(--line); border-radius:16px; padding:32px 28px;
  box-shadow:0 1px 3px rgba(16,24,40,.06),0 12px 28px -12px rgba(16,24,40,.12);
}
.head{display:flex; align-items:center; gap:12px; margin-bottom:6px}
.mark{
  width:38px; height:38px; border-radius:10px; flex:0 0 auto;
  background:var(--c1s); color:var(--c1b);
  display:flex; align-items:center; justify-content:center;
  font-weight:800; font-size:15px; letter-spacing:-.03em;
}
h1{font-size:19px; font-weight:760; letter-spacing:-.02em}
.sub{font-size:12.5px; color:var(--ink3); margin-bottom:24px}
label{display:block; font-size:13px; font-weight:550; color:var(--ink2); margin-bottom:7px}
input{
  width:100%; padding:11px 13px; margin-bottom:16px;
  border:1px solid var(--line2); border-radius:10px;
  font-family:var(--sans); font-size:15px; color:var(--ink);
  background:var(--canvas); outline:0; transition:border-color .15s,box-shadow .15s;
}
input:focus{
  border-color:var(--c1);
  box-shadow:0 0 0 3px rgba(55,138,221,.14);
  background:var(--solid);
}
button{
  width:100%; padding:11px 14px; border:0; border-radius:10px;
  background:var(--ink); color:#fff; font-family:var(--sans);
  font-size:15px; font-weight:600; cursor:pointer;
  transition:opacity .15s;
}
button:hover{opacity:.88}
button:disabled{opacity:.45; cursor:not-allowed}
.err{
  background:var(--c3s); color:var(--c3b); border-radius:9px;
  padding:9px 12px; font-size:13px; margin-bottom:16px; line-height:1.5;
}
.tip{
  margin-top:18px; padding-top:16px; border-top:1px solid var(--line);
  font-size:12px; color:var(--ink3); line-height:1.6;
}
</style>
</head>
<body>
  <form class="box" method="post" action="/login">
    <div class="head">
      <div class="mark">里番</div>
      <h1>里番缺口看板</h1>
    </div>
    <div class="sub">TMDB 2000+ 全览 · 本地缺集对照</div>

    ${errBox}

    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="u">账号</label>
    <input id="u" name="username" autocomplete="username" autofocus required
           ${locked ? 'disabled' : ''}>

    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required
           ${locked ? 'disabled' : ''}>

    <button type="submit" ${locked ? 'disabled' : ''}>${
      locked ? `已锁定，请 ${retryAfterSec} 秒后重试` : '登录'
    }</button>

    <div class="tip">
      局域网内直接访问 <code>你的局域网IP:8848</code> 无需登录。<br>
      本页仅用于公网访问时的身份验证。
    </div>
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}
