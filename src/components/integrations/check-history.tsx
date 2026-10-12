import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { desktop } from "@/lib/desktop";
import { t, intlLocale } from "@/lib/i18n";
import type { ProbeCheckResult } from "@/lib/integrations";
import { Button } from "../ui/button";
import { ResourceStatus } from "./common";
import { dateText, errorText, numberText } from "./data";
import { historySeries } from "./history-series.mjs";

export default function CheckHistory({
  connectionId,
  checkId,
  intervalSeconds,
  updatedAt,
}: {
  connectionId: string;
  checkId: string;
  intervalSeconds: number;
  updatedAt?: string;
}) {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("1h");
  const [samples, setSamples] = useState<ProbeCheckResult[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void desktop()!
      .integrations.probeCheckHistory(connectionId, checkId, range)
      .then((rows) => {
        if (!cancelled) {
          setSamples(rows);
          setError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, checkId, range, retry, updatedAt]);
  return (
    <section className="space-y-4" aria-label={t("延迟与检查记录")}>
      <div className="integration-toolbar">
        <h4 className="font-medium text-meta">{t("延迟与检查记录")}</h4>
        <div className="flex gap-1" role="group" aria-label={t("时间范围")}>
          {(["1h", "24h", "7d"] as const).map((value) => (
            <button
              key={value}
              className="range-option"
              aria-pressed={range === value}
              onClick={() => {
                setSamples([]);
                setRange(value);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div className="flex gap-2">
          <p className="tool-error" role="alert">
            {error}
          </p>
          <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
            {t("重试")}
          </Button>
        </div>
      )}
      <div className="integration-history" aria-busy={busy}>
        {samples.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={historySeries(
                samples.map((row) => ({
                  ...row,
                  latencyMs: row.status === "up" ? row.latencyMs : null,
                })),
                intervalSeconds * 1000,
              )}
              margin={{ top: 8, right: 8, bottom: 4, left: -12 }}
            >
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                minTickGap={45}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) =>
                  new Date(value).toLocaleString(
                    intlLocale(),
                    range === "7d"
                      ? { month: "numeric", day: "numeric" }
                      : { hour: "2-digit", minute: "2-digit" },
                  )
                }
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(value) => dateText(new Date(Number(value)).toISOString())}
                contentStyle={{
                  background: "var(--color-card)",
                  color: "var(--color-ink)",
                  borderColor: "var(--color-line)",
                }}
              />
              <Line
                name={t("延迟（毫秒）")}
                dataKey="latencyMs"
                stroke="var(--color-ok)"
                strokeWidth={2}
                dot={samples.length < 3}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="integration-empty">
            {busy ? t("正在加载…") : t("此时间范围还没有检查记录")}
          </p>
        )}
      </div>
      <p className="text-2xs text-muted">{t("延迟仅展示成功检查；失败与未覆盖时间不会补为零。")}</p>
      <div className="integration-check-results" aria-label={t("检查记录")}>
        {[...samples].reverse().map((row, index) => (
          <div key={`${row.at}:${index}`} className="integration-dns-row">
            <div className="flex items-center justify-between gap-2">
              <time className="text-2xs text-muted">{dateText(row.at)}</time>
              <ResourceStatus status={row.status} />
            </div>
            <p className="mt-1 text-meta">{numberText(row.latencyMs, " ms")}</p>
            {row.message && <p className="mt-1 break-all text-2xs text-muted">{row.message}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
