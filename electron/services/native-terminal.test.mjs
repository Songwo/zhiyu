import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import ssh2 from "ssh2";
import { NativeTerminalManager, nativeTerminalUpdate } from "./native-terminal.mjs";
import { SshManager } from "./ssh.mjs";

function processFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.messages = [];
  child.stdin.on("data", (chunk) => child.messages.push(JSON.parse(chunk.toString())));
  child.kill = () => {
    child.emit("exit", 0);
    return true;
  };
  child.message = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  return child;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("嵌入消息仅允许受控字体、颜色、布局与操作", () => {
  assert.deepEqual(
    nativeTerminalUpdate({
      type: "bounds",
      x: -1,
      y: 12.6,
      width: 50000,
      height: 600,
      visible: true,
    }),
    { type: "bounds", x: 0, y: 13, width: 30000, height: 600, visible: true },
  );
  assert.throws(() => nativeTerminalUpdate({ type: "bounds", x: Infinity }), /布局无效/);
  assert.throws(
    () =>
      nativeTerminalUpdate({
        type: "appearance",
        colors: Array(16).fill("#ffffff"),
        fontFamily: "remote-font",
        fontSize: 14,
      }),
    /字体或配色无效/,
  );
  assert.throws(() => nativeTerminalUpdate({ type: "attach", parentHandle: "1234" }), /不支持/);
  assert.deepEqual(nativeTerminalUpdate({ type: "copy", parentHandle: "1234" }), { type: "copy" });
  assert.deepEqual(nativeTerminalUpdate({ type: "input", data: "df -h", extra: 1 }), {
    type: "input",
    data: "df -h",
  });
  assert.throws(() => nativeTerminalUpdate({ type: "input", data: "x".repeat(5000) }), /输入无效/);
  assert.throws(() => nativeTerminalUpdate({ type: "input", data: 42 }), /输入无效/);
  const appearance = {
    type: "appearance",
    background: "#ffffff",
    foreground: "#000000",
    colors: Array(16).fill("#808080"),
    fontFamily: "Consolas, Microsoft YaHei UI",
    fontSize: 14,
  };
  assert.equal(nativeTerminalUpdate({ ...appearance, cursorStyle: "block" }).cursorStyle, "block");
  assert.equal(nativeTerminalUpdate({ ...appearance, cursorStyle: "beam" }).cursorStyle, "bar");
});

test("内嵌预览传递主窗口句柄与外观，不发起 SSH 连接", async () => {
  const child = processFixture();
  const events = [];
  let opened = 0;
  const manager = new NativeTerminalManager({
    executable: "test",
    ssh: {},
    connect: async () => {
      opened++;
    },
    spawnProcess: (_file, args) => {
      assert.deepEqual(args, ["--embed", "12345"]);
      return child;
    },
    onEvent: (event) => events.push(event),
  });
  try {
    const ready = manager.open(
      { id: "preview" },
      {
        parentHandle: "12345",
        preview: true,
        appearance: { background: "#ffffff" },
        bounds: { visible: true },
      },
    );
    child.message({ type: "ready", embedded: true, parentHandle: "12345", childHandle: "67890" });
    await ready;
    assert.equal(opened, 0);
    assert.equal(events[0].embedded, true);
    assert.ok(child.messages.some((m) => m.type === "preview"));
    manager.update("preview", { type: "bounds", visible: false });
    assert.equal(child.messages.at(-1).visible, false);
  } finally {
    manager.closeAll();
  }
});
const target = {
  id: "qa",
  host: "127.0.0.1",
  port: 22,
  username: "tester",
  label: "本机测试服务器",
};

test("原生输出背压暂停 SSH，管道排空后恢复读取", async () => {
  const child = processFixture();
  const calls = [];
  let sink;
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh: {
      close() {},
      resize() {},
      pause: (id) => calls.push(["pause", id]),
      resume: (id) => calls.push(["resume", id]),
    },
    connect: async (_id, _size, emit) => {
      sink = emit;
      return { sessionId: "flow" };
    },
  });
  try {
    const opened = manager.open(target);
    child.message({ type: "ready" });
    await opened;
    await tick();
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (message) => {
      write(message);
      return false;
    };
    sink("ssh:data", { chunk: "large output" });
    assert.deepEqual(calls.at(-1), ["pause", "flow"]);
    child.stdin.emit("drain");
    assert.deepEqual(calls.at(-1), ["resume", "flow"]);
  } finally {
    manager.closeAll();
  }
});

