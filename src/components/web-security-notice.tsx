import { ShieldAlert } from "lucide-react";
import { t } from "@/lib/i18n";

/** Web 工作区常驻提醒；不能因确认一次而永久隐藏信任边界。 */
export function WebSecurityNotice() {
  return (
    <aside
      aria-label={t("Web 安全提醒")}
      className="mx-4 mt-3 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-2xs leading-relaxed text-ink sm:mx-6"
    >
      <details>
        <summary className="flex cursor-pointer items-start gap-2 font-medium">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          {t("Web 端存在浏览器与服务器风险，敏感资产建议优先使用桌面端。查看安全说明")}
        </summary>
        <p className="mt-2 text-muted">
          {t(
            "只访问自己信任的部署并使用 HTTPS，开启两步验证，避免公共设备和不可信浏览器扩展。密钥库在浏览器解锁后，恶意脚本或扩展仍可能读取明文；SSH、邮箱等服务端操作会将所需凭据交给服务器处理。服务器加密存储不等于端到端加密，管理员仍有能力访问。桌面端同样需要可信设备与更新。",
          )}
        </p>
      </details>
    </aside>
  );
}
