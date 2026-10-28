/**
 * ZSP（Zhiyu Sync Protocol）v1 的密码学部分，桌面端与网页版服务器共用。
 * 协议说明、威胁模型和参数见 docs/SYNC.md；这里只做原语的组合，不接触网络与文件。
 *
 * 构件：ristretto255 上的 CPace 风格 PAKE（配对）、Ed25519 签名（身份）、X25519（会话临时密钥）、
 * HKDF-SHA256、HMAC-SHA256、AES-256-GCM。所有输入都当作不可信，格式不对一律抛出 ZspError。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";

export class ZspError extends Error {
  constructor(message, code = "protocol") {
    super(message);
    this.name = "ZspError";
    this.code = code;
  }
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const POINT = ristretto255.Point;
const ORDER = POINT.Fn.ORDER;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 10;
export const MAX_COUNTER = 2 ** 32;

/** 长度前缀拼接：不同字段不会拼出相同字节串。 */
export function lp(...parts) {
  const chunks = [];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    chunks.push(size, bytes);
  }
  return Buffer.concat(chunks);
}
export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
export function unb64u(value, length, label = "字段") {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length > 96 * 1024 * 1024
  )
    throw new ZspError(`${label}格式不正确`);
  const bytes = Buffer.from(value, "base64url");
  if (length !== undefined && bytes.length !== length) throw new ZspError(`${label}长度不正确`);
  return bytes;
}
export const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
export function equalBytes(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ———— 配对码 ————

/** 50 位熵的一次性配对码，返回规范形式（10 个字符）。 */
export function generatePairCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CROCKFORD[byte & 31]; // 取低 5 位，均匀
  return code;
}
export const formatPairCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;
/** 接受用户手输的形式：忽略大小写、空格和连字符，I/L 视为 1，O 视为 0。 */
export function normalizePairCode(input) {
  const text = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (text.length !== CODE_LENGTH || [...text].some((c) => !CROCKFORD.includes(c)))
    throw new ZspError("配对码格式不正确");
  return text;
}

// ———— PAKE（CPace 风格，ristretto255） ————

function generator(code, sid) {
  return ristretto255_hasher.hashToCurve(lp(code, sid, "ZSP1 pairing"), {
    DST: "ZSP1-CPace-ristretto255-v1",
  });
}
function randomScalar() {
  // 64 字节取模，偏差可忽略；范围 [1, ORDER-1]。
  const value = BigInt("0x" + randomBytes(64).toString("hex")) % (ORDER - 1n);
  return value + 1n;
}
function decodePoint(bytes, label) {
  let point;
  try {
    point = POINT.fromBytes(bytes);
  } catch {
    throw new ZspError(`${label}不是有效的点`);
  }
  // ristretto255 里全零字节解码为单位元，必须显式拒绝（小阶点攻击）。
  if (point.is0()) throw new ZspError(`${label}无效`);
  return point;
}
function pairKeys(shared, sid, Ya, Yb) {
  const isk = hkdf(shared, lp(sid, Ya, Yb), "ZSP1 pair isk", 32);
  const okm = hkdf(isk, Buffer.alloc(0), "ZSP1 pair keys", 128);
  return {
    kS: okm.subarray(0, 32),
    kC: okm.subarray(32, 64),
    kEncC2S: okm.subarray(64, 96),
    kEncS2C: okm.subarray(96, 128),
  };
}
export const pairTag = (key, role, sid, Ya, Yb) => hmac(key, lp(role, sid, Ya, Yb));

/** 发起方（桌面）：第一步，生成 Ya。 */
export function pairInitiate(code, sid) {
  const g = generator(normalizePairCode(code), sid);
  const ya = randomScalar();
  const Ya = Buffer.from(g.multiply(ya).toBytes());
  return {
    Ya,
    /** 收到 Yb 后算出会话密钥；之后必须先验证服务器的 tagS 再发 tagC。 */
    finish(YbBytes) {
      const Yb = Buffer.from(YbBytes);
      const shared = Buffer.from(decodePoint(Yb, "服务器的点").multiply(ya).toBytes());
      if (shared.every((b) => b === 0)) throw new ZspError("配对失败");
      return { Yb, ...pairKeys(shared, sid, Ya, Yb) };
    },
  };
}
/** 响应方（服务器）：收到 Ya，返回 Yb 与密钥。 */
export function pairRespond(code, sid, YaBytes) {
  const Ya = Buffer.from(YaBytes);
  const peer = decodePoint(Ya, "桌面端的点");
  const g = generator(normalizePairCode(code), sid);
  const yb = randomScalar();
  const Yb = Buffer.from(g.multiply(yb).toBytes());
  const shared = Buffer.from(peer.multiply(yb).toBytes());
  if (shared.every((b) => b === 0)) throw new ZspError("配对失败");
  return { Ya, Yb, ...pairKeys(shared, sid, Ya, Yb) };
}

