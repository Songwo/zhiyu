import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsAppId, migrateLegacyWindowsShortcut } from "./windows-identity.mjs";
import * as identity from "./windows-identity.mjs";
test("Windows 开发版与正式版使用不同应用身份", () => {
  assert.notEqual(windowsAppId(false), windowsAppId(true));
  assert.equal(windowsAppId(true), "dev.songwo.zhiyu");
  assert.notEqual(windowsAppId(true), "dev.songwo.nanpad", "不再复用旧任务栏分组缓存");
});
test("只备份抢占知屿身份的 Electron 快捷方式，重复运行无副作用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-identity-"));
  const file = join(directory, "Electron.lnk");
  const options = {
    programsDirectory: directory,
    backupDirectory: join(directory, "backups"),
    readShortcut: () => ({
      target: "C:\\runtime\\electron.exe",
      appUserModelId: "dev.songwo.nanpad",
    }),
  };
  try {
    await writeFile(file, "fixture-shortcut");
    const backup = await migrateLegacyWindowsShortcut(options);
    assert.equal(await readFile(backup, "utf8"), "fixture-shortcut");
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(await migrateLegacyWindowsShortcut(options), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function appFixture(t, { packaged = true, customPaths = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = customPaths
    ? { userData: join(root, "custom-profile"), sessionData: join(root, "custom-session") }
    : {};
  const overrides = { ...paths };
  let name = "Electron";
  return {
    root,
    paths,
    app: {
      isPackaged: packaged,
      getName: () => name,
      setName: (value) => {
        name = value;
      },
      getPath: (key) => overrides[key] ?? join(root, name),
      setPath: (key, value) => {
        assert.ok(statSync(value).isDirectory(), "Electron 路径覆盖前目录必须存在");
        overrides[key] = value;
      },
    },
  };
}

test("显示名更改为知屿后仍使用原 Nanpad 数据与会话目录", async (t) => {
  const { app, root } = await appFixture(t);
  identity.initializeAppIdentity(app, { platform: "win32" });
  assert.equal(app.getName(), "知屿 Zhiyu");
  assert.equal(app.getPath("userData"), join(root, "Nanpad"));
  assert.equal(app.getPath("sessionData"), join(root, "Nanpad"));
});

test("品牌更名保留显式用户目录与独立会话目录，正式版忽略开发环境覆盖", async (t) => {
  const { app, root, paths } = await appFixture(t, { customPaths: true });
  const ignored = join(root, "untrusted-test-path");
  identity.initializeAppIdentity(app, { testDataDirectory: ignored });
  assert.equal(app.getPath("userData"), paths.userData);
  assert.equal(app.getPath("sessionData"), paths.sessionData);
  await assert.rejects(stat(ignored), { code: "ENOENT" });
});

test("开发测试的数据和会话都留在隔离目录，避免更名时写入真实资料", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  const isolated = join(root, "isolated-profile");
  identity.initializeAppIdentity(app, { testDataDirectory: isolated, platform: "win32" });
  assert.equal(app.getName(), "知屿 Zhiyu");
  assert.equal(app.getPath("userData"), isolated);
  assert.equal(app.getPath("sessionData"), isolated);
  await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} 保留原应用名称与系统密钥存储身份`, async (t) => {
    const { app, root } = await appFixture(t);
    identity.initializeAppIdentity(app, { platform });
    assert.equal(app.getName(), "Nanpad");
    assert.equal(app.getPath("userData"), join(root, "Nanpad"));
    assert.equal(app.getPath("sessionData"), join(root, "Nanpad"));
  });
}
test("其他应用、独立开发身份与正式版快捷方式保持原样", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanpad-identity-"));
  const file = join(directory, "Electron.lnk");
  try {
    await writeFile(file, "keep");
    for (const entry of [
      { target: "C:\\electron.exe", appUserModelId: "other.app" },
      { target: "C:\\electron.exe", appUserModelId: windowsAppId(false) },
      { target: "C:\\Nanpad.exe", appUserModelId: windowsAppId(true) },
    ]) {
      assert.equal(
        await migrateLegacyWindowsShortcut({
          programsDirectory: directory,
          backupDirectory: join(directory, "backups"),
          readShortcut: () => entry,
        }),
        null,
      );
      assert.equal(await readFile(file, "utf8"), "keep");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("便携标记只在 Windows 正式程序旁生效，显式用户目录优先", () => {
  const execPath = String.raw`D:\Tools\Zhiyu\Zhiyu.exe`;
  const marker = String.raw`D:\Tools\Zhiyu\portable.txt`;
  const exists = (path) => path === marker;
  const base = { packaged: true, platform: "win32", execPath, argv: [execPath], exists };
  assert.equal(identity.PORTABLE_MARKER, "portable.txt");
  assert.equal(identity.portableDataDirectory(base), String.raw`D:\Tools\Zhiyu\data`);
  assert.equal(identity.portableDataDirectory({ ...base, exists: () => false }), null);
  assert.equal(identity.portableDataDirectory({ ...base, packaged: false }), null);
  assert.equal(identity.portableDataDirectory({ ...base, platform: "darwin" }), null);
  assert.equal(
    identity.portableDataDirectory({ ...base, argv: [execPath, String.raw`--user-data-dir=E:\p`] }),
    null,
  );
});

test("便携模式的资料与会话都写入程序旁目录", async (t) => {
  const { app, root } = await appFixture(t);
  const portable = join(root, "Zhiyu", "data");
  const result = identity.initializeAppIdentity(app, {
    portableDirectory: portable,
    platform: "win32",
  });
  assert.deepEqual(result, { portable: true });
  assert.equal(app.getPath("userData"), portable);
  assert.equal(app.getPath("sessionData"), portable);
  await assert.rejects(stat(join(root, "Nanpad")), { code: "ENOENT" });
});

test("开发版忽略便携目录，安装版返回非便携状态", async (t) => {
  const { app, root } = await appFixture(t, { packaged: false });
  const result = identity.initializeAppIdentity(app, {
    portableDirectory: join(root, "data"),
    platform: "win32",
  });
  assert.deepEqual(result, { portable: false });
  assert.equal(app.getPath("userData"), join(root, "Nanpad"));
});
