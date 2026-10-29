#!/usr/bin/env node
/**
 * Run the desktop app in development: Vite serves the renderer on :8090,
 * Electron points at it once the port answers.
 *
 * Kept as a script rather than a `concurrently` dependency so the start order
 * is explicit — Electron must not open a window against a port that is not
 * listening yet, or it renders a Chromium error page and never retries.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildNativeTerminal } from "./build-native-terminal.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
buildNativeTerminal();
const PORT = 8090;
const HOST = "127.0.0.1";
const URL_ = `http://${HOST}:${PORT}/`;

const children = [];
function bye(code = 0) {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => bye(0));

function portOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port: PORT });
    socket.setTimeout(500);
    socket.on("connect", () => (socket.destroy(), resolve(true)));
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => (socket.destroy(), resolve(false)));
  });
}

const vite = spawn(
  process.execPath,
  [join(root, "node_modules/vite/bin/vite.js"), "--config", join(root, "vite.desktop.config.ts")],
  { cwd: root, stdio: "inherit" },
);
children.push(vite);
vite.on("exit", (code) => bye(code ?? 0));

for (let i = 0; i < 120; i += 1) {
  if (await portOpen()) break;
  await new Promise((r) => setTimeout(r, 250));
}

const electronBin = (await import("electron")).default;
const app = spawn(electronBin, [join(root, "electron/main.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, SINAN_DEV_URL: URL_ },
});
children.push(app);
app.on("exit", (code) => bye(code ?? 0));
