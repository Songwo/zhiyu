/** 自托管网页版：页面由 selfhost/server.mjs 提供，资料通过同源接口读写。 */
export const isWeb = () => import.meta.env.VITE_ZHIYU_WEB === "1";

export class WebConflictError extends Error {}

/** 同源 JSON 接口。改动类请求带上 x-zhiyu 头；登录过期时回到登录页。 */
export async function webApi<T>(
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/web/${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-zhiyu": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.assign("/login");
    throw new Error("登录已过期，请重新登录");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) throw new WebConflictError(data.error ?? "资料已在其他设备更新");
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export async function webLogout() {
  await webApi("logout", { method: "POST", body: {} }).catch(() => {});
  location.assign("/login");
}

/** 下载整份资料的加密备份（与桌面版备份格式相同）。 */
export async function webDownloadBackup(password: string) {
  const res = await fetch("/api/web/backup", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-zhiyu": "1" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "备份失败");
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
    "zhiyu.zhiyu-backup";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 用桌面版或网页版的备份文件替换服务器上的资料。 */
export async function webRestoreBackup(file: File, password: string) {
  const bytes = new TextEncoder().encode(password);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const res = await fetch("/api/web/restore", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-zhiyu": "1",
      "x-zhiyu-backup-password": btoa(binary),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "恢复失败");
  return data as { ok: true; files: number };
}
