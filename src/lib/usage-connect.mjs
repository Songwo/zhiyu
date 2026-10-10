/**
 * 验证失败保留已加密保存的来源，由用户在来源卡片中重试。
 * @param {Pick<import("./usage").UsageBridge, "add" | "refresh"> & Partial<Pick<import("./usage").UsageBridge, "update">>} api
 * @param {Record<string, string>} input
 * @param {string} [id]
 */
export async function saveAndVerifyUsageSource(api, input, id) {
  if (id && !api.update) throw new Error("当前桌面端不支持编辑来源，请更新后重试。");
  const source = id && api.update ? await api.update(id, input) : await api.add(input);
  try {
    await api.refresh(source.id);
    return { source, verified: true, error: "" };
  } catch (error) {
    return {
      source,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 只缓存主进程已经解析的节点详情；采集失败不更换成功采样时间。
 * @param {(id: string) => Promise<import('./usage').SubscriptionDetails>} load
 */
export function createSubscriptionDetailsCache(load) {
  /** @type {Map<string, {checkedAt: string | undefined, promise: Promise<import('./usage').SubscriptionDetails>}>} */
  const entries = new Map();
  return {
    /** @param {Pick<import('./usage').UsageSource, 'id' | 'checkedAt'>} source */
    read(source) {
      const previous = entries.get(source.id);
      if (previous && previous.checkedAt === source.checkedAt) return previous.promise;
      const promise = Promise.resolve()
        .then(() => load(source.id))
        .catch((error) => {
          if (entries.get(source.id)?.promise === promise) entries.delete(source.id);
          throw error;
        });
      entries.set(source.id, { checkedAt: source.checkedAt, promise });
      return promise;
    },
  };
}