// ———— 身份（Ed25519）与临时密钥（X25519） ————

const rawPublic = (keyObject, prefix) =>
  Buffer.from(keyObject.export({ type: "spki", format: "der" })).subarray(prefix.length);
export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: rawPublic(publicKey, SPKI_ED25519), privateKey };
}
export const exportIdentity = (identity) =>
  Buffer.from(identity.privateKey.export({ type: "pkcs8", format: "der" }));
export function importIdentity(der) {
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(der), type: "pkcs8", format: "der" });
  } catch {
    throw new ZspError("身份密钥无法读取");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new ZspError("身份密钥类型不正确");
  return {
    privateKey,
    publicKey: rawPublic(createPublicKey(privateKey), SPKI_ED25519),
  };
}
const edPublic = (raw) => {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new ZspError("公钥长度不正确");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), type: "spki", format: "der" });
};
export const signWith = (identity, message) => edSign(null, message, identity.privateKey);
export function verifyWith(publicKey, message, signature) {
  try {
    return signature.length === 64 && edVerify(null, message, edPublic(publicKey), signature);
  } catch {
    return false;
  }
}
/** 公钥指纹：SHA-256 的前 16 字节，四位一组，便于肉眼核对。 */
export const fingerprint = (publicKey) =>
  sha256("ZSP1 fingerprint", publicKey)
    .subarray(0, 16)
    .toString("hex")
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1 ");
export const deviceIdOf = (publicKey) =>
  sha256("ZSP1 device", publicKey).subarray(0, 16).toString("hex");

function ephemeral() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: rawPublic(publicKey, SPKI_X25519), privateKey };
}
function agree(privateKey, peerRaw) {
  if (!Buffer.isBuffer(peerRaw) || peerRaw.length !== 32) throw new ZspError("临时公钥长度不正确");
  let shared;
  try {
    shared = Buffer.from(
      diffieHellman({
        privateKey,
        publicKey: createPublicKey({
          key: Buffer.concat([SPKI_X25519, peerRaw]),
          type: "spki",
          format: "der",
        }),
      }),
    );
  } catch {
    // 低阶点等无效公钥会让底层直接报错，统一成协议错误。
    throw new ZspError("临时公钥无效");
  }
  if (shared.every((b) => b === 0)) throw new ZspError("临时公钥无效");
  return shared;
}

// ———— 加密通道（AES-256-GCM，方向分离、计数器严格递增） ————

