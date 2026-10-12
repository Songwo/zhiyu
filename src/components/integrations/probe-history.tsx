import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { desktop } from "@/lib/desktop";
import { t, intlLocale } from "@/lib/i18n";
import type { ProbeSample } from "@/lib/integrations";
import { Button } from "../ui/button";
import { errorText } from "./data";
import { historySeries } from "./history-series.mjs";

export default function ProbeHistory({
  connectionId,
  hostId,
  updatedAt,
}: {
  connectionId: string;
  hostId: string;
  updatedAt?: string;
}) {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("1h");
  const [samples, setSamples] = useState<ProbeSample[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void desktop()!
      .integrations.probeHistory(connectionId, hostId, range)
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
  }, [connectionId, hostId, range, retry, updatedAt]);
  return (
    <section className="space-y-3" aria-label={t("探针指标历史")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-meta">{t("探针指标历史")}</h4>
        <div role="group" aria-label={t("时间范围")} className="flex gap-1">
          {(["1h", "24h", "7d"] as const).map((value) => (
            <button
              key={value}
              className="range-option"
              aria-pressed={value === range}
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
          <p role="alert" className="tool-error">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
            {t("重试")}
          </Button>
        </div>
      )}
      <div className="integration-history" aria-busy={busy}>
        {samples.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={historySeries(samples)}
              margin={{ top: 8, right: 8, bottom: 4, left: -18 }}
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
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => `${value}%`}
              />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString(intlLocale())}
                contentStyle={{
                  background: "var(--color-card)",
                  color: "var(--color-ink)",
                  borderColor: "var(--color-line)",
                }}
              />
              <Line
                name="CPU %"
                dataKey="cpu"
                stroke="var(--color-ink)"
                strokeWidth={2}
                dot={samples.length === 1}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                name={t("内存")}
                dataKey="memory"
                stroke="var(--color-ok)"
                strokeWidth={2}
                dot={samples.length === 1}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                name={t("磁盘")}
                dataKey="disk"
                stroke="var(--color-warn)"
                strokeWidth={2}
                dot={samples.length === 1}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="integration-empty">
            {busy ? t("正在加载…") : t("此时间范围还没有探针样本")}
          </p>
        )}
      </div>
      <p className="text-2xs text-muted">{t("CPU · 内存 · 磁盘，单位 %；缺失样本保持断开")}</p>
    </section>
  );
}
