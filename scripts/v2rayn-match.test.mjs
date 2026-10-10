import test from "node:test";
import assert from "node:assert/strict";
import { matchV2raynNodes } from "../src/lib/v2rayn-match.mjs";

const node = (id, name = "节点", extra = {}) => ({
  id,
  name,
  protocol: "vless",
  host: "a.example.test",
  port: 443,
  ...extra,
});

test("等价 IPv6 展开和压缩地址可匹配", () => {
  const clients = [node("a", "IPv6", { host: "2001:0db8:0000:0000:0000:0000:0000:0001" })];
  const subscriptions = [node("s", "IPv6", { host: "[2001:db8::1]" })];
  assert.equal(matchV2raynNodes(clients, subscriptions).length, 1);
});

test("客户端节点只按主机端口协议匹配，不按显示名称猜测", () => {
  const input = [node("subscription-a")];
  const clients = [
    node("a"),
    node("wrong-protocol", "节点", { protocol: "trojan" }),
    node("wrong-port", "节点", { port: 8443 }),
    node("wrong-host", "节点", { host: "b.example.test" }),
  ];
  assert.deepEqual(
    matchV2raynNodes(clients, input).map((n) => n.id),
    ["a"],
  );
});
test("多个客户端配置相同目标时保守不匹配，唯一名称可消歧", () => {
  const clients = [node("a", "A"), node("b", "B")];
  assert.deepEqual(matchV2raynNodes(clients, [node("s", "未知")]), []);
  assert.deepEqual(
    matchV2raynNodes(clients, [node("s", "A")]).map((n) => n.id),
    ["a"],
  );
  assert.deepEqual(matchV2raynNodes([node("a", "A"), node("b", "A")], [node("s", "A")]), []);
});
test("多个订阅配置相同目标也不能随意归属，协议别名和主机大小写可规范化", () => {
  assert.deepEqual(matchV2raynNodes([node("a")], [node("s1"), node("s2")]), []);
  const result = matchV2raynNodes(
    [node("a", "A", { protocol: "shadowsocks", host: "A.EXAMPLE.TEST." })],
    [node("s", "A", { protocol: "ss" })],
  );
  assert.equal(result.length, 1);
  assert.deepEqual(
    matchV2raynNodes(
      [node("a", "A", { protocol: "unknown" })],
      [node("s", "A", { protocol: "unknown" })],
    ),
    [],
  );
});
