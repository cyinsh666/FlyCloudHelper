import { ApiError } from "../errors.js";
import { nativeHash } from "./store.js";
import type { NativeContext } from "./types.js";

/** 控制正文只接受普通对象，不把数组或空值解释成有效操作。 */
export function nativeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "请求正文必须是对象");
  return value as Record<string, unknown>;
}

/** 校验有限文本，稳定身份不能通过静默截断改变。 */
export function nativeText(value: unknown, name: string, maximum = 128): string {
  if (typeof value !== "string" || value.length < 1 || [...value].length > maximum) throw new ApiError(400, "invalid_request", `${name}不能为空且不能超过${maximum}个字符`);
  return value;
}

/** 章内位置和实际听时均必须是有限的非负秒数。 */
export function nativeSeconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 315360000) throw new ApiError(400, "invalid_position", `${name}必须是有效的非负秒数`);
  return value;
}

/** JSON 修订号按十进制大整数保存，禁止转为浮点比较。 */
export function nativeRevision(value: unknown, name = "ExpectedRevision"): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw new ApiError(400, "invalid_revision", `${name}必须是十进制整数字符串`);
  return value;
}

/** 业务修订号独立于既有 KV 行版本。 */
export function nextRevision(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > 99999999999999999999n) throw new ApiError(409, "native_revision_exhausted", "状态版本无法继续递增");
  return next.toString();
}

/** 普通列表不允许零值、无限量或隐式裁剪超限请求。 */
export function nativeLimit(value: unknown, defaultLimit = 30): number {
  if (value === undefined) return defaultLimit;
  const limit = typeof value === "number" ? value : typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "invalid_limit", "分页数量必须在1到100之间");
  return limit;
}

/** 游标绑定入口、账号和当前授权，不能跨资源或权限范围复用。 */
export function nativeCursorScope(context: NativeContext, kind: string): string {
  return nativeHash(JSON.stringify([context.service.ServiceId, context.account.AccountId, context.service.PermissionsRevision, context.account.PermissionsRevision, kind]));
}

/** 游标不携带凭据，只保存有界主键与版本。 */
export function encodeNativeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** 拒绝超长或格式损坏的游标，不退回第一页造成漏重。 */
export function decodeNativeCursor(value: unknown, scope: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 2048) throw new ApiError(400, "invalid_cursor", "分页游标无效");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!parsed || parsed.Scope !== scope) throw new Error("scope");
    return parsed;
  } catch { throw new ApiError(400, "invalid_cursor", "分页游标无效或授权已改变"); }
}
