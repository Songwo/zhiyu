import { openExternal } from "@/lib/web-bridge";
import { createElement, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlignLeft,
  FileText,
  Image as ImageIcon,
  ImageOff,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import type { MailMessage } from "@/lib/mailbox";
import { readImageGrants, writeImageGrants } from "@/lib/mail-image-grants";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const staticTags = new Set([
  "p",
  "div",
  "span",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "sub",
  "sup",
  "small",
  "mark",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
]);
const styleKeys = [
  "textAlign",
  "verticalAlign",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "textDecoration",
  "whiteSpace",
  "lineHeight",
] as const;

function webUrl(value: string | undefined) {
  if (!value || value.length > 4096) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function MailLink({ href, children }: { href?: string; children: ReactNode }) {
  const url = webUrl(href);
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        // 网页版交给浏览器按 target=_blank 打开；桌面版交给系统浏览器。
        if (!desktop()) return;
        event.preventDefault();
        void openExternal(url).catch((error: Error) => toast.error(error.message));
      }}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function RemoteImageNotice({ onLoad }: { onLoad: () => void }) {
  return (
    <span className="my-3 flex flex-wrap items-center gap-3 border-y border-line py-3 text-meta not-italic">
      <ShieldCheck className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-48 text-muted">
        <strong className="block font-medium text-ink">{t("外部图片已拦截")}</strong>
        {t("加载后，发件方可能获知你的 IP 地址及阅读时间。")}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onLoad}>
        <ImageIcon aria-hidden="true" />
        {t("加载本封图片")}
      </Button>
    </span>
  );
}

function MailImage({
  src,
  alt,
  remote,
  allowed,
  onLoad,
  showNotice = true,
}: {
  src?: string;
  alt?: string;
  remote?: string;
  allowed: boolean;
  onLoad: () => void;
  showNotice?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const external = webUrl(remote);
  const inline =
    src && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src) ? src : "";
  const imageSource = inline || (allowed ? external : "");
  if (external && !allowed)
    return showNotice ? (
      <RemoteImageNotice onLoad={onLoad} />
    ) : (
      <span className="my-2 inline-flex max-w-full items-center gap-2 rounded border border-dashed border-line px-3 py-2 text-meta text-muted">
        <ImageOff className="size-4 shrink-0" aria-hidden="true" />
        <span className="break-words">{alt || t("外部图片")}</span>
      </span>
    );
  if (!imageSource || failed)
    return (
      <span className="my-2 inline-flex max-w-full items-center gap-2 text-meta text-muted">
        <ImageOff className="size-4 shrink-0" aria-hidden="true" />
        <span className="break-words">{failed ? t("图片未能加载") : alt || t("图片未能加载")}</span>
        {failed && imageSource && (
          <button
            type="button"
            title={t("重新加载图片")}
            aria-label={t("重新加载图片")}
            onClick={() => setFailed(false)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded hover:bg-line"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </button>
        )}
      </span>
    );
  return (
    <img
      src={imageSource}
      alt={alt || t("邮件图片")}
      className="my-3 h-auto max-w-full rounded"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function HtmlBody({
  body,
  allowed,
  onLoad,
}: {
  body: HTMLElement;
  allowed: boolean;
  onLoad: () => void;
}) {
  const renderNode = (node: Node, key: string): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof HTMLElement)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "img")
      return (
        <MailImage
          key={`${key}:${node.getAttribute("src") ?? node.getAttribute("data-mail-remote-src")}`}
          src={node.getAttribute("src") ?? undefined}
          remote={node.getAttribute("data-mail-remote-src") ?? undefined}
          alt={node.getAttribute("alt") ?? undefined}
          allowed={allowed}
          onLoad={onLoad}
          showNotice={false}
        />
      );
    const children = Array.from(node.childNodes).map((child, index) =>
      renderNode(child, `${key}.${index}`),
    );
    if (tag === "a")
      return (
        <MailLink key={key} href={node.getAttribute("href") ?? undefined}>
          {children}
        </MailLink>
      );
    if (!staticTags.has(tag)) return null;
    const style = Object.fromEntries(
      styleKeys
        .filter((property) => node.style[property])
        .map((property) => [property, node.style[property]]),
    ) as CSSProperties;
    const props: Record<string, unknown> = { key, style };
    for (const [attribute, property] of [
      ["colspan", "colSpan"],
      ["rowspan", "rowSpan"],
      ["start", "start"],
      ["value", "value"],
    ]) {
      const raw = node.getAttribute(attribute);
      if (raw && /^\d{1,3}$/.test(raw)) props[property] = Math.max(1, Math.min(100, Number(raw)));
    }
    if (tag === "ol" && node.hasAttribute("reversed")) props.reversed = true;
    const element = ["br", "hr", "col"].includes(tag)
      ? createElement(tag, props)
      : createElement(tag, props, children);
    return tag === "table" ? (
      <div key={key} className="markdown-table">
        {element}
      </div>
    ) : (
      element
    );
  };
  return Array.from(body.childNodes).map((node, index) => renderNode(node, String(index)));
}

