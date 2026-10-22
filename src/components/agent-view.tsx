import {
  ArrowUp,
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  Lock,
  MessageSquarePlus,
  PanelRightOpen,
  Search,
  Trash2,
  FileText,
  ArrowUpRight,
  ShieldCheck,
  SquareTerminal,
  Square,
  Settings2,
  Loader2,
  RotateCcw,
  WandSparkles,
  Check,
  PencilLine,
  Link2,
  Activity,
  CalendarCheck,
  CalendarClock,
  MessageCircleQuestion,
  NotebookPen,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { renewalCalendar } from "../../electron/services/renewals.mjs";
import { toast } from "sonner";
import { EditorDialog } from "./ui/editor-dialog";
import {
  continuationRequest,
  modelHistory,
  retryRequest,
  workspaceAccessOptions,
} from "@/lib/agent-retry.mjs";
import { usePresence } from "@/lib/motion";
import { useDocuments } from "@/lib/documents";
import "./agent-workspace.css";
import { LogoMark } from "./logo";
import { Button } from "./ui/button";
import { TimeAgo } from "./ui/time-ago";
import { type Block, type SecretField } from "@/lib/agent";
import { AgentSettings } from "./agent-settings";
import { Markdown } from "./markdown";
import type { Source, WorkspaceProposal, WorkspaceAccessRequest } from "@/lib/agent-client";
import { useConversations, type Message } from "@/lib/conversations";
import { accountId, credentialId, desktop } from "@/lib/desktop";
import { attentionOf, chipClass, dotClass, KIND_LABEL } from "@/lib/status";
import { assetEntries } from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import { mergeSnapshotChange } from "@/lib/snapshot-merge";
import type { AssetKind } from "@/lib/types";
import { copyText } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";

const toolLabel = (name: string) =>
  t(
    {
      search_knowledge: "本地检索",
      get_asset: "查询资产",
      search_documents: "检索文档",
      get_document: "读取文档",
      get_related_resources: "查询关联资源",
      locate_credential: "定位凭据",
      check_mailbox: "检查邮箱",
      list_mail_folders: "查询邮箱分组",
      list_mailboxes: "查询邮箱账号",
      asset_summary: "资产统计",
      propose_document_edit: "建议修改文档",
      propose_document_rename: "建议文档改名",
      request_workspace_access: "请求本次权限",
      propose_account_edit: "建议修改账号",
      propose_asset_link: "建议关联资产",
      propose_document_binding: "建议关联文档",
      propose_asset_update: "建议修改资产",
      propose_document_create: "建议新建文档",
      list_renewals: "续费与费用",
      suggest_next_steps: "下一步建议",
    }[name] ?? name,
  );

/** 本机执行检索和提案校验，修改只有在用户审阅后才会应用。 */
export function AgentView() {
  const conversations = useConversations((s) => s.conversations);
  const activeId = useConversations((s) => s.activeId);
  const hydrated = useConversations((s) => s.hydrated);
  const append = useConversations((s) => s.append);
  const start = useConversations((s) => s.start);
  const [draft, setDraft] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [model, setModel] = useState("");
  const [allowMailboxChecks, setAllowMailboxChecks] = useState(false);
  const [allowDocumentContent, setAllowDocumentContent] = useState(false);
  const [allowWorkspaceChanges, setAllowWorkspaceChanges] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const capabilities = usePresence(capabilitiesOpen && !configOpen, 200);
  const [contextOpen, setContextOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requireVault = useVault((state) => state.require);
  const [running, setRunning] = useState<{
    id: string;
    conversationId: string;
    text: string;
    phase: string;
    tools: string[];
    sources: Source[];
  } | null>(null);
  const runRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const api = desktop()?.agent;
  const messagesRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const busy = Boolean(running) || preparing || !hydrated;

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messages = active?.messages ?? [];
  // 长对话窗口化渲染：只挂载最近的消息，更早的按需展开，避免全量重渲。
  const [visibleCount, setVisibleCount] = useState(40);
  useEffect(() => {
    setVisibleCount(40);
    setDraft("");
    setError("");
    setAllowMailboxChecks(false);
    setAllowDocumentContent(false);
    setAllowWorkspaceChanges(false);
    followBottom.current = true;
  }, [activeId]);
  const agentPrompt = useAppStore((s) => s.agentPrompt);
  useEffect(() => {
    if (!agentPrompt || !hydrated) return;
    fillDraft(agentPrompt.text);
    if (agentPrompt.changes) setAllowWorkspaceChanges(true);
    useAppStore.getState().clearAgentPrompt();
  }, [agentPrompt, hydrated]);
  const visibleMessages = messages.slice(-visibleCount);
  const hiddenCount = messages.length - visibleMessages.length;

  useEffect(() => {
    // 只推动消息容器，避免浏览器把整个页面和输入区一起滚走。
    const scroll = messagesRef.current;
    if (scroll && followBottom.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages.length, activeId, running?.text]);

  useEffect(() => {
    if (!useConversations.getState().hydrated) {
      void Promise.resolve(useConversations.persist.rehydrate())
        .then(() => useConversations.getState().setHydrated(true))
        .catch((reason: Error) => setError(reason.message));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      ?.config()
      .then((config) => {
        if (alive) setModel(config.model);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api, configOpen]);
  useEffect(
    () => () => {
      if (runRef.current) void api?.cancel(runRef.current).catch(() => {});
    },
    [api],
  );

  async function send(
    text: string,
    retry?: { history: Message[]; appendQuestion: boolean },
    access?: WorkspaceAccessRequest,
  ) {
    const question = text.trim();
    if (!question || runRef.current || preparingRef.current || !hydrated) return;
    if (!api) {
      setError(t("模型连接与本地知识库仅在桌面端可用。"));
      return;
    }
    if (!model) {
      setConfigOpen(true);
      setError(t("请先配置真实模型地址、API Key 和模型名。"));
      return;
    }
    // 回答内的授权按钮只使用它明确展示的范围，不夹带输入区未提交的勾选。
    const checkMailboxes = access ? false : allowMailboxChecks;
    const readDocuments = access
      ? access.permissions.includes("documentContent")
      : allowDocumentContent;
    const proposeChanges = access
      ? access.permissions.includes("workspaceChanges")
      : allowWorkspaceChanges;
    preparingRef.current = true;
    setPreparing(true);
    try {
      if (checkMailboxes && !(await requireVault(t("本次允许查询邮箱")))) return;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
    if (runRef.current) return;
    setAllowMailboxChecks(false);
    setAllowDocumentContent(false);
    setAllowWorkspaceChanges(false);
    const conversationId = activeId ?? start();
    followBottom.current = true;
    const history = modelHistory(retry?.history ?? messages);
    if (!retry || retry.appendQuestion)
      append("you", [{ type: "text", text: question }], conversationId);
    if (!retry) setDraft("");
    setError("");
    const id = crypto.randomUUID();
    runRef.current = id;
    let output = "";
    const sources: Source[] = [],
      tools: string[] = [];
    setRunning({ id, conversationId, text: "", phase: t("本地检索"), tools: [], sources: [] });
    const off = api.onEvent((event) => {
      if (event.id !== id) return;
      if (event.type === "delta") output += event.text ?? "";
      if (event.type === "source" && event.source) sources.push(event.source);
      if (event.type === "tool" && event.name) tools.push(event.name);
      setRunning((previous) =>
        previous?.id === id
          ? {
              ...previous,
              text: output,
              phase: event.type === "phase" ? t(event.text ?? "") : previous.phase,
              tools: [...tools],
              sources: [...sources],
            }
          : previous,
      );
    });
    try {
      const result = await api.run({
        id,
        question,
        history,
        allowWorkspaceChanges: proposeChanges,
        allowMailboxChecks: checkMailboxes,
        allowDocumentContent: readDocuments,
      });
      append(
        "agent",
        [
          { type: "text", text: result.text },
          { type: "sources", sources: result.sourceItems },
          ...(result.proposals ?? []).map((proposal): Block => ({ type: "proposal", proposal })),
          ...(result.accessRequests ?? []).map((request): Block => ({ type: "access", request })),
          ...(result.nextSteps?.length
            ? [{ type: "next", steps: result.nextSteps } satisfies Block]
            : []),
          {
            type: "run",
            model: result.model,
            steps: result.steps,
            tools: result.tools,
            status: "success",
            documentContent: readDocuments,
            workspaceChanges: proposeChanges,
          },
        ],
        conversationId,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      append(
        "agent",
        [
          { type: "text", text: output ? `${output}\n\n${reason}` : reason },
          { type: "sources", sources },
          {
            type: "run",
            model,
            steps: 0,
            tools,
            status: reason === "已停止生成。" ? "stopped" : "error",
            documentContent: readDocuments,
            workspaceChanges: proposeChanges,
          },
        ],
        conversationId,
      );
    } finally {
      off();
      runRef.current = null;
      setRunning(null);
    }
  }

  function fillDraft(question: string) {
    setDraft(question);
    setContextOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }

  const sourceGroups = messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === "sources" ? [{ messageId: message.id, sources: block.sources }] : [],
    ),
  );
  const context = (
    <AgentContext
      busy={busy}
      onPick={fillDraft}
      onNavigate={() => setContextOpen(false)}
      sourceGroups={sourceGroups}
      runningSources={running?.sources ?? []}
      onTrace={(messageId) => {
        setVisibleCount(messages.length);
        setContextOpen(false);
        followBottom.current = false;
        requestAnimationFrame(() => {
          const scroll = messagesRef.current;
          const target = scroll?.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(messageId)}"]`,
          );
          if (scroll && target)
            scroll.scrollTop +=
              target.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
        });
      }}
    />
  );

  return (
    <div className="agent-workspace">
      <section className="agent-chat" aria-label={t("AI 问答")}>
        <header className="agent-header">
          <div className="min-w-0 flex-1">
            <p className="truncate text-meta font-medium">{active?.title ?? t("新对话")}</p>
            <p className="truncate text-2xs text-subtle">{model || t("尚未配置模型")}</p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            className="agent-context-toggle"
            aria-label={t("对话上下文")}
            title={t("对话上下文")}
            onClick={() => setContextOpen(true)}
          >
            <PanelRightOpen className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setCapabilitiesOpen((open) => !open)}
            aria-expanded={capabilitiesOpen}
            aria-controls="agent-capabilities"
          >
            <WandSparkles className="size-4" />
            {t("内置能力")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            aria-label={t(configOpen ? "返回对话" : "模型与知识库")}
            title={t(configOpen ? "返回对话" : "模型与知识库")}
            onClick={() => setConfigOpen((open) => !open)}
          >
            {configOpen ? <ArrowLeft className="size-4" /> : <Settings2 className="size-4" />}
          </Button>
        </header>
        {capabilities.mounted && (
          <div
            className="agent-capabilities-transition"
            data-shown={capabilities.shown}
            aria-hidden={!capabilitiesOpen || configOpen}
            inert={!capabilitiesOpen || configOpen}
          >
            <div className="agent-capabilities-clip">
              <div className="agent-capabilities" id="agent-capabilities">
                <p className="text-meta font-medium">{t("先生成建议，审阅后应用")}</p>
                <div className="agent-capability-grid">
                  {[
                    {
                      icon: FileText,
                      label: "文档改名",
                      prompt: "请找到以下文档，生成标题修改方案（保留正文）：",
                      note: "只需标题，无需正文权限",
                    },
                    {
                      icon: PencilLine,
                      label: "修改文档",
                      prompt: "请查找我指定的文档，按以下要求生成局部修改建议：",
                      note: "需要正文时会请求本次授权",
                    },
                    {
                      icon: ShieldCheck,
                      label: "整理账号资料",
                      prompt: "请查找我指定的账号，建议修改名称或标签：",
                      note: "密码等凭据在本机编辑",
                    },
                    {
                      icon: Link2,
                      label: "发现资源关联",
                      prompt: "请检查账号、服务器和文档，基于具体依据给出尚未保存的关联建议。",
                      note: "区分已有关系与建议",
                    },
                    {
                      icon: CalendarClock,
                      label: "补齐费用与到期日",
                      prompt:
                        "找出还没填写费用或到期日的服务器、域名、服务资产和 AI 订阅；有依据的直接生成补全建议，缺少依据的列出来问我：",
                      note: "生成可审阅的资产修改",
                    },
                    {
                      icon: NotebookPen,
                      label: "起草运维文档",
                      prompt:
                        "为以下资产起草一份运维文档（部署、巡检、故障恢复步骤），关联到对应资产，不确定的步骤用待办标出：",
                      note: "新建文档并关联资产",
                    },
                    {
                      icon: CalendarCheck,
                      label: "规划续费",
                      prompt: "未来 30 天要续费哪些？合计多少钱？按紧急程度排出处理顺序。",
                      note: "读取续费日历与支出",
                      changes: false,
                    },
                  ].map(({ icon: Icon, label, prompt, note, changes }) => (
                    <button
                      key={label}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        fillDraft(t(prompt));
                        setAllowWorkspaceChanges(changes !== false);
                        setCapabilitiesOpen(false);
                      }}
                    >
                      <Icon className="size-4" />
                      <span>
                        <strong>{t(label)}</strong>
                        <small>{t(note)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {configOpen ? (
          <div className="agent-settings-scroll">
            <AgentSettings onConfigChange={(config) => setModel(config.model)} />
          </div>
        ) : (
          <>
            <div
              ref={messagesRef}
              className="agent-message-scroll"
              role="region"
              aria-label={t("对话消息")}
              onScroll={(event) => {
                const scroll = event.currentTarget;
                followBottom.current =
                  scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
              }}
            >
              {messages.length === 0 ? (
                <Welcome
                  onPick={(question, changes) => {
                    fillDraft(question);
                    if (changes) setAllowWorkspaceChanges(true);
                  }}
                />
              ) : (
                <div className="agent-message-list">
                  {hiddenCount > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mx-auto flex"
                      onClick={() => {
                        const scroll = messagesRef.current;
                        const height = scroll?.scrollHeight ?? 0;
                        followBottom.current = false;
                        setVisibleCount((count) => count + 80);
                        requestAnimationFrame(() => {
                          if (scroll) scroll.scrollTop += scroll.scrollHeight - height;
                        });
                      }}
                    >
                      {t("显示更早的 {0} 条消息", hiddenCount)}
                    </Button>
                  )}
                  {visibleMessages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      busy={busy}
                      onAsk={(question) => void send(question)}
                      onSettings={() => setConfigOpen(true)}
                      onRetry={() => {
                        const retry = retryRequest(messages, message.id);
                        if (retry) void send(retry.question, retry);
                      }}
                      accessOptions={
                        message.id === messages.at(-1)?.id ? workspaceAccessOptions(message) : []
                      }
                      onAccess={(access) => {
                        const retry = continuationRequest(messages, message.id);
                        if (retry) void send(retry.question, retry, access);
                      }}
                    />
                  ))}
                  {running?.conversationId === activeId && (
                    <div className="agent-pending" aria-live="polite">
                      <p className="flex items-center gap-2 text-meta text-muted">
                        <Loader2 className="size-4 animate-spin" />
                        {running.phase}
                      </p>
                      {running.tools.length > 0 && (
                        <p className="my-2 break-words font-mono text-2xs text-subtle">
                          {running.tools.map(toolLabel).join(" → ")}
                        </p>
                      )}
                      <Markdown>{running.text}</Markdown>
                    </div>
                  )}
                </div>
              )}
            </div>
            <form
              className="agent-composer"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <div className="agent-composer-field">
                <textarea
                  ref={inputRef}
                  value={draft}
                  rows={1}
                  aria-label={t("向模型提问")}
                  maxLength={8000}
                  placeholder={t("哪些资产需要优先处理？请引用依据。")}
                  className="agent-input"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send(draft);
                    }
                  }}
                />
                <button
                  type={running ? "button" : "submit"}
                  aria-label={t(running ? "停止生成" : "发送")}
                  title={t(running ? "停止生成" : "发送")}
                  disabled={!running && (!draft.trim() || busy)}
                  className="agent-composer-action"
                  data-running={Boolean(running)}
                  onClick={
                    running
                      ? (event) => {
                          event.preventDefault();
                          void api
                            ?.cancel(running.id)
                            .catch((reason: Error) => setError(reason.message));
                        }
                      : undefined
                  }
                >
                  <ArrowUp className="agent-action-send size-4" aria-hidden="true" />
                  <Square className="agent-action-stop size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="agent-permissions">
                <label>
                  <input
                    type="checkbox"
                    checked={allowMailboxChecks}
                    disabled={busy || !api}
                    onChange={(event) => setAllowMailboxChecks(event.target.checked)}
                  />
                  {t("本次允许查询邮箱")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={allowDocumentContent}
                    disabled={busy || !api}
                    onChange={(event) => setAllowDocumentContent(event.target.checked)}
                  />
                  {t("本次允许检索文档正文")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={allowWorkspaceChanges}
                    disabled={busy || !api}
                    onChange={(event) => setAllowWorkspaceChanges(event.target.checked)}
                  />
                  {t("本次生成修改建议")}
                </label>
              </div>
              <p className="agent-privacy-note">
                {t(
                  "问题和命中片段发送至所选模型；勾选后可发送文档正文片段，仅本次有效。回答保存在本机历史，凭据不进入检索。",
                )}
              </p>
              {error && (
                <p role="alert" className="mt-2 break-words text-meta text-crit">
                  {error}
                </p>
              )}
            </form>
          </>
        )}
      </section>
      <aside className="agent-context-desktop" aria-label={t("对话上下文")}>
        {context}
      </aside>
      {contextOpen && (
        <EditorDialog title={t("对话上下文")} onClose={() => setContextOpen(false)}>
          {context}
        </EditorDialog>
      )}
    </div>
  );
}

/** 首屏按场景分组的提问，数字取自当前资料，点一下就带好问题。 */
function Welcome({ onPick }: { onPick: (q: string, changes?: boolean) => void }) {
  const data = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      services: s.services,
      phoneNumbers: s.phoneNumbers,
      aiAssets: s.aiAssets,
      certs: s.certs,
    })),
  );
  const attention = useAppStore(useShallow(attentionOf)).total;
  const groups = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    const upcoming = renewalCalendar(data, { from: key(today), to: key(end) }).length;
    const missing =
      [...data.servers, ...data.domains, ...data.services].filter(
        (asset) => !asset.billing || !asset.expiresAt,
      ).length +
      data.aiAssets.filter((asset) => asset.monthlyUsdKnown === false || !asset.monthlyUsd).length;
    const server = data.servers.find((item) => !item.demo) ?? data.servers[0];
    return [
      {
        icon: Activity,
        title: "巡检与处理",
        prompts: [
          attention
            ? {
                q: t(
                  "逐项分析需要留意的 {0} 项资产：原因、会影响哪些关联资产、下一步怎么处理。",
                  attention,
                ),
              }
            : { q: t("检查所有资产的状态，有没有需要提前处理的？请引用依据。") },
          { q: t("我的主机、域名和证书有哪些关联？哪台主机出问题影响最大？") },
        ],
      },
      {
        icon: CalendarClock,
        title: "续费与费用",
        prompts: [
          upcoming
            ? { q: t("未来 30 天有 {0} 项续费，合计多少钱？按紧急程度排出处理顺序。", upcoming) }
            : { q: t("未来 90 天有哪些续费？每月和每年一共花多少？") },
          missing
            ? {
                q: t("有 {0} 项资产还没填写费用或到期日，帮我列出来并生成补全建议。", missing),
                changes: true,
              }
            : { q: t("统计每月 AI 订阅费用，给出优化建议。") },
        ],
      },
      {
        icon: NotebookPen,
        title: "资料整理",
        prompts: [
          server
            ? {
                q: t("为「{0}」起草一份运维与故障恢复手册，并关联到这台主机。", server.name),
                changes: true,
              }
            : { q: t("帮我起草一份资产巡检清单文档。"), changes: true },
          {
            q: t("检查服务器、域名、账号和文档，给出尚未保存的关联建议。"),
            changes: true,
          },
        ],
      },
    ];
  }, [data, attention]);
  return (
    <div className="stagger-in agent-welcome mx-auto max-w-2xl pt-6">
      <LogoMark className="size-10" />
      <h2 className="mt-4 text-xl font-semibold tracking-tight">{t("问问你自己的资产")}</h2>
      <p className="mt-2 text-meta leading-relaxed text-muted">
        {t(
          "分析状态、续费、费用与关联，每个回答都给出下一步；需要修改时先生成建议，由你确认后应用。",
        )}
      </p>
      <div className="agent-welcome-groups">
        {groups.map(({ icon: Icon, title, prompts }) => (
          <section key={title} aria-label={t(title)}>
            <h3>
              <Icon aria-hidden="true" />
              {t(title)}
            </h3>
            {prompts.map((prompt) => (
              <button
                key={prompt.q}
                type="button"
                className="agent-welcome-prompt"
                onClick={() => onPick(prompt.q, "changes" in prompt ? prompt.changes : false)}
              >
                <span>{prompt.q}</span>
                {"changes" in prompt && prompt.changes && (
                  <span className="agent-welcome-badge">{t("生成建议")}</span>
                )}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  busy,
  onAsk,
  onRetry,
  onSettings,
  accessOptions,
  onAccess,
}: {
  message: Message;
  busy: boolean;
  onAsk: (question: string) => void;
  onRetry: () => void;
  onSettings: () => void;
  accessOptions: WorkspaceAccessRequest[];
  onAccess: (access: WorkspaceAccessRequest) => void;
}) {
  if (message.role === "you") {
    const text = message.blocks.find((b) => b.type === "text");
    return (
      <div className="flex justify-end" data-message-id={message.id}>
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-card">
          <p className="whitespace-pre-wrap text-meta">{text?.type === "text" ? text.text : ""}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3" data-message-id={message.id}>
      <LogoMark className="mt-0.5 size-6 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2.5">
        {message.blocks.map((block, i) => (
          <BlockView key={i} block={block} busy={busy} onAsk={onAsk} />
        ))}
        {accessOptions.length > 0 && (
          <section className="agent-access-request" aria-label={t("继续完成这项任务")}>
            <div className="flex items-center gap-2 text-meta font-medium">
              <ShieldCheck className="size-4 shrink-0" />
              {t("继续完成这项任务")}
            </div>
            {accessOptions.map((access, index) => (
              <div key={index}>
                {access.reason && <p className="text-meta text-muted">{access.reason}</p>}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onAccess(access)}
                >
                  <ArrowUpRight className="size-3.5 shrink-0" />
                  {t(
                    access.permissions.includes("documentContent")
                      ? access.permissions.includes("workspaceChanges")
                        ? "允许本次读取正文并生成建议"
                        : "允许本次读取正文并继续"
                      : "允许本次生成修改建议并继续",
                  )}
                </Button>
              </div>
            ))}
            <p className="text-2xs text-muted">
              {t(
                accessOptions.some((access) => access.permissions.includes("documentContent"))
                  ? "正文片段会发送至当前模型，仅本次有效；修改仍需你审阅确认。"
                  : "仅生成可审阅的修改方案，不读取正文；确认应用后才会保存。",
              )}
            </p>
          </section>
        )}
        {message.blocks.some((block) => block.type === "run" && block.status !== "success") && (
          <div className="agent-retry-actions">
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
              <RotateCcw className="size-3.5" />
              {t("重试这条问题")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onSettings} disabled={busy}>
              <Settings2 className="size-3.5" />
              {t("检查模型设置")}
            </Button>
            <p>{t("重试使用当前模型设置和下方勾选的本次权限。")}</p>
          </div>
        )}
        <TimeAgo iso={message.at} className="block text-2xs text-subtle" />
      </div>
    </div>
  );
}

function BlockView({
  block,
  busy = false,
  onAsk,
}: {
  block: Block;
  busy?: boolean;
  onAsk?: (question: string) => void;
}) {
  const setExpanded = useAppStore((s) => s.setExpanded);
  const openSsh = useAppStore((s) => s.openSsh);

  const reveal = (assetId: string, kind: AssetKind, focus?: "account") => {
    const w = Math.min(560, window.innerWidth - 48);
    setExpanded({
      kind,
      id: assetId,
      focus,
      origin: { x: (window.innerWidth - w) / 2, y: window.innerHeight * 0.3, w, h: 180 },
    });
  };

  switch (block.type) {
    case "access":
      return null;
    case "next":
      return block.steps.length > 0 ? (
        <nav className="agent-next" aria-label={t("下一步")}>
          <span className="agent-next-label">
            <Sparkles aria-hidden="true" />
            {t("下一步")}
          </span>
          <div className="agent-next-steps">
            {block.steps.map((step, i) => (
              <button
                key={i}
                type="button"
                className="agent-next-step"
                data-kind={step.kind}
                disabled={step.kind === "ask" && (busy || !onAsk)}
                title={step.kind === "ask" ? step.question : undefined}
                onClick={() => {
                  if (step.kind === "ask") onAsk?.(step.question);
                  else if ("asset" in step) reveal(step.asset.id, step.asset.kind);
                  else useAppStore.getState().setView(step.view);
                }}
              >
                {step.kind === "ask" ? (
                  <MessageCircleQuestion aria-hidden="true" />
                ) : (
                  <ArrowUpRight aria-hidden="true" />
                )}
                {step.label}
              </button>
            ))}
          </div>
        </nav>
      ) : null;
    case "proposal":
      return <ProposalCard proposal={block.proposal} />;
    case "sources":
      return block.sources.length > 0 ? (
        <details className="agent-sources">
          <summary>
            {t("检索来源")} · {block.sources.length}
          </summary>
          <ul>
            {block.sources.map((source) => (
              <li key={source.id}>
                <SourceItem source={source} />
              </li>
            ))}
          </ul>
        </details>
      ) : null;
    case "run":
      return (
        <p className="break-words text-2xs text-subtle">
          {block.model} ·{" "}
          {t(
            block.status === "success"
              ? "生成完成"
              : block.status === "stopped"
                ? "已停止"
                : "生成失败",
          )}{" "}
          · {block.steps} {t("轮")}
          {block.tools.length ? ` · ${block.tools.map(toolLabel).join(", ")}` : ""}
        </p>
      );
    case "text":
      return <Markdown>{block.text}</Markdown>;

    case "secret":
      return <SecretBlock block={block} />;

    case "asset":
      return (
        <button
          type="button"
          className="paste-match"
          onClick={() => reveal(block.assetId, block.kind)}
        >
          <span className="flex-1 text-left text-meta">
            {t("打开{0}详情", t(KIND_LABEL[block.kind]))}
          </span>
        </button>
      );

    case "action":
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            block.action === "ssh" ? openSsh(block.assetId) : reveal(block.assetId, block.kind)
          }
        >
          <SquareTerminal className="size-3.5" />
          {block.label}
        </Button>
      );

    case "choices":
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.options.map((o) => (
            <button
              key={o.assetId}
              type="button"
              className="tag-chip"
              onClick={() => reveal(o.assetId, o.kind)}
            >
              {o.label}
              <span className="opacity-55">{t(KIND_LABEL[o.kind])}</span>
            </button>
          ))}
        </div>
      );

    case "rows":
      return (
        <ul className="overflow-hidden rounded-xl bg-card shadow-card">
          {block.rows.map((row) => (
            <li key={row.assetId}>
              <button
                type="button"
                className="row-tap flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-line"
                onClick={() => row.assetId.startsWith("sample-") || reveal(row.assetId, row.kind)}
              >
                {row.status && <span className={dotClass(row.status)} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta font-medium">{row.label}</span>
                  {row.meta && (
                    <span className="block truncate text-2xs text-muted">{row.meta}</span>
                  )}
                </span>
                {row.status && row.status !== "online" && (
                  <span className={chipClass(row.status)}>
                    {row.status === "offline" ? t("告警") : t("注意")}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      );
  }
}

function ProposalCard({ proposal }: { proposal: WorkspaceProposal }) {
  const [state, setState] = useState<"pending" | "applying" | "applied" | "dismissed">(
    proposal.status ?? "pending",
  );
  const [failure, setFailure] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const expired = Date.now() > proposal.expiresAt;
  const finish = (status: "applied" | "dismissed", documentId?: string) => {
    setState(status);
    useConversations.setState((current) => ({
      conversations: current.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === "proposal" && block.proposal.id === proposal.id
              ? {
                  ...block,
                  proposal: { ...block.proposal, status, ...(documentId ? { documentId } : {}) },
                }
              : block,
          ),
        })),
      })),
    }));
  };
  const dismiss = async () => {
    if (state !== "pending" || dismissing) return;
    const api = desktop()?.agent;
    if (!api) return;
    setDismissing(true);
    setFailure("");
    try {
      await api.discardProposal(proposal.id);
      finish("dismissed");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setDismissing(false);
    }
  };
  const apply = async () => {
    if (state !== "pending" || dismissing) return;
    const api = desktop()?.agent;
    if (!api) return;
    setState("applying");
    setFailure("");
    try {
      if (proposal.documentId) await useDocuments.getState().flush(proposal.documentId);
      const before = useAppStore.getState();
      const result = await api.applyProposal(proposal.id);
      if (result.document) {
        const document = result.document;
        // 只替换本次涉及且已保存的草稿，其他编辑中的文档不受影响。
        if (["dirty", "saving", "error"].includes(useDocuments.getState().status[document.id]))
          throw new Error(t("文档在应用期间又被编辑，请保留当前草稿并重新打开核对。"));
        useDocuments.setState((current) => ({
          drafts: { ...current.drafts, [document.id]: document },
          status: { ...current.status, [document.id]: "saved" },
        }));
        useDocuments.getState().acceptChange({ document });
      }
      if (result.snapshot) {
        const current = useAppStore.getState();
        current.importSnapshot(
          mergeSnapshotChange(current, {
            before: result.before ?? before,
            snapshot: result.snapshot,
          }),
        );
      }
      // 新建的文档要记下 id，之后才能从卡片直接打开。
      finish("applied", result.document?.id);
      useAppStore.getState().log(t("已应用 AI 修改建议：{0}", proposal.title));
    } catch (error) {
      setState("pending");
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="agent-proposal" aria-label={t("待审阅修改建议")}>
      <header>
        <WandSparkles className="size-4" />
        <span>
          {t(state === "applied" ? "已应用" : state === "dismissed" ? "已忽略" : "待审阅修改建议")}
        </span>
      </header>
      <h3>{proposal.title}</h3>
      <p className="agent-proposal-reason">{proposal.reason}</p>
      <div className="agent-proposal-diff">
        <div>
          <span>{t("修改前")}</span>
          <pre>{proposal.before}</pre>
        </div>
        <div>
          <span>{t("修改后")}</span>
          <pre>{proposal.after}</pre>
        </div>
      </div>
      {failure && (
        <p role="alert" className="text-meta text-crit">
          {failure}
        </p>
      )}
      {state === "pending" || state === "applying" ? (
        <footer>
          <Button
            size="sm"
            disabled={state === "applying" || dismissing || expired}
            onClick={() => void apply()}
          >
            {state === "applying" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {t(expired ? "建议已过期，请重新生成" : "确认应用这项修改")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={state === "applying" || dismissing}
            onClick={() => void dismiss()}
          >
            {dismissing && <Loader2 className="size-3.5 animate-spin" />}
            {t("忽略")}
          </Button>
        </footer>
      ) : (
        <footer className="agent-proposal-done">
          <p className="text-2xs text-subtle">
            {t(state === "applied" ? "修改已保存到本机。" : "已保留原有内容。")}
          </p>
          {state === "applied" && <ProposalTarget proposal={proposal} />}
        </footer>
      )}
    </section>
  );
}

/** 应用之后直接打开改动的文档或资产，确认效果。 */
function ProposalTarget({ proposal }: { proposal: WorkspaceProposal }) {
  // 只取种类（字符串），避免每次渲染都生成新对象。
  const kind = useAppStore((s) =>
    proposal.assetId && !proposal.documentId
      ? assetEntries(s).find((entry) => entry.id === proposal.assetId)?.kind
      : undefined,
  );
  if (proposal.documentId) {
    const id = proposal.documentId;
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          try {
            await useDocuments.getState().open(id);
            useAppStore.getState().setView("docs");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <ArrowUpRight className="size-3.5" />
        {t("打开文档")}
      </Button>
    );
  }
  if (!kind || !proposal.assetId) return null;
  const id = proposal.assetId;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        const w = Math.min(560, window.innerWidth - 48);
        useAppStore.getState().setExpanded({
          kind,
          id,
          origin: { x: (window.innerWidth - w) / 2, y: window.innerHeight * 0.3, w, h: 180 },
        });
      }}
    >
      <ArrowUpRight className="size-3.5" />
      {t("查看资产")}
    </Button>
  );
}

