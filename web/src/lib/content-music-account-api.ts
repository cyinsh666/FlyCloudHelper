import { requestJson } from "@/lib/api";

/** 当前网易账号的公开资料，不包含登录凭据。 */
export interface NeteaseAccountProfile {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  vipType: number;
}

/** 在线音乐库独立保存的网易登录状态。 */
export interface NeteaseAccountState {
  status: "anonymous" | "logged_in" | "expired";
  profile: NeteaseAccountProfile | null;
  checkedAt: string | null;
}

/** 一次性扫码会话，由服务端控制有效期和查询间隔。 */
export interface NeteaseQrSession {
  sessionId: string;
  qrCodeContent: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

/** 扫码进度只返回公开状态；授权成功后附带当前账号。 */
export interface NeteaseQrCheckResult {
  status: "waiting" | "scanned" | "expired" | "authorized" | "verification_required";
  account?: NeteaseAccountState;
  verificationUrl?: string;
}

/** 管理端和个人媒体库共用同一组网易账号接口。 */
function accountPath(libraryId: string, admin: boolean): string {
  return `${admin ? "/api/v1/admin" : "/api/v1"}/libraries/${encodeURIComponent(libraryId)}/content-music/account`;
}

/** 读取账号摘要，不请求或暴露原始登录凭据。 */
export function getNeteaseAccount(libraryId: string, admin = false, signal?: AbortSignal): Promise<NeteaseAccountState> {
  return requestJson(accountPath(libraryId, admin), { signal });
}

/** 为当前音乐库创建网易云扫码登录会话。 */
export function createNeteaseQrSession(libraryId: string, admin = false, signal?: AbortSignal): Promise<NeteaseQrSession> {
  return requestJson(`${accountPath(libraryId, admin)}/qr`, { method: "POST", body: "{}", signal });
}

/** 查询指定会话的扫码状态，关闭弹窗时可取消当前请求。 */
export function checkNeteaseQrSession(libraryId: string, sessionId: string, admin = false, signal?: AbortSignal): Promise<NeteaseQrCheckResult> {
  return requestJson(`${accountPath(libraryId, admin)}/qr/${encodeURIComponent(sessionId)}/check`, {
    method: "POST", body: "{}", signal,
  });
}

/** 主动校验网易登录是否仍然有效。 */
export function checkNeteaseAccount(libraryId: string, admin = false, signal?: AbortSignal): Promise<NeteaseAccountState> {
  return requestJson(`${accountPath(libraryId, admin)}/check`, { method: "POST", body: "{}", signal });
}

/** 验证用户主动提供的网易网页登录会话，由服务端保存有效登录。 */
export function importNeteaseWebSession(libraryId: string, cookie: string, admin = false, signal?: AbortSignal): Promise<NeteaseAccountState> {
  return requestJson(`${accountPath(libraryId, admin)}/session`, {
    method: "POST", body: JSON.stringify({ cookie }), signal,
  });
}

/** 清除当前库的网易登录，音乐目录和 Navidrome 连接继续保留。 */
export function logoutNeteaseAccount(libraryId: string, admin = false, signal?: AbortSignal): Promise<NeteaseAccountState> {
  return requestJson(accountPath(libraryId, admin), { method: "DELETE", signal });
}
