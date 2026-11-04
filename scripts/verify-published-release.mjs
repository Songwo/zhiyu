import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

/** 校验实际下载的七个公开附件，不以附件名或上传状态代替内容验证。 */
export async function verifyPublishedRelease(release, directory) {
  const tag = release.tag_name;
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.equal(release.draft, false, "不能验证尚未发布的草稿");
  assert.equal(release.prerelease, false, "这里只接受正式版本");
  const version = tag.slice(1);
  const setupName = `Zhiyu-${version}-setup.exe`;
  const files = [
    "latest.yml",
    "SHA256SUMS.txt",
    setupName,
    `${setupName}.blockmap`,
    `Zhiyu-${version}-online-setup.exe`,
    `Zhiyu-${version}-portable-x64.zip`,
    `Zhiyu-${version}-browser-extension.zip`,
  ];
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  assert.equal(assets.size, release.assets.length, "不能有同名附件");
  const sums = new Map(
    (await readFile(join(directory, "SHA256SUMS.txt"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
        assert.ok(match, "SHA256SUMS 格式无效");
        return [match[2], match[1].toLowerCase()];
      }),
  );
  const checked = [];
  let setup;
  for (const name of files) {
    const asset = assets.get(name);
    assert.ok(asset && asset.state === "uploaded", `缺少已上传附件 ${name}`);
    assert.equal(
      asset.browser_download_url,
      `https://github.com/Songwo/zhiyu/releases/download/${tag}/${name}`,
    );
    const data = await readFile(join(directory, name));
    assert.equal(data.length, asset.size, `${name} 下载不完整`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    assert.equal(asset.digest, `sha256:${sha256}`, `${name} 与 GitHub 摘要不一致`);
    if (sums.has(name)) assert.equal(sums.get(name), sha256, `${name} 与校验清单不一致`);
    checked.push({ name, size: data.length, sha256 });
    if (name === setupName) setup = data;
  }
  assert.equal(sums.size, 4, "校验清单必须覆盖四个下载包");
  for (const name of files.filter((name) => /\.(exe|zip)$/.test(name)))
    assert.ok(sums.has(name), `校验清单缺少 ${name}`);
  const latest = yaml.load(await readFile(join(directory, "latest.yml"), "utf8"));
  assert.equal(latest.version, version);
  assert.equal(latest.path, setupName);
  const sha512 = createHash("sha512").update(setup).digest("base64");
  assert.equal(latest.sha512, sha512, "更新清单 SHA512 与实际安装包不一致");
  assert.equal(latest.files.length, 1);
  assert.equal(latest.files[0].url, setupName);
  assert.equal(latest.files[0].sha512, sha512);
  assert.equal(latest.files[0].size, setup.length);
  return { tag, publishedAt: release.published_at, checked, updateMetadataMatchesSetup: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [metadata, directory, receipt] = process.argv.slice(2);
  assert.ok(metadata && directory && receipt, "参数：release.json 下载目录 receipt.json");
  const result = await verifyPublishedRelease(
    JSON.parse(await readFile(metadata, "utf8")),
    directory,
  );
  await writeFile(receipt, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      tag: result.tag,
      assets: result.checked.length,
      sizesAndSha256: true,
      updateMetadataMatchesSetup: true,
    }),
  );
}
