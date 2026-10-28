import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import ssh2 from "ssh2";
import { SftpService } from "./sftp.mjs";
import { SERVICES_SCRIPT, SERVICES_TIMEOUT, parseServices } from "./service-monitor.mjs";

const { Client } = ssh2;

const CONNECT_TIMEOUT = 15_000;
const PROBE_TIMEOUT = 20_000;

/**
 * OpenSSH-style fingerprint of a raw host key buffer: SHA-256, base64, no padding.
 *
 * Same format `ssh-keygen -l` prints, so a suspicious fingerprint can be checked
 * against the real server out of band before the user accepts the change.
 */
export function fingerprintOf(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * In-memory TOFU store — what a SshManager without a wired-in store falls back to.
 * Reconnects within one process are still verified, which is what the test suite
 * exercises; the desktop app passes a vault-backed store so pins survive restarts
 * and tampering with the on-disk ciphertext is rejected by the GCM auth tag.
 */
function memoryHostKeyStore() {
  const known = new Map();
  return {
    async get(host, port) {
      return known.get(`${host}:${port}`) ?? null;
    },
    async set(host, port, fingerprint) {
      known.set(`${host}:${port}`, fingerprint);
    },
    async remove(host, port) {
      known.delete(`${host}:${port}`);
    },
  };
}

/**
 * One shell script, one round trip, `key=value` back.
 *
 * CPU is sampled from two reads of /proc/stat 400ms apart rather than `top`,
 * which is slow, non-uniform across distros, and reports the wrong thing on the
 * first sample anyway. Everything degrades to an empty value instead of failing
 * the whole probe, so a BSD box still reports what it can.
 */
const PROBE_SCRIPT = `
set +e
os=$( . /etc/os-release 2>/dev/null; printf '%s' "\${PRETTY_NAME:-$(uname -s) $(uname -r)}" )
printf 'os=%s\\n' "$os"
printf 'host=%s\\n' "$(hostname 2>/dev/null)"
printf 'kernel=%s\\n' "$(uname -r 2>/dev/null)"

if [ -r /proc/uptime ]; then
  printf 'uptime=%s\\n' "$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)"
fi

if [ -r /proc/stat ]; then
  read _cpu a b c d e f g _rest < /proc/stat
  t1=$((a+b+c+d+e+f+g)); i1=$d
  sleep 0.4
  read _cpu a b c d e f g _rest < /proc/stat
  t2=$((a+b+c+d+e+f+g)); i2=$d
  dt=$((t2-t1)); di=$((i2-i1))
  [ "$dt" -gt 0 ] && printf 'cpu=%s\\n' "$(( (100*(dt-di)) / dt ))"
fi

if [ -r /proc/meminfo ]; then
  total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  [ -z "$avail" ] && avail=$(awk '/^MemFree:/{print $2}' /proc/meminfo)
  [ -n "$total" ] && [ "$total" -gt 0 ] && printf 'memory=%s\\nmemTotalKb=%s\\n' "$(( (100*(total-avail))/total ))" "$total"
fi

df -Pk / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); printf "disk=%s\\ndiskTotalKb=%s\\n", $5, $2}'
printf 'loadavg=%s\\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
`;

/**
 * Live SSH connections, keyed by session id.
 *
 * Interactive shells and one-shot probes both go through here so a host is
 * never connected twice for the same click; probes open their own short-lived
 * connection because a shell channel is the user's, not ours.
 */
export class SshManager {
  sftp = new SftpService((target, credential) => this.#connect(target, credential));
  /** @type {Map<string, {client: import("ssh2").Client, stream: any, serverId: string}>} */
  #sessions = new Map();
  #emit;
  #hostKeys;
  #createClient;

  constructor(emit, hostKeys = memoryHostKeyStore(), createClient = () => new Client()) {
    this.#emit = emit;
    this.#hostKeys = hostKeys;
    this.#createClient = createClient;
  }

  async #connect(target, credential) {
    const config = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      readyTimeout: CONNECT_TIMEOUT,
      keepaliveInterval: 20_000,
      // Older boxes still hand out ssh-rsa host keys; refusing them outright
      // would make the app useless against exactly the servers people keep.
      algorithms: {
        serverHostKey: [
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "rsa-sha2-512",
          "rsa-sha2-256",
          "ssh-rsa",
        ],
      },
    };

    // Trust on first use: the first handshake pins the server's host key
    // fingerprint, every later connection must present the same key or the
    // handshake is refused — the SSH equivalent of a browser's certificate
    // pin. Without this, a man in the middle impersonating the server
    // harvests the password or private key on their way to the real host.
    let hostKeyFailure = null;
    config.hostVerifier = (key, callback) => {
      void (async () => {
        const host = String(target.host || "");
        const port = target.port || 22;
        const fingerprint = fingerprintOf(key);
        let known;
        try {
          known = await this.#hostKeys.get(host, port);
        } catch (err) {
          // A locked vault or a failing disk must not degrade into an
          // unverified connection.
          hostKeyFailure = err;
          callback(false);
          return;
        }
        if (typeof known !== "string" || !known) {
          try {
            await this.#hostKeys.set(host, port, fingerprint);
          } catch (err) {
            hostKeyFailure = err;
            callback(false);
            return;
          }
          callback(true);
          return;
        }
        if (known === fingerprint) {
          callback(true);
          return;
        }
        hostKeyFailure = new Error(
          `主机指纹已变更：${host}:${port} 此前记录 ${known}，本次收到 ${fingerprint}。` +
            "服务器可能已重装，也可能连接正被劫持；确认服务器确实更换后，可在该资产的 SSH 凭据面板重置指纹。",
        );
        callback(false);
      })();
    };

    if (!credential) throw new Error("没有找到该主机的凭据，请先在密钥库中保存");

    if (credential.kind === "password") {
      if (!credential.password) throw new Error("凭据缺少密码");
      config.password = credential.password;
    } else if (credential.kind === "key") {
      const key =
        credential.privateKey ??
        (credential.privateKeyPath ? await readFile(credential.privateKeyPath, "utf8") : null);
      if (!key) throw new Error("凭据缺少私钥");
      config.privateKey = key;
      if (credential.passphrase) config.passphrase = credential.passphrase;
    } else if (credential.kind === "agent") {
      config.agent =
        process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined);
      if (!config.agent) throw new Error("找不到 SSH agent");
    } else {
      throw new Error(`不支持的认证方式：${credential.kind}`);
    }

    const client = this.#createClient();
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        client.removeListener("ready", ready);
        reject(hostKeyFailure ?? new Error(friendly(err)));
        client.destroy();
      };
      const ready = () => {
        settled = true;
        resolve();
      };
      // 保留连接级监听：ssh2 在失败后的关闭过程中可能再次发出 error。
      // 就绪后的业务错误由命令、终端及 SFTP 各自处理。
      client.on("error", fail);
      client.once("close", () => fail(new Error("SSH 连接已关闭")));
      client.once("ready", ready);
      try {
        client.connect(config);
      } catch (err) {
        fail(err);
      }
    });
    return client;
  }

  /** Forget the pinned host key so the next connection trust-on-first-use again. */
  async resetHostKey(target) {
    await this.#hostKeys.remove(String(target?.host || ""), target?.port || 22);
  }

  /** Open an interactive PTY. Output is pushed to the renderer as it arrives. */
  async openShell(target, credential, size = { cols: 100, rows: 30 }) {
    const client = await this.#connect(target, credential);
    const sessionId = randomUUID();

    const stream = await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        client.removeListener("error", fail);
        client.removeListener("close", closed);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(friendly(err)));
        client.destroy();
      };
      const closed = () => fail(new Error("SSH 连接已中断，终端未打开"));
      client.once("error", fail);
      client.once("close", closed);
      try {
        client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (err, s) => {
          if (err) return fail(err);
          if (settled) {
            s.on("error", () => {});
            s.end();
            return;
          }
          settled = true;
          cleanup();
          resolve(s);
        });
      } catch (err) {
        fail(err);
      }
    });

    stream.on("data", (chunk) =>
      this.#emit("ssh:data", { sessionId, chunk: chunk.toString("utf8") }),
    );
    stream.stderr?.on("data", (chunk) =>
      this.#emit("ssh:data", { sessionId, chunk: chunk.toString("utf8") }),
    );
    stream.on("error", (err) => {
      this.#emit("ssh:data", { sessionId, chunk: `\r\n${friendly(err)}\r\n` });
      client.destroy();
    });
    stream.on("close", () => {
      this.#sessions.delete(sessionId);
      client.end();
      this.#emit("ssh:exit", { sessionId });
    });
    client.on("error", (err) =>
      this.#emit("ssh:data", { sessionId, chunk: `\r\n\x1b[31m${friendly(err)}\x1b[0m\r\n` }),
    );

    this.#sessions.set(sessionId, { client, stream, serverId: target.id });
    return { sessionId };
  }

  write(sessionId, data) {
    this.#sessions.get(sessionId)?.stream.write(data);
  }

  resize(sessionId, cols, rows) {
    this.#sessions.get(sessionId)?.stream.setWindow(rows, cols, 0, 0);
  }

  close(sessionId) {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    this.#sessions.delete(sessionId);
    try {
      s.stream.end();
    } catch {
      /* already gone */
    }
    s.client.end();
  }

  closeAll() {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }

  /** Run the metrics script once and hang up. */
  async probe(target, credential) {
    const client = await this.#connect(target, credential);
    try {
      const out = await this.#exec(client, PROBE_SCRIPT, PROBE_TIMEOUT);
      const base = { ok: true, ...parseProbe(out), at: new Date().toISOString() };
      // 端口与容器是附加信息：在同一条连接上再跑一次只读脚本，失败不影响指标。
      try {
        return {
          ...base,
          services: parseServices(await this.#exec(client, SERVICES_SCRIPT, SERVICES_TIMEOUT)),
        };
      } catch {
        return base;
      }
    } finally {
      client.end();
    }
  }

  /** Authenticate, run `true`, hang up — used by the credential form. */
  async test(target, credential) {
    const client = await this.#connect(target, credential);
    try {
      const who = await this.#exec(client, "id -un 2>/dev/null || whoami", 10_000);
      return { ok: true, message: `已连接，登录为 ${who.trim() || target.username}` };
    } finally {
      client.end();
    }
  }

  #exec(client, command, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("error", fail);
        client.removeListener("close", closed);
        if (err) reject(new Error(friendly(err)));
        else resolve(value);
      };
      const fail = (err) => finish(err);
      const closed = () => finish(new Error("SSH 连接已中断，命令未完成"));
      const timer = setTimeout(() => finish(new Error("命令执行超时")), timeout);
      client.once("error", fail);
      client.once("close", closed);
      try {
        client.exec(command, (err, stream) => {
          if (err) return finish(err);
          stream.on("error", fail);
          if (settled) {
            stream.end();
            return;
          }
          let out = "";
          stream.on("data", (d) => (out += d.toString("utf8")));
          stream.stderr.on("data", () => {});
          stream.on("close", () => finish(null, out));
        });
      } catch (err) {
        finish(err);
      }
    });
  }
}

