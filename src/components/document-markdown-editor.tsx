import { useLayoutEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import "./document-markdown-editor.css";

function resizeInput(input: HTMLTextAreaElement) {
  // 临时收缩文本框会让浏览器把祖先滚动位置截到新的文末，再扩高时不会自动恢复。
  // 记录输入事件已经确定的可见位置，只抵消测量高度引起的位移。
  const reader = input.closest<HTMLElement>(".document-reader-scroll");
  const scrollTop = reader?.scrollTop;
  const scrollLeft = reader?.scrollLeft;
  input.style.height = "auto";
  input.style.height = `${Math.max(360, input.scrollHeight)}px`;
  if (reader && scrollTop !== undefined && scrollLeft !== undefined) {
    reader.scrollTop = scrollTop;
    reader.scrollLeft = scrollLeft;
  }
}

export function DocumentMarkdownEditor({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    resizeInput(input);
  }, [value]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) < 0.5) return;
      width = nextWidth;
      resizeInput(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      className="document-markdown-input"
      aria-label={t("Markdown 源码")}
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
