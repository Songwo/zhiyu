import test from "node:test";
import assert from "node:assert/strict";
import { waitForReleaseMetadata } from "./release-metadata.mjs";

const tag = "v1.17.8";
const draft = { id: 434807576, tag_name: tag, draft: true, assets: [] };

test("草稿立即可见时无需等待，并保留附件和草稿状态", async () => {
  const release = await waitForReleaseMetadata(() => [draft], tag, {
    delay: () => assert.fail("不应等待"),
  });
  assert.equal(release, draft);
});

test("草稿列表延迟更新时只重读，不能误选其他版本或接受缺失 ID", async () => {
  const responses = [
    [{ ...draft, tag_name: "v1.17.6" }],
    [{ tag_name: tag }],
    [{ ...draft, id: 0 }],
    [draft],
  ];
  const delays = [];
  const release = await waitForReleaseMetadata(() => responses.shift(), tag, {
    delay: (ms) => delays.push(ms),
  });
  assert.equal(release, draft);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.equal(responses.length, 0);
});

test("持续不可见时在六次读取后终止，禁止无限重试", async () => {
  let reads = 0;
  const delays = [];
  await assert.rejects(
    waitForReleaseMetadata(
      () => {
        reads += 1;
        return [];
      },
      tag,
      { delay: (ms) => delays.push(ms) },
    ),
    /发布草稿元数据尚不可用：v1\.17\.8/,
  );
  assert.equal(reads, 6);
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
});

test("接口鉴权或网络失败原样上抛，不重复调用", async () => {
  const failure = new Error("HTTP 403");
  let reads = 0;
  await assert.rejects(
    waitForReleaseMetadata(
      () => {
        reads += 1;
        throw failure;
      },
      tag,
      { delay: () => assert.fail("不应等待") },
    ),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});
