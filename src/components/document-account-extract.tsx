import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, Fingerprint, Loader2, LockKeyhole, ScanText } from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/lib/desktop";
import { documentAccountsApi } from "@/lib/web-document-accounts";
import { useDocuments } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { useVault } from "@/lib/vault-state";
import { Button } from "./ui/button";
import { EditorDialog } from "./ui/editor-dialog";
import { Field, Input, Textarea } from "./ui/input";
import "./document-account-extract.css";

type ExtractBridge = NonNullable<ReturnType<typeof documentAccountsApi>>;
type Preview = Awaited<ReturnType<ExtractBridge["preview"]>>;
type Candidate = Preview["candidates"][number];
type Result = Awaited<ReturnType<ExtractBridge["commit"]>>;

/** 文本解析在桌面主进程或浏览器本地执行；预览密码只存在当前弹窗内。 */
export function DocumentAccountExtract({
  documentId,
  close,
}: {
  documentId: string;
  close: () => void;
}) {
  const bridge = documentAccountsApi();
  const unlocked = useVault((state) => state.unlocked);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [result, setResult] = useState<(Omit<Result, "assets"> & { firstAssetId?: string }) | null>(
    null,
  );
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const ticket = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      generation.current++;
    };
    const clear = () => {
      invalidate();
      const current = ticket.current;
      ticket.current = null;
      setPreview(null);
      setCandidates([]);
      setSelected([]);
      setRevealed([]);
      setResult(null);
      setError("");
      setBusy(null);
      if (current) void bridge?.cancel(current).catch(() => {});
    };
    const off = useVault.subscribe((state, previous) => {
      if (!state.unlocked && previous.unlocked) clear();
    });
    const offVault = desktop()?.onVaultChanged(clear);
    return () => {
      alive.current = false;
      invalidate();
      off();
      offVault?.();
      const current = ticket.current;
      ticket.current = null;
      if (current) void bridge?.cancel(current).catch(() => {});
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !unlocked) return;
    const current = ++generation.current;
    const previous = ticket.current;
    ticket.current = null;
    if (previous) void bridge.cancel(previous).catch(() => {});
    setBusy("preview");
    setError("");
    setPreview(null);
    setCandidates([]);
    setSelected([]);
    setRevealed([]);
    setResult(null);
    void (async () => {
      try {
        const docs = useDocuments.getState();
        if (docs.drafts[documentId]) await docs.flush(documentId);
        if (!alive.current || current !== generation.current || !useVault.getState().unlocked)
          return;
        const value = await bridge.preview(documentId);
        if (!alive.current || current !== generation.current || !useVault.getState().unlocked) {
          void bridge.cancel(value.ticket).catch(() => {});
          return;
        }
        ticket.current = value.ticket;
        setPreview(value);
        setCandidates(value.candidates);
        setSelected(value.candidates.map((item) => item.id));
      } catch (caught) {
        if (alive.current && current === generation.current)
          setError(caught instanceof Error ? caught.message : t("文档账号解析失败，请重试。"));
      } finally {
        if (alive.current && current === generation.current) setBusy(null);
      }
    })();
  }, [bridge, documentId, unlocked, attempt]);

  async function commit() {
    if (!bridge || !ticket.current || busy || !selected.length || !unlocked) return;
    const current = generation.current;
    setBusy("commit");
    setError("");
    try {
      const value = await bridge.commit({
        ticket: ticket.current,
        candidates: candidates.filter((item) => selected.includes(item.id)),
      });
      await useAppStore.setState((state) => ({
        secrets: [
          ...state.secrets,
          ...value.assets.filter((asset) => !state.secrets.some((item) => item.id === asset.id)),
        ],
      }));
      if (!alive.current || current !== generation.current || !useVault.getState().unlocked) return;
      ticket.current = null;
      setPreview(null);
      setCandidates([]);
      setSelected([]);
      setRevealed([]);
      const { assets, ...counts } = value;
      setResult({ ...counts, firstAssetId: assets[0]?.id });
      if (!value.bindingError) toast.success(t("账号已保存并关联到文档"));
    } catch (caught) {
      if (alive.current && current === generation.current)
        setError(caught instanceof Error ? caught.message : t("保存文档账号失败，请重试。"));
    } finally {
      if (alive.current && current === generation.current) setBusy(null);
    }
  }

  function dismiss() {
    generation.current++;
    const current = ticket.current;
    ticket.current = null;
    setCandidates([]);
    setPreview(null);
    setSelected([]);
    setRevealed([]);
    if (current) void bridge?.cancel(current).catch(() => {});
    close();
  }

  function patch(id: string, values: Partial<Candidate>) {
    setCandidates((items) => items.map((item) => (item.id === id ? { ...item, ...values } : item)));
  }

  return (
    <EditorDialog title={t("从文档提取账号")} onClose={dismiss}>
      <div className="editor-scroll document-extract">
        <div className="document-extract-intro">
          <ScanText className="size-5" />
          <p>{t("在本机识别网址、账号和密码。逐项核对后保存到密钥库，并关联当前文档。")}</p>
        </div>
        {!unlocked ? (
          <div className="document-extract-notice">
            <p>{t("解锁密钥库后可解析并保存文档中的账号。")}</p>
            <Button
              variant="outline"
              onClick={() =>
                void useVault
                  .getState()
                  .require(t("提取文档账号需要先解锁密钥库。"))
                  .catch(() => setError(t("解锁失败，请重试。")))
              }
            >
              <LockKeyhole />
              {t("解锁密钥库")}
            </Button>
          </div>
        ) : busy === "preview" ? (
          <p className="document-extract-status" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("正在本机解析文档…")}
          </p>
        ) : result ? (
          <div className="document-extract-result">
            <Check className="size-6" />
            <h3>{t("账号保存结果")}</h3>
            <p>{t("新增 {0} 项账号，复用 {1} 项已有账号。", result.added, result.existing)}</p>
            {result.bindingError ? (
              <p className="document-extract-error" role="alert">
                {t("账号已保存，但文档关联未完成：{0}", result.bindingError)}
              </p>
            ) : (
              <p>{t("已建立账号与这篇文档的关联。")}</p>
            )}
            {result.firstAssetId && (
              <Button
                variant="outline"
                onClick={() => {
                  useAppStore.getState().setExpanded({
                    kind: "secret",
                    id: result.firstAssetId!,
                    origin: { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0 },
                  });
                  dismiss();
                }}
              >
                <Fingerprint />
                {t("查看已保存账号")}
              </Button>
            )}
          </div>
        ) : preview ? (
          <>
            <p className="document-extract-source">{preview.documentTitle}</p>
            <p className="document-extract-note">
              {t("相同网址、账号和密码会复用已有记录；密码不同会新增独立账号，不会覆盖原密码。")}
            </p>
            {preview.warnings.length > 0 && (
              <ul className="document-extract-warnings">
                {preview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
            {candidates.length ? (
              <>
                <label className="document-extract-all">
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    checked={selected.length === candidates.length}
                    onChange={(event) =>
                      setSelected(event.target.checked ? candidates.map((item) => item.id) : [])
                    }
                  />
                  {t("选择全部 {0} 项账号", candidates.length)}
                </label>
                <div className="document-extract-list">
                  {candidates.map((candidate, index) => (
                    <article className="document-extract-card" key={candidate.id}>
                      <label className="document-extract-card-heading">
                        <input
                          type="checkbox"
                          disabled={!!busy}
                          checked={selected.includes(candidate.id)}
                          onChange={(event) =>
                            setSelected((items) =>
                              event.target.checked
                                ? [...items, candidate.id]
                                : items.filter((id) => id !== candidate.id),
                            )
                          }
                          aria-label={t("选择待导入账号 {0}", index + 1)}
                        />
                        <strong>{t("账号 {0}", index + 1)}</strong>
                      </label>
                      <Field label={t("账号名称")}>
                        <Input
                          aria-label={t("账号 {0} 名称", index + 1)}
                          value={candidate.name}
                          disabled={!!busy}
                          onChange={(event) => patch(candidate.id, { name: event.target.value })}
                        />
                      </Field>
                      <Field label={t("登录网址")}>
                        <Input
                          aria-label={t("账号 {0} 登录网址", index + 1)}
                          value={candidate.url}
                          disabled={!!busy}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(event) => patch(candidate.id, { url: event.target.value })}
                        />
                      </Field>
                      <Field label={t("账户名")}>
                        <Input
                          aria-label={t("账号 {0} 账户名", index + 1)}
                          value={candidate.username}
                          disabled={!!busy}
                          autoComplete="off"
                          onChange={(event) =>
                            patch(candidate.id, { username: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={t("密码")}>
                        <div className="document-extract-password">
                          <Input
                            aria-label={t("账号 {0} 密码", index + 1)}
                            type={revealed.includes(candidate.id) ? "text" : "password"}
                            value={candidate.password}
                            disabled={!!busy}
                            autoComplete="new-password"
                            onChange={(event) =>
                              patch(candidate.id, { password: event.target.value })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t(
                              revealed.includes(candidate.id) ? "隐藏密码" : "显示密码",
                            )}
                            onClick={() =>
                              setRevealed((items) =>
                                items.includes(candidate.id)
                                  ? items.filter((id) => id !== candidate.id)
                                  : [...items, candidate.id],
                              )
                            }
                          >
                            {revealed.includes(candidate.id) ? <EyeOff /> : <Eye />}
                          </Button>
                        </div>
                      </Field>
                      <Field label={t("备注")}>
                        <Textarea
                          aria-label={t("账号 {0} 备注", index + 1)}
                          value={candidate.note}
                          disabled={!!busy}
                          onChange={(event) => patch(candidate.id, { note: event.target.value })}
                        />
                      </Field>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p className="document-extract-note">
                {t(
                  "没有识别到可保存的账号。可在文档中使用“网址、账号、密码”等明确字段后重新解析。",
                )}
              </p>
            )}
          </>
        ) : null}
        {error && (
          <div className="document-extract-notice">
            <p className="document-extract-error" role="alert">
              {error}
            </p>
            {!busy && (
              <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                {t("重新解析文档")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="editor-footer document-extract-footer">
        <Button variant="ghost" onClick={dismiss}>
          {t(result ? "关闭" : "取消")}
        </Button>
        {!result && preview && (
          <Button disabled={!!busy || !selected.length} onClick={() => void commit()}>
            {busy === "commit" && <Loader2 className="animate-spin" />}
            {t("保存并关联 {0} 项账号", selected.length)}
          </Button>
        )}
      </div>
    </EditorDialog>
  );
}
