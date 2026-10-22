/** @typedef {100 | 110 | 125 | 150} ZoomPercent */
/** @typedef {"in" | "out" | "reset"} ZoomCommand */
/** @type {readonly ZoomPercent[]} */
export const ZOOM_PERCENTS = Object.freeze([100, 110, 125, 150]);

/** @param {unknown} value @returns {ZoomPercent} */
export function validateZoomPercent(value) {
  if (typeof value !== "number" || !ZOOM_PERCENTS.includes(/** @type {ZoomPercent} */ (value))) {
    throw new Error("界面大小只能是 100%、110%、125% 或 150%。");
  }
  return /** @type {ZoomPercent} */ (value);
}

/** @param {unknown} value @returns {ZoomPercent} */
export function readZoomPercent(value) {
  try {
    return validateZoomPercent(value);
  } catch {
    return 100;
  }
}

/** @param {unknown} current @param {ZoomCommand} command @returns {ZoomPercent} */
export function stepZoomPercent(current, command) {
  if (command === "reset") return 100;
  const index = ZOOM_PERCENTS.indexOf(readZoomPercent(current));
  return ZOOM_PERCENTS[
    Math.max(0, Math.min(ZOOM_PERCENTS.length - 1, index + (command === "in" ? 1 : -1)))
  ];
}

/** @param {{key: string, control?: boolean, meta?: boolean, alt?: boolean}} input @returns {ZoomCommand | null} */
export function zoomCommandForKey(input) {
  if ((!input.control && !input.meta) || input.alt) return null;
  if (["+", "="].includes(input.key)) return "in";
  if (["-", "_"].includes(input.key)) return "out";
  return input.key === "0" ? "reset" : null;
}

/** 工作区坐标由 Electron 以 DIP 提供，不乘除系统 DPI。 */
/** @param {{x: number, y: number, width: number, height: number}} area */
export function initialWindowBounds(area) {
  // 原生窗口在分数 DPI 下会取整，四周留出 8 DIP 避免边框越界。
  const width = Math.min(1280, Math.max(1, Math.floor(area.width) - 16));
  const height = Math.min(800, Math.max(1, Math.floor(area.height) - 16));
  return {
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(620, height),
    x: Math.floor(area.x + (area.width - width) / 2),
    y: Math.floor(area.y + (area.height - height) / 2),
  };
}

/**
 * 设置面板、菜单与键盘共用队列；写盘失败时不改变实际显示。
 * @param {{read: () => unknown, save: (value: ZoomPercent) => Promise<unknown>, apply: (value: ZoomPercent) => void, publish: (state: {zoomPercent: ZoomPercent}) => void}} options
 */
export function createDisplayController({ read, save, apply, publish }) {
  let pending = Promise.resolve();
  const get = () => ({ zoomPercent: readZoomPercent(read()) });
  /** @param {() => ZoomPercent} resolve */
  const update = (resolve) => {
    const task = pending.then(async () => {
      const zoomPercent = resolve();
      await save(zoomPercent);
      apply(zoomPercent);
      const state = { zoomPercent };
      publish(state);
      return state;
    });
    pending = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  return {
    get,
    /** @param {unknown} value */
    set: (value) => update(() => validateZoomPercent(value)),
    /** @param {ZoomCommand} command */
    step: (command) => update(() => stepZoomPercent(read(), command)),
  };
}
