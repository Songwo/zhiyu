import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAtomicWriter } from "../selfhost/atomic-write.mjs";

const blocked = (code = "EPERM") => Object.assign(new Error("synthetic file lock"), { code });
async function rig(t) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "state.json");
  await writeFile(file, "original");
  return { root, file };
}

test("Windows 暂时占用后仍原子替换，等待期间原文件完整可读", async (t) => {
  const { root, file } = await rig(t);
  let attempts = 0;
  const waits = [];
  const write = createAtomicWriter({
    platform: "win32",
    renameFile: async (from, to) => {
      if (++attempts < 3) throw blocked(attempts === 1 ? "EPERM" : "EBUSY");
      return rename(from, to);
    },
    wait: async (ms) => {
      waits.push(ms);
      assert.equal(await readFile(file, "utf8"), "original");
    },
  });
  await write(file, "complete replacement");
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.equal(await readFile(file, "utf8"), "complete replacement");
  assert.deepEqual(await readdir(root), ["state.json"]);
});

test("永久占用和非重试错误保持原文件、清理临时文件，并且不会无限等待", async (t) => {
  const { root, file } = await rig(t);
  for (const [platform, code, retry] of [
    ["win32", "EPERM", true],
    ["win32", "EIO", false],
    ["linux", "EPERM", false],
  ]) {
    let attempts = 0,
      waited = 0;
    const write = createAtomicWriter({
      platform,
      renameFile: async () => {
        attempts++;
        throw blocked(code);
      },
      wait: async (ms) => {
        waited += ms;
      },
    });
    await assert.rejects(write(file, "must not overwrite"), { code });
    assert.ok(attempts >= 1 && attempts <= 7);
    assert.equal(attempts > 1, retry);
    assert.ok(waited <= 1000);
    assert.equal(await readFile(file, "utf8"), "original");
    assert.deepEqual(await readdir(root), ["state.json"]);
  }
});

test("同文件并发写入按调用顺序提交，失败也不污染后续队列", async (t) => {
  const { file } = await rig(t);
  let entered, release;
  const began = new Promise((r) => {
      entered = r;
    }),
    barrier = new Promise((r) => {
      release = r;
    });
  let calls = 0;
  const write = createAtomicWriter({
    renameFile: async (from, to) => {
      const call = ++calls;
      if (call === 1) {
        entered();
        await barrier;
        throw blocked("EIO");
      }
      return rename(from, to);
    },
  });
  const first = write(file, "first");
  const firstCheck = assert.rejects(first, { code: "EIO" });
  await began;
  const second = write(file, "second");
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(await readFile(file, "utf8"), "original");
  release();
  await firstCheck;
  await second;
  assert.equal(await readFile(file, "utf8"), "second");
});

test(
  "同步身份初始化写入失败交给服务创建调用者，不产生未处理拒绝",
  { timeout: 30000 },
  async (t) => {
    const { root } = await rig(t);
    await writeFile(join(root, "index.html"), "startup fixture");
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(String(to).endsWith('sync-identity.json'))throw Object.assign(new Error('synthetic startup failure'),{code:'EACCES'});return rename(from,to)};syncBuiltinESMExports();process.on('unhandledRejection',()=>process.exit(3));const{createWebServer}=await import(${JSON.stringify(new URL("../selfhost/server.mjs", import.meta.url).href)});try{await createWebServer({root:process.env.ZHIYU_ATOMIC_FIXTURE,staticDir:process.env.ZHIYU_ATOMIC_FIXTURE,schedulePush:false,log:{log(){},error(){}}});process.exit(2)}catch(e){if(e.code!=='EACCES')throw e;await new Promise(setImmediate);console.log('startup failure handled');process.exit(0)}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ZHIYU_ATOMIC_FIXTURE: root },
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /startup failure handled/);
  },
);
