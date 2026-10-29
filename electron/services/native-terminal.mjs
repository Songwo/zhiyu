import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** 原生窗口只接收终端输出，凭据与主机指纹始终由现有 SSH 管理器处理。 */
export class NativeTerminalManager {
  #windows = new Map();
  #executable;
  #connect;
  #ssh;
  #spawn;
  #onEvent;
  constructor({ executable, ssh, connect, spawnProcess = spawn, onEvent = () => {} }) {
    this.#executable = executable;
    this.#ssh = ssh;
    this.#connect = connect;
    this.#spawn = spawnProcess;
    this.#onEvent = onEvent;
  }
  async open(target, options = {}) {
    const existing = this.#windows.get(target.id);
    if (existing) {
      existing.send({ type: "focus" });
      return existing.ready;
    }
    const child = this.#spawn(
      this.#executable,
      options.parentHandle ? ["--embed", String(options.parentHandle)] : [],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let resolveReady, rejectReady;
    const entry = {
      child,
      session: null,
      disposed: false,
      generation: 0,
      connecting: false,
      blocked: false,
      size: { cols: 100, rows: 30 },
      ready: new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      send: (message) => {
        if (entry.disposed || child.stdin.destroyed) return;
        if (child.stdin.writableLength > 8 * 1024 * 1024) {
          dispose(new Error("原生终端输出拥塞，会话已停止。"));
          return;
        }
        if (!child.stdin.write(JSON.stringify(message) + "\n")) {
          entry.blocked = true;
          if (entry.session) this.#ssh.pause?.(entry.session);
        }
        if (message.type === "status") this.#onEvent({ serverId: target.id, ...message });
      },
    };
    this.#windows.set(target.id, entry);
    const dispose = (error) => {
      if (entry.disposed) return;
      entry.disposed = true;
      entry.generation++;
      clearTimeout(timeout);
      if (this.#windows.get(target.id) === entry) this.#windows.delete(target.id);
      this.#onEvent({
        serverId: target.id,
        type: "status",
        value: "closed",
        message: "会话已关闭",
      });
      if (entry.session) this.#ssh.close(entry.session);
      child.kill();
      rejectReady(error || new Error("原生终端已关闭。"));
    };
    entry.dispose = dispose;
    const timeout = setTimeout(() => dispose(new Error("原生终端启动超时，请重试。")), 10000);
    child.on("error", () => dispose(new Error("无法启动原生终端，请重新构建或安装桌面版。")));
    child.on("exit", () => dispose());
    child.stdin.on("error", () => dispose(new Error("原生终端通信已断开。")));
    child.stdin.on("drain", () => {
      entry.blocked = false;
      if (!entry.disposed && entry.session) this.#ssh.resume?.(entry.session);
    });
    // 不将进程的诊断输出或服务器内容写入应用日志。
    child.stderr.resume();
    let started = false;
    const connect = async (message) => {
      if (entry.connecting || entry.disposed) return;
      const cols = Math.max(20, Math.min(400, Math.floor(Number(message.cols) || 100)));
      const rows = Math.max(4, Math.min(200, Math.floor(Number(message.rows) || 30)));
      entry.size = { cols, rows };
      entry.connecting = true;
      const generation = ++entry.generation;
      if (entry.session) {
        const session = entry.session;
        entry.session = null;
        this.#ssh.close(session);
      }
      entry.send({
        type: "init",
        label: `${target.label || target.name || "SSH"}  ·  ${target.username}@${target.host}:${target.port || 22}`,
      });
      entry.send({ type: "data", data: "\x1b[0m\r\n" });
      let ended = false;
      const startedAt = performance.now();
      try {
        const result = await this.#connect(target.id, { cols, rows }, (channel, payload) => {
          if (entry.disposed || entry.generation !== generation) return;
          if (channel === "ssh:data") entry.send({ type: "data", data: payload.chunk });
          if (channel === "ssh:exit") {
            ended = true;
            entry.session = null;
            entry.send({ type: "status", value: "closed", message: "连接已断开，可重新连接" });
          }
        });
        if (entry.disposed || entry.generation !== generation || ended)
          this.#ssh.close(result.sessionId);
        else {
          entry.session = result.sessionId;
          if (entry.blocked) this.#ssh.pause?.(entry.session);
          this.#ssh.resize(result.sessionId, entry.size.cols, entry.size.rows);
          entry.send({
            type: "status",
            value: "open",
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }
      } catch (error) {
        if (!entry.disposed && entry.generation === generation)
          entry.send({ type: "status", value: "error", message: String(error.message) });
      } finally {
        if (entry.generation === generation) entry.connecting = false;
      }
    };
    // JSON 一行一条；过大或损坏的消息关闭此窗口，不影响其他服务器会话。
    let pendingBytes = 0;
    child.stdout.on("data", (chunk) => {
      pendingBytes += chunk.length;
      if (pendingBytes > 8 * 1024 * 1024) dispose(new Error("原生终端消息过大。"));
      if (chunk.includes(10)) pendingBytes = 0;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (entry.disposed) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        dispose(new Error("原生终端消息无效。"));
        return;
      }
      if (!message || typeof message !== "object") return;
      if (["layout", "appearance", "viewport"].includes(message.type))
        this.#onEvent({ serverId: target.id, ...message });
      if (message.type === "ready" && !started) {
        started = true;
        clearTimeout(timeout);
        if (options.appearance) entry.send({ type: "appearance", ...options.appearance });
        if (options.bounds) entry.send({ type: "bounds", ...options.bounds });
        this.#onEvent({
          serverId: target.id,
          type: "attached",
          embedded: message.embedded === true,
          parentHandle: message.parentHandle,
          childHandle: message.childHandle,
        });
        resolveReady({ native: true });
        if (options.preview) {
          entry.send({ type: "preview" });
          entry.send({ type: "status", value: "preview", message: "外观预览 · 未连接服务器" });
        } else void connect(message);
      } else if (message.type === "reconnect" && started) void connect(message);
      else if (message.type === "close") dispose();
      else if (
        message.type === "input" &&
        entry.session &&
        typeof message.data === "string" &&
        message.data.length <= 2000000
      )
        this.#ssh.write(entry.session, message.data);
      else if (message.type === "resize") {
        entry.size = {
          cols: Math.max(20, Math.min(400, Math.floor(Number(message.cols) || 100))),
          rows: Math.max(4, Math.min(200, Math.floor(Number(message.rows) || 30))),
        };
        if (entry.session) this.#ssh.resize(entry.session, entry.size.cols, entry.size.rows);
      }
    });
    return entry.ready;
  }
  closeAll() {
    for (const entry of this.#windows.values()) entry.dispose();
  }
  update(id, message) {
    const entry = this.#windows.get(id);
    if (entry) entry.send(message);
  }
  close(id) {
    this.#windows.get(id)?.dispose();
  }
}

