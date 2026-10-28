/**
 * 从 site/zsp-steps.json 生成会自动循环播放的协议动画 site/zsp-flow.svg（README 和文档里直接引用）。
 *
 * 只用 CSS 动画，没有脚本，GitHub 在 <img> 里也能播放；颜色跟随系统的明暗主题。
 * 只取分镜里标了 "readme": true 的关键步骤，让循环保持在一分钟以内。
 *
 * 用法：node scripts/build-zsp-svg.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const W = 960;
const H = 540;
const STEP_SECONDS = 6.5;
const FADE = 0.35;
const X = { desktop: 170, server: 790 };
const WIRE = { left: 222, right: 738, y: 170 };

const esc = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
/** 估算文字宽度：CJK 约 1 em，其余约 0.56 em。 */
const units = (text) =>
  [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.56), 0);
function wrap(text, maxUnits) {
  const lines = [];
  let line = "";
  for (const ch of text) {
    if (units(line + ch) > maxUnits) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}
const firstSentences = (text, maxLines, maxUnits) => {
  const lines = wrap(text, maxUnits);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`;
  return kept;
};
const pct = (seconds, total) => `${((seconds / total) * 100).toFixed(3)}%`;

export function buildSvg(storyboard) {
  const steps = storyboard.steps.filter((step) => step.readme);
  const total = steps.length * STEP_SECONDS;
  const chapterTitle = (id) => storyboard.chapters.find((c) => c.id === id)?.title ?? "";
  const css = [];
  const body = [];

  steps.forEach((step, i) => {
    const start = i * STEP_SECONDS;
    const end = start + STEP_SECONDS;
    css.push(
      `@keyframes v${i}{0%{opacity:0}${i === 0 ? "" : `${pct(start, total)}{opacity:0}`}${pct(start + FADE, total)}{opacity:1}${pct(end - FADE, total)}{opacity:1}${pct(end, total)}{opacity:0}100%{opacity:0}}`,
      `.s${i}{animation:v${i} ${total}s linear infinite;opacity:0}`,
    );
    const parts = [];
    parts.push(
      `<text class="pill" x="928" y="42" text-anchor="end">${esc(chapterTitle(step.chapter))} · ${i + 1}/${steps.length}</text>`,
    );
    // 徽章：每个角色最多 3 条。
    for (const side of ["desktop", "server"]) {
      (step.badges?.[side] ?? []).slice(0, 3).forEach((text, k) => {
        const width = Math.round(units(text) * 13 + 24);
        const x = X[side] - width / 2;
        const y = 292 + k * 34;
        parts.push(
          `<rect class="chip${/✓/.test(text) ? " ok" : ""}" x="${x}" y="${y}" width="${width}" height="26" rx="13"/>` +
            `<text class="chip-t${/✓/.test(text) ? " ok" : ""}" x="${X[side]}" y="${y + 17.5}" text-anchor="middle">${esc(text)}</text>`,
        );
      });
    }
    parts.push(
      `<text class="muted small" x="480" y="${step.human ? 150 : 152}" text-anchor="middle">${step.human ? "不经过网络" : step.attacker ? "有人在这条线上" : "网络（可能被监听）"}</text>`,
    );

    const movers = [];
    const pill = (label, enc, className, width) =>
      `<rect class="${className}" width="${width}" height="28" rx="14"/>` +
      (enc ? `<text class="lock" x="12" y="19">🔒</text>` : "") +
      `<text class="pk" x="${enc ? 30 : 14}" y="19">${esc(label)}</text>`;
    const fly = (name, spec, from, to, begin, seconds) => {
      const width = Math.round(units(spec.label) * 13 + (spec.enc ? 48 : 30));
      const at = (p) => `translate(${p.x}px,${p.y}px)`;
      css.push(
        `@keyframes ${name}{0%,${pct(start + begin, total)}{transform:${at(from(width))};opacity:0}${pct(start + begin + 0.2, total)}{transform:${at(from(width))};opacity:1}${pct(start + begin + seconds, total)}{transform:${at(to(width))};opacity:1}100%{transform:${at(to(width))};opacity:1}}`,
        `.${name}{animation:${name} ${total}s ease-in-out infinite}`,
      );
      movers.push(
        `<g class="${name}">${pill(spec.label, spec.enc, spec.kind ?? "pk-bg", width)}</g>`,
      );
    };
    if (step.human)
      fly(
        `h${i}`,
        { label: step.human.label, kind: "human" },
        () => ({ x: WIRE.right - 150, y: 92 }),
        () => ({ x: WIRE.left + 8, y: 92 }),
        0.6,
        2.2,
      );
    (step.packets ?? []).forEach((packet, k) => {
      const ltr = packet.from === "desktop";
      const y = ltr ? WIRE.y - 40 : WIRE.y + 12;
      fly(
        `p${i}_${k}`,
        { ...packet, kind: packet.enc ? "pk-enc" : "pk-bg" },
        (w) => ({ x: ltr ? WIRE.left : WIRE.right - w, y }),
        (w) => ({ x: ltr ? WIRE.right - w : WIRE.left, y }),
        0.7 + k * 1.7,
        1.5,
      );
    });
    if (step.attacker) {
      const target = X[step.attacker.target];
      parts.push(
        `<circle class="evil-bg" cx="480" cy="372" r="30"/><text class="evil" x="480" y="381" text-anchor="middle">☠</text>` +
          `<text class="muted small" x="480" y="424" text-anchor="middle">捣乱的人</text>`,
      );
      const width = Math.round(units(step.attacker.label) * 13 + 30);
      const from = { x: 480 - width / 2, y: 340 };
      const to = { x: target + (target < 480 ? 54 : -54 - width), y: 214 };
      css.push(
        `@keyframes a${i}{0%,${pct(start + 0.7, total)}{transform:translate(${from.x}px,${from.y}px);opacity:0}${pct(start + 0.9, total)}{transform:translate(${from.x}px,${from.y}px);opacity:1}${pct(start + 2.4, total)}{transform:translate(${to.x}px,${to.y}px);opacity:1}100%{transform:translate(${to.x}px,${to.y}px);opacity:1}}`,
        `.a${i}{animation:a${i} ${total}s ease-in-out infinite}`,
        `@keyframes r${i}{0%,${pct(start + 2.3, total)}{opacity:0}${pct(start + 2.7, total)}{opacity:1}100%{opacity:1}}`,
        `.r${i}{animation:r${i} ${total}s linear infinite;opacity:0}`,
      );
      movers.push(`<g class="a${i}">${pill(step.attacker.label, false, "pk-evil", width)}</g>`);
      const rw = Math.round(units(`✕ ${step.attacker.result}`) * 14 + 28);
      parts.push(
        `<g class="r${i}"><rect class="res" x="${target - rw / 2}" y="${WIRE.y + 166}" width="${rw}" height="32" rx="10"/>` +
          `<text class="res-t" x="${target}" y="${WIRE.y + 187}" text-anchor="middle">✕ ${esc(step.attacker.result)}</text></g>`,
      );
    }
    // 标题与理由。
    parts.push(`<text class="title" x="32" y="468">${esc(step.title)}</text>`);
    firstSentences(step.why, 2, 62).forEach((line, k) =>
      parts.push(`<text class="why" x="32" y="${496 + k * 22}">${esc(line)}</text>`),
    );
    body.push(`<g class="step s${i}">${parts.join("")}${movers.join("")}</g>`);
  });

  const icon = (cx, kind) =>
    kind === "desktop"
      ? `<g transform="translate(${cx - 24} 134)" class="ico"><rect x="6" y="9" width="36" height="24" rx="3"/><path d="M2 38h44M18 33v5M30 33v5"/></g>`
      : `<g transform="translate(${cx - 24} 134)" class="ico"><rect x="7" y="8" width="34" height="13" rx="3"/><rect x="7" y="27" width="34" height="13" rx="3"/><path d="M13 14.5h.01M13 33.5h.01M20 14.5h14M20 33.5h14"/></g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">知屿桌面版与网页版同步（ZSP）的配对与同步流程动画</title>
<desc id="d">桌面版和网页版用一次性配对码配对，之后每次同步互相认证并加密；重放、篡改、冒充、回滚都会被拒绝。完整说明见 docs/SYNC.md。</desc>
<style>
svg{--bg:#ffffff;--ink:#1b2232;--muted:#5b6478;--line:rgba(27,34,50,.22);--blue:#3b6fe0;--blue-soft:#e5edff;--teal:#138a96;--amber:#ffb23f;--red:#e5484d;--chip:#f3f4f7;--ok:#1a8a5b;font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
@media (prefers-color-scheme:dark){svg{--bg:#1b1d22;--ink:#eef0f5;--muted:#a2a8b6;--line:rgba(255,255,255,.25);--blue:#5b87f0;--blue-soft:rgba(91,135,240,.18);--teal:#35b6c2;--chip:#272a31;--ok:#47c98f}}
.bg{fill:var(--bg)}.title{font-size:22px;font-weight:700;fill:var(--ink)}.why{font-size:15px;fill:var(--muted)}
.muted{fill:var(--muted)}.small{font-size:13px}.pill{font-size:13px;fill:var(--muted)}
.wire{stroke:var(--line);stroke-width:2;stroke-dasharray:6 6;fill:none}
.ico-bg{fill:var(--blue-soft)}.ico{fill:none;stroke:var(--blue);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.name{font-size:17px;font-weight:700;fill:var(--ink)}
.chip{fill:var(--chip);stroke:var(--line);stroke-width:1}.chip.ok{stroke:var(--ok)}.chip-t{font-size:13px;fill:var(--muted)}.chip-t.ok{fill:var(--ok)}
.pk-bg{fill:var(--blue)}.pk-enc{fill:var(--teal)}.human{fill:var(--amber)}.pk-evil{fill:var(--red)}
.pk{font-size:13px;fill:#fff}.human+.pk{fill:#3a2a00}.lock{font-size:12px}
.evil-bg{fill:rgba(229,72,77,.14)}.evil{font-size:30px;fill:var(--red)}
.res{fill:rgba(229,72,77,.12)}.res-t{font-size:14px;font-weight:700;fill:var(--red)}
${css.join("\n")}
@media (prefers-reduced-motion:reduce){.step{animation:none!important;opacity:0}.s0{opacity:1!important}*[class*="p0_"],*[class*="h0"]{animation:none!important;opacity:1!important}}
</style>
<rect class="bg" width="${W}" height="${H}" rx="22"/>
<text class="pill" x="32" y="42">知屿 · 同步协议 ZSP</text>
<line class="wire" x1="${WIRE.left}" y1="${WIRE.y}" x2="${WIRE.right}" y2="${WIRE.y}"/>
<rect class="ico-bg" x="${X.desktop - 38}" y="132" width="76" height="76" rx="20"/>${icon(X.desktop, "desktop")}
<text class="name" x="${X.desktop}" y="236" text-anchor="middle">桌面版</text><text class="muted small" x="${X.desktop}" y="256" text-anchor="middle">你的电脑</text>
<rect class="ico-bg" x="${X.server - 38}" y="132" width="76" height="76" rx="20"/>${icon(X.server, "server")}
<text class="name" x="${X.server}" y="236" text-anchor="middle">网页版</text><text class="muted small" x="${X.server}" y="256" text-anchor="middle">你的 VPS</text>
${body.join("\n")}
</svg>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const storyboard = JSON.parse(await readFile(join(root, "site/zsp-steps.json"), "utf8"));
  const svg = buildSvg(storyboard);
  await writeFile(join(root, "site/zsp-flow.svg"), svg);
  console.log(
    `site/zsp-flow.svg 已生成：${storyboard.steps.filter((s) => s.readme).length} 步，${svg.length} 字节`,
  );
}
