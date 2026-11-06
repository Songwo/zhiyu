import { useEffect, useMemo, useState } from "react";
import { Plus, FileText, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useDocuments } from "@/lib/documents";
import { refKey, type AssetRef } from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { t } from "@/lib/i18n";
import { updateResourceRelation } from "@/lib/resource-relation-actions";
const fail = (e: unknown) => toast.error(String(e));
export function AssetDocuments({ asset }: { asset: AssetRef }) {
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const list = useDocuments((s) => s.list);
  const load = useDocuments((s) => s.load);
  const links = useAppStore((s) => s.links);
  const account = useAppStore((s) =>
    asset.kind === "secret"
      ? s.secrets.find((item) => item.id === asset.id && item.kind === "account")
      : undefined,
  );
  useEffect(() => {
    void load().catch(fail);
  }, [load]);
  const bound = useMemo(
    () =>
      list.filter(
        (doc) =>
          doc.bindings.some((ref) => refKey(ref) === refKey(asset)) ||
          links.some(
            (link) =>
              (link.from.kind === "document" &&
                link.from.id === doc.id &&
                refKey(link.to) === refKey(asset)) ||
              (link.to.kind === "document" &&
                link.to.id === doc.id &&
                refKey(link.from) === refKey(asset)),
          ),
      ),
    [list, asset, links],
  );
  const available = list.filter(
    (doc) =>
      !bound.some((item) => item.id === doc.id) &&
      doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  async function enter(id?: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (id) await useDocuments.getState().open(id);
      else
        await useDocuments.getState().create(
          [{ kind: asset.kind, id: asset.id }],
          account
            ? {
                title: t("{0} · 账号资料", account.name),
                content: { type: "doc", content: [{ type: "paragraph" }] },
              }
            : undefined,
        );
      useAppStore.getState().setExpanded(null);
      useAppStore.getState().setView("docs");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function bind(id: string, linked: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await updateResourceRelation({ kind: "document", id }, asset, !linked);
      setChoosing(false);
      setQuery("");
      toast.success(t(linked ? "已关联文档" : "已解除关联，文档仍保留"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="border-t border-line p-4" aria-label={t(account ? "账号资料" : "关联文档")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t(account ? "账号资料" : "关联文档")} · {bound.length}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setChoosing((value) => !value)}
            aria-expanded={choosing}
          >
            <Link2 />
            {t("关联已有文档")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void enter()}>
            <Plus />
            {t("新建文档")}
          </Button>
        </div>
      </div>
      {account && (
        <p className="mb-3 text-xs leading-relaxed text-muted">
          {t("将注册说明、订阅凭证和使用笔记集中到账号资料。密码与恢复码请保存在上方敏感备注中。")}
        </p>
      )}
      {choosing && (
        <div className="mb-3 rounded-lg border border-line bg-canvas p-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("搜索已有文档")}
            placeholder={t("搜索已有文档")}
          />
          <div className="mt-2 max-h-48 overflow-y-auto">
            {available.map((doc) => (
              <button
                key={doc.id}
                type="button"
                disabled={busy}
                className="flex min-h-11 w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-line"
                onClick={() => void bind(doc.id, true)}
                aria-label={t("关联文档 {0}", doc.title)}
              >
                <FileText className="size-4 shrink-0" />
                <span className="truncate">{doc.title}</span>
                <Plus className="ml-auto size-4 shrink-0" />
              </button>
            ))}
            {!available.length && (
              <p className="py-3 text-xs text-muted">{t("没有可关联的文档")}</p>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setChoosing(false)}>
            {t("取消")}
          </Button>
        </div>
      )}
      {bound.map((doc) => (
        <div className="flex items-start gap-1" key={doc.id}>
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-md p-2 text-left text-sm hover:bg-line"
            disabled={busy}
            onClick={() => void enter(doc.id)}
          >
            <FileText className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{doc.title}</span>
              {doc.excerpt && (
                <span className="mt-1 line-clamp-2 block break-words text-xs text-muted">
                  {doc.excerpt}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs text-muted">{t("打开")}</span>
          </button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={() => void bind(doc.id, false)}
            aria-label={t("解除关联 {0}", doc.title)}
            title={t("取消关联不会删除文档")}
          >
            <Unlink className="size-4" />
          </Button>
        </div>
      ))}
      {!bound.length && (
        <p className="text-xs text-muted">{t("还没有关联文档，可新建图文笔记。")}</p>
      )}
    </section>
  );
}
