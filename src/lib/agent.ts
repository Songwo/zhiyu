import {
  hasServerMetrics,
  hasServerObservation,
  serverNeedsAttention,
} from "./server-observation.mjs";
import { KIND_LABEL } from "./status.ts";
import { tagsOf } from "./tags.ts";
import type { AssetKind, Snapshot, Status } from "./types.ts";
import { daysUntil, formatUsd } from "./utils.ts";
import { t } from "./i18n.ts";

/**
 * 回答由正文、来源与运行记录组成。凭据块只保存引用，不写入密钥库里的值。
 * 用户问题和获得授权的文档片段仍可能包含敏感信息，并会保存在本机对话历史中。
 */
export type Block =
  | { type: "access"; request: import("./agent-client").WorkspaceAccessRequest }
  | { type: "proposal"; proposal: import("./agent-client").WorkspaceProposal }
  | { type: "sources"; sources: import("./agent-client").Source[] }
  | { type: "next"; steps: import("./agent-client").NextStep[] }
  | {
      type: "run";
      model: string;
      steps: number;
      tools: string[];
      status: "success" | "error" | "stopped";
      /** 标记这次回答是否允许使用工作区文档正文，下一次发送前重新确认范围。 */
      documentContent?: boolean;
      workspaceChanges?: boolean;
    }
  | { type: "text"; text: string }
  | { type: "secret"; assetId: string; kind: AssetKind; field: SecretField; label: string }
  | { type: "asset"; assetId: string; kind: AssetKind }
  | { type: "rows"; rows: Row[] }
  | {
      type: "action";
      action: "ssh" | "open-asset";
      assetId: string;
      kind: AssetKind;
      label: string;
    }
  | { type: "choices"; options: Array<{ assetId: string; kind: AssetKind; label: string }> };

export type SecretField = "password" | "username" | "url" | "note";

export interface Row {
  assetId: string;
  kind: AssetKind;
  label: string;
  meta: string;
  status?: Status;
  accent?: string;
}

export interface Answer {
  blocks: Block[];
  /** True when a block needs the vault open to show anything. */
  needsVault: boolean;
}

interface Candidate {
  score?: number;
  id: string;
  kind: AssetKind;
  label: string;
  meta: string;
  status: Status;
  tokens: string[];
}

// ---------------------------------------------------------------- indexing

