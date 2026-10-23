import type { StateStorage } from "zustand/middleware";
import { toast } from "sonner";
import { webApi, WebConflictError } from "./web";

/**
 * 网页版的资料存储：整份资料存在服务器上的 assets.json（与桌面版同一文件）。
 *
 * 每次保存带上读到时的版本号；家里和公司同时改时，后保存的一方会收到冲突，
 * 此时以服务器上的最新资料为准重新载入，并提示刚才那次修改需要重做。
 */
let revision: string | null = null;
let lastSent: string | null = null;
let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> | null = null;
let reload: (() => Promise<void>) | null = null;

async function flush() {
  if (writing || pending === null) return;
  const value = pending;
  pending = null;
  writing = (async () => {
    try {
      const res = await webApi<{ revision: string }>("store", {
        method: "PUT",
        body: { revision, data: JSON.parse(value) },
      });
      revision = res.revision;
      lastSent = value;
    } catch (error) {
      if (error instanceof WebConflictError) {
        toast.warning("资料已在另一台设备更新，已载入最新内容；刚才的修改请再做一次");
        await reload?.();
      } else toast.error(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
    }
  })();
  await writing;
  writing = null;
  if (pending !== null) void flush();
}

export const webStorage: StateStorage = {
  getItem: async () => {
    const res = await webApi<{ revision: string | null; data: unknown }>("store");
    revision = res.revision;
    lastSent = res.data ? JSON.stringify(res.data) : null;
    return lastSent;
  },
  setItem: async (_name, value) => {
    if (value === lastSent) return;
    pending = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 400);
  },
  removeItem: async () => {},
};

/** 回到这个标签页时检查服务器上是否有别的设备写入的新资料。 */
export function startWebSync(rehydrate: () => Promise<void>) {
  reload = rehydrate;
  const check = async () => {
    if (pending !== null || writing || document.visibilityState !== "visible") return;
    try {
      const res = await webApi<{ revision: string | null }>("store");
      if (res.revision !== revision && pending === null && !writing) await rehydrate();
    } catch {
      // 网络暂时不通时下次再查。
    }
  };
  const onVisible = () => void check();
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  const interval = setInterval(onVisible, 60_000);
  // 关闭页面前把还没发出去的修改发掉。
  const onHide = () => {
    if (pending !== null) void flush();
  };
  window.addEventListener("pagehide", onHide);
  return () => {
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pagehide", onHide);
    clearInterval(interval);
  };
}
