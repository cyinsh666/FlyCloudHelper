import { ApiError } from "../../errors.js";
import type { CloudAuthorizationDriver, CloudAuthorizationPollResult, CloudAuthorizationStartOptions } from "./types.js";
import { absorbResponseCookies, createCookieHeader } from "./cookie.js";
import { createAuthForm, readAuthNumber, readAuthText } from "./http.js";

const CLOUD189_WEB = "https://cloud.189.cn";
const CLOUD189_AUTH = "https://open.e.189.cn";
const CLOUD189_API = "https://api.cloud.189.cn";
const CLOUD189_APP_ID = "8025431004";
const CLOUD189_RETURN_URL = "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html";
const CLOUD189_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

/** 天翼云盘个人云 PC 扫码授权，不经过 FlymbyServer。 */
export class Cloud189AuthorizationDriver implements CloudAuthorizationDriver {
  public readonly providerType = "cloud189";

  /** 初始化 PC 登录页参数并创建官方二维码 UUID。 */
  public async start(_options: CloudAuthorizationStartOptions, signal?: AbortSignal) {
    const cookies: Record<string, string> = {};
    const pageUrl = new URL("/api/portal/unifyLoginForPC.action", CLOUD189_WEB);
    pageUrl.search = new URLSearchParams({
      appId: CLOUD189_APP_ID, clientType: "10020", returnURL: CLOUD189_RETURN_URL, timeStamp: String(Date.now()),
    }).toString();
    const html = await this.requestText(pageUrl.href, { method: "GET" }, cookies, "cloud189_qr_init_failed", signal);
    const lt = this.readHtmlValue(html, /\blt\s*=\s*['"](.+?)['"]/u);
    const reqId = this.readHtmlValue(html, /\breqId\s*=\s*['"](.+?)['"]/u);
    const paramId = this.readHtmlValue(html, /\bparamId\s*=\s*['"](.+?)['"]/u);
    const captchaToken = this.readHtmlValue(html, /['"]captchaToken['"]\s+value=['"](.+?)['"]/u);
    if (!lt || !reqId || !paramId || !captchaToken) throw new ApiError(502, "cloud189_qr_params_invalid", "天翼云盘登录参数解析失败");
    const uuidPayload = await this.requestJson(`${CLOUD189_AUTH}/api/logbox/oauth2/getUUID.do`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createAuthForm({ appId: CLOUD189_APP_ID }),
    }, cookies, "cloud189_qr_create_failed", signal);
    const qrCodeContent = readAuthText(uuidPayload, ["uuid"]);
    const encryptedUuid = readAuthText(uuidPayload, ["encryuuid"]);
    if (!qrCodeContent || !encryptedUuid) throw new ApiError(502, "cloud189_qr_uuid_invalid", "天翼云盘二维码参数不完整");
    return {
      authMethod: "qr", qrCodeContent, expiresInSeconds: 300, pollIntervalSeconds: 2,
      driverState: { cookies, lt, reqId, paramId, captchaToken, qrCodeContent, encryptedUuid, redirectUrl: "" },
    };
  }

  /** 查询扫码状态，成功时仅在服务端短会话保存重定向地址。 */
  public async poll(state: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult> {
    if (String(state.redirectUrl ?? "")) return { state: "confirmed", retryAfterSeconds: 1 };
    const now = new Date();
    const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      + `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
    const cookies = state.cookies as Record<string, string>;
    const payload = await this.requestJson(`${CLOUD189_AUTH}/api/logbox/oauth2/qrcodeLoginState.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: CLOUD189_AUTH, Reqid: String(state.reqId ?? ""), lt: String(state.lt ?? "") },
      body: createAuthForm({
        appId: CLOUD189_APP_ID, clientType: "10020", returnUrl: CLOUD189_RETURN_URL,
        paramId: String(state.paramId ?? ""), uuid: String(state.qrCodeContent ?? ""),
        encryuuid: String(state.encryptedUuid ?? ""), date: dateText, timeStamp: Date.now(),
        cb_SaveName: "0", isOauth2: "true", state: "",
      }),
    }, cookies, "cloud189_qr_poll_failed", signal);
    const status = readAuthNumber(payload.status ?? payload.result ?? payload.code, Number.NaN);
    if (status === 0) {
      const nestedData = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
      const nestedResult = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
      const redirectUrl = readAuthText(payload, ["redirectUrl", "redirectURL", "redirect_url", "RedirectUrl", "RedirectURL", "url", "loginUrl"])
        || readAuthText(nestedData, ["redirectUrl", "redirectURL", "redirect_url", "RedirectUrl", "RedirectURL", "url", "loginUrl"])
        || readAuthText(nestedResult, ["redirectUrl", "redirectURL", "redirect_url", "RedirectUrl", "RedirectURL", "url", "loginUrl"]);
      if (!redirectUrl.startsWith("https://")) throw new ApiError(502, "cloud189_qr_redirect_invalid", "天翼云盘扫码结果缺少授权地址");
      state.redirectUrl = redirectUrl;
      return { state: "confirmed", retryAfterSeconds: 1, message: "已确认，正在完成授权" };
    }
    if (status === -11001) return { state: "expired", retryAfterSeconds: 0, message: "二维码已过期" };
    if (status === -106 || status === -11002) return { state: "waiting", retryAfterSeconds: 2, message: "请使用天翼云盘客户端扫码" };
    throw new ApiError(502, "cloud189_qr_status_invalid", "天翼云盘扫码状态返回无效");
  }

  /** 使用扫码成功的重定向地址换取个人云会话材料。 */
  public async complete(state: Record<string, unknown>, signal?: AbortSignal) {
    const redirectUrl = String(state.redirectUrl ?? "").trim();
    if (!redirectUrl) throw new ApiError(409, "provider_auth_not_confirmed", "请先在天翼云盘客户端确认登录");
    const url = new URL("/getSessionForPC.action", CLOUD189_API);
    url.search = new URLSearchParams({ clientType: "TELEPC", version: "6.2", channelId: "web_cloud.189.cn", redirectURL: redirectUrl }).toString();
    const payload = await this.requestJson(url.href, { method: "POST", headers: { "Content-Type": "application/json" } },
      state.cookies as Record<string, string>, "cloud189_token_exchange_failed", signal);
    const accessToken = readAuthText(payload, ["accessToken", "access_token"]);
    const refreshToken = readAuthText(payload, ["refreshToken"]);
    const sessionKey = readAuthText(payload, ["sessionKey"]);
    const sessionSecret = readAuthText(payload, ["sessionSecret"]);
    if (!accessToken || !refreshToken || !sessionKey || !sessionSecret) throw new ApiError(502, "cloud189_token_invalid", "天翼云盘未返回完整登录凭据");
    const loginName = readAuthText(payload, ["loginName"]);
    return { connection: { accessToken, refreshToken, sessionKey, sessionSecret, loginName }, accountSummary: this.maskAccount(loginName) };
  }

  /** 清除内存中 Cookie 和重定向凭据。 */
  public dispose(state: Record<string, unknown>): void {
    if (state.cookies && typeof state.cookies === "object") Object.keys(state.cookies as object).forEach((key) => delete (state.cookies as Record<string, unknown>)[key]);
    state.redirectUrl = "";
  }

  /** 请求官方页面，有限跟随官方 189 域跳转并维护 Cookie。 */
  private async requestText(url: string, init: RequestInit, cookies: Record<string, string>, errorCode: string, signal?: AbortSignal): Promise<string> {
    let current = url;
    for (let index = 0; index < 4; index += 1) {
      try {
        const response = await fetch(current, { ...init, signal, redirect: "manual", headers: { "User-Agent": CLOUD189_UA, Cookie: createCookieHeader(cookies), ...init.headers } });
        absorbResponseCookies(response, cookies);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get("location") ?? "", current);
          if (!next.hostname.endsWith("189.cn")) throw new Error("invalid redirect");
          current = next.href;
          init = { method: "GET" };
          continue;
        }
        if (!response.ok) throw new Error("http");
        return response.text();
      } catch { throw new ApiError(503, errorCode, "天翼云盘授权服务暂不可用"); }
    }
    throw new ApiError(502, errorCode, "天翼云盘登录跳转次数过多");
  }

  /** 请求天翼 JSON 接口并保留同一授权会话的 Cookie。 */
  private async requestJson(url: string, init: RequestInit, cookies: Record<string, string>, errorCode: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const text = await this.requestText(url, init, cookies, errorCode, signal);
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
    } catch { /* 转为稳定错误。 */ }
    throw new ApiError(502, errorCode, "天翼云盘接口响应异常");
  }

  /** 从 PC 登录页读取指定会话参数。 */
  private readHtmlValue(html: string, pattern: RegExp): string { return pattern.exec(html)?.[1]?.trim() ?? ""; }

  /** 页面仅展示脱敏账号。 */
  private maskAccount(value: string): string | null {
    if (!value) return null;
    return value.length <= 4 ? `${value.slice(0, 1)}***` : `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
}
