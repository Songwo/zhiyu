import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import handler from "../.vercel/output/functions/__server.func/index.mjs";

// Windows 验收生产产物；不使用依赖 /proc 的 Linux preview:restart，也不占用固定端口。
const root = resolve(".vercel/output/static");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:" + server.address().port);
    const file = resolve(root, "." + decodeURIComponent(url.pathname));
    const sub = relative(root, file);
    if (sub.startsWith("..") || isAbsolute(sub)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
      res.end(bytes);
      return;
    } catch (error) {
      if (!["ENOENT", "EISDIR"].includes(error.code)) throw error;
    }
    const response = await handler.fetch(new Request(url, { headers: req.headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end("生产预览请求失败");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
await writeFile(".claude/codex-handoff/relations-built-server.json", JSON.stringify({ base }));
console.log(JSON.stringify({ ready: true, base }));
