import { normalizeServices } from "./service-assets.mjs";
import { normalizeAssetTypes } from "./asset-types.mjs";
import { normalizeReminders } from "./reminders.mjs";
import { normalizeIntegrationRef } from "./integration-ref.mjs";
import { normalizePhoneNumbers } from "./phone-numbers.mjs";
import { hostedImageUrl } from "./hosted-image.mjs";
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_EDGE = 512;

/** @param {Uint8Array} bytes @param {number} offset */
function uint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** @param {Uint8Array} bytes @param {number} offset @param {string} expected */
function matches(bytes, offset, expected) {
  return [...expected].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0));
}

/** 在图片解码和分配像素内存前检查文件头及尺寸。
 * @param {Uint8Array} bytes
 * @param {string} mime
 */
export function inspectRaster(bytes, mime) {
  let width = 0;
  let height = 0;
  if (mime === "image/png") {
    if (
      bytes.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
      uint32(bytes, 8) !== 13 ||
      !matches(bytes, 12, "IHDR")
    )
      throw new Error("图片内容与格式不匹配。");
    width = uint32(bytes, 16);
    height = uint32(bytes, 20);
  } else if (mime === "image/jpeg") {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error("图片内容与格式不匹配。");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) break;
        height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        break;
      }
      offset += length;
    }
  } else if (mime === "image/webp") {
    if (bytes.length < 30 || !matches(bytes, 0, "RIFF") || !matches(bytes, 8, "WEBP"))
      throw new Error("图片内容与格式不匹配。");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("图片文件不完整。");
    if (matches(bytes, 12, "VP8X")) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (matches(bytes, 12, "VP8L") && bytes[20] === 47) {
      width = 1 + bytes[21] + ((bytes[22] & 63) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10);
    } else if (
      matches(bytes, 12, "VP8 ") &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    }
  } else throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
  if (!width || !height) throw new Error("无法读取图片尺寸。");
  if (width > 8192 || height > 8192 || width * height > 24_000_000)
    throw new Error("图片尺寸过大，最长边不能超过 8192 像素，总像素不能超过 2400 万。");
  return { width, height };
}

/** 持久化只接受重编码后的 PNG，不接受远程 URL 或 SVG。
 * @param {unknown} value
 */
export function validateImageDataUrl(value) {
  if (value === "" || value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 22 + Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    throw new Error("保存的图片不能超过 1 MiB。");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) throw new Error("图片必须是经过处理的 PNG 图片。");
  let binary;
  try {
    binary = atob(match[1]);
  } catch {
    throw new Error("图片编码无效。");
  }
  if (btoa(binary) !== match[1] || binary.length > MAX_IMAGE_BYTES)
    throw new Error("图片编码无效或大小超过限制。");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const { width, height } = inspectRaster(bytes, "image/png");
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE)
    throw new Error("保存的图片最长边不能超过 512 像素。");
  let offset = 8;
  let hasPixels = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    if (length > bytes.length - offset - 12) throw new Error("图片文件不完整。");
    if (matches(bytes, offset + 4, "IDAT") && length > 0) hasPixels = true;
    if (matches(bytes, offset + 4, "IEND")) {
      ended = length === 0 && offset + 12 === bytes.length;
      break;
    }
    offset += length + 12;
  }
  if (!ended || !hasPixels) throw new Error("图片文件不完整。");
  return value;
}

/** @param {unknown} value */
export function safeImageDataUrl(value) {
  try {
    return validateImageDataUrl(value);
  } catch {
    return "";
  }
}

/** @template T
 * @param {T} value
 * @param {{ strict?: boolean, normalize?: (image: unknown) => string }} [options]
 * @returns {T}
 */
