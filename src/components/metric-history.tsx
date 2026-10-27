import { hostBridge } from "@/lib/web-bridge";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "./ui/button";
import { type MetricSample } from "@/lib/desktop";
import { t, intlLocale } from "@/lib/i18n";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 唯一依赖 recharts 的组件。独立成文件并由调用方 lazy 加载，
// 图表库才不会被常驻的侧栏 / 设置页顺带拖进启动主包。
export function MetricHistory({ serverId }: { serverId: string }) {
  const [hours, setHours] = useState(24);
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bridge = hostBridge();
    if (!bridge) return;
    let cancelled = false;
    let request = 0;
    const refresh = async () => {
      const token = ++request;
      setBusy(true);
      try {
        const rows = await bridge.metrics.list(serverId, Date.now() - hours * 3_600_000);
        if (!cancelled && token === request) {
          setSamples(rows);
          setError("");
        }
      } catch (err) {
        if (!cancelled && token === request) setError(errorText(err));
      } finally {
        if (!cancelled && token === request) setBusy(false);
      }
    };
    void refresh();
    const off = bridge.metrics.onUpdated((e) => {
      if (e.id === serverId) void refresh();
    });
    const offError = bridge.metrics.onError((e) => {
      if (e.id === serverId) setError(e.error);
    });
    return () => {
      cancelled = true;
      off();
      offError();
    };
  }, [serverId, hours, revision]);
  const stride = Math.max(1, Math.ceil(samples.length / 500));
  const rows = samples
    .filter((_, i) => i % stride === 0 || i === samples.length - 1)
    .map((row) => ({ ...row, time: Date.parse(row.at) }));
  return (
    <section className="detail-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="tool-heading">{t("指标历史")}</h3>
        <div className="flex items-center gap-1" role="group" aria-label={t("时间范围")}>
          {[1, 24, 168].map((value) => (
            <button
              key={value}
              className="range-option"
              aria-pressed={hours === value}
              onClick={() => setHours(value)}
            >
              {value === 168 ? "7d" : `${value}h`}
            </button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("刷新")}
            title={t("刷新")}
            disabled={busy || !hostBridge()}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="metric-history" aria-busy={busy}>
        {rows.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 12, right: 12, left: -18, bottom: 4 }}>
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) =>
                  new Date(value).toLocaleTimeString(intlLocale(), {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
                minTickGap={40}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(value) => `${value}%`}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString(intlLocale())}
                contentStyle={{
                  background: "var(--color-card)",
                  borderColor: "var(--color-line)",
                  color: "var(--color-ink)",
                  borderRadius: 6,
                }}
              />
              <Line
                dataKey="cpu"
                name="CPU"
                stroke="var(--color-ink)"
                dot={rows.length === 1}
                isAnimationActive={false}
                connectNulls={false}
                strokeWidth={2}
              />
              <Line
                dataKey="memory"
                name={t("内存")}
                stroke="var(--color-ok)"
                dot={rows.length === 1}
                isAnimationActive={false}
                connectNulls={false}
                strokeWidth={2}
              />
              <Line
                dataKey="disk"
                name={t("磁盘")}
                stroke="var(--color-warn)"
                dot={rows.length === 1}
                isAnimationActive={false}
                connectNulls={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="tool-empty">{busy ? t("读取中…") : t("暂无真实采集记录")}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-2xs text-muted">
        <span>CPU</span>
        <span className="text-ok">{t("内存")}</span>
        <span className="text-warn">{t("磁盘")}</span>
        <span className="ml-auto">{t("保留最近 30 天")}</span>
      </div>
    </section>
  );
}
