import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import type { CloudAuthorizationDriver, CloudAuthorizationPollResult, CloudAuthorizationStartOptions } from "./types.js";
import { readAuthData, readAuthNumber, readAuthText, requestAuthJson } from "./http.js";

const CLOUD123_LOGIN = "https://login.123pan.com";

/** 123云盘 App 扫码授权；按产品确认只提供扫码，不开放账号密码。 */
export class Cloud123AuthorizationDriver implements CloudAuthorizationDriver {
  public readonly providerType = "cloud123";

  /** 为一次授权生成稳定设备指纹和二维码。 */
  public async start(_options: CloudAuthorizationStartOptions, signal?: AbortSignal) {
    const loginUuid = randomUUID();
    const deviceType = "M2012K11AC";
    const osVersion = "Android_13";
    const headers = this.createQrHeaders(loginUuid);
    const payload = await requestAuthJson(`${CLOUD123_LOGIN}/api/user/qr-code/generate`, {
      method: "GET", headers,
    }, "cloud123_qr_create_failed", "123云盘二维码创建失败，请稍后重试", signal);
    if (readAuthNumber(payload.code, -1) !== 0) throw new ApiError(502, "cloud123_qr_create_failed", "123云盘二维码创建失败");
    const data = readAuthData(payload);
    const uniId = readAuthText(data, ["uniID"]);
    const qrBase = readAuthText(data, ["url"]);
    if (!uniId || !qrBase.startsWith("https://")) throw new ApiError(502, "cloud123_qr_invalid", "123云盘二维码参数不完整");
    const separator = qrBase.includes("?") ? "&" : "?";
    return {
      authMethod: "app_qr",
      qrCodeContent: `${qrBase}${separator}${new URLSearchParams({ env: "production", uniID: uniId, source: "123pan", type: "login" })}`,
      expiresInSeconds: 300,
      pollIntervalSeconds: 2,
      driverState: { loginUuid, deviceType, osVersion, uniId, pendingToken: "" },
    };
  }

  /** 查询 123 App 扫码结果，确认后的 Token 只写入短会话内部状态。 */
  public async poll(state: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult> {
    const query = new URLSearchParams({ uniID: String(state.uniId ?? "") });
    const payload = await requestAuthJson(`${CLOUD123_LOGIN}/api/user/qr-code/result?${query}`, {
      method: "GET", headers: this.createQrHeaders(String(state.loginUuid ?? "")),
    }, "cloud123_qr_poll_failed", "123云盘扫码状态查询失败，请稍后重试", signal);
    const data = readAuthData(payload);
    const code = readAuthNumber(payload.code, -1);
    if (code === 200) {
      if (readAuthNumber(data.login_type) !== 7) return { state: "failed", retryAfterSeconds: 0, errorCode: "cloud123_qr_platform_unsupported", message: "请使用123 App扫码登录" };
      const token = readAuthText(data, ["token"]);
      if (!token) throw new ApiError(502, "cloud123_token_invalid", "123云盘扫码结果缺少登录凭据");
      state.pendingToken = token;
      return { state: "confirmed", retryAfterSeconds: 1, message: "已确认，正在完成授权" };
    }
    if (code !== 0) throw new ApiError(502, "cloud123_qr_status_invalid", "123云盘扫码状态返回无效");
    const loginStatus = readAuthNumber(data.loginStatus, -1);
    if (loginStatus === 1) return { state: "scanned", retryAfterSeconds: 2, message: "已扫码，请在123 App确认" };
    if (loginStatus === 2) return { state: "rejected", retryAfterSeconds: 0, message: "已拒绝登录" };
    if (loginStatus === 4) return { state: "expired", retryAfterSeconds: 0, message: "二维码已过期" };
    return { state: "waiting", retryAfterSeconds: 2, message: "请使用123 App扫码" };
  }

  /** 123扫码结果本身就是业务 Token，补充设备指纹后交给服务连接。 */
  public async complete(state: Record<string, unknown>) {
    const token = String(state.pendingToken ?? "").trim();
    if (!token) throw new ApiError(409, "provider_auth_not_confirmed", "请先在123 App确认登录");
    return {
      connection: {
        accessToken: token,
        deviceType: String(state.deviceType ?? ""),
        osVersion: String(state.osVersion ?? ""),
        loginUuid: String(state.loginUuid ?? ""),
      },
      accountSummary: null,
    };
  }

  /** 构造与现有 123 Android 业务协议一致的设备请求头。 */
  private createQrHeaders(loginUuid: string): Record<string, string> {
    return {
      "accept-encoding": "gzip", devicename: "Xiaomi", "x-app-version": "2.4.0",
      loginuuid: loginUuid, "app-version": "3", platform: "web",
      "content-type": "application/json;charset=UTF-8",
    };
  }
}
