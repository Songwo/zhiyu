import { hostBridge } from "./web-bridge";
import { create } from "zustand";

export interface Profile {
  name: string;
  avatarDataUrl?: string;
  ready: boolean;
  vaultExists: boolean;
  mainIdentity?: import("./main-identity").MainIdentity | null;
}
export const useProfile = create<{
  profile: Profile | null;
  error: string;
  refresh: () => Promise<void>;
}>((set) => ({
  profile: null,
  error: "",
  refresh: async () => {
    try {
      set({
        error: "",
        profile: (await hostBridge()?.profile.get()) ?? {
          name: "知屿",
          ready: true,
          vaultExists: false,
        },
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
}));
