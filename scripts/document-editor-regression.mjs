import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";
import { expandNavigationGroups } from "./navigation-helper.mjs";

// 独立用户目录与合成文本；文本插入和 HTML 粘贴不使用系统剪贴板。
const directory = await mkdtemp(join(tmpdir(), "zhiyu-editor-regression-"));
let instance;
try {
  const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SINAN_DEV_URL;
  delete env.NODE_PATH;
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  instance = await electron.launch({
    cwd: process.env.NANPAD_QA_APP_CWD ?? process.cwd(),
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [resolve("electron/main.mjs")]),
      `--user-data-dir=${directory}`,
    ],
    env,
    locale: "zh-CN",
  });
  const page = await instance.firstWindow();
  const errors = [];
  const checks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1360, 900);
    win.webContents.setBackgroundThrottling(false);
    win.showInactive();
    // Ctrl+A 等浏览器默认编辑快捷键需要前台窗口，避免把后台输入差异当成格式功能错误。
    win.focus();
  });
  await completeOnboarding(page);
  await expandNavigationGroups(page);
  await page.evaluate(async () => {
    for (const [id, title, markdown] of [
      ["doc-editor-source", "长文光标回归", "# 合成原文\n"],
      ["doc-editor-rich", "富文本保存回归", undefined],
    ])
      await window.sinan.documents.save({
        id,
        title,
        ...(markdown === undefined ? {} : { markdown }),
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "合成初始文字" }] }],
        },
        bindings: [],
      });
  });
  async function open(title) {
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "文档资产", exact: true })
      .click();
    await page.locator(".document-list-item").filter({ hasText: title }).click();
    await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  }
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await open("长文光标回归");
  const input = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  const source = Array.from(
    { length: 650 },
    (_, index) => `第 ${index} 行：这是用于大段粘贴测试的合成 Markdown 内容，不包含私人资料。`,
  ).join("\n");
  await input.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(source);
  for (const index of [100, 200, 325, 500]) {
    await input.evaluate((el, index) => {
      el.focus();
      const position = el.value.indexOf(`第 ${index} 行`);
      el.setSelectionRange(position, position);
      const reader = el.closest(".document-reader-scroll");
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      reader.scrollTop = el.offsetTop + index * lineHeight - 200;
    }, index);
    const before = await input.evaluate((el) => ({
      position: el.selectionStart,
      scroll: el.closest(".document-reader-scroll").scrollTop,
    }));
    await page.keyboard.insertText("EDIT");
    await page.waitForTimeout(1000);
    const after = await input.evaluate((el) => ({
      position: el.selectionStart,
      scroll: el.closest(".document-reader-scroll").scrollTop,
      active: document.activeElement === el,
    }));
    assert.equal(after.position, before.position + 4, "自动保存后光标仍在中部插入位置");
    assert.ok(
      Math.abs(after.scroll - before.scroll) < 2,
      `单行输入不能移动阅读视口：${JSON.stringify({ before, after })}`,
    );
    assert.equal(after.active, true);
    await page.keyboard.press("Backspace");
    assert.equal(await input.evaluate((el) => el.selectionStart), before.position + 3);
  }
  checks.push("650 行原文中部输入、删除和自动保存保持光标与视口");
  const middle = await input.evaluate((el) => el.selectionStart);
  await page.keyboard.insertText("\n新增一段\n继续原文");
  assert.equal(
    await input.evaluate((el) => el.selectionStart),
    middle + "\n新增一段\n继续原文".length,
  );
  const edited = await input.inputValue();
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  assert.equal(
    await page.evaluate(
      async () => (await window.sinan.documents.get("doc-editor-source")).markdown,
    ),
    edited,
  );
  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await open("长文光标回归");
  assert.equal(await input.inputValue(), edited);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const size = await input.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    top: el.scrollTop,
  }));
  assert.ok(size.scroll <= size.client + 2, `窄屏长文不能被固定高度裁切：${JSON.stringify(size)}`);
  assert.equal(size.top, 0);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  checks.push("多行插入和重启页面后原文完整保存");

  await open("富文本保存回归");
  const rich = page.getByRole("textbox", { name: "文档正文", exact: true });
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  // 延迟一次编辑入口的自动聚焦，模拟帧回调到达前用户已经点击正文。
  const held = await page
    .getByRole("button", { name: "编辑文档", exact: true })
    .evaluate((button) => {
      const original = window.requestAnimationFrame;
      const callbacks = [];
      window.requestAnimationFrame = (callback) => {
        callbacks.push(callback);
        return 0;
      };
      try {
        button.click();
      } finally {
        window.requestAnimationFrame = original;
      }
      window.__releaseEditorFocus = () =>
        callbacks.forEach((callback) => callback(performance.now()));
      return callbacks.length;
    });
  assert.ok(held > 0);
  await rich.waitFor();
  const focusRace = await rich.evaluate((el) => {
    el.focus();
    window.__releaseEditorFocus();
    return {
      retained: document.activeElement === el,
      active: document.activeElement?.getAttribute("aria-label"),
    };
  });
  assert.equal(
    focusRace.retained,
    true,
    `延迟自动聚焦不能夺走用户已点击的正文焦点：${JSON.stringify(focusRace)}`,
  );
  checks.push("进入编辑时的延迟自动聚焦尊重用户已选择的正文");
  await page.evaluate(() => {
    window.__editorEvents = [];
    for (const type of ["focusin", "focusout", "keydown", "click"])
      document.addEventListener(
        type,
        (event) => {
          const editor = document.querySelector(".document-prose");
          window.__editorEvents.push({
            type,
            key: event.key,
            ctrl: event.ctrlKey,
            target: event.target.getAttribute?.("aria-label") || event.target.className,
            active: document.activeElement?.className,
            selection: editor?.editor?.state.selection.toJSON(),
            editable: editor?.getAttribute("contenteditable"),
            focused: document.hasFocus(),
            selected: window.getSelection()?.toString().slice(0, 80),
          });
          if (window.__editorEvents.length > 40) window.__editorEvents.shift();
        },
        true,
      );
  });
  await rich.click();
  await page.keyboard.press("Control+A");
  await rich.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<p>联系方式 <a href="mailto:synthetic@example.test">合成邮箱</a> <a href="tel:123456">合成电话</a> <a href="javascript:alert(1)">危险协议文字</a> <a href="https://example.test/docs">官方资料</a></p>',
    );
    data.setData("text/plain", "联系方式 合成邮箱 合成电话 危险协议文字 官方资料");
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await rich.locator('a[href="https://example.test/docs"]').count(), 1);
  assert.equal(
    await rich.locator('a[href^="mailto:"], a[href^="tel:"], a[href^="javascript:"]').count(),
    0,
  );
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.getByRole("button", { name: "编辑文档", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  const saved = await page.evaluate(async () => window.sinan.documents.get("doc-editor-rich"));
  assert.ok(JSON.stringify(saved.content).includes("合成邮箱"));
  checks.push("粘贴邮箱、电话与危险协议保留文字，HTTPS 保留链接且保存成功");

  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await rich.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("格式回归文字");
  await page.keyboard.press("Control+A");
  for (const [name, selector] of [
    ["下划线", "u"],
    ["删除线", "s"],
    ["粗体", "strong"],
    ["斜体", "em"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(await rich.locator(selector).textContent(), "格式回归文字");
    assert.equal(
      await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"),
      "true",
    );
  }
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  for (const selector of ["u", "s", "strong", "em"])
    assert.equal(await rich.locator(selector).textContent(), "格式回归文字");
  const synchronizedSelection = await rich.evaluate((el) => {
    const editor = el.editor;
    editor.commands.selectAll();
    el.focus();
    const text = el.querySelector("u").firstChild;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // 模拟焦点切换后 DOM 选区已折叠、编辑器仍保留 AllSelection 的同一轮事件。
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    return { visible: selection.toString(), model: editor.state.selection.toJSON() };
  });
  assert.equal(
    synchronizedSelection.visible,
    "格式回归文字",
    JSON.stringify(synchronizedSelection),
  );
  await rich.click();
  await page.keyboard.press("Control+A");
  await page.getByRole("button", { name: "清除格式", exact: true }).click();
  if (await rich.locator("u, s, strong, em").count())
    console.log(
      JSON.stringify({
        events: await page.evaluate(() => window.__editorEvents),
        afterClear: await rich.innerHTML(),
        afterSelection: await rich.evaluate((el) => ({
          active: document.activeElement === el,
          selected: window.getSelection()?.toString(),
          editorSelection: el.editor?.state.selection.toJSON(),
        })),
      }),
    );
  assert.equal(await rich.locator("u, s, strong, em").count(), 0);
  await page.getByRole("button", { name: "行内代码", exact: true }).click();
  assert.equal(await rich.locator("code").textContent(), "格式回归文字");
  await page.getByRole("button", { name: "行内代码", exact: true }).click();
  for (const level of [1, 2, 3]) {
    await page.getByRole("combobox", { name: "段落样式", exact: true }).selectOption(String(level));
    // 全选也包含编辑器的末尾空段落，标题命令可以合法地生成多个标题节点。
    assert.deepEqual((await rich.locator(`h${level}`).allTextContents()).filter(Boolean), [
      "格式回归文字",
    ]);
  }
  await page.getByRole("combobox", { name: "段落样式", exact: true }).selectOption("paragraph");
  await rich.click();
  await page.keyboard.press("Control+End");
  await page.getByRole("button", { name: "分隔线", exact: true }).click();
  assert.equal(await rich.locator("hr").count(), 1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await rich.locator("hr").count(), 0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  assert.equal(await rich.locator("hr").count(), 1);
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.getByRole("button", { name: "编辑文档", exact: true }).waitFor();
  assert.ok(
    JSON.stringify(
      (await page.evaluate(async () => window.sinan.documents.get("doc-editor-rich"))).content,
    ).includes("horizontalRule"),
  );
  checks.push("常用格式、三级标题、清除、分隔线、撤销重做实际操作和保存");
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/document-editor-toolbar-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false);
  const toolbar = page.getByRole("group", { name: "文档格式", exact: true });
  assert.equal(await toolbar.isVisible(), true);
  await page.screenshot({ path: "screenshots/document-editor-toolbar-mobile.png" });
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, errors }, null, 2));
} finally {
  // 不让测试中的 beforeunload 保存提示阻挡 Electron 的退出。
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await instance?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
