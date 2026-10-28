import assert from "node:assert/strict";
import test from "node:test";
import { releaseDetails, renderSite } from "./build-site.mjs";

function publishedRelease(version = "1.2.3") {
  const base = `https://github.com/Songwo/zhiyu/releases`;
  return {
    tag_name: `v${version}`,
    name: `知屿 Zhiyu ${version}`,
    draft: false,
    prerelease: false,
    html_url: `${base}/tag/v${version}`,
    published_at: "2026-10-07T06:27:45Z",
    body: "# 知屿\n\n修复 Windows 任务栏旧图标，保留原资料。\n\n## 修复内容\n\n- 具体说明",
    assets: [
      `Nanpad-${version}-setup.exe`,
      `Nanpad-${version}-browser-extension.zip`,
      "SHA256SUMS.txt",
    ].map((name) => ({
      name,
      size: 114856991,
      state: "uploaded",
      browser_download_url: `${base}/download/v${version}/${name}`,
    })),
  };
}

test("统一品牌后的下载页支持新安装包名，同时兼容历史附件", () => {
  const release = publishedRelease("1.6.0");
  for (const asset of release.assets) {
    asset.name = asset.name.replace("Nanpad-", "Zhiyu-");
    asset.browser_download_url = asset.browser_download_url.replace("Nanpad-", "Zhiyu-");
  }
  assert.match(releaseDetails(release).INSTALLER_URL, /Zhiyu-1\.6\.0-setup\.exe$/);
});

test("宣传页以已发布版本为准，同步全部下载入口与更新摘要", () => {
  const details = releaseDetails(publishedRelease("1.2.4"));
  assert.equal(details.VERSION, "1.2.4");
  assert.equal(details.RELEASE_DATE, "2026年10月7日");
  assert.equal(details.RELEASE_SUMMARY, "修复 Windows 任务栏旧图标，保留原资料。");
  assert.match(details.INSTALLER_URL, /v1\.2\.4\/Nanpad-1\.2\.4-setup\.exe$/);
  assert.match(details.EXTENSION_URL, /v1\.2\.4\/Nanpad-1\.2\.4-browser-extension\.zip$/);
  assert.match(details.CHECKSUM_URL, /v1\.2\.4\/SHA256SUMS\.txt$/);
  // 没有便携版附件的旧版本退回到 Release 页面。
  assert.equal(details.PORTABLE_URL, details.RELEASE_URL);
});

test("有便携版附件时，下载页直接链接便携版", () => {
  const release = publishedRelease("1.9.0");
  for (const asset of release.assets) {
    asset.name = asset.name.replace("Nanpad-", "Zhiyu-");
    asset.browser_download_url = asset.browser_download_url.replace("Nanpad-", "Zhiyu-");
  }
  const name = "Zhiyu-1.9.0-portable-x64.zip";
  release.assets.push({
    name,
    size: 160_000_000,
    state: "uploaded",
    browser_download_url: `https://github.com/Songwo/zhiyu/releases/download/v1.9.0/${name}`,
  });
  const details = releaseDetails(release);
  assert.match(details.PORTABLE_URL, /portable-x64\.zip$/);
  assert.equal(details.PORTABLE_SIZE, "160 MB");
});

test("未正式发布或附件尚未上传完成时拒绝部署", () => {
  for (const patch of [
    { draft: true },
    { prerelease: true },
    { published_at: null },
    { tag_name: "v1.3.0-beta" },
  ]) {
    assert.throws(() => releaseDetails({ ...publishedRelease(), ...patch }));
  }
  for (const name of ["setup.exe", "browser-extension.zip", "SHA256SUMS.txt"]) {
    const release = publishedRelease();
    release.assets = release.assets.filter((asset) => !asset.name.endsWith(name));
    assert.throws(() => releaseDetails(release), /asset/i);
  }
  const uploading = publishedRelease();
  uploading.assets[0].state = "new";
  assert.throws(() => releaseDetails(uploading), /asset/i);
});

