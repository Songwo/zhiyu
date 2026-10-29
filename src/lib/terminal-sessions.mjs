export const TERMINAL_PREVIEW = "__terminal_preview__";

/** 会话列表只在本次进程内保留，不写入资产文件，也不跨密钥库锁定恢复。 @param {string[]} ids @param {string} id */
export function openTerminalSession(ids, id) {
  return [
    ...ids.filter(
      (value) => value !== id && (value !== TERMINAL_PREVIEW || id === TERMINAL_PREVIEW),
    ),
    id,
  ];
}
/** @param {string[]} ids @param {string | null} active */
export function leaveTerminalSession(ids, active) {
  return {
    sshServerId: null,
    sshSessionIds: active === TERMINAL_PREVIEW ? ids.filter((id) => id !== active) : ids,
  };
}
/** @param {string[]} ids @param {string | null} active @param {string} id */
export function disconnectTerminalSession(ids, active, id) {
  return {
    sshServerId: active === id ? null : active,
    sshSessionIds: ids.filter((value) => value !== id),
  };
}
