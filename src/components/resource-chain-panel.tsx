import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import {
  relationPaths,
  resourceKey,
  type Relation,
  type ResourceRow,
  type ResourceRef,
} from "@/lib/resource-relations.mjs";
import { t } from "@/lib/i18n";
import { resourceKindLabel } from "@/lib/resource-inventory";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

const resourceKindName = resourceKindLabel;
export function ResourceChainPanel({
  resources,
  relations,
  focus,
  onFocus,
  all: allResources,
}: {
  resources: ResourceRow[];
  relations: Relation[];
  focus: ResourceRef | null;
  onFocus: (ref: ResourceRef | null) => void;
  all: boolean;
}) {
  const [all, setAll] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    setDetails(false);
    setAll(false);
  }, [focus?.kind, focus?.id]);
  const root = focus && resources.find((r) => resourceKey(r) === resourceKey(focus));
  const paths = root
    ? relationPaths(resources, relations, root).filter((entry) => entry.distance > 0)
    : [];
  const names = new Map(resources.map((r) => [resourceKey(r), r.name]));
  return (
    <section aria-label={t("关联链路")} className="resource-chain-compact">
      <div className="resource-chain-controls">
        <span className="resource-chain-label">{t("聚焦关联资源")}</span>
        <Select
          className="resource-chain-select"
          aria-label={t("聚焦关联资源")}
          value={root ? resourceKey(root) : ""}
          onValueChange={(key) => {
            setAll(false);
            onFocus(resources.find((r) => resourceKey(r) === key) ?? null);
          }}
          placeholder={t("选择邮箱、账号或其他资源")}
          options={[
            { value: "", label: t("选择邮箱、账号或其他资源") },
            ...resources.map((r) => ({
              value: resourceKey(r),
              label: r.name,
              description: t(resourceKindName(r)),
            })),
          ]}
        />
        {root && (
          <Button variant="ghost" size="sm" onClick={() => onFocus(null)}>
            {t(allResources ? "查看全部资源" : "返回当前范围")}
          </Button>
        )}
        {root && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            {t("链路详情")}
            <ChevronDown className={details ? "rotate-180" : undefined} />
          </Button>
        )}
      </div>
      {root && details && (
        <div className="resource-chain-details space-y-3">
          <p className="text-meta text-muted">
            {t(
              "直接关联 {0} 项 · 间接关联 {1} 项 · 涉及文档 {2} 篇",
              paths.filter((p) => p.distance === 1).length,
              paths.filter((p) => p.distance > 1).length,
              paths.filter((p) => p.row.kind === "document").length,
            )}
          </p>
          {root.kind === "mail" && (
            <p className="rounded-lg bg-warn/5 p-3 text-2xs leading-relaxed text-warn">
              {t(
                "邮箱失去访问时，可按下方链路核对登录、找回和通知设置。保存的关联不等于已验证的登录依赖。",
              )}
            </p>
          )}
          {!paths.length && (
            <p className="text-meta text-muted">
              {t("这项资源还没有已确认关联，可通过管理资源关联添加。")}
            </p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {(all ? paths : paths.slice(0, 8)).map((entry) => (
              <li
                key={resourceKey(entry.row)}
                className="min-w-0 rounded-lg bg-canvas p-3 text-meta"
              >
                <button
                  type="button"
                  className="flex w-full items-start gap-2 text-left font-medium"
                  onClick={() => onFocus(entry.row)}
                >
                  <span className="min-w-0 flex-1 break-words">
                    {entry.row.name}{" "}
                    <span className="text-2xs font-normal text-muted">
                      {t(resourceKindName(entry.row))}
                    </span>
                  </span>
                  <ArrowUpRight className="size-3.5 shrink-0" />
                </button>
                <p className="mt-1 break-words text-2xs leading-relaxed text-muted">
                  {entry.path.map((ref) => names.get(resourceKey(ref)) ?? ref.id).join(" ↔ ")}
                </p>
              </li>
            ))}
          </ul>
          {paths.length > 8 && (
            <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
              {t(all ? "收起链路列表" : "查看全部 {0} 项关联", paths.length)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
