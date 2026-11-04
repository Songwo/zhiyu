import { normalizeCapture } from "./browser-capture.mjs";

const hex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const keys = (v, names) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === names.length &&
  names.every((key) => Object.hasOwn(v, key));
const fail = (status, message) => Object.assign(new Error(message), { status });
const site = (value) => {
  if (typeof value !== "string" || value.length > 4096) throw fail(400, "网站地址无效。");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw fail(400, "账号填写仅支持 HTTPS 或本机测试网站。");
  return url.origin;
};

/** 已解锁 Web 标签页的插件会话；凭据与授权仅存在当前标签页内存。 */
export class WebExtensionSession {
  #vault;
  #accounts;
  #saveDocument;
  #notify;
  #now;
  #random;
  #clients = new Map();
  #pending = new Map();
  #selections = new Map();
  #pairing = null;
  #generation = 0;
  #rate = { at: 0, count: 0 };
  #stopped = false;
  #off;
  #timer;
  constructor({
    vault,
    accounts,
    saveDocument,
    onChange = () => {},
    now = Date.now,
    random = hex,
  }) {
    this.#vault = vault;
    this.#accounts = accounts;
    this.#saveDocument = saveDocument;
    this.#notify = onChange;
    this.#now = now;
    this.#random = random;
    this.#off = vault.onLock(() => this.revoke());
  }
  #clean() {
    const now = this.#now();
    if (this.#pairing?.expiresAt <= now) this.#pairing = null;
    for (const map of [this.#pending, this.#selections])
      for (const [id, value] of map) if (value.expiresAt <= now) map.delete(id);
  }
  #unlocked() {
    return !this.#stopped && this.#vault.unlocked;
  }
  #schedule() {
    clearTimeout(this.#timer);
    const due = Math.min(
      this.#pairing?.expiresAt ?? Infinity,
      ...[...this.#pending.values(), ...this.#selections.values()].map((item) => item.expiresAt),
    );
    if (!Number.isFinite(due) || this.#stopped) return;
    this.#timer = setTimeout(
      () => {
        this.#clean();
        this.#notify();
        this.#schedule();
      },
      Math.max(1, due - this.#now()),
    );
    this.#timer.unref?.();
  }
  status() {
    this.#clean();
    return {
      running: !this.#stopped,
      port: 0,
      pairedClients: this.#clients.size,
      pairingPending: Boolean(this.#pairing),
      pendingCount: this.#pending.size,
    };
  }
  beginPairing() {
    if (!this.#unlocked()) throw fail(423, "请先解锁密钥库再连接浏览器插件。");
    this.#pairing = { code: this.#random(), expiresAt: this.#now() + 300000 };
    this.#schedule();
    this.#notify();
    return { ...this.#pairing, port: 0 };
  }
  revoke() {
    this.#generation++;
    this.#pairing = null;
    clearTimeout(this.#timer);
    this.#clients.clear();
    this.#pending.clear();
    this.#selections.clear();
    this.#notify();
  }
  list() {
    this.#clean();
    if (!this.#unlocked()) return [];
    return [...this.#pending.values()].map(({ id, url, title, username, createdAt, source }) => ({
      id,
      url,
      title,
      username,
      createdAt,
      source,
      hasCredential: true,
    }));
  }
  take(id) {
    this.#clean();
    if (!this.#unlocked()) throw fail(423, "请先解锁密钥库。");
    const item = this.#pending.get(id);
    if (!item) throw fail(404, "待保存账号已过期或已被处理。");
    this.#pending.delete(id);
    this.#notify();
    const { expiresAt: _expiresAt, ...capture } = item;
    return capture;
  }
  discard(id) {
    this.#pending.delete(id);
    this.#notify();
  }
  stop() {
    this.revoke();
    this.#stopped = true;
    this.#off?.();
  }
  async call(path, { extensionId, token, body }) {
    try {
      this.#clean();
      if (!/^[a-p]{32}$/.test(extensionId)) throw fail(403, "插件来源无效。");
      if (!this.#unlocked()) throw fail(423, "密钥库已锁定，请先解锁并重新配对。");
      const now = this.#now();
      if (now - this.#rate.at >= 60000) this.#rate = { at: now, count: 0 };
      if (++this.#rate.count > 120) throw fail(429, "请求过于频繁，请稍后重试。");
      if (
        typeof path !== "string" ||
        ![
          "/v1/pair",
          "/v1/status",
          "/v1/captures",
          "/v1/accounts/list",
          "/v1/accounts/fill",
          "/v1/accounts/save",
          "/v1/documents",
        ].includes(path)
      )
        throw fail(404, "接口不存在。");
      const input = structuredClone(body);
      const encoded = JSON.stringify(input);
      if (
        !encoded ||
        new TextEncoder().encode(encoded).length > (path === "/v1/documents" ? 1250000 : 16384)
      )
        throw fail(413, "请求内容过大。");
      if (path === "/v1/pair") {
        if (!keys(input, ["code"]) || !this.#pairing || input.code !== this.#pairing.code)
          throw fail(401, "配对码无效或已过期，请重新生成。");
        for (const [key, client] of this.#clients)
          if (client.extensionId === extensionId) this.#clients.delete(key);
        if (this.#clients.size >= 8) throw fail(409, "连接数量已达上限。");
        const paired = this.#random();
        this.#clients.set(paired, { extensionId });
        this.#pairing = null;
        this.#notify();
        return { status: 200, data: { token: paired } };
      }
      const client = this.#clients.get(token),
        generation = this.#generation;
      const guard = () => {
        if (!this.#unlocked()) throw fail(423, "密钥库已锁定。");
        if (
          generation !== this.#generation ||
          !client ||
          client.extensionId !== extensionId ||
          this.#clients.get(token) !== client
        )
          throw fail(401, "连接已撤销，请重新配对。");
      };
      guard();
      if (path === "/v1/status") {
        if (!keys(input, [])) throw fail(400, "状态请求必须为空对象。");
        return { status: 200, data: { unlocked: true } };
      }
      if (path.startsWith("/v1/accounts/")) {
        const origin = site(input?.url);
        if (path === "/v1/accounts/list") {
          if (!keys(input, ["url"])) throw fail(400, "账号查询格式无效。");
          const accounts = (await this.#accounts.listForOrigin(origin))
            .slice(0, 100)
            .map(({ id, title, username }) => ({ id, title, username }));
          guard();
          while (this.#selections.size >= 128)
            this.#selections.delete(this.#selections.keys().next().value);
          const selectionToken = this.#random();
          this.#selections.set(selectionToken, {
            token,
            origin,
            ids: new Set(accounts.map((a) => a.id)),
            expiresAt: now + 120000,
          });
          return { status: 200, data: { accounts, selectionToken } };
        }
        if (path === "/v1/accounts/fill") {
          if (!keys(input, ["url", "id", "selectionToken"])) throw fail(400, "账号选择格式无效。");
          const selection = this.#selections.get(input.selectionToken);
          if (
            !selection ||
            selection.token !== token ||
            selection.origin !== origin ||
            !selection.ids.has(input.id)
          )
            throw fail(403, "账号选择已失效，请重新选择。");
          this.#selections.delete(input.selectionToken);
          const account = await this.#accounts.getForOrigin(input.id, origin);
          guard();
          return { status: 200, data: { username: account.username, password: account.password } };
        }
        const capture = this.#capture(input);
        const result = await this.#accounts.saveCapture({ ...capture, url: origin + "/" }, guard);
        guard();
        return { status: 201, data: { id: result.id, status: result.status } };
      }
      if (path === "/v1/documents") {
        if (
          !keys(input, ["url", "title", "text"]) ||
          typeof input.title !== "string" ||
          input.title.length > 512 ||
          typeof input.text !== "string" ||
          input.text.length > 200000
        )
          throw fail(400, "网页文档格式无效。");
        site(input.url);
        const result = await this.#saveDocument(input, guard);
        guard();
        return { status: 201, data: result };
      }
      const capture = this.#capture(input);
      if (this.#pending.size >= 10) throw fail(409, "待保存账号已达上限。");
      const id = this.#random();
      this.#pending.set(id, { ...capture, id, createdAt: now, expiresAt: now + 300000 });
      this.#notify();
      return { status: 201, data: { id } };
    } catch (error) {
      return {
        status: error.status || 400,
        data: { error: error.status ? error.message : "插件请求未完成，请重试。" },
      };
    } finally {
      this.#schedule();
    }
  }
  #capture(value) {
    const names =
      value?.source === "auto"
        ? ["url", "title", "username", "password", "source"]
        : ["url", "title", "username", "password"];
    if (
      !keys(value, names) ||
      typeof value.username !== "string" ||
      !value.username.trim() ||
      value.username.length > 320 ||
      /[\r\n\0]/.test(value.username) ||
      typeof value.password !== "string" ||
      !value.password ||
      value.password.length > 4096
    )
      throw fail(400, "账号信息格式不正确。");
    site(value.url);
    return {
      ...normalizeCapture(value),
      username: value.username.trim(),
      password: value.password,
      ...(value.source === "auto" ? { source: "auto" } : {}),
    };
  }
}
