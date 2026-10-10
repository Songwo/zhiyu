import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  MAX_SUBSCRIPTION_BYTES,
  MAX_SUBSCRIPTION_NODES,
  parseSubscriptionNodes,
} from "./subscription-parser.mjs";

const b64 = (value) => Buffer.from(value).toString("base64");
test("YAML 别名不能通过端口类型转换导致指数级展开", () => {
  const lines = ["a0: &a0 [443]"];
  for (let index = 1; index <= 25; index++)
    lines.push(`a${index}: &a${index} [*a${index - 1}, *a${index - 1}]`);
  lines.push(
    "proxies:\n  - name: test\n    type: ss\n    server: node.example.test\n    port: *a25",
  );
  const source = `import { readFileSync } from 'node:fs'; import { parseSubscriptionNodes } from ${JSON.stringify(import.meta.resolve("./subscription-parser.mjs"))}; const result=parseSubscriptionNodes(readFileSync(0,'utf8')); if(result.nodes.length!==0) process.exit(2);`;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", source],
    {
      input: lines.join("\n"),
      timeout: 2500,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8192,
    },
  );
  assert.equal(result.error, undefined, "恶意端口必须迅速拒绝，不能等待类型转换");
  assert.equal(result.status, 0, "数组端口必须拒绝且不能耗尽内存");
});
const uris = [
  "vless://synthetic-credential@node.example.test:443#%E9%A6%99%E6%B8%AF%2001",
  "trojan://synthetic-password@[2001:db8::1]:443#IPv6",
  `ss://${b64("aes-256-gcm:synthetic-password@ss.example.test:8443")}#SS`,
  `vmess://${b64(JSON.stringify({ add: "vmess.example.test", port: "443", ps: "东京", id: "synthetic-uuid" }))}`,
  "hysteria2://synthetic-hy-password@hy.example.test:443?obfs=salamander&obfs-password=synthetic-obfs#HY2",
];
test("URI 和 Base64 订阅解析中文、IPv6、VMess 与旧 SS，不返回认证字段", () => {
  for (const [body, format] of [
    [uris.join("\n"), "uri"],
    [b64(uris.join("\n")), "base64"],
  ]) {
    const result = parseSubscriptionNodes(body);
    assert.equal(result.format, format);
    assert.equal(result.nodes.length, 5);
    assert.equal(result.nodes[0].name, "香港 01");
    assert.equal(result.nodes[1].host, "2001:db8::1");
    assert.equal(result.nodes[3].name, "东京");
    assert.equal(new Set(result.nodes.map((node) => node.id)).size, 5);
    assert.equal(JSON.stringify(result).includes("synthetic-"), false);
    for (const node of result.nodes)
      assert.deepEqual(Object.keys(node).sort(), ["host", "id", "name", "port", "protocol"]);
  }
});
test("Clash YAML 仅输出叶节点元信息，组和认证参数不进入结果", () => {
  const result = parseSubscriptionNodes(
    `proxies:\n  - name: 香港\n    type: ss\n    server: hk.example.test\n    port: 443\n    cipher: aes-128-gcm\n    password: synthetic-clash-password\n  - name: 日本\n    type: hysteria2\n    server: jp.example.test\n    port: 8443\n    password: synthetic-hy-password\nproxy-groups:\n  - name: 自动选择\n    type: select\n    proxies: [香港, 日本]\n`,
  );
  assert.equal(result.format, "clash");
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[1].protocol, "hysteria2");
  assert.equal(JSON.stringify(result).includes("synthetic-"), false);
});
test("sing-box JSON 忽略路由组，保留节点名称协议地址", () => {
  const result = parseSubscriptionNodes(
    JSON.stringify({
      outbounds: [
        { type: "selector", tag: "proxy", outbounds: ["节点"] },
        {
          type: "vless",
          tag: "节点",
          server: "node.example.test",
          server_port: 8443,
          uuid: "synthetic-private-uuid",
        },
        { type: "direct", tag: "direct" },
      ],
    }),
  );
  assert.equal(result.format, "sing-box");
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].port, 8443);
  assert.equal(JSON.stringify(result).includes("synthetic-"), false);
});
test("同名同地址的两个配置保留为两条节点，不凭元信息误合并", () => {
  const result = parseSubscriptionNodes(
    uris[0] + "\n" + uris[0].replace("synthetic-credential", "another-credential"),
  );
  assert.equal(result.nodes.length, 2);
  assert.notEqual(result.nodes[0].id, result.nodes[1].id);
});
test("拒绝无效端口、缺失地址、HTML、解析异常，不把原文带进错误", () => {
  for (const body of [
    "<html>synthetic-private-secret</html>",
    "proxies: [invalid",
    "proxies:\n- name: bad\n  type: ss\n  server: host\n  port: 70000",
    "vless://secret@host:0#bad",
  ]) {
    const result = parseSubscriptionNodes(body);
    assert.equal(result.nodes.length, 0);
    assert.ok(result.nodesMessage);
    assert.equal(JSON.stringify(result).includes("synthetic-private-secret"), false);
  }
});
test("正文与节点数量有上限，YAML 自引用不触发无限递归", () => {
  assert.throws(() => parseSubscriptionNodes("x".repeat(MAX_SUBSCRIPTION_BYTES + 1)), /2 MiB/);
  const many = parseSubscriptionNodes(
    Array.from({ length: MAX_SUBSCRIPTION_NODES + 3 }, (_, i) => uris[0] + i).join("\n"),
  );
  assert.equal(many.nodes.length, MAX_SUBSCRIPTION_NODES);
  assert.equal(many.truncated, true);
  const cyclic = parseSubscriptionNodes("proxies: &loop [*loop]");
  assert.equal(cyclic.nodes.length, 0);
});
