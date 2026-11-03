import { useEffect, useRef, useState, type RefObject } from "react";
import { Sparkles, Square, X } from "lucide-react";
import { desktop } from "@/lib/desktop";
import type { AnalysisConfig, AnalysisResult } from "@/lib/document-analysis";
import type { TaskProgressItem } from "@/lib/task-progress";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { TaskProgress } from "./task-progress";
import "./document-analysis.css";

type Block = { id: string; text: string; element: HTMLElement };
export function DocumentAnalysisPanel({
  documentId,
  revision,
  disabled,
  readerRef,
}: {
  documentId: string;
  revision: string;
  disabled: boolean;
  readerRef: RefObject<HTMLDivElement | null>;
}) {
  const api = desktop()?.documentAnalysis;
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const configRef = useRef<AnalysisConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<TaskProgressItem[]>([]);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [error, setError] = useState("");
  const runId = useRef("");
  const blocks = useRef<Block[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (runId.current) void api?.cancel(runId.current);
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    const load = () => {
      void api
        ?.config()
        .then((value) => {
          if (live) {
            const previous = configRef.current;
            const rules = (settings: AnalysisConfig) =>
              JSON.stringify(settings.rules.map(({ id, description }) => ({ id, description })));
            if (
              previous &&
              ((!value.enabled && previous.enabled) ||
                previous.model !== value.model ||
                rules(previous) !== rules(value))
            ) {
              if (runId.current) void api?.cancel(runId.current);
              runId.current = "";
              setRunning(false);
              setItems([]);
              setResults([]);
            }
            configRef.current = value;
            setConfig(value);
          }
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("zhiyu:analysis-settings", load);
    return () => {
      live = false;
      window.removeEventListener("zhiyu:analysis-settings", load);
    };
  }, [api]);
  useEffect(() => {
    if (runId.current) void api?.cancel(runId.current);
    runId.current = "";
    setResults([]);
    setItems([]);
    setRunning(false);
    setConsent(false);
  }, [api, documentId, revision, disabled]);
  useEffect(() => {
    const root = readerRef.current?.querySelector<HTMLElement>(
      ".document-markdown, .document-prose",
    );
    if (!root || disabled || !config?.enabled) return;
    const original = {
      fontSize: root.style.fontSize,
      lineHeight: root.style.lineHeight,
      maxWidth: root.style.maxWidth,
    };
    root.style.fontSize = `${config.fontSize}px`;
    root.style.lineHeight = String(config.lineHeight);
    root.style.maxWidth = config.width === "wide" ? "none" : "72ch";
    const marked: HTMLElement[] = [];
    if (open && ["highlight", "underline"].includes(config.mode))
      for (const result of results) {
        if (result.confidence < config.threshold) continue;
        const rule = config.rules.find((item) => item.id === result.choice);
        const block = blocks.current.find((item) => item.id === result.id);
        if (
          !rule ||
          !block ||
          !block.element.isConnected ||
          block.element.textContent !== block.text
        )
          continue;
        block.element.dataset.jevRule = rule.id;
        block.element.dataset.jevMode = config.mode;
        marked.push(block.element);
      }
    return () => {
      Object.assign(root.style, original);
      marked.forEach((element) => {
        delete element.dataset.jevRule;
        delete element.dataset.jevMode;
      });
    };
  }, [config, results, open, disabled, readerRef, revision]);
  if (!api || !config?.enabled || disabled) return null;
  const start = async () => {
    if (running) return;
    setError("");
    const root = readerRef.current?.querySelector<HTMLElement>(
      ".document-markdown, .document-prose",
    );
    const elements = [
      ...(root?.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th") ?? []),
    ].filter(
      (element) =>
        !element.closest("pre,code") &&
        !element.querySelector("p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th") &&
        element.textContent?.trim(),
    );
    if (
      !elements.length ||
      elements.length > 50 ||
      elements.some((element) => (element.textContent?.length ?? 0) > 6000)
    ) {
      setError(t("本次支持 1 到 50 段，每段不超过 6000 字；请拆分较长的文档。"));
      return;
    }
    blocks.current = elements.map((element, index) => ({
      id: `block_${index}`,
      text: element.textContent || "",
      element,
    }));
    const id = `jev_${Date.now().toString(36)}`;
    runId.current = id;
    setRunning(true);
    setItems([]);
    setResults([]);
    const off = api.onEvent((event) => {
      if (alive.current && runId.current === event.id) {
        setItems(event.items);
        setResults(event.results);
      }
    });
    try {
      const result = await api.run({
        id,
        blocks: blocks.current.map(({ id, text }) => ({ id, text })),
        allowDocumentContent: consent,
      });
      if (alive.current && runId.current === id) {
        setItems(result.items);
        setResults(result.results);
      }
    } catch (failure) {
      if (alive.current && runId.current === id)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      off();
      if (alive.current && runId.current === id) {
        setRunning(false);
        runId.current = "";
      }
    }
  };
  return (
    <div className="document-ai-panel">
      <style>
        {config.rules
          .map(
            (rule) =>
              `[data-jev-rule="${rule.id}"][data-jev-mode="highlight"]{background:color-mix(in srgb,${rule.color} 20%,transparent);border-radius:4px;box-shadow:-3px 0 ${rule.color};} [data-jev-rule="${rule.id}"][data-jev-mode="underline"]{text-decoration:underline;text-decoration-color:${rule.color};text-decoration-thickness:2px;text-underline-offset:4px;}`,
          )
          .join("\n")}
      </style>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(!open)}>
        <Sparkles className="size-4" />
        {t("Jev 文档提示")}
      </Button>
      {open && (
        <section className="document-ai-body" aria-label={t("Jev 分析面板")}>
          <div className="document-ai-actions">
            <p>{t("逐段分析分类与置信度，不修改原文。")}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("关闭分析面板")}
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>
          <label className="document-ai-consent">
            <input
              type="checkbox"
              disabled={running}
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {t("允许本次将当前文档段落发送给 TypeSafe 分析")}
          </label>
          <div className="document-ai-actions">
            <Button
              type="button"
              size="sm"
              disabled={running || !consent || !config.hasApiKey}
              onClick={() => void start()}
            >
              {t("分析当前文档")}
            </Button>
            {running && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void api.cancel(runId.current)}
              >
                <Square />
                {t("停止分析")}
              </Button>
            )}
          </div>
          {!config.hasApiKey && <p>{t("请先在设置的模型与知识库中保存 Jev API Key。")}</p>}
          {items.length > 0 && (
            <details className="document-ai-progress" open={running}>
              <summary>{running ? t("实时分析进度") : t("查看分析过程")}</summary>
              <TaskProgress items={items} />
            </details>
          )}
          {config.mode !== "off" && results.length > 0 && (
            <ul className="document-ai-results">
              {results
                .filter(
                  (result) => result.choice !== "none" && result.confidence >= config.threshold,
                )
                .map((result) => {
                  const rule = config.rules.find((rule) => rule.id === result.choice);
                  const block = blocks.current.find((block) => block.id === result.id);
                  return (
                    <li key={result.id}>
                      <button
                        type="button"
                        title={rule?.description}
                        onClick={() =>
                          block?.element.scrollIntoView({ behavior: "auto", block: "center" })
                        }
                      >
                        <b>{rule?.label}</b>
                        <span>
                          {t(
                            "第 {0} 段",
                            blocks.current.findIndex((item) => item.id === result.id) + 1,
                          )}
                        </span>
                        <span>{Math.round(result.confidence * 100)}%</span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
    </div>
  );
}
