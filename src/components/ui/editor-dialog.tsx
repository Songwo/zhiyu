import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { t } from "@/lib/i18n";
import { m } from "motion/react";
import { useMotionPolicy } from "@/lib/motion";

export function EditorDialog({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const motionMode = useMotionPolicy();
  const duration = motionMode === "off" ? 0 : motionMode === "reduced" ? 0.12 : 0.2;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <m.div
            className="editor-backdrop"
            initial={motionMode === "off" ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration }}
          />
        </Dialog.Overlay>
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // 嵌套在设置里时，仅关闭最上层，避免同一次按键穿透到父页面。
            event.preventDefault();
            onClose();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            requestAnimationFrame(() => {
              const dialogs = document.querySelectorAll<HTMLElement>(
                '[role="dialog"]:not([data-state="closed"]):not([data-shown="false"])',
              );
              const topDialog = dialogs.item(dialogs.length - 1);
              if (target?.isConnected && (!topDialog || topDialog.contains(target))) {
                target.focus({ preventScroll: true });
              }
            });
          }}
        >
          <m.div
            className="editor-dialog"
            style={{ x: "-50%", y: "-50%" }}
            initial={
              motionMode === "off" ? false : { opacity: 0, scale: motionMode === "full" ? 0.97 : 1 }
            }
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="editor-heading">
              <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
              <Dialog.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label={closeLabel ?? t("关闭")}
                >
                  <X />
                </Button>
              </Dialog.Close>
            </div>
            {children}
          </m.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
