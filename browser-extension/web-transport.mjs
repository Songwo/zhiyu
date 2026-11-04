export const WEB_WORKSPACE_KEY = "zhiyuWebWorkspace";
const WEB_TAB_KEY = "zhiyuWebWorkspaceTab";

export function workspaceOrigin(value) {
  if (!value) return "";
  const url = new URL(value);
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Web 工作区需填写 HTTPS 站点地址；本机测试可使用 HTTP，不包含路径、账号或查询参数。",
    );
  return url.origin;
}

/** 内容脚本转发给已打开的 Web 标签页，不请求远程密码接口或上传连接令牌。 */
export function createBridgeFetch({ chrome, fetchImpl = fetch }) {
  return async (url, options = {}) => {
    const selected = (await chrome.storage.local.get(WEB_WORKSPACE_KEY))[WEB_WORKSPACE_KEY];
    if (!selected) return fetchImpl(url, options);
    const origin = workspaceOrigin(selected),
      path = new URL(url).pathname;
    if (options.method !== "POST" || options.signal?.aborted) throw new Error("插件请求已取消。");
    const token = /^Bearer ([a-f0-9]{64})$/.exec(options.headers?.Authorization || "")?.[1];
    const body = JSON.parse(options.body || "{}");
    let tabs;
    if (path === "/v1/pair") {
      tabs = (await chrome.tabs.query({}))
        .filter((tab) => {
          try {
            return (
              new URL(tab.url).origin === origin &&
              new URL(tab.url).pathname === "/" &&
              !tab.pendingUrl
            );
          } catch {
            return false;
          }
        })
        .slice(0, 8);
    } else {
      const paired = (await chrome.storage.session.get(WEB_TAB_KEY))[WEB_TAB_KEY];
      if (!paired || paired.origin !== origin) throw new Error("请打开并重新配对 Web 工作区。");
      tabs = [await chrome.tabs.get(paired.tabId)];
    }
    let last;
    for (const tab of tabs) {
      if (new URL(tab.url).origin !== origin || tab.pendingUrl) continue;
      if (options.signal?.aborted) throw new Error("插件请求已取消。");
      try {
        const result = await chrome.tabs.sendMessage(
          tab.id,
          {
            type: "zhiyu:web-call",
            workspaceOrigin: origin,
            path,
            body,
            ...(token ? { token } : {}),
          },
          { frameId: 0 },
        );
        if (
          !result ||
          !Number.isInteger(result.status) ||
          !result.data ||
          result.status < 200 ||
          result.status > 599
        )
          throw new Error("Web 工作区未响应，请保持标签页打开并解锁。");
        last = result;
        if (path === "/v1/pair" && result.status === 200)
          await chrome.storage.session.set({ [WEB_TAB_KEY]: { origin, tabId: tab.id } });
        if (result.status === 200 || result.status === 201 || path !== "/v1/pair") break;
      } catch (error) {
        if (path !== "/v1/pair") throw error;
      }
    }
    if (!last) throw new Error("请打开所选 Web 工作区、解锁密钥库并生成配对码。");
    if (options.signal?.aborted) throw new Error("插件请求已取消。");
    return new Response(JSON.stringify(last.data), {
      status: last.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

export const bridgeFetch = (url, options) =>
  createBridgeFetch({ chrome: globalThis.chrome })(url, options);
