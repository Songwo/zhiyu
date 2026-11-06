import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { expandNavigationGroups } from "./navigation-helper.mjs";
import { universalRelationFixture } from "./universal-relations-fixture.mjs";
import { webResearchFixture } from "./web-research-fixture.mjs";

// 同一份合成资料检查全部导航页和实际侧栏，不读取用户资料或连接真实服务器。
const { snapshot, documents } = universalRelationFixture();
const now = new Date().toISOString();
snapshot.servers = Array.from({ length: 4 }, (_, index) => ({
  ...snapshot.servers[index % 2],
  id: "layout-server-" + index,
  name: "布局测试主机 " + (index + 1),
  host: "server-" + index + ".example.test",
  demo: true,
  collect: false,
  sshConfigured: false,
  port: 22,
  username: "tester",
  os: "Linux",
  region: "测试地区",
  label: "布局验收",
  cpu: 12,
  memory: 32,
  disk: 45,
  uptime: "1 天",
  lastSeen: now,
  nodes: [],
}));
snapshot.domains = Array.from({ length: 8 }, (_, index) => ({
  ...snapshot.domains[index % 2],
  id: "layout-domain-" + index,
  name: "domain-" + index + ".example.test",
  registrar: "测试注册商",
  dns: "test",
  nameservers: [],
  expiresAt: "2028-12-01",
  autoRenew: false,
}));
for (const mailbox of snapshot.mailboxes)
  Object.assign(mailbox, {
    address: mailbox.id + "@example.test",
    domain: "example.test",
    kind: "mailbox",
    usedMb: 0,
    quotaMb: 100,
  });
for (const ai of snapshot.aiAssets)
  Object.assign(ai, {
    plan: "Test",
    monthlyUsd: 0,
    usagePct: 0,
    renewsAt: "2028-12-01",
    keyHint: "",
  });
for (const secret of snapshot.secrets)
  Object.assign(secret, { kind: "account", value: "", hint: "", lastRotated: now });
for (const cert of snapshot.certs)
  Object.assign(cert, {
    cn: cert.id + ".example.test",
    issuer: "Test",
    sans: [],
    expiresAt: "2028-12-01",
    daysLeft: 700,
    checkedAt: now,
  });
const docs = documents.map((doc) => ({
  ...doc,
  bindings: [],
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "布局验收文档，保留正文阅读宽度。" }] },
    ],
  },
}));
const views = [
  ["overview", "资产总览"],
  ["servers", "服务器"],
  ["domains", "域名"],
  ["certs", "安全证书"],
  ["services", "服务资产"],
  ["ai", "AI 订阅"],
  ["mail", "邮箱"],
  ["vault", "密钥库"],
  ["cards", "U 卡与支付卡"],
  ["esims", "eSIM 卡"],
  ["phones", "号码管理"],
  ["nodes", "自建节点"],
  ["usage", "用量记录"],
  ["renewals", "费用与续费"],
  ["relations", "资产关系图"],
  ["docs", "文档资产"],
  ["agent", "AI 助手"],
  ["terminal", "终端"],
];
const browser = await chromium.launch();
const results = [],
  errors = [];
