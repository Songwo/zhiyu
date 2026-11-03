import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveBrandIcon } from "../src/lib/brand-icons.mjs";
import { BRAND_FILES } from "../src/lib/brand-files.mjs";
import { CHINA_BANKS } from "../electron/services/card-issuers.mjs";

test("每家国内银行都有本地图标，简称与全称指向同一资源", () => {
  for (const [code, name, aliases] of CHINA_BANKS) {
    const expected = `bank-${code.toLowerCase()}`;
    assert.equal(resolveBrandIcon({ provider: name })?.id, expected);
    assert.equal(resolveBrandIcon({ provider: aliases.split("|")[0] })?.id, expected);
  }
});

test("AI 订阅与常见资产自动匹配，现有 OAuth 展示名受支持", () => {
  for (const [provider, id] of [
    ["OpenAI / ChatGPT", "openai"],
    ["Anthropic / Claude", "claude"],
    ["xAI / Grok", "grok"],
    ["Google / Gemini", "gemini"],
    ["GitHub Copilot", "githubcopilot"],
    ["DeepSeek", "deepseek"],
    ["通义千问", "qwen"],
    ["Cloudflare", "cloudflare"],
    ["阿里云", "alibabacloud"],
    ["Let's Encrypt", "letsencrypt"],
    ["Wise", "wise"],
    ["Visa", "visa"],
    ["银联", "unionpay"],
  ])
    assert.equal(resolveBrandIcon({ provider })?.id, id);
  assert.equal(resolveBrandIcon({ os: "Ubuntu 24.04 LTS" })?.id, "ubuntu");
  assert.equal(resolveBrandIcon({ registrar: "Namecheap" })?.id, "namecheap");
  assert.equal(resolveBrandIcon({ address: "synthetic@gmail.com" })?.id, "gmail");
  assert.equal(resolveBrandIcon({ provider: "Cloudflare", os: "Ubuntu" })?.id, "cloudflare");
});

test("只信任域名边界，未知品牌保留默认图标，不联网猜 favicon", () => {
  assert.equal(resolveBrandIcon({ url: "https://dash.cloudflare.com/path" })?.id, "cloudflare");
  assert.equal(resolveBrandIcon({ url: "https://cloudflare.com.attacker.example" }), undefined);
  assert.equal(resolveBrandIcon({ url: "https://cloudflare.com@attacker.example" }), undefined);
  assert.equal(resolveBrandIcon({ url: "javascript:cloudflare.com" }), undefined);
  assert.equal(resolveBrandIcon({ url: "https://example.test/cloudflare.com" }), undefined);
  assert.equal(resolveBrandIcon({ name: "OpenAI 代理自定义" }), undefined);
  assert.equal(resolveBrandIcon({ provider: "我自己的服务" }), undefined);
});

test("内置文件齐全，摘要与来源记录一致，SVG 不含执行内容或外部嵌入", async () => {
  const manifest = JSON.parse(await readFile("public/brands/manifest.json", "utf8"));
  assert.equal(manifest.icons.length, Object.keys(BRAND_FILES).length);
  assert.equal(manifest.icons.filter(({ id }) => id.startsWith("bank-")).length, 30);
  for (const item of manifest.icons) {
    assert.match(item.file, /^[a-z0-9-]+\.(svg|png)$/);
    const bytes = await readFile(`public/brands/${item.file}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.file);
    assert.equal(BRAND_FILES[item.id], item.file);
    assert.ok(item.url.startsWith("https://"));
    if (item.file.endsWith("svg")) {
      const svg = bytes.toString();
      assert.doesNotMatch(svg, /\r/, "SVG 使用规范 LF，摘要不能依赖平台换行转换");
      assert.match(svg, /<svg\b/);
      assert.doesNotMatch(
        svg,
        /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i,
      );
    } else assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  for (const group of Object.keys(manifest.sources))
    assert.ok((await readFile(`public/brands/licenses/${group}.txt`, "utf8")).length > 100);
});
