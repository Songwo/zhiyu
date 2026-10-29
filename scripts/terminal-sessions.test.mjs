import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openTerminalSession,
  leaveTerminalSession,
  disconnectTerminalSession,
  TERMINAL_PREVIEW,
} from "../src/lib/terminal-sessions.mjs";
test("离开终端保留会话，重新打开不重复创建", () => {
  const ids = openTerminalSession([], "server-a");
  assert.deepEqual(leaveTerminalSession(ids, "server-a"), {
    sshServerId: null,
    sshSessionIds: ["server-a"],
  });
  assert.deepEqual(openTerminalSession(ids, "server-a"), ["server-a"]);
  assert.deepEqual(openTerminalSession(ids, "server-b"), ["server-a", "server-b"]);
});
test("显式断开只结束指定会话；外观预览不驻留", () => {
  assert.deepEqual(disconnectTerminalSession(["a", "b"], "b", "a"), {
    sshServerId: "b",
    sshSessionIds: ["b"],
  });
  assert.deepEqual(disconnectTerminalSession(["a"], "a", "a"), {
    sshServerId: null,
    sshSessionIds: [],
  });
  assert.deepEqual(leaveTerminalSession(["a", TERMINAL_PREVIEW], TERMINAL_PREVIEW).sshSessionIds, [
    "a",
  ]);
  assert.deepEqual(openTerminalSession([TERMINAL_PREVIEW], "a"), ["a"]);
});
