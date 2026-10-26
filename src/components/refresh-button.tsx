import { useAppStore } from "@/lib/store";
import { canProbeServer, isCollectionPaused } from "@/lib/server-observation.mjs";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { isDesktop } from "@/lib/desktop";
import { refreshAll, refreshById, useProbeState, type ProbeKind } from "@/lib/probes";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

const NEEDS_VAULT: Record<ProbeKind, boolean> = { server: true, domain: false, cert: false };
const LABEL: Record<ProbeKind, string> = { server: "主机", domain: "域名", cert: "证书" };

/** Probe every asset of one kind. Hidden entirely in the web preview. */
export function RefreshAllButton({ kind }: { kind: ProbeKind | null }) {
  const [busy, setBusy] = useState(false);
  const requireVault = useVault((s) => s.require);
  if (!isDesktop() || !kind) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      title={t("重新采集全部{0}", t(LABEL[kind]))}
      onClick={async () => {
        if (
          kind === "server" &&
          !useAppStore.getState().servers.some((server) => !server.demo && canProbeServer(server))
        ) {
          toast(t("先为需要采集的主机配置 SSH。"));
          return;
        }
        if (
          NEEDS_VAULT[kind] &&
          !(await requireVault(t("采集主机指标需要读取已保存的 SSH 凭据。")))
        ) {
          return;
        }
        setBusy(true);
        try {
          const n = await refreshAll(kind);
          if (n > 0) useAppStore.getState().log(t("手动检查了 {0} 项{1}", n, t(LABEL[kind])), kind);
          toast(t("已刷新 {0} 项{1}", n, t(LABEL[kind])));
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />

      {t("刷新")}
    </Button>
  );
}

/** Probe one asset, from its detail sheet. */
export function RefreshOneButton({ kind, id }: { kind: ProbeKind; id: string }) {
  const busy = useProbeState((s) => Boolean(s.busy[id]));
  const configured = useAppStore(
    (s) =>
      kind !== "server" || s.servers.find((server) => server.id === id)?.sshConfigured !== false,
  );
  const paused = useAppStore(
    (s) =>
      kind === "server" && isCollectionPaused(s.servers.find((server) => server.id === id) ?? {}),
  );
  const requireVault = useVault((s) => s.require);
  if (!isDesktop()) return null;
  const label = paused ? "已关闭自动采集" : configured ? "重新采集" : "配置 SSH";

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={busy || paused}
      aria-label={t(label)}
      title={t(label)}
      onClick={async () => {
        if (!configured) {
          useAppStore.getState().openComposer("server", id);
          return;
        }
        if (
          NEEDS_VAULT[kind] &&
          !(await requireVault(t("采集主机指标需要读取已保存的 SSH 凭据。")))
        ) {
          return;
        }
        await refreshById(kind, id);
        const state = useAppStore.getState();
        const asset = (
          kind === "server" ? state.servers : kind === "domain" ? state.domains : state.certs
        ).find((item) => item.id === id);
        if (asset && !asset.demo) state.log(t("手动检查了{0}状态", t(LABEL[kind])), kind);
      }}
    >
      <RefreshCw className={cn("size-4", busy && "animate-spin")} />
    </Button>
  );
}
