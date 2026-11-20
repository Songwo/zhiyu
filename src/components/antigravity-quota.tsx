import { useState } from "react";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { AiUsageWindow } from "@/lib/ai-accounts";
import { Button } from "./ui/button";

export function AntigravityQuota() {
  const read = desktop()?.aiAccounts?.antigravityQuota;
  const [busy, setBusy] = useState(false);
  const [windows, setWindows] = useState<AiUsageWindow[]>([]);
  const [error, setError] = useState("");
  if (!read) return null;
  return (
    <section className="rounded-lg border border-line px-4 py-3" aria-label="Antigravity CLI">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Antigravity CLI</h2>
          <p className="text-xs text-muted">
            {t("读取本机 Antigravity CLI 当前登录账号的额度，结果仅在此处显示。")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setWindows([]);
            setError("");
            try {
              setWindows((await read()).windows);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t(busy ? "正在读取…" : "读取本机额度")}
        </Button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-crit" role="alert">
          {t(error)}
        </p>
      )}
      {windows.length > 0 && (
        <ul className="mt-2 divide-y divide-line text-sm">
          {windows.map((window) => (
            <li key={window.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              <span>{window.model}</span>
              <span className="text-muted">
                {t(window.windowSeconds === 18000 ? "5 小时" : "7 天")}
              </span>
              <strong>
                {t("剩余 {0}%", Number((100 - (window.usedPercent ?? 0)).toFixed(2)))}
              </strong>
              {window.resetsAt && (
                <time className="text-muted" dateTime={window.resetsAt}>
                  {t("重置于 {0}", new Date(window.resetsAt).toLocaleString())}
                </time>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
