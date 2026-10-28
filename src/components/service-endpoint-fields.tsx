import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { Field, Input, Select } from "./ui/input";

const NONE = "__none";

/** 服务表单里的「运行位置」：绑定到哪台主机的哪个端口 / 容器，对外用哪个域名。 */
export function ServiceEndpointFields({
  form,
  set,
}: {
  form: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const server = servers.find((item) => item.id === form.endpointServer);
  const scan = server?.serviceScan;
  const containers = scan?.docker.containers ?? [];
  const containerNames = new Set(containers.map((container) => container.name));
  return (
    <div className="space-y-3 rounded-xl border border-line p-3 sm:col-span-2">
      <div>
        <p className="text-meta font-medium">{t("运行位置（可选）")}</p>
        <p className="mt-1 text-2xs leading-relaxed text-muted">
          {t(
            "绑定后，服务的状态由这台主机最近一次采集到的端口、容器和域名自动决定，端口没在监听或容器停了会提醒你。",
          )}
        </p>
      </div>
      <Field label={t("运行在")}>
        <Select
          aria-label={t("运行在")}
          value={form.endpointServer || NONE}
          onValueChange={(value) => set("endpointServer", value === NONE ? "" : value)}
          options={[
            { value: NONE, label: t("不绑定") },
            ...servers.map((item) => ({ value: item.id, label: item.name })),
          ]}
        />
      </Field>
      {server && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("监听端口")}>
            <Input
              aria-label={t("监听端口")}
              inputMode="numeric"
              list="endpoint-ports"
              placeholder={t("例如 8080")}
              maxLength={5}
              value={form.endpointPort ?? ""}
              onChange={(event) => set("endpointPort", event.target.value.replace(/\D/g, ""))}
            />
            <datalist id="endpoint-ports">
              {(scan?.ports ?? []).map((port) => (
                <option key={`${port.proto}:${port.port}`} value={port.port}>
                  {port.process ?? ""}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label={t("端口协议")}>
            <Select
              aria-label={t("端口协议")}
              value={form.endpointProto || "tcp"}
              onValueChange={(value) => set("endpointProto", value)}
              options={[
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
            />
          </Field>
          <Field label={t("Docker 容器")}>
            <Select
              aria-label={t("Docker 容器")}
              value={form.endpointContainer || NONE}
              onValueChange={(value) => set("endpointContainer", value === NONE ? "" : value)}
              options={[
                { value: NONE, label: t("不指定") },
                ...(form.endpointContainer && !containerNames.has(form.endpointContainer)
                  ? [{ value: form.endpointContainer, label: form.endpointContainer }]
                  : []),
                ...containers.map((container) => ({
                  value: container.name,
                  label: container.name,
                })),
              ]}
            />
          </Field>
          <Field label={t("对外域名")}>
            <Select
              aria-label={t("对外域名")}
              value={form.endpointDomain || NONE}
              onValueChange={(value) => set("endpointDomain", value === NONE ? "" : value)}
              options={[
                { value: NONE, label: t("不指定") },
                ...domains.map((domain) => ({ value: domain.id, label: domain.name })),
              ]}
            />
          </Field>
          {!scan && (
            <p className="text-2xs text-muted sm:col-span-2">
              {t("这台主机还没有采集过端口与容器，保存后在主机详情的「端口与容器」里刷新一次。")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
