import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { chooseOption } from "./select-helper.mjs";

// 只挂载新工作区并注入合成 bridge；不读取本机资产、Token 或生产云资源。
const origin = process.env.ZHIYU_UI_TEST_ORIGIN || "http://127.0.0.1:8080";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "zh-CN",
  viewport: { width: 1280, height: 980 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  await page.route(`${origin}/__cloud-probe-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/src/styles.css"></head><body><main id="root" style="max-width:1000px;margin:0 auto;padding:16px"></main></body></html>',
    }),
  );
  await page.goto(`${origin}/__cloud-probe-test`);
  await page.evaluate(async () => {
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { IntegrationsSettings } =
      await import("/src/components/integrations/integrations-settings.tsx");
    const { useAppStore } = await import("/src/lib/store.ts");
    useAppStore.setState({ servers: [], services: [], domains: [], hydrated: true });
    const connections = [
      {
        id: "cf",
        provider: "cloudflare",
        name: "合成云账户",
        hasToken: true,
        allowInsecure: false,
      },
      {
        id: "probe",
        provider: "probe",
        name: "合成监控",
        endpoint: "https://monitor.example.test",
        hasToken: true,
        allowInsecure: false,
      },
    ];
    const now = new Date().toISOString();
    const hosts = [
      {
        id: "host-1",
        name: "离线测试机",
        hostname: "fixture-host",
        os: "linux",
        arch: "amd64",
        status: "offline",
        lastSeen: now,
        latest: { at: now, cpu: 17, memory: 30, disk: null, rxRate: 23, txRate: 12 },
      },
    ];
    const checks = [];
    const records = [
      {
        id: "dns-1",
        type: "A",
        name: "example.test",
        content: "192.0.2.1",
        ttl: 300,
        proxied: false,
        comment: "原有备注",
      },
      { id: "dns-https", type: "HTTPS", name: "secure.example.test", content: "1 .", ttl: 300 },
    ];
    window.__calls = {
      inventory: [],
      saves: [],
      binds: [],
      previews: [],
      applies: [],
      checks: [],
      revokes: [],
      deletes: [],
    };
    window.__failOnce = false;
    window.__hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden });
    window.sinan = {
      integrations: {
        list: async () => structuredClone(connections),
        save: async (input) => {
          window.__calls.saves.push(structuredClone(input));
          const saved = {
            ...input,
            id: input.id || "added",
            hasToken: true,
            allowInsecure: !!input.allowInsecure,
          };
          delete saved.token;
          const index = connections.findIndex((item) => item.id === saved.id);
          if (index < 0) connections.push(saved);
          else connections[index] = saved;
          return structuredClone(saved);
        },
        remove: async (id) => {
          connections.splice(
            connections.findIndex((item) => item.id === id),
            1,
          );
        },
        inventory: async (id, force) => {
          window.__calls.inventory.push({ id, force });
          if (window.__failOnce) {
            window.__failOnce = false;
            throw new Error("合成网络错误");
          }
          return {
            resources:
              id === "cf"
                ? [
                    {
                      key: "zone:zone-1",
                      type: "zone",
                      remoteId: "zone-1",
                      name: "example.test",
                      url: "https://example.test",
                      status: "active",
                    },
                  ]
                : [
                    ...hosts.map((host) => ({
                      key: `host:${host.id}`,
                      type: "host",
                      remoteId: host.id,
                      name: host.name,
                      url: "",
                      status: host.status,
                      host,
                    })),
                    ...checks.map((check) => ({
                      key: `check:${check.id}`,
                      type: "check",
                      remoteId: check.id,
                      name: check.name,
                      url: check.target,
                      status: check.status,
                      check,
                    })),
                  ],
            warnings: [],
            cached: !force,
            fetchedAt: new Date().toISOString(),
          };
        },
        bind: async (input) => {
          window.__calls.binds.push(input);
          return { kind: "domain", id: "asset-1" };
        },
        unbind: async () => {},
        dnsList: async () => structuredClone(records),
        dnsPreview: async (input) => {
          window.__calls.previews.push(input);
          return {
            ticket: `ticket-${window.__calls.previews.length}`,
            action: input.action,
            zoneId: input.zoneId,
            before: records.find((row) => row.id === input.recordId) || null,
            after: input.record || null,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
        },
        dnsApply: async (ticket) => {
          window.__calls.applies.push(ticket);
        },
        probeHistory: async () => [{ at: now, cpu: 17, memory: 30, disk: null }],
        probeCheckHistory: async () => [
          { at: now, status: "up", latencyMs: 28, message: "" },
          {
            at: new Date(Date.parse(now) + 60000).toISOString(),
            status: "down",
            latencyMs: null,
            message: "合成连接超时",
          },
        ],
        probeEnroll: async (_id, name) => {
          hosts.push({ id: "new-host", name, status: "pending", lastSeen: null, latest: null });
          return { id: "new-host", secret: "fixture-once-only-secret" };
        },
        probeRevoke: async (_id, id) => {
          window.__calls.revokes.push(id);
          hosts.splice(
            hosts.findIndex((row) => row.id === id),
            1,
          );
        },
        probeSaveCheck: async (_id, input) => {
          window.__calls.checks.push(input);
          const saved = {
            ...input,
            id: input.id || "check-1",
            status: "pending",
            lastCheckedAt: null,
            latencyMs: null,
            message: "",
            uptime24h: null,
          };
          const index = checks.findIndex((item) => item.id === saved.id);
          if (index < 0) checks.push(saved);
          else checks[index] = saved;
        },
        probeDeleteCheck: async (_id, id) => {
          window.__calls.deletes.push(id);
          checks.splice(
            checks.findIndex((item) => item.id === id),
            1,
          );
        },
      },
    };
    window.__reactRoot = ReactDOM.createRoot(document.getElementById("root"));
    window.__reactRoot.render(React.createElement(IntegrationsSettings));
  });

  await page.getByRole("button", { name: "管理 DNS", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "编辑连接", exact: true });
  assert.equal(await dialog.getByLabel("Cloudflare API Token", { exact: true }).inputValue(), "");
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__calls.saves[0].token), undefined);

  await page.getByRole("button", { name: "管理 DNS", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "DNS 管理 · example.test", exact: true });
  assert.equal(
    await dialog
      .getByRole("button", { name: "编辑记录 secure.example.test", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByRole("button", { name: "编辑记录 example.test", exact: true }).click();
  await dialog.getByLabel("记录内容", { exact: true }).fill("192.0.2.2");
  await dialog.getByLabel("备注", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "预览变更", exact: true }).click();
  await dialog.getByText("确认 DNS 变更", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__calls.applies.length), 0);
  assert.equal(await page.evaluate(() => window.__calls.previews[0].record.content), "192.0.2.2");
  assert.equal(await page.evaluate(() => window.__calls.previews[0].record.comment), "");
  await dialog.getByRole("button", { name: "确认应用变更", exact: true }).click();
  await dialog.getByRole("button", { name: "新增记录", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__calls.applies), ["ticket-1"]);
  await dialog.getByRole("button", { name: "新增记录", exact: true }).click();
  await dialog.getByLabel("记录名称", { exact: true }).fill("www.example.test");
  await dialog.getByLabel("记录内容", { exact: true }).fill("192.0.2.3");
  await dialog.getByRole("button", { name: "预览变更", exact: true }).click();
  await dialog.getByRole("button", { name: "确认应用变更", exact: true }).click();
  await dialog.getByRole("button", { name: "删除记录 example.test", exact: true }).click();
  await dialog.getByText("删除此记录", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__calls.applies.length), 2);
  await dialog.getByRole("button", { name: "返回", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导入或绑定资产", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "关联资源 · example.test", exact: true });
  await dialog.getByRole("button", { name: "确认关联", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__calls.binds[0]), {
    connectionId: "cf",
    resourceKey: "zone:zone-1",
    assetId: undefined,
  });

  await page.getByRole("button", { name: "合成监控", exact: true }).click();
  await page.getByRole("button", { name: "指标与历史", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "离线测试机", exact: true });
  await dialog.getByText(/当前没有实时上报/).waitFor();
  await dialog.locator(".recharts-line").first().waitFor();
  assert.ok(await dialog.getByText("—", { exact: true }).count());
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/cloud-probe-history-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByText("CPU · 内存 · 磁盘，单位 %；缺失样本保持断开", { exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await dialog.locator(".integration-form").evaluate((element) => element.scrollTop > 0),
    true,
  );
  await page.screenshot({ path: "screenshots/cloud-probe-history-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 980 });

  await page.getByRole("button", { name: "注册探针主机", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "注册探针主机", exact: true });
  await dialog.getByLabel("主机名称", { exact: true }).fill("新测试机");
  await dialog.getByRole("button", { name: "生成主机凭据", exact: true }).click();
  await dialog.getByLabel("client-secret", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByLabel("client-secret", { exact: true }).inputValue(),
    "fixture-once-only-secret",
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-once-only-secret")),
    false,
  );
  await dialog.getByRole("button", { name: "已保存，关闭", exact: true }).click();
  assert.equal(await page.getByLabel("client-secret", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "新增服务检查", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "新增服务检查", exact: true });
  await dialog.getByLabel("检查名称", { exact: true }).fill("合成 TCP 检查");
  await chooseOption(page, dialog.getByRole("combobox", { name: "检查协议" }), "TCP");
  await dialog.getByLabel("检查目标", { exact: true }).fill("example.test:443");
  await dialog.getByLabel("检查间隔（秒）", { exact: true }).fill("5");
  assert.equal(
    await dialog
      .getByLabel("检查间隔（秒）", { exact: true })
      .evaluate((element) => element.checkValidity()),
    false,
  );
  await dialog.getByLabel("检查间隔（秒）", { exact: true }).fill("10");
  await dialog.getByLabel("超时（毫秒）", { exact: true }).fill("20000");
  assert.equal(
    await dialog
      .getByLabel("超时（毫秒）", { exact: true })
      .evaluate((element) => element.checkValidity()),
    false,
  );
  await dialog.getByLabel("检查间隔（秒）", { exact: true }).fill("60");
  await dialog.getByLabel("超时（毫秒）", { exact: true }).fill("5000");
  await dialog.getByRole("button", { name: "保存检查", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "编辑检查", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑服务检查", exact: true });
  await dialog.getByLabel("检查间隔（秒）", { exact: true }).fill("30");
  await dialog.getByRole("button", { name: "保存检查", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__calls.checks[1].intervalSeconds), 30);
  await page.getByRole("button", { name: "延迟与记录", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "服务检查 · 合成 TCP 检查", exact: true });
  await dialog.getByText("合成连接超时", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".recharts-wrapper").count(), 1);
  assert.equal(await dialog.getByText("28 ms", { exact: true }).count(), 1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "删除检查", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "删除检查", exact: true });
  assert.equal(await page.evaluate(() => window.__calls.deletes.length), 0);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__calls.deletes), ["check-1"]);
  await page
    .locator("article")
    .filter({ hasText: "新测试机" })
    .getByRole("button", { name: "撤销主机", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "撤销主机", exact: true });
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__calls.revokes), ["new-host"]);

  await page.evaluate(() => {
    window.__failOnce = true;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "合成网络错误" }).waitFor();
  await page.getByText("正在显示上次成功同步的数据", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page
    .getByText("正在显示上次成功同步的数据", { exact: true })
    .waitFor({ state: "detached" });
  const beforePoll = await page.evaluate(() => window.__calls.inventory.length);
  await page.waitForFunction((before) => window.__calls.inventory.length > before, beforePoll, {
    timeout: 8000,
  });
  await page.evaluate(() => {
    window.__hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenPoll = await page.evaluate(() => window.__calls.inventory.length);
  await page.waitForTimeout(5500);
  assert.equal(await page.evaluate(() => window.__calls.inventory.length), hiddenPoll);
  await page.evaluate(() => {
    window.__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((before) => window.__calls.inventory.length > before, hiddenPoll);
  await page.screenshot({ path: "screenshots/cloud-probe-workspace-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/cloud-probe-workspace-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => window.__reactRoot.unmount());
  const unmountedPoll = await page.evaluate(() => window.__calls.inventory.length);
  await page.waitForTimeout(5500);
  assert.equal(await page.evaluate(() => window.__calls.inventory.length), unmountedPoll);
  // 同时验证真实设置容器和入口事件，避免独立组件通过但嵌入后被裁切。
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { Settings } = await import("/src/components/settings.tsx");
    const { IntegrationsEntry } = await import("/src/components/integrations/entry.tsx");
    window.__settingsRoot = ReactDOM.createRoot(document.getElementById("root"));
    window.__settingsRoot.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(IntegrationsEntry),
        React.createElement(Settings),
      ),
    );
  });
  await page.getByRole("button", { name: "管理连接", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置", exact: true });
  await settingsDialog.getByRole("button", { name: "管理 DNS", exact: true }).waitFor();
  await page.screenshot({ path: "screenshots/cloud-probe-settings-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 980 });
  await page.screenshot({ path: "screenshots/cloud-probe-settings-desktop.png" });
  await settingsDialog.getByRole("button", { name: "管理 DNS", exact: true }).click();
  await page.getByRole("dialog", { name: "DNS 管理 · example.test", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "DNS 管理 · example.test", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(await settingsDialog.isVisible(), true);
  await settingsDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await settingsDialog.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        credentialsPreserved: true,
        dnsPreviewBeforeMutation: true,
        unsupportedDnsReadOnly: true,
        resourceBinding: true,
        enrollmentAndRevocation: true,
        checkCrud: true,
        missingMetricsAndOfflineTime: true,
        historyRendered: true,
        refreshAndVisibility: true,
        mobileOverflow: false,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
