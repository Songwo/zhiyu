import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 检查实际交付媒体，避免只更新页面文字却仍发布旧片。
function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  let offset = start;
  while (offset + 8 <= end) {
    const initialSize = buffer.readUInt32BE(offset);
    const extended = initialSize === 1;
    const size = extended
      ? Number(buffer.readBigUInt64BE(offset + 8))
      : initialSize || end - offset;
    const header = extended ? 16 : 8;
    assert.ok(size >= header && offset + size <= end, "MP4 box 不完整");
    result.push({
      type: buffer.toString("ascii", offset + 4, offset + 8),
      offset,
      start: offset + header,
      end: offset + size,
    });
    offset += size;
  }
  return result;
}

test("新版宣传片为156秒的1080p H.264/AAC，并启用网页渐进播放", async () => {
  const media = await readFile("site/promo.mp4");
  const top = boxes(media);
  assert.equal(top[0].type, "ftyp");
  const moov = top.find((box) => box.type === "moov");
  const mdat = top.find((box) => box.type === "mdat");
  assert.ok(moov && mdat && moov.offset < mdat.offset, "moov 必须在视频数据前");
  const children = boxes(media, moov.start, moov.end);
  const mvhd = children.find((box) => box.type === "mvhd");
  assert.ok(mvhd);
  const version = media[mvhd.start];
  const timeOffset = mvhd.start + (version === 1 ? 20 : 12);
  const timescale = media.readUInt32BE(timeOffset);
  const duration =
    version === 1
      ? Number(media.readBigUInt64BE(timeOffset + 4))
      : media.readUInt32BE(timeOffset + 4);
  assert.ok(Math.abs(duration / timescale - 156) <= 0.1, `实际时长 ${duration / timescale}`);
  const videoTrack = children
    .filter((box) => box.type === "trak")
    .find((track) => {
      const tkhd = boxes(media, track.start, track.end).find((box) => box.type === "tkhd");
      return (
        tkhd &&
        media.readUInt32BE(tkhd.end - 8) / 65536 === 1920 &&
        media.readUInt32BE(tkhd.end - 4) / 65536 === 1080
      );
    });
  assert.ok(videoTrack, "缺少1920×1080视频轨");
  const metadata = media.subarray(moov.start, moov.end).toString("latin1");
  assert.ok(metadata.includes("avc1"), "缺少H.264视频轨");
  assert.ok(metadata.includes("mp4a") && metadata.includes("soun"), "缺少AAC配乐轨");
});

test("主页字幕与说明覆盖新版重点功能并保留音乐署名", async () => {
  const page = await readFile("site/index.html", "utf8");
  for (const text of [
    "2 分 36 秒",
    "Jev",
    "Exa",
    "U 卡",
    "离线演示回放",
    "Kevin MacLeod",
    "creativecommons.org/licenses/by/3.0/",
  ])
    assert.ok(page.includes(text), text);
  assert.match(page, /<track\s+kind="captions"[^>]+promo\.zh-CN\.vtt/);
  const vtt = await readFile("site/promo.zh-CN.vtt", "utf8");
  assert.ok(vtt.startsWith("WEBVTT\n"));
  const ranges = [
    ...vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g),
  ];
  assert.equal(ranges.length, 21);
  let previousEnd = 0;
  for (const range of ranges) {
    const seconds = (offset) =>
      Number(range[offset]) * 3600 +
      Number(range[offset + 1]) * 60 +
      Number(range[offset + 2]) +
      Number(range[offset + 3]) / 1000;
    const start = seconds(1),
      end = seconds(5);
    assert.ok(start >= previousEnd && end > start && end <= 156);
    previousEnd = end;
  }
});
