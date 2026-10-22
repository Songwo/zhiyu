import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { selectiveStorage } from "./selective-storage";
import { desktop, isDesktop } from "./desktop";
import { EMPTY_SNAPSHOT, SEED_ACTIVITY, SEED_SNAPSHOT } from "./seed";
import type {
  ActivityItem,
  AiAsset,
  AssetKind,
  Billing,
  Certificate,
  Domain,
  Mailbox,
  PhoneNumber,
  Secret,
  Server,
  ServiceAsset,
  Snapshot,
  ViewId,
} from "./types";
import { uid } from "./utils";
import { t } from "./i18n.ts";
import { normalizeLinks, refKey, type AssetRef, type AssetLink } from "./operations";
import type { AiAccount } from "./ai-accounts";
import { subscriptionFromAccount } from "./ai-subscriptions";
import { normalizeSnapshotImages } from "../../electron/services/image-data.mjs";
import { normalizeMailFolders } from "./mail-folders";
import { normalizeSecretFolders } from "./secret-folders";
import {
  normalizePhoneNumber,
  normalizePhoneNumbers,
} from "../../electron/services/phone-numbers.mjs";
import { normalizeUsageDraft } from "./usage-setup.mjs";
import { calendarDay, normalizeBilling } from "../../electron/services/renewals.mjs";
import { retainActivity } from "./activity-history.mjs";

export interface UsageSetupDraft {
  type?: "3x-ui" | "subscription" | "openai-api" | "anthropic-api";
  serverId?: string;
  nodeId?: string;
  name?: string;
}

