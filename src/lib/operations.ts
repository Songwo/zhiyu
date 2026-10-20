import { phoneExpiry } from "../../electron/services/phone-numbers.mjs";
import { extraExpiryCandidates } from "../../electron/services/renewals.mjs";
import { serverNeedsAttention } from "./server-observation.mjs";
import type { AssetKind, Snapshot } from "./types.ts";
import { t } from "./i18n.ts";
import { parseTags } from "./tags.ts";

export interface AssetRef {
  kind: AssetKind;
  id: string;
}
export interface AssetLink {
  from: AssetRef;
  to: AssetRef;
}
export interface AssetEntry extends AssetRef {
  label: string;
}

export function updateAssetTags(
  snapshot: Snapshot,
  refs: AssetRef[],
  raw: string,
  mode: "add" | "remove",
): Snapshot {
  const selected = new Set(refs.map(refKey));
  const tags = parseTags(raw);
  const update = <T extends { id: string; tags: string[] }>(kind: AssetKind, items: T[]): T[] =>
    items.map((item) =>
      !selected.has(refKey({ kind, id: item.id }))
        ? item
        : {
            ...item,
            tags:
              mode === "add"
                ? [...new Set([...(item.tags ?? []), ...tags])]
                : (item.tags ?? []).filter((tag) => !tags.includes(tag)),
          },
    );
  return {
    ...snapshot,
    servers: update("server", snapshot.servers),
    domains: update("domain", snapshot.domains),
    mailboxes: update("mail", snapshot.mailboxes),
    aiAssets: update("ai", snapshot.aiAssets),
    secrets: update("secret", snapshot.secrets),
    certs: update("cert", snapshot.certs),
    services: update("service", snapshot.services ?? []),
  };
}

export function assetEntries(s: Snapshot): AssetEntry[] {
  return [
    ...s.servers.map((x) => ({ kind: "server" as const, id: x.id, label: x.name })),
    ...s.domains.map((x) => ({ kind: "domain" as const, id: x.id, label: x.name })),
    ...s.mailboxes.map((x) => ({ kind: "mail" as const, id: x.id, label: x.address })),
    ...s.aiAssets.map((x) => ({ kind: "ai" as const, id: x.id, label: x.name })),
    ...s.secrets.map((x) => ({ kind: "secret" as const, id: x.id, label: x.name })),
    ...s.certs.map((x) => ({ kind: "cert" as const, id: x.id, label: x.cn })),
    ...(s.services ?? []).map((x) => ({ kind: "service" as const, id: x.id, label: x.name })),
  ];
}

export function refKey(ref: AssetRef): string {
  return JSON.stringify([ref.kind, ref.id]);
}

export function normalizeLinks(value: unknown, snapshot: Snapshot): AssetLink[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(assetEntries(snapshot).map(refKey));
  const seen = new Set<string>();
  return value
    .filter((link): link is AssetLink => {
      if (!link || !link.from || !link.to) return false;
      const from = refKey(link.from),
        to = refKey(link.to);
      const key = [from, to].sort().join("\n");
      if (from === to || !known.has(from) || !known.has(to) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ from, to }) => ({
      from: { kind: from.kind, id: from.id },
      to: { kind: to.kind, id: to.id },
    }));
}

export interface CalendarItem {
  id: string;
  date: string;
  title: string;
  detail: string;
}

// 无到期日的告警放在导出当天；固定 UID 便于日历再次导入时识别同一事项。
export function calendarItems(s: Snapshot, now = new Date()): CalendarItem[] {
  const today = now.toISOString().slice(0, 10);
  const out: CalendarItem[] = [];
  const add = (kind: string, id: string, title: string, date: string, detail: string) => {
    if (!Number.isFinite(Date.parse(date))) return;
    out.push({ id: `${kind}:${id}`, date: date.slice(0, 10), title, detail });
  };
  for (const record of s.phoneNumbers ?? []) {
    const expiry = phoneExpiry(record.expiresAt, now);
    if (expiry.days !== null && expiry.days <= 30)
      add(
        "phone",
        record.id,
        record.label || record.number,
        record.expiresAt,
        t("号码到期，请确认续费与关联订阅"),
      );
  }
  for (const x of s.servers)
    if (serverNeedsAttention(x)) add("server", x.id, x.name, today, t("主机异常"));
  for (const x of s.services ?? [])
    if (x.status !== "online") add("service", x.id, x.name, today, t("手动记录状态"));
  for (const x of s.mailboxes)
    if (x.status !== "online") add("mail", x.id, x.address, today, t("投递异常"));
  for (const x of s.secrets)
    if (x.status !== "online") add("secret", x.id, x.name, today, t("建议轮换"));
  for (const [kind, entries] of [
    ["domain", s.domains],
    ["cert", s.certs],
    ["ai", s.aiAssets],
  ] as const) {
    for (const x of entries) {
      const date = "renewsAt" in x ? x.renewsAt : x.expiresAt;
      const due = Date.parse(date) <= now.getTime() + 21 * 86_400_000;
      if (x.status !== "online" || due)
        add(
          kind,
          x.id,
          "cn" in x ? x.cn : x.name,
          Number.isFinite(Date.parse(date)) ? date : today,
          t("需要留意"),
        );
    }
  }
  // VPS 与服务资产的到期日与 AI 订阅相同，提前 21 天进入提醒；id 与异常提醒区分开。
  for (const x of extraExpiryCandidates(s, now))
    add(
      `${x.kind}-expiry`,
      x.id,
      x.name,
      x.date,
      t(x.kind === "server" ? "服务器到期，请确认续费" : "服务到期，请确认续费"),
    );
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const escapeIcs = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let part = "",
    bytes = 0;
  for (const c of line) {
    const size = encoder.encode(c).length;
    if (bytes + size > 75) {
      lines.push(part);
      part = " ";
      bytes = 1;
    }
    part += c;
    bytes += size;
  }
  lines.push(part);
  return lines.join("\r\n");
}

export function createCalendar(items: CalendarItem[], now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zhiyu//Asset reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const item of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date))) continue;
    const end = new Date(`${item.date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${encodeURIComponent(item.id)}@nanpad.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${item.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replace(/-/g, "")}`,
      `SUMMARY:${escapeIcs(item.title)}`,
      `DESCRIPTION:${escapeIcs(item.detail)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  return [...lines, "END:VCALENDAR"].map(foldLine).join("\r\n") + "\r\n";
}
