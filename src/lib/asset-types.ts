import {
  BookOpen,
  Box,
  Camera,
  Car,
  Cloud,
  CreditCard,
  Database,
  Gamepad2,
  Globe,
  House,
  KeyRound,
  Mail,
  Package,
  Phone,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { AssetType, AssetTypeField, ServiceAsset } from "./types";

/** 类型可选的图标，键和主进程校验的列表一致。 */
export const TYPE_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  box: { icon: Box, label: "盒子" },
  key: { icon: KeyRound, label: "钥匙" },
  cloud: { icon: Cloud, label: "云" },
  database: { icon: Database, label: "存储" },
  globe: { icon: Globe, label: "网络" },
  phone: { icon: Phone, label: "电话" },
  mail: { icon: Mail, label: "邮件" },
  shield: { icon: ShieldCheck, label: "安全" },
  wrench: { icon: Wrench, label: "工具" },
  book: { icon: BookOpen, label: "书本" },
  camera: { icon: Camera, label: "相机" },
  car: { icon: Car, label: "车辆" },
  home: { icon: House, label: "家" },
  card: { icon: CreditCard, label: "卡片" },
  gamepad: { icon: Gamepad2, label: "游戏" },
  package: { icon: Package, label: "包裹" },
};

export const typeIcon = (key: string | undefined): LucideIcon => TYPE_ICONS[key ?? ""]?.icon ?? Box;

export const FIELD_KIND_LABEL: Record<AssetTypeField["kind"], string> = {
  text: "文本",
  url: "链接",
  date: "日期",
  number: "数字",
};

export const MAX_TYPE_FIELDS = 12;

export const newId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

export function typeOf(
  types: AssetType[] | undefined,
  service: Pick<ServiceAsset, "typeId">,
): AssetType | undefined {
  return service.typeId ? types?.find((type) => type.id === service.typeId) : undefined;
}

/** 按类型里字段的顺序列出这项资产已填写的字段。 */
export function fieldRows(
  type: AssetType | undefined,
  service: Pick<ServiceAsset, "fields">,
): Array<AssetTypeField & { value: string }> {
  if (!type || !service.fields) return [];
  return type.fields.flatMap((field) => {
    const value = service.fields?.[field.id];
    return value ? [{ ...field, value }] : [];
  });
}

/** 链接字段只接受 http(s)，其余原样显示为文本。 */
export const safeHref = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};
