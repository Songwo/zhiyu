import { vaultApi } from "@/lib/vault-api";
import { Copy, ExternalLink, Eye, EyeOff, KeyRound, Lock, UserRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ACCOUNT_COPY, STANDALONE_ACCOUNT_COPY, WEBSITE_ACCOUNT_COPY } from "./account-fields";
import { Button } from "./ui/button";
import { TimeAgo } from "./ui/time-ago";
import { accountId, desktop, type AccountCredential } from "@/lib/desktop";
import { useAppStore } from "@/lib/store";
import type { AssetKind } from "@/lib/types";
import { copyText } from "@/lib/utils";
import { useVault } from "@/lib/vault-state";
import { t } from "@/lib/i18n";
import { IdentityPanel } from "./identity-panel";
import { AccountTotp } from "./account-totp";

/**
 * The read side of a saved account, shown inside the detail sheet.
 *
 * This is the thing you actually open the app for — so it leads with copy
 * buttons rather than a form, and the password stays masked until asked for.
 */
export function AccountPanel({ assetId, kind }: { assetId: string; kind: AssetKind }) {
  const bridge = desktop();
  const vault = vaultApi();
  // 网页版没有系统浏览器桥，直接在新标签页打开。
  const openLink = (url: string) =>
    bridge
      ? bridge.openExternal(url)
      : Promise.resolve(void window.open(url, "_blank", "noopener,noreferrer"));
  const unlocked = useVault((s) => s.unlocked);
  const requireVault = useVault((s) => s.require);
  const openComposer = useAppStore((s) => s.openComposer);
  const [record, setRecord] = useState<AccountCredential | null>(null);
  const [checked, setChecked] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const composerOpen = useAppStore((s) => s.composerOpen);
  const secretKind = useAppStore((s) => s.secrets.find((item) => item.id === assetId)?.kind);
  const identityProvider = useAppStore(
    (s) => s.secrets.find((item) => item.id === assetId)?.identityProvider,
  );
  const standalone = kind === "secret" && secretKind === "account";
  const copy = standalone
    ? STANDALONE_ACCOUNT_COPY
    : kind === "secret" && secretKind === "password"
      ? WEBSITE_ACCOUNT_COPY
      : ACCOUNT_COPY[kind];

  useEffect(() => {
    let alive = true;
    setReveal(false);
    setRecord(null);
    setChecked(false);
    setLoadError(false);
    void (async () => {
      if (!vault || !unlocked || (kind === "secret" && identityProvider)) {
        if (alive) {
          setRecord(null);
          setChecked(false);
        }
        return;
      }
      try {
        const rec = await vault.get(accountId(assetId));
        if (alive) {
          setRecord(rec as AccountCredential | null);
          setChecked(true);
        }
      } catch {
        if (alive) {
          setChecked(true);
          setLoadError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, assetId, unlocked, composerOpen, loadAttempt, kind, identityProvider]);

  if (!vault) return null;
  if (kind === "secret" && identityProvider === "linuxdo")
    return (
      <>
        <IdentityPanel key={assetId} assetId={assetId} />
        <div className="px-4 pb-4">
          <AccountTotp key={`totp:${assetId}`} assetId={assetId} />
        </div>
      </>
    );

  return (
    <section className="border-t border-line px-4 py-4" aria-label={t(copy.title)}>
      <div className="mb-3 flex items-center gap-2">
        <UserRound className="size-4 text-muted" />
        <h3 className="text-meta font-semibold">{t(copy.title)}</h3>
        {kind === "secret" && unlocked && (
          <Button
            className="ml-auto"
            variant="ghost"
            size="sm"
            onClick={() => openComposer(kind, assetId)}
          >
            {t("编辑账号")}
          </Button>
        )}
      </div>

      {!unlocked ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas p-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void requireVault(t("查看已保存的账号密码需要先解锁密钥库。")).catch((error) =>
                toast.error(String(error)),
              )
            }
          >
            <Lock className="size-3.5" />

            {t("解锁查看")}
          </Button>
          <p className="text-2xs text-muted">
            {t("解锁后在这里查看账号，当前页面和选择都会保留。")}
          </p>
        </div>
      ) : !checked ? (
        <p className="text-meta text-muted">{t("读取中…")}</p>
      ) : loadError ? (
        <div className="space-y-2">
          <p role="alert" className="text-meta text-crit">
            {t("账号信息读取失败，请重新打开后重试。")}
          </p>
          <Button variant="outline" size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>
            {t("重新读取")}
          </Button>
        </div>
      ) : !record ? (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => openComposer(kind, assetId)}>
            <KeyRound className="size-3.5" />

            {t("录入账号密码")}
          </Button>
          <span className="text-2xs text-muted">{t("尚未保存任何账号信息。")}</span>
        </div>
      ) : (
        <dl className="space-y-2">
          {record.url && (
            <Row label={t(standalone ? "登录网址" : "登录地址")}>
              <button
                type="button"
                className="truncate text-left text-meta text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                onClick={() => openLink(record.url!).catch(() => toast(t("无法打开链接")))}
              >
                {record.url}
              </button>
              <IconAction label={t("打开")} onClick={() => openLink(record.url!)}>
                <ExternalLink className="size-3.5" />
              </IconAction>
            </Row>
          )}

          {record.username && (
            <Row label={t(standalone ? "账户名" : "账号")}>
              <span className="truncate font-mono text-meta">{record.username}</span>
              <CopyAction value={record.username} what={t(standalone ? "账户名" : "账号")} />
            </Row>
          )}

          {record.password && (
            <Row label={t(copy.password)}>
              <span className="truncate font-mono text-meta" data-credential-password="true">
                {reveal ? record.password : "•".repeat(12)}
              </span>
              <IconAction
                label={reveal ? t("隐藏") : t("显示")}
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </IconAction>
              <CopyAction value={record.password} what={t(copy.password)} />
            </Row>
          )}

          {record.note && (
            <div>
              <dt className="mb-1 text-2xs text-subtle">{t(standalone ? "敏感备注" : "备注")}</dt>
              <dd>
                <pre className="whitespace-pre-wrap rounded-md bg-canvas px-3 py-2 font-mono text-2xs text-ink">
                  {record.note}
                </pre>
              </dd>
            </div>
          )}

          <p className="pt-1 text-2xs text-subtle">
            {t("更新于")} <TimeAgo iso={record.updatedAt} />
          </p>
        </dl>
      )}
      <AccountTotp key={assetId} assetId={assetId} />
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-20 shrink-0 text-2xs text-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1.5">{children}</dd>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-subtle transition-colors duration-150 ease-out hover:bg-line hover:text-ink"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function CopyAction({ value, what }: { value: string; what: string }) {
  return (
    <IconAction
      label={t("复制{0}", what)}
      onClick={() => {
        void copyText(value)
          .then(() => toast(t("已复制{0}", what)))
          .catch(() => toast.error(t("复制失败，请重试")));
      }}
    >
      <Copy className="size-3.5" />
    </IconAction>
  );
}