export interface ExpandState {
  kind: AssetKind;
  id: string;
  focus?: "account";
  origin: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface AppState extends Snapshot {
  services: ServiceAsset[];
  upsertService: (s: ServiceAsset) => void;
  phoneNumbers: PhoneNumber[];
  phoneFilter: "all" | "attention" | "expired" | "active" | "unknown";
  phoneFocusId: string | null;
  phoneCreateRequested: boolean;
  setPhoneFilter: (filter: AppState["phoneFilter"]) => void;
  openPhones: (options?: {
    id?: string;
    query?: string;
    attention?: boolean;
    create?: boolean;
  }) => void;
  upsertPhoneNumber: (record: PhoneNumber) => void;
  removePhoneNumber: (id: string) => void;
  links: AssetLink[];
  linkAssets: (from: AssetRef, to: AssetRef) => void;
  unlinkAssets: (from: AssetRef, to: AssetRef) => void;
  view: ViewId;
  filter: "all" | "attention";
  query: string;
  /** Tags the current list is narrowed to. Every selected tag must match. */
  tagFilter: string[];
  /** Break the list into one section per tag instead of one flat grid. */
  groupByTag: boolean;
  activity: ActivityItem[];
  expanded: ExpandState | null;
  sshServerId: string | null;
  commandOpen: boolean;
  settingsOpen: boolean;
  /** 系统设置作为主内容区的一页打开（头像菜单进入），与右上角的设置弹窗互不影响。 */
  settingsPage: boolean;
  settingsTab: string;
  composerOpen: boolean;
  createPickerOpen: boolean;
  setCreatePickerOpen: (open: boolean) => void;
  composerKind: AssetKind;
  editingId: string | null;
  composerPreset: Record<string, string> | null;
  usageSetupDraft: UsageSetupDraft | null;
  openUsageSetup: (draft?: UsageSetupDraft) => void;
  clearUsageSetup: () => void;
  mobileNav: boolean;
  hydrated: boolean;

  setView: (v: ViewId) => void;
  setFilter: (f: "all" | "attention") => void;
  setQuery: (q: string) => void;
  toggleTag: (tag: string) => void;
  /** Jump to the cross-kind view for one tag. */
  focusTag: (tag: string) => void;
  clearTags: () => void;
  setGroupByTag: (v: boolean) => void;
  setExpanded: (e: ExpandState | null) => void;
  openSsh: (serverId: string) => void;
  closeSsh: () => void;
  setCommandOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  openSettingsPage: (tab?: string) => void;
  closeSettingsPage: () => void;
  setSettingsTab: (tab: string) => void;
  openComposer: (
    kind: AssetKind,
    editingId?: string | null,
    preset?: Record<string, string>,
  ) => void;
  linkAssetsMany: (from: AssetRef, targets: AssetRef[]) => void;
  closeComposer: () => void;
  setMobileNav: (v: boolean) => void;
  setHydrated: (v: boolean) => void;

  upsertServer: (s: Server) => void;
  upsertDomain: (s: Domain) => void;
  upsertMail: (s: Mailbox) => void;
  upsertAi: (s: AiAsset) => void;
  syncAiAccount: (account: AiAccount, assetId?: string) => void;
  disconnectAiAccount: (accountId: string) => void;
  upsertSecret: (s: Secret) => void;
  upsertCert: (s: Certificate) => void;
  remove: (kind: AssetKind, id: string) => void;
  patchServerMetrics: (
    id: string,
    patch: Partial<Pick<Server, "cpu" | "memory" | "status" | "lastSeen">>,
  ) => void;
  log: (text: string, kind?: ActivityItem["kind"]) => void;
  resetDemo: () => void;
  importSnapshot: (snap: Snapshot) => void;
}

/** Sample data is a web-preview thing; the desktop app starts with your assets only. */
const initialSnapshot = () => (isDesktop() ? EMPTY_SNAPSHOT : SEED_SNAPSHOT);
const initialActivity = () => (isDesktop() ? [] : SEED_ACTIVITY);

const emptyUi = {
  view: "overview" as ViewId,
  filter: "all" as const,
  query: "",
  phoneFilter: "all" as const,
  phoneFocusId: null as string | null,
  phoneCreateRequested: false,
  tagFilter: [] as string[],
  groupByTag: false,
  expanded: null,
  sshServerId: null,
  commandOpen: false,
  settingsOpen: false,
  settingsPage: false,
  settingsTab: "appearance",
  composerOpen: false,
  createPickerOpen: false,
  composerKind: "server" as AssetKind,
  editingId: null,
  composerPreset: null,
  usageSetupDraft: null,
  mobileNav: false,
};

/**
 * On the desktop the assets live in a real file under the user's app-data
 * directory, not in a browser origin that an update or a cache clear can wipe.
 * The shape is the same either way, so the store does not care which it got.
 */
const diskStorage: StateStorage = {
  getItem: async () => {
    const file = await desktop()?.store.load();
    return file ? JSON.stringify(file) : null;
  },
  setItem: async (_name, value) => {
    await desktop()?.store.save(JSON.parse(value));
  },
  removeItem: async () => {
    await desktop()?.store.save({} as never);
  },
};

/** SSR has neither a bridge nor a browser; hydration happens after mount. */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// `createJSONStorage` calls this immediately, so it must be declared above the
// store — and must not touch `window` on the server render.
function pickStorage(): StateStorage {
  if (typeof window === "undefined") return noopStorage;
  return isDesktop() ? diskStorage : window.localStorage;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialSnapshot(),
      services: [],
      phoneNumbers: [],
      mailFolders: normalizeMailFolders(undefined),
      secretFolders: normalizeSecretFolders(undefined),
      ...emptyUi,
      links: [],
      linkAssets: (from, to) =>
        set({ links: normalizeLinks([...get().links, { from, to }], get()) }),
      linkAssetsMany: (from, targets) =>
        set({
          links: normalizeLinks([...get().links, ...targets.map((to) => ({ from, to }))], get()),
        }),
      unlinkAssets: (from, to) =>
        set({
          links: get().links.filter(
            (link) =>
              !(
                (refKey(link.from) === refKey(from) && refKey(link.to) === refKey(to)) ||
                (refKey(link.from) === refKey(to) && refKey(link.to) === refKey(from))
              ),
          ),
        }),
      activity: initialActivity(),
      hydrated: false,

      // A tag selection belongs to the list you picked it in.
      setView: (view) =>
        set({
          view,
          expanded: null,
          settingsPage: false,
          filter: "all",
          mobileNav: false,
          query: "",
          tagFilter: [],
          phoneFilter: "all",
          phoneFocusId: null,
          phoneCreateRequested: false,
        }),
      setCreatePickerOpen: (createPickerOpen) => set({ createPickerOpen, commandOpen: false }),
      setPhoneFilter: (phoneFilter) => set({ phoneFilter, phoneFocusId: null }),
      openPhones: (options = {}) =>
        set({
          view: "phones",
          query: options.query ?? "",
          phoneFocusId: options.id ?? null,
          phoneFilter: options.attention ? "attention" : "all",
          phoneCreateRequested: options.create ?? false,
          filter: "all",
          expanded: null,
          mobileNav: false,
          commandOpen: false,
          tagFilter: [],
        }),
      setFilter: (filter) => set({ filter }),
      setQuery: (query) => set({ query, phoneFocusId: null }),
      toggleTag: (tag) =>
        set({
          tagFilter: get().tagFilter.includes(tag)
            ? get().tagFilter.filter((t) => t !== tag)
            : [...get().tagFilter, tag],
        }),
      clearTags: () => set({ tagFilter: [] }),
      // Sets both at once: `setView` clears the selection on its own, which is
      // right everywhere except here, where the tag *is* the destination.
      focusTag: (tag) =>
        set({ view: "tags", tagFilter: [tag], query: "", mobileNav: false, expanded: null }),
      setGroupByTag: (groupByTag) => set({ groupByTag }),
      setExpanded: (expanded) => {
        const previous = get().expanded;
        set(expanded ? { expanded, settingsPage: false } : { expanded });
        if (!expanded || (previous?.id === expanded.id && previous.kind === expanded.kind)) return;
        if (
          !(get()[collectionKey(expanded.kind)] as { id: string }[]).some(
            (item) => item.id === expanded.id,
          )
        )
          return;
        const labels: Record<AssetKind, string> = {
          server: "服务器",
          domain: "域名",
          mail: "邮箱",
          ai: "AI 订阅",
          secret: "密钥库",
          cert: "安全证书",
          service: "服务资产",
        };
        get().log(t("查看了{0}详情", t(labels[expanded.kind])), expanded.kind);
      },
      openSsh: (sshServerId) => set({ sshServerId, expanded: null }),
      closeSsh: () => set({ sshServerId: null }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen, commandOpen: false }),
      openSettingsPage: (tab) =>
        set({
          settingsPage: true,
          settingsTab: tab ?? get().settingsTab,
          settingsOpen: false,
          expanded: null,
          commandOpen: false,
          mobileNav: false,
        }),
      closeSettingsPage: () => set({ settingsPage: false }),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      openComposer: (composerKind, editingId = null, preset) =>
        set({
          composerOpen: true,
          composerKind,
          editingId,
          composerPreset: preset ?? null,
          expanded: null,
        }),
      closeComposer: () => set({ composerOpen: false, editingId: null, composerPreset: null }),
      openUsageSetup: (draft = {}) =>
        set({
          view: "usage",
          usageSetupDraft: normalizeUsageDraft(draft) as UsageSetupDraft,
          expanded: null,
          composerOpen: false,
          editingId: null,
          composerPreset: null,
          commandOpen: false,
          mobileNav: false,
          query: "",
          tagFilter: [],
        }),
      clearUsageSetup: () => set({ usageSetupDraft: null }),
      setMobileNav: (mobileNav) => set({ mobileNav }),
      setHydrated: (hydrated) => set({ hydrated }),

