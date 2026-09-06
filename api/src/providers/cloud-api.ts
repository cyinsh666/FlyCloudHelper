import { ApiError } from "../errors.js";
import { providerFetch, type ProviderNetworkOptions } from "./network.js";

/** 请求固定网盘 API 并返回 JSON 文本，调用方可在解析前保护 64 位 ID。 */
export async function requestCloudApiText(
  url: string | URL,
  init: RequestInit,
  networkOptions: ProviderNetworkOptions,
  signal?: AbortSignal,
): Promise<{ text: string; response: Response }> {
  const response = await providerFetch(url, init, networkOptions, signal);
  const text = await response.text();
  if (!response.ok) throw new ApiError(502, "provider_upstream_failed", `网盘接口返回 HTTP ${response.status}`);
  return { text, response };
}

/** 解析 JSON 对象，并将常见 64 位资源 ID 保护为字符串。 */
export function parseCloudApiObject(text: string, idFields: string[] = []): Record<string, unknown> {
  let protectedText = text;
  for (const field of idFields) {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    protectedText = protectedText.replace(new RegExp(`("${escapedField}"\\s*:\\s*)(-?\\d+)(?=\\s*[,}])`, "gu"), "$1\"$2\"");
  }
  try {
    const payload = JSON.parse(protectedText) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  } catch { /* 转为稳定错误。 */ }
  throw new ApiError(502, "provider_response_invalid", "网盘接口响应无法解析");
}

/** 把未知对象字段读取为普通对象。 */
export function readCloudRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 按候选字段读取文本，资源 ID 不经过 Number。 */
export function readCloudText(record: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
  }
  return "";
}

/** 读取安全非负数字。 */
export function readCloudNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 使用 Provider 的临时地址读取不超过 4MB 的 NFO、字幕等小文本。 */
export async function readCloudTextFile(
  access: { url: string; headers: Record<string, string> },
  networkOptions: ProviderNetworkOptions,
  signal?: AbortSignal,
): Promise<string> {
  const response = await providerFetch(access.url, { method: "GET", headers: access.headers }, networkOptions, signal);
  if (!response.ok) throw new ApiError(502, "provider_text_read_failed", `网盘文本读取失败：HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 4 * 1024 * 1024) throw new ApiError(413, "provider_text_too_large", "网盘文本文件超过 4MB，已停止读取");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new ApiError(413, "provider_text_too_large", "网盘文本文件超过 4MB，已停止读取");
  return text;
}
