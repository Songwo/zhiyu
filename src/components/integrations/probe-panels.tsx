import { lazy, Suspense, useState } from "react";
import { Copy } from "lucide-react";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { ProbeCheckInput, ProbeHost } from "@/lib/integrations";
import { Button } from "../ui/button";
import { EditorDialog } from "../ui/editor-dialog";
import { Field, Input, Select } from "../ui/input";
import { bytesText, dateText, errorText, numberText } from "./data";
import { ResourceStatus } from "./common";

const ProbeHistory = lazy(() => import("./probe-history"));
const CheckHistory = lazy(() => import("./check-history"));

export function ProbeCheckHistory(props: {
  connectionId: string;
  checkId: string;
  intervalSeconds: number;
  updatedAt?: string;
}) {
  return (
    <Suspense fallback={<p className="integration-empty">{t("正在加载…")}</p>}>
      <CheckHistory {...props} />
    </Suspense>
  );
}

export function ProbeHostPanel({
  connectionId,
  host,
  updatedAt,
}: {
  connectionId: string;
  host: ProbeHost;
  updatedAt?: string;
}) {
  const sample = host.latest;
  const metrics = [
    ["CPU", numberText(sample?.cpu, "%")],
    [t("内存"), numberText(sample?.memory, "%")],
    [t("磁盘"), numberText(sample?.disk, "%")],
    [t("下载速率"), sample?.rxRate == null ? "—" : `${bytesText(sample.rxRate)}/s`],
    [t("上传速率"), sample?.txRate == null ? "—" : `${bytesText(sample.txRate)}/s`],
    [
      t("累计流量"),
      sample?.networkRx == null || sample?.networkTx == null
        ? "—"
        : bytesText(sample.networkRx + sample.networkTx),
    ],
    ["Swap", numberText(sample?.swap, "%")],
    [t("运行时间"), sample?.uptime == null ? "—" : t("{0} 小时", numberText(sample.uptime / 3600))],
    [
      t("负载（1 / 5 / 15 分钟）"),
      [sample?.load1, sample?.load5, sample?.load15].map((value) => numberText(value)).join(" / "),
    ],
    [t("TCP / UDP 连接"), `${numberText(sample?.tcp)} / ${numberText(sample?.udp)}`],
    [t("进程数"), numberText(sample?.processes)],
    [t("温度 / GPU"), `${numberText(sample?.temperature, "°C")} / ${numberText(sample?.gpu, "%")}`],
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <ResourceStatus status={host.status} />
        <span className="text-2xs text-muted">
          {[host.hostname, host.os, host.arch].filter(Boolean).join(" · ")}
        </span>
      </div>
      <p className="text-2xs text-muted">
        {host.status === "online"
          ? t("最近上报：{0}", dateText(host.lastSeen))
          : t("最后已知指标：{0}；当前没有实时上报", dateText(host.lastSeen))}
      </p>
      <div className="integration-metrics">
        {metrics.map(([label, value]) => (
          <div key={label} className="integration-metric">
            <p className="text-2xs text-muted">{label}</p>
            <p className="mt-1 break-words font-mono text-meta">{value}</p>
          </div>
        ))}
      </div>
      <Suspense fallback={<p className="integration-empty">{t("正在加载…")}</p>}>
        <ProbeHistory connectionId={connectionId} hostId={host.id} updatedAt={updatedAt} />
      </Suspense>
    </div>
  );
}

