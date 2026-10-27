import { Component, type ReactNode } from "react";
import { isChunkLoadError, reloadForNewVersion } from "@/lib/chunk-reload";
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
    // 升级后旧页面取不到新版本的页面文件：重试无效，只能刷新。
    if (isChunkLoadError(error))
      return (
        <div role="alert" className="mx-auto max-w-xl space-y-3 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">{t("知屿已更新")}</h2>
          <p className="text-meta text-muted">
            {t("这个页面的文件已经换成新版本，刷新后即可继续使用。")}
          </p>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              if (!reloadForNewVersion()) location.reload();
            }}
          >
            {t("刷新页面")}
          </button>
        </div>
      );
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
