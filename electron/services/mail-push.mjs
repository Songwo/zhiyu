import {
  PUSH_PROVIDERS as PROVIDERS,
  buildPushRequest,
  deliverPush,
  requiresDestination,
  validateToken,
} from "./push-channels.mjs";

const RECORD = "notification:mail-push";
const DEFAULTS = Object.freeze({
  enabled: false,
  provider: "telegram",
  destination: "",
  mailboxIds: [],
  intervalMinutes: 15,
  reminders: false,
});

function publicConfig(record) {
  const config = record ?? DEFAULTS;
  return {
    enabled: config.enabled === true,
    provider: config.provider,
    destination: config.destination,
    hasToken: Boolean(config.token),
    mailboxIds: [...config.mailboxIds],
    intervalMinutes: config.intervalMinutes,
    reminders: config.reminders === true,
  };
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class MailPushService {
  #vault;
  #checkMailbox;
  #getSnapshot;
  #fetch;
  #running = null;
  #controller = null;
  #nextTickAt = 0;
  #saving = false;
  #testing = false;

  constructor({ vault, checkMailbox, getSnapshot, fetchImpl = fetch }) {
    this.#vault = vault;
    this.#checkMailbox = checkMailbox;
    this.#getSnapshot = getSnapshot;
    this.#fetch = fetchImpl;
  }

  #requireUnlocked() {
    if (!this.#vault.unlocked) throw new Error("请先解锁密钥库，再配置邮件推送。");
  }

  async config() {
    this.#requireUnlocked();
    return publicConfig(await this.#vault.get(RECORD));
  }

  async save(input) {
    this.#requireUnlocked();
    if (this.#saving || this.#testing) throw new Error("推送操作正在进行，请稍后再试。");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("邮件推送配置不正确。");
    }
    const { provider, enabled, intervalMinutes } = input;
    if (!PROVIDERS.has(provider)) throw new Error("请选择支持的推送渠道。");
    if (typeof enabled !== "boolean") throw new Error("邮件推送开关不正确。");
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      throw new Error("检查间隔需为 5 到 1440 分钟。");
    }
    if (typeof input.destination !== "string" || input.destination.length > 100) {
      throw new Error("推送目标不正确。");
    }
    const destination = input.destination.trim();
    if (
      provider === "telegram" &&
      destination &&
      !/^(-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(destination)
    ) {
      throw new Error("Telegram 目标需为 Chat ID 或公开频道用户名。");
    }
    if (provider === "wxpusher" && destination && !/^UID_[A-Za-z0-9_-]{5,96}$/.test(destination))
      throw new Error("WxPusher 接收用户需填写以 UID_ 开头的用户 UID。");
    if (!requiresDestination(provider) && destination)
      throw new Error("此渠道使用密钥指定目标，无需填写目标地址。");
    if (
      !Array.isArray(input.mailboxIds) ||
      input.mailboxIds.length > 25 ||
      input.mailboxIds.some(
        (id) =>
          typeof id !== "string" ||
          !id ||
          id.length > 200 ||
          ["__proto__", "constructor", "prototype"].includes(id),
      )
    ) {
      throw new Error("请选择最多 25 个邮箱。");
    }
    if (
      input.token !== undefined &&
      (typeof input.token !== "string" || input.token.length > 300)
    ) {
      throw new Error("推送凭据格式不正确。");
    }
    if (input.reminders !== undefined && typeof input.reminders !== "boolean") {
      throw new Error("提醒推送开关不正确。");
    }
    if (input.clearToken !== undefined && typeof input.clearToken !== "boolean") {
      throw new Error("清除凭据选项不正确。");
    }
    this.#saving = true;
    try {
      this.stop();
      await this.#running;
      this.#requireUnlocked();
      const snapshot = await this.#getSnapshot();
      const validIds = new Set(
        (snapshot?.mailboxes ?? [])
          .filter((mailbox) => mailbox.kind === "mailbox" && !mailbox.demo)
          .map((mailbox) => mailbox.id),
      );
      const mailboxIds = [...new Set(input.mailboxIds)];
      if (mailboxIds.some((id) => !validIds.has(id)))
        throw new Error("所选邮箱不存在或不支持收件检查。");
      const previous = await this.#vault.get(RECORD);
      const targetChanged =
        previous?.provider !== provider || previous?.destination !== destination;
      const enteredToken = input.token?.trim() ?? "";
      if (input.clearToken && enteredToken) throw new Error("不能同时替换和清除推送凭据。");
      const token = input.clearToken
        ? ""
        : enteredToken || (targetChanged ? "" : (previous?.token ?? ""));
      if (token) validateToken(provider, token);
      if (
        enabled &&
        (!token || !mailboxIds.length || (requiresDestination(provider) && !destination))
      ) {
        throw new Error("启用前请填写推送凭据、目标并选择邮箱。");
      }
      if (input.reminders === true && (!token || (requiresDestination(provider) && !destination)))
        throw new Error("推送提醒前请填写推送凭据和目标。");
      const reset =
        targetChanged ||
        enteredToken ||
        input.clearToken ||
        previous?.enabled !== enabled ||
        JSON.stringify(previous?.mailboxIds) !== JSON.stringify(mailboxIds);
      const record = {
        enabled,
        provider,
        destination,
        token,
        mailboxIds,
        intervalMinutes,
        reminders: input.reminders === true,
        observed: reset ? {} : (previous?.observed ?? {}),
        checkpoints: reset ? {} : (previous?.checkpoints ?? {}),
        pending: reset ? {} : (previous?.pending ?? {}),
      };
      this.#requireUnlocked();
      await this.#vault.set(RECORD, record);
      this.#nextTickAt = 0;
      return publicConfig(record);
    } finally {
      this.#saving = false;
    }
  }

  async test() {
    this.#requireUnlocked();
    if (this.#saving || this.#testing || this.#running)
      throw new Error("推送操作正在进行，请稍后再试。");
    this.#testing = true;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const record = await this.#vault.get(RECORD);
      if (!record?.token || (requiresDestination(record.provider) && !record.destination)) {
        throw new Error("请先保存推送凭据和目标。");
      }
      await this.#send(
        record,
        "知屿 Zhiyu 邮件推送测试：连接正常。此消息不包含邮箱或邮件内容。",
        controller.signal,
      );
      return { ok: true };
    } finally {
      if (this.#controller === controller) this.#controller = null;
      this.#testing = false;
    }
  }

  /** 到期与备忘提醒：渠道已配置且开启「提醒也推送」时发送一条，只含名称与天数。 */
  async remind(text) {
    if (!this.#vault.unlocked || this.#saving || this.#testing) return false;
    const record = await this.#vault.get(RECORD);
    if (
      !record?.reminders ||
      !record.token ||
      (requiresDestination(record.provider) && !record.destination)
    )
      return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await this.#send(
        record,
        String(text).slice(0, 2000),
        controller.signal,
        "知屿 Zhiyu 续费提醒",
      );
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  tick() {
    if (this.#running) return this.#running;
    if (this.#saving || this.#testing || !this.#vault.unlocked || Date.now() < this.#nextTickAt) {
      return Promise.resolve({ checked: 0, sent: false, skipped: true });
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#running = this.#tick(controller.signal).finally(() => {
      this.#running = null;
      if (this.#controller === controller) this.#controller = null;
    });
    return this.#running;
  }

  async #tick(signal) {
    let checked = 0;
    try {
      const record = await this.#vault.get(RECORD);
      if (!record?.enabled || !record.token || !record.mailboxIds.length)
        return { checked, sent: false, skipped: true };
      this.#nextTickAt = Date.now() + record.intervalMinutes * 60_000;
      const snapshot = await this.#getSnapshot();
      const validIds = new Set(
        (snapshot?.mailboxes ?? [])
          .filter((mailbox) => mailbox.kind === "mailbox" && !mailbox.demo)
          .map((mailbox) => mailbox.id),
      );
      record.observed ??= {};
      record.checkpoints ??= {};
      record.pending ??= {};
      for (const id of Object.keys(record.pending)) {
        if (!validIds.has(id) || !record.mailboxIds.includes(id)) delete record.pending[id];
      }
      let failed = 0;
      for (const id of record.mailboxIds) {
        signal.throwIfAborted();
        this.#requireUnlocked();
        if (!validIds.has(id)) continue;
        try {
          const result = await this.#checkMailbox(id, {
            signal,
            cursor: "push",
            checkpoint: record.checkpoints[id],
          });
          signal.throwIfAborted();
          this.#requireUnlocked();
          checked += 1;
          const checkedAt = Number.isFinite(Date.parse(result.checkedAt))
            ? new Date(result.checkedAt).toISOString()
            : new Date().toISOString();
          const newMessages = boundedCount(result.newMessages);
          const previousCheck = record.observed[id];
          if (previousCheck && newMessages > 0) {
            record.pending[id] = {
              newMessages: boundedCount(record.pending[id]?.newMessages) + newMessages,
              unseen: boundedCount(result.unseen),
              checkedAt,
            };
          }
          record.observed[id] = checkedAt;
          if (result.checkpoint) record.checkpoints[id] = result.checkpoint;
          this.#requireUnlocked();
          await this.#vault.set(RECORD, record);
        } catch {
          signal.throwIfAborted();
          failed += 1;
        }
      }
      signal.throwIfAborted();
      this.#requireUnlocked();
      await this.#vault.set(RECORD, record);
      const pending = Object.values(record.pending);
      if (!pending.length) return { checked, sent: false, failed };
      const newMessages = pending.reduce((total, entry) => total + entry.newMessages, 0);
      const unseen = pending.reduce((total, entry) => total + entry.unseen, 0);
      const checkedAt = pending
        .map((entry) => entry.checkedAt)
        .sort()
        .at(-1);
      const text = `知屿 Zhiyu 邮件提醒\n新增邮件：${newMessages} 封\n相关邮箱未读：${unseen} 封\n检查时间：${checkedAt}`;
      await this.#send(record, text, signal);
      signal.throwIfAborted();
      this.#requireUnlocked();
      record.pending = {};
      await this.#vault.set(RECORD, record);
      return { checked, sent: true, failed };
    } catch {
      this.#nextTickAt = Date.now() + 60_000;
      return {
        checked,
        sent: false,
        error: signal.aborted ? "邮件推送已停止。" : "邮件检查或推送失败，将在下次检查时重试。",
      };
    }
  }

  async #send(record, text, signal, title = "知屿 Zhiyu 邮件提醒") {
    this.#requireUnlocked();
    signal.throwIfAborted();
    const request = buildPushRequest(record, text, title);
    try {
      await deliverPush(record, request, { signal, fetchImpl: this.#fetch });
    } catch {
      throw new Error(
        signal.aborted ? "邮件推送已停止。" : "推送失败，请检查渠道凭据、目标和网络后重试。",
      );
    }
  }

  stop() {
    this.#controller?.abort();
  }
}
