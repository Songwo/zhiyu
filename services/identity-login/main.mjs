import { readFile } from "node:fs/promises";
import { createIdentityLoginServer } from "./server.mjs";
import { createProxiedFetch } from "./outbound.mjs";
import { createResearchService } from "./research-service.mjs";

let transport;
let research;
const closeTransport = async () => {
  try {
    await transport?.close();
  } catch {
    process.stderr.write("知屿登录服务出站连接未能正常关闭。\n");
    process.exitCode = 1;
  }
};

try {
  const filename = process.env.ZHIYU_IDENTITY_CONFIG;
  const file = filename ? JSON.parse(await readFile(filename, "utf8")) : {};
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("配置文件须为 JSON 对象。");
  const value = (key) => process.env[key] ?? file[key];
  const port = Number(value("PORT") || 49284);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT 无效。");
  transport = await createProxiedFetch(value("OUTBOUND_PROXY_URL"));
  if (value("EXA_API_KEY"))
    research = await createResearchService({
      file: value("ZHIYU_SEARCH_DB"),
      apiKey: value("EXA_API_KEY"),
      encryptionKey: Buffer.from(value("ZHIYU_RESEARCH_ENCRYPTION_KEY") || "", "base64"),
      publicOrigin: value("PUBLIC_ORIGIN") || "https://auth.allinsong.top",
      merchantId: value("LDC_CLIENT_ID"),
      merchantKey: value("LDC_CLIENT_SECRET"),
      balanceReader: value("ZHIYU_EXA_BALANCE_FILE")
        ? async () => {
            // 只读取维护者已核实的证据，不用读取时间伪造核验时间；超过一分钟的证据拒绝收费。
            const content = await readFile(value("ZHIYU_EXA_BALANCE_FILE"), "utf8");
            if (content.length > 4096) throw new Error("余额证明过大。");
            return JSON.parse(content);
          }
        : undefined,
    });
  const server = createIdentityLoginServer({
    fetchImpl: transport.fetch,
    research,
    onDiagnostic: (event) =>
      process.stderr.write(`${JSON.stringify({ event: "identity_login_failed", ...event })}\n`),
    config: {
      publicOrigin: value("PUBLIC_ORIGIN"),
      clientId: value("LINUXDO_CLIENT_ID"),
      clientSecret: value("LINUXDO_CLIENT_SECRET"),
      sessionEncryptionKey: value("SESSION_ENCRYPTION_KEY"),
      trustCloudflareProxy: [true, "true"].includes(value("TRUST_CLOUDFLARE_PROXY")),
    },
  });
  server.on("error", () => {
    process.stderr.write("知屿登录服务无法启动，请检查监听端口和服务配置。\n");
    process.exitCode = 1;
    void closeTransport();
    void research?.close();
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write("知屿登录服务已启动。\n"));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, 10_000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      void closeTransport();
      void research?.close();
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch {
  // 避免 JSON 解析错误把配置中的敏感片段输出到日志。
  process.stderr.write("知屿登录服务配置无效或无法读取，请检查受保护的配置文件。\n");
  process.exitCode = 1;
  await closeTransport();
  await research?.close();
}
