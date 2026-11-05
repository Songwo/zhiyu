import { setTimeout } from "node:timers/promises";

// 创建草稿后列表可能暂未更新；只重读元数据，避免重复创建或绕过附件校验。
export async function waitForReleaseMetadata(listReleases, tag, { delay = setTimeout } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const release = (await listReleases()).find((item) => item.tag_name === tag);
    if (Number.isSafeInteger(release?.id) && release.id > 0) return release;
    if (attempt < 5) await delay(500 * 2 ** attempt);
  }
  throw new Error(`发布草稿元数据尚不可用：${tag}；已停止发布，可稍后重试。`);
}
