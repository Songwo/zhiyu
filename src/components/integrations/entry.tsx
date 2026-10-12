import { Cloud } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "../ui/button";
import { openIntegrations } from "./data";
import "./integrations.css";

export function IntegrationsEntry() {
  return (
    <div className="integration-entry">
      <Cloud className="size-5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <h2 className="font-medium text-meta">{t("云服务与探针")}</h2>
        <p className="mt-1 text-2xs text-muted">
          {t("连接 Cloudflare、管理 DNS，用独立探针持续观察主机与服务。")}
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={openIntegrations}>
        {t("管理连接")}
      </Button>
    </div>
  );
}
