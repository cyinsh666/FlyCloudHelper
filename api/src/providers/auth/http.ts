import { ApiError } from "../../errors.js";

/** 读取上游对象中的首个非空文本，不把完整响应拼进异常。 */
export function readAuthText(source: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** 读取上游数字字段；格式异常时返回默认值。 */
export function readAuthNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 对固定官方 HTTPS 地址发起请求，并只接受 JSON 对象。 */
export async function requestAuthJson(
  url: string,
  init: RequestInit,
  errorCode: string,
  message: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new ApiError(500, "provider_auth_url_invalid", "网盘授权地址配置无效");
  try {
    const response = await fetch(target, { ...init, signal, redirect: "manual" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid json");
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, errorCode, message);
  }
}

/** 生成 application/x-www-form-urlencoded 请求体。 */
export function createAuthForm(values: Record<string, string | number>): URLSearchParams {
  const form = new URLSearchParams();
  Object.entries(values).forEach(([name, value]) => form.set(name, String(value)));
  return form;
}

/** 从多种 data 包装中读取业务对象。 */
export function readAuthData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : payload;
}
