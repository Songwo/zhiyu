import { hostBridge } from "@/lib/web-bridge";
import { useEffect, useState } from "react";
import { Loader2, Plug, Save, RefreshCw, FilePlus2, Trash2 } from "lucide-react";
import type { ModelConfig, KnowledgeStatus } from "@/lib/agent-client";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/input";
import { AiAccountsPanel } from "./ai-accounts";

export function AgentSettings({
  onConfigChange,
}: {
  onConfigChange?: (config: ModelConfig) => void;
}) {
  const api = hostBridge()?.agent;
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void Promise.all([api.config(), api.knowledge()])
      .then(([c, k]) => {
        if (alive) {
          setConfig(c);
          setKnowledge(k);
        }
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!api) return <p>{t("模型连接与本地知识库仅在桌面端可用。")}</p>;
  if (!config) return <p role="status">{error || t("加载中…")}</p>;
  const patch = (value: Partial<ModelConfig>) => setConfig({ ...config, ...value });
  const PROVIDERS = [
    { value: "https://api.openai.com/v1", label: "OpenAI API" },
    { value: "https://api.x.ai/v1", label: "xAI / Grok API" },
    {
      value: "https://generativelanguage.googleapis.com/v1beta/openai",
      label: "Google / Gemini API",
    },
    { value: "https://api.deepseek.com/v1", label: "DeepSeek" },
    {
      value: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      label: t("阿里云 / 通义千问"),
    },
    { value: "https://ark.cn-beijing.volces.com/api/v3", label: t("火山方舟 / 豆包") },
    { value: "https://znck.zle.ee/v1", label: "znck.zle.ee" },
  ];
  // 下拉框反映当前生效的服务商；非预设地址显示为自定义，便于确认正在用哪家。
  const providerValue = PROVIDERS.some((p) => p.value === config.baseUrl)
    ? config.baseUrl
    : "custom";
  const save = async () => {
    const saved = await api.saveConfig({
      ...config,
      apiKey: key || undefined,
      clearApiKey: clearKey,
    });
    setConfig(saved);
    onConfigChange?.(saved);
    setKey("");
    setClearKey(false);
  };
  return (
    <div className="agent-settings space-y-6">
      <section>
        <h3 className="text-lg font-semibold">{t("模型与知识库")}</h3>
        <p className="mt-2 text-meta text-muted">
          {t("问题、最近对话及命中片段会发送给已配置的模型。资产密钥值和自由备注不参与检索。")}
        </p>
        <fieldset disabled={busy} className="mt-4 space-y-3">
          {config.hasApiKey && config.apiKeyReadable === false && (
            <p
              role="alert"
              className="rounded-md border border-line bg-canvas px-3 py-2 text-meta text-crit"
            >
              {t(
                "已保存的 API Key 在当前环境无法解密（日常数据迁移后常见），请重新输入并保存，否则问答无法连接模型。",
              )}
            </p>
          )}
          <Field label={t("模型服务商")}>
            <Select
              aria-label={t("模型服务商")}
              value={providerValue}
              onValueChange={(value) => {
                if (value && value !== "custom") patch({ baseUrl: value, model: "" });
              }}
              options={[...PROVIDERS, { value: "custom", label: t("自定义地址") }]}
            />
          </Field>
          <Field label="API Base URL">
            <Input
              aria-label="API Base URL"
              value={config.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </Field>
          <Field label={t("模型名称")}>
            {models.length > 0 && (
              <Select
                aria-label={t("选择模型")}
                value={models.includes(config.model) ? config.model : ""}
                onValueChange={(value) => {
                  if (value) patch({ model: value });
                }}
                options={[
                  { value: "", label: t("已加载 {0} 个模型，点击选择", models.length) },
                  ...models.map((model) => ({ value: model, label: model })),
                ]}
              />
            )}
            <Input
              aria-label={t("模型名称")}
              list="agent-models"
              value={config.model}
              placeholder={models.length > 0 ? t("或手动输入模型名") : ""}
              onChange={(e) => patch({ model: e.target.value })}
            />
          </Field>
          <datalist id="agent-models">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <Field label="API Key">
            <Input
              aria-label="API Key"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={config.hasApiKey ? t("已加密保存，留空保留") : t("输入 API Key")}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {config.hasApiKey && (
            <label className="flex items-center gap-2 text-meta">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              {t("清除已保存的 API Key")}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void task(async () => {
                  await save();
                  setNotice(t("模型配置已保存"));
                })
              }
            >
              <Save className="size-4" />
              {t("保存配置")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void task(async () => {
                  await save();
                  const loaded = await api.models();
                  setModels(loaded);
                  setNotice(t("已加载 {0} 个模型，可在模型名称下拉框选择。", loaded.length));
                })
              }
            >
              <RefreshCw className="size-4" />
              {t("读取模型")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void task(async () => {
                  await save();
                  const result = await api.test();
                  setNotice(
                    `${t("真实模型连接成功")} · ${result.model} · ${result.latencyMs} ms\n${result.text}`,
                  );
                })
              }
            >
              <Plug className="size-4" />
              {t("测试连接")}
            </Button>
          </div>
          <div className="agent-settings-numbers">
            {(
              [
                ["topK", "检索片段数", 1, 12],
                ["maxSteps", "工具调用轮数", 1, 6],
                ["maxTokens", "输出 Token 上限", 256, 8192],
              ] as const
            ).map(([field, label, min, max]) => (
              <Field key={field} label={t(label)}>
                <Input
                  type="number"
                  aria-label={t(label)}
                  min={min}
                  max={max}
                  value={config[field]}
                  onChange={(e) => patch({ [field]: Number(e.target.value) })}
                />
              </Field>
            ))}
          </div>
          <label className="flex items-center gap-2 text-meta">
            <input
              type="checkbox"
              checked={config.embeddingEnabled}
              onChange={(e) => patch({ embeddingEnabled: e.target.checked })}
            />
            {t("本地向量混合检索")}
          </label>
          {config.embeddingEnabled && (
            <>
              <Field label={t("本地 Embedding 地址")}>
                <Input
                  aria-label={t("本地 Embedding 地址")}
                  value={config.embeddingBaseUrl}
                  onChange={(e) => patch({ embeddingBaseUrl: e.target.value })}
                />
              </Field>
              <Field label={t("Embedding 模型")}>
                <Input
                  aria-label={t("Embedding 模型")}
                  value={config.embeddingModel}
                  onChange={(e) => patch({ embeddingModel: e.target.value })}
                />
              </Field>
            </>
          )}
        </fieldset>
      </section>
      <section className="border-t border-line pt-4">
        <h4 className="font-semibold">{t("本地知识库")}</h4>
        <p className="my-2 text-meta text-muted">
          {t(
            "{0} 项资产 · {1} 份文档 · {2} 个片段",
            knowledge?.assets ?? 0,
            knowledge?.documents.length ?? 0,
            knowledge?.chunks ?? 0,
          )}
        </p>
        <p className="mb-3 text-2xs text-subtle">
          {t("导入的文档内容会参与模型问答，请勿导入密码或密钥。支持 TXT、Markdown。")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void task(async () => {
                const result = await api.importDocument();
                if (result) setKnowledge(result);
              })
            }
          >
            <FilePlus2 className="size-4" />
            {t("导入知识文档")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void task(async () => {
                await save();
                setKnowledge(await api.rebuild());
                setNotice(t("本地索引已重建"));
              })
            }
          >
            <RefreshCw className="size-4" />
            {t("重建索引")}
          </Button>
        </div>
        <ul className="mt-3 divide-y divide-line">
          {knowledge?.documents.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 break-words text-meta">
                {doc.name}
                <small className="block text-subtle">
                  {doc.characters} {t("字符")}
                </small>
              </span>
              <Button
                disabled={busy}
                size="icon-sm"
                variant="ghost"
                aria-label={t("移除知识文档")}
                title={t("移除知识文档")}
                onClick={() =>
                  void task(async () => {
                    setKnowledge(await api.removeDocument(doc.id));
                  })
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <AiAccountsPanel />
      {busy && (
        <p role="status" className="flex items-center gap-2 text-meta">
          <Loader2 className="size-4 animate-spin" />
          {t("处理中…")}
        </p>
      )}
      {notice && (
        <p role="status" className="whitespace-pre-wrap break-words text-meta text-ok">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-meta text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
