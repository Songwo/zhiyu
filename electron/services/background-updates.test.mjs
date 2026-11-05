import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundUpdates } from "./background-updates.mjs";

function rig(t, { manual = false, error = false, auto = true } = {}) {
  let now = 1000,
    checks = 0,
    downloads = 0;
  let state = { state: "idle", manual };
  const updater = {
    supported: true,
    status: () => state,
    check: async () => {
      checks++;
      return (state = { state: error ? "error" : "outdated", manual });
    },
    download: async () => {
      downloads++;
      return (state = { state: "downloaded", manual });
    },
    install: () => {
      throw new Error("后台不得触发安装");
    },
  };
  const task = new BackgroundUpdates({ updater, now: () => now, autoDownload: () => auto });
  task.start({ firstDelay: 0 });
  t.after(() => task.stop());
  return {
    task,
    updater,
    counts: () => ({ checks, downloads }),
    advance(ms) {
      now += ms;
    },
    reset() {
      state = { state: "idle", manual };
    },
  };
}
test("启动后台检查并下载，重复检查合并，下载完成后不安装也不抢占操作", async (t) => {
  const f = rig(t);
  const a = f.task.tick(),
    b = f.task.tick();
  await Promise.all([a, b]);
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1 });
  f.advance(5 * 3600000);
  await f.task.tick();
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1 });
});
test("便携版及关闭后台下载只提示，不下载安装器", async (t) => {
  for (const options of [{ manual: true }, { auto: false }]) {
    const f = rig(t, options);
    await f.task.tick();
    assert.deepEqual(f.counts(), { checks: 1, downloads: 0 });
  }
});
test("启动延迟内即使焦点恢复也不检查，延迟后才后台运行", async (t) => {
  const f = rig(t);
  f.task.start({ firstDelay: 30000 });
  await f.task.tick();
  assert.equal(f.counts().checks, 0);
  f.advance(30000);
  await f.task.tick();
  assert.equal(f.counts().checks, 1);
});
test("失败十五分钟后重试，正常四小时检查，停止后不再联网", async (t) => {
  const f = rig(t, { error: true });
  await f.task.tick();
  f.advance(14 * 60000);
  await f.task.tick();
  assert.equal(f.counts().checks, 1);
  f.advance(60000);
  await f.task.tick();
  assert.equal(f.counts().checks, 2);
  f.task.stop();
  f.advance(5 * 3600000);
  await f.task.tick();
  assert.equal(f.counts().checks, 2);
  const normal = rig(t, { auto: false });
  await normal.task.tick();
  normal.reset();
  normal.advance(3 * 3600000);
  await normal.task.tick();
  assert.equal(normal.counts().checks, 1);
  normal.advance(3600000);
  await normal.task.tick();
  assert.equal(normal.counts().checks, 2);
});
