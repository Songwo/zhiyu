import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { refKey } from "@/lib/operations";
import type { ResourceRef } from "@/lib/types";
import { resourceKindLabel } from "@/lib/resource-inventory";
import { t } from "@/lib/i18n";

export function AssetPicker({
  entries,
  selected,
  onChange,
  label,
}: {
  entries: (ResourceRef & { label: string })[];
  selected: string[];
  onChange: (keys: string[]) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const unique = [...new Map(entries.map((entry) => [refKey(entry), entry])).values()];
  const chosen = unique.filter((entry) => selected.includes(refKey(entry)));
  const visible = unique.filter((entry) =>
    `${entry.label} ${t(resourceKindLabel(entry))}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const all = visible.length > 0 && visible.every((entry) => selected.includes(refKey(entry)));
  return (
    <div className="asset-picker min-w-0 space-y-2" role="group" aria-label={label}>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={t("已选关联")}>
          {chosen.map((entry) => (
            <span
              key={refKey(entry)}
              className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-line bg-canvas px-2.5 py-1 text-2xs"
            >
              <span className="truncate" title={`${entry.label} · ${t(resourceKindLabel(entry))}`}>
                {entry.label}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 min-h-6 min-w-6"
                aria-label={t("移除关联 {0}", entry.label)}
                title={t("移除关联 {0}", entry.label)}
                onClick={() => onChange(selected.filter((key) => key !== refKey(entry)))}
              >
                <X className="size-3" />
              </Button>
            </span>
          ))}
        </div>
      )}
      <Input
        aria-label={t("搜索资产名称或类型")}
        placeholder={t("搜索资产名称或类型")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <label className="flex min-h-11 items-center gap-2 text-meta">
        <input
          type="checkbox"
          checked={all}
          disabled={!visible.length}
          onChange={() => {
            const keys = visible.map(refKey);
            onChange(
              all
                ? selected.filter((key) => !keys.includes(key))
                : [...new Set([...selected, ...keys])],
            );
          }}
        />
        {t("选择搜索结果")}{" "}
        <span className="ml-auto text-muted">{t("已选 {0} 项", chosen.length)}</span>
      </label>
      <div className="h-56 overflow-y-auto border-y border-line">
        {!visible.length && <p className="py-4 text-meta text-muted">{t("没有匹配的资产")}</p>}
        {visible.map((entry) => (
          <label
            key={refKey(entry)}
            className="flex min-h-11 items-center gap-3 border-b border-line py-2 text-meta"
          >
            <input
              type="checkbox"
              checked={selected.includes(refKey(entry))}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...new Set([...selected, refKey(entry)])]
                    : selected.filter((key) => key !== refKey(entry)),
                )
              }
            />
            <span className="min-w-0 flex-1 break-words">{entry.label}</span>
            <span className="shrink-0 text-subtle">{t(resourceKindLabel(entry))}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
