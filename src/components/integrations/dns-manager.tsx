import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useState, type FormEvent } from "react";
import { Plus, Pencil, Trash2, ArrowRight } from "lucide-react";
import { t } from "@/lib/i18n";
import type { DnsInput, DnsProposal, DnsRecord } from "@/lib/integrations";
import { Button } from "../ui/button";
import { EditorDialog } from "../ui/editor-dialog";
import { Field, Input, Select, Textarea } from "../ui/input";
import { dateText, errorText } from "./data";

const TYPES: DnsInput["type"][] = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"];
export function DnsManager({
  connectionId,
  zoneId,
  name,
  onClose,
}: {
  connectionId: string;
  zoneId: string;
  name: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DnsRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<DnsRecord | "new" | null>(null);
  const [proposal, setProposal] = useState<DnsProposal | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void hostBridge()!
      .integrations.dnsList(connectionId, zoneId, revision > 0)
      .then((result) => {
        if (!cancelled) {
          setRows(result);
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
  }, [connectionId, zoneId, revision]);
  const preview = async (action: DnsProposal["action"], record?: DnsInput, recordId?: string) => {
    setBusy(true);
    setError("");
    try {
      setProposal(
        await hostBridge()!.integrations.dnsPreview({
          connectionId,
          zoneId,
          action,
          record,
          recordId,
        }),
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      await hostBridge()!.integrations.dnsApply(proposal.ticket);
      setProposal(null);
      setEdit(null);
      setRevision((n) => n + 1);
    } catch (reason) {
      setError(errorText(reason));
      setProposal(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditorDialog
      title={t("DNS 管理 · {0}", name)}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="integration-form">
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        {proposal ? (
          <>
            <h3 className="font-semibold">{t("确认 DNS 变更")}</h3>
            <p className="text-meta text-muted">
              {t("核对后将立即修改 Cloudflare DNS。预览有效至 {0}。", dateText(proposal.expiresAt))}
            </p>
            <div className="integration-proposal">
              <div>
                <p className="text-meta text-muted">{t("修改前")}</p>
                <pre>{proposal.before ? JSON.stringify(proposal.before, null, 2) : "—"}</pre>
              </div>
              <div>
                <p className="text-meta text-muted">{t("修改后")}</p>
                <pre>
                  {proposal.after ? JSON.stringify(proposal.after, null, 2) : t("删除此记录")}
                </pre>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setProposal(null)}>
                {t("返回")}
              </Button>
              <Button
                variant={proposal.action === "delete" ? "danger" : "solid"}
                disabled={busy}
                onClick={() => void apply()}
              >
                {t("确认应用变更")}
              </Button>
            </div>
          </>
        ) : edit ? (
          <DnsForm
            key={edit === "new" ? "new" : edit.id}
            initial={edit === "new" ? undefined : edit}
            zoneName={name}
            busy={busy}
            onCancel={() => setEdit(null)}
            onPreview={(record) =>
              void preview(
                edit === "new" ? "create" : "update",
                record,
                edit === "new" ? undefined : edit.id,
              )
            }
          />
        ) : (
          <>
            <div className="integration-toolbar">
              <p className="text-meta text-muted">{t("共 {0} 条记录", rows.length)}</p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRevision((n) => n + 1)}
                >
                  {t("刷新")}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => setEdit("new")}>
                  <Plus />
                  {t("新增记录")}
                </Button>
              </div>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t("搜索 DNS 记录")}
              placeholder={t("搜索 DNS 记录")}
            />
            <div className="integration-dns-list" aria-busy={busy}>
              {rows
                .filter((row) =>
                  `${row.name} ${row.type} ${row.content}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((row) => (
                  <div key={row.id} className="integration-dns-row">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-2xs text-muted">{row.type}</span>
                      <strong className="min-w-0 flex-1 break-all text-meta">{row.name}</strong>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || !TYPES.includes(row.type as DnsInput["type"])}
                        title={
                          !TYPES.includes(row.type as DnsInput["type"])
                            ? t("此记录类型可查看和删除，请在 Cloudflare 编辑")
                            : undefined
                        }
                        aria-label={t("编辑记录 {0}", row.name)}
                        onClick={() => setEdit(row)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={t("删除记录 {0}", row.name)}
                        onClick={() => void preview("delete", undefined, row.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <p className="font-mono text-2xs break-all text-muted">{row.content}</p>
                    <p className="mt-2 text-2xs text-subtle">
                      TTL {row.ttl === 1 ? t("自动") : `${row.ttl}s`}
                      {row.proxied ? ` · ${t("已开启代理")}` : ""}
                    </p>
                  </div>
                ))}
            </div>
            {!rows.length && (
              <p className="integration-empty">{busy ? t("正在加载…") : t("暂无 DNS 记录")}</p>
            )}
          </>
        )}
      </div>
    </EditorDialog>
  );
}

function DnsForm({
  initial,
  zoneName,
  busy,
  onCancel,
  onPreview,
}: {
  initial?: DnsRecord;
  zoneName: string;
  busy: boolean;
  onCancel: () => void;
  onPreview: (record: DnsInput) => void;
}) {
  const [record, setRecord] = useState<DnsInput>(
    initial
      ? { ...initial, type: initial.type as DnsInput["type"] }
      : { type: "A", name: zoneName, content: "", ttl: 1, proxied: false },
  );
  const [error, setError] = useState("");
  const proxyable = ["A", "AAAA", "CNAME"].includes(record.type);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      onPreview({
        type: record.type,
        name: record.name.trim(),
        content: record.content,
        ttl: record.ttl,
        ...(proxyable ? { proxied: !!record.proxied } : {}),
        ...(record.type === "MX" ? { priority: record.priority ?? 10 } : {}),
        comment: record.comment ?? "",
      });
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="integration-form-grid">
        <Field label={t("记录类型")}>
          <Select
            aria-label={t("记录类型")}
            value={record.type}
            options={TYPES.map((type) => ({ value: type, label: type }))}
            onValueChange={(value) => setRecord({ ...record, type: value as DnsInput["type"] })}
          />
        </Field>
        <Field label={t("记录名称")}>
          <Input
            aria-label={t("记录名称")}
            required
            value={record.name}
            onChange={(event) => setRecord({ ...record, name: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t("记录内容")}>
        <Textarea
          aria-label={t("记录内容")}
          required
          value={record.content}
          onChange={(event) => setRecord({ ...record, content: event.target.value })}
        />
      </Field>

      <div className="integration-form-grid">
        <Field label={t("TTL（1 表示自动）")}>
          <Input
            aria-label={t("TTL（1 表示自动）")}
            type="number"
            min={1}
            max={86400}
            required
            value={record.ttl}
            onChange={(event) => setRecord({ ...record, ttl: Number(event.target.value) })}
          />
        </Field>
        {record.type === "MX" && (
          <Field label={t("优先级")}>
            <Input
              aria-label={t("优先级")}
              type="number"
              min={0}
              max={65535}
              value={record.priority ?? 10}
              onChange={(event) => setRecord({ ...record, priority: Number(event.target.value) })}
            />
          </Field>
        )}
      </div>
      {proxyable && (
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={!!record.proxied}
            onChange={(event) => setRecord({ ...record, proxied: event.target.checked })}
          />
          {t("启用 Cloudflare 代理")}
        </label>
      )}
      <Field label={t("备注")}>
        <Input
          aria-label={t("备注")}
          value={record.comment ?? ""}
          onChange={(event) => setRecord({ ...record, comment: event.target.value })}
        />
      </Field>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button type="submit" disabled={busy}>
          <ArrowRight />
          {t("预览变更")}
        </Button>
      </div>
    </form>
  );
}
