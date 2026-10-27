import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_RUNTIME_DEPENDENCIES,
  createPackageStage,
  installPackageDependencies,
  mainProcessPackages,
  packageEnvironment,
} from "./package-stage.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zhiyu-package-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("打包暂存区统一符号链接路径，真实 npm 生成的锁可直接用于 npm ci", async (t) => {
  const root = await fixture(t);
  const actual = join(root, "real directory");
  const alias = join(root, "alias directory");
  await mkdir(actual);
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const stage = await createPackageStage(alias);
  assert.equal(dirname(stage), actual);
  assert.equal(stage, await realpath(stage));
  const npmCli =
    process.env.npm_execpath ||
    resolve(
      dirname(process.execPath),
      process.platform === "win32"
        ? "node_modules/npm/bin/npm-cli.js"
        : "../lib/node_modules/npm/bin/npm-cli.js",
    );
  await access(npmCli);
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ name: "path-regression", version: "1.0.0", private: true }),
  );
  await installPackageDependencies(stage, npmCli, {}, packageEnvironment());
  const lock = JSON.parse(await readFile(join(stage, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].name, "path-regression");
  assert.equal(lock.packages[""].version, "1.0.0");
  await assert.rejects(access(join(root, "package-lock.json")));
});

test("隔离 npm 项目上下文但保留 Electron 镜像和系统变量", () => {
  const env = packageEnvironment({
    npm_config_prefix: "wrong",
    NPM_CONFIG_PREFIX: "wrong",
    npm_execpath: "npm.js",
    INIT_CWD: "parent",
    ELECTRON_MIRROR: "https://mirror.example/",
    PATH: "bin",
  });
  assert.deepEqual(env, { ELECTRON_MIRROR: "https://mirror.example/", PATH: "bin" });
});

test("暂存锁中版本漂移时在 npm ci 前中止", async (t) => {
  const root = await fixture(t);
  const stage = await createPackageStage(root);
  const cli = join(root, "fake-npm.mjs");
  await writeFile(
    cli,
    `import {writeFileSync} from 'node:fs'; if(process.argv[2] === 'ci') writeFileSync('unexpected-ci', '');`,
  );
  await writeFile(
    join(stage, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": { dependencies: { runtime: "1.0.0" } },
        "node_modules/runtime": { version: "2.0.0" },
      },
    }),
  );
  await assert.rejects(
    installPackageDependencies(stage, cli, { runtime: "1.0.0" }, packageEnvironment()),
    /版本不一致：runtime/,
  );
  await assert.rejects(access(join(stage, "unexpected-ci")));
});

test("桌面安装包的依赖清单覆盖主进程实际引用的每个第三方包", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const used = mainProcessPackages(root);
  assert.ok(used.includes("ssh2"), "应能扫描到主进程的依赖");
  assert.ok(!used.includes("mdast"), "JSDoc 里的类型引用不算运行时依赖");
  assert.deepEqual(
    used.filter((name) => !DESKTOP_RUNTIME_DEPENDENCIES.includes(name)),
    [],
  );
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of DESKTOP_RUNTIME_DEPENDENCIES)
    assert.ok(manifest.dependencies[name], `${name} 必须是生产依赖`);
});
