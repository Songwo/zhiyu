import test from "node:test";
import assert from "node:assert/strict";
import { trackPersistence } from "../src/lib/persist-barrier.mjs";

test("显式完成等待真实落盘，连续修改按顺序写入", async () => {
  const values = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tracker = trackPersistence({
    getItem: () => null,
    removeItem: () => {},
    setItem: async (_name, value) => {
      if (values.length === 0) await gate;
      values.push(value.state.value);
    },
  });
  tracker.storage.setItem("test", { state: { value: 1 }, version: 0 });
  tracker.storage.setItem("test", { state: { value: 2 }, version: 0 });
  let completed = false;
  const flush = tracker.flush().then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await flush;
  assert.deepEqual(values, [1, 2]);
});

test("后台失败有处理而显式保存会失败，重试不受旧拒绝污染", async () => {
  let attempts = 0;
  const errors = [];
  const failure = Error("磁盘写入失败");
  const tracker = trackPersistence(
    {
      getItem: () => null,
      removeItem: () => {},
      setItem: async () => {
        if (++attempts === 1) throw failure;
      },
    },
    { onError: (error) => errors.push(error) },
  );
  await tracker.storage.setItem("test", { state: {}, version: 0 });
  await assert.rejects(tracker.flush(), (error) => error === failure);
  assert.deepEqual(errors, [failure]);
  await tracker.storage.setItem("test", { state: {}, version: 0 });
  await tracker.flush();
  assert.equal(attempts, 2);
});
