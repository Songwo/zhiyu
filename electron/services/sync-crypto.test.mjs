import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  SecureChannel,
  ZspError,
  b64u,
  deviceIdOf,
  exportIdentity,
  fingerprint,
  formatPairCode,
  generateIdentity,
  generatePairCode,
  importIdentity,
  lp,
  manifestDigest,
  normalizePairCode,
  pairChannel,
  pairInitiate,
  pairRespond,
  pairTag,
  sessionClientFinish,
  sessionClientStart,
  sessionServerRespond,
  sessionServerVerify,
  signManifest,
  signWith,
  verifyManifest,
  verifyWith,
} from "./sync-crypto.mjs";

const sid = () => randomBytes(16);
const same = (a, b) => Buffer.compare(a, b) === 0;

test("长度前缀拼接不会把不同字段拼成同样的字节", () => {
  assert.ok(!same(lp("a", "bc"), lp("ab", "c")));
  assert.ok(!same(lp("a", ""), lp("a")));
});

test("配对码：50 位熵、可手输的多种写法都归一，非法字符拒绝", () => {
  const codes = new Set(Array.from({ length: 200 }, generatePairCode));
  assert.equal(codes.size, 200);
  const code = generatePairCode();
  assert.equal(code.length, 10);
  assert.equal(normalizePairCode(formatPairCode(code).toLowerCase()), code);
  assert.equal(normalizePairCode("  oi1l-00abcd "), "011100ABCD");
  for (const bad of ["", "ABC", "ABCDEFGHIJK", "ABCDE-FGHIU", "U".repeat(10), "ÄBCDE-FGHJK"])
    assert.throws(() => normalizePairCode(bad), ZspError, bad);
});

test("PAKE：配对码一致时双方得到相同密钥，确认标签互相验证", () => {
  const code = generatePairCode();
  const id = sid();
  const client = pairInitiate(code, id);
  const server = pairRespond(code, id, client.Ya);
  const keys = client.finish(server.Yb);
  for (const name of ["kS", "kC", "kEncC2S", "kEncS2C"])
    assert.ok(same(keys[name], server[name]), name);
  assert.ok(
    same(
      pairTag(keys.kS, "S", id, client.Ya, server.Yb),
      pairTag(server.kS, "S", id, client.Ya, server.Yb),
    ),
  );
  assert.ok(!same(keys.kS, keys.kC), "两个方向的确认密钥不同");
});

test("PAKE：配对码不一致时得到完全不同的密钥，标签无法通过", () => {
  const id = sid();
  const client = pairInitiate(generatePairCode(), id);
  const server = pairRespond(generatePairCode(), id, client.Ya);
  const keys = client.finish(server.Yb);
  assert.ok(!same(keys.kS, server.kS));
  assert.ok(
    !same(
      pairTag(keys.kS, "S", id, client.Ya, server.Yb),
      pairTag(server.kS, "S", id, client.Ya, server.Yb),
    ),
  );
});

test("PAKE：sid 与码共同决定密钥，换 sid 就对不上", () => {
  const code = generatePairCode();
  const client = pairInitiate(code, sid());
  const server = pairRespond(code, sid(), client.Ya);
  assert.ok(!same(client.finish(server.Yb).kS, server.kS));
});

test("PAKE：单位元、非法点与篡改的点被拒绝", () => {
  const code = generatePairCode();
  const id = sid();
  assert.throws(() => pairRespond(code, id, Buffer.alloc(32)), ZspError, "全零 = 单位元");
  assert.throws(() => pairRespond(code, id, Buffer.alloc(32, 0xff)), ZspError);
  assert.throws(() => pairRespond(code, id, Buffer.alloc(31)), ZspError);
  const client = pairInitiate(code, id);
  assert.throws(() => client.finish(Buffer.alloc(32)), ZspError);
  assert.throws(() => client.finish(Buffer.alloc(32, 0xff)), ZspError);
  const server = pairRespond(code, id, client.Ya);
  const flipped = Buffer.from(server.Yb);
  flipped[5] ^= 1;
  let rejected = false;
  try {
    rejected = !same(client.finish(flipped).kS, server.kS);
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "改一位的点要么无法解码要么得到不同密钥");
});