let web;
await mkdir("screenshots", { recursive: true });
await writeFile("screenshots/workspace-layout-fixture.json", JSON.stringify({ snapshot, docs }));
if (process.env.WORKSPACE_LAYOUT_PREPARE_ONLY === "1") {
  await browser.close();
  process.exit(0);
}
async function geometry(page, label) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const state = await page.evaluate(() => {
    const container = document.querySelector(".page-container");
    const scroll = container.parentElement.getBoundingClientRect(),
      frame = container.getBoundingClientRect();
    const main = container.querySelector(":scope > main").getBoundingClientRect();
    const aside = container.querySelector(":scope > aside");
    const rail =
      aside && getComputedStyle(aside).display !== "none" ? aside.getBoundingClientRect() : null;
    const innerAsides = [...container.querySelectorAll("main aside")]
      .filter(
        (n) =>
          getComputedStyle(n).display !== "none" &&
          getComputedStyle(n).visibility !== "hidden" &&
          n.getBoundingClientRect().width > 0,
      )
      .map((n) => {
        const r = n.getBoundingClientRect();
        return {
          label: n.getAttribute("aria-label") ?? n.className,
          left: r.left - main.left,
          right: main.right - r.right,
          width: r.width,
        };
      });
    return {
      zoom: Number(getComputedStyle(document.documentElement).zoom) || 1,
      outerLeft: frame.left - scroll.left,
      outerRight: scroll.right - frame.right,
      mainLeft: main.left - scroll.left,
      railWidth: rail?.width ?? 0,
      railRight: rail ? scroll.right - rail.right : null,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      frameWidth: frame.width,
      availableWidth: scroll.width,
      innerAsides,
    };
  });
  assert.ok(
    state.outerLeft <= 2 && state.outerRight <= 2,
    label + " 工作区不得被居中限宽：" + JSON.stringify(state),
  );
  assert.ok(state.mainLeft <= 32 * state.zoom, label + " 主内容左侧不得保留空列");
  assert.equal(state.overflow, false, label + " 横向溢出");
  if (state.railWidth) {
    assert.ok(
      state.railWidth >= 264 * state.zoom - 1 && state.railWidth <= 321 * state.zoom,
      label + " 侧栏宽度失控",
    );
    assert.ok(state.railRight <= 32 * state.zoom, label + " 侧栏必须贴近工作区右边");
  }
  for (const aside of state.innerAsides)
    assert.ok(
      aside.left >= -2 && aside.right >= -2,
      label + " 内部侧栏超出主区域：" + JSON.stringify(aside),
    );
  results.push({ label, ...state });
}
async function navigate(page, name, mode, mobile) {
  if (mode === "desktop" && !mobile) {
    const navigation = page.locator("#primary-navigation");
    if (name === "终端" && (await navigation.getAttribute("data-collapsed")) !== "true") {
      const tools = navigation.getByRole("button", { name: "更多工具", exact: true });
      if ((await tools.getAttribute("aria-expanded")) === "false") await tools.click();
    }
    await navigation.getByRole("button", { name, exact: true }).click();
  } else if (mode === "desktop") {
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await expandNavigationGroups(page);
    if (name === "终端") {
      const tools = page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "更多工具", exact: true });
      if ((await tools.getAttribute("aria-expanded")) === "false") await tools.click();
    }
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    if (mobile || !(await page.locator('.web-nav button[aria-haspopup="menu"]').isVisible())) {
      await page.getByRole("button", { name: "打开菜单", exact: true }).click();
      await page
        .getByRole("dialog", { name: "全部页面", exact: true })
        .getByRole("button", { name, exact: true })
        .click();
    } else {
      const primary = page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name, exact: true });
      if (await primary.count()) await primary.click();
      else {
        await page.locator('.web-nav button[aria-haspopup="menu"]').click();
        await page.getByRole("menuitem", { name, exact: true }).click();
      }
    }
  }
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("main [role=status]")].some(
        (n) => n.textContent.trim() === "正在加载…",
      ),
  );
}
try {
  for (const mode of process.env.WORKSPACE_LAYOUT_MODE
    ? [process.env.WORKSPACE_LAYOUT_MODE]
    : ["desktop", "web"]) {
    if (mode === "web") {
      web = await webResearchFixture({ built: true });
      const r = await web.call("/api/web/store", {
        cookie: web.cookie,
        method: "PUT",
        body: { revision: null, data: { version: 0, state: snapshot } },
      });
      assert.equal(r.ok, true);
      for (const doc of docs) {
        const r = await web.call("/api/web/documents/" + doc.id, {
          cookie: web.cookie,
          method: "PUT",
          body: doc,
        });
        assert.equal(r.ok, true);
      }
    }
    const context = await browser.newContext({
      viewport: { width: 2048, height: 1152 },
      locale: "zh-CN",
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      ({ snapshot, docs }) => {
        if (localStorage.getItem("workspace-layout-seeded")) return;
        localStorage.setItem("sinan-assets-v1", JSON.stringify({ version: 0, state: snapshot }));
        localStorage.setItem(
          "sinan-settings-v1",
          JSON.stringify({
            version: 0,
            state: {
              language: "zh",
              theme: "light",
              motionMode: "off",
              sidebarCollapsed: false,
              assetLayout: "cards",
            },
          }),
        );
        for (const doc of docs) localStorage.setItem("nanpad-doc:" + doc.id, JSON.stringify(doc));
        localStorage.setItem("workspace-layout-seeded", "true");
      },
      { snapshot, docs },
    );
    if (web)
      await context.addCookies([
        { name: "zhiyu_session", value: web.cookie.split("=")[1], url: web.base },
      ]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(mode === "web" ? web.base : process.env.NANPAD_QA_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.locator("[data-app-ready=true]").waitFor({ timeout: 60000 });
    if (mode === "desktop") await expandNavigationGroups(page);
    for (const [width, height, collapsed] of [
      [2048, 1152, false],
      [2048, 1152, true],
      [1440, 960, false],
      [1440, 960, true],
      [1024, 800, false],
      [390, 844, false],
    ]) {
      if (mode === "web" && collapsed) continue;
      await page.setViewportSize({ width, height });
      if (mode === "desktop" && width >= 768) {
        const actual =
          (await page.locator("#primary-navigation").getAttribute("data-collapsed")) === "true";
        if (actual !== collapsed)
          await page
            .getByRole("button", { name: collapsed ? "收起主导航" : "展开主导航", exact: true })
            .click();
        if (!collapsed) await expandNavigationGroups(page);
      }
      for (const [view, name] of mode === "web" ? [...views, ["host", "主机监控"]] : views) {
        try {
          await navigate(page, name, mode, width < 768);
          await geometry(page, `${mode}/${width}/${collapsed ? "collapsed" : "expanded"}/${view}`);
          if (["servers", "domains", "docs", "agent"].includes(view) && [2048, 390].includes(width))
            await page.screenshot({ path: `screenshots/layout-${mode}-${width}-${view}.png` });
        } catch (error) {
          await page.screenshot({ path: "screenshots/workspace-layout-failure.png" });
          throw error;
        }
      }
      if (width >= 1024) {
        await navigate(page, "服务器", mode, false);
        await page.locator('article[data-asset-id="layout-server-0"]').click();
        await page.getByRole("region", { name: "资产详情", exact: true }).waitFor();
        await geometry(page, `${mode}/${width}/${collapsed ? "collapsed" : "expanded"}/detail`);
        await page.getByRole("button", { name: "返回列表", exact: true }).click();
        if (mode === "desktop")
          await page.locator("#primary-navigation .sidebar-profile-trigger").click();
        else await page.getByRole("button", { name: "账号与设置", exact: true }).click();
        if (mode === "desktop")
          await page.locator("button.sidebar-menu-item").filter({ hasText: "系统设置…" }).click();
        else await page.getByRole("menuitem", { name: "系统设置…", exact: true }).click();
        await page.locator(".settings-page-panel").waitFor();
        await geometry(page, `${mode}/${width}/${collapsed ? "collapsed" : "expanded"}/settings`);
        const aside = page.locator(".settings-page-panel > .settings-nav");
        const navBox = await aside.boundingBox(),
          panelBox = await page.locator(".settings-page-panel").boundingBox();
        assert.ok(Math.abs(navBox.x - panelBox.x) <= 2, "设置导航应贴齐面板左侧");
        assert.ok(navBox.width <= 200, "设置导航宽度不应挤压内容");
        await page.getByRole("button", { name: "返回", exact: true }).click();
      }
    }
    if (mode === "desktop") {
      await page.setViewportSize({ width: 2048, height: 1152 });
      for (const zoom of [125, 150]) {
        await page.getByRole("button", { name: "系统设置…", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "设置", exact: true });
        await dialog
          .getByRole("group", { name: "界面大小", exact: true })
          .getByRole("button", { name: zoom + "%", exact: true })
          .click();
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await page.waitForFunction(
          (zoom) => Number(document.documentElement.style.zoom) === zoom / 100,
          zoom,
        );
        for (const collapsed of [false, true]) {
          const actual =
            (await page.locator("#primary-navigation").getAttribute("data-collapsed")) === "true";
          if (actual !== collapsed)
            await page
              .getByRole("button", { name: collapsed ? "收起主导航" : "展开主导航", exact: true })
              .click();
          if (!collapsed) await expandNavigationGroups(page);
          for (const [view, name] of views.filter(([view]) =>
            ["servers", "domains", "docs", "agent"].includes(view),
          )) {
            await navigate(page, name, mode, false);
            await geometry(
              page,
              `${mode}/${zoom}%/${collapsed ? "collapsed" : "expanded"}/${view}`,
            );
          }
        }
      }
    }
    await context.close();
    if (web) {
      await web.close();
      web = null;
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    "screenshots/workspace-layout-receipt.json",
    JSON.stringify({ passed: true, results, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, scenarios: results.length, errors }));
} finally {
  await browser.close();
  if (web) await web.close();
}
