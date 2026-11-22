import { ChevronDown, Tags, Rows3 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useAppStore } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { tagCounts } from "@/lib/tags";
import type { Taggable } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";

/**
 * The collection the current view lists, before any filtering.
 *
 * Chips are counted against this rather than the filtered result, so the strip
 * does not collapse out from under the pointer while you narrow things down.
 */
function useViewCollection(): Array<Partial<Taggable>> {
  const view = useAppStore((s) => s.view);
  const servers = useAppStore((s) => s.servers);
  const domains = useAppStore((s) => s.domains);
  const mailboxes = useAppStore((s) => s.mailboxes);
  const aiAssets = useAppStore((s) => s.aiAssets);
  const secrets = useAppStore((s) => s.secrets);
  const certs = useAppStore((s) => s.certs);
  const services = useAppStore((s) => s.services);
  const layout = useSettings((s) => s.assetLayout);
  const hydrated = useAppStore((s) => s.hydrated);

  switch (view) {
    case "servers":
    case "terminal":
      return servers;
    case "domains":
      return domains;
    case "mail":
      return mailboxes;
    case "ai":
      return aiAssets;
    case "vault":
      return secrets;
    case "services":
      return services;
    case "certs":
      return certs;
    // The overview is a dashboard and the tags view sources its own list;
    // neither has a single collection for the strip to count.
    case "overview":
    case "tags":
      return hydrated && layout !== "cards"
        ? [...servers, ...domains, ...mailboxes, ...aiAssets, ...secrets, ...certs, ...services]
        : [];
    case "agent":
    case "nodes":
    default:
      return [];
  }
}

/** 标签从未筛选的集合取数；关闭面板后，已选标签仍显示在工具栏上。 */
export function TagFilter({ canGroup }: { canGroup: boolean }) {
  const items = useViewCollection();
  const selected = useAppStore((s) => s.tagFilter);
  const toggleTag = useAppStore((s) => s.toggleTag);
  const clearTags = useAppStore((s) => s.clearTags);
  const grouped = useAppStore((s) => s.groupByTag);
  const setGroupByTag = useAppStore((s) => s.setGroupByTag);
  const layout = useSettings((s) => s.assetLayout);
  const [tagQuery, setTagQuery] = useState("");
  const tagQueryId = useId();

  const counts = tagCounts(items);
  const showGrouping = canGroup && layout === "cards";
  if (counts.length === 0 && selected.length === 0) return null;
  const needle = tagQuery.trim().toLocaleLowerCase();
  const options = counts.filter(({ tag }) => tag.toLocaleLowerCase().includes(needle));
  const matching = new Set(counts.map(({ tag }) => tag));

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) setTagQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="workspace-tag-trigger"
          aria-label={t("标签筛选")}
          aria-description={selected.length ? t("已选标签：{0}", selected.join("、")) : undefined}
          data-selected={selected.length > 0}
        >
          <Tags aria-hidden="true" />
          {t("标签")}
          {selected.length > 0 && (
            <span
              className="workspace-tag-selection"
              aria-hidden="true"
              title={selected.join("、")}
            >
              <span>{selected[0]}</span>
              {selected.length > 1 && <b>+{selected.length - 1}</b>}
            </span>
          )}
          <ChevronDown aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="workspace-tag-panel"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t("标签筛选")}
        >
          <label className="sr-only" htmlFor={tagQueryId}>
            {t("搜索标签")}
          </label>
          <input
            id={tagQueryId}
            className="ui-input h-9 w-full rounded-sm px-3 text-meta"
            placeholder={t("搜索标签")}
            value={tagQuery}
            onChange={(event) => setTagQuery(event.target.value)}
          />
          <div className="workspace-tag-options" role="group" aria-label={t("标签")}>
            {options.map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                className={cn("tag-chip", selected.includes(tag) && "tag-chip-on")}
                aria-pressed={selected.includes(tag)}
                onClick={() => toggleTag(tag)}
              >
                {tag}
                <span className="tabular-nums opacity-55" aria-hidden="true">
                  {count}
                </span>
              </button>
            ))}
            {!needle &&
              selected
                .filter((tag) => !matching.has(tag))
                .map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="tag-chip tag-chip-on"
                    aria-pressed="true"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
            {!options.length && needle && (
              <p className="text-meta text-muted" role="status">
                {t("没有匹配的标签")}
              </p>
            )}
          </div>
          {(showGrouping || selected.length > 0) && (
            <div className="workspace-tag-panel-footer">
              {showGrouping && (
                <Button
                  variant={grouped ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={grouped}
                  onClick={() => setGroupByTag(!grouped)}
                >
                  <Rows3 />
                  {t("按标签分组")}
                </Button>
              )}
              {selected.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearTags}>
                  {t("清除标签筛选")}
                </Button>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A tag chip on a card. Clicking it narrows the list to that tag. */
export function CardTag({ tag }: { tag: string }) {
  const selected = useAppStore((s) => s.tagFilter);
  const toggleTag = useAppStore((s) => s.toggleTag);
  return (
    <button
      type="button"
      className={cn("chip chip-mute tag-inline", selected.includes(tag) && "tag-inline-on")}
      aria-pressed={selected.includes(tag)}
      onClick={(e) => {
        // The card itself opens the detail sheet; the tag only filters.
        e.stopPropagation();
        toggleTag(tag);
      }}
    >
      {tag}
    </button>
  );
}

/** Section heading for the grouped layout. */
export function GroupHeading({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <div className="col-span-full flex items-center gap-2 px-1 pt-1">
      <h3 className="text-meta font-semibold tracking-tight">{label}</h3>
      <span className="text-2xs tabular-nums text-subtle">{count}</span>
      <span className="ml-2 h-px flex-1 bg-line" />
      {children}
    </div>
  );
}
