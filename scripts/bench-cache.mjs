#!/usr/bin/env node
// 缓存与性能基准（docs/archive/plans/v0.9.0 验证计划）：
// 对比 RAG 索引「全量重建」与「签名复用」的耗时，数据不变时第二个问题起免重建。
// 运行：node scripts/bench-cache.mjs
import { LocalIndex } from "../electron/services/rag.mjs";
import { demoSnapshot, mergeDemo } from "../electron/services/demo.mjs";

const RUNS = 7;
const snapshot = mergeDemo(demoSnapshot());
const documents = Array.from({ length: 12 }, (_, i) => ({
  id: `bench-${i}`,
  name: `基准文档 ${i}`,
  text: "司南缓存性能基准：资产问答、本地检索与知识库分块验证内容。".repeat(160),
  addedAt: "2026-09-10",
}));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function time(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

const buildTimes = [];
for (let i = 0; i < RUNS; i++)
  buildTimes.push(await time(() => void new LocalIndex(snapshot, documents)));

const built = new LocalIndex(snapshot, documents);
const saved = { version: 1, signature: built.signature, index: built.searcher.toJSON() };
const reuseTimes = [];
for (let i = 0; i < RUNS; i++) {
  const ms = await time(() => void new LocalIndex(snapshot, documents, saved));
  reuseTimes.push(ms);
  if (i === 0) {
    // 正确性抽检：复用结果必须与重建一致。
    const reused = new LocalIndex(snapshot, documents, saved);
    if (!reused.reused) throw new Error("基准失败：签名复用未命中");
    for (const query of ["服务器", "邮箱", "基准文档"])
      if (
        JSON.stringify(reused.search(query, 6).map((x) => x.id)) !==
        JSON.stringify(built.search(query, 6).map((x) => x.id))
      )
        throw new Error(`基准失败：复用结果与重建不一致（${query}）`);
  }
}

const buildMs = median(buildTimes);
const reuseMs = median(reuseTimes);
console.log(
  JSON.stringify(
    {
      docs: built.docs.length,
      runs: RUNS,
      rebuildMs: Number(buildMs.toFixed(1)),
      reuseMs: Number(reuseMs.toFixed(1)),
      speedup: Number((buildMs / reuseMs).toFixed(1)),
      resultsEquivalent: true,
    },
    null,
    2,
  ),
);
