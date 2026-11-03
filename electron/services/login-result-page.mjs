import { randomBytes } from "node:crypto";

// 与应用现有 favicon 共用的知屿标志；页面不加载外部图片或字体。
const BRAND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 48 48" fill="none"><circle cx="45.5" cy="19" r="5.2" fill="#FFB23F"/><path d="M31 34.4C26.2 30 18.6 28.6 10 30.2V41.8C18.6 40.4 26 41.6 31 45.8Z" fill="#3B6FE0"/><path d="M33 34.4C37.8 30 45.4 28.6 54 30.2V41.8C45.4 40.4 38 41.6 33 45.8Z" fill="#8DB0F5"/><path d="M12.5 51C17.6 48.1 22.8 48.1 28 51S38.4 53.9 43.6 51S50.2 48.9 51.5 48.9" stroke="#2BB3C0" stroke-width="3.4" stroke-linecap="round"/></svg>`;
const escape = (/** @type {string} */ value) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char,
  );

/** 回调页只接收固定文案，不插入 code、state、账户或供应商响应。
 * @param {{message: string, success?: boolean}} options
 */
export function loginResultPage({ message, success = false }) {
  const nonce = randomBytes(18).toString("base64");
  const title = success ? "身份验证成功" : "本次登录未完成";
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  return {
    csp,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · 知屿 Zhiyu</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f5f5f2;--paper:#fff;--ink:#222a2c;--muted:#6c7678;--line:#e4e8e7;--accent:#32766b;--soft:#edf5f1;--blue:#3b6fe0;--shadow:#263b3512}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.03em}.brand img{width:34px;height:34px}.brand span{color:var(--muted);font-weight:450;margin-left:4px}.shell{width:100%;max-width:560px;margin:auto;padding:40px 0}.card{background:var(--paper);border:1px solid var(--line);border-radius:24px;box-shadow:0 16px 56px var(--shadow);overflow:hidden}.content{padding:40px}.eyebrow{font-size:11px;letter-spacing:.12em;font-weight:650;color:var(--muted);margin:0 0 28px}.mark{width:60px;height:60px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--accent);margin-bottom:24px}.check{width:24px;height:14px;border-left:3px solid currentColor;border-bottom:3px solid currentColor;transform:translateY(-3px) rotate(-45deg)}.error-mark{font-size:30px;font-weight:500}h1{font-size:30px;line-height:1.25;letter-spacing:-.04em;margin:0 0 14px}p{margin:0}.message{color:var(--muted);max-width:410px}.next{margin-top:28px;padding:18px 20px;background:var(--bg);border:1px solid var(--line);border-radius:14px;display:flex;align-items:flex-start;gap:12px}.step{flex:none;width:24px;height:24px;display:grid;place-items:center;border:1px solid var(--line);background:var(--paper);border-radius:50%;font-size:12px;font-weight:600}.next strong{font-size:14px;font-weight:600;display:block}.next p{font-size:13px;color:var(--muted);margin-top:3px}.actions{margin-top:28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}button{min-height:44px;border:0;border-radius:11px;padding:11px 22px;background:var(--ink);color:var(--paper);font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .18s,transform .18s}button:hover{opacity:.86}button:active{transform:translateY(1px)}button:focus-visible{outline:3px solid var(--blue);outline-offset:4px}.hint{font-size:12px;color:var(--muted)}.fallback{margin-top:14px;font-size:13px;color:var(--muted)}.bottom{border-top:1px solid var(--line);padding:16px 40px;font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:center}.dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}footer{text-align:center;font-size:11px;color:var(--muted);padding-top:20px;letter-spacing:.04em}
@media(prefers-color-scheme:dark){:root{--bg:#191d1c;--paper:#242a28;--ink:#edf3ef;--muted:#a4b3ab;--line:#39433d;--accent:#94cbb6;--soft:#2d4036;--shadow:#0003}}
@media(max-width:520px){body{padding:20px}.shell{padding:28px 0}.content{padding:28px 24px}h1{font-size:27px}.bottom{padding:16px 24px}.actions{align-items:flex-start;flex-direction:column;gap:10px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body data-result="${success ? "success" : "incomplete"}">
<header class="brand"><img alt="" src="data:image/svg+xml,${encodeURIComponent(BRAND)}">知屿<span>Zhiyu</span></header>
<main class="shell"><article class="card"><div class="content"><p class="eyebrow">LINUX DO CONNECT · 身份连接</p><div class="mark" aria-hidden="true">${success ? '<span class="check"></span>' : '<span class="error-mark">!</span>'}</div><h1>${title}</h1><p class="message" role="status">${escape(message)}</p>
<div class="next"><span class="step">${success ? "2" : "↗"}</span><div><strong>${success ? "回到知屿，确认绑定" : "回到知屿，重新发起"}</strong><p>${success ? "核对头像、昵称与同步选项，确认后才会保存主身份。" : "已有身份与本机资料保留。请使用新授权页面继续。"}</p></div></div>
<div class="actions"><button id="close-page" type="button">关闭此页</button><span class="hint">你可以安全关闭这个标签页</span></div><p id="close-fallback" class="fallback" role="status" hidden>浏览器未允许自动关闭，请手动关闭此标签页，然后返回知屿。</p></div>
<div class="bottom"><span class="dot" aria-hidden="true"></span>${success ? "浏览器验证已完成 · 等待应用内确认" : "本次授权未保存 · 可重新尝试"}</div></article><footer>连接你的数字生活</footer></main>
<script nonce="${nonce}">try{history.replaceState(null,'',location.pathname)}catch{}document.getElementById('close-page').addEventListener('click',()=>{window.close();setTimeout(()=>{document.getElementById('close-fallback').hidden=false},180)});</script></body></html>`,
  };
}
