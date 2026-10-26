/**
 * 随机 UUID（v4）。crypto.randomUUID 只在 HTTPS 或 localhost 下存在，
 * 网页版经 http://局域网地址 打开时会缺失；getRandomValues 在任何页面都可用。
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
