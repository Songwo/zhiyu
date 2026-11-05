import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
export const S3_TEST_ACCESS = "SYNTHETICACCESS",
  S3_TEST_SECRET = "synthetic-private-s3-key";

/** 真实本机 HTTP S3：独立校验 SigV4 和请求体摘要，不连接真实存储。 */
export async function s3BackupFixture() {
  const objects = new Map(),
    requests = [],
    errors = [];
  const behavior = {
    putStatus: 200,
    headStatus: 200,
    deleteStatus: 204,
    redirect: false,
    headWrongSize: false,
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const auth =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
          req.headers.authorization ?? "",
        );
      assert.ok(auth, "必须有 SigV4 授权");
      assert.equal(auth[1], S3_TEST_ACCESS);
      assert.equal(req.headers["x-amz-content-sha256"], sha(body));
      const signed = auth[4],
        headers = signed
          .split(";")
          .map(
            (key) =>
              key +
              ":" +
              String(req.headers[key] ?? "")
                .trim()
                .replace(/\s+/g, " "),
          )
          .join("\n");
      const url = new URL(req.url, `http://${req.headers.host}`);
      const canonical = [req.method, url.pathname, "", headers + "\n", signed, sha(body)].join(
        "\n",
      );
      const scope = `${auth[2]}/${auth[3]}/s3/aws4_request`;
      const k = hmac(
        hmac(hmac(hmac("AWS4" + S3_TEST_SECRET, auth[2]), auth[3]), "s3"),
        "aws4_request",
      );
      const expected = hmac(
        k,
        ["AWS4-HMAC-SHA256", req.headers["x-amz-date"], scope, sha(canonical)].join("\n"),
      ).toString("hex");
      assert.equal(auth[5], expected, "签名必须与独立参考实现一致");
      requests.push({ method: req.method, key: url.pathname, body, headers: req.headers });
      if (behavior.redirect) {
        res.writeHead(307, { location: "https://untrusted.example.test/" });
        return res.end();
      }
      if (req.method === "PUT") {
        res.statusCode = behavior.putStatus;
        if (res.statusCode === 200) objects.set(url.pathname, body);
      } else if (req.method === "HEAD") {
        res.statusCode = objects.has(url.pathname) ? behavior.headStatus : 404;
        if (res.statusCode === 200)
          res.setHeader(
            "Content-Length",
            (objects.get(url.pathname)?.length ?? 0) + (behavior.headWrongSize ? 1 : 0),
          );
      } else if (req.method === "DELETE") {
        res.statusCode = behavior.deleteStatus;
        if (res.statusCode === 204) objects.delete(url.pathname);
      } else res.statusCode = 501;
      res.end();
    } catch (error) {
      errors.push(error.message);
      res.writeHead(403);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    objects,
    requests,
    errors,
    behavior,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