      upsertPhoneNumber: (record) =>
        set({
          phoneNumbers: normalizePhoneNumbers(
            upsert(get().phoneNumbers, normalizePhoneNumber(record)),
          ),
        }),
      removePhoneNumber: (id) =>
        set({ phoneNumbers: get().phoneNumbers.filter((record) => record.id !== id) }),
      upsertServer: (s) =>
        set({
          servers: upsert(get().servers, s),
        }),
      upsertDomain: (s) => set({ domains: upsert(get().domains, s) }),
      upsertMail: (s) => set({ mailboxes: upsert(get().mailboxes, s) }),
      upsertAi: (s) => set({ aiAssets: upsert(get().aiAssets, s) }),
      syncAiAccount: (account, assetId) => {
        const previous =
          get().aiAssets.find((item) => item.oauthAccountId === account.id) ??
          get().aiAssets.find((item) => item.id === assetId);
        get().upsertAi(subscriptionFromAccount(account, previous));
      },
      disconnectAiAccount: (accountId) =>
        set({
          aiAssets: get().aiAssets.map((item) =>
            item.oauthAccountId === accountId
              ? { ...item, oauthDisconnected: true, status: "warning" }
              : item,
          ),
        }),
      upsertSecret: (s) => set({ secrets: upsert(get().secrets, s) }),
      upsertCert: (s) => set({ certs: upsert(get().certs, s) }),
      upsertService: (s) => set({ services: upsert(get().services, s) }),

      remove: (kind, id) => {
        const key = collectionKey(kind);
        const removed = (
          get()[key] as { id: string; name?: string; address?: string; cn?: string }[]
        ).find((x) => x.id === id);
        set({
          [key]: (get()[key] as { id: string }[]).filter((x) => x.id !== id),
          links: get().links.filter(
            (link) =>
              refKey(link.from) !== refKey({ kind, id }) &&
              refKey(link.to) !== refKey({ kind, id }),
          ),
          expanded: null,
          ...(kind === "ai"
            ? {
                phoneNumbers: get().phoneNumbers.map((record) => ({
                  ...record,
                  subscriptionIds: record.subscriptionIds.filter(
                    (subscriptionId) => subscriptionId !== id,
                  ),
                })),
              }
            : {}),
        } as Partial<AppState>);
        get().log(t("已移除 {0}", removed?.name ?? removed?.address ?? removed?.cn ?? id), kind);
      },

      patchServerMetrics: (id, patch) =>
        set({
          servers: get().servers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        }),

      log: (text, kind = "system") =>
        set({
          activity: retainActivity([
            {
              id: uid("act"),
              at: new Date().toISOString(),
              text,
              kind,
            },
            ...get().activity,
          ]),
        }),

