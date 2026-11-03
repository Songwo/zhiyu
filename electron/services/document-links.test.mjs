import assert from "node:assert/strict";
import test from "node:test";
import { documentLink } from "./document-links.mjs";
import { normalizeDocument } from "./documents.mjs";

test("编辑器允许的链接都能通过文档持久化，非网页协议保持为普通文本", () => {
  for (const href of [
    "https://example.test/page?q=1",
    "http://example.test",
    "mailto:sample@example.test",
    "tel:123456",
    "javascript:alert(1)",
    "https://user:pass@example.test",
    "/relative",
  ]) {
    const safe = documentLink(href);
    const doc = normalizeDocument({
      id: "doc-links-regression",
      title: "合成链接",
      bindings: [],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: href,
                ...(safe ? { marks: [{ type: "link", attrs: { href: safe } }] } : {}),
              },
            ],
          },
        ],
      },
    });
    const text = doc.content.content[0].content[0];
    assert.equal(text.text, href);
    assert.equal(
      Boolean(text.marks?.length),
      href.startsWith("http") && !href.includes("user:pass"),
    );
  }
});

test("持久化继续拒绝绕过编辑器的非网页链接", () => {
  assert.throws(
    () =>
      normalizeDocument({
        id: "doc-invalid-link",
        title: "合成链接",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "邮箱",
                  marks: [{ type: "link", attrs: { href: "mailto:sample@example.test" } }],
                },
              ],
            },
          ],
        },
        bindings: [],
      }),
    /链接只支持 HTTP 或 HTTPS/,
  );
});
