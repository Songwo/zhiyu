import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, LockKeyhole, Pencil, ShieldCheck } from "lucide-react";
import type { ServiceAsset } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { vaultApi } from "@/lib/vault-api";
import { copyText } from "@/lib/utils";
import { cardPrivateId, normalizeCardPrivate } from "@/lib/card-private.mjs";
import { detectCardNetwork } from "../../electron/services/managed-cards.mjs";
import { bankMetadataPatch, detectChinaBank } from "@/lib/card-identity.mjs";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { EditorDialog } from "./ui/editor-dialog";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";

type PrivateRecord = ReturnType<typeof normalizeCardPrivate>;

/** 锁库、翻回正面和离开详情都会隐藏并清理明文；复制始终重新校验解锁状态。 */
export function CardPrivate({ data, active }: { data: ServiceAsset; active: boolean }) {
  const kind = data.card!.kind;
  const unlocked = useVault((state) => state.unlocked);
  const [record, setRecord] = useState<PrivateRecord | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editor, setEditor] = useState<PrivateRecord | null>(null);
  const [copied, setCopied] = useState("");
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const owner = useRef({ id: data.id, active });
  owner.current = { id: data.id, active };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setRecord(null);
    setRevealed(false);
    setCopied("");
    if (!unlocked || !active) setEditor(null);
    if (unlocked && active)
      void vaultApi()
        ?.get(cardPrivateId(data.id))
        .then((value) => {
          if (live && useVault.getState().unlocked) setRecord(normalizeCardPrivate(value, kind));
        })
        .catch((error) => {
          if (live) toast.error(String(error.message));
        });
    return () => {
      live = false;
    };
  }, [data.id, active, unlocked, kind, revision]);
  useEffect(() => {
    if (!revealed) return;
    const hide = () => setRevealed(false);
    const timer = window.setTimeout(hide, 20000);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [revealed]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  async function access(action: (value: PrivateRecord) => Promise<void> | void) {
    if (busy.current) return;
    busy.current = true;
    const id = data.id;
    try {
      if (!(await useVault.getState().require(t("查看或复制完整卡片资料需要解锁密钥库。")))) return;
      const api = vaultApi();
      if (!api) return;
      const value = normalizeCardPrivate(await api.get(cardPrivateId(id)), kind);
      const status = await api.status();
      if (
        !mounted.current ||
        owner.current.id !== id ||
        !owner.current.active ||
        !status.unlocked ||
        !useVault.getState().unlocked
      )
        return;
      setRecord(value);
      await action(value);
    } catch (error) {
      if (mounted.current && owner.current.id === id && owner.current.active)
        toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
    }
  }
  const fields: { key: keyof PrivateRecord; label: string }[] =
    kind === "payment"
      ? [
          { key: "number", label: t("完整卡号") },
          { key: "holder", label: t("持卡人") },
          { key: "cvv", label: t("安全码 CVV") },
        ]
      : [
          { key: "iccid", label: "ICCID" },
          { key: "eid", label: "EID" },
          { key: "activationCode", label: t("激活码") },
        ];
  const show = active && unlocked && revealed;
  return (
    <>
      <div className="card-private-heading">
        <span>
          <ShieldCheck />
          {unlocked ? t("已解锁 · 加密资料") : t("敏感资料已锁定")}
        </span>
        <button
          type="button"
          aria-label={revealed ? t("隐藏卡片资料") : t("显示卡片资料")}
          onClick={() => (revealed ? setRevealed(false) : void access(() => setRevealed(true)))}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </button>
      </div>
      <div className="card-private-rows">
        {fields.map(({ key, label }) => (
          <div key={key}>
            <span className="card-private-label">{label}</span>
            <span className="card-private-value">
              {show
                ? record?.[key] || t("未保存")
                : unlocked && record && !record[key]
                  ? t("未保存")
                  : key === "number"
                    ? `•••• •••• •••• ${data.card?.last4 || "••••"}`
                    : "••••••"}
            </span>
            <button
              type="button"
              aria-label={t("复制{0}", label)}
              title={t("复制{0}", label)}
              onClick={() =>
                void access(async (value) => {
                  if (!value[key]) {
                    toast(t("请先录入加密卡片资料"));
                    return;
                  }
                  await copyText(value[key]);
                  if (mounted.current && owner.current.active) {
                    setCopied(key);
                    toast.success(t("已复制{0}", label));
                  }
                })
              }
            >
              {copied === key ? <Check /> : <Copy />}
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="card-private-edit"
        onClick={() =>
          void access((value) => {
            setRevealed(false);
            setEditor(value);
          })
        }
      >
        {unlocked ? <Pencil /> : <LockKeyhole />}
        {t("录入或编辑加密资料")}
      </button>
      {editor && active && unlocked && (
        <PrivateEditor
          key={data.id}
          data={data}
          value={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

function PrivateEditor({
  data,
  value,
  onClose,
  onSaved,
}: {
  data: ServiceAsset;
  value: PrivateRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [adoptBank, setAdoptBank] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const fields: { key: keyof PrivateRecord; label: string; type?: string }[] =
    data.card!.kind === "payment"
      ? [
          { key: "number", label: t("完整卡号"), type: "password" },
          { key: "holder", label: t("持卡人") },
          { key: "cvv", label: t("安全码 CVV"), type: "password" },
        ]
      : [
          { key: "iccid", label: "ICCID", type: "password" },
          { key: "eid", label: "EID", type: "password" },
          { key: "activationCode", label: t("激活码"), type: "password" },
        ];
  const detected = data.card!.kind === "payment" ? detectCardNetwork(form.number) : "";
  const detectedBank = data.card!.kind === "payment" ? detectChinaBank(form.number) : undefined;
  const networkMismatch =
    detected && data.card?.network && detected.toLowerCase() !== data.card.network.toLowerCase();
  return (
    <EditorDialog
      title={t("加密卡片资料")}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="card-secrets-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setError("");
          setSaving(true);
          try {
            const api = vaultApi();
            if (!api || !useVault.getState().unlocked) throw new Error(t("密钥库已锁定"));
            if (!useAppStore.getState().services.some((item) => item.id === data.id))
              throw new Error(t("该资产已被删除，请重新打开"));
            const safe = normalizeCardPrivate(form, data.card!.kind);
            await api.set(cardPrivateId(data.id), { ...safe, updatedAt: new Date().toISOString() });
            if (!live.current || !useVault.getState().unlocked) return;
            const latest = useAppStore.getState().services.find((item) => item.id === data.id);
            if (!latest?.card) throw new Error(t("该资产已被删除，请重新打开"));
            const number = safe.number || safe.iccid;
            const bankPatch = bankMetadataPatch(
              { provider: latest.provider, ...latest.card },
              detectedBank,
              adoptBank,
            );
            const { provider, ...cardPatch } = bankPatch;
            if (number)
              useAppStore.getState().upsertService({
                ...latest,
                ...(provider ? { provider } : {}),
                card: {
                  ...latest.card,
                  ...cardPatch,
                  last4: number.slice(-4),
                  ...(latest.card.kind === "payment" && !latest.card.network
                    ? { network: detectCardNetwork(safe.number) }
                    : {}),
                },
              });
            setForm(normalizeCardPrivate(null, data.card!.kind));
            onSaved();
            toast.success(t("加密资料已保存"));
          } catch (failure) {
            if (live.current)
              setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            if (live.current) setSaving(false);
          }
        }}
      >
        <p className="card-form-help">
          {t("完整卡号、安全码与激活资料只保存在密钥库，不进入普通资产或 AI 上下文。")}
        </p>
        {networkMismatch && (
          <p className="mb-4 text-sm text-muted">
            {t("卡号前缀识别为 {0}，与当前卡组织不同，请核对后保存。", detected)}
          </p>
        )}
        {detectedBank && (
          <div className="card-bank-result">
            <p className="card-form-help">
              {t("参考号段识别：{0}，请核对。", detectedBank.provider)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => setAdoptBank(!adoptBank)}
            >
              {adoptBank ? t("已选择，保存时采用") : t("保存时采用此银行")}
            </Button>
          </div>
        )}
        <fieldset disabled={saving} className="grid gap-4">
          {fields.map(({ key, label, type }) => (
            <div key={key}>
              <Label>{label}</Label>
              <Input
                aria-label={label}
                type={type || "text"}
                autoComplete="off"
                inputMode={["number", "cvv", "iccid", "eid"].includes(key) ? "numeric" : "text"}
                maxLength={
                  key === "activationCode" ? 4096 : key === "holder" ? 200 : key === "cvv" ? 4 : 64
                }
                value={form[key]}
                onChange={(event) => {
                  if (key === "number") setAdoptBank(false);
                  setForm((old) => ({ ...old, [key]: event.target.value }));
                }}
              />
            </div>
          ))}
          <div>
            <Label>{t("加密备注")}</Label>
            <Textarea
              aria-label={t("加密备注")}
              maxLength={10000}
              value={form.note}
              onChange={(event) => setForm((old) => ({ ...old, note: event.target.value }))}
            />
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="card-editor-footer">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={saving}>
            {t("保存加密资料")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}
