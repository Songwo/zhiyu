/**
 * 升级后的旧页面：网页版换了镜像（或重新构建）后，已打开的标签页仍按旧文件名按需加载页面，
 * 服务器上已经没有这些文件，页面就会报错。此时刷新一次即可载入新版本。
 */
const KEY = "zhiyu-chunk-reload";

export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|module script.*MIME type/i.test(
    message,
  );
}

/** 刷新一次；30 秒内已经刷新过就不再刷新，避免服务器真的缺文件时陷入循环。 */
export function reloadForNewVersion(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    // 无痕模式等读不到时照常刷新一次。
  }
  if (Date.now() - last < 30_000) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // 同上。
  }
  location.reload();
  return true;
}

export function startChunkRecovery() {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}
