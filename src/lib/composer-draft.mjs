/** @typedef {import("./types").Server} Server */
/** @typedef {Record<string, string>} Form */

/** @param {string | undefined} name @param {string} fallback */
export function initialWorkspaceName(name, fallback) {
  return name?.trim() || fallback;
}

/** @param {unknown} existing @param {Form} form @returns {"record" | "ssh"} */
export function initialServerMode(existing, form) {
  if (
    existing &&
    typeof existing === "object" &&
    "sshConfigured" in existing &&
    existing.sshConfigured === false
  )
    return "record";
  return existing || form._authKind || form._password || form._privateKey || form._privateKeyPath
    ? "ssh"
    : "record";
}

/**
 * 编辑已有订阅或从订阅模板新建时直接进入手动表单；空白新建先选择来源。
 * @param {unknown} existing @param {{ name?: string } | null} [preset] @returns {"choose" | "manual"}
 */
export function initialAiMode(existing, preset = null) {
  return existing || preset?.name ? "manual" : "choose";
}

/** @param {Form} form @param {"record" | "ssh"} mode @returns {Form | null} */
export function sshDraftForSave(form, mode) {
  return mode === "ssh" ? form : null;
}

/** 面板账号使用独立草稿键，避免与 SSH 密码相互覆盖。 @param {string} key */
export function serverAccountKey(key) {
  return `_panel${key}`;
}

/** @param {Form} form @returns {Form} */
export function serverAccountDraft(form) {
  return Object.fromEntries(
    Object.entries(form)
      .filter(([key]) => key.startsWith("_panel_"))
      .map(([key, value]) => [key.slice(6), value]),
  );
}

/** @param {{id: string, form: Form, existing: Server | null, tags: string[], now: string, pendingLabel: string, mode: "record" | "ssh"}} draft @returns {Server} */
export function serverAssetFromDraft({ id, form, existing: prev, tags, pendingLabel, mode }) {
  const name = (form.name ?? prev?.name ?? "").trim() || "unnamed";
  return {
    ...prev,
    id,
    sshConfigured: mode === "ssh" ? true : prev ? prev.sshConfigured : false,
    imageDataUrl: form.imageDataUrl ?? prev?.imageDataUrl ?? "",
    name,
    label: form.label === undefined ? (prev?.label ?? name) : form.label.trim() || name,
    host: (form.host ?? prev?.host ?? "").trim(),
    port: form.port === undefined ? (prev?.port ?? 22) : Number(form.port) || 22,
    username:
      form.username === undefined ? (prev?.username ?? "root") : form.username.trim() || "root",
    os: form.os ?? prev?.os ?? "",
    region: form.region ?? prev?.region ?? "",
    tags,
    status: prev?.status ?? "warning",
    cpu: prev?.cpu ?? 0,
    memory: prev?.memory ?? 0,
    disk: prev?.disk ?? 0,
    uptime: prev?.uptime ?? pendingLabel,
    lastSeen: prev?.lastSeen ?? "",
    notes: form.notes ?? prev?.notes ?? "",
    authKind:
      mode === "ssh"
        ? /** @type {Server["authKind"]} */ (form._authKind ?? prev?.authKind ?? "password")
        : (prev?.authKind ?? "password"),
  };
}