function parseProbe(text) {
  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const num = (k) => {
    const n = Number(kv[k]);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    os: kv.os || undefined,
    hostname: kv.host || undefined,
    kernel: kv.kernel || undefined,
    cpu: clampPct(num("cpu")),
    memory: clampPct(num("memory")),
    disk: clampPct(num("disk")),
    uptimeSeconds: num("uptime"),
    memTotalKb: num("memTotalKb"),
    diskTotalKb: num("diskTotalKb"),
    loadavg: kv.loadavg || undefined,
  };
}

function clampPct(n) {
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** ssh2 errors are terse and English; say what actually went wrong. */
function friendly(err) {
  const msg = String(err?.message ?? err);
  if (/All configured authentication methods failed/i.test(msg))
    return "认证失败：用户名、密码或私钥不正确";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝：目标端口没有 SSH 服务";
  if (/ETIMEDOUT|Timed out while waiting/i.test(msg)) return "连接超时：主机不可达或被防火墙拦截";
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "无法解析主机名";
  if (/ECONNRESET/i.test(msg)) return "连接被重置";
  // What a DNS wildcard or a captive proxy looks like: the socket opens, then
  // dies before SSH says hello.
  if (/Connection lost before handshake/i.test(msg))
    return "对端未完成 SSH 握手：地址或端口可能不对";
  if (/Handshake failed/i.test(msg)) return "SSH 握手失败：双方没有共同的加密算法";
  if (/Host denied \(verification failed\)/i.test(msg)) return "主机指纹校验失败，连接已拒绝";
  if (/Cannot parse privateKey|no matching key format/i.test(msg))
    return "私钥格式无法解析（若有口令请一并填写）";
  if (/Encrypted private key detected|passphrase/i.test(msg)) return "私钥已加密，需要填写口令";
  return msg;
}
