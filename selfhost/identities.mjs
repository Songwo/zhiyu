import { AsyncLocalStorage } from "node:async_hooks";
import { IdentityAccounts } from "../electron/services/identity-accounts.mjs";
import { identityPostsDocument } from "../electron/services/identity-documents.mjs";

/** 兼容旧独立身份资产；不代替 Linux.do 主身份。 */
export function createWebIdentities({
  store,
  fetchImpl,
  sessionActive,
  getSnapshot,
  mutateAssets,
  documents,
  emit,
}) {
  const scope = new AsyncLocalStorage(),
    owners = new Map();
  let stopped = false;
  const valid = () => !stopped && sessionActive(scope.getStore()?.sessionKey);
  const assert = () => {
    if (!valid()) throw new Error("网页登录已过期，请重新登录。");
  };
  const vault = {
    get unlocked() {
      return valid();
    },
    session: 1,
    onLock: () => () => {},
    get: async (id) => {
      assert();
      return store.get(id);
    },
    batch: (entries, options = {}) => {
      assert();
      return store.batch(entries, {
        beforeCommit: () => {
          assert();
          options.beforeCommit?.();
        },
      });
    },
  };
  const service = new IdentityAccounts({
    vault,
    fetchImpl,
    getAssets: getSnapshot,
    manualLoopback: true,
    openExternal: async () => {},
  });
  const own = (id) => {
    if (owners.get(id) !== scope.getStore()?.sessionKey)
      throw new Error("授权不属于当前网页登录会话。");
  };
  const handlers = {
    config: () => service.config(),
    configure: ([input]) => {
      if (input?.allowServerStorage !== true)
        throw new Error("请先确认允许服务器加密保存独立身份接入凭据。");
      return service.configure(input);
    },
    start: async ([options]) => {
      if (options?.allowServerStorage !== true)
        throw new Error("请先确认允许服务器加密保存独立身份授权。");
      const s = await service.start();
      assert();
      owners.clear();
      owners.set(s.id, scope.getStore().sessionKey);
      return s;
    },
    status: ([id]) => {
      own(id);
      return service.status(id);
    },
    finish: ([id, input]) => {
      own(id);
      return service.finish(id, input);
    },
    cancel: ([id]) => {
      own(id);
      owners.delete(id);
      return service.cancel(id);
    },
    get: ([id]) => service.get(id),
    refresh: ([id]) => service.refresh(id),
    loadPosts: ([id, options]) => service.loadPosts(id, options),
    disconnect: ([id]) => service.disconnect(id),
    commit: async ([input]) => {
      own(input?.sessionId);
      if (
        input?.folderId &&
        !(await getSnapshot()).secretFolders?.some((f) => f.id === input.folderId)
      )
        throw new Error("所选分组已不存在。");
      let asset, result;
      await mutateAssets(async (snapshot) => {
        result = await service.commit(input);
        assert();
        const existing = snapshot.secrets?.find((s) => s.id === result.asset.id);
        asset = existing ? { ...existing, identityProvider: "linuxdo" } : result.asset;
        return {
          ...snapshot,
          secrets: existing
            ? snapshot.secrets.map((s) => (s.id === asset.id ? asset : s))
            : [...(snapshot.secrets ?? []), asset],
        };
      });
      return { ...result, asset };
    },
    "save-posts": async ([input]) => {
      const account = await service.get(input?.assetId);
      const result = await service.readPosts(input?.assetId, input?.postIds, {
        force: input?.force === true,
      });
      assert();
      if (!result.items.length) return { documentId: null, imported: 0, errors: result.errors };
      const saved = await documents().save(identityPostsDocument(account, result.items), {
        assertCurrent: assert,
      });
      emit("documents:changed", { document: saved });
      return { documentId: saved.id, imported: result.items.length, errors: result.errors };
    },
  };
  return {
    channels: Object.keys(handlers).map((key) => "identities:" + key),
    async pruneAssets(snapshot) {
      const ids = new Set(
        (snapshot?.secrets ?? []).filter((s) => s.identityProvider === "linuxdo").map((s) => s.id),
      );
      const stale = (await store.list()).filter(
        (id) => id.startsWith("identity-auth:") && !ids.has(id.slice(14)),
      );
      if (stale.length)
        await store.removeMany(
          stale.flatMap((key) => [key, `account:${key.slice(14)}`, `totp:${key.slice(14)}`]),
        );
    },
    call(channel, args, context) {
      return scope.run(context, async () => {
        assert();
        const result = await handlers[channel.slice(11)](args ?? []);
        assert();
        return result;
      });
    },
    dropSessions() {
      for (const [id, owner] of owners)
        if (!sessionActive(owner)) {
          service.cancel(id);
          owners.delete(id);
        }
    },
    stop() {
      stopped = true;
      service.stop();
      owners.clear();
    },
  };
}
