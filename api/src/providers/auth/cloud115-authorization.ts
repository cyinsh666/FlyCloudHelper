import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../../errors.js";
import { findCloud115ClientType, type Cloud115ClientType } from "./cloud115-client-types.js";
import type { CloudAuthorizationDriver, CloudAuthorizationPollResult, CloudAuthorizationStartOptions } from "./types.js";
import { createAuthForm, readAuthData, readAuthNumber, readAuthText, requestAuthJson } from "./http.js";

const CLOUD115_QR_API = "https://qrcodeapi.115.com";

/** 115客户端来源扫码及OpenAPI设备码授权，不依赖FlymbyServer或OpenList。 */
export class Cloud115AuthorizationDriver implements CloudAuthorizationDriver {
  public readonly providerType = "cloud115";

  public constructor(private readonly clientId: string) {}

  /** 按页面选择创建客户端Cookie扫码或原有OpenAPI设备码会话。 */
  public async start(options: CloudAuthorizationStartOptions, signal?: AbortSignal) {
    const selectedClient = findCloud115ClientType(options.clientType || "ipad");
    if (!selectedClient) throw new ApiError(422, "cloud115_client_type_invalid", "不支持的115登录来源");
    if (selectedClient.cookieQr) return this.startCookieQr(selectedClient, signal);
    return this.startOpenApiQr(signal);
  }

  /** 创建带标准 Base64 SHA256 challenge 的OpenAPI设备码。 */
  private async startOpenApiQr(signal?: AbortSignal) {
    const deviceCode = await this.createOpenApiDeviceCode(signal);
    return {
      authMethod: "device_qr",
      qrCodeContent: deviceCode.qrCodeContent || `https://115.com/scan/dg-${deviceCode.uid}`,
      qrCodeImageUrl: `${CLOUD115_QR_API}/api/1.0/web/1.0/qrcode?uid=${encodeURIComponent(deviceCode.uid)}`,
      expiresInSeconds: deviceCode.expiresInSeconds,
      pollIntervalSeconds: 2,
      driverState: {
        flow: "openapi",
        clientType: "openapi",
        uid: deviceCode.uid,
        time: deviceCode.time,
        sign: deviceCode.sign,
        codeVerifier: deviceCode.codeVerifier,
      },
    };
  }

  /** 创建指定115客户端来源的Cookie扫码会话。 */
  private async startCookieQr(selectedClient: Cloud115ClientType, signal?: AbortSignal) {
    const payload = await requestAuthJson(`${CLOUD115_QR_API}/api/1.0/web/1.0/token/`, {
      method: "GET",
      headers: { "User-Agent": "FlyCloudHelper/115CookieQr" },
    }, "cloud115_cookie_qr_create_failed", "115客户端二维码创建失败，请稍后重试", signal);
    const data = readAuthData(payload);
    const uid = readAuthText(data, ["uid"]);
    const sign = readAuthText(data, ["sign"]);
    const qrTime = readAuthNumber(data.time);
    if (!uid || !sign || qrTime <= 0) throw new ApiError(502, "cloud115_cookie_qr_invalid", "115客户端二维码参数不完整");
    return {
      authMethod: "cookie_qr",
      qrCodeContent: readAuthText(data, ["qrcode"]) || `https://115.com/scan/dg-${uid}`,
      qrCodeImageUrl: `${CLOUD115_QR_API}/api/1.0/web/1.0/qrcode?uid=${encodeURIComponent(uid)}`,
      expiresInSeconds: 120,
      pollIntervalSeconds: 2,
      driverState: {
        flow: "cookie_qr",
        clientType: selectedClient.value,
        uid,
        time: qrTime,
        sign,
      },
    };
  }

