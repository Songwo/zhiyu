import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

// 结构校验放在已执行 npm ci 的主 CI；Pages 渲染测试继续只使用 Node 内置模块。
test("Pages 仅从 main 部署，发布标签不直接进入受保护环境", async () => {
  const workflow = yaml.load(await readFile(".github/workflows/pages.yml", "utf8"));
  assert.equal(workflow.on.release, undefined, "release 事件引用标签，会被只允许 main 的环境拒绝");
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.workflow_run.workflows, ["Windows 正式版"]);
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.match(workflow.jobs.deploy.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.deploy.if, /conclusion == 'success'/);
  assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
  assert.equal(workflow.jobs.deploy.steps[0].with.ref, "main");
});
