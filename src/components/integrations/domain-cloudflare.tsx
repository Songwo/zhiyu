import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Cloud,
  ExternalLink,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { refreshDomain } from "@/lib/probes";
import { useAppStore } from "@/lib/store";
import { daysUntil, formatDate } from "@/lib/utils";
import type {
  IntegrationConnection,
  IntegrationResource,
  IntegrationsBridge,
} from "@/lib/integrations";
import { Button } from "../ui/button";
import { EditorDialog } from "../ui/editor-dialog";
import { Field, Input } from "../ui/input";
import { DnsManager } from "./dns-manager";
import { FetchStatus } from "./common";
import { ConfirmAction } from "./probe-panels";
import { errorText, useInventory } from "./data";
import "./integrations.css";

const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const ZONE_STATUS: Record<string, string> = {
  active: "已激活",
  pending: "待验证 NS",
  initializing: "初始化中",
  moved: "已迁移",
  deactivated: "已停用",
  unknown: "未知",
};

/** 进入域名页时自动同步一次，之后至少隔 10 分钟，避免每次切页都请求 Cloudflare。 */
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000;
const lastAutoSync = new Map<string, number>();

/** 新 Token 能读到的域名如果已经在另一个连接里，说明是重复连接。 */
async function overlappingConnection(
  bridge: IntegrationsBridge,
  saved: IntegrationConnection,
  others: IntegrationConnection[],
) {
  const zoneIds = (id: string) =>
    bridge
      .inventory(id)
      .then((inventory) =>
        inventory.resources.filter((row) => row.type === "zone").map((row) => row.remoteId),
      );
  const mine = new Set(await zoneIds(saved.id));
  for (const other of others) {
    try {
      if ((await zoneIds(other.id)).some((id) => mine.has(id))) return other;
    } catch {
      /* 另一个连接暂时读不到时，不影响这次连接 */
    }
  }
  return null;
}

