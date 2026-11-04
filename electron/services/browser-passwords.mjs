const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const TICKET_TTL = 5 * 60 * 1000;

function parseCsv(input) {
  if (typeof input !== "string" || new TextEncoder().encode(input).byteLength > MAX_BYTES)
    throw new Error("CSV 大小不能超过 10 MiB。");
  const text = input.replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const finishField = () => {
    row.push(field);
    if (row.length > 32) throw new Error("CSV 字段数量过多。");
    field = "";
    closed = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value !== "")) rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new Error("CSV 最多支持 10000 条密码。");
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
      continue;
    }
    if (char === ",") finishField();
    else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[index + 1] === "\n") index += 1;
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("CSV 引号格式无效。");
      field += char;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合。");
  if (field || row.length || closed) finishRow();
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase());
  if (
    !headers ||
    new Set(headers).size !== headers.length ||
    !["url", "username", "password"].every((name) => headers.includes(name))
  )
    throw new Error(
      "CSV 必须包含 url、username、password 字段，请使用 Chrome 或 Edge 的密码导出文件。",
    );
  return rows.map((values) => {
    if (values.length !== headers.length) return null;
    const fields = Object.fromEntries(headers.map((name, index) => [name, values[index]]));
    return {
      title: fields.name ?? fields.title ?? "",
      url: fields.url,
      username: fields.username,
      password: fields.password,
      note: fields.note ?? fields.notes ?? "",
    };
  });
}

function siteUrl(value, secure = false) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32)
  )
    throw new Error("账号网址无效。");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("账号网址无效。");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new Error("账号网址无效。");
  if (
    secure &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("为保证安全，仅支持 HTTPS 或本机页面填写账号。");
  return url;
}

function credential(input) {
  if (!input || typeof input !== "object") throw new Error("账号格式无效。");
  const parsed = siteUrl(input.url);
  if (
    typeof input.username !== "string" ||
    input.username.length > 320 ||
    /[\r\n\0]/.test(input.username) ||
    typeof input.password !== "string" ||
    !input.password ||
    input.password.length > 4096 ||
    input.password.includes("\0") ||
    (input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > 20000 || input.note.includes("\0"))) ||
    (input.title !== undefined &&
      (typeof input.title !== "string" || input.title.length > 300 || /[\r\n\0]/.test(input.title)))
  )
    throw new Error("账号字段无效或过长。");
  return {
    url: input.url,
    origin: parsed.origin,
    title: input.title?.trim() || parsed.hostname,
    username: input.username,
    password: input.password,
    note: input.note ?? "",
  };
}

function safePreview(input) {
  const safe = (value, limit) =>
    typeof value === "string" ? value.replace(/[\r\n\0]/g, " ").slice(0, limit) : "";
  return {
    title: safe(input?.title, 300),
    url: safe(input?.url, 4096),
    username: safe(input?.username, 320),
  };
}

function identity(record) {
  return JSON.stringify([record.origin, record.username]);
}

function indexRecords(records) {
  const index = new Map();
  for (const record of records) {
    const key = identity(record);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  }
  return index;
}

function classify(record, index) {
  const matches = index.get(identity(record)) ?? [];
  if (matches.some((item) => item.password === record.password)) return "duplicate";
  return matches.length ? "conflict" : "new";
}

function makeEntry(record, id) {
  const updatedAt = new Date().toISOString();
  const asset = {
    id,
    name: record.title,
    kind: "account",
    hint: "",
    value: "",
    notes: "",
    lastRotated: updatedAt.slice(0, 10),
    status: "online",
    tags: [],
  };
  return {
    asset,
    entry: {
      id: `account:${id}`,
      secret: {
        url: record.url,
        username: record.username,
        password: record.password,
        note: record.note,
        updatedAt,
        _browserAsset: asset,
      },
    },
  };
}

