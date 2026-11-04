// 内容脚本只收到账号候选；密码在用户明确选择后短暂用于当前文档的可见登录表单。
(() => {
  if (window.top !== window || globalThis.__zhiyuCompanion) return;
  globalThis.__zhiyuCompanion = true;
  const chrome = globalThis.chrome;
  const fields = globalThis.__zhiyuFields;
  const documentKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  const secure =
    location.protocol === "https:" ||
    ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  const ERRORS = {
    unpaired: "请先在插件中连接已解锁的知屿。",
    locked: "请解锁知屿并重新配对。",
    offline: "知屿暂未连接，请打开桌面端后重试。",
    insecure: "仅在 HTTPS 网站提供账号填写。",
    expired: "本次记录已过期或浏览器已休眠，请重新读取表单。",
    navigated: "网页已变化，请重新选择账号。",
    "no-form": "请先选中可见的登录框，并保持密码框为空。",
    rate: "操作过于频繁，请稍后再试。",
  };
  let prefs = { nanpadAutoSuggest: true, nanpadAutoDocument: true };
  let host,
    panel,
    content,
    dismissed = false,
    lastUrl = location.href,
    listed = false,
    busy = false;
  let preparedPair = null,
    suggestedPair = null;
  const message = async (type, extra = {}) => {
    try {
      return await chrome.runtime.sendMessage({ type, ...extra });
    } catch {
      return { ok: false, reason: "offline" };
    }
  };
  function remove() {
    host?.remove();
    host = panel = content = null;
  }
  function frame(title, description) {
    remove();
    host = document.createElement("div");
    host.setAttribute("data-zhiyu-companion", "");
    host.style.cssText =
      "all:initial;position:fixed;right:20px;bottom:20px;width:min(340px,calc(100vw - 32px));z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{color-scheme:light dark}*{box-sizing:border-box}.panel{--bg:#fff;--fg:#203330;--muted:#637570;--line:#dbe7e2;--accent:#1d7160;--soft:#f0f6f3;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 10px 42px #12382c29;animation:enter .2s ease-out}header{display:flex;gap:10px;align-items:center}header img{width:30px;height:30px;border-radius:8px}strong{font-size:14px}header button{margin-left:auto;width:32px;min-height:32px;padding:0}p{color:var(--muted);font-size:12px;margin:10px 0}button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:9px;padding:10px 12px;min-height:42px;transition:background .15s,transform .15s}button:hover{background:var(--line)}button:active{transform:scale(.98)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}.actions{display:grid;gap:7px;max-height:240px;overflow:auto}.account{text-align:left;display:grid;width:100%}.account span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account small{font-size:11px;color:var(--muted)}.primary{background:var(--accent);color:white;width:100%;border-color:var(--accent)}.primary:hover{background:#155a4c}.note{margin-bottom:0}.status{word-break:break-word}@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@media(prefers-color-scheme:dark){.panel{--bg:#1e2b28;--fg:#e5f0eb;--muted:#a4b6ae;--line:#3c5048;--accent:#348f78;--soft:#293b34}}@media(prefers-reduced-motion:reduce){.panel,button{animation:none;transition:none}}`;
    panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("aria-label", "知屿浏览器助手");
    const header = document.createElement("header");
    const logo = document.createElement("img");
    logo.src = chrome.runtime.getURL("icon.png");
    logo.alt = "";
    const label = document.createElement("strong");
    label.textContent = title;
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "本页不再提示";
    close.setAttribute("aria-label", "关闭知屿提示");
    close.dataset.action = "close";
    close.addEventListener("click", (event) => {
      if (event.isTrusted) {
        dismissed = true;
        remove();
      }
    });
    header.append(logo, label, close);
    const text = document.createElement("p");
    text.textContent = description;
    content = document.createElement("div");
    content.className = "actions";
    panel.append(header, text, content);
    root.append(style, panel);
    document.documentElement.append(host);
  }
  function button(label, action, style = "primary", key = "action") {
    const el = document.createElement("button");
    el.textContent = label;
    el.className = style;
    el.dataset.action = key;
    el.addEventListener("click", async (event) => {
      if (!event.isTrusted || busy) return;
      busy = true;
      el.disabled = true;
      try {
        await action();
      } finally {
        busy = false;
        el.disabled = false;
      }
    });
    content.append(el);
    return el;
  }
  function status(text) {
    const item = document.createElement("p");
    item.className = "status";
    item.setAttribute("role", "status");
    item.textContent = text;
    panel?.querySelector(".status")?.remove();
    panel?.append(item);
  }
  const report = (reply) =>
    status(ERRORS[reply?.reason] || "本次操作未保存，请重试或检查桌面连接。");
  async function pending() {
    if (!secure || dismissed) return false;
    const reply = await message("zhiyu-pending");
    if (!reply?.pending) return false;
    frame("保存到知屿", `${reply.pending.username} · ${location.hostname}`);
    button(
      "加密保存账号",
      async () => {
        const result = await message("zhiyu-save-pending");
        if (!result?.ok) return report(result);
        status(
          result.status === "existing" || result.status === "duplicate"
            ? "这个账号已保存在知屿。"
            : "账号已加密保存。同账号的不同密码会保留为新版本。",
        );
        setTimeout(remove, 5000);
      },
      "primary",
      "save-account",
    );
    button(
      "这次不保存",
      async () => {
        await message("zhiyu-dismiss-pending");
        remove();
      },
      "",
      "dismiss-account",
    );
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "临时保留最多 2 分钟；浏览器休眠后需重新读取。";
    panel.append(note);
    return true;
  }
  globalThis.__zhiyuShowPending = pending;
  function isDocument() {
    return /(^|\.)(docs\.qq\.com|mp\.weixin\.qq\.com|feishu\.cn|larksuite\.com|yuque\.com|shimo\.im)$/.test(
      location.hostname,
    );
  }
  function readDocument() {
    const selectors = [
      "#js_content",
      ".lake-content",
      ".lark-editor",
      ".wiki-content",
      ".doc-content",
      "[data-page-content]",
      "[role='document']",
      "article",
      "main",
    ];
    const root = selectors
      .map((selector) => document.querySelector(selector))
      .find((el) => el && fields.visible(el));
    const texts = [];
    let length = 0,
      truncated = false;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let inspected = 0;
      while (walker.nextNode()) {
        if (++inspected > 50000) {
          truncated = true;
          break;
        }
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            "script,style,noscript,form,input,textarea,select,button,nav,aside,[hidden],[aria-hidden='true'],[data-zhiyu-companion]",
          ) ||
          !fields.visible(parent)
        )
          continue;
        const text = node.textContent.replace(/[\t\r ]+/g, " ").trim();
        if (!text) continue;
        if (length + text.length + 2 > 199800) {
          truncated = true;
          break;
        }
        texts.push(text);
        length += text.length + 2;
      }
    }
    return {
      ok: true,
      title: (document.title || location.hostname).slice(0, 120),
      text: texts.join("\n\n"),
      partial: truncated || !root || Boolean(root?.querySelector("canvas")) || isDocument(),
    };
  }
  async function showDocument() {
    if (!isDocument() || prefs.nanpadAutoDocument === false || dismissed) return;
    frame("留一份文档到知屿", "保存当前已加载的可见正文和来源链接，便于关联账号与资料。");
    button(
      "保存当前文档",
      async () => {
        const result = await message("zhiyu-document");
        if (!result?.ok) return report(result);
        status(
          result.status === "existing"
            ? "此来源已保存，未覆盖已有文档。"
            : result.sourceOnly
              ? "正文无法读取，已保存来源链接。"
              : "已保存当前可见正文与来源；未加载内容不在本次快照中。",
        );
        dismissed = true;
      },
      "primary",
      "save-document",
    );
  }
  async function suggest() {
    if (document.documentElement.dataset.zhiyuWebWorkspace === "true") {
      remove();
      return;
    }
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      listed = false;
      dismissed = false;
      preparedPair = null;
      remove();
      void showDocument();
    }
    if (dismissed || busy) return;
    const pair = secure && prefs.nanpadAutoSuggest !== false ? fields.target() : null;
    if (suggestedPair && pair?.password !== suggestedPair.password) {
      listed = false;
      suggestedPair = null;
      remove();
    }
    if (!pair || pair.password.value || listed) return;
    listed = true;
    suggestedPair = pair;
    const href = location.href;
    const reply = await message("zhiyu-list");
    if (!reply?.ok || !reply.accounts?.length)
      setTimeout(() => {
        listed = false;
      }, 15000);
    if (
      href !== location.href ||
      dismissed ||
      !reply?.ok ||
      !reply.accounts?.length ||
      pair.password.value
    )
      return;
    frame("选择登录账号", `${location.hostname} · 选择后填写，不会自动登录`);
    for (const item of reply.accounts) {
      const el = button(
        "",
        async () => {
          preparedPair = pair;
          // 票据短期有效，每次明确选择时刷新，只允许后台当前候选 id。
          const fresh = await message("zhiyu-list");
          if (!fresh?.ok) return report(fresh);
          const result = await message("zhiyu-fill", { id: item.id });
          if (!result?.ok) return report(result);
          remove();
        },
        "account",
        "fill-account",
      );
      const username = document.createElement("span");
      username.textContent = item.username;
      const title = document.createElement("small");
      title.textContent = item.title || "已加密保存的账号";
      el.append(username, title);
    }
  }
  let timer;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void suggest(), 350);
  }
  const observers = new WeakSet();
  function observe() {
    for (const root of fields.roots()) {
      if (observers.has(root)) continue;
      observers.add(root);
      new MutationObserver((records) => {
        if (records.some((record) => record.target !== host && !host?.contains(record.target)))
          schedule();
      }).observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["hidden", "type", "style", "class", "autocomplete"],
      });
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && !sender.url.startsWith(chrome.runtime.getURL(""))) ||
      message.url !== location.href
    )
      return false;
    if (message.type === "zhiyu-page-ready") {
      if (!preparedPair || !fields.forms().some((item) => item.password === preparedPair.password))
        preparedPair = fields.target();
      respond({
        ready: Boolean(
          preparedPair &&
          !preparedPair.password.value &&
          fields.forms().some((item) => item.password === preparedPair.password),
        ),
        documentKey,
      });
      return false;
    }
    if (message.type === "zhiyu-page-fill") {
      const ok =
        secure &&
        message.documentKey === documentKey &&
        fields.fill(preparedPair, message.credential || {});
      preparedPair = null;
      respond({ ok });
      return false;
    }
    if (message.type === "zhiyu-page-document") {
      respond(readDocument());
      return false;
    }
    if (message.type === "zhiyu-page-pending") {
      void pending();
      respond({ ok: true });
    }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of ["nanpadAutoSuggest", "nanpadAutoDocument"])
      if (key in changes) prefs[key] = changes[key].newValue !== false;
    remove();
    listed = false;
    dismissed = false;
    void suggest();
  });
  document.addEventListener("focusin", schedule, true);
  window.addEventListener("pagehide", () => {
    preparedPair = null;
    remove();
  });
  window.addEventListener("popstate", () => {
    dismissed = false;
    listed = false;
    schedule();
  });
  void chrome.storage.local
    .get(["nanpadAutoSuggest", "nanpadAutoDocument"])
    .then(async (stored) => {
      prefs = stored;
      observe();
      if (!(await pending())) {
        await suggest();
        if (!host) await showDocument();
      }
    });
  // SPA 的开放 Shadow DOM 和 history API 变化不会产生普通导航事件。
  setInterval(() => {
    if (!document.hidden) {
      observe();
      schedule();
    }
  }, 2000);
})();
