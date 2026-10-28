import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 只提供预览所需的静态文件，避免把项目与本机目录暴露给浏览器。
const files = new Map([
  ["/", ["public/installer-preview/index.html", "text/html; charset=utf-8"]],
  ["/installer-preview/", ["public/installer-preview/index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["public/installer-preview/style.css", "text/css"]],
  ["/preview.mjs", ["public/installer-preview/preview.mjs", "text/javascript"]],
  ["/installer-preview/style.css", ["public/installer-preview/style.css", "text/css"]],
  ["/installer-preview/preview.mjs", ["public/installer-preview/preview.mjs", "text/javascript"]],
  ["/brand/zhiyu.svg", ["public/brand/zhiyu.svg", "image/svg+xml"]],
  ["/favicon.ico", ["public/brand/zhiyu.svg", "image/svg+xml"]],
  ["/LICENSE", ["LICENSE", "text/plain; charset=utf-8"]],
]);

export function createPreviewServer() {
  return createServer(async (request, response) => {
    const entry = files.get(new URL(request.url, "http://preview").pathname);
    if (!entry || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      const content = await readFile(resolve(root, entry[0]));
      response.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(500).end("Preview asset unavailable");
    }
  });
}

export async function exportPreview(destination) {
  const [html, css, script, logo] = await Promise.all([
    readFile(resolve(root, "public/installer-preview/index.html"), "utf8"),
    readFile(resolve(root, "public/installer-preview/style.css"), "utf8"),
    readFile(resolve(root, "public/installer-preview/preview.mjs"), "utf8"),
    readFile(resolve(root, "public/brand/zhiyu.svg")),
  ]);
  const standalone = html
    .replace(/<link rel="stylesheet" href="\.\/style.css"\s*\/>/, () => `<style>${css}</style>`)
    .replace(
      /<script type="module" src="\.\/preview.mjs"><\/script>/,
      () => `<script type="module">${script}</script>`,
    )
    .replaceAll("/brand/zhiyu.svg", `data:image/svg+xml;base64,${logo.toString("base64")}`)
    .replace('href="/LICENSE"', 'href="https://github.com/Songwo/zhiyu/blob/main/LICENSE"');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, standalone);
}

if (process.argv[2] === "--export") {
  await exportPreview(resolve(root, "screenshots/installer-preview/知屿安装体验.html"));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(8080, "0.0.0.0", () => {
    console.log("Installer design preview: http://127.0.0.1:8080/installer-preview/");
  });
}
