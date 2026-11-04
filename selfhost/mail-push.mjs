import { MailPushService } from "../electron/services/mail-push.mjs";

/** 用户明确同意后，仅保管所选邮箱的后台检查凭据。整份配置原子加密写入。 */
export function createWebMailPush({ store, getSnapshot, checkMailbox, fetchImpl }) {
  let state,
    staging = false,
    stopped = false,
    queue = Promise.resolve();
  const load = async () =>
    (state ??= (await store.get("state")) ?? { config: null, credentials: {} });
  const vault = {
    unlocked: true,
    get: async () => structuredClone((await load()).config),
    set: async (_key, config) => {
      if (stopped) throw new Error("后台邮件检查已停止。");
      state = { ...(await load()), config };
      if (!staging) await store.set("state", state);
    },
  };
  const service = new MailPushService({
    vault,
    getSnapshot,
    fetchImpl,
    checkMailbox: async (id, options) => {
      const credential = (await load()).credentials[id];
      if (!credential) throw new Error("未保存该邮箱的后台检查凭据。");
      return checkMailbox(id, credential, options);
    },
  });
  const serial = (work) => {
    const task = queue.then(() => {
      if (stopped) throw new Error("后台邮件检查已停止。");
      return work();
    });
    queue = task.catch(() => {});
    return task;
  };
  const config = async () => ({
    ...(await service.config()),
    serverConsent: Boolean((await load()).config?.enabled),
  });
  const clean = async () => {
    const value = await load();
    const ids = new Set(
      (await getSnapshot())?.mailboxes
        ?.filter((m) => m.kind === "mailbox" && !m.demo)
        .map((m) => m.id) ?? [],
    );
    const credentials = Object.fromEntries(
      Object.entries(value.credentials).filter(
        ([id]) => ids.has(id) && value.config?.mailboxIds.includes(id),
      ),
    );
    if (Object.keys(credentials).length !== Object.keys(value.credentials).length) {
      state = { ...value, credentials };
      await store.set("state", state);
    }
  };
  return {
    config: () => serial(config),
    save(input, credentials, contextValid = () => {}) {
      service.stop();
      return serial(async () => {
        contextValid();
        if (input?.enabled && input.serverConsent !== true)
          throw new Error("请先确认允许服务器加密保存所选邮箱的后台检查凭据。");
        const nextCredentials = {};
        if (input?.enabled) {
          if (!Array.isArray(input.mailboxIds) || input.mailboxIds.length > 25)
            throw new Error("请选择最多 25 个邮箱。");
          for (const id of input.mailboxIds) {
            if (typeof id !== "string" || ["__proto__", "constructor", "prototype"].includes(id))
              throw new Error("邮箱标识不正确。");
            const value = credentials?.[id];
            if (
              !value ||
              typeof value.username !== "string" ||
              !value.username ||
              value.username.length > 320 ||
              typeof value.password !== "string" ||
              !value.password ||
              value.password.length > 4096
            )
              throw new Error("所选邮箱缺少有效的用户名或授权码，请解锁后重新保存。");
            nextCredentials[id] = { username: value.username, password: value.password };
          }
        }
        const previous = structuredClone(await load());
        staging = true;
        try {
          await service.save({ ...input, reminders: false });
          contextValid();
          state = { config: state.config, credentials: nextCredentials };
          await store.set("state", state, { beforeCommit: contextValid });
          return await config();
        } catch (error) {
          state = previous;
          throw error;
        } finally {
          staging = false;
        }
      });
    },
    test: () => serial(() => service.test()),
    tick: () =>
      serial(async () => {
        await clean();
        return service.tick();
      }),
    stop() {
      stopped = true;
      service.stop();
    },
  };
}
