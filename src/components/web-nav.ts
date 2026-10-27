import { Gauge } from "lucide-react";
import { isWeb } from "@/lib/web";
import { NAV, type NavGroup } from "./sidebar";

/** 只在自托管网页版出现的页面；桌面版侧栏不变。 */
export const WEB_NAV: NavGroup["items"] = [{ id: "host", label: "主机监控", icon: Gauge }];
export const NAV_ALL = isWeb() ? [...NAV, ...WEB_NAV] : NAV;
