import { useState } from "react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import {
  containerAlertRule,
  serverStatusWithContainerAlerts,
  type ContainerAlertConfig,
} from "@/lib/server-services";
import type { Server } from "@/lib/types";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";

/** 在最新资产上合并，避免设置面板覆盖同时返回的 SSH 采集结果。 */
export function changeContainerAlerts(
  id: string,
  change: (config: ContainerAlertConfig, server: Server) => ContainerAlertConfig,
) {
  const store = useAppStore.getState(),
    current = store.servers.find((s) => s.id === id);
  if (!current) return;
  const next = { ...current, containerAlerts: change(current.containerAlerts ?? {}, current) };
  store.upsertServer({ ...next, status: serverStatusWithContainerAlerts(next) });
}

export function ContainerAlertSettings({ server, now }: { server: Server; now: number }) {
  const [target, setTarget] = useState("");
  const [minutes, setMinutes] = useState("15");
  const muted = Object.entries(server.containerAlerts?.mutedUntil ?? {}).filter(
    ([, until]) => until > now,
  );
  const containers = server.serviceScan?.docker.containers ?? [];
  return (
    <section className="space-y-3 rounded-xl border border-line p-4" aria-label={t("容器告警设置")}>
      <details>
        <summary className="cursor-pointer text-meta font-semibold">{t("容器告警设置")}</summary>
        <p className="my-3 text-2xs leading-relaxed text-muted">
          {t(
            "重启阈值按 Docker 累计次数判断；确认当前异常可清除历史告警。启动宽限仅适用于运行中容器，重启循环、异常退出和内存不足仍会立即提醒。",
          )}
        </p>
        <Field label={t("规则适用范围")}>
          <Select
            value={target}
            onValueChange={setTarget}
            options={[
              { value: "", label: t("此主机所有容器（默认规则）") },
              ...containers.map((c) => ({ value: c.name, label: c.name })),
            ]}
          />
        </Field>
        <RuleForm
          key={
            target +
            JSON.stringify(
              server.containerAlerts?.overrides?.[target] ?? [
                server.containerAlerts?.restartThreshold,
                server.containerAlerts?.startupGraceSeconds,
              ],
            )
          }
          server={server}
          target={target}
        />
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <Field label={t("维护静音时长")}>
            <Select
              value={minutes}
              onValueChange={setMinutes}
              options={[
                { value: "15", label: t("15 分钟") },
                { value: "60", label: t("1 小时") },
                { value: "240", label: t("4 小时") },
                { value: "1440", label: t("24 小时") },
              ]}
            />
          </Field>
          <Button
            variant="outline"
            disabled={!containers.length}
            onClick={() => {
              changeContainerAlerts(server.id, (config, current) => ({
                ...config,
                mutedUntil: {
                  ...config.mutedUntil,
                  ...Object.fromEntries(
                    (current.serviceScan?.docker.containers ?? [])
                      .filter((c) => !target || c.name === target)
                      .map((c) => [c.name, Date.now() + Number(minutes) * 60000]),
                  ),
                },
              }));
              toast.success(t("已进入维护静音，真实容器状态仍会保留"));
            }}
          >
            {t("进入维护静音")}
          </Button>
        </div>
        <p className="mt-2 text-2xs text-muted">
          {t(
            "维护静音会暂时停止所选容器的全部容器告警，到期自动恢复。不会停止采集，也不执行容器重启。",
          )}
        </p>
      </details>
      {!!muted.length && (
        <ul className="space-y-2 text-2xs text-muted">
          {muted.map(([name, until]) => (
            <li key={name} className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("{0} 静音至 {1}", name, new Date(until).toLocaleString())}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  changeContainerAlerts(server.id, (config) => {
                    const mutedUntil = { ...config.mutedUntil };
                    delete mutedUntil[name];
                    return { ...config, mutedUntil };
                  })
                }
              >
                {t("取消静音")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleForm({ server, target }: { server: Server; target: string }) {
  const rule = containerAlertRule(server.containerAlerts, target);
  const [threshold, setThreshold] = useState(String(rule.restartThreshold));
  const [grace, setGrace] = useState(String(rule.startupGraceSeconds));
  const [error, setError] = useState("");
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const restartThreshold = Number(threshold),
          startupGraceSeconds = Number(grace);
        if (
          !threshold ||
          !grace ||
          !Number.isInteger(restartThreshold) ||
          restartThreshold < 1 ||
          restartThreshold > 10000 ||
          !Number.isInteger(startupGraceSeconds) ||
          startupGraceSeconds < 0 ||
          startupGraceSeconds > 3600
        ) {
          setError(t("重启阈值需为 1–10000，启动宽限需为 0–3600 秒。"));
          return;
        }
        changeContainerAlerts(server.id, (config) =>
          target
            ? {
                ...config,
                overrides: {
                  ...config.overrides,
                  [target]: { restartThreshold, startupGraceSeconds },
                },
              }
            : { ...config, restartThreshold, startupGraceSeconds },
        );
        setError("");
        toast.success(t("容器告警规则已保存"));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("累计重启告警阈值（次）")}>
          <Input
            type="number"
            min={1}
            max={10000}
            step={1}
            required
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>
        <Field label={t("启动宽限（秒）")}>
          <Input
            type="number"
            min={0}
            max={3600}
            step={1}
            required
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-2xs text-crit">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary">
          {t("保存告警规则")}
        </Button>
        {target && (
          <Button
            variant="ghost"
            onClick={() => {
              changeContainerAlerts(server.id, (config) => {
                const overrides = { ...config.overrides };
                delete overrides[target];
                return { ...config, overrides };
              });
              toast.success(t("已恢复此主机默认规则"));
            }}
          >
            {t("恢复主机默认规则")}
          </Button>
        )}
      </div>
    </form>
  );
}
