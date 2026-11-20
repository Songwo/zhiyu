import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Info } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "./button";

/** 页面说明按需展开，保留键盘访问与窄屏避让。 */
export function PageHelp({ children }: { children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("使用说明")} title={t("使用说明")}>
          <Info aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="page-help-content" sideOffset={6} collisionPadding={12}>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
