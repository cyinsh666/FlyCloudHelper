import { randomBytes } from "node:crypto";
import { ApiError } from "../../errors.js";
import type { CloudAuthorizationDriver, CloudAuthorizationPollResult, CloudAuthorizationStartOptions } from "./types.js";
import { absorbResponseCookies, createCookieHeader } from "./cookie.js";
import { readAuthData, readAuthNumber, readAuthText } from "./http.js";

const QUARK_CAS = "https://uop.quark.cn/cas/ajax";
const QUARK_PAN = "https://pan.quark.cn";
const QUARK_DRIVE = "https://drive.quark.cn/1/clouddrive";
const QUARK_LOGIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36";
const QUARK_CLIENT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4";

/** 夸克 CAS 将扫码 token 和确认票据都放在 data.members 中。 */
function readQuarkMembers(payload: Record<string, unknown>): Record<string, unknown> {
  const members = readAuthData(payload).members;
  return members && typeof members === "object" && !Array.isArray(members)
    ? members as Record<string, unknown>
    : {};
}

/** 夸克 CAS 扫码驱动，最终只向凭据仓保存业务 Cookie。 */
export class QuarkAuthorizationDriver implements CloudAuthorizationDriver {
  public readonly providerType = "quark";

  /** 获取 CAS token 并构造夸克 App 可识别的二维码地址。 */
  public async start(_options: CloudAuthorizationStartOptions, signal?: AbortSignal) {
    const cookies: Record<string, string> = {};
    const query = new URLSearchParams({ client_id: "532", v: "1.2", request_id: randomBytes(16).toString("hex") });
    const payload = await this.requestJson(`${QUARK_CAS}/getTokenForQrcodeLogin?${query}`, cookies, false, signal);
    const status = readAuthNumber(payload.status);
    const token = readAuthText(readQuarkMembers(payload), ["token"]);
    if (status !== 2_000_000 || !token) {
      console.warn(`[codex-quark-qr-auth] 阶段=创建二维码 结果=失败 上游状态码=${status} 是否包含令牌=${Boolean(token)}`);
      throw new ApiError(502, "quark_qr_create_failed", "夸克二维码创建失败");
    }
    console.info(`[codex-quark-qr-auth] 阶段=创建二维码 结果=成功 上游状态码=${status}`);
    const qrQuery = new URLSearchParams({ token, client_id: "532", ssb: "weblogin", uc_param_str: "", uc_biz_str: "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0" });
    return { authMethod: "qr", qrCodeContent: `https://su.quark.cn/4_eMHBJ?${qrQuery}`, expiresInSeconds: 300, pollIntervalSeconds: 2, driverState: { token, ticket: "", cookies } };
  }

  /** 查询 CAS service ticket，票据只保留在服务端短会话。 */
  public async poll(state: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult> {
    if (String(state.ticket ?? "")) return { state: "confirmed", retryAfterSeconds: 1 };
    const query = new URLSearchParams({ client_id: "532", v: "1.2", token: String(state.token ?? ""), request_id: randomBytes(16).toString("hex") });
    const payload = await this.requestJson(`${QUARK_CAS}/getServiceTicketByQrcodeToken?${query}`, state.cookies as Record<string, string>, false, signal);
    const status = readAuthNumber(payload.status);
    const ticket = readAuthText(readQuarkMembers(payload), ["service_ticket"]);
    if (status === 2_000_000 && ticket) {
      state.ticket = ticket;
      console.info(`[codex-quark-qr-auth] 阶段=扫码确认 结果=成功 上游状态码=${status}`);
      return { state: "confirmed", retryAfterSeconds: 1, message: "已确认，正在完成授权" };
    }
    if ([5_000_400_2, 5_000_400_3, 5_000_400_4].includes(status)) return { state: "failed", retryAfterSeconds: 0, message: "二维码已失效，请重新扫码" };
    return { state: "waiting", retryAfterSeconds: 2, message: "请使用夸克 App扫码" };
  }

  /** 使用 service ticket 完成 Cookie 交换并验证根目录。 */
  public async complete(state: Record<string, unknown>, signal?: AbortSignal) {
    const ticket = String(state.ticket ?? "").trim();
    if (!ticket) throw new ApiError(409, "provider_auth_not_confirmed", "请先使用夸克 App扫码并确认");
    const cookies = state.cookies as Record<string, string>;
    await this.requestText(`${QUARK_PAN}/account/info?${new URLSearchParams({ st: ticket, lw: "scan" })}`, cookies, false, signal);
    await this.requestText(`${QUARK_PAN}/`, cookies, false, signal);
    const query = new URLSearchParams({ pr: "ucpro", fr: "pc", pdir_fid: "0", _page: "1", _size: "1", _fetch_total: "1" });
    const payload = await this.requestJson(`${QUARK_DRIVE}/file/sort?${query}`, cookies, true, signal);
    const data = readAuthData(payload);
    if (readAuthNumber(payload.code, -1) !== 0 || !Array.isArray(data.list)) throw new ApiError(502, "quark_cookie_bootstrap_failed", "夸克登录凭据无法访问目录，请重新扫码");
    const cookie = createCookieHeader(cookies);
    if (!cookie) throw new ApiError(502, "quark_cookie_missing", "夸克未返回登录凭据");
    return { connection: { cookie }, accountSummary: null };
  }

  /** 擦除授权票据和 Cookie。 */
  public dispose(state: Record<string, unknown>): void {
    state.token = "";
    state.ticket = "";
    if (state.cookies && typeof state.cookies === "object") Object.keys(state.cookies as object).forEach((key) => delete (state.cookies as Record<string, unknown>)[key]);
  }

  /** 有限跟随夸克官方域跳转，并在每跳收集 Cookie。 */
  private async requestText(url: string, cookies: Record<string, string>, drive: boolean, signal?: AbortSignal): Promise<string> {
    let current = url;
    for (let index = 0; index < 6; index += 1) {
      const target = new URL(current);
      if (target.protocol !== "https:" || (target.hostname !== "quark.cn" && !target.hostname.endsWith(".quark.cn"))) throw new ApiError(502, "quark_redirect_invalid", "夸克返回未知跳转地址");
      try {
        const response = await fetch(target, { method: "GET", signal, redirect: "manual", headers: {
          "User-Agent": drive ? QUARK_CLIENT_UA : QUARK_LOGIN_UA, Referer: `${QUARK_PAN}/`,
          Accept: drive ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml,*/*",
          Cookie: createCookieHeader(cookies), ...(drive ? { Origin: QUARK_PAN } : {}),
        } });
        absorbResponseCookies(response, cookies);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          current = new URL(response.headers.get("location") ?? "", current).href;
          continue;
        }
        if (!response.ok) throw new Error("http");
        return response.text();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, "quark_upstream_unavailable", "夸克授权服务暂不可用");
      }
    }
    throw new ApiError(502, "quark_redirect_limit", "夸克登录跳转次数过多");
  }

  /** 解析夸克 JSON 对象，不暴露上游正文。 */
  private async requestJson(url: string, cookies: Record<string, string>, drive: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const text = await this.requestText(url, cookies, drive, signal);
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
    } catch { /* 转为稳定错误。 */ }
    throw new ApiError(502, "quark_response_invalid", "夸克接口响应异常，请重试");
  }
}
