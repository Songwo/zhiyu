import { hostedImageUrl } from "../../electron/services/hosted-image.mjs";
import { uploadImage } from "@/lib/image-bed";
import { ImageBedSettings } from "./image-bed-settings";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImagePlus, Loader2, Trash2, UserRound } from "lucide-react";
import { safeImageDataUrl } from "../../electron/services/image-data.mjs";
import { prepareImage } from "@/lib/user-images";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { BrandIcon } from "./brand-icon";
import type { BrandIdentity } from "@/lib/brand-icons.mjs";

export function AssetImage({
  value,
  fallback,
  brand,
}: {
  value?: string;
  fallback: ReactNode;
  brand?: BrandIdentity;
}) {
  const image = useMemo(() => hostedImageUrl(value) || safeImageDataUrl(value), [value]);
  const [failed, setFailed] = useState<string | null>(null);
  return image && failed !== image ? (
    <img
      referrerPolicy="no-referrer"
      src={image}
      alt={t("资产图片")}
      className="size-10 shrink-0 rounded-md object-cover"
      onError={() => setFailed(image)}
    />
  ) : brand ? (
    <BrandIcon identity={brand} fallback={fallback} />
  ) : (
    fallback
  );
}

export function ImagePicker({
  value,
  onChange,
  avatar = false,
  disabled = false,
  onBusyChange,
  label: customLabel,
  brand,
}: {
  value?: string;
  onChange: (value: string) => void;
  avatar?: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  label?: string;
  brand?: BrandIdentity;
}) {
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const image = useMemo(() => hostedImageUrl(value) || safeImageDataUrl(value), [value]);
  const label = customLabel ?? t(avatar ? "个人头像" : "资产图片");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  return (
    <div className="space-y-2">
      <div className="text-meta font-medium text-muted">{label}</div>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid size-16 shrink-0 place-items-center overflow-hidden border border-line bg-canvas text-muted",
            avatar ? "rounded-full" : "rounded-md",
          )}
        >
          {image ? (
            <img src={image} alt={label} className="size-full object-cover" />
          ) : avatar ? (
            <UserRound className="size-6" />
          ) : (
            <BrandIcon identity={brand ?? {}} fallback={<ImagePlus className="size-6" />} />
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={label}
          className="hidden"
          disabled={busy || disabled}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            onBusyChange?.(true);
            setError("");
            try {
              const result = await prepareImage(file, avatar ? 256 : 512);
              const saved = avatar ? result : await uploadImage(result, file.name, "asset");
              if (alive.current) onChange(saved);
            } catch (cause) {
              if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              if (alive.current) {
                setBusy(false);
                onBusyChange?.(false);
              }
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => input.current?.click()}
          title={t(image ? "更换图片" : "上传图片")}
          aria-label={t(image ? "更换图片" : "上传图片")}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          {t(image ? "更换图片" : "上传图片")}
        </Button>
        {image && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy || disabled}
            title={t("移除图片")}
            aria-label={t("移除图片")}
            onClick={() => {
              setError("");
              onChange("");
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {!avatar && brand && !image && (
        <p className="text-meta text-muted">
          {t("已识别的品牌使用内置图标，上传图片可自行替换。")}
        </p>
      )}
      {!avatar && <ImageBedSettings />}
      {error && (
        <p role="alert" className="text-meta text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
