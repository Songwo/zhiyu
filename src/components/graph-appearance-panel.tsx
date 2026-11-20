import { useEffect, useId, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Palette, RotateCcw, X } from "lucide-react";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { useSettings } from "@/lib/settings";
import {
  normalizeGraphAppearance,
  validGraphColor,
  RELATION_COLOR_LABELS,
  RESOURCE_COLOR_LABELS,
  type GraphAppearance,
} from "@/lib/graph-appearance";
import { t } from "@/lib/i18n";

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const id = useId();
  return (
    <div className="graph-color-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="color"
        value={value}
        aria-label={t("选择{0}颜色", label)}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        type="text"
        value={draft}
        maxLength={7}
        aria-label={t("{0}颜色代码", label)}
        spellCheck={false}
        aria-invalid={!validGraphColor(draft)}
        onChange={(event) => {
          setDraft(event.target.value);
          if (validGraphColor(event.target.value)) onChange(event.target.value);
        }}
        onBlur={() => {
          if (!validGraphColor(draft)) setDraft(value);
        }}
      />
    </div>
  );
}
export function GraphAppearancePanel({
  open,
  onOpenChange,
  portalContainer,
  selected,
  onClearSelection,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  portalContainer?: HTMLElement | null;
  selected: { id: string; label: string; color: string } | null;
  onClearSelection: () => void;
}) {
  const appearance = useSettings((state) => state.graphAppearance);
  const setAppearance = useSettings((state) => state.setGraphAppearance);
  const patch = (value: Partial<GraphAppearance>) => setAppearance({ ...appearance, ...value });
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          size="icon-sm"
          variant={open ? "secondary" : "ghost"}
          aria-label={t("连线配色")}
          title={t("连线配色")}
        >
          <Palette className="size-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          className="graph-appearance-panel"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t("连线显示设置")}
        >
          <header>
            <h2>{t("连线显示设置")}</h2>
            <Popover.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t("关闭配色设置")}>
                <X />
              </Button>
            </Popover.Close>
          </header>
          {selected && (
            <section className="graph-selected-color">
              <div>
                <b>{t("当前连线")}</b>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("取消连线选择")}
                  onClick={onClearSelection}
                >
                  <X />
                </Button>
              </div>
              <p>{selected.label}</p>
              <ColorField
                label={t("单条连线")}
                value={selected.color}
                onChange={(color) =>
                  patch({ overrides: { ...appearance.overrides, [selected.id]: color } })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={!appearance.overrides[selected.id]}
                onClick={() => {
                  const overrides = { ...appearance.overrides };
                  delete overrides[selected.id];
                  patch({ overrides });
                }}
              >
                {t("此连线跟随分组配色")}
              </Button>
            </section>
          )}
          <label className="graph-appearance-mode">
            <span>{t("配色依据")}</span>
            <Select
              aria-label={t("配色依据")}
              portalContainer={portalContainer}
              value={appearance.mode}
              onValueChange={(mode) => patch({ mode: mode as GraphAppearance["mode"] })}
              options={[
                { value: "relation", label: t("按关联类型") },
                { value: "resource", label: t("按起始资源类型") },
                { value: "monochrome", label: t("统一颜色") },
              ]}
            />
          </label>
          <div className="graph-palette-fields">
            {appearance.mode === "monochrome" ? (
              <ColorField
                label={t("全部关联")}
                value={appearance.singleColor}
                onChange={(singleColor) => patch({ singleColor })}
              />
            ) : appearance.mode === "relation" ? (
              Object.entries(RELATION_COLOR_LABELS).map(([key, label]) => (
                <ColorField
                  key={key}
                  label={t(label)}
                  value={appearance.relationColors[key as keyof typeof RELATION_COLOR_LABELS]}
                  onChange={(color) =>
                    patch({ relationColors: { ...appearance.relationColors, [key]: color } })
                  }
                />
              ))
            ) : (
              Object.entries(RESOURCE_COLOR_LABELS).map(([key, label]) => (
                <ColorField
                  key={key}
                  label={t(label)}
                  value={appearance.resourceColors[key as keyof typeof RESOURCE_COLOR_LABELS]}
                  onChange={(color) =>
                    patch({ resourceColors: { ...appearance.resourceColors, [key]: color } })
                  }
                />
              ))
            )}
          </div>
          <label className="graph-line-width">
            <span>
              {t("连线粗细")}
              <small>{appearance.width.toFixed(1)} px</small>
            </span>
            <input
              type="range"
              aria-label={t("连线粗细")}
              min="1"
              max="5"
              step="0.2"
              value={appearance.width}
              onChange={(event) => patch({ width: Number(event.target.value) })}
            />
          </label>
          <label className="graph-legend-toggle">
            <input
              type="checkbox"
              checked={appearance.showLegend}
              onChange={(event) => patch({ showLegend: event.target.checked })}
            />
            {t("显示配色图例")}
          </label>
          <label className="graph-legend-toggle graph-pulse-toggle">
            <input
              type="checkbox"
              checked={appearance.pulseSelection}
              onChange={(event) => patch({ pulseSelection: event.target.checked })}
            />
            {t("选中资产动态高亮")}
          </label>
          <p className="graph-appearance-hint">
            {t(
              "单击连线高亮两端资产，双击连线或打开配色面板可单独改色。减少动态效果时使用静态高亮。",
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setAppearance(normalizeGraphAppearance(null))}
          >
            <RotateCcw />
            {t("恢复默认配色")}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
