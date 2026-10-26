/** @typedef {{lastSeen?: unknown, probedAt?: unknown, probeError?: unknown, status?: string, collect?: boolean}} ServerObservation */

/** 新记录明确以空 lastSeen 表示尚无指标；旧数据缺字段时保留历史行为。 @param {ServerObservation} server */
export function hasServerMetrics(server) {
  return server.lastSeen !== "";
}

/** 已尝试采集也属于已知状态，首次失败仍需展示真实错误。 @param {ServerObservation} server */
export function hasServerObservation(server) {
  if (isCollectionPaused(server)) return false;
  return hasServerMetrics(server) || Boolean(server.probedAt || server.probeError);
}

/** @param {ServerObservation} server */
export function serverNeedsAttention(server) {
  return hasServerObservation(server) && server.status !== "online";
}

/** 用户为这台主机关闭了自动采集（例如本机连不上），不探测、不告警。 @param {{collect?: boolean}} server */
export function isCollectionPaused(server) {
  return server.collect === false;
}

/** @param {{sshConfigured?: boolean, collect?: boolean}} server */
export function canProbeServer(server) {
  return server.sshConfigured !== false && !isCollectionPaused(server);
}
