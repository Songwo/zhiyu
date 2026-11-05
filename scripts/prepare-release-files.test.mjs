import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { prepareReleaseFiles } from "./prepare-release-files.mjs";
import { requiresMacPackages, releaseAssetNames, macPackageNames } from "./release-assets.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";
import { releaseDetails } from "./build-site.mjs";

const hash = (b, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(b).digest(encoding);
test("新版缺任何 Mac 格式/架构都阻断，完整附件的摘要和更新清单可被发布后验收复核", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-release-files-")),
    version = "1.17.7";
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(requiresMacPackages("1.17.6"), false);
  assert.equal(requiresMacPackages(version), true);
  assert.equal(requiresMacPackages("2.0.0"), true);
  const setupName = `Zhiyu-${version}-setup.exe`,
    setup = Buffer.from("synthetic setup");
  for (const name of releaseAssetNames(version).filter(
    (name) => !["latest-mac.yml", "SHA256SUMS.txt", "latest.yml"].includes(name),
  ))
    await writeFile(
      join(root, name),
      name === setupName ? setup : Buffer.from("synthetic " + name),
    );
  await writeFile(
    join(root, "latest.yml"),
    yaml.dump({
      version,
      releaseDate: "2026-11-05T00:00:00Z",
      path: setupName,
      sha512: hash(setup, "sha512", "base64"),
      files: [{ url: setupName, size: setup.length, sha512: hash(setup, "sha512", "base64") }],
    }),
  );
  for (const name of macPackageNames(version)) {
    const bytes = await readFile(join(root, name));
    await unlink(join(root, name));
    await assert.rejects(prepareReleaseFiles(root, version), { code: "ENOENT" });
    await writeFile(join(root, name), bytes);
  }
  const files = await prepareReleaseFiles(root, version);
  assert.equal(files.length, 12);
  const before = await readFile(join(root, "latest-mac.yml"));
  await prepareReleaseFiles(root, version);
  assert.deepEqual(
    await readFile(join(root, "latest-mac.yml")),
    before,
    "重复运行产生相同更新清单",
  );
  const release = {
    tag_name: "v" + version,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/Songwo/zhiyu/releases/tag/v${version}`,
    published_at: "2026-11-05T01:00:00Z",
    assets: await Promise.all(
      files.map(async (name) => {
        const data = await readFile(join(root, name));
        return {
          name,
          state: "uploaded",
          size: data.length,
          digest: "sha256:" + hash(data),
          browser_download_url: `https://github.com/Songwo/zhiyu/releases/download/v${version}/${name}`,
        };
      }),
    ),
  };
  assert.equal((await verifyPublishedRelease(release, root)).macMetadataVerified, true);
  assert.match(releaseDetails(release).MAC_X64_DMG_URL, /mac-x64\.dmg$/);
  for (const name of macPackageNames(version))
    assert.throws(
      () => releaseDetails({ ...release, assets: release.assets.filter((a) => a.name !== name) }),
      /missing/,
    );
  const mac = yaml.load(before.toString());
  mac.files[0].sha512 = "invalid";
  const bad = Buffer.from(yaml.dump(mac));
  await writeFile(join(root, "latest-mac.yml"), bad);
  Object.assign(
    release.assets.find((a) => a.name === "latest-mac.yml"),
    { size: bad.length, digest: "sha256:" + hash(bad) },
  );
  await assert.rejects(verifyPublishedRelease(release, root), /Mac 更新清单摘要错误/);
});
