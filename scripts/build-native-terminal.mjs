import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function buildNativeTerminal({ test = false } = {}) {
  if (process.platform !== "win32") return;
  const framework = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/Framework64/v4.0.30319",
  );
  const output = resolve("release/native-terminal/Zhiyu.Terminal.exe");
  const references = ["WindowsBase.dll", "PresentationCore.dll", "PresentationFramework.dll"].map(
    (file) => `/reference:${join(framework, "WPF", file)}`,
  );
  const shared = [
    "/nologo",
    "/platform:x64",
    "/optimize+",
    "/utf8output",
    "/reference:System.Xaml.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Drawing.dll",
    ...references,
  ];
  const run = (file, args) => {
    const result = spawnSync(file, args, { stdio: "inherit", windowsHide: true });
    if (result.status !== 0)
      throw new Error(`原生终端构建或测试失败：${result.error || result.status}`);
  };
  const sources = [resolve("build/terminal/Screen.cs"), resolve("build/terminal/Terminal.cs")];
  run(join(framework, "csc.exe"), [
    ...shared,
    "/target:winexe",
    `/out:${output}`,
    `/win32icon:${resolve("build/icon.ico")}`,
    `/win32manifest:${resolve("build/terminal/app.manifest")}`,
    ...sources,
  ]);
  if (test) {
    const suite = resolve("release/native-terminal/terminal-tests.exe");
    run(join(framework, "csc.exe"), [
      ...shared,
      "/target:exe",
      "/main:TerminalTests",
      `/out:${suite}`,
      ...sources,
      resolve("build/terminal/Tests.cs"),
    ]);
    run(suite, []);
  }
  return output;
}

await mkdir(resolve("release/native-terminal"), { recursive: true });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildNativeTerminal({ test: process.argv.includes("--test") });