export function normalizeSnapshotImages(
  value,
  { strict = true, normalize = validateImageDataUrl } = {},
) {
  if (!value || typeof value !== "object") return value;
  const outer = /** @type {Record<string, unknown>} */ (value);
  const wrapped = Boolean(outer.state && typeof outer.state === "object");
  const state = /** @type {Record<string, unknown>} */ (wrapped ? outer.state : outer);
  const result = { ...state };
  if ("services" in state) result.services = normalizeServices(state.services, strict);
  if ("assetTypes" in state) result.assetTypes = normalizeAssetTypes(state.assetTypes, strict);
  if ("reminders" in state) result.reminders = normalizeReminders(state.reminders, strict);
  if ("phoneNumbers" in state)
    result.phoneNumbers = normalizePhoneNumbers(state.phoneNumbers, strict);
  for (const key of [
    "servers",
    "domains",
    "mailboxes",
    "aiAssets",
    "secrets",
    "certs",
    "services",
  ]) {
    if (!Array.isArray(result[key])) continue;
    result[key] = result[key].map((asset) => {
      if (!asset || typeof asset !== "object") return asset;
      const next = { ...asset };
      if ((key === "servers" || key === "domains") && "integration" in asset) {
        try {
          next.integration = normalizeIntegrationRef(asset.integration);
        } catch (error) {
          if (strict) throw error;
          delete next.integration;
        }
      }
      if (key === "mailboxes" && "senderAvatars" in asset) {
        /** @type {{ address: string, imageDataUrl: string }[]} */
        const avatars = [];
        let totalBytes = 0;
        if (strict && (!Array.isArray(asset.senderAvatars) || asset.senderAvatars.length > 32))
          throw new Error("每个邮箱最多保存 32 个发件人头像。");
        for (const entry of (Array.isArray(asset.senderAvatars) ? asset.senderAvatars : []).slice(
          0,
          32,
        )) {
          try {
            if (
              !entry ||
              typeof entry.address !== "string" ||
              !/^[^\s@<>]+@[^\s@<>]+$/.test(entry.address) ||
              entry.address.length > 254
            )
              throw new Error("发件人邮箱地址无效。");
            const address = entry.address.toLowerCase();
            const imageDataUrl = normalize(entry.imageDataUrl);
            if (!imageDataUrl || avatars.some((avatar) => avatar.address === address)) continue;
            totalBytes += imageDataUrl.length;
            if (totalBytes > 8 * 1024 * 1024) throw new Error("发件人头像总大小不能超过 8 MiB。");
            avatars.push({ address, imageDataUrl });
          } catch (error) {
            if (strict) throw error;
          }
        }
        next.senderAvatars = avatars;
      }
      if (!("imageDataUrl" in asset)) return next;
      try {
        return {
          ...next,
          imageDataUrl: hostedImageUrl(asset.imageDataUrl) || normalize(asset.imageDataUrl),
        };
      } catch (error) {
        if (strict) throw error;
        delete next.imageDataUrl;
        return next;
      }
    });
  }
  return /** @type {T} */ (wrapped ? { ...outer, state: result } : result);
}

/** @param {{ createFromDataURL: (value: string) => { isEmpty(): boolean, getSize(): {width: number, height: number}, toPNG(): { toString(encoding: string): string } } }} nativeImage */
export function createImageNormalizer(nativeImage) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  /** @param {unknown} value */
  return (value) => {
    if (typeof value === "string" && cache.has(value))
      return /** @type {string} */ (cache.get(value));
    const dataUrl = validateImageDataUrl(value);
    if (!dataUrl) return "";
    const decoded = nativeImage.createFromDataURL(dataUrl);
    if (decoded.isEmpty()) throw new Error("图片无法解码，请重新选择图片。");
    const { width, height } = decoded.getSize();
    if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE)
      throw new Error("图片尺寸无效。");
    const normalized = validateImageDataUrl(
      `data:image/png;base64,${decoded.toPNG().toString("base64")}`,
    );
    if (cache.size >= 32) cache.clear();
    cache.set(dataUrl, normalized);
    cache.set(normalized, normalized);
    return normalized;
  };
}