/** 域名页顶部：连接 Cloudflare 后读取账户下的全部域名，导入后可看到期时间并改 DNS。 */
export function DomainsCloudflareEntry() {
  const bridge = desktop()?.integrations;
  const [connections, setConnections] = useState<IntegrationConnection[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [viewing, setViewing] = useState<IntegrationConnection | null>(null);
  const [syncing, setSyncing] = useState("");
  const [editing, setEditing] = useState<IntegrationConnection | null>(null);
  const [removing, setRemoving] = useState<IntegrationConnection | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .list()
      .then((rows) => {
        if (!cancelled) setConnections(rows.filter((row) => row.provider === "cloudflare"));
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, revision]);
  useEffect(() => {
    if (!bridge || !connections) return;
    for (const connection of connections) {
      if (Date.now() - (lastAutoSync.get(connection.id) ?? 0) < AUTO_SYNC_INTERVAL) continue;
      lastAutoSync.set(connection.id, Date.now());
      void bridge.syncZones(connection.id).catch(() => undefined);
    }
  }, [bridge, connections]);
  if (!bridge || !connections) return null;
  const sync = async (connection: IntegrationConnection) => {
    setSyncing(connection.id);
    try {
      const { updated } = await bridge.syncZones(connection.id);
      lastAutoSync.set(connection.id, Date.now());
      toast(updated ? t("已同步 {0} 个域名", updated) : t("域名信息已是最新"));
    } catch (reason) {
      toast.error(errorText(reason));
    } finally {
      setSyncing("");
    }
  };
  return (
    <>
      {connections.length === 0 ? (
        <div className="integration-entry">
          <Cloud className="size-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-meta">{t("连接 Cloudflare")}</h2>
            <p className="mt-1 text-2xs text-muted">
              {t(
                "填入 API Token，自动读取账户下的全部域名与到期时间，并可在这里直接修改 DNS 记录。",
              )}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setConnecting(true)}>
            <Cloud />
            {t("连接 Cloudflare")}
          </Button>
        </div>
      ) : (
        connections.map((connection, index) => (
          <div key={connection.id} className="integration-entry">
            <Cloud className="size-5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <h2 className="font-medium text-meta break-all">{connection.name}</h2>
              <p className="mt-1 text-2xs text-muted">
                {t("已连接 Cloudflare。查看账户下的域名、到期时间，并管理 DNS。")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setViewing(connection)}>
                {t("预览与导入域名")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={syncing === connection.id}
                onClick={() => void sync(connection)}
              >
                <RefreshCw className={syncing === connection.id ? "animate-spin" : ""} />
                {t("同步")}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("编辑连接")}
                aria-label={t("编辑连接 {0}", connection.name)}
                onClick={() => setEditing(connection)}
              >
                <Pencil />
              </Button>
              <Button
                variant="danger-ghost"
                size="icon-sm"
                title={t("移除连接")}
                aria-label={t("移除连接 {0}", connection.name)}
                onClick={() => setRemoving(connection)}
              >
                <Trash2 />
              </Button>
              {index === connections.length - 1 && (
                <Button variant="ghost" size="sm" onClick={() => setConnecting(true)}>
                  <Plus />
                  {t("添加账号")}
                </Button>
              )}
            </div>
          </div>
        ))
      )}
      {connecting && (
        <CloudflareConnectDialog
          existing={connections}
          onClose={() => setConnecting(false)}
          onConnected={(connection) => {
            setConnecting(false);
            setRevision((n) => n + 1);
            setViewing(connection);
          }}
        />
      )}
      {editing && (
        <CloudflareEditDialog
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {removing && (
        <ConfirmAction
          title={t("移除连接")}
          description={t(
            "将移除本机保存的连接凭据。已导入的域名资产保留，但不再从 Cloudflare 同步；远端资源不会删除。",
          )}
          action={() => bridge.remove(removing.id)}
          onClose={() => setRemoving(null)}
          onDone={() => {
            lastAutoSync.delete(removing.id);
            setRemoving(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {viewing && (
        <CloudflareZonesDialog
          connection={viewing}
          onClose={() => {
            setViewing(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

function CloudflareConnectDialog({
  existing,
  onClose,
  onConnected,
}: {
  existing: IntegrationConnection[];
  onClose: () => void;
  onConnected: (connection: IntegrationConnection) => void;
}) {
  const [name, setName] = useState(
    existing.length ? `Cloudflare ${existing.length + 1}` : "Cloudflare",
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = desktop()!.integrations;
    setBusy(true);
    setError("");
    try {
      const saved = await bridge.save({
        provider: "cloudflare",
        name: name.trim() || "Cloudflare",
        token: token.trim(),
      });
      try {
        await bridge.inventory(saved.id, true);
      } catch (reason) {
        // Token 无效或没有任何读取权限时不保留这个连接。
        await bridge.remove(saved.id).catch(() => undefined);
        throw reason;
      }
      const duplicate = await overlappingConnection(bridge, saved, existing);
      if (duplicate) {
        await bridge.remove(saved.id).catch(() => undefined);
        throw new Error(
          t(
            "这个 Token 能读到的域名已在连接「{0}」中。要更换 Token，请在那个连接上点编辑。",
            duplicate.name,
          ),
        );
      }
      setToken("");
      onConnected(saved);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditorDialog
      title={t("连接 Cloudflare")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="integration-form" onSubmit={submit}>
        <div className="integration-guide">
          <p className="text-meta font-medium">{t("先在 Cloudflare 创建一个 API Token")}</p>
          <ol>
            <li>{t("区域 · 区域 · 读取：必需，用来列出账户下的全部域名。")}</li>
            <li>{t("区域 · DNS · 编辑：需要在知屿里修改 DNS 时授予；只看可只给读取。")}</li>
            <li>
              {t(
                "账户 · 域名注册（Registrar）· 读取：可选，用来读取在 Cloudflare 注册的域名到期日。",
              )}
            </li>
          </ol>
          <p className="text-2xs text-muted">
            {t("资源范围请限定到你的账户和域名。不要使用 Global API Key。")}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void desktop()?.openExternal(TOKEN_PAGE)}
          >
            <ExternalLink />
            {t("打开 Cloudflare 创建 Token")}
          </Button>
        </div>
        <Field label={t("连接名称")}>
          <Input
            aria-label={t("连接名称")}
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Cloudflare API Token">
          <Input
            aria-label="Cloudflare API Token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            required
            autoFocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <p className="text-2xs leading-relaxed text-muted">
          {t("凭据由操作系统加密保存在本机；不会写入资产或浏览器存储。")}
        </p>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("正在验证…") : t("连接并读取域名")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

function CloudflareEditDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: IntegrationConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = desktop()!.integrations;
    const entered = token.trim();
    setBusy(true);
    setError("");
    try {
      if (entered) {
        // 先用临时连接验证新 Token，通过后才替换，避免换成无效 Token 后丢掉原来可用的。
        const probe = await bridge.save({
          provider: "cloudflare",
          name: name.trim(),
          token: entered,
        });
        try {
          await bridge.inventory(probe.id, true);
        } finally {
          await bridge.remove(probe.id).catch(() => undefined);
        }
      }
      await bridge.save({
        id: connection.id,
        provider: "cloudflare",
        name: name.trim(),
        ...(entered ? { token: entered } : {}),
      });
      setToken("");
      onSaved();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditorDialog
      title={t("编辑连接")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="integration-form" onSubmit={submit}>
        <Field label={t("连接名称")}>
          <Input
            aria-label={t("连接名称")}
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Cloudflare API Token">
          <Input
            aria-label="Cloudflare API Token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={token}
            placeholder={t("留空保留当前 Token")}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <p className="text-2xs leading-relaxed text-muted">
          {t("换新 Token 时会先验证能否读取域名，通过后才替换；已导入的域名不受影响。")}
        </p>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("正在验证…") : t("保存连接")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

function CloudflareZonesDialog({
  connection,
  onClose,
}: {
  connection: IntegrationConnection;
  onClose: () => void;
}) {
  const inventory = useInventory(connection.id, "cloudflare");
  const domains = useAppStore((state) => state.domains);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dns, setDns] = useState<IntegrationResource | null>(null);
  const zones = useMemo(
    () => (inventory.data?.resources ?? []).filter((row) => row.type === "zone"),
    [inventory.data],
  );
  const importedKeys = useMemo(
    () =>
      new Set(
        zones
          .filter((zone) =>
            domains.some(
              (domain) =>
                domain.integration?.connectionId === connection.id &&
                domain.integration.resourceType === "zone" &&
                domain.integration.remoteId === zone.remoteId &&
                (domain.integration.accountId ?? "") === (zone.accountId ?? ""),
            ),
          )
          .map((zone) => zone.key),
      ),
    [zones, domains, connection.id],
  );
  // 第一次读到列表时默认勾选尚未导入的域名。
  useEffect(() => {
    if (selected === null && inventory.data)
      setSelected(new Set(zones.filter((zone) => !importedKeys.has(zone.key)).map((z) => z.key)));
  }, [selected, inventory.data, zones, importedKeys]);
  const picked = selected ?? new Set<string>();
  const visible = zones.filter((zone) => zone.name.includes(query.trim().toLowerCase()));
  const withExpiry = zones.filter((zone) => zone.zone?.expiresAt).length;
  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const importSelected = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await desktop()!.integrations.importZones({
        connectionId: connection.id,
        resourceKeys: [...picked],
      });
      // 非 Cloudflare 注册的域名没有到期日，顺手用 WHOIS 补全。
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const asset of result.assets) {
        const domain = useAppStore.getState().domains.find((item) => item.id === asset.id);
        if (domain && !domain.expiresAt) void refreshDomain(domain);
      }
      toast(t("已导入 {0} 个、更新 {1} 个域名", result.created, result.updated));
      setSelected(new Set());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditorDialog
      title={t("Cloudflare 域名 · {0}", connection.name)}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="integration-form">
        <div className="integration-toolbar">
          <p className="text-meta text-muted">
            {inventory.data
              ? t(
                  "共 {0} 个域名，已导入 {1} 个，{2} 个带有到期日",
                  zones.length,
                  importedKeys.size,
                  withExpiry,
                )
              : t("正在加载…")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !zones.length}
              onClick={() =>
                setSelected(
                  picked.size === zones.length ? new Set() : new Set(zones.map((zone) => zone.key)),
                )
              }
            >
              {picked.size === zones.length && zones.length ? t("取消全选") : t("全选")}
            </Button>
            <Button
              size="sm"
              disabled={busy || picked.size === 0}
              onClick={() => void importSelected()}
            >
              {t("导入所选 ({0})", picked.size)}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Search className="size-4 shrink-0 text-muted" />
          <Input
            aria-label={t("搜索域名")}
            placeholder={t("搜索域名")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        {inventory.data?.warnings.map((warning, index) => (
          <p key={index} role="status" className="tool-error">
            {warning}
          </p>
        ))}
        <div className="integration-zone-list" aria-busy={inventory.busy}>
          {visible.map((zone) => {
            const days = zone.zone?.expiresAt ? daysUntil(zone.zone.expiresAt) : undefined;
            return (
              <div key={zone.key} className="integration-zone-row">
                <input
                  type="checkbox"
                  aria-label={t("选择 {0}", zone.name)}
                  checked={picked.has(zone.key)}
                  disabled={busy}
                  onChange={() => toggle(zone.key)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-meta break-all">{zone.name}</strong>
                    <span className="integration-status" data-status={zone.status}>
                      {t(ZONE_STATUS[zone.status] ?? "未知")}
                    </span>
                    {importedKeys.has(zone.key) && (
                      <span className="chip chip-mute">{t("已导入")}</span>
                    )}
                  </div>
                  <p className="mt-1 text-2xs text-muted">
                    {zone.zone?.expiresAt
                      ? `${t("到期 {0}", formatDate(zone.zone.expiresAt))}${
                          days === undefined
                            ? ""
                            : ` · ${days <= 0 ? t("已过期") : t("{0} 天后", days)}`
                        }${zone.zone.autoRenew === undefined ? "" : ` · ${zone.zone.autoRenew ? t("自动续费") : t("手动续费")}`}`
                      : t("非 Cloudflare 注册，导入后通过 WHOIS 补全到期日")}
                    {zone.zone?.nameServers.length ? ` · NS ${zone.zone.nameServers[0]}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  title={t("管理 DNS")}
                  onClick={() => setDns(zone)}
                >
                  <Network />
                  {t("DNS")}
                </Button>
              </div>
            );
          })}
        </div>
        {!visible.length && (
          <p className="integration-empty">
            {inventory.busy && !inventory.data
              ? t("正在加载…")
              : zones.length
                ? t("没有匹配的域名")
                : t("这个 Token 下没有可读取的域名。请确认已授予“区域 · 区域 · 读取”。")}
          </p>
        )}
        <FetchStatus {...inventory} />
        {dns && (
          <DnsManager
            connectionId={connection.id}
            zoneId={dns.remoteId}
            name={dns.name}
            onClose={() => setDns(null)}
          />
        )}
      </div>
    </EditorDialog>
  );
}