  /** 创建OpenAPI设备码，既用于直接扫码，也用于Cookie扫码后的自动确认。 */
  private async createOpenApiDeviceCode(signal?: AbortSignal): Promise<{
    uid: string;
    time: number;
    sign: string;
    codeVerifier: string;
    qrCodeContent: string;
    expiresInSeconds: number;
  }> {
    const codeVerifier = randomBytes(48).toString("base64url").slice(0, 64);
    // 关键变量：115 要求标准 Base64，不能使用 OAuth 常见的 base64url。
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64");
    const payload = await requestAuthJson(`${CLOUD115_QR_API}/open/authDeviceCode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FlyCloudHelper/115Open" },
      body: createAuthForm({ client_id: this.clientId, code_challenge: codeChallenge, code_challenge_method: "sha256" }),
    }, "cloud115_device_code_failed", "115二维码创建失败，请稍后重试", signal);
    const data = readAuthData(payload);
    const uid = readAuthText(data, ["uid"]);
    if (!uid) throw new ApiError(502, "cloud115_device_code_invalid", "115二维码参数不完整");
    return {
      uid,
      time: readAuthNumber(data.time),
      sign: readAuthText(data, ["sign"]),
      codeVerifier,
      qrCodeContent: readAuthText(data, ["qrcode"]),
      expiresInSeconds: Math.max(60, readAuthNumber(data.expires_in, 120)),
    };
  }

  /** 查询设备码状态，保留 115 定义的等待、已扫和确认状态。 */
  public async poll(state: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult> {
    const query = new URLSearchParams({ uid: String(state.uid ?? "") });
    if (Number(state.time) > 0) query.set("time", String(state.time));
    if (state.sign) query.set("sign", String(state.sign));
    const payload = await requestAuthJson(`${CLOUD115_QR_API}/get/status/?${query}`, {
      method: "GET", headers: { "User-Agent": "FlyCloudHelper/115Open" },
    }, "cloud115_qr_poll_failed", "115扫码状态查询失败，请稍后重试", signal);
    const data = readAuthData(payload);
    const status = readAuthNumber(data.status, 99);
    if (status === 1) return { state: "scanned", retryAfterSeconds: 2, message: "已扫码，请在115客户端确认" };
    if (status === 2) return { state: "confirmed", retryAfterSeconds: 1, message: "已确认，正在完成授权" };
    if (status === -1) return { state: "expired", retryAfterSeconds: 0, message: "二维码已过期" };
    if (status === -2) return { state: "cancelled", retryAfterSeconds: 0, message: "已取消登录" };
    return { state: "waiting", retryAfterSeconds: 2, message: "请使用115客户端扫码" };
  }

  /** 按会话来源直接交换Token，或先取得客户端Cookie再自动确认OpenAPI设备码。 */
  public async complete(state: Record<string, unknown>, signal?: AbortSignal) {
    if (String(state.flow ?? "") === "cookie_qr") return this.completeCookieQr(state, signal);
    return this.exchangeOpenApiToken(state, "device_qr", "openapi", signal);
  }

  /** 使用已确认的客户端二维码取得短期Cookie，并在内存中转换为OpenAPI Token。 */
  private async completeCookieQr(state: Record<string, unknown>, signal?: AbortSignal) {
    const selectedClient = findCloud115ClientType(state.clientType);
    if (!selectedClient?.cookieQr) throw new ApiError(422, "cloud115_client_type_invalid", "115登录来源已失效，请重新扫码");
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (selectedClient.userAgent) headers["User-Agent"] = selectedClient.userAgent;
    const cookiePayload = await requestAuthJson(
      `${CLOUD115_QR_API}/app/1.0/${selectedClient.requestApp}/1.0/login/qrcode/`,
      { method: "POST", headers, body: createAuthForm({ account: String(state.uid ?? "") }) },
      "cloud115_cookie_missing",
      "115客户端扫码未返回登录凭据，请重新扫码",
      signal,
    );
    const cookieHeader = this.formatCookieHeader(readAuthData(cookiePayload).cookie);
    if (!cookieHeader) throw new ApiError(502, "cloud115_cookie_missing", "115客户端扫码未返回登录凭据，请重新扫码");

    // 关键变量：Cookie仅存在于本次方法局部变量，转换完成后不会写入授权会话或服务凭据。
    const deviceCode = await this.createOpenApiDeviceCode(signal);
    const cookieHeaders = { Cookie: cookieHeader, "User-Agent": "FlyCloudHelper/115CookieQr" };
    const scanPayload = await requestAuthJson(`${CLOUD115_QR_API}/api/2.0/prompt.php?${new URLSearchParams({ uid: deviceCode.uid })}`, {
      method: "GET", headers: cookieHeaders,
    }, "cloud115_openapi_scan_failed", "115客户端登录转换失败，请重新扫码", signal);
    this.requireOperationSuccess(scanPayload, "cloud115_openapi_scan_failed", "115 OpenAPI自动扫码失败");
    const confirmQuery = new URLSearchParams({ key: deviceCode.uid, uid: deviceCode.uid, client: "0" });
    const confirmPayload = await requestAuthJson(`${CLOUD115_QR_API}/api/2.0/slogin.php?${confirmQuery}`, {
      method: "GET", headers: cookieHeaders,
    }, "cloud115_openapi_confirm_failed", "115客户端登录转换失败，请重新扫码", signal);
    this.requireOperationSuccess(confirmPayload, "cloud115_openapi_confirm_failed", "115 OpenAPI自动确认失败");
    return this.exchangeOpenApiToken({ uid: deviceCode.uid, codeVerifier: deviceCode.codeVerifier }, "cookie_qr", selectedClient.value, signal);
  }

  /** 使用设备码和verifier换取可刷新的OpenAPI Token。 */
  private async exchangeOpenApiToken(
    state: Record<string, unknown>,
    authMethod: string,
    clientType: string,
    signal?: AbortSignal,
  ) {
    const payload = await requestAuthJson(`${CLOUD115_QR_API}/open/deviceCodeToToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FlyCloudHelper/115Open" },
      body: createAuthForm({ uid: String(state.uid ?? ""), code_verifier: String(state.codeVerifier ?? "") }),
    }, "cloud115_token_exchange_failed", "115授权凭据获取失败，请重新扫码", signal);
    const data = readAuthData(payload);
    const accessToken = readAuthText(data, ["access_token", "accessToken"]);
    const refreshToken = readAuthText(data, ["refresh_token", "refreshToken"]);
    if (!accessToken || !refreshToken) throw new ApiError(502, "cloud115_token_invalid", "115未返回完整登录凭据");
    const expiresIn = Math.max(0, readAuthNumber(data.expires_in));
    return {
      connection: {
        accessToken,
        refreshToken,
        expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1_000 : 0,
        authMethod,
        clientType,
        authSource: "flycloud_helper",
      },
      accountSummary: null,
    };
  }

  /** 把115返回的Cookie对象或文本转换为仅供本次请求使用的Cookie头。 */
  private formatCookieHeader(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    return Object.entries(value as Record<string, unknown>)
      .filter(([name, item]) => Boolean(name) && item !== null && item !== undefined && String(item))
      .map(([name, item]) => `${name}=${String(item)}`)
      .join("; ");
  }

  /** 校验115自动扫码和确认接口明确返回成功。 */
  private requireOperationSuccess(payload: Record<string, unknown>, errorCode: string, message: string): void {
    const code = readAuthNumber(payload.code, 0);
    if (code !== 0 || payload.state === false || payload.state === 0) {
      throw new ApiError(502, errorCode, message);
    }
  }
}
