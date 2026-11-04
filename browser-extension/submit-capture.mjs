// 用户实际提交登录时短暂记住账号，只有点击“加密保存”才写入知屿。
// 不读取 iframe、隐藏字段、注册/修改密码表单，也不截断超长密码。
(() => {
  if (window.top !== window || globalThis.__nanpadSubmitCapture) return;
  globalThis.__nanpadSubmitCapture = true;
  const chrome = globalThis.chrome;
  const fields = globalThis.__zhiyuFields;
  let enabled = true,
    lastGesture = 0,
    lastSent = "",
    lastSentAt = 0,
    sending = false;
  const secure =
    location.protocol === "https:" ||
    ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  const SUBMIT = /^(登录|登陆|立即登录|登\s*录|sign\s?in|log\s?in|login|continue)$/i;
  async function deliver(pair) {
    if (
      !enabled ||
      !secure ||
      sending ||
      !pair ||
      Date.now() - lastSentAt < 1000 ||
      document.documentElement.dataset.zhiyuWebWorkspace === "true"
    )
      return;
    const username = pair.username.value.trim(),
      password = pair.password.value;
    if (
      !username ||
      username.length > 320 ||
      /[\r\n\0]/.test(username) ||
      !password ||
      password.length > 4096
    )
      return;
    // 指纹仅用于本页面连点去重，内存中不额外保留密码副本。
    const bytes = new TextEncoder().encode(`${username}\0${password}`);
    sending = true;
    try {
      // 在提交回调的第一个 await 之前发送，尽量在页面导航前交给扩展后台。
      const request = chrome.runtime.sendMessage({
        type: "zhiyu-stage",
        capture: { title: document.title, username, password },
      });
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(".");
      const reply = await request;
      if (reply?.ok) {
        lastSentAt = Date.now();
        if (digest === lastSent) return;
        lastSent = digest;
        void globalThis.__zhiyuShowPending?.();
      }
    } catch {
      /* 浏览器休眠或扩展重载时，保留网页自身的登录行为。 */
    } finally {
      bytes.fill(0);
      sending = false;
    }
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Enter") lastGesture = Date.now();
    },
    true,
  );
  document.addEventListener(
    "input",
    () => {
      lastSentAt = 0;
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !enabled) return;
      lastGesture = Date.now();
      const target = event
        .composedPath()
        .find(
          (item) =>
            item instanceof Element && item.matches('button,input[type="submit"],[role="button"]'),
        );
      if (!target || !SUBMIT.test((target.textContent || target.value || "").trim())) return;
      const pair = fields.forms().find((item) => item.scope.contains(target));
      if (pair) void deliver(pair);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (!event.isTrusted || Date.now() - lastGesture > 1500 || !enabled) return;
      const form = event.composedPath().find((item) => item instanceof HTMLFormElement);
      if (form) void deliver(fields.forms().find((item) => item.password.form === form));
    },
    true,
  );
  void chrome.storage.local.get("nanpadAutoCapture").then((stored) => {
    enabled = stored.nanpadAutoCapture !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "nanpadAutoCapture" in changes)
      enabled = changes.nanpadAutoCapture.newValue !== false;
  });
})();
