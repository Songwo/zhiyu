import { navigateDesktop } from "./navigation-helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { _electron as electron } from "playwright";
import { completeOnboarding } from "./onboarding-helper.mjs";

const directory = await mkdtemp(join(tmpdir(), "nanpad-local-usage-ipc-"));
// 用真实旧版上限启动 Electron，覆盖迁移后定时采集、IPC 广播与图表更新整条链。
await writeFile(
  join(directory, "local-usage.json"),
  JSON.stringify({
    version: 1,
    enabled: true,
    checkpoints: [],
    records: [],
    events: Array.from({ length: 100_000 }, (_, index) => [
      createHash("sha256").update(`historical-fixture-${index}`).digest("hex"),
      true,
    ]),
  }),
);
const logs = join(directory, "qa-logs", "codex");
const claudeLogs = join(directory, "qa-logs", "claude");
const grokLogs = join(directory, "qa-logs", "grok", "synthetic-session");
const grokCopyLogs = join(directory, "qa-logs", "grok", "copied-session");
const geminiLogs = join(directory, "qa-logs", "gemini", "project", "chats");
await Promise.all(
  [logs, claudeLogs, grokLogs, grokCopyLogs, geminiLogs].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);
const timestamp = new Date().toISOString();
const line = (value) => JSON.stringify(value) + "\n";
const event = (input, output) =>
  line({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0 },
      },
    },
  });
