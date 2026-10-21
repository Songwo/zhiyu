import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { useTilt } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * 景深头图：柔和渐变底 + 缓慢漂移的光斑 + 随指针轻微倾斜的白色浮层。
 * 浮层里放页面最重要的一组数字或入口。
 */
export function DepthHero({
  eyebrow,
  title,
  description,
  actions,
  children,
  tone = "forest",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  tone?: "forest" | "dusk" | "sand";
  className?: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  useTilt(stage, 3.5);
  return (
    <section className={cn("depth-hero", className)} data-tone={tone}>
      <div className="depth-hero-ambient" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="depth-hero-copy">
        {eyebrow && <p className="depth-hero-eyebrow">{eyebrow}</p>}
        <h1 className="depth-hero-title">{title}</h1>
        {description && <p className="depth-hero-description">{description}</p>}
        {actions && <div className="depth-hero-actions">{actions}</div>}
      </div>
      {children && (
        <div className="depth-hero-stage">
          <div ref={stage} className="depth-panel">
            <span className="depth-panel-glare" aria-hidden="true" />
            {children}
          </div>
        </div>
      )}
    </section>
  );
}

/** 不加外框的内容段落：标题 + 一句说明 + 右侧操作，靠留白分隔。 */
export function PageSection({
  title,
  description,
  action,
  children,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cn("page-section", className)} {...rest}>
      <div className="page-section-head">
        <div className="min-w-0">
          <h2 className="page-section-title">{title}</h2>
          {description && <p className="page-section-description">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 列表行：图标块 + 标题与说明 + 右侧附加信息，悬停时浅灰底并轻推箭头。 */
export function RowButton({
  icon: Icon,
  title,
  detail,
  trailing,
  arrow = true,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLButtonElement>, "title"> & {
  icon?: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  arrow?: boolean;
}) {
  return (
    <button type="button" className={cn("row-button", className)} {...rest}>
      {Icon && (
        <span className="row-button-icon" aria-hidden="true">
          <Icon />
        </span>
      )}
      <span className="row-button-text">
        <span className="row-button-title">{title}</span>
        {detail && <span className="row-button-detail">{detail}</span>}
      </span>
      {trailing}
      {arrow && <ArrowUpRight className="row-button-arrow" aria-hidden="true" />}
    </button>
  );
}