const NON_WORD = /[\s,，。．.、:：;；?？!！"'`()（）【】[\]/\\|@_-]+/;

/** Everything the question might refer to, flattened into one searchable list. */
function index(snapshot: Snapshot): Candidate[] {
  const make = (
    id: string,
    kind: AssetKind,
    label: string,
    meta: string,
    status: Status,
    extra: Array<string | undefined>,
    tags: string[],
  ): Candidate => ({
    id,
    kind,
    label,
    meta,
    status,
    tokens: [label, ...extra.filter(Boolean), ...tags]
      .flatMap((v) => String(v).toLowerCase().split(NON_WORD))
      .filter((t) => t.length >= 2),
  });

  return [
    ...snapshot.servers.map((s) =>
      make(
        s.id,
        "server",
        s.name,
        s.host,
        s.status,
        [s.label, s.host, s.username, s.region, s.os],
        tagsOf(s),
      ),
    ),
    ...snapshot.domains.map((s) =>
      make(s.id, "domain", s.name, s.registrar, s.status, [s.registrar, s.dns], tagsOf(s)),
    ),
    ...snapshot.mailboxes.map((s) =>
      make(s.id, "mail", s.address, s.domain, s.status, [s.domain, s.forwardTo], tagsOf(s)),
    ),
    ...snapshot.aiAssets.map((s) =>
      make(s.id, "ai", s.name, s.provider, s.status, [s.provider, s.plan], tagsOf(s)),
    ),
    ...snapshot.secrets.map((s) =>
      make(s.id, "secret", s.name, s.hint, s.status, [s.hint, s.kind], tagsOf(s)),
    ),
    ...(snapshot.services ?? []).map((s) =>
      make(s.id, "service", s.name, s.provider, s.status, [s.category, s.url], tagsOf(s)),
    ),
    ...snapshot.certs.map((s) =>
      make(s.id, "cert", s.cn, s.issuer, s.status, [s.issuer, s.host, ...s.sans], tagsOf(s)),
    ),
  ];
}

/** Words in the question that say which kind of thing is being asked about. */
const KIND_HINTS: Array<[RegExp, AssetKind]> = [
  [/worker|博客|自建邮箱|服务资产|service/i, "service"],
  [/邮箱|邮件|信箱|mail/i, "mail"],
  [/服务器|主机|机器|vps|host|server/i, "server"],
  [/域名|domain/i, "domain"],
  [/证书|ssl|tls|cert/i, "cert"],
  [/订阅|会员|ai\b|api/i, "ai"],
  [/密钥|秘钥|key|token/i, "secret"],
];

function hintedKind(query: string): AssetKind | null {
  for (const [re, kind] of KIND_HINTS) if (re.test(query)) return kind;
  return null;
}

const MAX_GRAM = 8;

/**
 * Every substring of the question worth matching against, longest first.
 *
 * Chinese does not put spaces between words, so "连一下腾讯云" cannot be split
 * into tokens the way an English sentence can. Sliding a window over it and
 * asking whether any asset's name *contains* that window finds 腾讯云4H4G from
 * 腾讯云, which token equality never would.
 */
function grams(query: string): string[] {
  const q = query.toLowerCase();
  const filler = new Set([
    "what",
    "which",
    "where",
    "when",
    "how",
    "is",
    "are",
    "the",
    "for",
    "my",
    "of",
    "to",
    "me",
    "has",
    "does",
    "have",
    "password",
    "mailbox",
    "email",
    "server",
    "host",
    "domain",
    "subscription",
    "this",
    "month",
    "in",
    "on",
    "and",
  ]);
  const out = new Set(
    q
      .split(NON_WORD)
      .filter((word) => word.length >= 2 && !filler.has(word) && !/\p{Script=Han}/u.test(word)),
  );
  // 中文按字片段匹配，英文只匹配完整词，避免 for/which 等短片段命中资产。
  for (const segment of q.match(/\p{Script=Han}+/gu) ?? []) {
    for (let size = Math.min(MAX_GRAM, segment.length); size >= 2; size -= 1) {
      for (let i = 0; i + size <= segment.length; i += 1) out.add(segment.slice(i, i + size));
    }
  }
  return [...out];
}

/**
 * Rank assets by how well the question names them.
 *
 * Matching runs both ways: the question may quote the whole name, or name only
 * a piece of it. Longer overlaps win either way — "billing" identifying
 * `billing@studio.app` is a much stronger signal than "app", which would match
 * half the estate.
 */
function resolve(query: string, candidates: Candidate[]): Candidate[] {
  const q = query.toLowerCase();
  const kind = hintedKind(query);
  const windows = grams(query);

  const scored = candidates
    .map((c) => {
      let score = 0;
      for (const token of c.tokens) {
        // The question quotes the whole token — the strongest signal there is.
        if (/\p{Script=Han}/u.test(token) ? q.includes(token) : windows.includes(token)) {
          score = Math.max(score, token.length * 12 + (c.label.toLowerCase() === token ? 30 : 0));
          continue;
        }
        // The question names part of it, which is how people actually refer to
        // a host called 腾讯云4H4G.
        for (const gram of windows) {
          if (token.includes(gram)) {
            score = Math.max(score, gram.length * 10);
            break;
          }
        }
      }
      if (score > 0 && kind && c.kind === kind) score += 25;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x) => ({ ...x.c, score: x.score }));
}

// ---------------------------------------------------------------- intents

type Intent =
  | { name: "secret"; field: SecretField }
  | { name: "expiry" }
  | { name: "usage" }
  | { name: "spend" }
  | { name: "host" }
  | { name: "connect" }
  | { name: "attention" }
  | { name: "list" }
  | { name: "unknown" };

function classify(query: string): Intent {
  const q = query.toLowerCase();
  if (/密码|口令|passwd|password|授权码|app password/.test(q))
    return { name: "secret", field: "password" };
  if (/账号|帐号|用户名|登录名|username|user name|account name|login name/.test(q))
    return { name: "secret", field: "username" };
  if (/登录地址|网址|后台|控制台|链接|url|sign-?in link|console|dashboard/.test(q))
    return { name: "secret", field: "url" };
  if (/备注|恢复码|二次验证|2fa|note|recovery code|backup code/.test(q))
    return { name: "secret", field: "note" };
  if (/连一下|连接|登陆一下|开终端|ssh|终端|connect|terminal|shell|log ?in to/.test(q))
    return { name: "connect" };
  if (/到期|过期|续费|多久|几天|多少天|expire|expiry|expiring|renew|due|run out/.test(q))
    return { name: "expiry" };
  if (/用量|用了多少|使用率|额度|usage|quota|used the most|consumption/.test(q))
    return { name: "usage" };
  if (/多少钱|月费|花费|花多少|账单|spend|cost|bill|how much|per month|monthly/.test(q))
    return { name: "spend" };
  if (/cpu|内存|磁盘|负载|在线|状态|跑得怎么样|memory|disk|load|online|status|doing/.test(q))
    return { name: "host" };
  if (
    /待处理|需要处理|有什么问题|异常|告警|要注意|attention|needs? (?:my )?(?:attention|action)|anything wrong|issues?|problems?/.test(
      q,
    )
  )
    return { name: "attention" };
  if (/有哪些|列一下|全部|多少个|都有什么|list|show me|how many|what do i have/.test(q))
    return { name: "list" };
  return { name: "unknown" };
}

// ---------------------------------------------------------------- answering

const FIELD_LABEL: Record<SecretField, string> = {
  password: "密码",
  username: "账号",
  url: "登录地址",
  note: "备注",
};

/**
 * Answer a question from the local estate. No network, no model.
 *
 * When the question names an asset ambiguously the answer is a set of choices
 * rather than a guess — picking the wrong mailbox and printing its password is
 * a worse failure than asking.
 */
export function ask(query: string, snapshot: Snapshot): Answer {
  const text = query.trim();
  if (!text) return { blocks: [{ type: "text", text: t("想问什么？") }], needsVault: false };

  const intent = classify(text);
  const candidates = index(snapshot);
  const matches = resolve(text, candidates);

  switch (intent.name) {
    case "secret":
      return answerSecret(text, intent.field, matches);
    case "connect":
      return answerConnect(matches);
    case "expiry":
      return answerExpiry(text, snapshot, matches);
    case "usage":
      return answerUsage(snapshot, matches);
    case "spend":
      return answerSpend(snapshot);
    case "host":
      return answerHost(snapshot, matches);
    case "attention":
      return answerAttention(snapshot);
    case "list":
      return answerList(text, snapshot);
    default:
      return answerUnknown(matches);
  }
}

function answerSecret(query: string, field: SecretField, matches: Candidate[]): Answer {
  if (matches.length === 0) {
    return {
      blocks: [
        {
          type: "text",
          text: t(
            "没找到你说的那个资产。试试说得具体一点，比如「{0}」前面加上名称或地址。",
            t(FIELD_LABEL[field]),
          ),
        },
      ],
      needsVault: false,
    };
  }
  if (matches.length > 1 && matches[0].tokens.length && matches[1] && sameStrength(matches)) {
    return {
      blocks: [
        { type: "text", text: t("有几个都对得上，你要哪一个的{0}？", t(FIELD_LABEL[field])) },
        {
          type: "choices",
          options: matches
            .slice(0, 5)
            .map((m) => ({ assetId: m.id, kind: m.kind, label: m.label })),
        },
      ],
      needsVault: false,
    };
  }

  const hit = matches[0];
  return {
    blocks: [
      {
        type: "text",
        text: t("{0} {1} 的{2}：", t(KIND_LABEL[hit.kind]), hit.label, t(FIELD_LABEL[field])),
      },
      { type: "secret", assetId: hit.id, kind: hit.kind, field, label: hit.label },
      { type: "asset", assetId: hit.id, kind: hit.kind },
    ],
    needsVault: true,
  };
}

/** Two candidates are "equally strong" when neither clearly names the asset. */
function sameStrength(matches: Candidate[]): boolean {
  return matches[1] !== undefined && matches[0].score === matches[1].score;
}

function answerConnect(matches: Candidate[]): Answer {
  const host = matches.find((m) => m.kind === "server");
  if (!host) {
    return { blocks: [{ type: "text", text: t("没找到这台主机。") }], needsVault: false };
  }
  if (host.status === "offline") {
    return {
      blocks: [
        { type: "text", text: t("{0} 目前不可达，先看看它为什么离线。", host.label) },
        { type: "asset", assetId: host.id, kind: "server" },
      ],
      needsVault: false,
    };
  }
  return {
    blocks: [
      { type: "text", text: t("连接 {0}：", host.label) },
      {
        type: "action",
        action: "ssh",
        assetId: host.id,
        kind: "server",
        label: t("打开 {0} 的 SSH 会话", host.label),
      },
    ],
    needsVault: true,
  };
}

function answerExpiry(query: string, snapshot: Snapshot, matches: Candidate[]): Answer {
  const dated: Array<Row & { days: number }> = [
    ...snapshot.domains.map((d) => ({
      assetId: d.id,
      kind: "domain" as const,
      label: d.name,
      meta: t("{0} 天后到期 · {1}", daysUntil(d.expiresAt), d.registrar),
      status: d.status,
      days: daysUntil(d.expiresAt),
    })),
    ...snapshot.certs.map((c) => ({
      assetId: c.id,
      kind: "cert" as const,
      label: c.cn,
      meta: t("{0} 天后到期 · {1}", daysUntil(c.expiresAt), c.issuer),
      status: c.status,
      days: daysUntil(c.expiresAt),
    })),
    ...snapshot.aiAssets.map((a) => ({
      assetId: a.id,
      kind: "ai" as const,
      label: a.name,
      meta: t("{0} 天后续费 · {1}/月", daysUntil(a.renewsAt), formatUsd(a.monthlyUsd)),
      status: a.status,
      days: daysUntil(a.renewsAt),
    })),
  ].sort((a, b) => a.days - b.days);

  const named = matches[0];
  if (named) {
    const row = dated.find((r) => r.assetId === named.id);
    if (row) {
      return {
        blocks: [
          { type: "text", text: t("{0} {1}：{2}。", t(KIND_LABEL[row.kind]), row.label, row.meta) },
          { type: "asset", assetId: row.assetId, kind: row.kind },
        ],
        needsVault: false,
      };
    }
  }

  const window = /本月|这个月|当月|30 ?天|一个月/.test(query)
    ? 30
    : /90|三个月|季度/.test(query)
      ? 90
      : /一周|7 ?天|本周/.test(query)
        ? 7
        : 60;
  const soon = dated.filter((r) => r.days <= window);
  if (soon.length === 0) {
    return {
      blocks: [{ type: "text", text: t("{0} 天内没有要到期的东西。", window) }],
      needsVault: false,
    };
  }
  return {
    blocks: [
      { type: "text", text: t("{0} 天内有 {1} 项要到期，最近的排在前面：", window, soon.length) },
      { type: "rows", rows: soon.slice(0, 10) },
    ],
    needsVault: false,
  };
}

function answerUsage(snapshot: Snapshot, matches: Candidate[]): Answer {
  const named = matches.find((m) => m.kind === "ai");
  if (named) {
    const ai = snapshot.aiAssets.find((a) => a.id === named.id)!;
    return {
      blocks: [
        {
          type: "text",
          text: t(
            "{0} 本月用量 {1}%，月费 {2}，{3} 天后续费。",
            ai.name,
            ai.usagePct,
            formatUsd(ai.monthlyUsd),
            daysUntil(ai.renewsAt),
          ),
        },
        { type: "asset", assetId: ai.id, kind: "ai" },
      ],
      needsVault: false,
    };
  }

  const rows = [...snapshot.aiAssets]
    .sort((a, b) => b.usagePct - a.usagePct)
    .map((a) => ({
      assetId: a.id,
      kind: "ai" as const,
      label: a.name,
      meta: t("用量 {0}% · {1}/月", a.usagePct, formatUsd(a.monthlyUsd)),
      status: a.status,
    }));
  if (rows.length === 0) {
    return { blocks: [{ type: "text", text: t("还没有记录任何 AI 订阅。") }], needsVault: false };
  }
  return {
    blocks: [
      { type: "text", text: t("按用量从高到低：") },
      { type: "rows", rows },
    ],
    needsVault: false,
  };
}

function answerSpend(snapshot: Snapshot): Answer {
  const total = snapshot.aiAssets.reduce((a, x) => a + x.monthlyUsd, 0);
  if (snapshot.aiAssets.length === 0) {
    return {
      blocks: [{ type: "text", text: t("还没有记录任何订阅，所以是 0。") }],
      needsVault: false,
    };
  }
  const rows = [...snapshot.aiAssets]
    .sort((a, b) => b.monthlyUsd - a.monthlyUsd)
    .map((a) => ({
      assetId: a.id,
      kind: "ai" as const,
      label: a.name,
      meta: t("{0}/月 · {1}", formatUsd(a.monthlyUsd), a.provider),
      status: a.status,
    }));
  return {
    blocks: [
      {
        type: "text",
        text: t("{0} 个订阅，每月合计 {1}。", snapshot.aiAssets.length, formatUsd(total)),
      },
      { type: "rows", rows },
    ],
    needsVault: false,
  };
}

function answerHost(snapshot: Snapshot, matches: Candidate[]): Answer {
  const named = matches.find((m) => m.kind === "server");
  if (named) {
    const s = snapshot.servers.find((x) => x.id === named.id)!;
    const detail =
      s.probeError ??
      (hasServerMetrics(s)
        ? t("CPU {0}% · 内存 {1}% · 磁盘 {2}% · 运行 {3}", s.cpu, s.memory, s.disk, s.uptime)
        : t("未采集"));
    return {
      blocks: [
        { type: "text", text: t("{0}：{1}", s.name, detail) },
        { type: "asset", assetId: s.id, kind: "server" },
      ],
      needsVault: false,
    };
  }

  const rows = snapshot.servers.map((s) => ({
    assetId: s.id,
    kind: "server" as const,
    label: s.name,
    meta:
      s.probeError ??
      (hasServerMetrics(s)
        ? t("CPU {0}% · 内存 {1}% · 磁盘 {2}%", s.cpu, s.memory, s.disk)
        : t("未采集")),
    status: hasServerObservation(s) ? s.status : undefined,
  }));
  if (rows.length === 0) {
    return { blocks: [{ type: "text", text: t("还没有记录任何主机。") }], needsVault: false };
  }
  return {
    blocks: [
      { type: "text", text: t("所有主机：") },
      { type: "rows", rows },
    ],
    needsVault: false,
  };
}

function answerAttention(snapshot: Snapshot): Answer {
  const rows: Row[] = [
    ...snapshot.servers.filter(serverNeedsAttention).map((s) => ({
      assetId: s.id,
      kind: "server" as const,
      label: s.name,
      meta: s.probeError ?? (s.status === "offline" ? t("主机离线") : `CPU ${s.cpu}%`),
      status: s.status,
    })),
    ...snapshot.certs
      .filter((c) => c.status !== "online")
      .map((c) => ({
        assetId: c.id,
        kind: "cert" as const,
        label: c.cn,
        meta: c.trusted === false ? t("证书链不受信任") : t("{0} 天后到期", daysUntil(c.expiresAt)),
        status: c.status,
      })),
    ...snapshot.domains
      .filter((d) => d.status !== "online")
      .map((d) => ({
        assetId: d.id,
        kind: "domain" as const,
        label: d.name,
        meta: t("{0} 天后到期", daysUntil(d.expiresAt)),
        status: d.status,
      })),
    ...snapshot.aiAssets
      .filter((a) => a.status !== "online")
      .map((a) => ({
        assetId: a.id,
        kind: "ai" as const,
        label: a.name,
        meta: t("用量 {0}%", a.usagePct),
        status: a.status,
      })),
  ];

  if (rows.length === 0) {
    return {
      blocks: [{ type: "text", text: t("没有待处理的事项，全部正常。") }],
      needsVault: false,
    };
  }
  return {
    blocks: [
      { type: "text", text: t("有 {0} 项需要留意：", rows.length) },
      { type: "rows", rows },
    ],
    needsVault: false,
  };
}

function answerList(query: string, snapshot: Snapshot): Answer {
  const kind = hintedKind(query);
  const all = index(snapshot);
  const list = kind ? all.filter((c) => c.kind === kind) : all;
  if (list.length === 0) {
    return { blocks: [{ type: "text", text: t("这一类还没有任何记录。") }], needsVault: false };
  }
  return {
    blocks: [
      {
        type: "text",
        text: t("共 {0} 项{1}：", list.length, kind ? t(KIND_LABEL[kind]) : t("资产")),
      },
      {
        type: "rows",
        rows: list.slice(0, 20).map((c) => ({
          assetId: c.id,
          kind: c.kind,
          label: c.label,
          meta: c.meta,
          status: c.status,
        })),
      },
    ],
    needsVault: false,
  };
}

function answerUnknown(matches: Candidate[]): Answer {
  if (matches.length > 0) {
    const hit = matches[0];
    return {
      blocks: [
        {
          type: "text",
          text: t("找到了 {0} {1}，但没看懂你想问它什么。", t(KIND_LABEL[hit.kind]), hit.label),
        },
        { type: "asset", assetId: hit.id, kind: hit.kind },
        { type: "text", text: t("可以问：密码 / 账号 / 还有多久到期 / 用量 / 状态。") },
      ],
      needsVault: false,
    };
  }
  return {
    blocks: [
      { type: "text", text: t("这个我还没学会。可以试试这些问法：") },
      {
        type: "rows",
        rows: SAMPLES.map((s, i) => ({
          assetId: `sample-${i}`,
          kind: "server" as const,
          label: t(s),
          meta: "",
        })),
      },
    ],
    needsVault: false,
  };
}

export const SAMPLES = [
  "我 163 那个邮箱的密码是多少",
  "这个月有什么要到期的",
  "AI 一个月花多少钱",
  "哪个订阅用量最高",
  "有什么需要处理的",
  "连一下腾讯云那台机器",
];