test("原生窗口：握手、窗口复用、输入与缩放、重连隔离、退出清理", async () => {
  const child = processFixture();
  const calls = [];
  let sink,
    count = 0;
  const manager = new NativeTerminalManager({
    executable: "native.exe",
    spawnProcess: (file, args, options) => {
      assert.equal(file, "native.exe");
      assert.deepEqual(args, []);
      assert.equal(options.windowsHide, true);
      return child;
    },
    ssh: {
      write: (...args) => calls.push(["write", ...args]),
      resize: (...args) => calls.push(["resize", ...args]),
      close: (id) => calls.push(["close", id]),
    },
    connect: async (id, size, emit) => {
      sink = emit;
      calls.push(["connect", id, size]);
      return { sessionId: `s${++count}` };
    },
  });
  try {
    const opened = manager.open(target);
    child.message({ type: "ready", cols: 100, rows: 30 });
    assert.deepEqual(await opened, { native: true });
    await tick();
    sink("ssh:data", { chunk: "中文\x1b[31m输出" });
    assert.ok(child.messages.some((m) => m.type === "data" && m.data.includes("中文")));
    await manager.open(target);
    assert.equal(count, 1);
    assert.equal(child.messages.at(-1).type, "focus");
    child.message({ type: "input", data: "pwd\r" });
    child.message({ type: "resize", cols: 9999, rows: -1 });
    assert.ok(calls.some((c) => c[0] === "write" && c[2] === "pwd\r"));
    assert.ok(calls.some((c) => c[0] === "resize" && c[2] === 400 && c[3] === 4));
    const oldSink = sink;
    child.message({ type: "reconnect" });
    await tick();
    assert.equal(count, 2);
    const before = child.messages.length;
    oldSink("ssh:exit", {});
    assert.equal(child.messages.length, before);
    child.message({ type: "close" });
    assert.ok(calls.some((c) => c[0] === "close" && c[1] === "s2"));
  } finally {
    manager.closeAll();
  }
});

test("关闭尚在连接的原生窗口，不遗留迟到的 SSH 会话", async () => {
  const child = processFixture();
  let release;
  const closed = [];
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh: { close: (id) => closed.push(id) },
    connect: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const opened = manager.open(target);
  child.message({ type: "ready" });
  await opened;
  manager.closeAll();
  release({ sessionId: "late" });
  await tick();
  assert.deepEqual(closed, ["late"]);
});

test("连接建立期间调整窗口，SSH 就绪后应用最新尺寸", async () => {
  const child = processFixture();
  let release;
  const sizes = [];
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh: { close() {}, resize: (...args) => sizes.push(args) },
    connect: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    const opened = manager.open(target);
    child.message({ type: "ready", cols: 100, rows: 30 });
    await opened;
    child.message({ type: "resize", cols: 80, rows: 20 });
    release({ sessionId: "resized" });
    await tick();
    assert.deepEqual(sizes, [["resized", 80, 20]]);
  } finally {
    manager.closeAll();
  }
});

test("SSH 先关闭后才返回会话标识时，不误报已连接", async () => {
  const child = processFixture();
  const closed = [];
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh: { close: (id) => closed.push(id) },
    connect: async (_id, _size, sink) => {
      sink("ssh:exit", {});
      return { sessionId: "closed" };
    },
  });
  try {
    const opened = manager.open(target);
    child.message({ type: "ready" });
    await opened;
    await tick();
    assert.deepEqual(closed, ["closed"]);
    assert.ok(!child.messages.some((m) => m.type === "status" && m.value === "open"));
  } finally {
    manager.closeAll();
  }
});

test("启动失败和损坏消息明确拒绝，不回退成网页终端", async () => {
  for (const broken of [false, true]) {
    const child = processFixture();
    const manager = new NativeTerminalManager({
      executable: "test",
      spawnProcess: () => child,
      ssh: {},
      connect: async () => {
        throw new Error("不可调用");
      },
    });
    const opened = manager.open(target);
    const rejected = assert.rejects(opened, broken ? /消息无效/ : /无法启动/);
    if (broken) child.stdout.write("invalid\n");
    else child.emit("error", new Error("ENOENT"));
    await rejected;
    manager.closeAll();
  }
});

