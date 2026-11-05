import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { macPackageNames, releaseAssetNames, requiresMacPackages } from "./release-assets.mjs";

/** 汇总同一标签的 Windows 与 macOS 文件，再生成统一摘要及双架构 Mac 更新清单。 */
export async function prepareReleaseFiles(directory, version) {
  assert.equal(requiresMacPackages(version), true, "此发布流程要求完整 macOS 包");
  const latest = yaml.load(await readFile(join(directory, "latest.yml"), "utf8"));
  assert.equal(latest.version, version, "Windows 更新清单版本不匹配");
  const setupName = `Zhiyu-${version}-setup.exe`,
    setup = await readFile(join(directory, setupName));
  const setupSha512 = createHash("sha512").update(setup).digest("base64");
  assert.equal(latest.path, setupName);
  assert.equal(latest.sha512, setupSha512, "Windows 更新清单摘要不匹配");
  assert.equal(latest.files.length, 1);
  assert.equal(latest.files[0].url, setupName);
  assert.equal(latest.files[0].sha512, setupSha512);
  assert.equal(latest.files[0].size, setup.length);
  const macFiles = [];
  for (const name of macPackageNames(version)) {
    const data = await readFile(join(directory, name));
    assert.ok(data.length > 0, `附件为空：${name}`);
    macFiles.push({
      url: name,
      sha512: createHash("sha512").update(data).digest("base64"),
      size: data.length,
    });
  }
  const zip = macFiles.find((f) => f.url.endsWith("-arm64.zip"));
  await writeFile(
    join(directory, "latest-mac.yml"),
    yaml.dump({
      version,
      files: macFiles,
      path: zip.url,
      sha512: zip.sha512,
      ...(latest.releaseDate ? { releaseDate: latest.releaseDate } : {}),
    }),
  );
  const files = releaseAssetNames(version),
    sums = [];
  for (const name of files.filter((name) => name !== "SHA256SUMS.txt")) {
    assert.ok((await stat(join(directory, name))).isFile(), `缺少附件：${name}`);
    assert.ok((await stat(join(directory, name))).size > 0, `附件为空：${name}`);
    if (/\.(exe|zip|dmg)$/.test(name))
      sums.push(
        `${createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex")}  ${name}`,
      );
  }
  await writeFile(join(directory, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, version] = process.argv.slice(2);
  const files = await prepareReleaseFiles(directory, version);
  console.log(JSON.stringify({ version, files, macArchitectures: ["arm64", "x64"] }));
}
