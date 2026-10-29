export const TERMINAL_FONTS = {
  cascadia: {
    label: "Cascadia Mono",
    family: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
    native: "Cascadia Mono, Consolas, Microsoft YaHei UI",
  },
  consolas: {
    label: "Consolas",
    family: 'Consolas, "Microsoft YaHei UI", monospace',
    native: "Consolas, Microsoft YaHei UI",
  },
  jetbrains: {
    label: "JetBrains Mono",
    family: '"JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
    native: "JetBrains Mono, Consolas, Microsoft YaHei UI",
  },
};
export const TERMINAL_THEMES = { system: "跟随软件", dusk: "柔和暗色", paper: "暖纸护眼" };
export const TERMINAL_CURSORS = { bar: "竖线", block: "方块", underline: "下划线" };
/** @typedef {{font: keyof typeof TERMINAL_FONTS, fontSize: number, theme: keyof typeof TERMINAL_THEMES, cursorStyle: keyof typeof TERMINAL_CURSORS, cursorBlink: boolean, autoFollow: boolean, scrollback: number}} TerminalPreferences */
/** @type {TerminalPreferences} */
export const TERMINAL_DEFAULTS = {
  font: "cascadia",
  fontSize: 14,
  theme: "system",
  cursorStyle: "bar",
  cursorBlink: true,
  autoFollow: true,
  scrollback: 5000,
};

/** 迁移早期终端页独立保存的外观；不可读时保留默认配置。 @param {{getItem(key: string): string | null} | undefined} storage */
export function legacyTerminalAppearance(storage) {
  try {
    return migrateTerminalAppearance(
      JSON.parse(storage?.getItem("zhiyu-terminal-appearance-v1") || "null"),
    );
  } catch {
    return normalizeTerminalAppearance(null);
  }
}

/** 光标样式之前保存的配置把当时默认的“常亮”一并写入，迁移时改为新的闪烁默认值。 @param {unknown} input */
export function migrateTerminalAppearance(input) {
  return normalizeTerminalAppearance(
    input && typeof input === "object" && !Object.hasOwn(input, "cursorStyle")
      ? { ...input, cursorBlink: true }
      : input,
  );
}

/** @param {unknown} input @returns {TerminalPreferences} */
export function normalizeTerminalAppearance(input) {
  const value =
    input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  return {
    cursorStyle:
      typeof value.cursorStyle === "string" && Object.hasOwn(TERMINAL_CURSORS, value.cursorStyle)
        ? /** @type {keyof typeof TERMINAL_CURSORS} */ (value.cursorStyle)
        : TERMINAL_DEFAULTS.cursorStyle,
    cursorBlink: value.cursorBlink !== false,
    autoFollow: value.autoFollow !== false,
    scrollback:
      typeof value.scrollback === "number" && [1000, 5000, 10000, 20000].includes(value.scrollback)
        ? value.scrollback
        : TERMINAL_DEFAULTS.scrollback,
    font:
      typeof value.font === "string" && Object.hasOwn(TERMINAL_FONTS, value.font)
        ? /** @type {keyof typeof TERMINAL_FONTS} */ (value.font)
        : TERMINAL_DEFAULTS.font,
    fontSize:
      typeof value?.fontSize === "number" && Number.isFinite(value.fontSize)
        ? Math.max(11, Math.min(22, Math.round(value.fontSize)))
        : TERMINAL_DEFAULTS.fontSize,
    theme:
      typeof value.theme === "string" && Object.hasOwn(TERMINAL_THEMES, value.theme)
        ? /** @type {keyof typeof TERMINAL_THEMES} */ (value.theme)
        : TERMINAL_DEFAULTS.theme,
  };
}

const darkAnsi = [
  "#353532",
  "#e08a86",
  "#9fc098",
  "#d1bd88",
  "#9bb7dc",
  "#c3a6c6",
  "#8cbfc0",
  "#d8d8d1",
  "#999990",
  "#edaaa3",
  "#bad5ae",
  "#e2d0a1",
  "#b8ccec",
  "#d9bdd9",
  "#a8d8d4",
  "#f0eee6",
];
const lightAnsi = [
  "#353532",
  "#a34b45",
  "#477345",
  "#80621d",
  "#3d6395",
  "#805682",
  "#337578",
  "#42423d",
  "#72726a",
  "#a54b43",
  "#467346",
  "#81651e",
  "#45699e",
  "#805383",
  "#2c7376",
  "#20201d",
];

/** @param {string | undefined} color @param {string} fallback */
export function terminalColor(color, fallback) {
  if (color && /^#[\da-f]{6}$/i.test(color)) return color;
  if (color && /^#[\da-f]{3}$/i.test(color))
    return (
      "#" +
      color
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    );
  const rgb = color?.match(/^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/);
  if (rgb && rgb.slice(1).every((c) => Number(c) <= 255))
    return (
      "#" +
      rgb
        .slice(1)
        .map((c) => Number(c).toString(16).padStart(2, "0"))
        .join("")
    );
  return fallback;
}

/** @param {unknown} settings @param {string} [resolved] @param {{background?: string, foreground?: string}} [tokens] */
export function terminalPalette(settings, resolved = "light", tokens = {}) {
  const config = normalizeTerminalAppearance(settings);
  const dark = config.theme === "dusk" || (config.theme === "system" && resolved === "dark");
  const background =
    config.theme === "system"
      ? terminalColor(tokens.background, dark ? "#20201e" : "#ffffff")
      : dark
        ? "#242622"
        : "#f5f1e7";
  const foreground =
    config.theme === "system"
      ? terminalColor(tokens.foreground, dark ? "#ececea" : "#1b1b19")
      : dark
        ? "#d8dbd2"
        : "#45443b";
  const colors = [...(dark ? darkAnsi : lightAnsi)];
  colors[7] = foreground;
  const names = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ];
  return {
    background,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
    autoFollow: config.autoFollow,
    scrollback: config.scrollback,
    foreground,
    colors,
    fontFamily: TERMINAL_FONTS[config.font].family,
    nativeFont: TERMINAL_FONTS[config.font].native,
    fontSize: config.fontSize,
    xterm: {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: dark ? "#68706080" : "#a6b79b66",
      ...Object.fromEntries(names.map((name, i) => [name, colors[i]])),
    },
  };
}
