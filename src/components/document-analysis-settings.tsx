import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { hostBridge } from "@/lib/web-bridge";
import type { AnalysisConfig } from "@/lib/document-analysis";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/input";
import "./document-analysis.css";

export function DocumentAnalysisSettings() {
  const api = hostBridge()?.documentAnalysis;
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    void api
      ?.config()
      .then((value) => {
        if (alive) setConfig(value);
      })
      .catch((error) => {
        if (alive) setNotice(error.message);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  if (!api) return null;
  const patch = (value: Partial<AnalysisConfig>) =>
    setConfig((previous) => (previous ? { ...previous, ...value } : previous));
  return (
    <section className="document-ai-settings space-y-4">
      <h3 className="text-lg font-semibold">{t("Jev 文档提示")}</h3>
      <p className="text-meta text-muted">
        {t("使用自己的 TypeSafe API Key，按段分类并显示提示；每次手动分析才发送选定段落。")}
      </p>
      {config && (
        <fieldset disabled={busy} className="space-y-3">
          <label className="flex items-center gap-2 text-meta">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            {t("启用 Jev 文档分析")}
          </label>
          <Field label={t("Jev API Key")}>
            <Input
              aria-label={t("Jev API Key")}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={config.hasApiKey ? t("已保存，留空保持") : t("输入 TypeSafe API Key")}
            />
          </Field>
          {config.apiKeyReadable === false && (
            <p role="alert">{t("Jev 密钥在此电脑无法解密，请重新保存。")}</p>
          )}
          {config.hasApiKey && (
            <label className="flex items-center gap-2 text-meta">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              {t("移除已保存的 Jev 密钥")}
            </label>
          )}
          <Field label={t("Jev 模型")}>
            <Input
              aria-label={t("Jev 模型")}
              value={config.model}
              onChange={(event) => patch({ model: event.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("提示显示方式")}>
              <Select
                aria-label={t("提示显示方式")}
                value={config.mode}
                onValueChange={(mode) => patch({ mode: mode as AnalysisConfig["mode"] })}
                options={[
                  { value: "highlight", label: t("段落高亮") },
                  { value: "underline", label: t("文字下划线") },
                  { value: "sidebar", label: t("仅显示分析条目") },
                  { value: "off", label: t("不显示标记") },
                ]}
              />
            </Field>
            <Field label={t("最低置信度")}>
              <Input
                aria-label={t("最低置信度")}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={config.threshold}
                onChange={(event) => patch({ threshold: Number(event.target.value) })}
              />
            </Field>
            <Field label={t("阅读字号")}>
              <Select
                aria-label={t("阅读字号")}
                value={String(config.fontSize)}
                onValueChange={(value) => patch({ fontSize: Number(value) })}
                options={[14, 16, 18, 20].map((value) => ({
                  value: String(value),
                  label: `${value}px`,
                }))}
              />
            </Field>
            <Field label={t("阅读行距")}>
              <Select
                aria-label={t("阅读行距")}
                value={String(config.lineHeight)}
                onValueChange={(value) => patch({ lineHeight: Number(value) })}
                options={[1.5, 1.8, 2.1].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
              />
            </Field>
          </div>
          <Field label={t("阅读宽度")}>
            <Select
              aria-label={t("阅读宽度")}
              value={config.width}
              onValueChange={(value) => patch({ width: value as AnalysisConfig["width"] })}
              options={[
                { value: "comfortable", label: t("舒适宽度") },
                { value: "wide", label: t("宽屏阅读") },
              ]}
            />
          </Field>
          <div className="space-y-3">
            {config.rules.map((rule, index) => (
              <div key={rule.id} className="document-ai-rule">
                <Input
                  aria-label={t("规则名称 {0}", index + 1)}
                  value={rule.label}
                  maxLength={40}
                  onChange={(event) =>
                    patch({
                      rules: config.rules.map((item) =>
                        item.id === rule.id ? { ...item, label: event.target.value } : item,
                      ),
                    })
                  }
                />
                <input
                  type="color"
                  aria-label={t("规则颜色 {0}", index + 1)}
                  value={rule.color}
                  onChange={(event) =>
                    patch({
                      rules: config.rules.map((item) =>
                        item.id === rule.id ? { ...item, color: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("删除规则 {0}", index + 1)}
                  disabled={config.rules.length <= 1}
                  onClick={() =>
                    patch({ rules: config.rules.filter((item) => item.id !== rule.id) })
                  }
                >
                  <Trash2 />
                </Button>
                <Textarea
                  aria-label={t("分类说明 {0}", index + 1)}
                  className="sm:col-span-3"
                  value={rule.description}
                  maxLength={1000}
                  onChange={(event) =>
                    patch({
                      rules: config.rules.map((item) =>
                        item.id === rule.id ? { ...item, description: event.target.value } : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={config.rules.length >= 8}
              onClick={() =>
                patch({
                  rules: [
                    ...config.rules,
                    {
                      id: `rule_${Date.now().toString(36)}`,
                      label: t("自定义分类"),
                      description: t("需要关注的文档信息"),
                      color: "#428cbd",
                    },
                  ],
                })
              }
            >
              <Plus />
              {t("添加分类规则")}
            </Button>
          </div>
          <Button
            type="button"
            onClick={async () => {
              setBusy(true);
              setNotice("");
              try {
                const saved = await api.saveConfig({
                  ...config,
                  ...(key ? { apiKey: key } : {}),
                  clearApiKey: clearKey,
                });
                setConfig(saved);
                setKey("");
                setClearKey(false);
                window.dispatchEvent(new Event("zhiyu:analysis-settings"));
                setNotice(t("Jev 设置已保存"));
              } catch (error) {
                setNotice(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Save />
            {t("保存 Jev 设置")}
          </Button>
        </fieldset>
      )}
      {notice && (
        <p role="status" className="text-meta">
          {notice}
        </p>
      )}
    </section>
  );
}
