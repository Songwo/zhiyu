/** @typedef {"full" | "reduced" | "off"} MotionMode */

/** @param {unknown} value @returns {MotionMode} */
export function normalizeMotionMode(value) {
  return value === "reduced" || value === "off" ? value : "full";
}

/** 用户关闭优先；系统减少动态效果时，完整档也只保留轻量反馈。
 * @param {unknown} value
 */
export function effectiveMotionMode(value, systemReduced = false) {
  const mode = normalizeMotionMode(value);
  return mode === "full" && systemReduced ? "reduced" : mode;
}

/** 共用时序避免弹窗、页面和任务步骤各自使用不同节奏。
 * @param {MotionMode} mode
 */
export function motionPreset(mode, kind = "panel") {
  const full = mode === "full";
  return {
    initial:
      mode === "off"
        ? false
        : full
          ? kind === "step"
            ? { opacity: 0, x: -8 }
            : { opacity: 0, y: kind === "view" ? 8 : 14 }
          : { opacity: 0 },
    animate: full ? { opacity: 1, x: 0, y: 0 } : { opacity: 1 },
    transition: full
      ? { type: "spring", duration: kind === "step" ? 0.24 : 0.3, bounce: 0 }
      : { duration: mode === "off" ? 0 : 0.12 },
  };
}
