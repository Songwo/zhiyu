import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

assert.equal(process.platform, "win32");
const run = promisify(execFile);
const cache =
  process.env.ELECTRON_BUILDER_CACHE ||
  join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "electron-builder/Cache");
async function compilerAt(directory, depth = 0) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "makensis.exe") return join(directory, entry.name);
    if (entry.isDirectory() && depth < 4) {
      const found = await compilerAt(join(directory, entry.name), depth + 1);
      if (found) return found;
    }
  }
}
const compiler = await compilerAt(cache);
assert.ok(compiler, "未找到 NSIS 编译器");
const directory = await mkdtemp(join(tmpdir(), "zhiyu-startup-test-"));
const testKey = `Software\\ZhiyuInstallerTests\\${randomUUID()}`;
const quote = (value) => `"${value.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`;
try {
  const executable = join(directory, "test.exe");
  const result = join(directory, "result.txt");
  const script = join(directory, "test.nsi");
  const source = [
    "Unicode true",
    'Name "Zhiyu startup isolated regression"',
    `OutFile ${quote(executable)}`,
    "RequestExecutionLevel user",
    "SilentInstall silent",
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    `!include ${quote(resolve("build/installer.nsh"))}`,
    "Var appExe",
    'Section "Isolated registry assertions"',
    "SetShellVarContext current",
    `StrCpy $INSTDIR ${quote(directory)}`,
    'StrCpy $appExe "$INSTDIR\\Zhiyu.exe"',
    `!insertmacro zhiyuApplyStartup "${testKey}"`,
    `FileOpen $9 ${quote(result)} w`,
    `ReadRegStr $R0 HKCU "${testKey}" "Zhiyu"`,
    'FileWrite $9 "$R0$\\r$\\n"',
    "FileClose $9",
    `!insertmacro zhiyuRemoveStartup "${testKey}"`,
    `ReadRegStr $R0 HKCU "${testKey}" "Zhiyu"`,
    '${If} $R0 != ""',
    "SetErrorLevel 3",
    "${EndIf}",
    `WriteRegStr HKCU "${testKey}" "Zhiyu" "other-program"`,
    `!insertmacro zhiyuRemoveStartup "${testKey}"`,
    `ReadRegStr $R0 HKCU "${testKey}" "Zhiyu"`,
    '${If} $R0 != "other-program"',
    "SetErrorLevel 4",
    "${EndIf}",
    `DeleteRegKey HKCU "${testKey}"`,
    "SectionEnd",
  ];
  await writeFile(script, source.join("\r\n"));
  await run(compiler, ["/V2", "/INPUTCHARSET", "UTF8", script], { windowsHide: true });
  for (const [args, expected] of [
    [[], ""],
    [["/ZH_STARTUP=1"], `"${join(directory, "Zhiyu.exe")}"`],
    [["/ZH_STARTUP=0"], ""],
  ]) {
    await run(executable, args, { windowsHide: true });
    assert.equal((await readFile(result, "utf8")).trim(), expected);
  }
  console.log(
    "PASS native NSIS startup opt-in, opt-out, uninstall cleanup and unrelated-value preservation",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
