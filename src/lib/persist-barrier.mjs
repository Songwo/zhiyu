/** 跟踪实际持久化任务；后台错误有处理，显式保存仍能等待并收到失败。
 * @template T
 * @param {import('zustand/middleware').PersistStorage<T>} storage
 * @param {{onError?:(error:unknown)=>void}} [options]
 * @returns {{storage:import('zustand/middleware').PersistStorage<T>,flush:()=>Promise<void>}}
 */
export function trackPersistence(storage, { onError = () => {} } = {}) {
  /** @type {Promise<unknown>} */
  let latest = Promise.resolve();
  return {
    storage: {
      getItem: (name) => storage.getItem(name),
      removeItem: (name) => storage.removeItem(name),
      setItem(name, value) {
        const task = latest.catch(() => {}).then(() => storage.setItem(name, value));
        latest = task;
        void task.catch((error) => {
          try {
            onError(error);
          } catch {
            /* 错误提示不能阻断后续保存。 */
          }
        });
        return task.then(
          () => {},
          () => {},
        );
      },
    },
    async flush() {
      for (;;) {
        const current = latest;
        await current;
        if (latest === current) return;
      }
    },
  };
}
