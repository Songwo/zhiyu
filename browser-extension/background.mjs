// 连接凭据只存于扩展会话区，账号和选择票据只存于后台内存。
import { BRIDGE } from "./bridge-config.mjs";
import { createCompanionRouter } from "./companion-router.mjs";
import { bridgeFetch, WEB_WORKSPACE_KEY } from "./web-transport.mjs";

const chrome = globalThis.chrome;
const router = createCompanionRouter({ chrome, bridge: BRIDGE, fetchImpl: bridgeFetch });
chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading" || change.url) router.invalidate(id, false, change.url);
});
chrome.tabs.onRemoved.addListener((id) => router.invalidate(id, true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && "nanpadConnectionToken" in changes) router.clear();
  if (area === "local" && changes.nanpadAutoCapture?.newValue === false) router.clear();
  if (area === "local" && WEB_WORKSPACE_KEY in changes) {
    router.clear();
    void chrome.storage.session.remove(["nanpadConnectionToken", "zhiyuWebWorkspaceTab"]);
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!router.accepts(message)) return false;
  void router
    .handle(message, sender)
    .then(sendResponse, () => sendResponse({ ok: false, reason: "rejected" }));
  return true;
});
