import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/app-shell";
import { startChunkRecovery } from "@/lib/chunk-reload";
import { isDesktop } from "@/lib/desktop";
import "@/styles.css";

// `is-desktop` turns on the window-chrome rules (drag strip, title-bar inset).
// It is set from the bridge, not from a build flag, so opening this bundle in a
// plain browser still lays out correctly.
if (isDesktop()) document.documentElement.classList.add("is-desktop");

startChunkRecovery();

const host = document.getElementById("root");
if (!host) throw new Error("缺少 #root 挂载点");

// No StrictMode on purpose: its double-invoked effects would open two SSH
// sessions per click, and the second one is a real connection to a real host.
createRoot(host).render(<AppShell />);
