import { t } from "@/lib/i18n";
import { BRAND_MARK } from "@/lib/brand-mark.mjs";

/** 界面与安装图标共用同一透明标记：书页成屿、朝阳与海浪，浅深主题都清晰可辨。 */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  const m = BRAND_MARK;
  return (
    <svg viewBox={m.viewBox} className={className} fill="none" aria-hidden="true">
      <circle cx={m.sun.cx} cy={m.sun.cy} r={m.sun.r} fill={m.glow} />
      <path d={m.pageLeft} fill={m.page} />
      <path d={m.pageRight} fill={m.pageShade} />
      <path d={m.wavePath} stroke={m.waveColor} strokeWidth={3.4} strokeLinecap="round" />
    </svg>
  );
}

export function LogoWord() {
  return (
    <div className="flex items-center gap-3">
      <LogoMark />
      <div className="leading-tight">
        <div className="text-lg font-bold tracking-wordmark">{t("知屿")}</div>
        <div className="text-2xs text-muted">{t("个人知识与资产空间")}</div>
      </div>
    </div>
  );
}
