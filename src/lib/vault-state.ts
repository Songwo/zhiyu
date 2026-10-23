import { create } from "zustand";
import { vaultApi } from "./vault-api";

interface VaultState {
  checked: boolean;
  exists: boolean;
  unlocked: boolean;
  /** Set while a dialog is asking for the master password. */
  prompt: { reason: string } | null;

  refresh: () => Promise<void>;
  create: (master: string) => Promise<void>;
  unlock: (master: string) => Promise<void>;
  lock: () => Promise<void>;
  /** Open the dialog and resolve once the vault is usable — or false if dismissed. */
  require: (reason: string) => Promise<boolean>;
  resolvePrompt: (ok: boolean) => void;
}

/** The single in-flight `require()` waiter. */
let pending: ((ok: boolean) => void) | null = null;

export const useVault = create<VaultState>((set, get) => ({
  checked: false,
  exists: false,
  unlocked: false,
  prompt: null,

  refresh: async () => {
    const api = vaultApi();
    if (!api) {
      set({ checked: true, exists: false, unlocked: false });
      return;
    }
    const status = await api.status();
    set({ checked: true, exists: status.exists, unlocked: status.unlocked });
  },

  create: async (master) => {
    await vaultApi()?.create(master);
    set({ exists: true, unlocked: true });
    get().resolvePrompt(true);
  },

  unlock: async (master) => {
    await vaultApi()?.unlock(master);
    set({ exists: true, unlocked: true });
    get().resolvePrompt(true);
  },

  lock: async () => {
    await vaultApi()?.lock();
    set({ unlocked: false });
  },

  require: async (reason) => {
    const api = vaultApi();
    if (!api) return false;
    const status = await api.status();
    set({ checked: true, exists: status.exists, unlocked: status.unlocked });
    if (status.unlocked) return true;
    // A second caller joins the dialog already on screen instead of stacking one.
    if (pending)
      return new Promise<boolean>((resolve) => {
        const previous = pending!;
        pending = (ok) => {
          previous(ok);
          resolve(ok);
        };
      });
    set({ prompt: { reason } });
    return new Promise<boolean>((resolve) => {
      pending = resolve;
    });
  },

  resolvePrompt: (ok) => {
    set({ prompt: null });
    const resolve = pending;
    pending = null;
    resolve?.(ok);
  },
}));
