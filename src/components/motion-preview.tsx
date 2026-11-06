import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CreditCard,
  Cpu,
  FileText,
  Link2,
  Mail,
  RotateCcw,
  Server,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { useMotionPolicy, useMotionPreset } from "@/lib/motion";
import type { TaskProgressItem } from "@/lib/task-progress";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { TaskProgress } from "./task-progress";
import "./document-analysis.css";

type Scene = "relations" | "card" | "progress";

/** 纯本地交互示例，不读取资产，也不调用 Exa、模型或服务器。 */
export function MotionPreview() {
  const [scene, setScene] = useState<Scene>("relations");
  const [expanded, setExpanded] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [steps, setSteps] = useState<TaskProgressItem[]>([]);
  const [playing, setPlaying] = useState(false);
  const runId = useRef(0);
  const group = useId();
  const mode = useMotionPolicy();
  const animation = useMotionPreset();
  const transition =
    mode === "full"
      ? { type: "spring" as const, duration: 0.36, bounce: 0 }
      : { duration: mode === "off" ? 0 : 0.12 };

  useEffect(() => {
    if (!playing) return;
    const run = ++runId.current;
    const labels = [t("读取演示资产"), t("查找已保存的关联"), t("整理关联路径")];
    let index = 0;
    const advance = () => {
      if (runId.current !== run) return;
      const now = Date.now();
      const stepIndex = index;
      setSteps((current) => [
        ...current.map((item) =>
          item.status === "running" ? { ...item, status: "done" as const, endedAt: now } : item,
        ),
        ...(stepIndex < labels.length
          ? [
              {
                id: `${run}:${stepIndex}`,
                label: labels[stepIndex],
                status: "running" as const,
                startedAt: now,
              },
            ]
          : []),
      ]);
      index += 1;
      if (index > labels.length) setPlaying(false);
    };
    advance();
    const timer = window.setInterval(advance, 850);
    return () => {
      runId.current += 1;
      window.clearInterval(timer);
    };
  }, [playing]);

  const changeScene = (next: Scene) => {
    setScene(next);
    setExpanded(false);
    setFlipped(false);
    setPlaying(false);
    setSteps([]);
  };

  return (
    <div className="motion-preview">
      <p className="motion-preview-note">
        {t("仅演示界面效果，不读取私人资产，不消耗检索或模型额度。")}
      </p>
      <div className="motion-preview-tabs" role="group" aria-label={t("选择动效示例")}>
        {(
          [
            ["relations", "关联展开"],
            ["card", "卡片翻转"],
            ["progress", "任务进度"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={scene === id ? "outline" : "ghost"}
            aria-pressed={scene === id}
            onClick={() => changeScene(id)}
          >
            {t(label)}
          </Button>
        ))}
      </div>
      <LayoutGroup id={group}>
        <div className="motion-preview-stage" data-scene={scene}>
          {scene === "relations" && (
            <AnimatePresence initial={false} mode="popLayout">
              {expanded ? (
                <m.div
                  key="detail"
                  className="motion-demo-detail"
                  {...animation}
                  exit={{ opacity: 0 }}
                  transition={transition}
                >
                  <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
                    <ArrowLeft className="size-3.5" />
                    {t("返回示例")}
                  </Button>
                  <m.div
                    layoutId="demo-asset"
                    className="motion-demo-asset"
                    transition={transition}
                  >
                    <span className="motion-demo-icon">
                      <Server />
                    </span>
                    <div>
                      <strong>{t("演示主机")}</strong>
                      <small>{t("邮箱、账号与文档彼此相连")}</small>
                    </div>
                    <ShieldCheck className="motion-demo-check" />
                  </m.div>
                  <div className="motion-demo-relations">
                    <span>
                      <Mail />
                      {t("演示邮箱")}
                    </span>
                    <Link2 />
                    <span>
                      <FileText />
                      {t("部署文档")}
                    </span>
                  </div>
                </m.div>
              ) : (
                <m.button
                  key="asset"
                  type="button"
                  className="motion-demo-asset motion-demo-open"
                  layoutId="demo-asset"
                  onClick={() => setExpanded(true)}
                  transition={transition}
                >
                  <span className="motion-demo-icon">
                    <Server />
                  </span>
                  <div>
                    <strong>{t("演示主机")}</strong>
                    <small>{t("点击展开关联")}</small>
                  </div>
                  <ArrowUpRight className="motion-demo-arrow" />
                </m.button>
              )}
            </AnimatePresence>
          )}
          {scene === "card" && (
            <div className="motion-demo-card-scene">
              <button
                className="motion-demo-flip"
                type="button"
                aria-pressed={flipped}
                aria-label={t("翻转示例卡片")}
                onClick={() => setFlipped(!flipped)}
              >
                <m.span
                  className="motion-demo-card-object"
                  animate={{ rotateY: flipped ? 180 : 0 }}
                  transition={
                    mode === "full"
                      ? { type: "spring", duration: 0.65, bounce: 0 }
                      : { duration: 0 }
                  }
                >
                  <span className="motion-demo-card-front" aria-hidden={flipped}>
                    <span className="motion-demo-card-brand">
                      <CreditCard />
                      {t("知屿示例卡")}
                    </span>
                    <span className="motion-demo-card-chip">
                      <Cpu />
                      <Wifi />
                    </span>
                    <span className="motion-demo-card-number">•••• •••• •••• 2026</span>
                    <span className="motion-demo-card-caption">
                      {t("虚拟卡 · 仅供演示")}
                      <span>12 / 29</span>
                    </span>
                  </span>
                  <span className="motion-demo-card-back" aria-hidden={!flipped}>
                    <span className="motion-demo-stripe" />
                    <ShieldCheck className="size-7" />
                    <strong>{t("敏感信息解锁后查看")}</strong>
                    <small>{t("此示例不包含真实卡号与安全码")}</small>
                  </span>
                </m.span>
              </button>
              <p className="motion-demo-caption">
                <RotateCcw className="size-3.5" />
                {t("点击卡片查看正反面")}
              </p>
            </div>
          )}
          {scene === "progress" && (
            <m.div className="motion-demo-task" {...animation}>
              <div className="motion-demo-task-heading">
                <span className="motion-demo-icon">
                  <Link2 />
                </span>
                <strong>{t("关联路径整理")}</strong>
              </div>
              <TaskProgress items={steps} />
              {steps.length === 0 && (
                <p className="motion-demo-caption">
                  {t("每一步根据状态衔接，已有条目不会反复入场。")}
                </p>
              )}
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                disabled={playing}
                onClick={() => {
                  setSteps([]);
                  setPlaying(true);
                }}
              >
                {steps.length > 0 && !playing ? (
                  <RotateCcw className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {playing ? t("演示进行中…") : t("播放步骤演示")}
              </Button>
            </m.div>
          )}
        </div>
      </LayoutGroup>
      <p className="motion-preview-note">
        {mode === "full"
          ? t("当前：完整动效")
          : mode === "reduced"
            ? t("当前：轻量动效，仅保留淡入淡出")
            : t("当前：已关闭动效")}
      </p>
    </div>
  );
}
