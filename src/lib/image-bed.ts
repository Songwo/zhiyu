import { hostBridge } from "./web-bridge";
export interface ImageBedStatus {
  configured: boolean;
  enabled: boolean;
  origin: string;
}
export interface ImageBedBridge {
  status(): Promise<ImageBedStatus>;
  configure(input: { apiKey?: string; enabled: boolean }): Promise<ImageBedStatus>;
  upload(input: {
    dataUrl: string;
    filename: string;
    kind: "document" | "asset";
  }): Promise<{ url: string; key: string; filename: string; size: number }>;
}
let pendingUploads = 0;
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (pendingUploads) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
export async function uploadImage(dataUrl: string, filename: string, kind: "document" | "asset") {
  pendingUploads++;
  try {
    return await performUpload(dataUrl, filename, kind);
  } finally {
    pendingUploads--;
  }
}
async function performUpload(dataUrl: string, filename: string, kind: "document" | "asset") {
  const bridge = hostBridge();
  if (!bridge) return dataUrl;
  const api = bridge.images;
  if (!api) throw new Error("请重启知屿，加载新的图床上传接口");
  const status = await api.status();
  if (!status.enabled) return dataUrl;
  if (dataUrl.startsWith("data:image/webp;")) {
    const blob = new Blob([Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0))], {
      type: "image/webp",
    });
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      dataUrl = canvas.toDataURL("image/png");
      while (dataUrl.length > 10 * 1024 * 1024 && canvas.width > 400 && canvas.height > 400) {
        canvas.width = Math.round(canvas.width * 0.75);
        canvas.height = Math.round(canvas.height * 0.75);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        dataUrl = canvas.toDataURL("image/png");
      }
    } finally {
      bitmap.close();
    }
  }
  return (await api.upload({ dataUrl, filename, kind })).url;
}
