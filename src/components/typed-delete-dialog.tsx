import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@/lib/i18n";
import { EditorDialog } from "./ui/editor-dialog";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";

/** 必须逐字输入当前资产名称；回车和取消均不会绕过检查。 */
export function TypedDeleteDialog({
  name,
  onClose,
  onConfirm,
  description,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  description?: string;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <EditorDialog
      title={t("确认删除资产")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="typed-delete-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name || typed !== name || busy) return;
          setBusy(true);
          setError("");
          try {
            await onConfirm();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="delete-warning">
          <AlertTriangle aria-hidden="true" />
          <p>{t("将删除「{0}」及其资产关联，文档本身会保留。此操作无法撤销。", name)}</p>
        </div>
        {description && <p className="mb-4 text-sm text-muted">{description}</p>}
        <Label htmlFor="delete-original-name">{t("请输入完整名称以确认删除")}</Label>
        <p className="mb-3 break-all rounded-lg bg-surface p-3 font-semibold select-all">{name}</p>
        <Input
          id="delete-original-name"
          aria-label={t("请输入完整名称以确认删除")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
        {error && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" variant="danger" disabled={busy || !name || typed !== name}>
            {busy ? t("处理中…") : t("永久删除")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}