export class SecureChannel {
  #send;
  #recv;
  #th;
  #role;
  #sendCounter = 0;
  #recvCounter = 0;
  constructor({ sendKey, recvKey, th, role }) {
    this.#send = sendKey;
    this.#recv = recvKey;
    this.#th = th;
    this.#role = role;
  }
  static #iv(counter) {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(BigInt(counter), 4);
    return iv;
  }
  #aad(direction, counter) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(counter));
    return lp(this.#th, direction, bytes);
  }
  get sendCounter() {
    return this.#sendCounter;
  }
  get receiveCounter() {
    return this.#recvCounter;
  }
  /** 加密一条消息，返回计数器与密文（含 16 字节标签）。 */
  seal(plaintext) {
    if (this.#sendCounter >= MAX_COUNTER) throw new ZspError("会话消息数已达上限");
    const counter = this.#sendCounter++;
    const cipher = createCipheriv("aes-256-gcm", this.#send, SecureChannel.#iv(counter));
    cipher.setAAD(this.#aad(this.#role === "client" ? "c2s" : "s2c", counter));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { counter, data: Buffer.concat([body, cipher.getAuthTag()]) };
  }
  /** 只接受下一个期望的计数器；重放、乱序、篡改都会抛错，且不推进计数。 */
  open(counter, data) {
    if (!Number.isSafeInteger(counter) || counter !== this.#recvCounter)
      throw new ZspError("消息序号不正确", "replay");
    if (!Buffer.isBuffer(data) || data.length < 16) throw new ZspError("消息格式不正确");
    const decipher = createDecipheriv("aes-256-gcm", this.#recv, SecureChannel.#iv(counter));
    decipher.setAAD(this.#aad(this.#role === "client" ? "s2c" : "c2s", counter));
    decipher.setAuthTag(data.subarray(data.length - 16));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    } catch {
      throw new ZspError("消息认证失败", "auth");
    }
    this.#recvCounter += 1;
    return plaintext;
  }
}

/** 配对阶段在 PAKE 密钥下传递身份用的两个单向通道。 */
export function pairChannel(keys, role, sid, Ya, Yb) {
  const th = sha256(lp("ZSP1-PAIR-CHANNEL", sid, Ya, Yb));
  return role === "client"
    ? new SecureChannel({ sendKey: keys.kEncC2S, recvKey: keys.kEncS2C, th, role })
    : new SecureChannel({ sendKey: keys.kEncS2C, recvKey: keys.kEncC2S, th, role });
}
export const pairDeviceMessage = (sid, Ya, Yb, devicePub) =>
  lp("ZSP1-PAIR-DEV", sid, Ya, Yb, devicePub);
export const pairServerMessage = (sid, Ya, Yb, serverPub, devicePub) =>
  lp("ZSP1-PAIR-SRV", sid, Ya, Yb, serverPub, devicePub);

// ———— 会话握手（SIGMA 风格） ————

const sessionTranscript = (deviceId, epkC, nC, epkS, nS, serverPub, devicePub) =>
  sha256(lp("ZSP1-SESSION", deviceId, epkC, nC, epkS, nS, serverPub, devicePub));
function sessionKeys(shared, th) {
  const okm = hkdf(shared, th, "ZSP1 session keys", 64);
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

/** 桌面：发起会话。 */
export function sessionClientStart(deviceId) {
  const eph = ephemeral();
  const nonce = randomBytes(32);
  return {
    message: { dev: deviceId, epk: b64u(eph.publicKey), nc: b64u(nonce) },
    eph,
    nonce,
    deviceId,
  };
}
/** 服务器：回应会话请求。`device` 由调用方在服务器登记里查出（含公钥）。 */
export function sessionServerRespond({ message, device, serverIdentity }) {
  const epkC = unb64u(message?.epk, 32, "临时公钥");
  const nC = unb64u(message?.nc, 32, "随机数");
  const eph = ephemeral();
  const nS = randomBytes(32);
  const th = sessionTranscript(
    device.id,
    epkC,
    nC,
    eph.publicKey,
    nS,
    serverIdentity.publicKey,
    device.publicKey,
  );
  const keys = sessionKeys(agree(eph.privateKey, epkC), th);
  const sigS = signWith(serverIdentity, lp("ZSP1-SRV-SIG", th));
  return {
    reply: { epk: b64u(eph.publicKey), ns: b64u(nS), sig: b64u(sigS) },
    state: { th, keys, sigS, devicePub: device.publicKey },
  };
}
/** 桌面：验证服务器、派生密钥，并产出带身份签名的认证消息。 */
export function sessionClientFinish({ start, reply, serverPublicKey, deviceIdentity }) {
  const epkS = unb64u(reply?.epk, 32, "临时公钥");
  const nS = unb64u(reply?.ns, 32, "随机数");
  const sigS = unb64u(reply?.sig, 64, "签名");
  const th = sessionTranscript(
    start.deviceId,
    start.eph.publicKey,
    start.nonce,
    epkS,
    nS,
    serverPublicKey,
    deviceIdentity.publicKey,
  );
  if (!verifyWith(serverPublicKey, lp("ZSP1-SRV-SIG", th), sigS))
    throw new ZspError("服务器身份验证失败：公钥与配对时不一致", "server-identity");
  const keys = sessionKeys(agree(start.eph.privateKey, epkS), th);
  const channel = new SecureChannel({ sendKey: keys.c2s, recvKey: keys.s2c, th, role: "client" });
  const sigC = signWith(deviceIdentity, lp("ZSP1-DEV-SIG", th, sigS));
  return { channel, auth: channel.seal(sigC) };
}
/** 服务器：验证设备签名，成功后返回服务器侧通道。 */
export function sessionServerVerify({ state, auth }) {
  const channel = new SecureChannel({
    sendKey: state.keys.s2c,
    recvKey: state.keys.c2s,
    th: state.th,
    role: "server",
  });
  const sigC = channel.open(auth.counter, auth.data);
  if (!verifyWith(state.devicePub, lp("ZSP1-DEV-SIG", state.th, state.sigS), sigC))
    throw new ZspError("设备身份验证失败", "device-identity");
  return channel;
}

// ———— 清单签名（回滚与分叉检测） ————

export const manifestDigest = (files) =>
  sha256(
    lp(
      "ZSP1-MANIFEST",
      ...Object.keys(files)
        .sort()
        .flatMap((path) => [path, files[path].h]),
    ),
  );
export const signManifest = (identity, seq, digest) =>
  signWith(identity, lp("ZSP1-MANIFEST-SIG", String(seq), digest));
export const verifyManifest = (publicKey, seq, digest, signature) =>
  verifyWith(publicKey, lp("ZSP1-MANIFEST-SIG", String(seq), digest), signature);
