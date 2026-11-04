import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

test("发布后验收核对真实文件；拒绝截断包、摘要篡改、错误更新信息和草稿", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-published-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hash = (data, algorithm = "sha256", format = "hex") =>
    createHash(algorithm).update(data).digest(format);
  const blobs = Object.fromEntries(
    ["setup.exe", "online-setup.exe", "portable-x64.zip", "browser-extension.zip"].map((suffix) => [
      `Zhiyu-1.2.3-${suffix}`,
      Buffer.from(`synthetic ${suffix}`),
    ]),
  );
  const setup = blobs["Zhiyu-1.2.3-setup.exe"];
  const latest = {
    version: "1.2.3",
    path: "Zhiyu-1.2.3-setup.exe",
    sha512: hash(setup, "sha512", "base64"),
    files: [
      { url: "Zhiyu-1.2.3-setup.exe", size: setup.length, sha512: hash(setup, "sha512", "base64") },
    ],
  };
  blobs["SHA256SUMS.txt"] = Buffer.from(
    Object.entries(blobs)
      .map(([name, bytes]) => `${hash(bytes)}  ${name}`)
      .join("\n"),
  );
  blobs["latest.yml"] = Buffer.from(yaml.dump(latest));
  blobs["Zhiyu-1.2.3-setup.exe.blockmap"] = Buffer.from("synthetic blockmap");
  const release = { tag_name: "v1.2.3", draft: false, prerelease: false, assets: [] };
  for (const [name, bytes] of Object.entries(blobs)) {
    await writeFile(join(root, name), bytes);
    release.assets.push({
      name,
      size: bytes.length,
      state: "uploaded",
      digest: `sha256:${hash(bytes)}`,
      browser_download_url: `https://github.com/Songwo/zhiyu/releases/download/v1.2.3/${name}`,
    });
  }
  assert.equal((await verifyPublishedRelease(release, root)).checked.length, 7);
  await writeFile(join(root, "Zhiyu-1.2.3-setup.exe"), setup.subarray(1));
  await assert.rejects(verifyPublishedRelease(release, root), /下载不完整/);
  await writeFile(join(root, "Zhiyu-1.2.3-setup.exe"), setup);
  const digest = release.assets[0].digest;
  release.assets[0].digest = "sha256:" + "0".repeat(64);
  await assert.rejects(verifyPublishedRelease(release, root), /GitHub 摘要不一致/);
  release.assets[0].digest = digest;
  const changed = Buffer.from(yaml.dump({ ...latest, sha512: "invalid" }));
  await writeFile(join(root, "latest.yml"), changed);
  Object.assign(
    release.assets.find((asset) => asset.name === "latest.yml"),
    { size: changed.length, digest: `sha256:${hash(changed)}` },
  );
  await assert.rejects(verifyPublishedRelease(release, root), /更新清单 SHA512/);
  await assert.rejects(verifyPublishedRelease({ ...release, draft: true }, root), /草稿/);
});
