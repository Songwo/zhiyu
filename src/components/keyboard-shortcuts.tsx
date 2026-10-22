import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { EditorDialog } from "./ui/editor-dialog";

/** 打开快捷键说明：命令面板和其他入口派发这个事件。 */
export const SHORTCUTS_EVENT = "shortcuts:open";

const GROUPS: { title: string; items: [keys: string[], label: string][] }[] = [
  {
    title: "查找与新建",
    items: [
      [["Ctrl", "K"], "搜索资产、页面与操作"],
      [["/"], "打开搜索"],
      [["Ctrl", "N"], "在当前页面新建资产"],
    ],
  },
  {
    title: "导航",
    items: [
      [["Alt", "←"], "后退：关闭详情或回到上一页"],
      [["Alt", "→"], "前进"],
      [["Esc"], "关闭弹窗、返回列表"],
    ],
  },
  {
    title: "界面",
    items: [
      [["Ctrl", ","], "打开设置"],
      [["Ctrl", "+"], "放大界面"],
      [["Ctrl", "-"], "缩小界面"],
      [["Ctrl", "0"], "恢复 100%"],
      [["?"], "显示本页快捷键"],
    ],
  },
];

const typing = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** 按 ? 或从命令面板打开的快捷键一览；macOS 上把 Ctrl 显示为 ⌘。 */
export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (typing(event.target) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener(SHORTCUTS_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(SHORTCUTS_EVENT, show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!open) return null;
  const mac = document.documentElement.dataset.platform === "darwin";
  return (
    <EditorDialog title={t("键盘快捷键")} onClose={() => setOpen(false)}>
      <div className="editor-scroll shortcut-groups">
        {GROUPS.map((group) => (
          <section key={group.title} aria-label={t(group.title)}>
            <h3>{t(group.title)}</h3>
            <dl>
              {group.items.map(([keys, label]) => (
                <div key={label} className="shortcut-row">
                  <dt>{t(label)}</dt>
                  <dd>
                    {keys.map((key) => (
                      <kbd key={key}>{mac && key === "Ctrl" ? "⌘" : mac && key === "Alt" ? "⌥" : key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </EditorDialog>
  );
}
