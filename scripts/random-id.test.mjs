import test from "node:test";
import assert from "node:assert/strict";
import { randomId } from "../src/lib/random-id.ts";

test("randomId 生成 v4 UUID，不依赖只在 HTTPS 下才有的 crypto.randomUUID", () => {
  const ids = new Set(Array.from({ length: 200 }, () => randomId()));
  assert.equal(ids.size, 200);
  for (const id of ids)
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