export function MailContent({ message }: { message: MailMessage }) {
  const [plain, setPlain] = useState(false);
  const [allowedFor, setAllowedFor] = useState<MailMessage | null>(null);
  const [rememberedGrants, setRememberedGrants] = useState<string[]>(() => readImageGrants());
  // 授权绑定本次读取对象；已记住授权的邮件按 Message-ID 跨会话延续，不自动加载其他邮件。
  const grantKey = `img:${message.messageId ?? `uid-${message.uid}`}`;
  const allowed = allowedFor === message || rememberedGrants.includes(grantKey);
  const parsed = useMemo(() => {
    if (!message.html || typeof DOMParser === "undefined") return null;
    const body = new DOMParser().parseFromString(message.html, "text/html").body;
    return body.querySelectorAll("*").length <= 10000 ? body : null;
  }, [message.html]);
  const remoteCount = parsed?.querySelectorAll("img[data-mail-remote-src]").length ?? 0;
  const loadImages = () => {
    setAllowedFor(message);
    const next = [...rememberedGrants.filter((key) => key !== grantKey), grantKey];
    setRememberedGrants(next);
    writeImageGrants(next);
  };
  return (
    <section className="min-w-0" aria-label={t("邮件正文")}>
      <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex h-8 items-center gap-1 rounded-md bg-canvas p-0.5"
          role="group"
          aria-label={t("正文显示方式")}
        >
          {[
            { plain: false, label: t("排版"), Icon: FileText },
            { plain: true, label: t("原文"), Icon: AlignLeft },
          ].map(({ plain: value, label, Icon }) => (
            <button
              key={label}
              type="button"
              aria-pressed={plain === value}
              onClick={() => setPlain(value)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded px-3 text-meta transition-colors duration-150 motion-reduce:transition-none",
                plain === value ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        {allowed && (
          <button
            type="button"
            onClick={() => setAllowedFor(null)}
            className="inline-flex h-8 items-center gap-1.5 text-meta text-muted hover:text-ink"
          >
            <ImageOff className="size-3.5" aria-hidden="true" />
            {t("隐藏外部图片")}
          </button>
        )}
      </div>
      {plain ? (
        <pre className="whitespace-pre-wrap font-mono text-body leading-relaxed [overflow-wrap:anywhere]">
          {message.text || t("邮件没有可显示的文本正文")}
        </pre>
      ) : (
        <>
          {remoteCount > 0 && !allowed && <RemoteImageNotice onLoad={loadImages} />}
          <div className="markdown-body mail-body min-w-0 [&_div]:max-w-full [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_p]:my-3 [&_pre]:max-w-full [&_table]:max-w-full [&_td]:break-words [&_th]:break-words">
            {parsed ? (
              <HtmlBody body={parsed} allowed={allowed} onLoad={loadImages} />
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                urlTransform={(url) => webUrl(url)}
                components={{
                  a: ({ href, children }) => <MailLink href={href}>{children}</MailLink>,
                  img: ({ src, alt }) => (
                    <MailImage
                      key={typeof src === "string" ? src : ""}
                      remote={typeof src === "string" ? src : undefined}
                      alt={alt}
                      allowed={allowed}
                      onLoad={loadImages}
                    />
                  ),
                  table: ({ children }) => (
                    <div className="markdown-table">
                      <table>{children}</table>
                    </div>
                  ),
                }}
              >
                {message.text || t("邮件没有可显示的文本正文")}
              </ReactMarkdown>
            )}
          </div>
        </>
      )}
    </section>
  );
}
