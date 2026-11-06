import { useMemo, useState } from "react";
import { Check, Link2, Unlink, WandSparkles } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  resourceKey,
  suggestRelations,
  canRelateResources,
  type Relation,
  type ResourceRow,
} from "@/lib/resource-relations.mjs";
import { updateResourceRelation } from "@/lib/resource-relation-actions";
import { resourceKindLabel } from "@/lib/resource-inventory";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

export function ResourceRelationsPanel({
  resources,
  relations,
}: {
  resources: ResourceRow[];
  relations: Relation[];
}) {
  const [tab, setTab] = useState<"saved" | "suggestions" | "add">("saved");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const suggestions = useMemo(() => suggestRelations(resources, relations), [resources, relations]);
  const options = resources.map((row) => ({
    value: resourceKey(row),
    label: `${row.name} · ${t(resourceKindLabel(row))}`,
  }));
  const names = new Map(resources.map((row) => [resourceKey(row), row.name]));
  const choices = suggestions.filter((item) => selected.has(item.id));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(t("关联已保存"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="resource-relations-panel" aria-label={t("管理资源关联")} aria-busy={busy}>
      <div className="resource-panel-tabs" role="group" aria-label={t("关联操作")}>
        <Button
          variant={tab === "saved" ? "solid" : "ghost"}
          size="sm"
          onClick={() => setTab("saved")}
        >
          <Link2 />
          {t("已确认关联")} {relations.length}
        </Button>
        <Button
          variant={tab === "suggestions" ? "solid" : "ghost"}
          size="sm"
          onClick={() => setTab("suggestions")}
        >
          <WandSparkles />
          {t("发现关联")} {suggestions.length}
        </Button>
        <Button variant={tab === "add" ? "solid" : "ghost"} size="sm" onClick={() => setTab("add")}>
          {t("新增关联")}
        </Button>
      </div>
      {tab === "add" ? (
        <div className="resource-add-form">
          <p className="text-sm text-muted">
            {t("选择两项资源，把账号、服务器和文档自由组成一组。")}
          </p>
          <div className="resource-add-fields">
            <Select
              aria-label={t("起始资源")}
              value={from}
              onValueChange={(value) => {
                setFrom(value);
                setTo("");
                setError("");
              }}
              placeholder={t("选择资源")}
              options={options}
            />
            <Link2 className="size-4 text-muted" />
            <Select
              aria-label={t("目标资源")}
              value={to}
              onValueChange={setTo}
              placeholder={t("选择资源")}
              options={options.filter((option) => {
                const source = resources.find((r) => resourceKey(r) === from),
                  target = resources.find((r) => resourceKey(r) === option.value);
                return !source || (target && canRelateResources(source, target));
              })}
            />
            <Button
              disabled={
                busy ||
                !resources.some(
                  (source) =>
                    resourceKey(source) === from &&
                    resources.some(
                      (target) => resourceKey(target) === to && canRelateResources(source, target),
                    ),
                )
              }
              onClick={() =>
                void run(async () => {
                  const source = resources.find((row) => resourceKey(row) === from),
                    target = resources.find((row) => resourceKey(row) === to);
                  if (!source || !target) throw Error(t("关联资源已不存在，请刷新后重试。"));
                  await updateResourceRelation(source, target);
                  setFrom("");
                  setTo("");
                })
              }
            >
              {busy ? t("正在保存…") : t("保存关联")}
            </Button>
          </div>
        </div>
      ) : tab === "suggestions" ? (
        <>
          <p className="text-sm text-muted">
            {t("依据公开元数据在本机匹配，不读取密码或文档正文。建议确认后才会出现在关系图中。")}
          </p>
          <div className="resource-relation-list">
            {suggestions.map((item) => (
              <label className="resource-relation-row" key={item.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.has(item.id)}
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>
                    {names.get(resourceKey(item.from))} ↔ {names.get(resourceKey(item.to))}
                  </strong>
                  <small>
                    {t(
                      item.basis === "host"
                        ? "主机地址一致：{0}"
                        : item.basis === "tag"
                          ? "共有标签：{0}"
                          : "标题提及：{0}",
                      item.evidence,
                    )}{" "}
                    · {t("待确认")}
                  </small>
                </span>
              </label>
            ))}
            {!suggestions.length && (
              <p className="text-sm text-muted">
                {t("没有新的关联建议，可手动连接，或请 AI 助手根据所选资料提出建议。")}
              </p>
            )}
          </div>
          {!!suggestions.length && (
            <Button
              disabled={busy || !choices.length}
              onClick={() =>
                void run(async () => {
                  for (const item of choices) await updateResourceRelation(item.from, item.to);
                  setSelected(new Set());
                })
              }
            >
              <Check />
              {t("确认选中的 {0} 条关联", choices.length)}
            </Button>
          )}
        </>
      ) : (
        <div className="resource-relation-list">
          {relations.map((item) => (
            <div className="resource-relation-row" key={item.id}>
              <Link2 className="size-4 shrink-0 text-muted" />
              <span>
                <strong>
                  {names.get(resourceKey(item.from))} ↔ {names.get(resourceKey(item.to))}
                </strong>
                <small>
                  {t(
                    item.type === "document"
                      ? "文档绑定"
                      : item.type === "phone"
                        ? "号码与订阅绑定"
                        : "已保存关联",
                  )}
                </small>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(
                  "解除 {0} 与 {1} 的关联",
                  names.get(resourceKey(item.from)) ?? "",
                  names.get(resourceKey(item.to)) ?? "",
                )}
                disabled={busy}
                onClick={() => void run(() => updateResourceRelation(item.from, item.to, true))}
              >
                <Unlink />
              </Button>
            </div>
          ))}
          {!relations.length && (
            <p className="text-sm text-muted">
              {t("尚无已确认关联。先添加关联，或查看自动发现的建议。")}
            </p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-ok">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-crit">
          {t(error)}
        </p>
      )}
    </section>
  );
}
