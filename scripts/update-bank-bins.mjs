import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { CHINA_BANKS } from "../electron/services/card-issuers.mjs";

// 固定来源版本；升级时先审核上游许可证与数据，再修改版本号。
const commit = "79af3e5d1bd381537c2f0e95c03584c911963d1e";
const base = `https://raw.githubusercontent.com/caijf/bankcard/${commit}`;
async function download(path) {
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${path}`);
  return response.text();
}
const [source, license] = await Promise.all([download("src/data/bin.ts"), download("LICENSE")]);
if (!license.startsWith("MIT License\n") || !license.includes("Copyright (c) 2019 caijf"))
  throw new Error("Unexpected upstream license");
const allowed = new Set(CHINA_BANKS.map(([code]) => code));
const rows = [...source.matchAll(/\{ bin: '(\d+)', bank: '(\w+)', type: \w+, len: (\d+) \}/g)]
  .map(([, bin, bank, length]) => [bin, bank, Number(length)])
  .filter(([bin, bank]) => bin.length >= 6 && allowed.has(bank));
for (const code of allowed)
  if (!rows.some(([, bank]) => bank === code)) throw new Error(`Missing bank: ${code}`);
rows.sort(
  (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
);
await mkdir("electron/services/data", { recursive: true });
await writeFile("electron/services/data/bankcard-LICENSE.txt", license);
await writeFile(
  "electron/services/data/card-bank-bins.mjs",
  await format(
    [
      "// 此文件由 scripts/update-bank-bins.mjs 生成；源数据 MIT 许可证见同目录 bankcard-LICENSE.txt。",
      `// 来源 caijf/bankcard@${commit}，src/data/bin.ts SHA256: ${createHash("sha256").update(source).digest("hex")}`,
      "/** @type {[string, string, number][]} */",
      `export const CHINA_BANK_BINS = ${JSON.stringify(rows)};`,
      "",
    ].join("\n"),
    { parser: "babel", printWidth: 100 },
  ),
);
console.log(JSON.stringify({ banks: allowed.size, bins: rows.length, commit }));
