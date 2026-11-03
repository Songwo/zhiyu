import {
  createHash,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export class ResearchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => new ResearchError(status, code, message);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const FREE_LIMIT = 50;
const PRICE_CENTS = 1000;
const PURCHASE_UNITS = 100;
export function creditSignature(parameters, key) {
  const text = Object.keys(parameters)
    .filter(
      (name) =>
        !["sign", "sign_type"].includes(name) &&
        parameters[name] !== "" &&
        parameters[name] != null,
    )
    .sort()
    .map((name) => `${name}=${parameters[name]}`)
    .join("&");
  return createHash("md5")
    .update(text + key)
    .digest("hex");
}
function moneyCents(value) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value))) return -1;
  const [whole, decimal = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
}
async function readJson(response, max = 2 * 1024 * 1024) {
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw fail(502, "upstream_format", "检索服务返回的数据格式无效，未产生积分支付。");
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw fail(502, "upstream_size", "检索返回的数据过大，未产生积分支付。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(502, "upstream_format", "检索返回的数据无效，未产生积分支付。");
  }
}

/** 一次性免费 50 次；10 LDC 购买 100 次。未知或过期的上游余额证明必须关闭购买。 */
export async function createResearchService({
  file,
  apiKey,
  encryptionKey,
  publicOrigin,
  merchantId = "",
  merchantKey = "",
  balanceReader,
  fetchImpl = fetch,
  exaOrigin = "https://api.exa.ai",
  creditOrigin = "https://credit.linux.do",
  now = Date.now,
  maxDailyUsd = 5,
  maxSearchCostUsd = 0.05,
} = {}) {
  if (
    !apiKey ||
    !file ||
    !isAbsolute(file) ||
    !Buffer.isBuffer(encryptionKey) ||
    encryptionKey.length !== 32
  )
    throw new Error("联网检索需要服务端 Exa 密钥、独立账本路径和 32 字节加密密钥。");
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (process.platform !== "win32") await chmod(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS research_accounts(subject TEXT PRIMARY KEY, free_used INTEGER NOT NULL DEFAULT 0, paid_total INTEGER NOT NULL DEFAULT 0, paid_used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS research_jobs(id TEXT PRIMARY KEY, subject TEXT NOT NULL, request_id TEXT NOT NULL, query TEXT NOT NULL, state TEXT NOT NULL, is_free INTEGER NOT NULL, result BLOB, cost_usd REAL, events TEXT NOT NULL, payment_url TEXT, created_at INTEGER NOT NULL, UNIQUE(subject,request_id));
    CREATE TABLE IF NOT EXISTS research_state(id TEXT PRIMARY KEY, code TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_purchases(job_id TEXT PRIMARY KEY, subject TEXT NOT NULL, units INTEGER NOT NULL, money_cents INTEGER NOT NULL, state TEXT NOT NULL, reserved_usd REAL NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER, trade_no TEXT UNIQUE);
    UPDATE research_jobs SET state='interrupted' WHERE state IN ('queued','searching');`);
  const controllers = new Map();
  const paymentLocks = new Map();
  const lastPoll = new Map();
  let stopped = false;
  const get = (id) => db.prepare("SELECT * FROM research_jobs WHERE id=?").get(id);
  const actor = (subject) => digest(`zhiyu-search:${subject}`);
  const unavailable = () =>
    db.prepare("SELECT code FROM research_state WHERE id='exa'").get()?.code === "exhausted";
  const markAvailability = (code) =>
    db
      .prepare(
        "INSERT INTO research_state(id,code) VALUES('exa',?) ON CONFLICT(id) DO UPDATE SET code=excluded.code",
      )
      .run(code);
  async function budgetProof() {
    if (typeof balanceReader !== "function")
      throw fail(
        503,
        "exa_balance_unknown",
        "无法核实 Exa 的真实可用余额，暂不开放积分购买，不会消耗社区积分。",
      );
    let proof;
    try {
      proof = await balanceReader();
    } catch {
      throw fail(503, "exa_balance_unknown", "Exa 余额核验暂时不可用，已禁止积分购买。");
    }
    if (
      !proof ||
      !["exa-billing", "operator-verified"].includes(proof.source) ||
      typeof proof.availableUsd !== "number" ||
      !Number.isFinite(proof.availableUsd) ||
      proof.availableUsd < 0 ||
      !Number.isSafeInteger(proof.checkedAt) ||
      proof.checkedAt > now() ||
      now() - proof.checkedAt > 60000
    )
      throw fail(503, "exa_balance_unknown", "Exa 余额核验缺失或已过期，已禁止积分购买。");
    const incurred = db
      .prepare("SELECT COALESCE(SUM(cost_usd),0) AS n FROM research_jobs WHERE created_at>=?")
      .get(proof.checkedAt).n;
    return {
      ...proof,
      availableUsd: Math.max(0, proof.availableUsd - incurred),
      deductedUsd: incurred,
    };
  }
  function committedBudget() {
    return (
      db.prepare("SELECT COALESCE(SUM(paid_total-paid_used),0) AS n FROM research_accounts").get()
        .n *
        maxSearchCostUsd +
      db
        .prepare(
          "SELECT COALESCE(SUM(reserved_usd),0) AS n FROM research_purchases WHERE state IN ('creating','pending','unknown')",
        )
        .get().n
    );
  }
  function seal(id, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  function open(id, bytes) {
    const data = Buffer.from(bytes);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
    );
  }
  function owned(subject, id) {
    const job = get(id);
    if (!job || job.subject !== actor(subject)) throw fail(404, "not_found", "没有找到这次检索。");
    return job;
  }
  function event(id, label, status = "running", detail) {
    const job = get(id);
    const items = JSON.parse(job.events);
    const previous = items.findLast((item) => item.status === "running");
    if (previous) {
      previous.status = status === "error" || status === "cancelled" ? status : "done";
      previous.endedAt = now();
    }
    if (status === "running" || !previous)
      items.push({
        id: `step_${items.length}`,
        label,
        status,
        startedAt: now(),
        ...(status !== "running" ? { endedAt: now() } : {}),
        ...(detail ? { detail } : {}),
      });
    else if (detail) previous.detail = detail;
    db.prepare("UPDATE research_jobs SET events=? WHERE id=?").run(JSON.stringify(items), id);
  }
  function dto(job) {
    const complete = job.state === "complete";
    return {
      id: job.id,
      query: job.query,
      state: job.state,
      free: Boolean(job.is_free),
      price: "10.00",
      purchaseUnits: PURCHASE_UNITS,
      items: JSON.parse(job.events),
      paymentUrl: job.payment_url || null,
      ...(complete && job.result ? { results: open(job.id, job.result) } : {}),
    };
  }
  for (const job of db
    .prepare("SELECT id,events FROM research_jobs WHERE state='interrupted'")
    .all())
    if (JSON.parse(job.events).some((item) => item.status === "running"))
      event(job.id, "服务重启", "error", "服务重启已中断，未消耗检索次数。");
  function quota(subject) {
    const user = actor(subject);
    db.prepare("INSERT OR IGNORE INTO research_accounts(subject) VALUES(?)").run(user);
    const account = db.prepare("SELECT * FROM research_accounts WHERE subject=?").get(user);
    const used = account.free_used;
    const reserved = db
      .prepare(
        "SELECT COUNT(*) AS n FROM research_jobs WHERE subject=? AND is_free=1 AND state IN ('queued','searching')",
      )
      .get(user).n;
    const pending = db
      .prepare(
        "SELECT id FROM research_jobs WHERE subject=? AND state='awaiting_payment' ORDER BY created_at DESC LIMIT 1",
      )
      .get(user);
    return {
      configured: true,
      freeRemaining: Math.max(0, FREE_LIMIT - used - reserved),
      freeUsed: used,
      freeReserved: reserved,
      freeLimit: FREE_LIMIT,
      paidRemaining: account.paid_total - account.paid_used,
      paidTotal: account.paid_total,
      paidUsed: account.paid_used,
      price: "10.00",
      purchaseUnits: PURCHASE_UNITS,
      paymentConfigured: Boolean(merchantId && merchantKey),
      purchaseGuardConfigured: typeof balanceReader === "function",
      exaStatus: unavailable() ? "exhausted" : "unverified",
      balanceKnown: false,
      pendingJobId: pending?.id || null,
    };
  }
  async function search(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    try {
      db.prepare("UPDATE research_jobs SET state='searching' WHERE id=?").run(job.id);
      event(job.id, "核对检索额度");
      const spent = db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd),0) AS total FROM research_jobs WHERE created_at>=? AND state NOT IN ('queued','searching')",
        )
        .get(new Date(new Date(now()).toISOString().slice(0, 10)).getTime()).total;
      const pending = db
        .prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE state IN ('queued','searching')")
        .get().n;
      if (spent + pending * maxSearchCostUsd > maxDailyUsd)
        throw fail(503, "owner_budget", "站点今日 Exa 预算不足，已停止检索，不会创建积分支付。");
      if (job.is_free && committedBudget() > 0) {
        const proof = await budgetProof();
        if (proof.availableUsd - committedBudget() < maxSearchCostUsd * pending)
          throw fail(
            503,
            "reserved_budget",
            "Exa 剩余预算已为购买额度预留，暂不提供新的免费检索，未扣次数。",
          );
      }
      event(job.id, "向 Exa 发起检索");
      // 请求已经发出而响应丢失时，用保守成本占用站点预算，不能按零成本重新出售。
      db.prepare("UPDATE research_jobs SET cost_usd=? WHERE id=?").run(maxSearchCostUsd, job.id);
      const response = await fetchImpl(`${exaOrigin}/search`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query: job.query,
          type: "auto",
          numResults: 5,
          contents: { highlights: true },
        }),
      });
      if (response.status === 402) {
        markAvailability("exhausted");
        throw fail(503, "exa_exhausted", "Exa 额度不足，未消耗免费次数，也不会创建社区积分支付。");
      }
      if (!response.ok)
        throw fail(502, "exa_unavailable", "Exa 暂时不可用，未消耗免费次数，也不会创建积分支付。");
      const data = await readJson(response);
      controller.signal.throwIfAborted();
      if (
        typeof data.costDollars?.total === "number" &&
        Number.isFinite(data.costDollars.total) &&
        data.costDollars.total >= 0
      )
        db.prepare("UPDATE research_jobs SET cost_usd=? WHERE id=?").run(
          data.costDollars.total,
          job.id,
        );
      event(job.id, "整理来源与摘录");
      if (!Array.isArray(data.results))
        throw fail(502, "exa_format", "Exa 返回的数据无效，未消耗次数或积分。");
      const results = data.results.slice(0, 5).flatMap((item) => {
        try {
          const url = new URL(item.url);
          if (url.protocol !== "https:" || url.username || url.password) return [];
          return [
            {
              title: String(item.title || url.hostname).slice(0, 400),
              url: url.href,
              publishedDate:
                typeof item.publishedDate === "string" ? item.publishedDate.slice(0, 40) : "",
              highlights: Array.isArray(item.highlights)
                ? item.highlights
                    .filter((value) => typeof value === "string")
                    .slice(0, 3)
                    .map((value) => value.slice(0, 2500))
                : [],
            },
          ];
        } catch {
          return [];
        }
      });
      if (!results.length) throw fail(422, "no_results", "本次没有可用来源，未消耗次数或积分。");
      const cost = data.costDollars?.total;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > maxSearchCostUsd)
        throw fail(503, "cost_unverified", "无法核实本次 Exa 费用或费用超出上限，未创建积分支付。");
      controller.signal.throwIfAborted();
      const encrypted = seal(job.id, results);
      db.exec("BEGIN IMMEDIATE");
      try {
        const account = db
          .prepare("SELECT * FROM research_accounts WHERE subject=?")
          .get(job.subject);
        const delivered = job.is_free || account.paid_total > account.paid_used;
        if (job.is_free)
          db.prepare("UPDATE research_accounts SET free_used=free_used+1 WHERE subject=?").run(
            job.subject,
          );
        else if (delivered)
          db.prepare("UPDATE research_accounts SET paid_used=paid_used+1 WHERE subject=?").run(
            job.subject,
          );
        db.prepare("UPDATE research_jobs SET state=?,result=?,cost_usd=? WHERE id=?").run(
          delivered ? "complete" : "awaiting_payment",
          encrypted,
          cost,
          job.id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      markAvailability("available");
      const delivered = get(job.id).state === "complete";
      event(job.id, delivered ? "检索完成" : "结果已准备，等待购买额度");
      event(
        job.id,
        "完成",
        "done",
        job.is_free
          ? "已使用 1 次免费检索"
          : delivered
            ? "已使用 1 次已购检索额度"
            : "本次结果已加密保存；核实 Exa 可售预算后，10 LDC 购买 100 次并使用 1 次查看本次结果。",
      );
    } catch (error) {
      const cancelled = controller.signal.aborted;
      db.prepare(
        "UPDATE research_jobs SET state=? WHERE id=? AND state IN ('queued','searching')",
      ).run(cancelled ? "cancelled" : "failed", job.id);
      event(
        job.id,
        "检索停止",
        cancelled ? "cancelled" : "error",
        cancelled
          ? "已取消，未消耗次数或积分。"
          : error instanceof ResearchError
            ? error.message
            : "检索未完成，未消耗次数或积分。",
      );
    } finally {
      controllers.delete(job.id);
    }
  }
  function start(subject, input) {
    if (stopped) throw fail(503, "stopped", "检索服务正在重启，请稍后重试。");
    if (
      !input ||
      typeof input.query !== "string" ||
      !input.query.trim() ||
      input.query.length > 600 ||
      [...input.query].some((char) => char.charCodeAt(0) < 32) ||
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{10,100}$/.test(input.requestId)
    )
      throw fail(400, "invalid_request", "请输入不超过 600 字的公开检索问题。");
    const user = actor(subject);
    const query = input.query.trim();
    const existing = db
      .prepare("SELECT * FROM research_jobs WHERE subject=? AND request_id=?")
      .get(user, input.requestId);
    if (existing) {
      if (existing.query !== query)
        throw fail(409, "request_conflict", "相同请求标识不能用于不同问题。");
      return dto(existing);
    }
    const q = quota(subject);
    if (q.pendingJobId)
      throw fail(409, "pending_result", "已有准备好的检索结果，请先查看或完成该次支付。");
    if (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM research_jobs WHERE subject=? AND state IN ('queued','searching')",
        )
        .get(user).n
    )
      throw fail(409, "already_running", "已有检索在进行，请等待或取消。");
    if (q.freeRemaining === 0 && q.paidRemaining === 0 && !q.paymentConfigured)
      throw fail(503, "payment_not_configured", "检索次数已用完，站点暂未启用积分支付。");
    if (q.freeRemaining === 0 && q.paidRemaining === 0 && !q.purchaseGuardConfigured)
      throw fail(
        503,
        "exa_balance_unknown",
        "无法核实 Exa 的真实可用余额，暂不开放积分购买，不会消耗社区积分。",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO research_jobs(id,subject,request_id,query,state,is_free,events,created_at) VALUES(?,?,?,?,'queued',?,'[]',?)",
    ).run(id, user, input.requestId, query, q.freeRemaining > 0 ? 1 : 0, now());
    event(id, "准备检索问题");
    void search(get(id)).catch(() => {
      stopped = true;
    });
    return dto(get(id));
  }
  async function verifyPaid(job) {
    const purchase = db.prepare("SELECT * FROM research_purchases WHERE job_id=?").get(job.id);
    if (job.state !== "awaiting_payment" || !purchase) return;
    const url = new URL(`${creditOrigin}/epay/api.php`);
    url.search = new URLSearchParams({
      act: "order",
      pid: merchantId,
      key: merchantKey,
      out_trade_no: job.id,
    }).toString();
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw fail(
        502,
        "payment_unknown",
        "积分支付状态暂时无法核实，请稍后刷新；不会重复创建订单。",
      );
    const value = await readJson(response);
    if (value.code !== 1 || value.status !== 1) return;
    if (
      String(value.pid) !== String(merchantId) ||
      value.out_trade_no !== job.id ||
      moneyCents(value.money) !== PRICE_CENTS ||
      !job.result ||
      typeof value.trade_no !== "string" ||
      !value.trade_no ||
      value.trade_no.length > 200
    )
      throw fail(502, "payment_mismatch", "积分订单信息不一致，结果尚未解锁，请联系维护者核对。");
    open(job.id, job.result);
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT state FROM research_purchases WHERE job_id=?").get(job.id);
      if (current.state !== "paid") {
        db.prepare(
          "UPDATE research_accounts SET paid_total=paid_total+?,paid_used=paid_used+1 WHERE subject=?",
        ).run(purchase.units, job.subject);
        db.prepare(
          "UPDATE research_purchases SET state='paid',paid_at=?,trade_no=? WHERE job_id=?",
        ).run(now(), String(value.trade_no), job.id);
        db.prepare(
          "UPDATE research_jobs SET state='complete' WHERE id=? AND state='awaiting_payment'",
        ).run(job.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    event(job.id, "积分支付已核实，额度已入账并解锁已有结果", "done");
  }
  async function status(subject, id) {
    let job = owned(subject, id);
    if (
      job.state === "awaiting_payment" &&
      db.prepare("SELECT job_id FROM research_purchases WHERE job_id=?").get(id) &&
      now() - (lastPoll.get(id) || 0) > 5000
    ) {
      lastPoll.set(id, now());
      await verifyPaid(job);
      job = get(id);
    }
    return dto(job);
  }
  async function checkout(subject, id) {
    const job = owned(subject, id);
    if (job.state === "complete") return dto(job);
    if (job.state !== "awaiting_payment" || !job.result)
      throw fail(409, "result_not_ready", "本次 Exa 尚未成功返回结果，禁止积分支付。");
    if (unavailable()) throw fail(503, "exa_exhausted", "Exa 额度不足，已禁止创建社区积分支付。");
    if (!merchantId || !merchantKey)
      throw fail(503, "payment_not_configured", "站点尚未配置积分支付。");
    if (job.payment_url) return dto(job);
    if (paymentLocks.has(id)) return paymentLocks.get(id);
    const operation = (async () => {
      const proof = await budgetProof();
      db.exec("BEGIN IMMEDIATE");
      try {
        const purchased = db.prepare("SELECT * FROM research_purchases WHERE job_id=?").get(id);
        if (purchased)
          throw fail(
            409,
            "payment_pending",
            "这笔积分订单状态待核实，请刷新记录；不会重复创建订单。",
          );
        const latestIncurred = db
          .prepare("SELECT COALESCE(SUM(cost_usd),0) AS n FROM research_jobs WHERE created_at>=?")
          .get(proof.checkedAt).n;
        const remaining = Math.max(
          0,
          proof.availableUsd - Math.max(0, latestIncurred - proof.deductedUsd),
        );
        if (remaining - committedBudget() < PURCHASE_UNITS * maxSearchCostUsd)
          throw fail(503, "exa_budget_low", "Exa 可售预算不足，已禁止积分购买，不会消耗社区积分。");
        db.prepare(
          "INSERT INTO research_purchases(job_id,subject,units,money_cents,state,reserved_usd,created_at) VALUES(?,?,?,?,'creating',?,?)",
        ).run(
          id,
          job.subject,
          PURCHASE_UNITS,
          PRICE_CENTS,
          PURCHASE_UNITS * maxSearchCostUsd,
          now(),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const parameters = {
        pid: merchantId,
        type: "epay",
        out_trade_no: id,
        name: "知屿联网检索 100 次",
        money: "10.00",
        notify_url: `${publicOrigin}/v1/research/payment/notify`,
        return_url: `${publicOrigin}/v1/research/payment/return`,
      };
      const body = new URLSearchParams({
        ...parameters,
        sign: creditSignature(parameters, merchantKey),
        sign_type: "MD5",
      });
      let response;
      try {
        response = await fetchImpl(`${creditOrigin}/epay/pay/submit.php`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        db.prepare("UPDATE research_purchases SET state='unknown' WHERE job_id=?").run(id);
        throw fail(502, "payment_unknown", "积分订单创建状态未知，请刷新记录；不会重复创建订单。");
      }
      const location = response.headers.get("location");
      if (![301, 302, 303, 307].includes(response.status) || !location)
        throw fail(
          502,
          "payment_unavailable",
          "积分支付服务未返回有效订单，未解锁或扣除本地次数。",
        );
      let target;
      try {
        target = new URL(location, creditOrigin);
      } catch {
        throw fail(502, "payment_url", "积分订单地址无效。");
      }
      if (
        target.origin !== new URL(creditOrigin).origin ||
        target.pathname !== "/paying" ||
        !target.searchParams.get("order_no") ||
        target.username ||
        target.password
      )
        throw fail(502, "payment_url", "积分订单地址无法验证。");
      db.prepare(
        "UPDATE research_jobs SET payment_url=? WHERE id=? AND state='awaiting_payment'",
      ).run(target.href, id);
      db.prepare("UPDATE research_purchases SET state='pending' WHERE job_id=?").run(id);
      return dto(get(id));
    })();
    paymentLocks.set(id, operation);
    try {
      return await operation;
    } finally {
      paymentLocks.delete(id);
    }
  }
  async function notify(parameters) {
    if (!parameters || typeof parameters.out_trade_no !== "string")
      throw fail(400, "invalid_payment", "积分回调无效。");
    const job = get(parameters.out_trade_no);
    if (
      !job ||
      !merchantKey ||
      parameters.pid !== String(merchantId) ||
      parameters.trade_status !== "TRADE_SUCCESS" ||
      moneyCents(parameters.money) !== PRICE_CENTS ||
      typeof parameters.sign !== "string" ||
      !/^[0-9a-f]{32}$/.test(parameters.sign)
    )
      throw fail(400, "invalid_payment", "积分回调无效。");
    const expected = creditSignature(parameters, merchantKey);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parameters.sign)))
      throw fail(400, "invalid_payment", "积分回调签名无效。");
    if (job.state !== "complete") await verifyPaid(job);
    if (get(job.id).state !== "complete")
      throw fail(409, "payment_unverified", "积分状态尚未核实。");
    return true;
  }
  function records(subject, input = {}) {
    const user = actor(subject);
    const offset = Number(input.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw fail(400, "invalid_offset", "记录分页参数无效。");
    const entries = db
      .prepare(
        `SELECT id,query,state,is_free,created_at,'search' AS kind,NULL AS units,NULL AS money_cents,NULL AS paid_at,NULL AS trade_no FROM research_jobs WHERE subject=?
      UNION ALL SELECT job_id AS id,NULL AS query,state,NULL AS is_free,created_at,'purchase' AS kind,units,money_cents,paid_at,trade_no FROM research_purchases WHERE subject=?
      ORDER BY created_at DESC,id DESC,kind DESC LIMIT 51 OFFSET ?`,
      )
      .all(user, user, offset);
    return {
      entries: entries.slice(0, 50).map((row) => ({
        id: `${row.kind}:${row.id}`,
        jobId: row.id,
        kind: row.kind,
        query: row.query,
        state: row.state,
        source: row.kind === "purchase" ? "purchase" : row.is_free ? "free" : "purchased",
        consumed: row.kind === "search" && row.state === "complete" ? 1 : 0,
        units: row.units,
        amount: row.money_cents == null ? null : (row.money_cents / 100).toFixed(2),
        createdAt: row.created_at,
        paidAt: row.paid_at,
        tradeNo: row.trade_no,
      })),
      nextOffset: entries.length > 50 ? offset + 50 : null,
    };
  }
  return {
    quota,
    records,
    start,
    status,
    checkout,
    notify,
    cancel(subject, id) {
      const job = owned(subject, id);
      controllers.get(job.id)?.abort();
      return true;
    },
    async close() {
      if (stopped) return;
      stopped = true;
      for (const controller of controllers.values()) controller.abort();
      while (controllers.size) await new Promise((resolve) => setTimeout(resolve, 5));
      db.close();
    },
  };
}