/** 只接受布局、字体、颜色和工具栏输入；原生句柄由主进程提供，渲染器不能指定其他应用。 */
export function nativeTerminalUpdate(value) {
  if (!value || typeof value !== "object") throw new Error("终端配置无效。");
  if (value.type === "bounds") {
    const number = (key) => {
      const n = value[key];
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("终端布局无效。");
      return Math.round(Math.max(0, Math.min(30000, n)));
    };
    return {
      type: "bounds",
      x: number("x"),
      y: number("y"),
      width: number("width"),
      height: number("height"),
      visible: value.visible === true,
    };
  }
  if (value.type === "appearance") {
    const color = (hex) => {
      if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex))
        throw new Error("终端颜色无效。");
      return hex;
    };
    if (
      !Array.isArray(value.colors) ||
      value.colors.length !== 16 ||
      ![
        "Cascadia Mono, Consolas, Microsoft YaHei UI",
        "Consolas, Microsoft YaHei UI",
        "JetBrains Mono, Consolas, Microsoft YaHei UI",
      ].includes(value.fontFamily)
    )
      throw new Error("终端字体或配色无效。");
    if (!Number.isFinite(value.fontSize)) throw new Error("终端字号无效。");
    return {
      type: "appearance",
      background: color(value.background),
      foreground: color(value.foreground),
      colors: value.colors.map(color),
      fontFamily: value.fontFamily,
      fontSize: Math.max(11, Math.min(22, value.fontSize)),
      cursorStyle: ["bar", "block", "underline"].includes(value.cursorStyle)
        ? value.cursorStyle
        : "bar",
      cursorBlink: value.cursorBlink === true,
      autoFollow: value.autoFollow !== false,
      scrollback: [1000, 5000, 10000, 20000].includes(value.scrollback) ? value.scrollback : 5000,
    };
  }
  if (["copy", "paste", "focus", "reconnect", "latest", "scroll-lock"].includes(value.type))
    return { type: value.type };
  // 工具栏的常用命令与清屏走原生控件的输入路径，和键盘输入一样只在已连接时发送。
  if (value.type === "input") {
    if (typeof value.data !== "string" || !value.data || value.data.length > 4096)
      throw new Error("终端输入无效。");
    return { type: "input", data: value.data };
  }
  throw new Error("不支持的终端操作。");
}
