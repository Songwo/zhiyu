// 网页版的服务器端提醒推送：浏览器关着也能按时把续费与备忘提醒推到手机。
// 配置（含渠道凭据）保存在 server/push.json，只有服务器能读；资产资料仍是同一份 assets.json。
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attentionLine, notificationCandidates } from "../electron/services/notifications.mjs";
import {
  PUSH_PROVIDERS,
  buildPushRequest,
  deliverPush,
  requiresDestination,
  validateToken,
} from "../electron/services/push-channels.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const LEAD_DAYS = [3, 7, 14, 21, 30, 60, 90];
const DEFAULTS = Object.freeze({
  enabled: false,
  provider: "telegram",
  destination: "",
  token: "",
  leadDays: 21,
});

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeAtomic(file, data) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

export class ReminderPushError extends Error {}

export class WebReminderPush {
  #files;
  #readSnapshot;
  #fetch;
  #log;
  #timer = null;
  #running = null;

  /**
   * @param {{ dir: string, readSnapshot: () => Promise<any>, fetchImpl?: typeof fetch, log?: Pick<Console, "error"> }} options
   */
  constructor({ dir, readSnapshot, fetchImpl = fetch, log = console }) {
    this.#files = { config: join(dir, "push.json"), sent: join(dir, "push-sent.json") };
    this.#readSnapshot = readSnapshot;
    this.#fetch = fetchImpl;
    this.#log = log;
  }

  async #record() {
    return { ...DEFAULTS, ...((await readJson(this.#files.config)) ?? {}) };
  }

  /** 给浏览器看的配置：不含凭据本身。 */
  async config() {
    const record = await this.#record();
    return {
      enabled: record.enabled === true,
      provider: record.provider,
      destination: record.destination,
      hasToken: Boolean(record.token),
      leadDays: record.leadDays,
    };
  }

  /** @param {any} input */
  async save(input) {
    const current = await this.#record();
    const provider = String(input?.provider ?? "");
    if (!PUSH_PROVIDERS.has(provider)) throw new ReminderPushError("请选择支持的推送渠道。");
    const destination = String(input?.destination ?? "").trim();
    if (destination.length > 120) throw new ReminderPushError("接收目标过长。");
    const leadDays = Number(input?.leadDays);
    if (!LEAD_DAYS.includes(leadDays)) throw new ReminderPushError("请选择支持的提前天数。");
    const sameTarget = provider === current.provider;
    const token =
      typeof input?.token === "string" && input.token.trim()
        ? input.token.trim()
        : input?.clearToken || !sameTarget
          ? ""
          : current.token;
    if (token) {
      try {
        validateToken(provider, token);
      } catch (error) {
        throw new ReminderPushError(error.message);
      }
    }
    const enabled = input?.enabled === true;
    if (enabled && (!token || (requiresDestination(provider) && !destination)))
      throw new ReminderPushError("开启推送前请填写推送凭据和接收目标。");
    const record = {
      enabled,
      provider,
      destination: requiresDestination(provider) ? destination : "",
      token,
      leadDays,
    };
    await writeAtomic(this.#files.config, JSON.stringify(record));
    return this.config();
  }

  async test() {
    const record = await this.#record();
    if (!record.token || (requiresDestination(record.provider) && !record.destination))
      throw new ReminderPushError("请先保存推送凭据和接收目标。");
    await this.#send(record, "知屿网页版提醒推送测试：连接正常。之后续费与备忘提醒会推送到这里。");
    return { ok: true };
  }

  /**
   * 安全提醒（异常登录等）：提醒推送已开启并配好渠道才发，没配或发送失败都静默，不影响登录本身。
   * @param {string} text
   */
  async notify(text) {
    try {
      const record = await this.#record();
      if (
        !record.enabled ||
        !record.token ||
        (requiresDestination(record.provider) && !record.destination)
      )
        return false;
      await this.#send(record, text, "知屿 Zhiyu 安全提醒");
      return true;
    } catch {
      return false;
    }
  }

  async #send(record, text, title = "知屿 Zhiyu 续费提醒") {
    let request;
    try {
      request = buildPushRequest(record, text, title);
    } catch (error) {
      throw new ReminderPushError(error.message);
    }
    try {
      await deliverPush(record, request, {
        signal: AbortSignal.timeout(20_000),
        fetchImpl: this.#fetch,
      });
    } catch {
      throw new ReminderPushError("推送失败，请检查渠道凭据、接收目标和服务器网络后重试。");
    }
  }

  /** 检查一次：同一件事每天最多推送一次，只发名称与天数。 */
  tick(now = Date.now()) {
    this.#running ??= this.#tick(now).finally(() => (this.#running = null));
    return this.#running;
  }

  async #tick(now) {
    const record = await this.#record();
    if (!record.enabled || !record.token) return { sent: 0 };
    const snapshot = await this.#readSnapshot();
    if (!snapshot) return { sent: 0 };
    const items = notificationCandidates(snapshot, now, { leadDays: record.leadDays }).filter(
      (item) => item.reason !== "offline",
    );
    const previous = (await readJson(this.#files.sent)) ?? {};
    /** @type {Record<string, number>} */
    const sent = {};
    for (const item of items) if (previous[item.key]) sent[item.key] = previous[item.key];
    const due = items.filter((item) => !(now - (sent[item.key] ?? -Infinity) < DAY));
    if (due.length) {
      const lines = due.slice(0, 15).map((item) => attentionLine(item));
      if (due.length > 15) lines.push(`……还有 ${due.length - 15} 项`);
      await this.#send(record, ["知屿提醒", ...lines].join("\n"));
      for (const item of due) sent[item.key] = now;
    }
    await writeAtomic(this.#files.sent, JSON.stringify(sent));
    return { sent: due.length };
  }

  /** 启动一分钟后检查一次，之后每小时一次。 */
  start() {
    const run = () =>
      void this.tick().catch((error) => this.#log.error("reminder-push", error.message));
    const first = setTimeout(run, 60_000);
    first.unref?.();
    this.#timer = setInterval(run, HOUR);
    this.#timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(this.#timer);
    };
  }
}
