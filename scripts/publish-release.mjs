import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareReleaseFiles } from "./prepare-release-files.mjs";

const [directory, version] = process.argv.slice(2);
assert.match(version, /^\d+\.\d+\.\d+$/);
const tag = "v" + version,
  repo = process.env.GITHUB_REPOSITORY;
assert.equal(repo, "Songwo/zhiyu");
const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const files = await prepareReleaseFiles(directory, version);
const expected = new Map(
  await Promise.all(
    files.map(async (name) => {
      const data = await readFile(join(directory, name));
      return [
        name,
        { size: data.length, digest: "sha256:" + createHash("sha256").update(data).digest("hex") },
      ];
    }),
  ),
);
const releases = JSON.parse(gh("api", `repos/${repo}/releases?per_page=100`));
let release = releases.find((r) => r.tag_name === tag);
const verify = (current) => {
  assert.equal(current.assets.length, files.length, "全平台附件集合不完整");
  for (const asset of current.assets) {
    const e = expected.get(asset.name);
    assert.ok(e, "存在非预期附件");
    assert.equal(asset.state, "uploaded");
    assert.equal(asset.size, e.size);
    assert.equal(asset.digest, e.digest);
  }
};
if (release && !release.draft) {
  verify(JSON.parse(gh("api", `repos/${repo}/releases/${release.id}`)));
  console.log("已公开附件与本次完整构建一致，无需覆盖。");
} else {
  if (!release) {
    gh(
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--draft",
      "--verify-tag",
      "--title",
      `知屿 Zhiyu ${version}`,
      "--notes-file",
      `docs/releases/v${version}.md`,
    );
    release = JSON.parse(gh("api", `repos/${repo}/releases?per_page=100`)).find(
      (r) => r.tag_name === tag,
    );
  }
  assert.ok(release?.id);
  gh(
    "release",
    "upload",
    tag,
    "--repo",
    repo,
    "--clobber",
    ...files.map((name) => join(directory, name)),
  );
  verify(JSON.parse(gh("api", `repos/${repo}/releases/${release.id}`)));
  gh("release", "edit", tag, "--repo", repo, "--draft=false", "--latest");
  const published = JSON.parse(gh("api", `repos/${repo}/releases/${release.id}`));
  verify(published);
  assert.equal(published.draft, false);
}
await writeFile(
  join(directory, "published-files.json"),
  JSON.stringify({ tag, files, architectures: ["windows-x64", "mac-arm64", "mac-x64"] }, null, 2),
);
console.log(JSON.stringify({ published: tag, artifacts: files.length, macosRequired: true }));
