import { Blocks, ExternalLink, Globe, Mail, Zap } from "lucide-react";
import type { ServiceAsset } from "@/lib/types";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { openFromEvent } from "./asset-card";
import { CardTag } from "./tag-bar";
import { StatusBadge } from "./ui/status-badge";
import { AssetImage } from "./image-picker";
import { SERVICE_LABELS } from "@/lib/services";
const ICONS = { worker: Zap, blog: Globe, mail: Mail, custom: Blocks };

export function ServiceCard({ data, compact = true }: { data: ServiceAsset; compact?: boolean }) {
  const Icon = ICONS[data.category];
  return (
    <article
      className={cn(
        "group relative bg-card text-left transition-all",
        compact ? "asset-card-valuable card-tap cursor-pointer" : "asset-card-detail",
      )}
      data-asset-id={compact ? data.id : undefined}
      role={compact ? "button" : undefined}
      tabIndex={compact ? 0 : undefined}
      aria-label={compact ? t("查看服务 {0}", data.name) : undefined}
      onClick={compact ? (event) => openFromEvent(event, "service", data.id) : undefined}
      onKeyDown={
        compact
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.currentTarget.click();
              }
            }
          : undefined
      }
    >
      <header className="flex items-start gap-3">
        <AssetImage
          value={data.imageDataUrl}
          fallback={
            <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface text-ink">
              <Icon className="size-5" />
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-semibold tracking-tight">{data.name}</h3>
            <StatusBadge status={data.status} />
          </div>
          <p className="mt-1 truncate text-meta text-muted">
            {t(SERVICE_LABELS[data.category])}
            {data.provider ? ` · ${data.provider}` : ""}
          </p>
        </div>
      </header>
      {data.url &&
        (compact ? (
          <p className="mt-4 truncate font-mono text-meta text-muted">{data.url}</p>
        ) : (
          <a
            className="mt-4 inline-flex max-w-full items-center gap-2 break-all text-meta text-link"
            href={data.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-4 shrink-0" />
            {data.url}
          </a>
        ))}
      {data.notes && (
        <p
          className={cn(
            "mt-3 whitespace-pre-wrap break-words text-meta leading-relaxed text-muted",
            compact && "line-clamp-2",
          )}
        >
          {data.notes}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        {data.tags.map((tag) => (
          <CardTag key={tag} tag={tag} />
        ))}
        <span className="ml-auto text-2xs text-subtle">
          {data.integration ? t("已关联 · 打开查看最新状态") : t("手动记录状态")}
        </span>
      </div>
    </article>
  );
}
