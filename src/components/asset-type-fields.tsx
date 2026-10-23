import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { t } from "@/lib/i18n";
import { SERVICE_LABELS } from "@/lib/services";
import { Field, Input, Select } from "./ui/input";
import { fieldKey } from "@/lib/asset-type-form";
import { AssetTypeManager } from "./asset-type-manager";

const NEW_TYPE = "__new-type";

/** 服务表单里的「资产类型」选择与自定义字段。 */
export function ServiceTypeFields({
  form,
  set,
}: {
  form: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  const types = useAppStore((s) => s.assetTypes);
  const [creating, setCreating] = useState(false);
  const current = types.find((type) => type.id === form.typeId);
  const value = current ? current.id : `builtin:${form.category || "custom"}`;
  return (
    <>
      <Field label={t("资产类型")}>
        <Select
          aria-label={t("资产类型")}
          value={value}
          onValueChange={(next) => {
            if (next === NEW_TYPE) {
              setCreating(true);
              return;
            }
            if (next.startsWith("builtin:")) {
              set("category", next.slice("builtin:".length));
              set("typeId", "");
            } else {
              set("category", "custom");
              set("typeId", next);
            }
          }}
          options={[
            ...Object.entries(SERVICE_LABELS).map(([key, label]) => ({
              value: `builtin:${key}`,
              label: t(label),
            })),
            ...types.map((type) => ({ value: type.id, label: type.name })),
            { value: NEW_TYPE, label: t("＋ 新建自定义类型…") },
          ]}
        />
      </Field>
      {current?.fields.map((field) => (
        <Field key={field.id} label={field.label}>
          <Input
            aria-label={field.label}
            type={field.kind === "date" ? "date" : "text"}
            inputMode={field.kind === "number" ? "decimal" : undefined}
            placeholder={field.kind === "url" ? "https://" : undefined}
            maxLength={500}
            value={form[fieldKey(field.id)] ?? ""}
            onChange={(event) => set(fieldKey(field.id), event.target.value)}
          />
        </Field>
      ))}
      {creating && (
        <AssetTypeManager
          startNew
          onClose={() => {
            setCreating(false);
            // 刚建好的类型排在最后，直接选中它。
            const latest = useAppStore.getState().assetTypes.at(-1);
            if (
              latest &&
              latest.id !== form.typeId &&
              !types.some((type) => type.id === latest.id)
            ) {
              set("category", "custom");
              set("typeId", latest.id);
            }
          }}
        />
      )}
    </>
  );
}