test("认证失败显示原始错误，重新连接会重新读取凭据", async () => {
  const child = processFixture();
  let count = 0;
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh: { close() {} },
    connect: async () => {
      count++;
      throw new Error("密钥库已锁定");
    },
  });
  try {
    const opened = manager.open(target);
    child.message({ type: "ready" });
    await opened;
    await tick();
    assert.equal(child.messages.at(-1).message, "密钥库已锁定");
    child.message({ type: "reconnect" });
    await tick();
    assert.equal(count, 2);
  } finally {
    manager.closeAll();
  }
});

test("真实 SSH：原生通道收到分块 UTF-8、发送命令并传递 PTY 尺寸", { timeout: 20000 }, async () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const clients = new Set();
  const sizes = [];
  let output = "";
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === "fixture" ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty, _reject, info) => {
          sizes.push([info.cols, info.rows]);
          acceptPty();
        });
        session.on("window-change", (acceptChange, _reject, info) => {
          sizes.push([info.cols, info.rows]);
          acceptChange?.();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          const bytes = Buffer.from("真实中文连接\r\n");
          let greetingDone = false;
          const replies = [];
          stream.write(bytes.subarray(0, 2));
          // 同一字符的 UTF-8 字节之间不能插入另一条回复，否则测试服务自身会制造乱码。
          setTimeout(() => {
            stream.write(bytes.subarray(2));
            greetingDone = true;
            for (const reply of replies) stream.write(reply);
          }, 15);
          stream.on("data", (chunk) => {
            output += chunk.toString();
            const reply = "ACK:" + chunk;
            if (greetingDone) stream.write(reply);
            else replies.push(reply);
          });
        });
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = processFixture();
  const ssh = new SshManager(() => assert.fail("原生输出不能发送到网页终端"));
  const actual = { ...target, port: server.address().port };
  const manager = new NativeTerminalManager({
    executable: "test",
    spawnProcess: () => child,
    ssh,
    connect: (_id, size, sink) =>
      ssh.openShell(actual, { kind: "password", password: "fixture" }, size, sink),
  });
  const until = async (predicate) => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("SSH 条件等待超时：" + JSON.stringify({ messages: child.messages, sizes, output }));
  };
  try {
    const opened = manager.open(actual);
    child.message({ type: "ready", cols: 120, rows: 32 });
    await opened;
    await until(() => child.messages.some((m) => m.type === "status" && m.value === "open"));
    child.message({ type: "input", data: "pwd\r" });
    child.message({ type: "resize", cols: 90, rows: 24 });
    await until(
      () =>
        child.messages
          .filter((m) => m.type === "data")
          .map((m) => m.data)
          .join("")
          .includes("真实中文连接") &&
        output.includes("pwd\r") &&
        sizes.some(([c, r]) => c === 90 && r === 24),
    );
    assert.deepEqual(sizes[0], [120, 32]);
    assert.ok(
      !child.messages
        .filter((m) => m.type === "data")
        .map((m) => m.data)
        .join("")
        .includes("�"),
    );
  } finally {
    manager.closeAll();
    ssh.closeAll();
    for (const client of clients) client.end();
    await new Promise((r) => server.close(r));
  }
});

test(
  "真实 C# 进程：UTF-8 握手、初始化与输出、关闭后退出",
  {
    skip:
      process.platform !== "win32" ||
      !existsSync(resolve("release/native-terminal/Zhiyu.Terminal.exe")),
    timeout: 15000,
  },
  async () => {
    let child;
    const manager = new NativeTerminalManager({
      executable: resolve("release/native-terminal/Zhiyu.Terminal.exe"),
      spawnProcess: (...args) => {
        child = spawn(...args);
        return child;
      },
      ssh: { close() {}, resize() {} },
      connect: async (_id, _size, sink) => {
        sink("ssh:data", { chunk: "\x1b[32m本机原生进程测试\x1b[0m\r\n" });
        return { sessionId: "native-test" };
      },
    });
    try {
      assert.deepEqual(await manager.open(target), { native: true });
      await new Promise((r) => setTimeout(r, 100));
      const exited = new Promise((resolve) => child.once("exit", resolve));
      manager.closeAll();
      await exited;
    } finally {
      manager.closeAll();
    }
  },
);
