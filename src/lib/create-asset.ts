import { toast } from "sonner";
import { useAppStore } from "./store";
import { t } from "./i18n";
import type { AssetKind, ViewId } from "./types";

export type CreateTarget = AssetKind | "document" | "phone" | "payment-card" | "esim";

export const CREATE_LABELS: Record<CreateTarget, string> = {
  "payment-card": "添加支付卡",
  esim: "添加 eSIM",
  server: "添加服务器",
  service: "添加服务",
  domain: "添加域名",
  cert: "添加证书",
  mail: "添加邮箱",
  ai: "添加 AI 订阅",
  secret: "添加密钥",
  document: "新建文档",
  phone: "添加号码",
};

const VIEW_TARGETS: Partial<Record<ViewId, CreateTarget>> = {
  cards: "payment-card",
  esims: "esim",
  servers: "server",
  services: "service",
  domains: "domain",
  certs: "cert",
  mail: "mail",
  ai: "ai",
  vault: "secret",
  docs: "document",
  phones: "phone",
};
let creatingDocument = false;

export async function createAsset(target?: CreateTarget) {
  const state = useAppStore.getState();
  if (!target) {
    state.setCreatePickerOpen(true);
    return;
  }
  state.setCreatePickerOpen(false);
  if (target === "payment-card" || target === "esim") {
    state.setView(target === "esim" ? "esims" : "cards");
    state.openComposer("service", null, { _cardKind: target === "esim" ? "esim" : "payment" });
  } else if (target === "phone") {
    state.openPhones({ create: true });
  } else if (target === "document") {
    if (creatingDocument) return;
    creatingDocument = true;
    try {
      const { useDocuments } = await import("./documents");
      if (!useDocuments.getState().loaded) await useDocuments.getState().load();
      await useDocuments.getState().create();
      useAppStore.getState().setView("docs");
    } catch (error) {
      toast.error(t("新建文档失败：{0}", error instanceof Error ? error.message : String(error)));
    } finally {
      creatingDocument = false;
    }
  } else {
    state.openComposer(target);
  }
}

export function createInCurrentView() {
  return createAsset(VIEW_TARGETS[useAppStore.getState().view]);
}
