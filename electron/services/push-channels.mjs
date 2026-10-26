// 推送渠道：Telegram、Server酱、企业微信群机器人、WxPusher。桌面版邮件推送与网页版提醒推送共用。

export const PUSH_PROVIDERS = new Set(["telegram", "serverchan", "wecom", "wxpusher"]);

/** @param {string} provider */
export const requiresDestination = (provider) => provider === "telegram" || provider === "wxpusher";

/** @param {string} provider @param {string} token */
export function validateToken(provider, token) {
  const valid =
    provider === "telegram"
      ? /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)
      : provider === "serverchan"
        ? /^SCT[A-Za-z0-9_-]{10,250}$/.test(token)
        : provider === "wxpusher"
          ? /^AT_[A-Za-z0-9_-]{10,250}$/.test(token)
          : /^[A-Za-z0-9-]{10,200}$/.test(token);
  if (!valid) throw new Error("推送凭据格式不正确，请填写对应渠道的 Token 或密钥。");
}

/** @typedef {{ provider: string, token: string, destination: string }} PushTarget */

/**
 * 组装请求；凭据或接收人格式不对时直接抛出可读的错误。
 * @param {PushTarget} target @param {string} text @param {string} title
 */
export function buildPushRequest(target, text, title) {
  validateToken(target.provider, target.token);
  if (target.provider === "telegram")
    return {
      url: `https://api.telegram.org/bot${target.token}/sendMessage`,
      body: { chat_id: target.destination, text, disable_web_page_preview: true },
    };
  if (target.provider === "serverchan")
    return { url: `https://sctapi.ftqq.com/${target.token}.send`, body: { title, desp: text } };
  if (target.provider === "wecom")
    return {
      url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(target.token)}`,
      body: { msgtype: "text", text: { content: text } },
    };
  if (target.provider === "wxpusher") {
    if (!/^UID_[A-Za-z0-9_-]{5,96}$/.test(target.destination))
      throw new Error("WxPusher 接收用户需填写以 UID_ 开头的用户 UID。");
    return {
      url: "https://wxpusher.zjiecode.com/api/send/message",
      body: {
        appToken: target.token,
        content: text,
        summary: title,
        contentType: 1,
        uids: [target.destination],
      },
    };
  }
  throw new Error("请选择支持的推送渠道。");
}

/**
 * 发送并核对渠道的应答；失败时抛出不含凭据的错误。
 * @param {PushTarget} target @param {{ url: string, body: unknown }} request
 * @param {{ signal: AbortSignal, fetchImpl?: typeof fetch }} options
 */
export async function deliverPush(target, request, { signal, fetchImpl = fetch }) {
  const response = await fetchImpl(request.url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error("request_failed");
  const result = await response.json();
  const accepted =
    target.provider === "telegram"
      ? result?.ok === true
      : target.provider === "wecom"
        ? result?.errcode === 0
        : target.provider === "wxpusher"
          ? result?.code === 1000 &&
            Array.isArray(result.data) &&
            result.data.some(
              (/** @type {any} */ entry) =>
                entry?.uid === target.destination && entry.code === 1000,
            ) &&
            result.data.every((/** @type {any} */ entry) => entry?.code === 1000)
          : result?.code === 0 &&
            (!result.data || result.data.errno === undefined || result.data.errno === 0);
  if (!accepted) throw new Error("provider_rejected");
}