export function ConfirmAction({
  title,
  description,
  action,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  action: () => Promise<unknown>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <EditorDialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="integration-form">
        <p className="text-meta leading-relaxed text-muted">{description}</p>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await action();
                onDone();
              } catch (reason) {
                setError(errorText(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("确认")}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}

export function ProbeEnrollment({
  connectionId,
  onClose,
  onDone,
}: {
  connectionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [credential, setCredential] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <EditorDialog
      title={t("注册探针主机")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="integration-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            setCredential(await desktop()!.integrations.probeEnroll(connectionId, name.trim()));
            onDone();
          } catch (reason) {
            setError(errorText(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        {credential ? (
          <>
            <p className="text-meta text-muted">
              {t("凭据仅显示一次。请保存到服务器的 Agent 配置中；关闭后无法再次读取。")}
            </p>
            <Field label="client-uuid">
              <Input aria-label="client-uuid" value={credential.id} readOnly />
            </Field>
            <Field label="client-secret">
              <Input
                aria-label="client-secret"
                value={credential.secret}
                readOnly
                autoComplete="off"
              />
            </Field>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify({ id: credential.id, secret: credential.secret }, null, 2),
                  );
                  setCopied(true);
                } catch (reason) {
                  setError(errorText(reason));
                }
              }}
            >
              <Copy />
              {copied ? t("已复制") : t("复制 Agent 凭据")}
            </Button>
            <Button onClick={onClose}>{t("已保存，关闭")}</Button>
          </>
        ) : (
          <>
            <p className="text-meta text-muted">
              {t("每台主机使用独立凭据，撤销后将立即停止接收上报。")}
            </p>
            <Field label={t("主机名称")}>
              <Input
                aria-label={t("主机名称")}
                required
                maxLength={160}
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !name.trim()}>
              {t("生成主机凭据")}
            </Button>
          </>
        )}
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </EditorDialog>
  );
}

export function CheckEditor({
  connectionId,
  initial,
  onClose,
  onDone,
}: {
  connectionId: string;
  initial?: ProbeCheckInput;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState<ProbeCheckInput>(
    initial
      ? { ...initial }
      : { name: "", type: "http", target: "", intervalSeconds: 60, timeoutMs: 5000 },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <EditorDialog
      title={initial ? t("编辑服务检查") : t("新增服务检查")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="integration-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await desktop()!.integrations.probeSaveCheck(connectionId, {
              id: value.id,
              name: value.name.trim(),
              type: value.type,
              target: value.target.trim(),
              intervalSeconds: value.intervalSeconds,
              timeoutMs: value.timeoutMs,
            });
            onDone();
          } catch (reason) {
            setError(errorText(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-meta text-muted">
          {t("检查由常驻监控服务端执行，关闭知屿后仍持续运行。")}
        </p>
        <Field label={t("检查名称")}>
          <Input
            aria-label={t("检查名称")}
            required
            maxLength={160}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </Field>
        <Field label={t("检查协议")}>
          <Select
            aria-label={t("检查协议")}
            value={value.type}
            options={[
              { value: "http", label: "HTTP / HTTPS" },
              { value: "tcp", label: "TCP" },
            ]}
            onValueChange={(type) => setValue({ ...value, type: type as "http" | "tcp" })}
          />
        </Field>
        <p className="text-2xs text-muted">
          {t("检查间隔为 10–3600 秒；超时为 100–30000 毫秒，且不能超过检查间隔。")}
        </p>
        <Field label={t("检查目标")}>
          <Input
            aria-label={t("检查目标")}
            required
            value={value.target}
            placeholder={value.type === "http" ? "https://example.com/health" : "example.com:443"}
            onChange={(event) => setValue({ ...value, target: event.target.value })}
          />
        </Field>
        <div className="integration-form-grid">
          <Field label={t("检查间隔（秒）")}>
            <Input
              aria-label={t("检查间隔（秒）")}
              type="number"
              min={10}
              max={3600}
              required
              value={value.intervalSeconds}
              onChange={(event) =>
                setValue({ ...value, intervalSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label={t("超时（毫秒）")}>
            <Input
              aria-label={t("超时（毫秒）")}
              type="number"
              min={100}
              max={Math.min(30000, value.intervalSeconds * 1000)}
              required
              value={value.timeoutMs}
              onChange={(event) => setValue({ ...value, timeoutMs: Number(event.target.value) })}
            />
          </Field>
        </div>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={busy}>
            {t("保存检查")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}
