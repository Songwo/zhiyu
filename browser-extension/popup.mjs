import { normalizeCapture, captureUrl } from "./browser-capture.mjs";
import { collectLoginForms } from "./form-capture.mjs";
import { BRIDGE } from "./bridge-config.mjs";
import { bridgeFetch, workspaceOrigin, WEB_WORKSPACE_KEY } from "./web-transport.mjs";

const bridge = BRIDGE;
const chrome = globalThis.chrome;
const tokenKey = "nanpadConnectionToken";
const autoKey = "nanpadAutoCapture";
const $ = (selector) => document.querySelector(selector);
const title = $("#title");
const username = $("#username");
const password = $("#password");
const status = $("#status");
const send = $("#send");
const pairing = $("#pairing");
let webWorkspace = (await chrome.storage.local.get(WEB_WORKSPACE_KEY))[WEB_WORKSPACE_KEY] || "";
$("#workspace-mode").value = webWorkspace ? "web" : "desktop";
$("#workspace-url").value = webWorkspace;
$("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next =
      $("#workspace-mode").value === "web" ? workspaceOrigin($("#workspace-url").value.trim()) : "";
    if ($("#workspace-mode").value === "web" && !next) throw new Error("请填写 Web 工作区地址。");
    await chrome.storage.local.set({ [WEB_WORKSPACE_KEY]: next });
    webWorkspace = next;
    await chrome.storage.session.remove([tokenKey, "zhiyuWebWorkspaceTab"]);
    await forgetConnection();
    connection("连接方式已保存，请重新配对");
    message("在已解锁的知屿中生成新配对码。Web 方式不会访问服务器明文密码接口。");
  } catch (error) {
    message(error.message, "error");
  }
});
let capture = null;
let tabId;
let token = "";
let connected = false;
// 初始化期间先禁用配对，避免旧的会话读取迟到后覆盖新连接。
let busy = true;
let candidates = [];