/**
 * A password, resolved at render time.
 *
 * The message on disk holds only `{assetId, field}`; the value is fetched from
 * the vault when this mounts and lives in component state, never in history.
 */
function SecretBlock({ block }: { block: Extract<Block, { type: "secret" }> }) {
  const bridge = desktop();
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const secrets = useAppStore((s) => s.secrets);
  const [value, setValue] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let alive = true;
    setValue(null);
    setShown(false);
    setMissing(false);
    void (async () => {
      if (!bridge || !unlocked) return;
      try {
        const account = await bridge.vault.get(accountId(block.assetId));
        let found = account?.[block.field as keyof typeof account] as string | undefined;
        // A server's SSH password lives under its own key, not the account one.
        if (!found && block.kind === "server" && block.field === "password") {
          const ssh = await bridge.vault.get(credentialId(block.assetId));
          found = ssh?.password;
        }
        if (!alive) return;
        setValue(found ?? null);
        setMissing(!found);
      } catch {
        if (alive) setMissing(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge, unlocked, block.assetId, block.field, block.kind, secrets]);

  if (!bridge) {
    return <p className="text-meta text-muted">{t("桌面版才能读取加密库。")}</p>;
  }

  if (!unlocked) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void requireVault(t("查看 {0} 的信息需要先解锁密钥库。", block.label))}
      >
        <Lock className="size-3.5" />

        {t("解锁查看")}
      </Button>
    );
  }

  if (missing) {
    return (
      <p className="flex items-center gap-1.5 text-meta text-muted">
        <ShieldCheck className="size-3.5" />

        {t("这条资产还没有保存过这个字段。")}
      </p>
    );
  }

  if (value === null) return <p className="text-meta text-subtle">{t("读取中…")}</p>;

  return (
    <div className="flex items-center gap-2 rounded-xl bg-card px-4 py-2.5 shadow-card">
      <span className="min-w-0 flex-1 truncate font-mono text-meta">
        {shown ? value : "•".repeat(Math.min(20, value.length))}
      </span>
      <button
        type="button"
        aria-label={shown ? t("隐藏") : t("显示")}
        className="grid size-7 shrink-0 place-items-center rounded-full text-subtle transition-colors duration-150 ease-out hover:bg-line hover:text-ink"
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label={t("复制")}
        className="grid size-7 shrink-0 place-items-center rounded-full text-subtle transition-colors duration-150 ease-out hover:bg-line hover:text-ink"
        onClick={() => {
          void copyText(value);
          toast(t("已复制{0}", FIELD_TEXT[block.field]));
        }}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

const FIELD_TEXT: Record<SecretField, string> = {
  password: "密码",
  username: "账号",
  url: "登录地址",
  note: "备注",
};

const COMMON_QUESTIONS = [
  "哪些资产需要优先处理？请引用依据。",
  "我的主机、域名和证书有哪些关联？",
  "统计每月 AI 订阅费用，给出优化建议。",
  "查找与当前资产相关的文档，并列出来源。",
];

type SourceGroup = { messageId: string; sources: Source[] };

/** 对话控件集中在同一工作区，流式生成时锁定会改变回答归属的操作。 */
function AgentContext({
  busy,
  onPick,
  onNavigate,
  sourceGroups,
  runningSources,
  onTrace,
}: {
  busy: boolean;
  onPick: (question: string) => void;
  onNavigate: () => void;
  sourceGroups: SourceGroup[];
  runningSources: Source[];
  onTrace: (messageId: string) => void;
}) {
  const conversations = useConversations((state) => state.conversations);
  const activeId = useConversations((state) => state.activeId);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const filtered = conversations
    .filter(
      (conversation) =>
        !needle ||
        [
          conversation.title,
          ...conversation.messages.flatMap((message) =>
            message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
          ),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sources = sourceGroups.flatMap((group) =>
    group.sources.map((source) => ({ ...source, messageId: group.messageId })),
  );
  return (
    <div className="agent-context-content">
      <section className="agent-context-section">
        <div className="agent-context-heading">
          <h2>{t("历史对话")}</h2>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              useConversations.getState().start();
              setQuery("");
              onNavigate();
            }}
          >
            <MessageSquarePlus className="size-4" />
            {t("新对话")}
          </Button>
        </div>
        <label className="agent-history-search">
          <Search className="size-4 shrink-0" />
          <input
            aria-label={t("搜索历史对话")}
            placeholder={t("搜索历史对话")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {busy && (
          <p className="text-2xs text-muted" role="status">
            {t("生成期间暂不可切换或删除对话。")}
          </p>
        )}
        {filtered.length === 0 ? (
          <p className="text-meta text-muted">{t(needle ? "没有匹配的对话。" : "还没有对话。")}</p>
        ) : (
          <ul className="agent-history-list">
            {filtered.map((conversation) => (
              <li
                key={conversation.id}
                className="agent-history-row"
                data-active={conversation.id === activeId}
              >
                <button
                  type="button"
                  className="agent-history-open"
                  disabled={busy}
                  aria-current={conversation.id === activeId ? "page" : undefined}
                  onClick={() => {
                    useConversations.getState().open(conversation.id);
                    onNavigate();
                  }}
                >
                  <span className="truncate text-meta font-medium">{conversation.title}</span>
                  <TimeAgo iso={conversation.updatedAt} className="text-2xs text-subtle" />
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={t("删除对话：{0}", conversation.title)}
                  title={t("删除对话")}
                  onClick={() => {
                    if (
                      window.confirm(
                        t("删除对话“{0}”？这会移除本机的问答历史，无法撤销。", conversation.title),
                      )
                    )
                      useConversations.getState().remove(conversation.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="agent-context-section">
        <div className="agent-context-heading">
          <h2>{t("常用提问")}</h2>
        </div>
        <p className="text-2xs text-muted">{t("选择后填入输入框，确认后再发送。")}</p>
        <div className="agent-question-list">
          {COMMON_QUESTIONS.map((question) => (
            <button
              type="button"
              key={question}
              disabled={busy}
              onClick={() => onPick(t(question))}
            >
              <span>{t(question)}</span>
              <ArrowUpRight className="size-3.5 shrink-0" />
            </button>
          ))}
        </div>
      </section>
      <section className="agent-context-section">
        <div className="agent-context-heading">
          <h2>{t("当前对话来源")}</h2>
          <span className="text-2xs text-subtle">{sources.length + runningSources.length}</span>
        </div>
        {sources.length + runningSources.length === 0 ? (
          <p className="text-meta text-muted">{t("回答引用的资产和文档会显示在这里。")}</p>
        ) : (
          <ul className="agent-context-sources">
            {sources.map((source, index) => (
              <li key={source.messageId + source.id + index}>
                <SourceItem source={source} compact />
                <button
                  type="button"
                  className="agent-trace-link"
                  onClick={() => onTrace(source.messageId)}
                >
                  {t("回到引用消息")}
                </button>
              </li>
            ))}
            {runningSources.map((source) => (
              <li key={source.id}>
                <SourceItem source={source} compact />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 文档跳转先等待旧稿保存；失败时保留当前界面并明确提示。 */
function SourceItem({ source, compact = false }: { source: Source; compact?: boolean }) {
  const [opening, setOpening] = useState(false);
  const canOpen = Boolean(source.documentId || (source.assetId && source.kind));
  async function openSource() {
    if (opening) return;
    setOpening(true);
    try {
      if (source.documentId) {
        await useDocuments.getState().open(source.documentId);
        useAppStore.getState().setView("docs");
      } else if (source.assetId && source.kind) {
        const width = Math.min(560, window.innerWidth - 48);
        useAppStore.getState().setExpanded({
          kind: source.kind,
          id: source.assetId,
          focus: source.focus,
          origin: {
            x: (window.innerWidth - width) / 2,
            y: window.innerHeight * 0.3,
            w: width,
            h: 180,
          },
        });
      }
    } catch (reason) {
      toast.error(
        t("打开来源失败：{0}", reason instanceof Error ? reason.message : String(reason)),
      );
    } finally {
      setOpening(false);
    }
  }
  const title = (
    <>
      <span className="agent-source-citation">[{source.citation}]</span>
      <span>{source.title}</span>
      {source.documentId ? (
        <FileText className="size-3.5 shrink-0" />
      ) : canOpen ? (
        <ArrowUpRight className="size-3.5 shrink-0" />
      ) : null}
    </>
  );
  return (
    <div className="agent-source-item">
      {canOpen ? (
        <button
          type="button"
          className="agent-source-title"
          disabled={opening}
          onClick={() => void openSource()}
        >
          {title}
        </button>
      ) : (
        <p className="agent-source-title">{title}</p>
      )}
      {source.focus === "account" && <p className="text-2xs text-muted">{t("打开凭据位置")}</p>}
      {!compact && <Markdown>{source.excerpt}</Markdown>}
    </div>
  );
}
