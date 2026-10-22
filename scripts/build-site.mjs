import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "https://github.com/Songwo/zhiyu";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function releaseDetails(release) {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "")?.[1];
  const published = new Date(release.published_at);
  if (
    !version ||
    release.draft !== false ||
    release.prerelease !== false ||
    !release.published_at ||
    !Number.isFinite(published.valueOf())
  )
    throw new Error("A published stable release is required");
  const releaseUrl = `${repository}/releases/tag/v${version}`;
  if (release.html_url !== releaseUrl) throw new Error("Unexpected release URL");
  const asset = (name) => {
    const entry = release.assets?.find((item) => item.name === name);
    if (!entry || entry.state !== "uploaded" || !Number.isFinite(entry.size) || entry.size <= 0)
      throw new Error(`Published asset is missing or incomplete: ${name}`);
    if (entry.browser_download_url !== `${repository}/releases/download/v${version}/${name}`)
      throw new Error(`Unexpected asset URL: ${name}`);
    return entry;
  };
  const brand = release.assets?.some((item) => item.name === `Zhiyu-${version}-setup.exe`)
    ? "Zhiyu"
    : "Nanpad";
  const installer = asset(`${brand}-${version}-setup.exe`);
  const extension = asset(`${brand}-${version}-browser-extension.zip`);
  const checksum = asset("SHA256SUMS.txt");
  // 便携版自 1.7.4 起提供；旧版本没有时退回到 Release 页面。
  const portable = release.assets?.some(
    (item) => item.name === `${brand}-${version}-portable-x64.zip`,
  )
    ? asset(`${brand}-${version}-portable-x64.zip`)
    : null;
  // 只取发布说明首段，作为普通文本转义；不执行 Markdown/HTML。
  const paragraph = (release.body ?? "")
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .find((part) => {
      const text = part.trim();
      return text && !/^(?:#|[-*>]|\d+\.|```)/.test(text);
    });
  const summary = (paragraph?.trim() || release.name || `知屿 Zhiyu ${version}`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ");
  return {
    VERSION: version,
    RELEASE_DATE: `${published.getUTCFullYear()}年${published.getUTCMonth() + 1}月${published.getUTCDate()}日`,
    RELEASE_ISO_DATE: published.toISOString().slice(0, 10),
    RELEASE_SUMMARY: summary.length > 220 ? `${summary.slice(0, 220)}…` : summary,
    RELEASE_URL: releaseUrl,
    INSTALLER_URL: installer.browser_download_url,
    INSTALLER_SIZE: `${Math.round(installer.size / 1_000_000)} MB`,
    EXTENSION_URL: extension.browser_download_url,
    CHECKSUM_URL: checksum.browser_download_url,
    PORTABLE_URL: portable?.browser_download_url ?? releaseUrl,
    PORTABLE_SIZE: portable ? `${Math.round(portable.size / 1_000_000)} MB` : "解压即用",
  };
}

export function renderSite(template, values) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown site template field: ${key}`);
    return escape(values[key]);
  });
}

async function buildSite(releaseFile, outputDirectory) {
  if (!releaseFile || !outputDirectory)
    throw new Error("Usage: node scripts/build-site.mjs <release.json> <output-directory>");
  const release = JSON.parse((await readFile(releaseFile, "utf8")).replace(/^\uFEFF/, ""));
  const details = releaseDetails(release);
  const source = join(root, "site");
  const files = [
    "style.css",
    "icon.png",
    "favicon.svg",
    "overview.png",
    "overview-dark.png",
    "detail.png",
    "renewals.png",
    "documents.png",
    "table.png",
    "usage.png",
    "vault.png",
    "promo.mp4",
    "promo-poster.jpg",
    "robots.txt",
    "sitemap.xml",
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(await readFile(join(source, file)));
  const html = renderSite(await readFile(join(source, "index.html"), "utf8"), {
    ...details,
    ASSET_REVISION: hash.digest("hex").slice(0, 12),
  });
  // 完成校验和渲染后才写入输出，附件缺失时不发布半成品。
  const output = resolve(outputDirectory);
  if (output === source || output === root)
    throw new Error("Output must be separate from site sources");
  await mkdir(output, { recursive: true });
  for (const file of files) await cp(join(source, file), join(output, file));
  await writeFile(join(output, "index.html"), html);
  await writeFile(join(output, "release.json"), `${JSON.stringify(details, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, version: details.VERSION, output, assets: files.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSite(process.argv[2], process.argv[3]);
}
