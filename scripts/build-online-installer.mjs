import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("在线安装器必须在 Windows 构建。");
const root = process.cwd();
const version = JSON.parse(await readFile("package.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("无效的发布版本。");
const directory = resolve("release", `v${version}`);
const test = process.argv.includes("--test");
const offline = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
    join(directory, `Zhiyu-${version}-setup.exe`),
);
const bytes = await readFile(offline);
const sha = createHash("sha256").update(bytes).digest("hex");
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "online-payload.txt"),
  `${version}\nhttps://github.com/Songwo/zhiyu/releases/download/v${version}/Zhiyu-${version}-setup.exe\n${sha}\n${bytes.length}\n`,
);
const assembly = join(directory, "OnlineAssemblyInfo.cs");
await writeFile(
  assembly,
  `using System.Reflection;\n[assembly: AssemblyTitle("知屿在线安装器")]\n[assembly: AssemblyProduct("Zhiyu Online Installer")]\n[assembly: AssemblyVersion("${version}.0")]\n[assembly: AssemblyFileVersion("${version}.0")]\n`,
);
const framework = join(process.env.WINDIR || "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319");
const compiler = join(framework, "csc.exe");
const references = ["WindowsBase.dll", "PresentationCore.dll", "PresentationFramework.dll"].map(
  (file) => `/reference:${join(framework, "WPF", file)}`,
);
const output = join(directory, `Zhiyu-${version}-online-setup.exe`);
const args = [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/utf8output",
  `/out:${output}`,
  "/reference:System.Net.Http.dll",
  "/reference:System.Xaml.dll",
  "/reference:System.Windows.Forms.dll",
  ...references,
  `/win32icon:${resolve("build/icon.ico")}`,
  `/win32manifest:${resolve("build/bootstrapper/app.manifest")}`,
  `/resource:${join(directory, "online-payload.txt")},payload`,
  `/resource:${resolve("build/bootstrapper/Installer.xaml")},ui`,
  `/resource:${resolve("build/icon.png")},logo`,
  assembly,
  resolve("build/bootstrapper/Bootstrapper.cs"),
];
const run = spawnSync(compiler, args, { cwd: root, stdio: "inherit", windowsHide: true });
if (run.status !== 0) throw new Error(`原生在线安装器编译失败：${run.error || run.status}`);
if (test) {
  const testOutput = join(directory, "online-installer-tests.exe");
  const result = spawnSync(
    compiler,
    args
      .filter(
        (arg) => !arg.startsWith("/target:") && !arg.startsWith("/out:") && !arg.endsWith(".cs"),
      )
      .concat([
        "/target:exe",
        "/main:BootstrapperTests",
        `/out:${testOutput}`,
        assembly,
        resolve("build/bootstrapper/Bootstrapper.cs"),
        resolve("build/bootstrapper/Tests.cs"),
      ]),
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) throw new Error("原生安装器测试编译失败。");
  const suite = spawnSync(testOutput, [], {
    stdio: "inherit",
    windowsHide: true,
    timeout: 300000,
    env: { ...process.env, ZHIYU_INSTALLER_TEST_PAYLOAD: offline },
  });
  if (suite.status !== 0) throw new Error("原生安装器测试失败。");
}
const signed = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-File", resolve("scripts/sign-windows.ps1"), "-Path", output],
  { stdio: "inherit", windowsHide: true },
);
if (signed.status !== 0) throw new Error("在线安装器签名失败。");
console.log(JSON.stringify({ output, size: (await stat(output)).size, payloadSha256: sha }));
