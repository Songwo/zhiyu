// 仅扩展后台/弹窗能调用；不向普通网页开放 runtime API，不接受子框架。
(() => {
  if (window !== window.top) return;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.kind !== "zhiyu:extension-web-response"
    )
      return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    pending.delete(event.data.requestId);
    clearTimeout(item.timer);
    item.reply({ status: event.data.status, data: event.data.data });
  });
  globalThis.chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "zhiyu:web-call") return false;
    if (
      sender.id !== globalThis.chrome.runtime.id ||
      message.workspaceOrigin !== location.origin ||
      pending.size >= 16 ||
      JSON.stringify(message).length > 1300000
    ) {
      reply({ status: 403, data: { error: "Web 工作区来源或请求无效。" } });
      return false;
    }
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("");
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reply({ status: 503, data: { error: "Web 工作区未响应，请保持页面打开并解锁。" } });
    }, 5000);
    pending.set(requestId, { reply, timer });
    window.postMessage(
      {
        kind: "zhiyu:extension-web-request",
        requestId,
        extensionId: globalThis.chrome.runtime.id,
        path: message.path,
        token: message.token,
        body: message.body,
      },
      location.origin,
    );
    return true;
  });
})();
