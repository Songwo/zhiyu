import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useState } from "react";
import { randomId } from "@/lib/random-id";
import { t } from "@/lib/i18n";
import { type UsageSource } from "@/lib/usage";
import { Plus, Copy, Trash2, RefreshCw, Pencil, Activity } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { useAppStore } from "@/lib/store";
import { type ProxyNode, type ProxyProtocol, type Server } from "@/lib/types";
import { formatProxyUri, parseProxyUri, validateProxyNode } from "@/lib/proxy-nodes";

const protocols: ProxyProtocol[] = ["vless", "vmess", "trojan", "ss", "hysteria2"];
export function ServerNodesPanel({ server }: { server: Server }) {
  const [show, setShow] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [sources, setSources] = useState<UsageSource[]>([]);
  const [sourceError, setSourceError] = useState("");
  useEffect(() => {
    let active = true;
    const api = hostBridge()?.usage;
    if (!api) return;
    const load = () =>
      void api
        .list()
        .then((data) => {
          if (active) {
            setSources(data.sources);
            setSourceError("");
          }
        })
        .catch(() => {
          if (active) setSourceError(t("流量连接状态读取失败"));
        });
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  function connectUsage(node: ProxyNode) {
    useAppStore
      .getState()
      .openUsageSetup({ type: "3x-ui", serverId: server.id, nodeId: node.id, name: node.name });
  }
  const saved = (server.nodes ?? []).find((node) => node.id === savedId);
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const empty = (): ProxyNode => ({
    id: "nod-" + randomId(),
    name: "",
    protocol: "vless",
    host: server.host ?? "",
    port: 443,
    security: "tls",
    network: "tcp",
  });
  const [form, setForm] = useState<ProxyNode>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  function save(node: ProxyNode) {
    validateProxyNode(node);
    const current = useAppStore.getState().servers.find((s) => s.id === server.id);
    if (!current) throw new Error("服务器已移除");
    useAppStore.getState().upsertServer({
      ...current,
      nodes: editing
        ? (current.nodes ?? []).map((n) => (n.id === editing ? node : n))
        : [...(current.nodes ?? []), node],
    });
    setShow(false);
    setEditing(null);
    setForm(empty());
    setUri("");
    setSavedId(node.id);
    toast.success("节点已保存");
  }
  function importNodes() {
    try {
      const lines = uri.trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) throw new Error("请粘贴节点分享链接");
      if (lines.length > 100) throw new Error("每次最多导入 100 个节点");
      const nodes = lines.map((line, index) => {
        const parsed = parseProxyUri(line);
        if (!parsed) throw new Error(`第 ${index + 1} 行无法识别`);
        const node = { ...parsed, id: "nod-" + randomId() } as ProxyNode;
        validateProxyNode(node);
        return node;
      });
      if (editing) {
        if (nodes.length !== 1) throw new Error("编辑时只能替换一条节点链接");
        save({ ...nodes[0], id: editing });
        return;
      }
      const current = useAppStore.getState().servers.find((s) => s.id === server.id);
      if (!current) throw new Error("服务器已移除");
      useAppStore
        .getState()
        .upsertServer({ ...current, nodes: [...(current.nodes ?? []), ...nodes] });
      setUri("");
      setShow(false);
      setSavedId(nodes[0].id);
      toast.success(`已导入 ${nodes.length} 个节点`);
    } catch (e) {
      toast.error(String(e));
    }
  }
  async function check(node: ProxyNode) {
    setBusy(node.id);
    try {
      const bridge = hostBridge();
      if (!bridge) throw new Error("真实 TCP 检测需要桌面端");
      const result = await bridge.nodes.check(node);
      const current = useAppStore.getState().servers.find((s) => s.id === server.id);
      if (current)
        useAppStore.getState().upsertServer({
          ...current,
          nodes: (current.nodes ?? []).map((n) =>
            n.id === node.id
              ? {
                  ...n,
                  latencyMs: result.latencyMs ?? undefined,
                  checkedAt: result.checkedAt,
                  checkError: result.error,
                }
              : n,
          ),
        });
      if (result.error) toast.error(result.error);
      else toast.success(`TCP 连通 ${result.latencyMs} ms（不代表代理出口速度）`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }
  const fields: [keyof ProxyNode, string][] = [
    ["name", "节点名称"],
    ["host", "主机 / IP"],
    ["sni", "SNI"],
    ["path", "WS / gRPC 路径"],
    ["pbk", "Reality 公钥"],
    ["sid", "Reality Short ID"],
    ["flow", "Flow"],
  ];
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{server.name} · 节点管理</h3>
          <p className="mt-1 text-xs text-muted">
            录入真实连接信息；TCP 检测不验证代理认证，也不测下载带宽。
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setForm(empty());
            setUri("");
            setShow(!show);
          }}
        >
          <Plus />
          添加节点
        </Button>
      </div>
      {saved && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card p-4 text-sm"
        >
          <div>
            <strong>{t("节点已保存")}</strong>
            <p className="mt-1 text-muted">{t("下一步连接流量统计，即可查看真实用量。")}</p>
          </div>
          <Button size="sm" onClick={() => connectUsage(saved)}>
            <Activity />
            {t("连接流量统计")}
          </Button>
        </div>
      )}
      {sourceError && (
        <p role="alert" className="text-sm text-muted">
          {sourceError}
        </p>
      )}
      {show && (
        <div className="usage-form">
          <h4 className="font-semibold">{editing ? "编辑节点" : "添加 / 导入节点"}</h4>
          <label>
            粘贴分享链接（一行一个）
            <textarea
              rows={3}
              className="rounded-md border border-line bg-canvas p-3 font-mono text-xs"
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="vless://… 或 vmess://…、trojan://…、ss://…、hysteria2://…"
            />
          </label>
          <Button variant="outline" onClick={importNodes}>
            导入链接
          </Button>
          <details open={!uri}>
            <summary className="cursor-pointer text-sm font-medium">手工填写连接信息</summary>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  save({
                    ...form,
                    rawUri: undefined,
                    latencyMs: undefined,
                    checkedAt: undefined,
                    checkError: undefined,
                  });
                } catch (err) {
                  toast.error(String(err));
                }
              }}
            >
              <label>
                协议
                <Select
                  aria-label={t("协议")}
                  value={form.protocol}
                  onValueChange={(value) => setForm({ ...form, protocol: value as ProxyProtocol })}
                  options={protocols.map((value) => ({ value, label: value }))}
                />
              </label>
              <label>
                端口
                <input
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </label>
              {fields.map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    required={key === "host" || key === "name"}
                    value={String(form[key] ?? "")}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                </label>
              ))}
              {["vless", "vmess"].includes(form.protocol) ? (
                <label>
                  UUID
                  <input
                    required
                    value={form.uuid ?? ""}
                    onChange={(e) => setForm({ ...form, uuid: e.target.value })}
                  />
                </label>
              ) : (
                <label>
                  {form.protocol === "ss" ? "加密方法:密码（例如 aes-256-gcm:…）" : "节点密码"}
                  <input
                    type="password"
                    required
                    value={form.password ?? ""}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </label>
              )}
              <label>
                传输
                <Select
                  aria-label={t("传输")}
                  value={form.network ?? "tcp"}
                  onValueChange={(value) =>
                    setForm({ ...form, network: value as ProxyNode["network"] })
                  }
                  options={["tcp", "ws", "grpc"].map((value) => ({ value, label: value }))}
                />
              </label>
              <label>
                安全
                <Select
                  aria-label={t("安全")}
                  value={form.security ?? "none"}
                  onValueChange={(value) =>
                    setForm({ ...form, security: value as ProxyNode["security"] })
                  }
                  options={["tls", "reality", "none"].map((value) => ({ value, label: value }))}
                />
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit">保存节点</Button>
                <Button type="button" variant="outline" onClick={() => setShow(false)}>
                  取消
                </Button>
              </div>
            </form>
          </details>
        </div>
      )}
      <div className="space-y-3">
        {(server.nodes ?? []).map((node) => {
          const linked = sources.filter((source) => source.nodeId === server.id + ":" + node.id);
          const status = sourceError
            ? t("流量连接状态读取失败")
            : linked.some((source) => source.error)
              ? t("流量连接需要处理")
              : linked.some((source) => source.checkedAt)
                ? t("流量统计已连接")
                : linked.length
                  ? t("流量来源已保存，等待连接")
                  : t("尚未连接流量统计");
          return (
            <div key={node.id} className="rounded-lg border border-line bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words text-sm font-semibold">{node.name}</h4>
                  <p className="mt-1 break-all font-mono text-xs text-muted">
                    {node.protocol.toUpperCase()} · {node.host}:{node.port}
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {node.checkedAt ? node.checkError || `TCP ${node.latencyMs} ms` : "尚未检测"}
                    {node.checkedAt && ` · ${new Date(node.checkedAt).toLocaleString()}`}
                  </p>
                  <p className="mt-2 text-xs text-muted" data-node-usage-status>
                    {status}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      linked.length ? useAppStore.getState().setView("usage") : connectUsage(node)
                    }
                  >
                    <Activity />
                    {linked.length ? t("查看流量记录") : t("连接流量统计")}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={"复制 " + node.name}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(formatProxyUri(node))
                        .then(() => toast.success("已复制分享链接"))
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    <Copy />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={"检测 " + node.name}
                    disabled={busy !== null}
                    onClick={() => void check(node)}
                  >
                    <RefreshCw className={busy === node.id ? "animate-spin" : ""} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={"编辑 " + node.name}
                    onClick={() => {
                      setEditing(node.id);
                      setForm(node);
                      setUri(node.rawUri ?? "");
                      setShow(true);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={"删除 " + node.name}
                    onClick={() => {
                      if (window.confirm("删除这个节点？")) {
                        const current = useAppStore
                          .getState()
                          .servers.find((s) => s.id === server.id);
                        if (current)
                          useAppStore.getState().upsertServer({
                            ...current,
                            nodes: (current.nodes ?? []).filter((n) => n.id !== node.id),
                          });
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {!server.nodes?.length && (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
            还没有节点。点击「添加节点」，导入分享链接或手工填写。
          </p>
        )}
      </div>
    </div>
  );
}
