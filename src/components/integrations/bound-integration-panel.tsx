import { hostBridge } from "@/lib/web-bridge";
import { useState } from "react";
import { Link2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { IntegrationRef } from "@/lib/integrations";
import { Button } from "../ui/button";
import { DnsManager } from "./dns-manager";
import { ConfirmAction, ProbeHostPanel, ProbeCheckHistory } from "./probe-panels";
import { FetchStatus, ResourceStatus } from "./common";
import { dateText, numberText, openIntegrations, useInventory } from "./data";
import "./integrations.css";

export function BoundIntegrationPanel({
  kind,
  id,
  integration,
}: {
  kind: "domain" | "service" | "server";
  id: string;
  integration: IntegrationRef;
}) {
  const inventory = useInventory(integration.connectionId, integration.provider);
  const [dnsOpen, setDnsOpen] = useState(false);
  const [unbindOpen, setUnbindOpen] = useState(false);
  const resource = inventory.data?.resources.find(
    (row) =>
      row.type === integration.resourceType &&
      row.remoteId === integration.remoteId &&
      row.accountId === integration.accountId,
  );
  return (
    <section className="integration-bound" aria-label={t("云资源与探针状态")}>
      <div className="integration-toolbar">
        <h3 className="flex items-center gap-2 font-semibold text-meta">
          <Link2 className="size-4" />
          {integration.provider === "cloudflare" ? "Cloudflare" : t("知屿独立探针")}
        </h3>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={openIntegrations}>
            {t("管理连接")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setUnbindOpen(true)}>
            {t("解除绑定")}
          </Button>
        </div>
      </div>
      {resource?.host ? (
        <ProbeHostPanel
          connectionId={integration.connectionId}
          host={resource.host}
          updatedAt={inventory.data?.fetchedAt}
        />
      ) : resource ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta break-all">{resource.name}</span>
            <ResourceStatus status={resource.status} />
          </div>
          {resource.check && (
            <p className="text-2xs text-muted">
              {t(
                "延迟 {0} ms · 24 小时可用率 {1} · 检查时间 {2}",
                numberText(resource.check.latencyMs),
                numberText(resource.check.uptime24h, "%"),
                dateText(resource.check.lastCheckedAt),
              )}
            </p>
          )}
          {resource.type === "zone" && (
            <Button variant="secondary" size="sm" onClick={() => setDnsOpen(true)}>
              {t("管理 DNS")}
            </Button>
          )}
        </div>
      ) : (
        inventory.data && (
          <p className="text-meta text-muted">
            {t("未找到已绑定资源，请检查连接权限或远端资源是否仍存在。")}
          </p>
        )
      )}
      {resource?.check && (
        <ProbeCheckHistory
          connectionId={integration.connectionId}
          checkId={resource.check.id}
          intervalSeconds={resource.check.intervalSeconds}
          updatedAt={inventory.data?.fetchedAt}
        />
      )}
      <FetchStatus {...inventory} />
      {dnsOpen && resource && (
        <DnsManager
          connectionId={integration.connectionId}
          zoneId={resource.remoteId}
          name={resource.name}
          onClose={() => setDnsOpen(false)}
        />
      )}
      {unbindOpen && (
        <ConfirmAction
          title={t("解除绑定")}
          description={t("仅解除此资产的远端关联，本机资产和远端资源都会保留。")}
          action={() => hostBridge()!.integrations.unbind({ kind, id })}
          onClose={() => setUnbindOpen(false)}
          onDone={() => setUnbindOpen(false)}
        />
      )}
    </section>
  );
}
