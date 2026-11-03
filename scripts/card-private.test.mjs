import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCardPrivate, cardPrivateId } from "../src/lib/card-private.mjs";
import { Vault } from "../electron/services/vault.mjs";

test("支付卡敏感资料规范化、格式校验和类型隔离", () => {
  const record = normalizeCardPrivate(
    {
      number: "4242 4242-4242 4242",
      holder: " 测试持卡人 ",
      cvv: "123",
      iccid: "ignore",
      activationCode: "ignore",
      arbitrary: "not-saved",
    },
    "payment",
  );
  assert.equal(record.number, "4242424242424242");
  assert.equal(record.holder, "测试持卡人");
  assert.equal(record.activationCode, "");
  assert.equal(record.iccid, "");
  assert.equal(record.arbitrary, undefined);
  for (const input of [
    { number: "123" },
    { number: "4242notvalid4242" },
    { cvv: "12" },
    { cvv: "12345" },
    { holder: "x".repeat(201) },
  ])
    assert.throws(() => normalizeCardPrivate(input, "payment"));
  assert.throws(() => normalizeCardPrivate({}, "unknown"));
});

test("eSIM 只保留自己的敏感字段，完整标识和激活码可原样复制", () => {
  const raw = {
    iccid: "89010000000000000001",
    eid: "89000000000000000000000000000001",
    activationCode: "LPA:1$smdp.example.test$synthetic-activation-only",
    number: "4242424242424242",
    cvv: "123",
    note: "合成测试",
  };
  const record = normalizeCardPrivate(raw, "esim");
  assert.equal(record.iccid, raw.iccid);
  assert.equal(record.eid, raw.eid);
  assert.equal(record.activationCode, raw.activationCode);
  assert.equal(record.number, "");
  assert.equal(record.cvv, "");
  for (const input of [
    { iccid: "short" },
    { eid: "1".repeat(31) },
    { activationCode: "x".repeat(4097) },
  ])
    assert.throws(() => normalizeCardPrivate(input, "esim"));
  assert.equal(normalizeCardPrivate(null, "payment").number, "");
});

test("真实密钥库往返：敏感值不进入普通资产或密文文件的明文，锁库拒读，删除后不可复制", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-private-card-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "vault.enc");
  const vault = new Vault(file);
  await vault.create("synthetic-card-master-2026");
  const value = normalizeCardPrivate(
    { number: "4242424242424242", holder: "synthetic-vault-only-holder", cvv: "123" },
    "payment",
  );
  const id = cardPrivateId("card-fixture");
  await vault.set(id, value);
  await writeFile(
    join(root, "assets.json"),
    JSON.stringify({ id: "card-fixture", card: { kind: "payment", last4: "4242" } }),
  );
  assert.equal((await vault.get(id)).number, value.number);
  for (const path of [file, join(root, "assets.json")]) {
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(value.number));
    assert.ok(!text.includes(value.holder));
  }
  vault.lock();
  await assert.rejects(vault.get(id));
  await vault.unlock("synthetic-card-master-2026");
  assert.equal((await vault.get(id)).cvv, "123");
  await vault.remove(id);
  assert.equal(await vault.get(id), null);
});