function message(text, state = "") {
  status.textContent = text;
  status.dataset.state = state;
}
function controls() {
  send.disabled = busy || !capture || !connected;
  $("#refresh").disabled = busy || !capture;
  $("#site-only").disabled = busy || !capture;
  $("#pair-button").disabled = busy;
  $("#disconnect").disabled = busy;
  $("#save-document").disabled = busy || !capture || !connected;
  $("#save-pending").disabled = busy || !connected;
}
function connection(text, state = "") {
  if (webWorkspace)
    text = text.replaceAll("桌面端", "Web 工作区").replaceAll("桌面连接", "Web 工作区连接");
  $("#connection-state").textContent = text;
  $("#connection-indicator").dataset.state = state;
  $("#disconnect").hidden = !token;
  pairing.hidden = connected;
  controls();
}
async function forgetConnection() {
  token = "";
  connected = false;
  await chrome.storage.session.remove(tokenKey);
  pairing.hidden = false;
  pairing.open = true;
  $("#saved-accounts").replaceChildren();
  $("#pending-account").hidden = true;
}
async function request(path, options = {}, authenticated = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await bridgeFetch(`${bridge}${path}`, {
      ...options,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 401) {
      await forgetConnection();
      connection("连接已失效，请重新配对", "error");
      throw new Error(
        webWorkspace
          ? "请在已解锁的 Web 工作区生成新的配对码。"
          : "请在已解锁的知屿桌面端生成新的配对码。",
      );
    }
    if (response.status === 423) {
      await forgetConnection();
      connection("密钥库已锁定", "error");
      throw new Error("请解锁知屿，再生成新的配对码连接。");
    }
    if (response.status === 429) throw new Error("操作过于频繁，请稍后再试。");
    if (!response.ok)
      throw new Error(
        path === "/v1/pair"
          ? "配对码无效或已过期，请在桌面端重新生成。"
          : "桌面端未接收，请检查待确认记录或重新连接。",
      );
    return await response.json();
  } catch (error) {
    if (error instanceof TypeError || error.name === "AbortError") {
      connected = false;
      connection("桌面端未连接", "error");
      if (webWorkspace)
        throw new Error("无法连接 Web 工作区，请打开所选站点并解锁，刷新或锁库后重新配对。");
      throw new Error("无法连接知屿，请打开 1.3.0 或更新版本并解锁。请求未自动重试。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function hidePassword() {
  password.type = "password";
  $("#toggle-password").setAttribute("aria-pressed", "false");
  $("#toggle-password").setAttribute("aria-label", "显示密码");
  $("#toggle-password").title = "显示密码";
  $("#toggle-password img").src = "icons/eye.svg";
}
function choose(index) {
  const candidate = candidates[index];
  username.value = candidate?.username || "";
  password.value = candidate?.password || "";
  hidePassword();
  if (candidate?.oversized)
    message("表单字段超过支持长度，已留空；账号上限 320 字符，密码上限 4096 字符。", "error");
}
function showCandidates(records) {
  candidates = Array.isArray(records) ? records.slice(0, 8) : [];
  const choices = $("#choices");
  choices.replaceChildren();
  $("#form-choices").hidden = candidates.length < 2;
  candidates.forEach((candidate, index) => {
    const label = document.createElement("label");
    label.className = "choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "selected-form";
    radio.value = String(index);
    radio.checked = index === 0;
    radio.addEventListener("change", () => choose(index));
    const name = document.createElement("span");
    name.textContent = candidate.username || `表单 ${index + 1}`;
    const kind = document.createElement("small");
    kind.textContent = candidate.kind === "new" ? "注册 / 新密码" : "登录";
    label.append(radio, name, kind);
    choices.append(label);
  });
  choose(0);
  $(".capture-details").open = candidates.some((item) => item.username || item.password);
  $("#capture-hint").textContent = candidates.length
    ? `已读取 ${candidates.length} 个表单`
    : "手动填写";
}
async function readTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const previousUrl = capture?.url;
  capture = normalizeCapture(tab);
  tabId = tab.id;
  if (previousUrl !== capture.url || !title.value.trim()) title.value = capture.title;
  $("#url").textContent = capture.url;
  $("#url").title = capture.url;
  try {
    const [{ result: workspace } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => document.documentElement.dataset.zhiyuWebWorkspace === "true",
    });
    if (workspace || (webWorkspace && new URL(tab.url).origin === webWorkspace)) {
      showCandidates([]);
      password.value = "";
      username.value = "";
      message("当前是知屿工作区，不读取主密码表单；请切换到需要填写的网站。");
      return;
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: collectLoginForms,
    });
    showCandidates(result);
    if (!candidates[0]?.oversized)
      message(
        candidates.length
          ? "请核对账号密码，一次点击即可加密保存。"
          : "未找到可读取的登录表单，可以手动填写账号密码。",
      );
  } catch {
    showCandidates([]);
    message("浏览器限制了此页的表单访问，可以手动填写账号密码。");
  }
}
async function currentCapture() {
  const tab = await chrome.tabs.get(tabId);
  const current = normalizeCapture(tab);
  if (current.url !== capture?.url) throw new Error("当前网页已切换站点，请重新读取后核对账号。");
  return { ...current, title: title.value.trim() || current.title };
}
$("#refresh").addEventListener("click", async () => {
  busy = true;
  controls();
  try {
    await readTab();
    await loadAccounts();
  } catch {
    capture = null;
    showCandidates([]);
    message("请在 HTTP 或 HTTPS 网站中打开插件。", "error");
  } finally {
    busy = false;
    controls();
  }
});
$("#toggle-password").addEventListener("click", () => {
  const reveal = password.type === "password";
  password.type = reveal ? "text" : "password";
  const label = reveal ? "隐藏密码" : "显示密码";
  $("#toggle-password").setAttribute("aria-pressed", String(reveal));
  $("#toggle-password").setAttribute("aria-label", label);
  $("#toggle-password").title = label;
  $("#toggle-password img").src = reveal ? "icons/eye-off.svg" : "icons/eye.svg";
});
$("#pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  controls();
  try {
    const { token: nextToken } = await request(
      "/v1/pair",
      { method: "POST", body: JSON.stringify({ code: $("#pair-code").value.trim() }) },
      false,
    );
    if (typeof nextToken !== "string" || nextToken.length < 32 || nextToken.length > 256)
      throw new Error("桌面端返回的连接信息无效。");
    await chrome.storage.session.set({ [tokenKey]: nextToken });
    token = nextToken;
    $("#pair-code").value = "";
    const state = await request("/v1/status", { method: "POST", body: "{}" });
    if (!state.unlocked) throw new Error("请先解锁桌面端密钥库。");
    connected = true;
    pairing.open = false;
    connection(webWorkspace ? "已连接 Web 工作区" : "已连接本机知屿", "connected");
    await loadAccounts();
    message("已配对，当前站点的账号与文档可以保存到知屿。", "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    busy = false;
    controls();
  }
});
$("#disconnect").addEventListener("click", async () => {
  await forgetConnection();
  connection("已断开桌面连接");
  message("已移除此浏览器会话的连接凭据。");
});
const autoToggle = $("#auto-capture");
autoToggle.addEventListener("change", () => {
  // 偏好跟随浏览器本地保存；内容脚本通过 storage 监听即时生效。
  // 默认开启：勾选时移除键回到默认，取消勾选时显式存 false。
  void (autoToggle.checked
    ? chrome.storage.local.remove(autoKey)
    : chrome.storage.local.set({ [autoKey]: false }));
});
void chrome.storage.local.get(autoKey).then((stored) => {
  autoToggle.checked = stored[autoKey] !== false;
});
$("#capture").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!capture || !connected || busy) return;
  if (!username.value.trim() || !password.value) {
    message("请填写账号和密码；只保存网址请使用“仅记录站点并打开知屿”。", "error");
    (!username.value.trim() ? username : password).focus();
    return;
  }
  busy = true;
  controls();
  try {
    const site = await currentCapture();
    const result = await companion("zhiyu-save-account", {
      capture: { ...site, username: username.value.trim(), password: password.value },
    });
    if (typeof result.id !== "string" || !result.id)
      throw new Error("未收到加密保存确认，请检查连接后重试。");
    candidates = [];
    password.value = "";
    $("#choices").replaceChildren();
    $("#form-choices").hidden = true;
    hidePassword();
    $(".capture-details").open = false;
    await loadAccounts();
    message("已加密保存到知屿；同账号的不同密码会保留为新版本。", "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    busy = false;
    controls();
  }
});
$("#site-only").addEventListener("click", async () => {
  try {
    if (webWorkspace) {
      const current = await currentCapture();
      await request("/v1/documents", {
        method: "POST",
        body: JSON.stringify({ url: current.url, title: current.title, text: "" }),
      });
      message("已保存来源链接到 Web 工作区。", "success");
    } else {
      await chrome.tabs.create({ url: captureUrl(await currentCapture()) });
      message("已请求打开知屿，请在桌面端继续记录站点。");
    }
  } catch (error) {
    message(error.message || "无法打开知屿，请安装桌面端并允许打开外部应用。", "error");
  }
});
window.addEventListener("pagehide", () => {
  candidates = [];
  password.value = "";
  $("#pair-code").value = "";
  token = "";
});

