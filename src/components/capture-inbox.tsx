import { useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { captureBridge } from "@/lib/web-extension";
import { useAppStore } from "@/lib/store";
import { useProfile } from "@/lib/profile";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";

export function CaptureInbox() {
  const [items, setItems] = useState<
    Array<{
      id: string;
      title: string;
      url: string;
      hasCredential?: boolean;
      username?: string;
      source?: string;
    }>
  >([]);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const ready = useProfile((s) => s.profile?.ready);
  const state = useAppStore();
  useEffect(() => {
    const api = captureBridge();
    if (!api) return;
    let active = true;
    let revision = 0;
    const invalidate = () => {
      generation.current++;
    };
    const refresh = () => {
      const current = ++revision;
      void Promise.all([api.capture.list(), api.extension.list()])
        .then(([sites, accounts]) => {
          if (active && current === revision) setItems([...accounts, ...sites]);
        })
        .catch((error) => {
          if (active) toast.error(String(error));
        });
    };
    const off = api.capture.onChanged(refresh);
    const offExtension = api.extension.onChanged(refresh);
    const offVault = api.onVaultChanged(() => {
      invalidate();
      setItems((list) => list.filter((entry) => !entry.hasCredential));
      refresh();
    });
    refresh();
    return () => {
      active = false;
      invalidate();
      off();
      offExtension();
      offVault();
    };
  }, []);
  const item = items[0];
  if (
    !item ||
    !ready ||
    !state.hydrated ||
    state.composerOpen ||
    state.settingsOpen ||
    state.expanded
  )
    return null;
  async function dismiss() {
    await (item.hasCredential ? captureBridge()?.extension : captureBridge()?.capture)?.discard(
      item.id,
    );
    setItems((list) => list.filter((entry) => entry.id !== item.id));
  }
  async function accept() {
    setBusy(true);
    const current = generation.current;
    try {
      if (item.hasCredential) {
        const api = captureBridge()!;
        const captured = await api.extension.take(item.id);
        // 领取过程中锁库、卸载或打开其他表单时，不把凭据放回界面。
        if (
          current !== generation.current ||
          !useVault.getState().unlocked ||
          useAppStore.getState().composerOpen
        )
          return;
        state.openComposer("secret", null, {
          kind: "password",
          name: captured.title,
          _url: captured.url,
          _username: captured.username,
          _password: captured.password,
          _captureId: captured.id,
        });
        setItems((list) => list.filter((entry) => entry.id !== item.id));
      } else {
        state.openComposer("secret", null, { kind: "password", name: item.title, _url: item.url });
        await dismiss();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("账号接收失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-lg rounded-lg border border-line bg-card p-4 shadow-float"
      aria-label={t("浏览器待保存网站")}
    >
      <div className="flex items-center gap-3">
        {item.hasCredential ? (
          <KeyRound className="size-5 shrink-0 text-muted" />
        ) : (
          <ExternalLink className="size-5 shrink-0 text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <strong className="flex items-center gap-2">
            <span className="truncate">{item.title}</span>
            {item.source === "auto" && (
              <span className="shrink-0 rounded-full bg-line px-2 py-0.5 text-2xs text-muted">
                {t("自动采集")}
              </span>
            )}
          </strong>
          <p className="break-all text-meta text-muted">{item.url}</p>
          {item.username && <p className="truncate text-meta text-muted">{item.username}</p>}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("忽略网站")}
          aria-label={t("忽略网站")}
          disabled={busy}
          onClick={() => void dismiss().catch((e) => toast.error(String(e)))}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-meta text-muted">{t("{0} 个网站待确认", items.length)}</span>
        <Button onClick={() => void accept()} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {item.hasCredential ? t("核对账号并保存") : t("填写账号并保存")}
        </Button>
      </div>
    </aside>
  );
}
