import assert from "node:assert/strict";
import test from "node:test";
import { deleteEncryptedAccount } from "../src/lib/account-delete.mjs";

test("取消解锁不会删除账号资料或凭据", async () => {
  const calls = [];
  assert.equal(
    await deleteEncryptedAccount({
      id: "one",
      requireUnlocked: async () => false,
      removeCredential: async () => calls.push("vault"),
      removeAsset: () => calls.push("asset"),
    }),
    false,
  );
  assert.deepEqual(calls, []);
});
test("加密记录删除失败仍保留账号入口", async () => {
  let removed = false;
  await assert.rejects(
    deleteEncryptedAccount({
      id: "one",
      requireUnlocked: async () => true,
      removeCredential: async () => {
        throw new Error("write failed");
      },
      removeAsset: () => {
        removed = true;
      },
    }),
    /write failed/,
  );
  assert.equal(removed, false);
});
test("成功时先删除指定账号加密记录，再移除资料", async () => {
  const calls = [];
  assert.equal(
    await deleteEncryptedAccount({
      id: "one",
      requireUnlocked: async () => true,
      removeCredential: async (key) => calls.push(key),
      removeAsset: (id) => calls.push(id),
    }),
    true,
  );
  assert.deepEqual(calls, ["account:one", "one"]);
});

test("删除等待资料和关联实际落盘，落盘失败不能返回成功", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const task = deleteEncryptedAccount({
    id: "one",
    requireUnlocked: async () => true,
    removeCredential: async () => {},
    removeAsset: () => pending,
  }).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  finish();
  await task;
  assert.equal(completed, true);
  await assert.rejects(
    deleteEncryptedAccount({
      id: "one",
      requireUnlocked: async () => true,
      removeCredential: async () => {},
      removeAsset: async () => {
        throw Error("关联落盘失败");
      },
    }),
    /关联落盘失败/,
  );
});
