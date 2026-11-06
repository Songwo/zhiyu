import { useState } from "react";
import { ListChecks, X, Tags, Link2 } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { assetRows, filterAssetRows } from "@/lib/asset-view";
import { refKey, updateAssetTags } from "@/lib/operations";
import { useResourceInventory } from "@/lib/resource-inventory";
import { updateResourceRelation } from "@/lib/resource-relation-actions";
import { parseTags } from "@/lib/tags";
import { t } from "@/lib/i18n";
import { AssetPicker } from "./asset-picker";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

export function AssetOrganizer() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="icon-sm" title={t("批量整理")} aria-label={t("批量整理")}>
          <ListChecks className="size-4" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] max-w-lg -translate-y-1/2 overflow-y-auto rounded-lg bg-card p-5 text-ink shadow-float"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">{t("批量整理")}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("关闭")}>
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <OrganizerBody close={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OrganizerBody({ close }: { close: () => void }) {
  const { resources } = useResourceInventory();
  const state = useAppStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"tags" | "links">("tags");
  const [tagMode, setTagMode] = useState<"add" | "remove">("add");
  const [tags, setTags] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const entries = filterAssetRows(
    assetRows(state),
    state.view,
    state.query,
    state.filter === "attention",
    state.tagFilter,
  ).map((row) => ({ ...row, label: row.name }));
  const refs = entries.filter((entry) => selected.includes(refKey(entry)));
  const targets = resources
    .map((row) => ({ ...row, label: row.name }))
    .filter((entry) => !refs.some((ref) => refKey(ref) === refKey(entry)));
  const valid =
    refs.length > 0 &&
    (mode === "tags"
      ? parseTags(tags).length > 0
      : targets.some((entry) => refKey(entry) === target));
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        try {
          if (mode === "tags")
            await useAppStore.setState((latest) => updateAssetTags(latest, refs, tags, tagMode));
          else {
            const to = targets.find((entry) => refKey(entry) === target);
            if (to) {
              let done = 0;
              try {
                for (const ref of refs) {
                  await updateResourceRelation(to, ref);
                  done++;
                }
              } catch (cause) {
                throw Error(
                  t(
                    "已保存 {0} 项关联，后续失败：{1}",
                    done,
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                );
              }
            }
          }
          state.log(t("已整理 {0} 项资产", refs.length));
          toast.success(t("已整理 {0} 项资产", refs.length));
          close();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <AssetPicker
        label={t("待整理资产")}
        entries={entries}
        selected={selected}
        onChange={setSelected}
      />
      <div className="flex gap-2" role="group" aria-label={t("整理方式")}>
        <Button
          type="button"
          variant={mode === "tags" ? "solid" : "outline"}
          aria-pressed={mode === "tags"}
          onClick={() => setMode("tags")}
        >
          <Tags className="mr-2 size-4" />
          {t("标签")}
        </Button>
        <Button
          type="button"
          variant={mode === "links" ? "solid" : "outline"}
          aria-pressed={mode === "links"}
          onClick={() => setMode("links")}
        >
          <Link2 className="mr-2 size-4" />
          {t("关联资产")}
        </Button>
      </div>
      {mode === "tags" ? (
        <>
          <Select
            aria-label={t("标签操作")}
            value={tagMode}
            onValueChange={(value) => setTagMode(value as "add" | "remove")}
            options={[
              { value: "add", label: t("添加标签") },
              { value: "remove", label: t("移除标签") },
            ]}
          />
          <Field label={t("标签（逗号分隔）")}>
            <Input
              aria-label={t("批量标签")}
              value={tags}
              maxLength={500}
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Select
          aria-label={t("关联到")}
          value={targets.some((e) => refKey(e) === target) ? target : ""}
          onValueChange={setTarget}
          options={[
            { value: "", label: t("选择关联资产") },
            ...targets.map((entry) => ({ value: refKey(entry), label: entry.label })),
          ]}
        />
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={!valid || busy}>
          {t(busy ? "保存中…" : "应用到所选资产")}
        </Button>
      </div>
    </form>
  );
}
