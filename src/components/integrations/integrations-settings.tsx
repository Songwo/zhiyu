import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useState } from "react";
import {
  Activity,
  Cloud,
  Globe,
  Link2,
  Pencil,
  Plus,
  Search,
  Server,
  Trash2,
  Zap,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import type {
  IntegrationConnection,
  IntegrationConnectionInput,
  IntegrationResource,
  IntegrationResourceType,
  ProbeCheck,
} from "@/lib/integrations";
import { Button } from "../ui/button";
import { Field, Input, Select } from "../ui/input";
import { EditorDialog } from "../ui/editor-dialog";
import { DnsManager } from "./dns-manager";
import {
  CheckEditor,
  ConfirmAction,
  ProbeEnrollment,
  ProbeHostPanel,
  ProbeCheckHistory,
} from "./probe-panels";
import { FetchStatus, ResourceStatus } from "./common";
import { dateText, errorText, numberText, useInventory } from "./data";
import "./integrations.css";

const RESOURCE_LABELS: Record<IntegrationResourceType, string> = {
  zone: "域名",
  worker: "Workers",
  pages: "Pages",
  tunnel: "Tunnel",
  host: "探针主机",
  check: "服务检查",
};
const RESOURCE_ICONS = {
  zone: Globe,
  worker: Zap,
  pages: Globe,
  tunnel: Cloud,
  host: Server,
  check: Activity,
};

export function IntegrationsSettings() {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<IntegrationConnection | "new" | null>(null);
  const [removing, setRemoving] = useState<IntegrationConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!hostBridge()?.integrations) return;
    let cancelled = false;
    setBusy(true);
    void hostBridge()!
      .integrations.list()
      .then((rows) => {
        if (!cancelled) {
          setConnections(rows);
          setSelected((current) =>
            rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? ""),
          );
          setError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  const connection = connections.find((row) => row.id === selected);
  if (!hostBridge()?.integrations) return <p className="integration-empty">{t("仅桌面版可用")}</p>;
  return (
    <section className="integration-workspace" aria-label={t("云服务与探针")}>
      <div className="integration-toolbar">
        <div>
          <h3 className="text-lg font-semibold">{t("云服务与探针")}</h3>
          <p className="mt-1 text-2xs text-muted">{t("资源连接与资产关联，集中在这里管理。")}</p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus />
          {t("添加连接")}
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-2">
          <p className="tool-error" role="alert">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setRevision((n) => n + 1)}>
            {t("重试")}
          </Button>
        </div>
      )}
      <div className="integration-connections" role="group" aria-label={t("已配置连接")}>
        {connections.map((item) => (
          <button
            key={item.id}
            className="integration-connection"
            aria-pressed={selected === item.id}
            onClick={() => setSelected(item.id)}
          >
            {item.provider === "cloudflare" ? (
              <Cloud className="size-4" />
            ) : (
              <Activity className="size-4" />
            )}
            <span className="text-meta">{item.name}</span>
          </button>
        ))}
      </div>
      {connection ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-2xs text-muted flex-1 min-w-0 break-all">
              {connection.provider === "cloudflare" ? "Cloudflare API" : connection.endpoint}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setEditing(connection)}>
              <Pencil />
              {t("编辑连接")}
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={() => setRemoving(connection)}>
              <Trash2 />
              {t("移除连接")}
            </Button>
          </div>
          <ConnectionWorkspace key={`${connection.id}:${revision}`} connection={connection} />
        </>
      ) : (
        <div className="integration-empty">
          {busy ? t("正在加载…") : t("添加 Cloudflare API Token 或知屿监控服务端，开始管理资源。")}
        </div>
      )}
      {editing && (
        <ConnectionEditor
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setSelected(saved.id);
            setEditing(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {removing && (
        <ConfirmAction
          title={t("移除连接")}
          description={t("将移除本机保存的连接凭据。已导入资产保留，远端资源不会删除。")}
          action={() => hostBridge()!.integrations.remove(removing.id)}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

function ConnectionEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: IntegrationConnection;
  onClose: () => void;
  onSaved: (connection: IntegrationConnection) => void;
}) {
  const [value, setValue] = useState<IntegrationConnectionInput>({
    id: initial?.id,
    provider: initial?.provider ?? "cloudflare",
    name: initial?.name ?? "",
    endpoint: initial?.endpoint ?? "",
    allowInsecure: initial?.allowInsecure ?? false,
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <EditorDialog
      title={initial ? t("编辑连接") : t("添加连接")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="integration-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const saved = await hostBridge()!.integrations.save({
              ...value,
              name: value.name.trim(),
              token: token.trim() || undefined,
            });
            setToken("");
            onSaved(saved);
          } catch (reason) {
            setError(errorText(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("连接类型")}>
          <Select
            aria-label={t("连接类型")}
            disabled={!!initial}
            value={value.provider}
            onValueChange={(provider) =>
              setValue({ ...value, provider: provider as "cloudflare" | "probe" })
            }
            options={[
              { value: "cloudflare", label: "Cloudflare" },
              { value: "probe", label: t("知屿独立探针") },
            ]}
          />
        </Field>
        <Field label={t("连接名称")}>
          <Input
            aria-label={t("连接名称")}
            required
            maxLength={160}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </Field>
        {value.provider === "probe" && (
          <>
            <Field label={t("监控服务端地址")}>
              <Input
                aria-label={t("监控服务端地址")}
                required
                type="url"
                value={value.endpoint}
                placeholder="https://probe.example.com"
                onChange={(event) => setValue({ ...value, endpoint: event.target.value })}
              />
            </Field>
            <label className="flex items-start gap-2 text-meta text-muted">
              <input
                className="mt-1"
                type="checkbox"
                checked={!!value.allowInsecure}
                onChange={(event) => setValue({ ...value, allowInsecure: event.target.checked })}
              />
              {t("允许内网 HTTP 明文连接（仅用于受信任网络）")}
            </label>
          </>
        )}
        <Field label={value.provider === "probe" ? t("监控管理员 Token") : "Cloudflare API Token"}>
          <Input
            aria-label={value.provider === "probe" ? t("监控管理员 Token") : "Cloudflare API Token"}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            required={!initial?.hasToken}
            value={token}
            placeholder={initial?.hasToken ? t("留空保留当前 Token") : ""}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <p className="text-2xs leading-relaxed text-muted">
          {t("凭据由操作系统加密保存在本机；不会写入资产或浏览器存储。")}
        </p>
        {value.provider === "cloudflare" && (
          <p className="text-2xs leading-relaxed text-muted">
            {t(
              "按需授权 Zone / DNS、Workers Scripts、Pages、Cloudflare Tunnel 的读取权限；修改 DNS 还需 DNS 编辑权限。权限不足的资源会单独提示。",
            )}
          </p>
        )}
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={busy}>
            {t("保存连接")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

function ConnectionWorkspace({ connection }: { connection: IntegrationConnection }) {
  const inventory = useInventory(connection.id, connection.provider);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [binding, setBinding] = useState<IntegrationResource | null>(null);
  const [dns, setDns] = useState<IntegrationResource | null>(null);
  const [hostKey, setHostKey] = useState("");
  const [checkHistoryKey, setCheckHistoryKey] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [check, setCheck] = useState<ProbeCheck | "new" | null>(null);
  const [removing, setRemoving] = useState<IntegrationResource | null>(null);
  const resources = inventory.data?.resources ?? [];
  const host = resources.find((resource) => resource.key === hostKey)?.host;
  const checkHistory = resources.find((resource) => resource.key === checkHistoryKey)?.check;
  const visible = resources.filter(
    (resource) =>
      (filter === "all" || resource.type === filter) &&
      `${resource.name} ${resource.url} ${resource.remoteId}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const types =
    connection.provider === "cloudflare"
      ? (["zone", "worker", "pages", "tunnel"] as const)
      : (["host", "check"] as const);
  return (
    <div className="integration-workspace">
      <div className="integration-stats">
        <div className="integration-stat">
          <p className="text-2xs text-muted">{t("远端资源")}</p>
          <p className="mt-1 text-xl font-semibold">{inventory.data ? resources.length : "—"}</p>
        </div>
        <div className="integration-stat">
          <p className="text-2xs text-muted">
            {connection.provider === "probe" ? t("在线主机") : t("域名")}
          </p>
          <p className="mt-1 text-xl font-semibold">
            {inventory.data
              ? resources.filter((resource) =>
                  connection.provider === "probe"
                    ? resource.host?.status === "online"
                    : resource.type === "zone",
                ).length
              : "—"}
          </p>
        </div>
        <div className="integration-stat">
          <p className="text-2xs text-muted">{t("自动同步")}</p>
          <p className="mt-1 text-xl font-semibold">
            {connection.provider === "probe" ? "5s" : "60s"}
          </p>
        </div>
      </div>
      <div className="integration-toolbar">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Search className="size-4 shrink-0 text-muted" />
          <Input
            aria-label={t("搜索远端资源")}
            placeholder={t("搜索远端资源")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          aria-label={t("资源类型")}
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: t("全部类型") },
            ...types.map((type) => ({ value: type, label: t(RESOURCE_LABELS[type]) })),
          ]}
        />
      </div>
      {connection.provider === "probe" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEnrolling(true)}>
            <Plus />
            {t("注册探针主机")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCheck("new")}>
            <Activity />
            {t("新增服务检查")}
          </Button>
        </div>
      )}
      {inventory.data?.warnings.map((warning, index) => (
        <p key={index} role="status" className="tool-error">
          {warning}
        </p>
      ))}
      <div className="integration-resources" aria-busy={inventory.busy}>
        {visible.map((resource) => {
          const Icon = RESOURCE_ICONS[resource.type];
          return (
            <article key={resource.key} className="integration-resource">
              <div className="integration-resource-header">
                <div className="integration-resource-icon">
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-meta font-semibold break-all">{resource.name}</h4>
                  <p className="mt-1 text-2xs text-muted break-all">
                    {t(RESOURCE_LABELS[resource.type])}
                    {resource.url ? ` · ${resource.url}` : ""}
                  </p>
                </div>
                <ResourceStatus status={resource.status} />
              </div>
              {resource.check && (
                <p className="mt-3 text-2xs text-muted">
                  {t(
                    "延迟 {0} ms · 24 小时可用率 {1} · 检查时间 {2}",
                    numberText(resource.check.latencyMs),
                    numberText(resource.check.uptime24h, "%"),
                    dateText(resource.check.lastCheckedAt),
                  )}
                  {resource.check.message ? ` · ${resource.check.message}` : ""}
                </p>
              )}
              {resource.host && (
                <p className="mt-3 text-2xs text-muted">
                  {t("最近上报：{0}", dateText(resource.host.lastSeen))}
                </p>
              )}
              <div className="integration-resource-actions">
                <Button size="sm" variant="secondary" onClick={() => setBinding(resource)}>
                  <Link2 />
                  {t("导入或绑定资产")}
                </Button>
                {resource.type === "zone" && (
                  <Button size="sm" variant="ghost" onClick={() => setDns(resource)}>
                    {t("管理 DNS")}
                  </Button>
                )}
                {resource.host && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setHostKey(resource.key)}>
                      {t("指标与历史")}
                    </Button>
                    <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(resource)}>
                      {t("撤销主机")}
                    </Button>
                  </>
                )}
                {resource.check && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCheckHistoryKey(resource.key)}
                    >
                      {t("延迟与记录")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCheck(resource.check!)}>
                      {t("编辑检查")}
                    </Button>
                    <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(resource)}>
                      {t("删除检查")}
                    </Button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length && (
        <p className="integration-empty">
          {inventory.busy && !inventory.data ? t("正在加载…") : t("没有匹配的远端资源")}
        </p>
      )}
      <FetchStatus {...inventory} />
      {binding && (
        <BindDialog connection={connection} resource={binding} onClose={() => setBinding(null)} />
      )}
      {dns && (
        <DnsManager
          connectionId={connection.id}
          zoneId={dns.remoteId}
          name={dns.name}
          onClose={() => setDns(null)}
        />
      )}
      {host && (
        <EditorDialog title={host.name} onClose={() => setHostKey("")}>
          <div className="integration-form">
            <ProbeHostPanel
              connectionId={connection.id}
              host={host}
              updatedAt={inventory.data?.fetchedAt}
            />
          </div>
        </EditorDialog>
      )}
      {checkHistory && (
        <EditorDialog
          title={t("服务检查 · {0}", checkHistory.name)}
          onClose={() => setCheckHistoryKey("")}
        >
          <div className="integration-form">
            <ProbeCheckHistory
              connectionId={connection.id}
              checkId={checkHistory.id}
              intervalSeconds={checkHistory.intervalSeconds}
              updatedAt={inventory.data?.fetchedAt}
            />
          </div>
        </EditorDialog>
      )}
      {enrolling && (
        <ProbeEnrollment
          connectionId={connection.id}
          onClose={() => setEnrolling(false)}
          onDone={inventory.refresh}
        />
      )}
      {check && (
        <CheckEditor
          connectionId={connection.id}
          initial={check === "new" ? undefined : check}
          onClose={() => setCheck(null)}
          onDone={() => {
            setCheck(null);
            inventory.refresh();
          }}
        />
      )}
      {removing && (
        <ConfirmAction
          title={removing.type === "host" ? t("撤销主机") : t("删除检查")}
          description={
            removing.type === "host"
              ? t("撤销 {0} 后，现有凭据立即失效，Agent 将无法继续上报。", removing.name)
              : t("删除 {0} 后，服务端将停止执行此检查。", removing.name)
          }
          action={() =>
            removing.type === "host"
              ? hostBridge()!.integrations.probeRevoke(connection.id, removing.remoteId)
              : hostBridge()!.integrations.probeDeleteCheck(connection.id, removing.remoteId)
          }
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            inventory.refresh();
          }}
        />
      )}
    </div>
  );
}

function BindDialog({
  connection,
  resource,
  onClose,
}: {
  connection: IntegrationConnection;
  resource: IntegrationResource;
  onClose: () => void;
}) {
  const domains = useAppStore((state) => state.domains);
  const services = useAppStore((state) => state.services);
  const servers = useAppStore((state) => state.servers);
  const assets = resource.type === "zone" ? domains : resource.type === "host" ? servers : services;
  const existing = assets.find(
    (asset) =>
      asset.integration?.connectionId === connection.id &&
      asset.integration.remoteId === resource.remoteId &&
      asset.integration.resourceType === resource.type,
  );
  const [assetId, setAssetId] = useState(existing?.id ?? "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <EditorDialog
      title={t("关联资源 · {0}", resource.name)}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="integration-form">
        <p className="text-meta text-muted">
          {t("导入为本机资产，或绑定已有资产。重复导入会复用原有资产，保留本机备注与关系。")}
        </p>
        <Select
          aria-label={t("目标资产")}
          value={assetId}
          onValueChange={setAssetId}
          options={[
            { value: "new", label: t("导入为新资产") },
            ...assets.map((asset) => ({ value: asset.id, label: asset.name })),
          ]}
        />
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await hostBridge()!.integrations.bind({
                  connectionId: connection.id,
                  resourceKey: resource.key,
                  assetId: assetId === "new" ? undefined : assetId,
                });
                onClose();
              } catch (reason) {
                setError(errorText(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("确认关联")}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}
