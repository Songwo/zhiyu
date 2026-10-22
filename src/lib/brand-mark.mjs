/**
 * 知屿标记：一本摊开的书像浮在海面的小岛，右上方一轮初升的太阳，前面一道海浪。
 * 没有底板，透明背景；配色在浅色与深色背景上都能看清。
 * 同一几何用于界面、安装图标、网站图标与浏览器插件。
 */
export const BRAND_MARK = {
  /** 只取图形所在的区域，透明图标里标记尽量撑满。 */
  viewBox: "8 8 48 48",
  pageLeft: "M31 34.4C26.2 30 18.6 28.6 10 30.2V41.8C18.6 40.4 26 41.6 31 45.8Z",
  pageRight: "M33 34.4C37.8 30 45.4 28.6 54 30.2V41.8C45.4 40.4 38 41.6 33 45.8Z",
  wavePath: "M12.5 51C17.6 48.1 22.8 48.1 28 51S38.4 53.9 43.6 51S50.2 48.9 51.5 48.9",
  sun: { cx: 45.5, cy: 19, r: 5.2 },
  page: "#3B6FE0",
  pageShade: "#8DB0F5",
  waveColor: "#2BB3C0",
  glow: "#FFB23F",
};

/** 输出独立的 SVG 文本（透明背景）。 */
export function brandSvg() {
  const m = BRAND_MARK;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m.viewBox}" width="64" height="64" fill="none">
<circle cx="${m.sun.cx}" cy="${m.sun.cy}" r="${m.sun.r}" fill="${m.glow}"/><path d="${m.pageLeft}" fill="${m.page}"/><path d="${m.pageRight}" fill="${m.pageShade}"/><path d="${m.wavePath}" stroke="${m.waveColor}" stroke-width="3.4" stroke-linecap="round"/></svg>`;
}
