import { Component, type ReactNode } from "react";
import { t } from "@/lib/i18n";

/** 某个页面渲染出错时只替换这一页，侧栏和其他页面仍可用，错误原文留在页面上便于反馈。 */
export class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-xl space-y-3 px-6 py-16 text-center">
        <h2 className="text-lg font-semibold">{t("这个页面出错了")}</h2>
        <p className="text-meta text-muted">
          {t(
            "其他页面不受影响，可以从侧栏切换。如果反复出现，请把下面的错误信息发到 GitHub Issues。",
          )}
        </p>
        <pre className="overflow-x-auto rounded-lg bg-surface p-3 text-left font-mono text-2xs text-crit">
          {error.message}
        </pre>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => this.setState({ error: null })}
        >
          {t("重试")}
        </button>
      </div>
    );
  }
}
