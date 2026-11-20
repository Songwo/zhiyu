/** 这些表单值只允许写入加密库，不能写入资产、日志或文档。 */
export const ACCOUNT_KEYS = ["_url", "_username", "_password", "_note"];

/**
 * 仅覆盖用户编辑过的字段；空密码保留旧密码，删除凭据由独立操作负责。
 * @param {Record<string, string>} form
 * @param {import("./desktop").AccountCredential | null} [previous]
 * @returns {import("./desktop").AccountCredential | null}
 */
export function accountFromForm(form, previous = null) {
  const field = (/** @type {string} */ key, /** @type {string | undefined} */ stored) =>
    Object.hasOwn(form, key) ? form[key].trim() || undefined : stored;
  const url = field("_url", previous?.url);
  const username = field("_username", previous?.username);
  const password = form._password || previous?.password;
  const note = field("_note", previous?.note);
  const provider = field("_oauthProvider", previous?.oauth?.provider);
  const mailClientId = field("_oauthMailClientId", previous?.oauth?.mailClientId);
  const mailAddress = field("_oauthMailAddress", previous?.oauth?.mailAddress);
  const oauth = provider
    ? {
        provider,
        refreshToken: Object.hasOwn(form, "_oauthRefresh")
          ? form._oauthRefresh || null
          : (previous?.oauth?.refreshToken ?? null),
        expiresAt: Object.hasOwn(form, "_oauthExpires")
          ? form._oauthExpires || null
          : (previous?.oauth?.expiresAt ?? null),
        scope: form._oauthScope ?? previous?.oauth?.scope ?? "",
        ...(mailClientId && mailAddress ? { mailClientId, mailAddress } : {}),
      }
    : undefined;
  if (!url && !username && !password && !note && !oauth) return null;
  return {
    url,
    username,
    password,
    note,
    ...(oauth ? { oauth } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** 锁库后移除敏感草稿；删除键允许解锁后重新回填，而不是把空值当作修改。
 * @param {Record<string, string>} form
 */
export function clearAccountDraft(form) {
  const next = { ...form };
  for (const key of ACCOUNT_KEYS) delete next[key];
  for (const key of Object.keys(next)) if (key.startsWith("_oauth")) delete next[key];
  return next;
}

/** 独立账号只公开显示名称；提示、说明与旧明文值都不带入资产。
 * @param {Record<string, string>} form
 * @returns {{ name: string; kind: "account"; hint: string; value: string; notes: string }}
 */
export function accountMetadataFromForm(form) {
  return { name: form.name?.trim() ?? "", kind: "account", hint: "", value: "", notes: "" };
}