const file = join(logs, "synthetic.jsonl");
await writeFile(
  file,
  line({ type: "session_meta", payload: { id: "qa-session", cwd: "PRIVATE_TEST_PATH" } }) +
    line({ type: "turn_context", payload: { model: "gpt-test" } }) +
    line({ type: "response_item", payload: { text: "PRIVATE_PROMPT_MARKER" } }) +
    event(100, 20),
);
const claudeEvent = line({
  type: "assistant",
  timestamp,
  sessionId: "qa-claude-session",
  requestId: "qa-claude-request",
  message: {
    id: "qa-claude-message",
    model: "claude-test",
    content: "PRIVATE_CLAUDE_PROMPT",
    usage: {
      input_tokens: 30,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  },
});
await writeFile(join(claudeLogs, "synthetic.jsonl"), claudeEvent + claudeEvent);
const grokDocument = (input = 200, output = 30) => ({
  sessionId: "qa-grok-session",
  updatedAt: timestamp,
  session: { inputTokens: input, outputTokens: output },
  turns: [
    {
      turnNumber: 1,
      endedAt: timestamp,
      modelUsage: {
        "grok-test": {
          inputTokens: input,
          outputTokens: output,
          cachedReadTokens: 120,
          cacheCreationTokens: 0,
          reasoningTokens: 10,
        },
      },
    },
  ],
});
await writeFile(join(grokLogs, "usage.json"), JSON.stringify(grokDocument()));
await writeFile(join(grokCopyLogs, "usage.json"), JSON.stringify(grokDocument()));
const geminiMessage = {
  id: "qa-gemini-message",
  type: "gemini",
  model: "gemini-test",
  timestamp,
  content: "PRIVATE_GEMINI_PROMPT",
  tokens: { input: 60, output: 12, cached: 10, thoughts: 8, tool: 4, total: 84 },
};
function sourceRecord(usage, sourceId) {
  const rows = usage.records.filter((row) => row.sourceId === sourceId);
  assert.equal(rows.length, 1, `${sourceId} 的同会话同模型统计应去重为一条`);
  return rows[0];
}
async function waitForLocalInput(page, input) {
  const deadline = Date.now() + 20000;
  let actual;
  do {
    actual = sourceRecord(
      await page.evaluate(() => window.sinan.usage.list()),
      "local:codex",
    ).input;
    if (actual === input) return;
    await new Promise((done) => setTimeout(done, 300));
  } while (Date.now() < deadline);
  console.error(
    JSON.stringify({
      expected: input,
      actual,
      status: await page.evaluate(() => window.sinan.usage.localStatus()),
      ui: (await page.locator(".local-usage-panel").count())
        ? await page.locator(".local-usage-panel").innerText()
        : await page.locator(".usage-insights").innerText(),
    }),
  );
  assert.equal(actual, input, "后台定时采集必须真正读取新增用量");
}
const env = { ...process.env, NANPAD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SINAN_DEV_URL;
let instance;
const errors = [];
try {
  instance = await electron.launch({
    args: [resolve("electron/main.mjs")],
    env,
    locale: "zh-CN",
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  assert.equal((await page.evaluate(() => window.sinan.usage.localStatus())).enabled, true);
  await page.evaluate(() => window.sinan.usage.refreshLocal());
  assert.ok((await page.evaluate(() => window.sinan.usage.list())).records.length > 0);
  await completeOnboarding(page);
  await page.evaluate(() => {
    window.__usageEvents = [];
    window.sinan.usage.onChanged((event) => window.__usageEvents.push(event));
  });
  const rejected = await page.evaluate(async () => {
    try {
      await window.sinan.usage.configureLocal({ enabled: true, roots: { codex: ["C:/"] } });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true, "渲染层不能指定任意扫描目录");
  await navigateDesktop(page, "用量记录");
  await page.getByRole("button", { name: "采集与监控", exact: true }).click();
  await page.evaluate(() => window.sinan.vault.lock());
  await page.getByRole("button", { name: "立即采集", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "解锁密钥库", exact: true }).count(), 0);
  await page.getByText("监控已开启", { exact: true }).waitFor();
  let usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(sourceRecord(usage, "local:codex").input, 100);
  assert.equal(sourceRecord(usage, "local:codex").output, 20);
  assert.equal(sourceRecord(usage, "local:claude").input, 55);
  assert.equal(sourceRecord(usage, "local:claude").output, 10);
  assert.equal(sourceRecord(usage, "local:claude").cached, 20);
  assert.equal(sourceRecord(usage, "local:claude").cacheWrite, 5);
  assert.equal(sourceRecord(usage, "local:grok").input, 200);
  assert.equal(sourceRecord(usage, "local:grok").output, 30);
  let status = await page.evaluate(() => window.sinan.usage.localStatus());
  assert.deepEqual(status.sources.map((source) => source.id).sort(), [
    "local:claude",
    "local:codex",
    "local:gemini",
    "local:grok",
  ]);
  assert.equal(status.sources.find((source) => source.id === "local:gemini").status, "no-usage");
  assert.equal(
    usage.records.some((row) => row.sourceId === "local:gemini"),
    false,
  );
  assert.ok(
    status.sources
      .filter((source) => source.id !== "local:gemini")
      .every((source) => source.status === "ready"),
  );
  await writeFile(
    join(geminiLogs, "session-synthetic.json"),
    JSON.stringify({
      sessionId: "qa-gemini-session",
      projectHash: "PRIVATE_GEMINI_PROJECT",
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [geminiMessage, geminiMessage],
    }),
  );
  await writeFile(join(grokLogs, "usage.json"), JSON.stringify(grokDocument(220, 40)));
  await appendFile(file, event(150, 30));
  await page.getByRole("button", { name: "立即采集", exact: true }).click();
  await waitForLocalInput(page, 150);
  usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(sourceRecord(usage, "local:gemini").input, 64);
  assert.equal(sourceRecord(usage, "local:gemini").output, 20);
  assert.equal(sourceRecord(usage, "local:gemini").cached, 10);
  assert.equal(sourceRecord(usage, "local:grok").input, 220);
  assert.equal(sourceRecord(usage, "local:grok").output, 40);
  await page.evaluate(() => window.sinan.usage.refreshLocal());
  const deduplicated = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(
    await page.evaluate(() => window.__usageEvents.at(-1).recordsChanged),
    false,
    "无新增用量只广播扫描状态",
  );
  for (const id of ["local:codex", "local:claude", "local:grok", "local:gemini"]) {
    assert.equal(sourceRecord(deduplicated, id).input, sourceRecord(usage, id).input);
    assert.equal(sourceRecord(deduplicated, id).output, sourceRecord(usage, id).output);
  }
  status = await page.evaluate(() => window.sinan.usage.localStatus());
  assert.ok(
    status.sources.every((source) => source.status === "ready" && source.lastUsageAt === timestamp),
  );
  await page.getByRole("button", { name: "关闭本机监控", exact: true }).click();
  await page.getByRole("button", { name: "开启本机监控", exact: true }).waitFor();
  await appendFile(file, event(180, 40));
  await page.evaluate(() => window.sinan.usage.refreshLocal());
  assert.equal(
    sourceRecord(await page.evaluate(() => window.sinan.usage.list()), "local:codex").input,
    150,
  );
  await page.getByRole("button", { name: "开启本机监控", exact: true }).click();
  await waitForLocalInput(page, 180);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByText("监控已开启", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".usage-record")].some(
      (row) => row.textContent.includes("Codex") && row.textContent.includes("220 Token"),
    ),
  );
  await mkdir("release/screenshots", { recursive: true });
  await page.getByRole("button", { name: "关闭监控详情", exact: true }).click();
  await page.locator(".local-monitor-dialog").waitFor({ state: "detached" });
  await page.locator(".usage-record").filter({ hasText: "Codex" }).locator("summary").click();
  await page.screenshot({ path: "release/screenshots/usage-desktop-integrated.png" });
  await instance.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
  assert.equal((await page.evaluate(() => window.sinan.vault.status())).unlocked, false);
  assert.equal((await page.evaluate(() => window.sinan.usage.localStatus())).paused, false);
  await appendFile(file, event(200, 45));
  await page.evaluate(() => window.sinan.usage.refreshLocal());
  await page
    .locator(".usage-chart-today")
    .getByText("539 Token", { exact: true })
    .waitFor({ timeout: 1500 });
  assert.equal(
    await page.evaluate(() => window.__usageEvents.at(-1).recordsChanged),
    true,
    "真实采集结束广播统计变化",
  );
  assert.equal(
    sourceRecord(await page.evaluate(() => window.sinan.usage.list()), "local:codex").input,
    200,
  );
  // 保持锁库，等待后台定时器采集新增记录，不依赖手动刷新。
  await appendFile(file, event(210, 50));
  await waitForLocalInput(page, 210);
  await page
    .locator(".usage-chart-today")
    .getByText("549 Token", { exact: true })
    .waitFor({ timeout: 1500 });
  // 恶意辅助窗口虽加载同一预载桥，仍不能读取主窗口服务。
  const foreign = await instance.evaluate(async ({ BrowserWindow }, preload) => {
    const extra = new BrowserWindow({
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true },
    });
    try {
      await extra.loadURL("data:text/html,<p>isolated</p>");
      return await extra.webContents.executeJavaScript(
        "window.sinan.usage.localStatus().then(() => false, () => true)",
      );
    } finally {
      extra.destroy();
    }
  }, resolve("electron/preload.cjs"));
  assert.equal(foreign, true, "非主窗口IPC拒绝");
  await page.evaluate(() => window.sinan.usage.configureLocal({ enabled: false }));
  usage = await page.evaluate(() => window.sinan.usage.list());
  assert.equal(sourceRecord(usage, "local:codex").input, 210, "停用保留历史");
  assert.equal(sourceRecord(usage, "local:claude").input, 55);
  assert.equal(sourceRecord(usage, "local:grok").input, 220);
  assert.equal(sourceRecord(usage, "local:gemini").input, 64);
  const cache = await readFile(join(directory, "local-usage.json"), "utf8");
  const manifest = JSON.parse(cache);
  assert.equal(manifest.version, 2, "正式 Electron 引擎迁移完整十万条旧事件索引");
  const indexBytes = await readFile(join(directory, manifest.index));
  assert.doesNotMatch(
    indexBytes.toString("utf8"),
    /PRIVATE_|synthetic\.jsonl|qa-session|qa-claude-|qa-grok-|qa-gemini-/,
  );
  assert.doesNotMatch(cache, /PRIVATE_|synthetic\.jsonl|qa-session|qa-claude-|qa-grok-|qa-gemini-/);
  assert.equal(cache.includes(directory), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      defaultOn: true,
      increments: true,
      liveChartAfterScan: true,
      legacy100kIndexMigration: true,
      statusOnlyEvents: true,
      clients: ["Codex", "Claude Code", "Grok Build", "Gemini CLI"],
      emptyGeminiReportsNoUsage: true,
      snapshotDeduplication: true,
      pauseResume: true,
      collectsWhileLocked: true,
      fixedRoots: true,
      foreignWindowRejected: true,
      privacy: true,
      pageErrors: errors,
    }),
  );
} finally {
  await instance?.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