      resetDemo: () =>
        set({
          ...initialSnapshot(),
          services: [],
          phoneNumbers: [],
          links: [],
          activity: initialActivity(),
          ...emptyUi,
        }),

      importSnapshot: (input) => {
        const snap = normalizeSnapshotImages(input);
        set({
          links: normalizeLinks(snap.links, snap),
          phoneNumbers: normalizePhoneNumbers(snap.phoneNumbers),
          servers: withServerExpiry(snap.servers ?? []),
          domains: withBilling(snap.domains ?? []),
          mailboxes: snap.mailboxes ?? [],
          mailFolders: normalizeMailFolders(snap.mailFolders),
          secretFolders: normalizeSecretFolders(snap.secretFolders),
          aiAssets: snap.aiAssets ?? [],
          secrets: snap.secrets ?? [],
          certs: snap.certs ?? [],
          services: snap.services ?? [],
        });
      },
    }),
    {
      name: "sinan-assets-v1",
      skipHydration: true,
      storage: selectiveStorage(
        createJSONStorage<Snapshot & { activity: ActivityItem[] }>(pickStorage)!,
      ),
      // Records written before tags existed have no `tags` array, and every
      // reader treats it as required. Normalise once, on the way in.
      merge: (persisted, current) => {
        const saved = normalizeSnapshotImages((persisted ?? {}) as Partial<AppState>, {
          strict: false,
        });
        return {
          ...current,
          ...saved,
          activity: retainActivity(saved.activity ?? current.activity),
          phoneNumbers: normalizePhoneNumbers(saved.phoneNumbers, false),
          servers: withServerExpiry(withTags(saved.servers)),
          domains: withBilling(withTags(saved.domains)),
          mailboxes: withTags(saved.mailboxes),
          mailFolders: normalizeMailFolders(saved.mailFolders),
          secretFolders: normalizeSecretFolders(saved.secretFolders),
          aiAssets: withTags(saved.aiAssets),
          secrets: withTags(saved.secrets),
          certs: withTags(saved.certs),
          services: withTags(saved.services),
          links: normalizeLinks(saved.links, {
            servers: saved.servers ?? [],
            domains: saved.domains ?? [],
            mailboxes: saved.mailboxes ?? [],
            aiAssets: saved.aiAssets ?? [],
            secrets: saved.secrets ?? [],
            certs: saved.certs ?? [],
            services: saved.services ?? [],
          }),
        };
      },
      partialize: (s) => ({
        phoneNumbers: s.phoneNumbers,
        links: s.links,
        servers: s.servers,
        domains: s.domains,
        mailboxes: s.mailboxes,
        mailFolders: s.mailFolders,
        secretFolders: s.secretFolders,
        aiAssets: s.aiAssets,
        secrets: s.secrets,
        certs: s.certs,
        services: s.services,
        activity: retainActivity(s.activity),
      }),
    },
  ),
);

function withTags<T extends { tags?: string[] }>(list: T[] | undefined): T[] {
  return (list ?? []).map((x) => (Array.isArray(x.tags) ? x : { ...x, tags: [] }));
}

/** 费用是后加的可选字段：缺失保持缺失，残缺或非法的值直接去掉。 */
function withBilling<T extends { billing?: Billing }>(list: T[]): T[] {
  return list.map((x) => {
    const { billing: raw, ...rest } = x;
    const billing = normalizeBilling(raw);
    return { ...rest, ...(billing ? { billing } : {}) } as T;
  });
}

/** 服务器的 VPS 到期日同样是可选字段，统一成 YYYY-MM-DD。 */
function withServerExpiry(list: Server[]): Server[] {
  return withBilling(list).map(({ expiresAt: raw, ...rest }) => {
    const expiresAt = calendarDay(raw);
    return expiresAt ? { ...rest, expiresAt } : rest;
  });
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

function collectionKey(
  kind: AssetKind,
): Exclude<keyof Snapshot, "links" | "mailFolders" | "secretFolders" | "phoneNumbers"> {
  switch (kind) {
    case "server":
      return "servers";
    case "domain":
      return "domains";
    case "mail":
      return "mailboxes";
    case "ai":
      return "aiAssets";
    case "secret":
      return "secrets";
    case "cert":
      return "certs";
    case "service":
      return "services";
  }
}

export function snapshotOf(s: Snapshot): Snapshot {
  return {
    phoneNumbers: s.phoneNumbers ?? [],
    links: s.links ?? [],
    servers: s.servers,
    domains: s.domains,
    mailboxes: s.mailboxes,
    mailFolders: s.mailFolders,
    secretFolders: s.secretFolders,
    aiAssets: s.aiAssets,
    secrets: s.secrets,
    certs: s.certs,
    services: s.services ?? [],
  };
}
