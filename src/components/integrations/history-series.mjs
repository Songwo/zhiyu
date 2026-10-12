/**
 * 历史 API 最多返回 720 点，以实际采样步长识别空档，避免把七日下采样当成离线。
 * @template {{at: string}} T
 * @param {readonly T[]} samples
 * @param {number} expectedStepMs
 */
export function historySeries(samples, expectedStepMs = 30000) {
  const sorted = samples
    .map((sample) => ({ ...sample, time: Date.parse(sample.at) }))
    .filter((sample) => Number.isFinite(sample.time))
    .sort((a, b) => a.time - b.time);
  const steps = sorted
    .slice(1)
    .map((sample, index) => sample.time - sorted[index].time)
    .filter((step) => step > 0)
    .sort((a, b) => a - b);
  // 服务端每 30 秒保留一个主机样本；90 秒以内的抖动不推断为离线。
  const typicalStep =
    sorted.length < 720
      ? expectedStepMs
      : (steps[Math.floor((steps.length - 1) / 2)] ?? expectedStepMs);
  const threshold = Math.max(90000, typicalStep * 2.5);
  /** @type {Array<(T & {time: number}) | {at: string, time: number, cpu: null, memory: null, disk: null, latencyMs: null}>} */
  const result = [];
  for (const sample of sorted) {
    const previous = result.at(-1);
    if (previous && sample.time - previous.time > threshold) {
      result.push({
        at: new Date(previous.time + 1).toISOString(),
        time: previous.time + 1,
        cpu: null,
        memory: null,
        disk: null,
        latencyMs: null,
      });
    }
    result.push(sample);
  }
  return result;
}