test("配对身份交换：在 PAKE 密钥下加密，错误方向与重放被拒绝", () => {
  const code = generatePairCode();
  const id = sid();
  const client = pairInitiate(code, id);
  const server = pairRespond(code, id, client.Ya);
  const keys = client.finish(server.Yb);
  const c = pairChannel(keys, "client", id, client.Ya, server.Yb);
  const s = pairChannel(server, "server", id, client.Ya, server.Yb);
  const sealed = c.seal(Buffer.from("device-pub"));
  assert.equal(s.open(sealed.counter, sealed.data).toString(), "device-pub");
  assert.throws(() => s.open(sealed.counter, sealed.data), /序号/, "重放");
  const back = s.seal(Buffer.from("server-pub"));
  assert.equal(c.open(back.counter, back.data).toString(), "server-pub");
  const reflected = c.seal(Buffer.from("x"));
  assert.throws(
    () => c.open(reflected.counter, reflected.data),
    ZspError,
    "不能把自己发的消息当对方的",
  );
});

test("身份密钥：导出导入后签名一致，别的密钥验不过", () => {
  const identity = generateIdentity();
  const restored = importIdentity(exportIdentity(identity));
  assert.ok(same(restored.publicKey, identity.publicKey));
  const message = Buffer.from("hello");
  const signature = signWith(restored, message);
  assert.ok(verifyWith(identity.publicKey, message, signature));
  assert.ok(!verifyWith(generateIdentity().publicKey, message, signature));
  assert.ok(!verifyWith(identity.publicKey, Buffer.from("hellO"), signature));
  assert.ok(!verifyWith(identity.publicKey, message, Buffer.alloc(64)));
  assert.ok(!verifyWith(Buffer.alloc(5), message, signature));
  assert.throws(() => importIdentity(Buffer.from("garbage")), ZspError);
  assert.match(fingerprint(identity.publicKey), /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  assert.match(deviceIdOf(identity.publicKey), /^[0-9a-f]{32}$/);
});

function handshake({ server = generateIdentity(), device = generateIdentity() } = {}) {
  const record = { id: deviceIdOf(device.publicKey), publicKey: device.publicKey };
  const start = sessionClientStart(record.id);
  const { reply, state } = sessionServerRespond({
    message: start.message,
    device: record,
    serverIdentity: server,
  });
  return { server, device, record, start, reply, state };
}

test("会话：双方认证后建立双向加密通道，消息往返一致", () => {
  const { server, device, start, reply, state } = handshake();
  const client = sessionClientFinish({
    start,
    reply,
    serverPublicKey: server.publicKey,
    deviceIdentity: device,
  });
  const serverChannel = sessionServerVerify({ state, auth: client.auth });
  for (let i = 0; i < 5; i += 1) {
    const request = client.channel.seal(Buffer.from(`req-${i}`));
    assert.equal(serverChannel.open(request.counter, request.data).toString(), `req-${i}`);
    const response = serverChannel.seal(Buffer.from(`res-${i}`));
    assert.equal(client.channel.open(response.counter, response.data).toString(), `res-${i}`);
  }
});

test("会话：服务器公钥与配对时不同（冒充）时桌面端拒绝", () => {
  const { start, reply, device } = handshake();
  assert.throws(
    () =>
      sessionClientFinish({
        start,
        reply,
        serverPublicKey: generateIdentity().publicKey,
        deviceIdentity: device,
      }),
    (error) => error instanceof ZspError && error.code === "server-identity",
  );
});

test("会话：篡改服务器回复里的任何一项都无法通过", () => {
  const { server, device, start, reply } = handshake();
  const flip = (value) => {
    const bytes = Buffer.from(value, "base64url");
    bytes[0] ^= 1;
    return b64u(bytes);
  };
  for (const field of ["epk", "ns", "sig"]) {
    assert.throws(
      () =>
        sessionClientFinish({
          start,
          reply: { ...reply, [field]: flip(reply[field]) },
          serverPublicKey: server.publicKey,
          deviceIdentity: device,
        }),
      ZspError,
      field,
    );
  }
});

test("会话：别的设备冒用已登记设备的 ID，服务器验证签名失败", () => {
  const registered = generateIdentity();
  const attacker = generateIdentity();
  const { server, start, reply, state } = handshake({ device: registered });
  // 攻击者知道设备公钥（所以转录哈希对得上），但没有私钥，只能用自己的私钥签名。
  const forged = sessionClientFinish({
    start,
    reply,
    serverPublicKey: server.publicKey,
    deviceIdentity: { publicKey: registered.publicKey, privateKey: attacker.privateKey },
  });
  assert.throws(
    () => sessionServerVerify({ state, auth: forged.auth }),
    (error) => error instanceof ZspError && error.code === "device-identity",
  );
});

test("会话：重放、乱序、篡改密文都被拒绝，且失败不推进计数", () => {
  const { server, device, start, reply, state } = handshake();
  const client = sessionClientFinish({
    start,
    reply,
    serverPublicKey: server.publicKey,
    deviceIdentity: device,
  });
  const channel = sessionServerVerify({ state, auth: client.auth });
  const first = client.channel.seal(Buffer.from("one"));
  const second = client.channel.seal(Buffer.from("two"));
  assert.throws(() => channel.open(second.counter, second.data), /序号/, "乱序");
  const tampered = Buffer.from(first.data);
  tampered[0] ^= 1;
  assert.throws(() => channel.open(first.counter, tampered), /认证/, "篡改");
  assert.equal(
    channel.open(first.counter, first.data).toString(),
    "one",
    "失败后仍能收到正确的消息",
  );
  assert.throws(() => channel.open(first.counter, first.data), /序号/, "重放");
  assert.equal(channel.open(second.counter, second.data).toString(), "two");
});

test("会话：不同会话的密钥互不相通（前向隔离）", () => {
  const server = generateIdentity();
  const device = generateIdentity();
  const a = handshake({ server, device });
  const b = handshake({ server, device });
  const clientA = sessionClientFinish({
    start: a.start,
    reply: a.reply,
    serverPublicKey: server.publicKey,
    deviceIdentity: device,
  });
  const clientB = sessionClientFinish({
    start: b.start,
    reply: b.reply,
    serverPublicKey: server.publicKey,
    deviceIdentity: device,
  });
  const channelB = sessionServerVerify({ state: b.state, auth: clientB.auth });
  const message = clientA.channel.seal(Buffer.from("secret"));
  assert.throws(() => channelB.open(message.counter + 1, message.data));
  // 计数器对得上时也解不开：密钥不同。
  const probe = new SecureChannel({
    sendKey: randomBytes(32),
    recvKey: randomBytes(32),
    th: randomBytes(32),
    role: "server",
  });
  assert.throws(() => probe.open(0, message.data), ZspError);
});

test("低阶临时公钥被拒绝", () => {
  const server = generateIdentity();
  const device = generateIdentity();
  const record = { id: deviceIdOf(device.publicKey), publicKey: device.publicKey };
  const start = sessionClientStart(record.id);
  assert.throws(
    () =>
      sessionServerRespond({
        message: { ...start.message, epk: b64u(Buffer.alloc(32)) },
        device: record,
        serverIdentity: server,
      }),
    ZspError,
  );
  assert.throws(
    () =>
      sessionServerRespond({
        message: { ...start.message, epk: "短" },
        device: record,
        serverIdentity: server,
      }),
    ZspError,
  );
});

test("清单签名：序号或内容被改动时验证失败", () => {
  const server = generateIdentity();
  const files = { "assets.json": { h: "aa", n: 1 }, "documents/doc-1.json": { h: "bb", n: 2 } };
  const digest = manifestDigest(files);
  const signature = signManifest(server, 7, digest);
  assert.ok(verifyManifest(server.publicKey, 7, digest, signature));
  assert.ok(!verifyManifest(server.publicKey, 6, digest, signature), "序号倒退");
  assert.ok(
    !verifyManifest(
      server.publicKey,
      7,
      manifestDigest({ ...files, "assets.json": { h: "ac", n: 1 } }),
      signature,
    ),
  );
  assert.ok(
    same(
      manifestDigest(files),
      manifestDigest({
        "documents/doc-1.json": { h: "bb", n: 99 },
        "assets.json": { h: "aa", n: 5 },
      }),
    ),
    "与顺序和大小字段无关",
  );
});
