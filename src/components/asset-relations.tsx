import { Link2, Plus, Unlink } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Select } from "./ui/input";
import { AssetPicker } from "./asset-picker";
import { t } from "@/lib/i18n";
import { refKey } from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import {
  connectedRefs,
  openResource,
  resourceKindLabel,
  useResourceInventory,
} from "@/lib/resource-inventory";
import { updateResourceRelation } from "@/lib/resource-relation-actions";
import type { ResourceRef } from "@/lib/types";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function AssetRelations({
  asset,
  documentsSeparate = false,
}: {
  asset: ResourceRef;
  documentsSeparate?: boolean;
}) {
  const { resources, relations, loaded, error: loadError } = useResourceInventory();
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const [selected, setSelected] = useState("");
  const [multiple, setMultiple] = useState<string[]>([]);
  const [batch, setBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { kind, id } = asset;
  const self = refKey({ kind, id });
  const linked = useMemo(() => connectedRefs({ kind, id }, relations), [kind, id, relations]);
  // 文档仍可批量关联；展示时只列在紧邻的「关联文档」中，避免重复。
  const related = documentsSeparate ? linked.filter((ref) => ref.kind !== "document") : linked;
  const entryByKey = useMemo(
    () => new Map(resources.map((row) => [refKey(row), row])),
    [resources],
  );
  const choices = useMemo(() => {
    if (!editing) return [];
    const excluded = new Set([self, ...linked.map(refKey)]);
    return resources
      .filter((row) => !excluded.has(refKey(row)))
      .map((row) => ({ ...row, label: row.name }));
  }, [editing, self, linked, resources]);
  const chosen = choices.find((entry) => refKey(entry) === selected);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="detail-section detail-relations"
      aria-label={t("关联资产")}
      aria-busy={busy || (!loaded && !loadError)}
    >
      <div className="detail-section-heading">
        <h3 className="tool-heading">
          <Link2 className="size-4" aria-hidden="true" />
          {t("关联资产")}
          {loaded && <span className="detail-section-count">{related.length}</span>}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            useAppStore.getState().setView("relations");
            useAppStore.setState({ relationFocus: asset });
          }}
        >
          {t("查看完整关联链")}
        </Button>
      </div>
      {(error || loadError) && (
        <p role="alert" className="my-2 text-meta text-crit">
          {error || loadError}
        </p>
      )}
      {busy && (
        <p role="status" className="my-2 text-meta text-muted">
          {t("正在保存…")}
        </p>
      )}
      {!loaded && !loadError && (
        <p className="detail-context-empty" role="status">
          {t("正在加载…")}
        </p>
      )}
      {loaded && related.length === 0 && (
        <p className="detail-context-empty">{t("尚未关联资产")}</p>
      )}
      <ul className="detail-relationship-list divide-y divide-line">
        {related.map((ref) => {
          const entry = entryByKey.get(refKey(ref));
          if (!entry) return null;
          return (
            <li key={refKey(ref)} className="flex min-w-0 items-center gap-2 py-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left text-meta hover:underline"
                onClick={(event) => {
                  const r = event.currentTarget.getBoundingClientRect();
                  void openResource(ref, { x: r.x, y: r.y, w: r.width, h: r.height }).catch(
                    (cause) => setError(errorText(cause)),
                  );
                }}
              >
                <span className="mr-2 text-subtle">{t(resourceKindLabel(entry))}</span>
                <span className="break-words">{entry.name}</span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                title={t("解除关联")}
                aria-label={t("解除关联")}
                onClick={() => void run(() => updateResourceRelation(asset, ref, true))}
              >
                <Unlink className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        aria-expanded={editing}
        aria-controls={editorId}
        onClick={() => setEditing(!editing)}
      >
        <Plus aria-hidden="true" />
        {t("管理关联")}
      </Button>
      <div id={editorId} hidden={!editing}>
        {editing && (
          <div className="detail-relation-editor">
            <div className="flex min-w-0 items-center gap-2">
              <Select
                className="min-w-0 flex-1 text-meta"
                aria-label={t("选择关联资产")}
                value={chosen ? selected : ""}
                onValueChange={setSelected}
                options={[
                  { value: "", label: t("选择关联资产") },
                  ...choices.map((entry) => ({
                    value: refKey(entry),
                    label: entry.label,
                    description: t(resourceKindLabel(entry)),
                  })),
                ]}
              />
              <Button
                variant="outline"
                size="icon-sm"
                disabled={busy || !chosen}
                title={t("添加关联")}
                aria-label={t("添加关联")}
                onClick={() => {
                  if (!chosen) return;
                  void run(async () => {
                    await updateResourceRelation(asset, chosen);
                    setSelected("");
                  });
                }}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              className="mt-2"
              aria-expanded={batch}
              onClick={() => setBatch(!batch)}
            >
              {t("搜索与多选关联")}
            </Button>
            {batch && (
              <div className="mt-2 space-y-3">
                <AssetPicker
                  label={t("选择多个关联资产")}
                  entries={choices}
                  selected={multiple}
                  onChange={setMultiple}
                />
                <Button
                  disabled={busy || !choices.some((entry) => multiple.includes(refKey(entry)))}
                  onClick={() =>
                    void run(async () => {
                      let done = 0;
                      try {
                        for (const target of choices.filter((entry) =>
                          multiple.includes(refKey(entry)),
                        )) {
                          await updateResourceRelation(asset, target);
                          done += 1;
                        }
                        setMultiple([]);
                      } catch (cause) {
                        throw Error(t("已保存 {0} 项关联，后续失败：{1}", done, errorText(cause)));
                      }
                    })
                  }
                >
                  <Plus className="mr-2 size-4" />
                  {t("添加所选关联")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
