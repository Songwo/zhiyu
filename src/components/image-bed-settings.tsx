import { useEffect, useState } from "react";
import { CloudUpload, Settings2 } from "lucide-react";
import { hostBridge } from "@/lib/web-bridge";
import { type ImageBedStatus } from "@/lib/image-bed";
import { Button } from "./ui/button";
export function ImageBedSettings({
  onStatusChange,
}: { onStatusChange?: (status: ImageBedStatus) => void } = {}) {
  const [status, setStatus] = useState<ImageBedStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void hostBridge()
      ?.images?.status()
      .then((s) => {
        setStatus(s);
        onStatusChange?.(s);
        setEnabled(s.enabled || !s.configured);
      })
      .catch(() => setError("图床配置读取失败"));
  }, [onStatusChange]);
  if (!hostBridge()) return <span className="text-xs text-muted">网页预览：图片保存在本机</span>;
  return (
    <div className="text-sm">
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(!open)}>
        <CloudUpload />
        {status?.enabled ? "图床上传已启用" : "本地嵌入"}
        <Settings2 className="size-3" />
      </Button>
      {open && (
        <div className="my-3 rounded-lg border border-line bg-card p-4">
          <h3 className="font-semibold">上传台图库</h3>
          <p className="mt-2 break-all text-xs text-muted">
            zensimagebed.pages.dev ·
            上传文档与资产图片。图片访问地址会随文档保存；已有本地图片不会自动上传。
          </p>
          <label className="mt-3 block text-xs">
            {status?.configured ? "替换 API Key（留空保留现有 Key）" : "API Key"}
            <input
              type="password"
              autoComplete="new-password"
              aria-label="图床 API Key"
              className="mt-2 w-full rounded-md border border-line bg-canvas p-2 text-sm"
              placeholder={status?.configured ? "已加密保存" : "zib_…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label className="my-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            新图片上传至我的图床
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await hostBridge()!.images.configure({
                  apiKey: key || undefined,
                  enabled,
                });
                setStatus(result);
                onStatusChange?.(result);
                setKey("");
                setOpen(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "保存中…" : "保存图床设置"}
          </Button>
          {error && (
            <p role="alert" className="mt-2 text-xs text-crit">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