function restoreAsset(id, stored) {
  if (!stored || stored.id !== id || stored.kind !== "account" || typeof stored.name !== "string")
    return null;
  return {
    id,
    name: stored.name.slice(0, 300),
    kind: "account",
    hint: "",
    value: "",
    notes: "",
    lastRotated: typeof stored.lastRotated === "string" ? stored.lastRotated : "",
    status: ["online", "warning", "offline"].includes(stored.status) ? stored.status : "online",
    tags: Array.isArray(stored.tags)
      ? stored.tags.filter((tag) => typeof tag === "string").slice(0, 100)
      : [],
    ...(typeof stored.folderId === "string" ? { folderId: stored.folderId } : {}),
  };
}

/** 密码只在主进程短期内存与加密库中流转；预览和资产元数据没有密码字段。 */
export class BrowserPasswords {
  #uuid;
  #ticket;
  #vault;
  #getAssets;
  #now;
  #tickets = new Map();
  #queue = Promise.resolve();
  #generation = 0;

  constructor({
    vault,
    getAssets = () => [],
    now = Date.now,
    uuid = () => globalThis.crypto.randomUUID(),
    ticket = () =>
      Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
  }) {
    this.#vault = vault;
    this.#getAssets = getAssets;
    this.#now = now;
    this.#uuid = uuid;
    this.#ticket = ticket;
    vault.onLock(() => this.clear());
  }

  #guard(generation, session) {
    if (!this.#vault.unlocked || generation !== this.#generation || session !== this.#vault.session)
      throw new Error("密钥库已锁定，操作已取消。");
  }

