import { hostBridge } from "@/lib/web-bridge";
import { ClipboardPaste, CornerDownLeft, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Textarea } from "./ui/input";
import { PASTE_HINTS, parsePaste, type PasteMatch } from "@/lib/parse-paste";
import { KIND_LABEL } from "@/lib/status";
import type { AssetKind } from "@/lib/types";
import { cn, daysUntil } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** A concrete example beats a list of formats when the box is empty. */
const PLACEHOLDER: Record<AssetKind, string> = {
  server: "ssh ubuntu@10.0.0.1 -p 22\n或 ~/.ssh/config 里的一段 Host 配置 / 私钥",
  domain: "https://example.com\n或证书 PEM",
  mail: "hello@example.com\n或一段 IMAP / SMTP 服务器设置",
  ai: "sk-…（OpenAI / Anthropic / xAI 的密钥）\n或控制台网址",
  secret: "sk-… / ghp_… / AKIA…\n或一段私钥",
  cert: "-----BEGIN CERTIFICATE-----\n…",
  service: "https://example.workers.dev",
};

/**
 * Paste anything, get the form filled in.
 *
 * Most of the pain of recording an asset is retyping things you already have on
 * the clipboard — an `ssh` line from a provider console, a key out of a `.env`,
 * a certificate someone mailed you. This reads the blob, says what it thinks it
 * is, and merges the fields on confirmation rather than silently.
 */
export function SmartPaste({
  kind,
  onApply,
}: {
  kind: AssetKind;
  onApply: (fields: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Scoped to this form: offering to parse an ssh command while you fill in a
  // mailbox is noise, not help.
  const ranked = parsePaste(text, kind);

  async function apply(match: PasteMatch) {
    let fields = match.fields;

    // A certificate is only useful once the dates are out of it, and that
    // needs X.509 from the main process.
    if (fields._pem) {
      const bridge = hostBridge();
      if (!bridge) {
        toast(t("证书解析需要桌面版"));
        return;
      }
      setBusy(true);
      try {
        const cert = await bridge.cert.parsePem(fields._pem);
        fields = {
          cn: cert.cn,
          issuer: cert.issuer,
          expiresAt: cert.expiresAt.slice(0, 10),
          sans: cert.sans.join(", "),
          host: cert.cn.replace(/^\*\./, ""),
        };
        toast(t("证书 {0} · {1} 天后到期", cert.cn, daysUntil(cert.expiresAt)));
      } catch (err) {
        toast(err instanceof Error ? err.message : t("证书解析失败"));
        return;
      } finally {
        setBusy(false);
      }
    }

    onApply(fields);
    setText("");
    setOpen(false);
    if (!fields._pem) toast(t("已填入{0}", match.label));
  }

  return (
    <div className="sm:col-span-2">
      {!open ? (
        <button
          type="button"
          className="paste-trigger"
          onClick={async () => {
            setOpen(true);
            // Offer what is already on the clipboard — that is almost always
            // the thing they came here to paste.
            try {
              const clip = await navigator.clipboard.readText();
              if (clip && parsePaste(clip, kind).length > 0) setText(clip);
            } catch {
              // No clipboard permission; the textarea still works.
            }
          }}
        >
          <Sparkles className="size-4" strokeWidth={1.9} />
          <span className="font-medium">{t("智能粘贴")}</span>
          <span className="text-2xs text-subtle">{t(PASTE_HINTS[kind].hint)}</span>
        </button>
      ) : (
        <div className="rounded-xl bg-canvas p-4">
          <div className="mb-2 flex items-center gap-2">
            <ClipboardPaste className="size-4 text-muted" />
            <h3 className="text-meta font-semibold">{t("智能粘贴")}</h3>
            <button
              type="button"
              className="ml-auto text-2xs text-subtle hover:text-ink"
              onClick={() => {
                setOpen(false);
                setText("");
              }}
            >
              {t("收起")}
            </button>
          </div>

          <Textarea
            autoFocus
            value={text}
            spellCheck={false}
            placeholder={t(PLACEHOLDER[kind])}
            className="min-h-24 font-mono text-2xs"
            onChange={(e) => setText(e.target.value)}
          />

          {text.trim() && ranked.length === 0 && (
            <p className="mt-2 text-2xs text-muted">
              {t("没认出来。可以直接在下面的字段里手工填写。")}
            </p>
          )}

          {ranked.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {ranked.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    disabled={busy}
                    className="paste-match"
                    onClick={() => void apply(match)}
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{match.label}</span>
                        <span className={cn("chip", match.kind === kind ? "chip-ok" : "chip-mute")}>
                          {t(KIND_LABEL[match.kind])}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-2xs text-muted">
                        {match.detail}
                      </span>
                    </span>
                    <CornerDownLeft className="size-3.5 shrink-0 text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
