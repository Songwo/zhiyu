import { useState, type ReactNode } from "react";
import { resolveBrandIcon, type BrandIdentity } from "@/lib/brand-icons.mjs";
import { cn } from "@/lib/utils";

/** 内置资源离线可用；未知品牌和损坏图标回退，不请求第三方 favicon。 */
export function BrandIcon({
  identity,
  fallback = null,
  className,
}: {
  identity: BrandIdentity;
  fallback?: ReactNode;
  className?: string;
}) {
  const brand = resolveBrandIcon(identity);
  const [failed, setFailed] = useState("");
  if (!brand || failed === brand.file) return fallback;
  return (
    <span className={cn("builtin-brand-icon", className)} data-brand-icon={brand.id}>
      <img
        src={`${import.meta.env.BASE_URL}brands/${brand.file}`}
        alt=""
        draggable={false}
        onError={() => setFailed(brand.file)}
      />
    </span>
  );
}
