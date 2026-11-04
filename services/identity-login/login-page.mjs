import { randomBytes } from "node:crypto";

/** 只接收服务端固定文案，绝不显示回调参数、令牌或用户资料。 */
export function loginPage(message, success = false) {
  const nonce = randomBytes(18).toString("base64");
  const text = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>知屿 · Linux.do 登录</title><style>
      :root{color-scheme:light dark;--bg:#f4f6f5;--card:#fff;--ink:#183831;--muted:#62746d;--line:#dfe7e2;--accent:#27765f}
      *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.75 system-ui,sans-serif;padding:24px}
      main{width:min(100%,480px);padding:40px;border:1px solid var(--line);border-radius:24px;background:var(--card);box-shadow:0 20px 70px #173a440d}header{font-size:14px;font-weight:600;letter-spacing:.12em}.mark{margin:32px 0 20px;width:56px;height:56px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;color:var(--accent);font-size:28px}h1{font-size:26px;line-height:1.35;margin:0 0 16px}p{margin:0;color:var(--muted)}button{width:100%;margin-top:28px;padding:12px 20px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}small{display:block;margin-top:16px;color:var(--muted);font-size:13px}
      @media(prefers-color-scheme:dark){:root{--bg:#151b18;--card:#1e2722;--ink:#e3eee8;--muted:#a6b8ac;--line:#35443b;--accent:#4c9b7b}}@media(max-width:420px){main{padding:28px}h1{font-size:24px}}
      </style></head><body><main><header>知屿 ZHIYU</header><div class="mark" aria-hidden="true">${success ? "✓" : "i"}</div><h1>${success ? "身份验证成功" : "Linux.do 主身份登录"}</h1><p>${text}</p><button type="button" id="close">关闭此页面</button><small id="hint">返回原知屿页面继续操作。</small></main><script nonce="${nonce}">history.replaceState(null,'',location.pathname);document.getElementById('close').addEventListener('click',()=>{window.close();document.getElementById('hint').textContent='浏览器未允许自动关闭，请手动关闭此标签页并返回知屿。';});</script></body></html>`,
  };
}
