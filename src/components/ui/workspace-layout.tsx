import { useRef, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Input } from "./input";
import { PageHelp } from "./page-help";
import "./workspace-layout.css";

export function WorkspaceHeader({
  title,
  meta,
  help,
  actions,
  className,
}: {
  title: string;
  meta?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("workspace-heading", className)}>
      <div className="workspace-heading-identity">
        <div className="workspace-heading-title">
          <h1 className="page-title">{title}</h1>
          {help && <PageHelp>{help}</PageHelp>}
        </div>
        {meta && <div className="workspace-heading-meta">{meta}</div>}
      </div>
      {actions && <div className="workspace-heading-actions">{actions}</div>}
    </header>
  );
}

export function WorkspaceSectionHeader({
  title,
  meta,
  leading,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="workspace-collection-heading">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <h2>{title}</h2>
        {meta && <span className="shrink-0 text-meta text-muted tabular-nums">{meta}</span>}
      </div>
      {actions && <div className="workspace-heading-actions">{actions}</div>}
    </header>
  );
}

export function WorkspaceControls({
  search,
  filters,
  actions,
  className,
}: {
  search: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("workspace-controls", className)}>
      <div className="workspace-controls-search">{search}</div>
      {filters && <div className="workspace-controls-filters">{filters}</div>}
      {actions && <div className="workspace-controls-actions">{actions}</div>}
    </div>
  );
}

export function WorkspaceSearch({
  label,
  placeholder = label,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="workspace-field-search" data-has-value={Boolean(value)}>
      <Search aria-hidden="true" className="workspace-search-symbol" />
      <Input
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="workspace-search-clear"
          aria-label={t("清除搜索")}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
