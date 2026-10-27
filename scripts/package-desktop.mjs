import { cp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_RUNTIME_DEPENDENCIES,
  createPackageStage,
  installPackageDependencies,
  mainProcessPackages,
  packageEnvironment,
  runPackageCommand,
} from "./package-stage.mjs";

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
// 漏装的包只会在安装后的程序启动时报错（1.16.1 的 @noble/hashes），所以打包前先核对。
const missing = mainProcessPackages(root).filter(
  (name) => !DESKTOP_RUNTIME_DEPENDENCIES.includes(name),
);
if (missing.length)
  throw new Error(
    `主进程引用了未加入打包清单的依赖：${missing.join("、")}，请加到 scripts/package-stage.mjs`,
  );
const stage = await createPackageStage();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
// React 界面已经被 Vite 打包，暂存区只安装主进程运行依赖及其传递依赖。
const dependencies = Object.fromEntries(
  DESKTOP_RUNTIME_DEPENDENCIES.map((name) => [name, lock.packages[`node_modules/${name}`].version]),
);
const appManifest = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  homepage: manifest.homepage,
  type: "module",
  main: "electron/main.mjs",
  dependencies,
};
await cp(join(root, "electron"), join(stage, "electron"), {
  recursive: true,
  filter: (source) => !source.endsWith(".test.mjs"),
});
await cp(join(root, "dist-desktop"), join(stage, "dist-desktop"), { recursive: true });
await writeFile(join(stage, "package.json"), JSON.stringify(appManifest, null, 2));
// 保留仓库锁定的版本，不在打包时重新解析最新依赖版本。
lock.packages[""] = appManifest;
await writeFile(join(stage, "package-lock.json"), JSON.stringify(lock));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请通过 npm run desktop:dist 或 npm run desktop:pack 执行。");
// npm run 注入的项目路径会让依赖收集器误读父项目，独立暂存区只保留运行依赖。
const env = packageEnvironment();
const run = (script, args) => runPackageCommand(stage, script, args, env);
const config = {
  ...manifest.build,
  directories: {
    app: stage,
    output: join(root, "release", `v${manifest.version}`),
    buildResources: join(root, "build"),
  },
  extraResources: manifest.build.extraResources.map((entry) => ({
    ...entry,
    from: resolve(root, entry.from),
  })),
  win: { ...manifest.build.win, icon: resolve(root, manifest.build.win.icon) },
  nsis: { ...manifest.build.nsis, include: resolve(root, manifest.build.nsis.include) },
  electronDist: join(root, "node_modules", "electron", "dist"),
  electronVersion: JSON.parse(
    await readFile(join(root, "node_modules", "electron", "package.json"), "utf8"),
  ).version,
  npmRebuild: false,
};
const configPath = join(stage, "builder.json");
await writeFile(configPath, JSON.stringify(config, null, 2));
try {
  await installPackageDependencies(stage, npmCli, dependencies, env);
  // 使用 electron-builder 内置的目录遍历器，避开 npm 依赖图收集时的内存溢出。
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ ...appManifest, packageManager: "traversal" }, null, 2),
  );
  run(join(root, "node_modules", "electron-builder", "cli.js"), [
    "--projectDir",
    stage,
    "--config",
    configPath,
    ...process.argv.slice(2),
  ]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
