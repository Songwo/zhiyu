import { isWeb } from "@/lib/web";
import { openExternal } from "@/lib/web-bridge";
import { useEffect, useRef, useState } from "react";
import { Copy, Download, ExternalLink, Link2, Loader2, Puzzle, Unplug } from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { t } from "@/lib/i18n";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";

const RELEASES_URL = "https://github.com/Songwo/zhiyu/releases/latest";

export function ExtensionSettings() {
  const bridge = desktop()?.extension;
  const unlocked = useVault((s) => s.unlocked);
  const [status, setStatus] = useState<Awaited<ReturnType<NonNullable<typeof bridge>["status"]>>>();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    void desktop()
      ?.info()
      .then((info) => setVersion(info.version))
      .catch(() => {});
  }, []);

  // 与本机同版本的直链；拿不到版本或链接失败时回退到发布页。
  async function downloadExtension() {
    const url = version
      ? `https://github.com/Songwo/zhiyu/releases/download/v${version}/Zhiyu-${version}-browser-extension.zip`
      : RELEASES_URL;
    try {
      await desktop()?.openExternal(url);
      if (version) toast.success(t("已在浏览器开始下载；解压后在扩展管理页加载该目录。"));
    } catch {
      void desktop()?.openExternal(RELEASES_URL);
    }
  }

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let revision = 0;
    const invalidate = () => {
      generation.current++;
    };
    const refresh = () => {
      const current = ++revision;
      void bridge
        .status()
        .then((value) => {
          if (active && current === revision) {
            setStatus(value);
            if (!value.pairingPending) setPairing(undefined);
          }
        })
        .catch(() => {
          if (active) setError(t("插件连接状态读取失败"));
        });
    };
    const off = bridge.onChanged(refresh);
    const offVault = desktop()!.onVaultChanged(() => {
      invalidate();
      setPairing(undefined);
    });
    refresh();
    return () => {
      active = false;
      invalidate();
      off();
      offVault();
    };
  }, [bridge]);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(
      () => setPairing(undefined),
      Math.max(0, pairing.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pairing]);

  async function pair() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      if (!(await useVault.getState().require(t("配对浏览器插件需要先解锁密钥库。")))) return;
      const current = generation.current;
      const value = await bridge.beginPairing();
      if (current === generation.current && useVault.getState().unlocked) setPairing(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("插件配对失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-3">
        <Puzzle className="size-5 text-muted" />
        <h3 className="text-lg font-semibold">{t("浏览器插件")}</h3>
      </div>
      <div className="rounded-xl bg-canvas p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-meta font-semibold">{t("还没有装插件？")}</span>
          {version && (
            <span className="text-2xs text-subtle">{t("与本机 v{0} 配套", version)}</span>
          )}
        </div>
        <p className="mb-3 text-meta text-muted">
          {t(
            "① 点击下载并解压插件包；② 浏览器打开 chrome://extensions（Edge 为 edge://extensions）并开启开发者模式；③ 点击「加载已解压的扩展程序」，选择解压出的目录。",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void downloadExtension()}>
            <Download className="size-4" />
            {t("下载浏览器插件")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void openExternal(RELEASES_URL)}>
            <ExternalLink className="size-4" />
            {t("打开 GitHub 发布页")}
          </Button>
        </div>
      </div>
      <p className="text-meta leading-relaxed text-muted">
        {t(
          "配对并解锁后，登录页会建议本站账号，选择后填写，不自动提交登录。提交新账号时可确认保存；支持的在线文档会提示保存到知屿，点击后才读取当前可见正文。自动提示可在插件中关闭。",
        )}
      </p>
      <p className="text-meta leading-relaxed text-muted">
        {t(
          "已有 Chrome / Edge 密码可在「密钥库 → 浏览器密码」中通过 CSV 批量迁移。插件不会读取浏览器的原生密码库；知屿锁定后停止读取和填写账号。",
        )}
      </p>
      {!bridge ? (
        <p className="text-meta text-muted">
          {isWeb()
            ? t(
                "插件通过这台电脑上的本机端口与桌面版配对；网页版运行在远端服务器上，插件连不到它。需要在登录页自动填写账号时，请在这台电脑安装桌面版。",
              )
            : t("仅桌面版可用")}
        </p>
      ) : (
        <>
          <dl className="divide-y divide-line text-meta">
            <div className="flex items-center justify-between gap-3 py-3">
              <dt className="text-muted">{t("本机连接")}</dt>
              <dd>{status?.running ? t("已就绪") : status ? t("连接不可用") : t("加载中")}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-3">
              <dt className="text-muted">{t("已配对浏览器")}</dt>
              <dd>{status?.pairedClients ?? 0}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-3">
              <dt className="text-muted">{t("待确认账号")}</dt>
              <dd>{status?.pendingCount ?? 0}</dd>
            </div>
          </dl>
          {(error || status?.error) && (
            <p role="alert" className="text-meta text-down">
              {error || status?.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void pair()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
              {t("生成配对码")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || (!status?.pairedClients && !pairing)}
              onClick={() => {
                void bridge
                  .revoke()
                  .then(() => setPairing(undefined))
                  .catch(() => setError(t("断开插件失败")));
              }}
            >
              <Unplug className="size-4" />
              {t("断开全部插件")}
            </Button>
          </div>
          {pairing && unlocked && (
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between gap-2 text-meta">
                <label htmlFor="extension-pairing-code">{t("配对码")}</label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("复制配对码")}
                  title={t("复制配对码")}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(pairing.code)
                      .then(() => toast.success(t("已复制")))
                      .catch(() => setError(t("复制失败")));
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <textarea
                id="extension-pairing-code"
                readOnly
                value={pairing.code}
                spellCheck={false}
                className="w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 font-mono text-meta text-ink"
                rows={3}
              />
              <p className="text-meta text-muted">
                {t(
                  "有效期至 {0}，使用一次后失效",
                  new Date(pairing.expiresAt).toLocaleTimeString(),
                )}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
