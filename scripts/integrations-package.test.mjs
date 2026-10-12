import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("云服务主进程可从仅含 electron 目录的安装包布局加载，不依赖未打包 src", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhiyu-package-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(resolve("electron"), join(directory, "electron"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.mjs"),
  });
  const imported = await import(
    pathToFileURL(join(directory, "electron/services/integrations.mjs")).href
  );
  assert.equal(typeof imported.Integrations, "function");
  const images = await import(
    pathToFileURL(join(directory, "electron/services/image-data.mjs")).href
  );
  const value = images.normalizeSnapshotImages({
    servers: [
      {
        id: "fixture",
        integration: { provider: "probe", connectionId: "c", remoteId: "h", resourceType: "host" },
      },
    ],
  });
  assert.equal(value.servers[0].integration.remoteId, "h");
});
