import { useEffect, useState } from "react";
import { desktop } from "@/lib/desktop";
import { intlLocale } from "@/lib/i18n";
import type { IntegrationInventory, IntegrationProvider } from "@/lib/integrations";

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const dateText = (value?: string | null) =>
  value ? new Date(value).toLocaleString(intlLocale()) : "—";
export const numberText = (value?: number | null, suffix = "") =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}${suffix}`;
export function bytesText(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const index = Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))));
  return `${numberText(value / 1024 ** index)} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
}

export function useInventory(id: string, provider: IntegrationProvider) {
  const [data, setData] = useState<IntegrationInventory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let first = true;
    const load = async () => {
      if (pending || document.hidden || !id) return;
      pending = true;
      setBusy(true);
      try {
        const result = await desktop()!.integrations.inventory(id, first && revision > 0);
        if (!stopped) {
          setData(result);
          setError("");
        }
      } catch (reason) {
        if (!stopped) setError(errorText(reason));
      } finally {
        first = false;
        pending = false;
        if (!stopped) setBusy(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), provider === "probe" ? 5000 : 60000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [id, provider, revision]);
  return { data, error, busy, refresh: () => setRevision((n) => n + 1) };
}

export function openIntegrations() {
  window.dispatchEvent(new Event("settings:integrations"));
}
