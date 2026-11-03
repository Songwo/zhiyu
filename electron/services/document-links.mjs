// 编辑器与持久化共用同一规则，避免可粘贴的链接在保存时被拒绝。
/** @param {string} value */
export function documentLink(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
