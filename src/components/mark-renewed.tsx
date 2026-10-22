import { CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import type { RenewalEntry } from "../../electron/services/renewals.mjs";
import { t } from "@/lib/i18n";
import { renewalStep } from "@/lib/renewal-step";
import { expiryStatus } from "@/lib/status";
import { useAppStore } from "@/lib/store";

/**
 * 「已续费」：续费完成后把到期日按周期顺延一期，日历和提醒随之更新；toast 里可以撤销。
 * 只对实际记录的到期日、月付或年付的资产显示；网页授权同步的 AI 订阅由服务商日期决定，不显示。
 */
export function MarkRenewedButton({
  entry,
  projected = false,
}: {
  entry: RenewalEntry;
  projected?: boolean;
}) {
  const step = renewalStep({ ...entry, projected });
  const oauth = useAppStore(
    (s) =>
      entry.kind === "ai" &&
      Boolean(s.aiAssets.find((item) => item.id === entry.id)?.oauthAccountId),
  );
  if (!step || oauth) return null;
  return (
    <button
      type="button"
      className="renewed-action"
      title={t("续费完成后，到期日顺延到 {0}", step.next)}
      aria-label={t("标记 {0} 已续费", entry.name)}
      onClick={() => markRenewed(entry, step)}
    >
      <CalendarCheck aria-hidden="true" />
      <span>{t("已续费")}</span>
    </button>
  );
}

function markRenewed(entry: RenewalEntry, step: NonNullable<ReturnType<typeof renewalStep>>) {
  const state = useAppStore.getState();
  let undo: (() => void) | null = null;
  if (entry.kind === "server") {
    const asset = state.servers.find((item) => item.id === entry.id);
    if (!asset) return;
    state.upsertServer({ ...asset, expiresAt: step.next });
    undo = () => useAppStore.getState().upsertServer(asset);
  } else if (entry.kind === "domain") {
    const asset = state.domains.find((item) => item.id === entry.id);
    if (!asset) return;
    state.upsertDomain({ ...asset, expiresAt: step.next, status: expiryStatus(step.next) });
    undo = () => useAppStore.getState().upsertDomain(asset);
  } else if (entry.kind === "service") {
    const asset = state.services.find((item) => item.id === entry.id);
    if (!asset) return;
    state.upsertService({ ...asset, expiresAt: step.next });
    undo = () => useAppStore.getState().upsertService(asset);
  } else if (entry.kind === "ai") {
    const asset = state.aiAssets.find((item) => item.id === entry.id);
    if (!asset || asset.oauthAccountId) return;
    state.upsertAi({ ...asset, renewsAt: keepTime(asset.renewsAt, step.next) });
    undo = () => useAppStore.getState().upsertAi(asset);
  } else if (entry.kind === "phone") {
    const record = state.phoneNumbers.find((item) => item.id === entry.id);
    if (!record) return;
    state.upsertPhoneNumber({ ...record, expiresAt: step.next });
    undo = () => useAppStore.getState().upsertPhoneNumber(record);
  }
  if (!undo) return;
  const restore = undo;
  state.log(
    t("已标记「{0}」续费，下次到期 {1}", entry.name, step.next),
    entry.kind === "phone" ? undefined : entry.kind,
  );
  toast.success(t("已标记续费：下次到期 {0}", step.next), {
    action: {
      label: t("撤销"),
      onClick: () => {
        restore();
        useAppStore.getState().log(t("撤销了「{0}」的续费标记", entry.name));
      },
    },
  });
}

/** 带时刻的续费日（同步来的 ISO 时间）只换本地日期，保留原来的时刻与格式。 */
function keepTime(previous: string, day: string) {
  if (!previous.includes("T")) return day;
  const date = new Date(previous);
  if (Number.isNaN(date.getTime())) return day;
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  date.setFullYear(year, month - 1, dayOfMonth);
  return date.toISOString();
}
