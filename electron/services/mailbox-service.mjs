import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MailOAuthError } from "./mail-oauth-credential.mjs";
import {
  MailboxQueryError,
  queryMailbox as queryImap,
  validateMailboxConnection,
} from "./mail.mjs";

export { validateMailboxConnection } from "./mail.mjs";

export class MailboxService {
  #file;
  #vault;
  #getSnapshot;
  #query;
  #resolveOAuth;
  #baselines;
  #queues = new Map();
  #controllers = new Set();
  #generation = 0;
  #writeQueue = Promise.resolve();

  constructor({
    directory,
    vault,
    getSnapshot,
    queryMailbox = queryImap,
    resolveOAuth = undefined,
  }) {
    this.#file = join(directory, "mailbox-baselines.json");
    this.#vault = vault;
    this.#getSnapshot = getSnapshot;
    this.#query = queryMailbox;
    this.#resolveOAuth = resolveOAuth;
  }

  check(assetId, { signal, cursor = "interactive", checkpoint } = {}) {
    if (typeof assetId !== "string" || !assetId || assetId.length > 256)
      return Promise.reject(new Error("请选择有效的邮箱资产"));
    if (!["interactive", "push"].includes(cursor))
      return Promise.reject(new Error("邮箱检查游标无效"));
    const generation = this.#generation;
    const previous = this.#queues.get(assetId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.#check(assetId, { signal, cursor, checkpoint, generation }));
    this.#queues.set(assetId, current);
    void current
      .finally(() => {
        if (this.#queues.get(assetId) === current) this.#queues.delete(assetId);
      })
      .catch(() => {});
    return current;
  }

  stop() {
    this.#generation += 1;
    for (const controller of this.#controllers) controller.abort();
  }

  async #load() {
    if (!this.#baselines)
      this.#baselines = (async () => {
        try {
          const value = JSON.parse(await readFile(this.#file, "utf8"));
          return value?.version === 1 && value.baselines && typeof value.baselines === "object"
            ? value.baselines
            : {};
        } catch (error) {
          if (error.code === "ENOENT") return {};
          throw new Error("邮箱检查基线读取失败，请检查本地文件权限");
        }
      })();
    return this.#baselines;
  }

  #persist(key, baseline) {
    const write = this.#writeQueue
      .catch(() => {})
      .then(async () => {
        const current = await this.#load();
        const next = { ...current, [key]: baseline };
        await mkdir(join(this.#file, ".."), { recursive: true });
        await writeFile(`${this.#file}.tmp`, JSON.stringify({ version: 1, baselines: next }), {
          mode: 0o600,
        });
        await rename(`${this.#file}.tmp`, this.#file);
        this.#baselines = Promise.resolve(next);
      });
    this.#writeQueue = write;
    return write;
  }

  async #check(assetId, { signal, cursor, checkpoint, generation }) {
    if (signal?.aborted || generation !== this.#generation) throw new Error("邮箱检查已取消");
    if (!this.#vault.unlocked) throw new Error("请先解锁密钥库再检查邮箱");
    const snapshot = await this.#getSnapshot();
    const mailbox = snapshot?.mailboxes?.find((entry) => entry.id === assetId);
    if (!mailbox || mailbox.demo || mailbox.kind !== "mailbox")
      throw new Error("请选择已保存的真实邮箱账号");
    if (!mailbox.imap) throw new Error("请先在邮箱详情中保存 IMAP 连接设置");
    const connection = validateMailboxConnection(mailbox.imap);
    let credential;
    try {
      credential = await this.#vault.get(`account:${assetId}`);
    } catch {
      throw new Error("邮箱凭据读取失败，请重新解锁密钥库");
    }
    const username = credential?.username;
    const password = credential?.password;
    const oauth = credential?.oauth?.mailClientId && this.#resolveOAuth;
    if (
      typeof username !== "string" ||
      !username ||
      (!oauth && (typeof password !== "string" || !password))
    )
      throw new Error("请先保存邮箱用户名与密码 / 授权码");
    const key = createHash("sha256")
      .update(JSON.stringify([assetId, cursor, connection, username]))
      .digest("hex");
    const previous =
      cursor === "push" ? validatedCheckpoint(checkpoint, key) : (await this.#load())[key];
    const controller = new AbortController();
    this.#controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || generation !== this.#generation || !this.#vault.unlocked) abort();
    const lockMonitor = setInterval(() => {
      if (!this.#vault.unlocked) abort();
    }, 250);
    try {
      if (controller.signal.aborted) throw new Error("邮箱检查已取消");
      const accessToken = oauth ? await this.#resolveOAuth(mailbox, credential, "imap") : undefined;
      if (controller.signal.aborted || !this.#vault.unlocked) throw new Error("邮箱检查已取消");
      const raw = await this.#query({
        ...connection,
        address: mailbox.address,
        username,
        password,
        accessToken,
        baseline: previous,
        signal: controller.signal,
      });
      if (controller.signal.aborted || signal?.aborted) throw new Error("邮箱检查已取消");
      if (!this.#vault.unlocked) throw new Error("密钥库已锁定，邮箱检查已取消");
      const messages = validCount(raw?.messages);
      const unseen = validCount(raw?.unseen);
      if (messages === null || unseen === null) throw new Error("IMAP 服务器未返回有效邮件统计");
      const validBaseline =
        typeof raw.uidValidity === "string" &&
        /^[1-9][0-9]{0,19}$/.test(raw.uidValidity) &&
        validCount(raw.uidNext) > 0;
      const comparable =
        validBaseline &&
        previous?.uidValidity === raw.uidValidity &&
        previous.uidNext > 0 &&
        raw.uidNext >= previous.uidNext;
      const result = {
        assetId,
        address: mailbox.address,
        messages,
        unseen,
        newMessages: comparable ? validCount(raw.newMessages) : null,
        checkedAt: new Date().toISOString(),
      };
      if (validCount(raw.usedMb) !== null) result.usedMb = raw.usedMb;
      if (validCount(raw.quotaMb) !== null) result.quotaMb = raw.quotaMb;
      const next = validBaseline
        ? { uidValidity: raw.uidValidity, uidNext: raw.uidNext }
        : { uidValidity: null, uidNext: null };
      // 推送游标由调用方与待发消息一起提交，检查成功本身不消费新增邮件。
      if (cursor === "push") result.checkpoint = { version: 1, identity: key, ...next };
      else await this.#persist(key, next);
      return result;
    } catch (error) {
      if (controller.signal.aborted || signal?.aborted)
        throw new Error("邮箱检查已取消或密钥库已锁定");
      // 自定义传输及服务器错误同样不能把凭据、邮件内容带回 renderer 或模型。
      if (error instanceof MailboxQueryError || error instanceof MailOAuthError)
        throw new Error(error.message);
      throw new Error("邮箱检查失败，请检查 IMAP 设置、网络及账号权限");
    } finally {
      clearInterval(lockMonitor);
      this.#controllers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validatedCheckpoint(checkpoint, identity) {
  if (checkpoint?.version !== 1 || checkpoint.identity !== identity) return undefined;
  if (
    typeof checkpoint.uidValidity !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(checkpoint.uidValidity) ||
    validCount(checkpoint.uidNext) <= 0
  )
    return undefined;
  return { uidValidity: checkpoint.uidValidity, uidNext: checkpoint.uidNext };
}
