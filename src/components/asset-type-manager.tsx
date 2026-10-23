import { Plus, Settings2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AssetType, AssetTypeField } from "@/lib/types";
import { FIELD_KIND_LABEL, MAX_TYPE_FIELDS, TYPE_ICONS, newId, typeIcon } from "@/lib/asset-types";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { EditorDialog } from "./ui/editor-dialog";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

const blankType = (): AssetType => ({
  id: newId("type"),
  name: "",
  icon: "box",
  fields: [],
});

/** 「管理类型」：新建、修改和删除自定义资产类型。 */
export function AssetTypeManagerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="size-4" />
        {t("管理类型")}
      </Button>
      {open && <AssetTypeManager onClose={() => setOpen(false)} />}
    </>
  );
}

export function AssetTypeManager({
  onClose,
  startNew = false,
}: {
  onClose: () => void;
  startNew?: boolean;
}) {
  const types = useAppStore((s) => s.assetTypes);
  const services = useAppStore((s) => s.services);
  const [draft, setDraft] = useState<AssetType | null>(startNew ? blankType() : null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const used = (id: string) => services.filter((service) => service.typeId === id).length;

  if (draft) {
    return (
      <EditorDialog
        title={types.some((type) => type.id === draft.id) ? t("编辑资产类型") : t("新建资产类型")}
        onClose={() => (startNew ? onClose() : setDraft(null))}
      >
        <TypeForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => (startNew ? onClose() : setDraft(null))}
          onSave={() => {
            try {
              useAppStore.getState().upsertAssetType({
                ...draft,
                fields: draft.fields.filter((field) => field.label.trim()),
              });
              toast.success(t("已保存类型「{0}」", draft.name.trim()));
              if (startNew) onClose();
              else setDraft(null);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      </EditorDialog>
    );
  }

  return (
    <EditorDialog title={t("自定义资产类型")} onClose={onClose}>
      <div className="asset-type-manager">
        <p className="text-meta text-muted">
          {t(
            "给自己的资产定义类型和字段，比如家用 NAS、游戏账号、设备保修。资产仍可记录费用、到期日和标签。",
          )}
        </p>
        {types.length === 0 ? (
          <p className="asset-type-empty">{t("还没有自定义类型。")}</p>
        ) : (
          <ul className="asset-type-list">
            {types.map((type) => {
              const Icon = typeIcon(type.icon);
              const count = used(type.id);
              return (
                <li key={type.id}>
                  <span className="asset-type-icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong>{type.name}</strong>
                    <span>
                      {t("{0} 个字段", type.fields.length)} · {t("{0} 项资产", count)}
                    </span>
                  </div>
                  {confirmDelete === type.id ? (
                    <>
                      <span className="text-2xs text-muted">
                        {count ? t("资产会保留，回到「其他服务」") : t("确定删除？")}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          useAppStore.getState().removeAssetType(type.id);
                          setConfirmDelete(null);
                          toast.success(t("已删除类型「{0}」", type.name));
                        }}
                      >
                        {t("删除")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        {t("取消")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft(structuredClone(type))}
                      >
                        {t("编辑")}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="danger-ghost"
                        aria-label={t("删除类型 {0}", type.name)}
                        onClick={() => setConfirmDelete(type.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="asset-type-actions">
          <Button onClick={() => setDraft(blankType())} disabled={types.length >= 30}>
            <Plus className="size-4" />
            {t("新建类型")}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}

function TypeForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: AssetType;
  onChange: (type: AssetType) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const setField = (id: string, patch: Partial<AssetTypeField>) =>
    onChange({
      ...draft,
      fields: draft.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    });
  return (
    <form
      className="asset-type-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <Field label={t("类型名称")}>
        <Input
          aria-label={t("类型名称")}
          value={draft.name}
          maxLength={40}
          required
          autoFocus
          placeholder={t("例如：家用 NAS")}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Field>
      <div>
        <span className="asset-type-label">{t("图标")}</span>
        <div className="asset-type-icons" role="radiogroup" aria-label={t("图标")}>
          {Object.entries(TYPE_ICONS).map(([key, { icon: Icon, label }]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={draft.icon === key}
              aria-label={t(label)}
              title={t(label)}
              className={cn(draft.icon === key && "is-selected")}
              onClick={() => onChange({ ...draft, icon: key })}
            >
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="asset-type-label">{t("字段")}</span>
        <ul className="asset-type-fields">
          {draft.fields.map((field, index) => (
            <li key={field.id}>
              <Input
                aria-label={t("字段名称 {0}", index + 1)}
                value={field.label}
                maxLength={40}
                placeholder={t("字段名称")}
                onChange={(event) => setField(field.id, { label: event.target.value })}
              />
              <Select
                aria-label={t("字段类型 {0}", index + 1)}
                value={field.kind}
                onValueChange={(value) =>
                  setField(field.id, { kind: value as AssetTypeField["kind"] })
                }
                options={Object.entries(FIELD_KIND_LABEL).map(([value, label]) => ({
                  value,
                  label: t(label),
                }))}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("移除字段 {0}", index + 1)}
                onClick={() =>
                  onChange({
                    ...draft,
                    fields: draft.fields.filter((item) => item.id !== field.id),
                  })
                }
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={draft.fields.length >= MAX_TYPE_FIELDS}
          onClick={() =>
            onChange({
              ...draft,
              fields: [...draft.fields, { id: newId("f"), label: "", kind: "text" }],
            })
          }
        >
          <Plus className="size-4" />
          {t("添加字段")}
        </Button>
        <p className="mt-2 text-2xs text-subtle">
          {t("字段内容会明文保存在资产里，不要填写密码或密钥，凭据请放进密钥库。")}
        </p>
      </div>
      <div className="asset-type-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button type="submit" disabled={!draft.name.trim()}>
          {t("保存")}
        </Button>
      </div>
    </form>
  );
}
