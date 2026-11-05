import { create } from "zustand";
import { desktop, type UpdateCheck } from "./desktop";
import { isWeb } from "./web";
import { webInvoke } from "./web-bridge";

export const useAppUpdates = create<{
  status: UpdateCheck | null;
  dismissed: string | null;
  setStatus: (status: UpdateCheck) => void;
  dismiss: () => void;
}>((set, get) => ({
  status: null,
  dismissed: null,
  setStatus: (status) => set({ status }),
  dismiss: () => set({ dismissed: get().status?.latest ?? null }),
}));

/** 桌面版由主进程在后台检查；Web 定时检查镜像版本，不执行服务器升级。 */
export function startUpdateNotices() {
  let alive = true,
    events = 0;
  const api = desktop();
  if (api) {
    const off = api.updates.onStatus((status) => {
      events++;
      if (alive) useAppUpdates.getState().setStatus(status);
    });
    void api.updates
      .status()
      .then((status) => {
        if (alive && !events) useAppUpdates.getState().setStatus(status);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }
  if (!isWeb()) return;
  let last = 0,
    next = Date.now() + 30000,
    running = false;
  const tick = async () => {
    if (!alive || running || Date.now() < next) return;
    running = true;
    last = Date.now();
    next = last + 4 * 3600000;
    try {
      const status = await webInvoke<UpdateCheck>("app:check-update");
      if (alive) useAppUpdates.getState().setStatus(status);
      if (status.state === "error") next = last + 15 * 60000;
    } catch {
      next = last + 15 * 60000;
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), 30000);
  window.addEventListener("focus", tick);
  window.addEventListener("online", tick);
  return () => {
    alive = false;
    window.clearInterval(timer);
    window.removeEventListener("focus", tick);
    window.removeEventListener("online", tick);
  };
}
