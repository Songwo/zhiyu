import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTerminalAppearance,
  terminalPalette,
  terminalColor,
  TERMINAL_DEFAULTS,
  legacyTerminalAppearance,
  migrateTerminalAppearance,
} from "../src/lib/terminal-appearance.mjs";

test("终端设置：非法配置恢复默认，字号保持安全边界", () => {
  assert.deepEqual(normalizeTerminalAppearance(null), TERMINAL_DEFAULTS);
  assert.deepEqual(
    normalizeTerminalAppearance({ font: "unknown", fontSize: NaN, theme: "__proto__" }),
    TERMINAL_DEFAULTS,
  );
  assert.equal(normalizeTerminalAppearance({ fontSize: 100 }).fontSize, 22);
  assert.equal(normalizeTerminalAppearance({ fontSize: -10 }).fontSize, 11);
});
test("终端设置迁入统一设置时保留旧字体、字号与配色", () => {
  assert.deepEqual(
    legacyTerminalAppearance({
      getItem: () => JSON.stringify({ font: "consolas", fontSize: 18, theme: "paper" }),
    }),
    { ...TERMINAL_DEFAULTS, font: "consolas", fontSize: 18, theme: "paper" },
  );
  assert.deepEqual(legacyTerminalAppearance({ getItem: () => "broken" }), TERMINAL_DEFAULTS);
  assert.deepEqual(
    legacyTerminalAppearance({
      getItem: () => {
        throw new Error("storage denied");
      },
    }),
    TERMINAL_DEFAULTS,
  );
});
test("终端交互默认竖线光标闪烁、自动跟随，历史行数只接受约定档位", () => {
  assert.equal(TERMINAL_DEFAULTS.cursorBlink, true);
  assert.equal(TERMINAL_DEFAULTS.cursorStyle, "bar");
  assert.equal(normalizeTerminalAppearance({ cursorStyle: "block" }).cursorStyle, "block");
  assert.equal(normalizeTerminalAppearance({ cursorStyle: "beam" }).cursorStyle, "bar");
  assert.equal(normalizeTerminalAppearance({ cursorBlink: false }).cursorBlink, false);
  assert.equal(
    normalizeTerminalAppearance({ cursorBlink: true, autoFollow: false, scrollback: 20000 })
      .scrollback,
    20000,
  );
  assert.equal(
    normalizeTerminalAppearance({ cursorBlink: true, autoFollow: false }).cursorBlink,
    true,
  );
  assert.equal(normalizeTerminalAppearance({ autoFollow: false }).autoFollow, false);
  assert.equal(normalizeTerminalAppearance({ scrollback: Infinity }).scrollback, 5000);
  assert.equal(normalizeTerminalAppearance({ scrollback: {} }).scrollback, 5000);
});
test("旧版保存的常亮光标迁移为闪烁，新版选择保持不变", () => {
  assert.equal(migrateTerminalAppearance({ cursorBlink: false, fontSize: 16 }).cursorBlink, true);
  assert.equal(migrateTerminalAppearance({ cursorBlink: false, fontSize: 16 }).fontSize, 16);
  assert.equal(
    migrateTerminalAppearance({ cursorBlink: false, cursorStyle: "block" }).cursorBlink,
    false,
  );
  assert.deepEqual(migrateTerminalAppearance(null), TERMINAL_DEFAULTS);
});
test("终端跟随软件颜色，独立配色在切换软件主题时保持稳定", () => {
  assert.equal(terminalColor("#fff", "#000000"), "#ffffff");
  assert.equal(terminalColor("rgb(32, 32, 30)", "#000000"), "#20201e");
  const palette = terminalPalette({ theme: "system" }, "dark", {
    background: "#222220",
    foreground: "#eeeeec",
  });
  assert.equal(palette.background, "#222220");
  assert.equal(palette.foreground, "#eeeeec");
  assert.equal(palette.colors[7], "#eeeeec");
  assert.deepEqual(
    terminalPalette({ theme: "paper" }, "dark"),
    terminalPalette({ theme: "paper" }, "light"),
  );
  assert.notEqual(
    terminalPalette({ theme: "system" }, "dark").background,
    terminalPalette({ theme: "system" }, "light").background,
  );
});
test("原生终端与网页终端共享 ANSI 高亮和字体设置", () => {
  const palette = terminalPalette({ font: "consolas", fontSize: 18, theme: "dusk" });
  assert.equal(palette.colors.length, 16);
  assert.equal(palette.xterm.red, palette.colors[1]);
  assert.ok(palette.nativeFont.includes("Consolas"));
  assert.equal(palette.fontSize, 18);
});