await Promise.allSettled([
  (async () => {
    try {
      await readTab();
    } catch {
      capture = null;
      message("请在 HTTP 或 HTTPS 网站中打开插件。", "error");
    } finally {
      controls();
    }
  })(),
  (async () => {
    try {
      const stored = await chrome.storage.session.get(tokenKey);
      token = typeof stored[tokenKey] === "string" ? stored[tokenKey] : "";
      if (!token) {
        pairing.open = true;
        connection("尚未连接桌面端");
        return;
      }
      const state = await request("/v1/status", { method: "POST", body: "{}" });
      if (!state.unlocked) {
        await forgetConnection();
        connection("请解锁桌面端", "error");
        return;
      }
      connected = true;
      connection(webWorkspace ? "已连接 Web 工作区" : "已连接本机知屿", "connected");
    } catch (error) {
      connection(
        webWorkspace && error.message.includes("解锁")
          ? "密钥库已锁定，请重新配对"
          : "桌面连接不可用",
        "error",
      );
      message(error.message, "error");
    }
  })(),
]);

const companionErrors = {
  unpaired: "请连接已解锁的知屿桌面端。",
  locked: "请解锁知屿，再重新配对。",
  offline: "桌面端未连接，请打开知屿后重试。",
  expired: "记录已过期，请重新读取当前页。",
  insecure: "为保护密码，仅支持在 HTTPS 网站保存和填写账号。",
  navigated: "页面已切换，请重新读取后操作。",
  "no-form": "没有可安全填写的登录表单；请先选中可见登录框，保持密码框为空。",
};
async function companion(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (result?.reason === "unpaired" || result?.reason === "locked") {
    await forgetConnection();
    connection(
      result.reason === "locked" ? "请解锁桌面端并重新配对" : "连接已失效，请重新配对",
      "error",
    );
  }
  if (!result?.ok)
    throw Error(companionErrors[result?.reason] || "操作未完成，请重新读取当前页或检查桌面连接。");
  return result;
}
async function loadAccounts() {
  const list = $("#saved-accounts");
  list.replaceChildren();
  $("#account-empty").textContent = connected ? "正在查找本站账号…" : "连接桌面端后显示本站账号";
  $("#save-document").disabled = !connected || !capture;
  $("#pending-account").hidden = true;
  if (!capture || !connected) return;
  try {
    const { accounts } = await companion("zhiyu-list");
    $("#account-empty").textContent = accounts.length
      ? "选择一个账号填写，网站不会自动提交登录。"
      : "本站暂无账号。登录后可自动提示保存。";
    for (const account of accounts) {
      const button = document.createElement("button");
      button.className = "saved-account";
      const name = document.createElement("strong");
      name.textContent = account.username;
      const label = document.createElement("span");
      label.textContent = account.title || "已加密保存";
      button.append(name, label);
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || busy) return;
        busy = true;
        controls();
        button.disabled = true;
        try {
          await currentCapture();
          await companion("zhiyu-list");
          await companion("zhiyu-fill", { id: account.id });
          message("已填写到当前登录表单，请核对后自行登录。", "success");
        } catch (error) {
          message(error.message, "error");
        } finally {
          busy = false;
          button.disabled = false;
          controls();
        }
      });
      list.append(button);
    }
    const result = await companion("zhiyu-pending");
    if (result.pending) {
      $("#pending-name").textContent = result.pending.username;
      $("#pending-account").hidden = false;
    }
  } catch (error) {
    $("#account-empty").textContent = error.message;
  }
}
$("#save-pending").addEventListener("click", async (event) => {
  if (!event.isTrusted || busy) return;
  busy = true;
  controls();
  try {
    await companion("zhiyu-save-pending");
    $("#pending-account").hidden = true;
    message("账号已加密保存；不同密码会保留为新版本。", "success");
    await loadAccounts();
  } catch (error) {
    message(error.message, "error");
  } finally {
    busy = false;
    controls();
  }
});
$("#save-document").addEventListener("click", async (event) => {
  if (!event.isTrusted || busy) return;
  busy = true;
  controls();
  $("#save-document").disabled = true;
  try {
    const result = await companion("zhiyu-document");
    message(
      result.status === "existing"
        ? "此来源已保存，未覆盖已有文档。"
        : result.sourceOnly
          ? "正文无法读取，已保存来源链接。"
          : "已保存当前可见正文与来源链接；未加载部分不包含在快照内。",
      "success",
    );
  } catch (error) {
    message(error.message, "error");
  } finally {
    busy = false;
    controls();
    $("#save-document").disabled = !connected;
  }
});
for (const [id, key] of [
  ["auto-suggest", "nanpadAutoSuggest"],
  ["auto-document", "nanpadAutoDocument"],
]) {
  const toggle = $("#" + id);
  const stored = await chrome.storage.local.get(key);
  toggle.checked = stored[key] !== false;
  toggle.addEventListener(
    "change",
    () =>
      void (toggle.checked
        ? chrome.storage.local.remove(key)
        : chrome.storage.local.set({ [key]: false })),
  );
}
await loadAccounts();
busy = false;
controls();
