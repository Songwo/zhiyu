/**
 * 首页「快速开始」：按已有资料判断每一步是否完成，不额外记录状态。
 * 新用户按顺序做完这几步，就能用上续费日历、文档关联和关系图。
 */

export type QuickStartStepId = "asset" | "billing" | "document" | "link" | "tag";

export interface QuickStartStep {
  id: QuickStartStepId;
  title: string;
  detail: string;
  done: boolean;
}

interface Tagged {
  tags?: string[];
}
interface Billed extends Tagged {
  billing?: unknown;
}
interface AiLike extends Tagged {
  monthlyUsd?: number;
  monthlyUsdKnown?: boolean;
}

export interface QuickStartInput {
  servers: Billed[];
  domains: Billed[];
  services: Billed[];
  phoneNumbers: Billed[];
  aiAssets: AiLike[];
  certs: Tagged[];
  mailboxes: Tagged[];
  secrets: Tagged[];
  links: unknown[];
  /** 文档列表还没读取时传 `null`，这一步按未完成处理。 */
  documentCount: number | null;
}

export function quickStartSteps(input: QuickStartInput): QuickStartStep[] {
  const assets: Tagged[] = [
    ...input.servers,
    ...input.domains,
    ...input.services,
    ...input.aiAssets,
    ...input.certs,
    ...input.mailboxes,
    ...input.secrets,
  ];
  const billed =
    [...input.servers, ...input.domains, ...input.services, ...input.phoneNumbers].some(
      (item) => item.billing != null,
    ) ||
    input.aiAssets.some(
      (item) => item.monthlyUsdKnown !== false && typeof item.monthlyUsd === "number" && item.monthlyUsd > 0,
    );
  return [
    {
      id: "asset",
      title: "添加第一项资产",
      detail: "服务器、域名、AI 订阅或任何在线服务，先记下一项。",
      done: assets.length + input.phoneNumbers.length > 0,
    },
    {
      id: "billing",
      title: "记录费用与续费日",
      detail: "填写金额和到期日，续费日历会按月付、年付提醒你。",
      done: billed,
    },
    {
      id: "document",
      title: "写一篇运维文档",
      detail: "部署步骤、账号说明写成 Markdown，关联到对应资产。",
      done: (input.documentCount ?? 0) > 0,
    },
    {
      id: "link",
      title: "关联两项资产",
      detail: "把网站、证书和它所在的主机连起来，出问题时一眼看到影响。",
      done: input.links.length > 0,
    },
    {
      id: "tag",
      title: "用标签分组",
      detail: "按项目或用途打标签，跨类型一起查看和筛选。",
      done: assets.some((item) => (item.tags?.length ?? 0) > 0),
    },
  ];
}
