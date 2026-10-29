import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { SshManager } from "./ssh.mjs";

function makeKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

/**
 * Minimal exec-capable SSH server, enough for `SshManager.test()` to run
 * `id -un` and come back with a username.
 */
function makeServer(hostKey) {
  const connections = new Set();
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.username === "tester" && ctx.password === "fixture"
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.end("tester\n");
        });
      }),
    );
  });
  return {
    start: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      }),
    stop: async () => {
      for (const c of connections) c.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const CREDENTIAL = { kind: "password", password: "fixture" };

test(
  "SSH 主机指纹 TOFU：首次记录、复用放行、变更拒绝、重置后重新记录",
  { timeout: 30000 },
  async () => {
    const a = makeServer(makeKey());
    const port = await a.start();
    const target = { id: "fixture", host: "127.0.0.1", port, username: "tester" };
    const manager = new SshManager(() => {});
    let b = null;
    try {
      // First use pins the fingerprint, and the immediate reconnect verifies it.
      assert.match((await manager.test(target, CREDENTIAL)).message, /tester/);
      assert.match((await manager.test(target, CREDENTIAL)).message, /tester/);

      // Same address, different host key: a man in the middle or a reinstalled
      // server — either way the connection must be refused, not silently trusted.
      await a.stop();
      b = makeServer(makeKey());
      await b.start(port);
      await assert.rejects(manager.test(target, CREDENTIAL), /主机指纹已变更/);
      await assert.rejects(manager.test(target, CREDENTIAL), /主机指纹已变更/);

      // After a deliberate reset the new key is pinned in turn.
      await manager.resetHostKey(target);
      assert.match((await manager.test(target, CREDENTIAL)).message, /tester/);
    } finally {
      await a.stop().catch(() => {});
      if (b) await b.stop().catch(() => {});
    }
  },
);

test("SSH 主机指纹存储不可用时拒绝连接而不是放行", { timeout: 30000 }, async () => {
  const s = makeServer(makeKey());
  const port = await s.start();
  const manager = new SshManager(() => {}, {
    get: async () => {
      throw new Error("密钥库已锁定");
    },
    set: async () => {},
    remove: async () => {},
  });
  try {
    await assert.rejects(
      manager.test({ id: "fixture", host: "127.0.0.1", port, username: "tester" }, CREDENTIAL),
      /密钥库已锁定/,
    );
  } finally {
    await s.stop();
  }
});
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

class BrokenClient extends EventEmitter {
  destroyed = false;
  connect() {
    queueMicrotask(() => {
      this.emit("error", new Error("ECONNRESET"));
      this.emit("error", new Error("Connection lost before handshake"));
      this.emit("close");
    });
  }
  destroy() {
    this.destroyed = true;
  }
  end() {
    this.destroy();
  }
}

test("SSH 终端配置真实保活和有限失联检测，输出支持背压", async () => {
  const client = new BrokenClient();
  const stream = new PassThrough();
  stream.stderr = new PassThrough();
  let config;
  client.connect = (value) => {
    config = value;
    queueMicrotask(() => client.emit("ready"));
  };
  client.shell = (_size, callback) => callback(null, stream);
  const manager = new SshManager(
    () => {},
    undefined,
    () => client,
  );
  const result = await manager.openShell(
    { id: "heartbeat", host: "fixture", username: "tester" },
    CREDENTIAL,
  );
  try {
    assert.equal(config.keepaliveInterval, 20000);
    assert.equal(config.keepaliveCountMax, 3);
    manager.pause(result.sessionId);
    assert.equal(stream.isPaused(), true);
    assert.equal(stream.stderr.isPaused(), true);
    manager.resume(result.sessionId);
    assert.equal(stream.isPaused(), false);
    assert.equal(stream.stderr.isPaused(), false);
  } finally {
    manager.closeAll();
  }
});

test("SSH 首次失败及关闭时的二次错误均被处理", async () => {
  const client = new BrokenClient();
  const manager = new SshManager(
    () => {},
    undefined,
    () => client,
  );
  await assert.rejects(
    manager.test({ host: "fixture", username: "tester" }, CREDENTIAL),
    /连接被重置/,
  );
  assert.equal(client.destroyed, true);
  assert.doesNotThrow(() => client.emit("error", new Error("Connection lost before handshake")));
});

test("SSH 命令执行中断立即失败，保留关闭阶段错误监听", async () => {
  const client = new BrokenClient();
  client.connect = () => queueMicrotask(() => client.emit("ready"));
  client.exec = () =>
    queueMicrotask(() => {
      client.emit("error", new Error("ECONNRESET"));
      client.emit("error", new Error("Connection lost before handshake"));
      client.emit("close");
    });
  const manager = new SshManager(
    () => {},
    undefined,
    () => client,
  );
  await assert.rejects(
    manager.probe({ host: "fixture", username: "tester" }, CREDENTIAL),
    /连接被重置/,
  );
  assert.equal(client.destroyed, true);
});

test("SSH 终端打开失败关闭连接且不丢失后续错误监听", async () => {
  const client = new BrokenClient();
  client.connect = () => queueMicrotask(() => client.emit("ready"));
  client.shell = (_options, callback) => callback(new Error("shell rejected"));
  const manager = new SshManager(
    () => {},
    undefined,
    () => client,
  );
  await assert.rejects(
    manager.openShell({ host: "fixture", username: "tester" }, CREDENTIAL),
    /shell rejected/,
  );
  assert.equal(client.destroyed, true);
  assert.doesNotThrow(() => client.emit("error", new Error("ECONNRESET")));
});
