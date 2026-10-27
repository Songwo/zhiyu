import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import {
  Activity,
  ArrowUp,
  ArrowUpRight,
  Box,
  Clock,
  Cpu,
  HardDrive,
  Info,
  MemoryStick,
  Network,
  Server,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { hostStats, type HostPoint, type HostSnapshot } from "@/lib/web-bridge";
import "./host-monitor.css";

/* ------------------------------------------------------------------ data */

interface HostState {
  data: HostSnapshot | null;
  error: string;
  loading: boolean;
  subscribers: number;
  timer: ReturnType<typeof setInterval> | null;
}
const useHost = create<HostState>(() => ({
  data: null,
  error: "",
  loading: false,
  subscribers: 0,
  timer: null,
}));

async function pull() {
  if (document.visibilityState !== "visible") return;
  useHost.setState({ loading: true });
  try {
    useHost.setState({ data: await hostStats(), error: "", loading: false });
  } catch (error) {
    useHost.setState({
      error: error instanceof Error ? error.message : String(error),
      loading: false,
    });
  }
}

/** 页面打开时每 5 秒取一次；仪表盘与监控页共用同一份数据，不重复请求。 */
function useHostStats() {
  useEffect(() => {
    const state = useHost.getState();
    if (!state.subscribers) {
      void pull();
      useHost.setState({ timer: setInterval(() => void pull(), 5000) });
    }
    useHost.setState({ subscribers: useHost.getState().subscribers + 1 });
    return () => {
      const next = useHost.getState().subscribers - 1;
      if (!next) {
        const timer = useHost.getState().timer;
        if (timer) clearInterval(timer);
        useHost.setState({ timer: null });
      }
      useHost.setState({ subscribers: next });
    };
  }, []);
  return useHost();
}

/* ------------------------------------------------------------- formatting */

function formatBytes(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.abs(value);
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`;
}
const formatRate = (value: number | null | undefined) =>
  value == null ? "—" : `${formatBytes(value)}/s`;
const formatPercent = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toFixed(1)}%`;

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return t("{0} 天 {1} 小时", days, hours);
  if (hours) return t("{0} 小时 {1} 分钟", hours, minutes);
  return t("{0} 分钟", Math.max(1, minutes));
}
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function tone(percent: number | null | undefined) {
  if (percent == null) return "idle";
  if (percent >= 90) return "crit";
  if (percent >= 75) return "warn";
  return "ok";
}

/* ------------------------------------------------------------------ chart */

interface Series {
  key: keyof HostPoint;
  label: string;
  /** 分类色第 1、2 位，已用调色板校验过浅色与深色两套（见 host-monitor.css）。 */
  color: "a" | "b";
}

/**
 * 单一纵轴的时间序列：一条线时画面积，两条线时画两条细线并带图例。
 * 悬停显示十字线与提示框；不支持悬停的设备仍能读到右上角的最新值。
 */
function TimeChart({
  points,
  series,
  format,
  max,
  label,
}: {
  points: HostPoint[];
  series: Series[];
  format: (value: number | null) => string;
  max?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 600;
  const height = 160;
  const pad = { top: 8, right: 4, bottom: 18, left: 4 };
  const values = points.flatMap((p) => series.map((s) => p[s.key] as number | null));
  const peak = max ?? Math.max(1, ...values.filter((v): v is number => v != null)) * 1.15;
  const x = (i: number) =>
    pad.left +
    (points.length <= 1 ? 0 : (i / (points.length - 1)) * (width - pad.left - pad.right));
  const y = (v: number) =>
    pad.top + (1 - Math.min(v, peak) / peak) * (height - pad.top - pad.bottom);
  const path = (key: keyof HostPoint) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key] as number | null;
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const baseline = height - pad.bottom;
  const area = (key: keyof HostPoint) => {
    const line = path(key);
    if (!line) return "";
    const first = points.findIndex((p) => p[key] != null);
    const last = points.length - 1 - [...points].reverse().findIndex((p) => p[key] != null);
    return `${line}L${x(last).toFixed(1)},${baseline}L${x(first).toFixed(1)},${baseline}Z`;
  };
  const latest = points.at(-1);
  const index = hover ?? null;
  const ticks =
    points.length > 1 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];

  if (points.length < 2)
    return (
      <div className="host-chart-empty" role="status">
        {t("正在收集数据，几秒后出现曲线…")}
      </div>
    );

  return (
    <div className="host-chart">
      {series.length > 1 && (
        <ul className="host-chart-legend" aria-label={t("图例")}>
          {series.map((s) => (
            <li key={String(s.key)}>
              <span className={`host-swatch host-swatch-${s.color}`} aria-hidden="true" />
              {t(s.label)}
              <strong>{format((latest?.[s.key] as number | null) ?? null)}</strong>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={box}
        className="host-chart-plot"
        onPointerMove={(event) => {
          const rect = box.current?.getBoundingClientRect();
          if (!rect) return;
          const ratio = (event.clientX - rect.left) / rect.width;
          setHover(
            Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("{0}，最近 {1} 个采样点", t(label), points.length)}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={pad.left}
              x2={width - pad.right}
              y1={pad.top + f * (baseline - pad.top)}
              y2={pad.top + f * (baseline - pad.top)}
              className="host-grid"
            />
          ))}
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={baseline}
            y2={baseline}
            className="host-axis"
          />
          {series.length === 1 && (
            <path d={area(series[0].key)} className={`host-area host-area-${series[0].color}`} />
          )}
          {series.map((s) => (
            <path
              key={String(s.key)}
              d={path(s.key)}
              className={`host-line host-line-${s.color}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {index !== null && (
            <line
              x1={x(index)}
              x2={x(index)}
              y1={pad.top}
              y2={baseline}
              className="host-crosshair"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {index !== null &&
          series.map((s) => {
            const v = points[index][s.key] as number | null;
            if (v == null) return null;
            return (
              <span
                key={String(s.key)}
                className={`host-dot host-dot-${s.color}`}
                style={{ left: `${(x(index) / width) * 100}%`, top: `${(y(v) / height) * 100}%` }}
              />
            );
          })}
        {index !== null && (
          <div
            className="host-tooltip"
            style={{ left: `${(x(index) / width) * 100}%` }}
            data-side={x(index) > width * 0.6 ? "left" : "right"}
          >
            <span className="host-tooltip-time">{clock(points[index].at)}</span>
            {series.map((s) => (
              <span key={String(s.key)} className="host-tooltip-row">
                <span className={`host-swatch host-swatch-${s.color}`} aria-hidden="true" />
                {t(s.label)}
                <strong>{format((points[index][s.key] as number | null) ?? null)}</strong>
              </span>
            ))}
          </div>
        )}
        <div className="host-chart-ticks" aria-hidden="true">
          {ticks.map((i) => (
            <span key={i}>{clock(points[i].at)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 小卡片里的迷你曲线：只看走势，不带坐标。 */
function Sparkline({ points, field }: { points: HostPoint[]; field: keyof HostPoint }) {
  const data = points.slice(-60).map((p) => p[field] as number | null);
  const known = data.filter((v): v is number => v != null);
  if (known.length < 2) return <span className="host-spark-empty" />;
  const peak = field === "rx" || field === "tx" ? Math.max(1, ...known) * 1.2 : 100;
  const d = data
    .map((v, i) =>
      v == null
        ? ""
        : `${i === 0 || data[i - 1] == null ? "M" : "L"}${((i / (data.length - 1)) * 100).toFixed(1)},${(30 - (Math.min(v, peak) / peak) * 28).toFixed(1)}`,
    )
    .join("");
  return (
    <svg className="host-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* --------------------------------------------------------------- building */

function Meter({ percent }: { percent: number | null | undefined }) {
  return (
    <span className="host-meter" data-tone={tone(percent)} aria-hidden="true">
      <span style={{ transform: `scaleX(${Math.min(100, percent ?? 0) / 100})` }} />
    </span>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  detail,
  percent,
  children,
  onClick,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail?: ReactNode;
  percent?: number | null;
  children?: ReactNode;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={cn("host-kpi", onClick && "host-kpi-link")}
      onClick={onClick}
    >
      <span className="host-kpi-label">
        <Icon aria-hidden="true" />
        {t(label)}
        {onClick && <ArrowUpRight className="host-kpi-arrow" aria-hidden="true" />}
      </span>
      <strong
        className="host-kpi-value"
        data-tone={percent === undefined ? undefined : tone(percent)}
      >
        {value}
      </strong>
      {percent !== undefined && <Meter percent={percent} />}
      {detail && <span className="host-kpi-detail">{detail}</span>}
      {children}
    </Tag>
  );
}

function ScopeNote({ data }: { data: HostSnapshot }) {
  const container = data.info.container;
  const host = data.scope?.procHost;
  let text: string;
  if (!container) text = t("知屿直接运行在这台主机上，看到的是整台机器的数据。");
  else if (host)
    text = t(
      "知屿运行在 {0} 容器里，已挂载宿主机 /proc：CPU、内存、负载、网络与进程都是整台 VPS 的；磁盘为资料目录所在的分区。",
      container,
    );
  else
    text = t(
      "知屿运行在 {0} 容器里，没有挂载宿主机 /proc：CPU、内存、负载与运行时长来自宿主机内核，但网络与进程只含容器自己。在 docker-compose.yml 加上 /proc:/host/proc:ro 后可看到整台 VPS。",
      container,
    );
  return (
    <p className="host-scope" data-partial={Boolean(container && !host)}>
      <Info aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

/** 仪表盘首页顶部的主机脉搏：四张小卡，点开进入主机监控。 */
export function HostPulse() {
  const { data, error } = useHostStats();
  const open = () => useAppStore.getState().setView("host");
  if (error && !data)
    return (
      <p className="host-scope" data-partial="true">
        <Info aria-hidden="true" />
        <span>{t("读取主机状态失败：{0}", error)}</span>
      </p>
    );
  if (data && !data.supported) return null;
  const history = data?.history ?? [];
  const memPercent = data?.memory ? (data.memory.used / data.memory.total) * 100 : null;
  const diskPercent = data?.disk ? (data.disk.used / data.disk.total) * 100 : null;
  return (
    <section className="host-pulse" aria-label={t("本机状态")}>
      <div className="host-pulse-head">
        <h2>
          <Server aria-hidden="true" />
          {data?.info.hostname ?? t("本机")}
          <span>
            {data
              ? t("已运行 {0} · {1} 核", formatDuration(data.uptime), data.info.cores)
              : t("正在读取…")}
          </span>
        </h2>
        <button type="button" className="section-link" onClick={open}>
          {t("主机监控")}
          <ArrowUpRight aria-hidden="true" />
        </button>
      </div>
      <div className="host-kpis">
        <Kpi
          icon={Cpu}
          label="CPU"
          value={formatPercent(data?.cpu?.usage)}
          percent={data?.cpu?.usage ?? null}
          onClick={open}
        >
          <Sparkline points={history} field="cpu" />
        </Kpi>
        <Kpi
          icon={MemoryStick}
          label="内存"
          value={formatPercent(memPercent)}
          percent={memPercent}
          detail={
            data?.memory
              ? `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`
              : undefined
          }
          onClick={open}
        >
          <Sparkline points={history} field="memory" />
        </Kpi>
        <Kpi
          icon={HardDrive}
          label="磁盘"
          value={formatPercent(diskPercent)}
          percent={diskPercent}
          detail={data?.disk ? t("剩余 {0}", formatBytes(data.disk.free)) : undefined}
          onClick={open}
        />
        <Kpi
          icon={Network}
          label="网络"
          value={formatRate(data?.network?.rx)}
          detail={
            <>
              <ArrowUp className="inline size-3" aria-hidden="true" />{" "}
              {t("上传 {0}", formatRate(data?.network?.tx))}
            </>
          }
          onClick={open}
        >
          <Sparkline points={history} field="rx" />
        </Kpi>
      </div>
    </section>
  );
}

/** 「主机监控」页：网页版所在主机的实时状态。 */
export function HostMonitorView() {
  const { data, error } = useHostStats();
  const [procSort, setProcSort] = useState<"cpu" | "memory">("cpu");
  const history = useMemo(() => data?.history ?? [], [data]);

  if (!data)
    return (
      <div className="host-page">
        <p className="host-scope" data-partial={Boolean(error)} role="status">
          <Info aria-hidden="true" />
          <span>{error ? t("读取主机状态失败：{0}", error) : t("正在读取主机状态…")}</span>
        </p>
      </div>
    );
  if (!data.supported)
    return (
      <div className="host-page">
        <p className="host-scope" data-partial="true">
          <Info aria-hidden="true" />
          <span>{data.reason}</span>
        </p>
      </div>
    );

  const memPercent = data.memory ? (data.memory.used / data.memory.total) * 100 : null;
  const diskPercent = data.disk ? (data.disk.used / data.disk.total) * 100 : null;
  const loadPercent = data.load ? (data.load[0] / data.info.cores) * 100 : null;
  const processes = procSort === "cpu" ? data.processes?.byCpu : data.processes?.byMemory;
  const limit = data.cgroup;

  return (
    <div className="host-page page-stagger">
      <ScopeNote data={data} />

      <dl className="host-facts">
        {[
          [Server, "主机名", data.info.hostname ?? t("容器内看不到，挂载 /etc/hostname 后显示")],
          [Box, "系统", data.info.os ?? t("挂载 /etc/os-release 后显示")],
          [Cpu, "处理器", `${data.info.cpuModel ?? "—"} · ${t("{0} 核", data.info.cores)}`],
          [Info, "内核", `${data.info.kernel} · ${data.info.arch}`],
          [Clock, "已运行", formatDuration(data.uptime)],
          [Activity, "进程", data.processes ? String(data.processes.count) : "—"],
        ].map(([Icon, label, value]) => {
          const I = Icon as typeof Cpu;
          return (
            <div key={label as string}>
              <dt>
                <I aria-hidden="true" />
                {t(label as string)}
              </dt>
              <dd title={value as string}>{value as string}</dd>
            </div>
          );
        })}
      </dl>

      <div className="host-kpis host-kpis-5">
        <Kpi
          icon={Cpu}
          label="CPU"
          value={formatPercent(data.cpu?.usage)}
          percent={data.cpu?.usage ?? null}
          detail={
            data.cpu
              ? t(
                  "I/O 等待 {0} · 被宿主占用 {1}",
                  formatPercent(data.cpu.iowait),
                  formatPercent(data.cpu.steal),
                )
              : undefined
          }
        />
        <Kpi
          icon={MemoryStick}
          label="内存"
          value={formatPercent(memPercent)}
          percent={memPercent}
          detail={
            data.memory
              ? `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}${
                  data.memory.swapTotal
                    ? ` · ${t("交换 {0}", formatBytes(data.memory.swapUsed))}`
                    : ""
                }`
              : undefined
          }
        />
        <Kpi
          icon={HardDrive}
          label="磁盘"
          value={formatPercent(diskPercent)}
          percent={diskPercent}
          detail={
            data.disk
              ? `${formatBytes(data.disk.used)} / ${formatBytes(data.disk.total)}`
              : undefined
          }
        />
        <Kpi
          icon={Activity}
          label="负载"
          value={data.load ? data.load[0].toFixed(2) : "—"}
          percent={loadPercent}
          detail={
            data.load
              ? t(
                  "5 分钟 {0} · 15 分钟 {1} · {2} 核",
                  data.load[1].toFixed(2),
                  data.load[2].toFixed(2),
                  data.info.cores,
                )
              : undefined
          }
        />
        <Kpi
          icon={Network}
          label="网络"
          value={formatRate(data.network?.rx)}
          detail={
            <>
              <ArrowUp className="inline size-3" aria-hidden="true" />{" "}
              {t("上传 {0}", formatRate(data.network?.tx))}
            </>
          }
        />
      </div>

      <div className="host-charts">
        <section className="host-card">
          <header>
            <h3>{t("CPU 使用率")}</h3>
            <span>{formatPercent(data.cpu?.usage)}</span>
          </header>
          <TimeChart
            label="CPU 使用率"
            points={history}
            series={[{ key: "cpu", label: "CPU", color: "a" }]}
            format={formatPercent}
            max={100}
          />
        </section>
        <section className="host-card">
          <header>
            <h3>{t("内存使用率")}</h3>
            <span>{formatPercent(memPercent)}</span>
          </header>
          <TimeChart
            label="内存使用率"
            points={history}
            series={[{ key: "memory", label: "内存", color: "a" }]}
            format={formatPercent}
            max={100}
          />
        </section>
        <section className="host-card">
          <header>
            <h3>{t("网络吞吐")}</h3>
            <span>
              {t(
                "合计 ↓ {0} · ↑ {1}",
                formatBytes(data.network?.totalRx),
                formatBytes(data.network?.totalTx),
              )}
            </span>
          </header>
          <TimeChart
            label="网络吞吐"
            points={history}
            series={[
              { key: "rx", label: "下载", color: "a" },
              { key: "tx", label: "上传", color: "b" },
            ]}
            format={formatRate}
          />
        </section>
        <section className="host-card">
          <header>
            <h3>{t("磁盘读写")}</h3>
            <span>
              {t("读 {0} · 写 {1}", formatRate(data.diskIo?.read), formatRate(data.diskIo?.write))}
            </span>
          </header>
          <TimeChart
            label="磁盘读写"
            points={history}
            series={[
              { key: "diskRead", label: "读取", color: "a" },
              { key: "diskWrite", label: "写入", color: "b" },
            ]}
            format={formatRate}
          />
        </section>
      </div>

      <div className="host-columns">
        <section className="host-card">
          <header>
            <h3>{t("占用最多的进程")}</h3>
            <div className="host-toggle" role="group" aria-label={t("排序")}>
              {(["cpu", "memory"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={procSort === key}
                  onClick={() => setProcSort(key)}
                >
                  {key === "cpu" ? "CPU" : t("内存")}
                </button>
              ))}
            </div>
          </header>
          {processes?.length ? (
            <table className="host-table">
              <thead>
                <tr>
                  <th>{t("进程")}</th>
                  <th>PID</th>
                  <th className="num">CPU</th>
                  <th className="num">{t("内存")}</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((p) => (
                  <tr key={p.pid}>
                    <td className="host-table-name" title={p.name}>
                      {p.name}
                    </td>
                    <td className="mono">{p.pid}</td>
                    <td className="num">{formatPercent(p.cpu)}</td>
                    <td className="num">{formatBytes(p.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="host-muted">{t("读不到进程列表。")}</p>
          )}
          {!data.scope?.procHost && data.info.container && (
            <p className="host-muted">{t("这里只有容器内的进程。")}</p>
          )}
        </section>

        <div className="host-stack">
          {limit && (limit.memoryLimit || limit.cpuLimit || data.info.container) && (
            <section className="host-card">
              <header>
                <h3>{t("容器配额")}</h3>
                <span>cgroup v{limit.version}</span>
              </header>
              <dl className="host-pairs">
                <div>
                  <dt>{t("容器内存")}</dt>
                  <dd>
                    {formatBytes(limit.memoryUsed)}
                    {" / "}
                    {limit.memoryLimit ? formatBytes(limit.memoryLimit) : t("不限")}
                  </dd>
                </div>
                <div>
                  <dt>{t("容器 CPU")}</dt>
                  <dd>
                    {formatPercent(limit.cpu)}
                    {" · "}
                    {limit.cpuLimit ? t("上限 {0} 核", limit.cpuLimit) : t("不限")}
                  </dd>
                </div>
              </dl>
              <p className="host-muted">
                {t("容器 CPU 以单核为 100%。没有设置上限时，容器最多可以用满整台机器。")}
              </p>
            </section>
          )}
          <section className="host-card">
            <header>
              <h3>{t("网卡")}</h3>
              <span>{t("开机以来累计")}</span>
            </header>
            {data.network?.interfaces.length ? (
              <table className="host-table">
                <thead>
                  <tr>
                    <th>{t("名称")}</th>
                    <th className="num">{t("下载")}</th>
                    <th className="num">{t("上传")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.network.interfaces.map((nic) => (
                    <tr key={nic.name}>
                      <td className="mono">{nic.name}</td>
                      <td className="num">{formatBytes(nic.rx)}</td>
                      <td className="num">{formatBytes(nic.tx)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="host-muted">{t("没有读到网卡。")}</p>
            )}
          </section>
          {data.service && (
            <section className="host-card">
              <header>
                <h3>{t("知屿服务")}</h3>
                <span>PID {data.service.pid}</span>
              </header>
              <dl className="host-pairs">
                <div>
                  <dt>{t("已运行")}</dt>
                  <dd>{formatDuration(data.service.uptime)}</dd>
                </div>
                <div>
                  <dt>{t("占用内存")}</dt>
                  <dd>{formatBytes(data.service.rss)}</dd>
                </div>
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