test("下载链接只接受当前仓库、当前版本及对应附件", () => {
  for (const url of [
    "javascript:alert(1)",
    "https://github.com.evil.test/setup.exe",
    "https://github.com/Songwo/zhiyu/releases/download/v0.1.0/Nanpad-0.1.0-setup.exe",
  ]) {
    const release = publishedRelease();
    release.assets[0].browser_download_url = url;
    assert.throws(() => releaseDetails(release), /URL/);
  }
});

test("发布说明按文本输出，不能把脚本或模板占位符带进网页", () => {
  const release = publishedRelease();
  release.body = '# 标题\n\n<img src=x onerror="alert(1)"> & {{VERSION}}';
  const html = renderSite("<p>{{RELEASE_SUMMARY}}</p><b>{{VERSION}}</b>", releaseDetails(release));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&quot;"));
  assert.ok(html.endsWith("<b>1.2.3</b>"));
  assert.ok(html.includes("{{VERSION}}"), "说明里的文本不作为二次模板执行");
  assert.throws(() => renderSite("{{UNKNOWN}}", releaseDetails(release)), /Unknown/);
});

test("没有正文时回退到发布标题，长说明保持简短", () => {
  assert.equal(
    releaseDetails({ ...publishedRelease(), body: "" }).RELEASE_SUMMARY,
    "知屿 Zhiyu 1.2.3",
  );
  assert.ok(
    releaseDetails({ ...publishedRelease(), body: "新".repeat(1000) }).RELEASE_SUMMARY.length <=
      221,
  );
});

test("同步协议动画：分镜自洽，动画 SVG 与分镜同步，页面模板的占位符都有值", async () => {
  const { readFile } = await import("node:fs/promises");
  const { buildSvg } = await import("./build-zsp-svg.mjs");
  const storyboard = JSON.parse(await readFile("site/zsp-steps.json", "utf8"));
  const chapters = new Set(storyboard.chapters.map((chapter) => chapter.id));
  const ids = new Set();
  const actors = new Set(["desktop", "server"]);
  for (const step of storyboard.steps) {
    assert.ok(!ids.has(step.id), `步骤 id 重复：${step.id}`);
    ids.add(step.id);
    assert.ok(chapters.has(step.chapter), `${step.id} 的章节不存在`);
    for (const field of ["title", "what", "why", "seen"])
      assert.ok(
        typeof step[field] === "string" && step[field].length > 4,
        `${step.id} 缺少 ${field}`,
      );
    for (const packet of step.packets ?? []) {
      assert.ok(
        actors.has(packet.from) && actors.has(packet.to) && packet.from !== packet.to,
        step.id,
      );
      assert.ok(packet.label?.length > 0, step.id);
    }
    if (step.chapter === "attack")
      assert.ok(step.attacker?.result && step.attacker.target, step.id);
    else assert.equal(step.attacker, undefined, `${step.id} 只有攻击章节才有攻击者`);
  }
  assert.ok(storyboard.steps.some((step) => step.readme));
  assert.equal(
    buildSvg(storyboard),
    await readFile("site/zsp-flow.svg", "utf8"),
    "分镜改过后请运行 node scripts/build-zsp-svg.mjs 重新生成 site/zsp-flow.svg",
  );
  for (const file of ["site/sync.html", "site/index.html", "site/guide.html"]) {
    const html = await readFile(file, "utf8");
    const values = {
      VERSION: "1.2.3",
      ASSET_REVISION: "abc",
      STEP_COUNT: storyboard.steps.length,
      RELEASE_DATE: "d",
      RELEASE_ISO_DATE: "d",
      RELEASE_SUMMARY: "s",
      RELEASE_URL: "u",
      INSTALLER_URL: "u",
      INSTALLER_SIZE: "1 MB",
      EXTENSION_URL: "u",
      CHECKSUM_URL: "u",
      PORTABLE_URL: "u",
      PORTABLE_SIZE: "1 MB",
    };
    assert.doesNotMatch(renderSite(html, values), /\{\{[A-Z_]+\}\}/, file);
  }
});
