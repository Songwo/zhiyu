import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeLinks,
  createCalendar,
  calendarItems,
  updateAssetTags,
  type AssetRef,
} from "./operations.ts";
import type { Snapshot } from "./types.ts";

const empty: Snapshot = {
  servers: [],
  domains: [],
  certs: [],
  mailboxes: [],
  aiAssets: [],
  secrets: [],
};
test("批量标签只修改选中资产，保留其他字段与未选中记录，不污染原快照", () => {
  const snapshot = {
    ...empty,
    servers: [{ id: "same", name: "host", tags: ["生产"], host: "example.test" }],
    domains: [{ id: "same", name: "site", tags: ["域名"] }],
  } as Snapshot;
  const refs: AssetRef[] = [
    { kind: "server", id: "same" },
    { kind: "cert", id: "missing" },
  ];
  const added = updateAssetTags(snapshot, refs, "生产，项目 A;重点", "add");
  assert.deepEqual(added.servers[0].tags, ["生产", "项目 A", "重点"]);
  assert.equal(added.servers[0].host, "example.test");
  assert.equal(added.domains[0], snapshot.domains[0]);
  assert.deepEqual(snapshot.servers[0].tags, ["生产"]);
  assert.deepEqual(updateAssetTags(added, refs, "生产;重点", "remove").servers[0].tags, ["项目 A"]);
});
test("关联去重、自关联和悬空引用被清除，同 ID 不同种类不混淆", () => {
  const from: AssetRef = { kind: "server", id: "same" },
    to: AssetRef = { kind: "domain", id: "same" };
  const snapshot = {
    ...empty,
    servers: [{ id: "same", name: "host" }],
    domains: [{ id: "same", name: "site" }],
  } as Snapshot;
  assert.deepEqual(
    normalizeLinks(
      [
        { from, to },
        { from: to, to: from },
        { from, to: from },
        { from, to: { kind: "cert", id: "missing" } },
        null,
      ],
      snapshot,
    ),
    [{ from, to }],
  );
  assert.deepEqual(normalizeLinks([{ from, to }], empty), []);
  assert.deepEqual(
    normalizeLinks(
      [{ from: { ...from, origin: { x: 10 } }, to: { ...to, label: "界面名称" } }],
      snapshot,
    ),
    [{ from, to }],
  );
});
test("日历遵循 CRLF、全天结束日和 UTF-8 75 字节折行", () => {
  const title = "生产域名，证书;".repeat(25) + "\nBEGIN:VEVENT";
  const result = createCalendar(
    [{ id: "domain:1", date: "2026-12-31", title, detail: "Check\\renew\nnow" }],
    new Date("2026-09-07T00:00:00Z"),
  );
  assert.ok(result.includes("DTEND;VALUE=DATE:20270101\r\n"));
  assert.ok(result.includes("UID:domain%3A1@nanpad.local"));
  for (const line of result.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(result.split("\r\nBEGIN:VEVENT\r\n").length, 2);
  assert.ok(result.replace(/\r\n /g, "").includes("\\nBEGIN:VEVENT"));
});
test("正常状态但即将到期的资产仍导出，不导出备注和凭据", () => {
  const now = new Date("2026-09-07T00:00:00Z");
  const snapshot = {
    ...empty,
    domains: [
      {
        id: "d1",
        name: "example.com",
        expiresAt: "2026-09-10",
        status: "online",
        notes: "private password",
      },
      { id: "d2", name: "later", expiresAt: "2027-01-01", status: "online" },
    ],
  } as Snapshot;
  const items = calendarItems(snapshot, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, "2026-09-10");
  assert.ok(!createCalendar(items, now).includes("private password"));
});

test("号码日历以本地日期筛选30天窗口，不输出号码备注或关联信息", () => {
  const snapshot = {
    ...empty,
    phoneNumbers: [
      {
        id: "today",
        number: "+1 555 0100",
        label: "续费号码",
        expiresAt: "2026-09-30",
        notes: "private phone note",
        subscriptionIds: ["private-linked-ai"],
      },
      { id: "later", number: "+1 555 0101", expiresAt: "2026-10-31" },
      { id: "unknown", number: "+1 555 0102", expiresAt: "" },
    ],
  } as Snapshot;
  const items = calendarItems(snapshot, new Date(2026, 8, 30, 0, 30));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "phone:today");
  assert.equal(items[0].date, "2026-09-30");
  assert.ok(!JSON.stringify(items).includes("private phone note"));
  assert.ok(!JSON.stringify(items).includes("private-linked-ai"));
});

test("日历导出包含服务器与服务资产的到期日，且与主机异常提醒不冲突", () => {
  const snapshot = {
    ...empty,
    servers: [
      {
        id: "vps",
        name: "东京 VPS",
        host: "203.0.113.5",
        status: "online",
        cpu: 1,
        memory: 1,
        expiresAt: "2026-10-30",
      },
      { id: "far", name: "far", status: "online", cpu: 1, memory: 1, expiresAt: "2027-03-01" },
    ],
    services: [{ id: "img", name: "图床", status: "online", expiresAt: "2026-10-22" }],
  } as unknown as Snapshot;
  const items = calendarItems(snapshot, new Date(2026, 9, 20, 9));
  assert.deepEqual(
    items.map((x) => [x.id, x.date]),
    [
      ["service-expiry:img", "2026-10-22"],
      ["server-expiry:vps", "2026-10-30"],
    ],
  );
  assert.ok(createCalendar(items).includes("SUMMARY:东京 VPS"));
});
