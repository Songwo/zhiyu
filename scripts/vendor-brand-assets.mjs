import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

// 仅开发时下载；运行中的软件只读取打包的文件，不查询第三方图标服务。
const root = "public/brands";
await mkdir(`${root}/licenses`, { recursive: true });
const sources = {
  lobe: {
    repo: "lobehub/lobe-icons",
    commit: "8064bdc847be0a94c956c00440eb67586af2871f",
    license: "MIT",
  },
  simple: {
    repo: "simple-icons/simple-icons",
    commit: "90646e4bf7f3b89df6c37e65baf3e7bc759a517c",
    license: "CC0-1.0",
  },
  payment: {
    repo: "orzFly/payment-webfont-cn",
    commit: "f699522215d4a22d58e728a663a2f8705588e1d1",
    license: "CC0-1.0",
  },
};
const raw = (group, path) =>
  `https://raw.githubusercontent.com/${sources[group].repo}/${sources[group].commit}/${path}`;
async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(18000),
    headers: { "User-Agent": "Zhiyu-asset-vendor" },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}
const records = [];
for (const [group, source] of Object.entries(sources)) {
  const license = await (
    await download(raw(group, group === "simple" ? "LICENSE.md" : "LICENSE"))
  ).text();
  await writeFile(`${root}/licenses/${group}.txt`, license);
  console.log(`License: ${source.repo}`);
}
const ai = [
  "openai",
  "claude-color",
  "grok",
  "gemini-color",
  "deepseek-color",
  "qwen-color",
  "doubao-color",
  "minimax-color",
  "kimi-color",
  "moonshot",
  "zhipu-color",
  "perplexity-color",
  "cursor",
  "copilot-color",
  "githubcopilot",
  "mistral-color",
  "ollama",
  "openrouter-color",
  "huggingface-color",
  "aws-color",
  "azure-color",
  "tencentcloud-color",
  "microsoft-color",
  "google-color",
  "volcengine-color",
];
const common = [
  "cloudflare",
  "github",
  "gitlab",
  "digitalocean",
  "vultr",
  "hetzner",
  "ovh",
  "googlecloud",
  "alibabacloud",
  "huawei",
  "docker",
  "ubuntu",
  "debian",
  "centos",
  "almalinux",
  "rockylinux",
  "nginx",
  "caddy",
  "letsencrypt",
  "vercel",
  "netlify",
  "render",
  "railway",
  "namecheap",
  "godaddy",
  "porkbun",
  "gmail",
  "protonmail",
  "icloud",
  "telegram",
  "notion",
  "discord",
  "spotify",
  "netflix",
  "youtube",
  "dropbox",
  "bitwarden",
  "1password",
  "paypal",
  "wise",
  "revolut",
  "visa",
  "mastercard",
  "americanexpress",
  "jcb",
  "discover",
];
const jobs = [
  ...ai.map((name) => ({
    id: name.replace(/-color$/, ""),
    url: raw("lobe", `packages/static-svg/icons/${name}.svg`),
    source: "lobe",
  })),
  ...common.map((id) => ({ id, url: raw("simple", `icons/${id}.svg`), source: "simple" })),
  { id: "unionpay", url: raw("payment", "svg/unionpay.svg"), source: "payment" },
];
const upstreamData = JSON.parse(
  await (await download(raw("simple", "data/simple-icons.json"))).text(),
);
for (let start = 0; start < jobs.length; start += 8) {
  await Promise.all(
    jobs.slice(start, start + 8).map(async ({ id, url, source }) => {
      // 仓库统一使用 LF；在计算摘要前规范换行，避免跨平台检出后校验不一致。
      let svg = (await (await download(url)).text()).replace(/\r\n?/g, "\n");
      if (
        !/<svg\b/.test(svg) ||
        /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(
          svg,
        )
      )
        throw new Error(`Unsafe SVG: ${id}`);
      let origin;
      if (source === "simple") {
        const item = upstreamData.find(
          (item) => item.slug === id || item.title.toLowerCase().replace(/[^a-z0-9]/g, "") === id,
        );
        if (item?.hex) svg = svg.replace("<svg ", `<svg fill="#${item.hex}" `);
        origin = item
          ? {
              originalSource: item.source,
              guidelines: item.guidelines,
              originalLicense: item.license,
            }
          : undefined;
      }
      const file = `${id}.svg`;
      await writeFile(`${root}/${file}`, svg);
      records.push({
        id,
        file,
        url,
        source,
        license: sources[source].license,
        ...origin,
        sha256: createHash("sha256").update(svg).digest("hex"),
      });
    }),
  );
}
// 国内银行采用支付宝公开银行标识，截取左侧标志以适应小图标。商标仅用于识别资产。
const banks = {
  ICBC: "www.icbc.com.cn",
  CCB: "www.ccb.com",
  ABC: "www.abchina.com",
  BOC: "www.boc.cn",
  COMM: "www.bankcomm.com",
  PSBC: "www.psbc.com",
  CMB: "www.cmbchina.com",
  CITIC: "www.citicbank.com",
  CEB: "www.cebbank.com",
  HXBANK: "www.hxb.com.cn",
  CMBC: "www.cmbc.com.cn",
  SPABANK: "bank.pingan.com",
  CIB: "www.cib.com.cn",
  SPDB: "www.spdb.com.cn",
  GDB: "www.cgbchina.com.cn",
  CZBANK: "www.czbank.com",
  BOHAIB: "www.cbhb.com.cn",
  EGBANK: "www.hfbank.com.cn",
  BJBANK: "www.bankofbeijing.com.cn",
  SHBANK: "www.bosc.cn",
  JSBANK: "www.jsbchina.cn",
  NJCB: "www.njcb.com.cn",
  NBBANK: "www.nbcb.com.cn",
  HZCB: "www.hzbank.com.cn",
  CDCB: "www.bocd.com.cn",
  CSCB: "www.cscb.cn",
  CQBANK: "www.cqcbank.com",
  GCB: "www.gzcb.com.cn",
  HSBANK: "www.hsbank.com.cn",
  DLB: "www.bankofdl.com",
};
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  for (let start = 0; start < Object.keys(banks).length; start += 6) {
    await Promise.all(
      Object.entries(banks)
        .slice(start, start + 6)
        .map(async ([code, domain]) => {
          const url = `https://apimg.alipay.com/combo.png?d=cashier&t=${code}`;
          try {
            const response = await download(url);
            let bytes = Buffer.from(await response.arrayBuffer());
            const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
            const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const ico = bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
            const gif = bytes.subarray(0, 3).toString() === "GIF";
            const jpeg = bytes[0] === 255 && bytes[1] === 216;
            if ((!png && !ico && !gif && !jpeg) || bytes.length > 256000)
              throw new Error("Not a supported small image");
            const id = `bank-${code.toLowerCase()}`;
            const cropWidth = { CEB: 47, CSCB: 44, SPABANK: 38, BOHAIB: 38 }[code] || 34;
            const output = await page.evaluate(
              async ({ source, cropWidth }) => {
                const img = new Image();
                img.src = source;
                await img.decode();
                const original = document.createElement("canvas");
                original.width = img.naturalWidth;
                original.height = img.naturalHeight;
                const originalContext = original.getContext("2d");
                originalContext.drawImage(img, 0, 0);
                const pixels = originalContext.getImageData(
                  0,
                  0,
                  original.width,
                  original.height,
                ).data;
                const ink = (x, y) => {
                  const offset = (y * original.width + x) * 4;
                  return (
                    pixels[offset + 3] > 100 &&
                    Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 220
                  );
                };
                const columns = Array.from(
                  { length: Math.min(cropWidth, original.width) },
                  (_, x) =>
                    Array.from({ length: original.height }, (_, y) => ink(x, y)).some(Boolean),
                );
                let left = columns.findIndex(Boolean);
                if (left < 0) throw new Error("Empty bank symbol");
                let right = cropWidth;
                for (let x = left + 1; x < columns.length - 1; x++)
                  if (!columns[x] && !columns[x + 1]) {
                    right = x;
                    break;
                  }
                let top = original.height,
                  bottom = 0;
                for (let y = 0; y < original.height; y++)
                  for (let x = left; x < right; x++)
                    if (ink(x, y)) {
                      top = Math.min(top, y);
                      bottom = Math.max(bottom, y + 1);
                    }
                if (right <= left || bottom <= top) throw new Error("Invalid bank symbol crop");
                const canvas = document.createElement("canvas");
                canvas.width = 72;
                canvas.height = 72;
                const context = canvas.getContext("2d");
                context.fillStyle = "#fff";
                context.fillRect(0, 0, 72, 72);
                const width = right - left,
                  height = bottom - top;
                const scale = 60 / Math.max(width, height);
                context.drawImage(
                  img,
                  left,
                  top,
                  width,
                  height,
                  (72 - width * scale) / 2,
                  (72 - height * scale) / 2,
                  width * scale,
                  height * scale,
                );
                return canvas.toDataURL("image/png").split(",")[1];
              },
              { source: `data:image/png;base64,${bytes.toString("base64")}`, cropWidth },
            );
            bytes = Buffer.from(output, "base64");
            const file = `${id}.png`;
            await writeFile(`${root}/${file}`, bytes);
            records.push({
              id,
              file,
              url,
              officialWebsite: `https://${domain}`,
              source: "alipay-bank-assets",
              license: "Bank trademark; identification only",
              transform: `Left symbol within ${cropWidth}px, trimmed at blank-column gap and ink bounds; white canvas 72px`,
              sourceSha256,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
            console.log(`Bank icon: ${code}`);
          } catch (error) {
            console.log(`Bank icon unavailable: ${code} ${error.message}`);
          }
        }),
    );
  }
} finally {
  await browser.close();
}
records.sort((a, b) => a.id.localeCompare(b.id));
if (records.filter(({ id }) => id.startsWith("bank-")).length !== Object.keys(banks).length)
  throw new Error("Bank assets incomplete; keep the previous manifest until all downloads succeed");
const outputFiles = new Set(records.map(({ file }) => file));
for (const file of await readdir(root))
  if (/^bank-[a-z]+\.(?:ico|gif|jpg)$/.test(file) && !outputFiles.has(file))
    await unlink(`${root}/${file}`);
await writeFile(
  `${root}/manifest.json`,
  JSON.stringify({ sources, icons: records }, null, 2) + "\n",
);
await writeFile(
  "src/lib/brand-files.mjs",
  "// 由 scripts/vendor-brand-assets.mjs 生成，仅记录已内置的文件。\n/** @type {Record<string, string>} */\nexport const BRAND_FILES = " +
    JSON.stringify(Object.fromEntries(records.map(({ id, file }) => [id, file])), null, 2) +
    ";\n",
);
console.log(
  JSON.stringify({
    icons: records.length,
    banks: records.filter((item) => item.id.startsWith("bank-")).length,
  }),
);
