import { resourceRows } from "../src/lib/resource-relations.mjs";
export const RELATION_TIME = "2026-11-06T00:00:00Z";
const phone = (id) => ({
  id,
  number: "+15550000101",
  label: id,
  provider: "test",
  expiresAt: "",
  notes: "",
  subscriptionIds: [],
  createdAt: RELATION_TIME,
  updatedAt: RELATION_TIME,
});
export function universalRelationFixture() {
  const snapshot = {
    servers: [],
    domains: [],
    mailboxes: [],
    aiAssets: [],
    secrets: [],
    certs: [],
    services: [],
    phoneNumbers: [phone("phone-a"), phone("phone-b")],
    links: [],
  };
  const rows = [];
  for (const [kind, collection] of Object.entries({
    server: "servers",
    domain: "domains",
    mail: "mailboxes",
    ai: "aiAssets",
    secret: "secrets",
    cert: "certs",
    service: "services",
  }))
    for (const suffix of ["a", "b"]) {
      const id = kind + "-" + suffix;
      snapshot[collection].push({
        id,
        name: id,
        host: "test.invalid",
        category: "custom",
        provider: "",
        url: "",
        status: "online",
        notes: "",
        tags: [],
      });
      rows.push({ kind, id, name: id, detail: "", status: "online", tags: [], search: id });
    }
  for (const kind of ["payment", "esim", "custom"]) {
    const id = "card-" + kind;
    snapshot.services.push({
      id,
      name: id,
      provider: "",
      url: "",
      category: "custom",
      status: "online",
      notes: "",
      tags: [],
      ...(kind !== "custom" ? { card: { kind } } : {}),
    });
    rows.push({
      kind: "service",
      id,
      name: id,
      detail: "",
      status: "online",
      tags: [],
      search: id,
    });
  }
  for (const server of snapshot.servers)
    server.nodes = [
      {
        id: "same-node",
        name: server.id + "-node",
        protocol: "vless",
        host: "private.invalid",
        port: 443,
        password: "PRIVATE_NODE_PASSWORD",
        rawUri: "PRIVATE_NODE_URI",
      },
    ];
  const documents = ["doc-a", "doc-b"].map((id) => ({
    id,
    title: id,
    bindings: [],
    excerpt: "PRIVATE_BODY",
    createdAt: RELATION_TIME,
    updatedAt: RELATION_TIME,
  }));
  return { snapshot, documents, resources: resourceRows(rows, documents, snapshot) };
}
