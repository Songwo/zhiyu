import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 桌面安装包里主进程需要的第三方包。界面已被 Vite 打包，暂存区只安装这些包及其传递依赖，
 * 所以主进程新引用一个包时必须加在这里；desktop:dist 打包前会用 mainProcessPackages 核对。
 */
export const DESKTOP_RUNTIME_DEPENDENCIES = [
  "ssh2",
  "electron-updater",
  "imapflow",
  "openai",
  "minisearch",
  "nodemailer",
  "mailparser",
  "html-to-text",
  "sanitize-html",
  "unified",
  "remark-parse",
  "remark-gfm",
  "js-yaml",
  "@noble/hashes",
];

/** 从主进程入口出发，收集代码里实际引用（静态、动态 import 与 require）的第三方包名。 */
export function mainProcessPackages(root) {
  const seen = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // 去掉注释，JSDoc 里的 import("mdast") 之类只是类型，不在运行时加载。
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const pattern =
      /(?:^|[;\s])(?:import|export)\s+(?!type)(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of code.matchAll(pattern)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (existsSync(target) && statSync(target).isFile()) visit(target);
      } else if (!spec.startsWith("node:") && spec !== "electron") {
        packages.add(
          spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0],
        );
      }
    }
  };
  visit(join(root, "electron/main.mjs"));
  visit(join(root, "electron/preload.cjs"));
  return [...packages].sort();
}

export async function createPackageStage(parent = tmpdir()) {
  // macOS 的 /var、/tmp 可能指向 /private。npm 和 builder 必须使用同一真实路径。
  return realpath(await mkdtemp(join(await realpath(parent), "nanpad-package-")));
}

export function packageEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key) || key === "INIT_CWD") delete env[key];
  }
  return env;
}

export function runPackageCommand(stage, script, args, env = packageEnvironment()) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: stage,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建子进程退出：${result.status ?? 1}`);
}

export async function installPackageDependencies(stage, npmCli, dependencies, env) {
  // 只通过 cwd 定位暂存项目。额外传 --prefix 会让 npm 在 macOS 符号链接路径中
  // 生成不同的依赖解析基准，造成刚生成的 lock 随后被 npm ci 判断为不同步。
  runPackageCommand(
    stage,
    npmCli,
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    env,
  );
  const lock = JSON.parse(await readFile(join(stage, "package-lock.json"), "utf8"));
  for (const [name, version] of Object.entries(dependencies)) {
    if (
      lock.packages?.[""]?.dependencies?.[name] !== version ||
      lock.packages?.[`node_modules/${name}`]?.version !== version
    ) {
      throw new Error(`暂存依赖与仓库锁定版本不一致：${name}`);
    }
  }
  runPackageCommand(
    stage,
    npmCli,
    ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
    env,
  );
}