  #enqueue(action) {
    const generation = this.#generation;
    const session = this.#vault.session;
    if (!this.#vault.unlocked) return Promise.reject(new Error("密钥库已锁定。"));
    const guard = () => this.#guard(generation, session);
    const task = this.#queue.then(async () => {
      guard();
      const result = await action(guard);
      guard();
      return result;
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  async #records(guard) {
    const all = await this.#vault.readAll("account:");
    guard();
    const assets = await this.#getAssets();
    guard();
    const names = new Map(
      (Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset.name]),
    );
    const records = [];
    for (const [key, stored] of Object.entries(all)) {
      const id = key.slice("account:".length);
      if (!id || !stored || typeof stored !== "object") continue;
      const asset = restoreAsset(id, stored._browserAsset);
      try {
        const normalized = credential({ ...stored, title: names.get(id) ?? asset?.name });
        records.push({ ...normalized, id, asset });
      } catch {
        // 非网站账号、OAuth 记录及不完整条目不参与浏览器密码迁移。
      }
    }
    return records;
  }

  #removeTicket(ticket) {
    const stored = this.#tickets.get(ticket);
    if (stored) clearTimeout(stored.timer);
    this.#tickets.delete(ticket);
  }

  clear() {
    this.#generation += 1;
    for (const ticket of this.#tickets.keys()) this.#removeTicket(ticket);
  }

  cancel(ticket) {
    this.#removeTicket(ticket);
    return { ok: true };
  }

  preview(csv) {
    return this.#enqueue(async (guard) => {
      const parsed = parseCsv(csv);
      const index = indexRecords(await this.#records(guard));
      const candidates = [];
      const rows = [];
      const counts = { added: 0, duplicates: 0, conflicts: 0, invalid: 0 };
      for (const input of parsed) {
        let normalized;
        try {
          normalized = credential(input);
        } catch {
          counts.invalid += 1;
          rows.push({ ...safePreview(input), status: "invalid" });
          continue;
        }
        const status = classify(normalized, index);
        counts[{ new: "added", duplicate: "duplicates", conflict: "conflicts" }[status]] += 1;
        rows.push({
          title: normalized.title,
          url: normalized.url,
          username: normalized.username,
          status,
        });
        if (status === "new") {
          candidates.push(normalized);
          index.set(identity(normalized), [normalized]);
        }
      }
      guard();
      // 一个导入窗口只保留最新预览，限制明文票据的内存驻留量。
      for (const ticket of this.#tickets.keys()) this.#removeTicket(ticket);
      const ticket = this.#ticket();
      const timer = setTimeout(() => this.#removeTicket(ticket), TICKET_TTL);
      timer.unref?.();
      this.#tickets.set(ticket, {
        candidates,
        total: parsed.length,
        expires: this.#now() + TICKET_TTL,
        timer,
      });
      return { ticket, total: parsed.length, ...counts, rows };
    });
  }

  commit(ticket) {
    return this.#enqueue(async (guard) => {
      const stored = typeof ticket === "string" ? this.#tickets.get(ticket) : null;
      if (!stored || stored.expires <= this.#now()) {
        this.#removeTicket(ticket);
        throw new Error("导入预览已失效或过期，请重新选择文件。");
      }
      const index = indexRecords(await this.#records(guard));
      const selected = [];
      for (const record of stored.candidates) {
        if (classify(record, index) !== "new") continue;
        selected.push(makeEntry(record, this.#uuid()));
        index.set(identity(record), [record]);
      }
      const beforeCommit = () => {
        guard();
        if (this.#tickets.get(ticket) !== stored || stored.expires <= this.#now())
          throw new Error("导入预览已失效或过期，请重新选择文件。");
      };
      beforeCommit();
      await this.#vault.batch(
        selected.map((item) => item.entry),
        { beforeCommit },
      );
      guard();
      this.#removeTicket(ticket);
      return {
        imported: selected.length,
        skipped: stored.total - selected.length,
        assets: selected.map((item) => item.asset),
      };
    });
  }

  exportCsv() {
    return this.#enqueue(async (guard) => {
      const records = await this.#records(guard);
      if (records.length > MAX_ROWS) throw new Error("单次最多导出 10000 条浏览器密码。");
      // 仅供密码管理器导入；不能更改公式前缀，否则会改变真实密码。
      const cell = (value) => `"${value.replaceAll('"', '""')}"`;
      const csv =
        "\ufeffname,url,username,password,note\r\n" +
        records
          .map(
            (record) =>
              [record.title, record.url, record.username, record.password, record.note]
                .map(cell)
                .join(",") + "\r\n",
          )
          .join("");
      if (new TextEncoder().encode(csv).byteLength > MAX_BYTES)
        throw new Error("导出 CSV 大小超过 10 MiB。");
      return { csv, count: records.length };
    });
  }

  listForOrigin(url) {
    return this.#enqueue(async (guard) => {
      const origin = siteUrl(url, true).origin;
      return (await this.#records(guard))
        .filter((record) => record.origin === origin)
        .map(({ id, title, username }) => ({ id, title, username }));
    });
  }

  getForOrigin(id, url) {
    return this.#enqueue(async (guard) => {
      const origin = siteUrl(url, true).origin;
      if (typeof id !== "string" || !id || id.length > 512) throw new Error("该站点账号不可用。");
      const record = (await this.#records(guard)).find(
        (item) => item.id === id && item.origin === origin,
      );
      if (!record) throw new Error("该站点账号不可用。");
      return { username: record.username, password: record.password };
    });
  }

  saveCapture(capture, assertCurrent = () => {}) {
    return this.#enqueue(async (guard) => {
      const assertAuthorized = () => {
        guard();
        assertCurrent();
      };
      assertAuthorized();
      const normalized = credential(capture);
      siteUrl(normalized.url, true);
      const records = await this.#records(assertAuthorized);
      assertAuthorized();
      const existing = records.find(
        (record) =>
          identity(record) === identity(normalized) && record.password === normalized.password,
      );
      if (existing) return { id: existing.id, status: "existing", assets: [] };
      const versions = records.filter((record) => identity(record) === identity(normalized)).length;
      const created = makeEntry(
        {
          ...normalized,
          title: versions
            ? `${normalized.title.slice(0, 270)} · 密码版本 ${versions + 1}`
            : normalized.title,
        },
        this.#uuid(),
      );
      assertAuthorized();
      await this.#vault.batch([created.entry], { beforeCommit: assertAuthorized });
      assertAuthorized();
      return { id: created.asset.id, status: "created", assets: [created.asset] };
    });
  }

  managedAssets() {
    return this.#enqueue(async (guard) => {
      const records = await this.#vault.readAll("account:");
      guard();
      return Object.entries(records)
        .map(([id, record]) => restoreAsset(id.slice("account:".length), record?._browserAsset))
        .filter(Boolean);
    });
  }
}
