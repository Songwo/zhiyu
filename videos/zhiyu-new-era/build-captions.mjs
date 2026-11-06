import { readFile, writeFile } from "node:fs/promises";
const directory = new URL("./", import.meta.url);
const captions = JSON.parse(await readFile(new URL("captions.json", directory), "utf8"));
const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const html = `<template>
  <style>
    @font-face { font-family: "Zhiyu Sans"; src: url("assets/fonts/NotoSansSC-subset.woff2"); font-weight: 100 900; }
    #root { position:absolute; inset:0; pointer-events:none; font-family:"Zhiyu Sans",sans-serif; }
    .caption-line { position:absolute; left:192px; right:192px; top:972px; margin:0; padding:10px 20px; border-radius:10px; background:#f4f7fc; color:#17263d; font-size:34px; line-height:1.5; text-align:center; white-space:nowrap; max-width:1536px; }
  </style>
  <div id="root" data-composition-id="captions" data-duration="156" data-width="1920" data-height="1080">
${captions.map(([start, end, text], index) => `    <div id="captions-group-${index + 1}" class="clip" data-start="${start}" data-duration="${(end - start).toFixed(3)}"><p class="caption-line">${escape(text)}</p></div>`).join("\n")}
  </div>
  <script>window.__timelines['captions'] = gsap.timeline({paused:true});</script>
</template>\n`;
await writeFile(new URL("compositions/captions.html", directory), html);
const timecode = (seconds) =>
  new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace(".", ",");
await writeFile(
  new URL("subtitles.zh-CN.srt", directory),
  captions
    .map(
      ([start, end, text], index) =>
        `${index + 1}\n${timecode(start)} --> ${timecode(end)}\n${text}\n`,
    )
    .join("\n"),
);
console.log(`Built ${captions.length} caption groups`);
