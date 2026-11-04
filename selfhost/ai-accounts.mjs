import { AsyncLocalStorage } from "node:async_hooks";
import { AiAccounts } from "../electron/services/ai-accounts.mjs";

/** 用户明确同意后由服务器加密保管 OAuth，原始令牌不回传浏览器。 */
export function createWebAiAccounts({ store, fetchImpl, sessionActive, usage }) {
  const scope = new AsyncLocalStorage(),
    scheduled = Symbol("scheduled");
  let stopped = false;
  const shutdown = new AbortController();
  const owners = new Map();
  const valid = (context = scope.getStore()) => {
    if (
      stopped ||
      !context ||
      (context.scheduled !== scheduled && !sessionActive(context.sessionKey))
    )
      throw new Error("网页登录已过期，请重新登录。");
  };
  const vault = {
    unlocked: true,
    session: 1,
    list: () => {
      valid();
      return store.list();
    },
    get: (id) => {
      valid();
      return store.get(id);
    },
    set: (id, value, options = {}) => {
      const context = scope.getStore();
      return store.set(id, value, {
        beforeCommit: () => {
          if (!options.rollback) {
            valid(context);
            options.beforeCommit?.();
          }
        },
      });
    },
    remove: (id, options = {}) => {
      const context = scope.getStore();
      return store.remove(id, {
        beforeCommit: () => {
          if (!options.rollback) valid(context);
        },
      });
    },
  };
  let authorizationUrl = "",
    starts = Promise.resolve();
  const service = new AiAccounts({
    vault,
    manualLoopback: true,
    fetchImpl: (url, options = {}) =>
      fetchImpl(url, {
        ...options,
        signal: AbortSignal.any([shutdown.signal, ...(options.signal ? [options.signal] : [])]),
      }),
    openExternal: async (url) => {
      authorizationUrl = url;
    },
  });
  const own = (id, key) => {
    if (owners.get(id) !== key) throw new Error("本次授权不属于当前网页登录会话。");
  };
  const handlers = {
    "ai-accounts:list": () => service.list(),
    "ai-accounts:start": ([provider, options], key) => {
      if (options?.allowServerStorage !== true)
        throw new Error("请先确认允许服务器加密保存本次 AI 授权凭据。");
      const start = starts.then(async () => {
        valid();
        const result = await service.start(provider);
        valid();
        owners.clear();
        owners.set(result.id, key);
        return { ...result, authorizationUrl };
      });
      starts = start.catch(() => undefined);
      return start;
    },
    "ai-accounts:status": ([id], key) => {
      own(id, key);
      return service.status(id);
    },
    "ai-accounts:finish": async ([id, input], key) => {
      own(id, key);
      return service.finish(id, input);
    },
    "ai-accounts:cancel": ([id], key) => {
      own(id, key);
      owners.delete(id);
      return service.cancel(id);
    },
    "ai-accounts:refresh": async ([id]) => {
      try {
        const account = await service.refresh(id);
        await usage.recordAccount(account);
        return account;
      } catch (error) {
        await usage.markFailure(`oauth:${id}`, error.message).catch(() => {});
        throw error;
      }
    },
    "ai-accounts:remove": ([id]) => service.remove(id),
  };
  const clean = () => {
    for (const [id, owner] of owners)
      if (!sessionActive(owner)) {
        service.cancel(id);
        owners.delete(id);
      }
  };
  return {
    channels: Object.keys(handlers),
    dropSessions: clean,
    async call(channel, args, context) {
      valid(context);
      clean();
      return scope.run(context, async () => {
        const result = await handlers[channel](args ?? [], context.sessionKey);
        valid();
        return result;
      });
    },
    async refreshAll() {
      return scope.run({ scheduled }, async () => {
        const failures = [];
        for (const account of await service.list()) {
          try {
            await handlers["ai-accounts:refresh"]([account.id]);
          } catch (error) {
            failures.push(`${account.provider}：${error.message}`);
          }
        }
        return failures;
      });
    },
    stop() {
      stopped = true;
      shutdown.abort();
      service.stop();
      owners.clear();
    },
  };
}
