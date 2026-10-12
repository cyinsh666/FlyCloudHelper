import { randomBytes, randomInt } from "node:crypto";
import { ApiError, validationError } from "../errors.js";
import { providerFetch } from "../providers/network.js";
import { createNeteaseEapiBody } from "./netease-eapi-request.js";
import { createNeteaseWebBody } from "./netease-web-request.js";

/** 网易账号公开资料；登录凭据由调用方另行加密保存。 */
export interface NeteaseAccountProfile {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  vipType: number;
}

/** 扫码状态的 Cookie 仅供宿主更新本次临时登录上下文，不返回管理页面。 */
export interface NeteaseQrCheckResult {
  status: "waiting" | "scanned" | "expired" | "authorized" | "verification_required";
  cookie: string;
  /** 本次登录所需的网易官方验证入口，仅返回所属登录会话，不写入日志。 */
  verificationUrl?: string;
}

// 关键变量：账号查询固定使用网页原站，扫码固定使用 Alger 4.30.0 的 EAPI 原站，Cookie 不发送给音频 CDN。
const NETEASE_ORIGIN = "https://music.163.com";
const NETEASE_QR_ORIGIN = "https://interface.music.163.com";
const NETEASE_LOGIN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// 关键变量：扫码参数与设备默认值来自 netease-cloud-music-api-alger 4.30.0，不与网页 type=1 混用。
const NETEASE_QR_TYPE = 3;
const NETEASE_QR_USER_AGENT = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const NETEASE_QR_OS_VERSION = "Microsoft-Windows-10-Professional-build-19045-64bit";
const NETEASE_QR_APP_VERSION = "3.1.17.204416";
const MAX_COOKIE_LENGTH = 32 * 1024;

/** 校验请求 Cookie 键值，避免把换行、Set-Cookie 属性或无效值带进请求头。 */
export function validateNeteaseCookie(cookie: string): string {
  if (typeof cookie !== "string" || Buffer.byteLength(cookie) > MAX_COOKIE_LENGTH || /[\r\n\u0000]/u.test(cookie)) {
    throw validationError("cookie", "网易登录凭据格式无效");
  }
  if (!cookie.trim()) return "";
  const pairs = cookie.split(";").map((part) => part.trim());
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator < 1 || !/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/u.test(name)
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(value)
      || /^(?:domain|path|expires|max-age|samesite|secure|httponly)$/iu.test(name)) {
      throw validationError("cookie", "网易登录凭据格式无效");
    }
  }
  return pairs.join("; ");
}

/** 读取已验证 Cookie 的键值，保留值内的等号。 */
function readNeteaseCookiePairs(cookie: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const checked = validateNeteaseCookie(cookie);
  if (!checked) return pairs;
  for (const part of checked.split("; ")) {
    const separator = part.indexOf("=");
    pairs.set(part.slice(0, separator), part.slice(separator + 1));
  }
  return pairs;
}

/** 按固定网易响应主机合并 Set-Cookie，忽略属性并删除明确过期的 Cookie。 */
export function mergeNeteaseCookies(cookie: string, setCookies: readonly string[], responseHost: "music.163.com" | "interface.music.163.com" = "music.163.com"): string {
  const pairs = readNeteaseCookiePairs(cookie);
  for (const header of setCookies) {
    if (Buffer.byteLength(header) > MAX_COOKIE_LENGTH || /[\r\n\u0000]/u.test(header)) {
      throw new ApiError(502, "content_music_cookie_invalid", "网易登录接口返回了无效凭据");
    }
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    if (!pair) continue;
    const domain = attributes.find((part) => /^domain=/iu.test(part))?.slice(7).toLowerCase().replace(/^\./u, "");
    if (domain && domain !== responseHost && !(responseHost.endsWith(`.${domain}`) && (domain === "music.163.com" || domain === "163.com"))) continue;
    let checkedPair: string;
    try { checkedPair = validateNeteaseCookie(pair); }
    catch { throw new ApiError(502, "content_music_cookie_invalid", "网易登录接口返回了无效凭据"); }
    const separator = checkedPair.indexOf("=");
    const name = checkedPair.slice(0, separator);
    const value = checkedPair.slice(separator + 1);
    const maxAge = attributes.find((part) => /^max-age=/iu.test(part))?.slice(8);
    const expires = attributes.find((part) => /^expires=/iu.test(part))?.slice(8);
    // 关键变量：Max-Age 优先于 Expires，避免刷新凭据时保留已经被源站注销的值。
    const expired = maxAge !== undefined && /^-?\d+$/u.test(maxAge)
      ? Number(maxAge) <= 0
      : expires !== undefined && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now();
    if (expired || !value) pairs.delete(name);
    else pairs.set(name, value);
  }
  return validateNeteaseCookie([...pairs].map(([name, value]) => `${name}=${value}`).join("; "));
}

/** 将原站 CSRF Cookie 带入 WEAPI 表单，缺失时沿用公开请求的空值。 */
export function readNeteaseCsrf(cookie: string): string {
  return readNeteaseCookiePairs(cookie).get("__csrf") ?? "";
}

/** 为一次扫码创建匿名设备上下文，随后仅由宿主当前用户的短期会话持有。 */
function createQrDeviceCookie(): string {
  // 关键变量：52 位大写十六进制设备标识在本次创建和轮询之间保持一致，不读取机器或用户真实标识。
  const deviceId = randomBytes(26).toString("hex").toUpperCase();
  const context: Record<string, string> = {
    osver: NETEASE_QR_OS_VERSION, deviceId, os: "pc", appver: NETEASE_QR_APP_VERSION,
    versioncode: "140", mobilename: "", buildver: String(Math.floor(Date.now() / 1000)), resolution: "1920x1080", channel: "netease",
  };
  return validateNeteaseCookie(Object.entries(context).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
}

/** 按 Alger EAPI 构建设备 header，始终沿用同一次扫码的设备标识和源站更新的会话。 */
function readQrDeviceHeader(cookie: string): Record<string, string> {
  const pairs = readNeteaseCookiePairs(cookie);
  const deviceId = pairs.get("deviceId");
  if (!deviceId || !/^[A-F\d]{52}$/u.test(deviceId)) throw new ApiError(409, "content_music_login_device_missing", "网易登录会话设备信息缺失，请重新获取二维码");
  const header: Record<string, string> = {
    osver: pairs.get("osver") || NETEASE_QR_OS_VERSION,
    deviceId, os: pairs.get("os") || "pc", appver: pairs.get("appver") || NETEASE_QR_APP_VERSION,
    versioncode: pairs.get("versioncode") || "140", mobilename: pairs.get("mobilename") || "",
    buildver: pairs.get("buildver") || String(Math.floor(Date.now() / 1000)), resolution: pairs.get("resolution") || "1920x1080",
    __csrf: pairs.get("__csrf") || "", channel: pairs.get("channel") || "netease",
    // 请求 ID 每次更新，设备标识和源站返回的匿名会话不随轮询重建。
    requestId: `${Date.now()}_${String(randomInt(1000)).padStart(4, "0")}`,
  };
  for (const name of ["MUSIC_U", "MUSIC_A", "NMTID"]) {
    const value = pairs.get(name);
    if (value) header[name] = value;
  }
  return header;
}

/** 读取明确的 JSON 对象；响应结构错误不能当作账号失效。 */
function readLoginObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 错误提示只读取有限数值状态码，不包含源站正文或个人资料。 */
function readLoginDiagnosticCode(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+$/u.test(value))) return null;
  const code = Number(value);
  return Number.isFinite(code) ? code : null;
}

/** 错误提示只附加源站数值状态码，便于识别失败阶段。 */
function loginSourceCodeSuffix(value: unknown): string {
  const code = readLoginDiagnosticCode(value);
  return code === null ? "" : `（源站错误码 ${code}）`;
}

/** 只接收网易官方 HTTPS 验证入口，签名参数由浏览器保留，不输出到诊断日志。 */
function readLoginVerificationUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value || value.length > 8 * 1024) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || (url.hostname !== "163.com" && !url.hostname.endsWith(".163.com"))) return null;
    return url;
  } catch { return null; }
}

/** 校验本次二维码 key，不允许拼接查询参数或控制字符。 */
function validateQrKey(key: string): void {
  if (typeof key !== "string" || !/^[A-Za-z\d_-]{8,256}$/u.test(key)) throw validationError("key", "网易登录二维码无效或已过期");
}

/** 解析公开头像地址，凭据不会嵌入头像 URL。 */
function readAccountAvatar(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** 网易原站扫码登录客户端；二维码、Cookie 和账号会话均不在实例内持久化。 */
export class NeteaseLoginClient {
  /** 复用云助手网络请求策略，不建立额外的账号或数据库存储。 */
  public constructor(private readonly allowInsecureHttp: boolean) {}

  /** 按端点使用固定网易 WEAPI 或扫码 EAPI，请求密文、设备标识和凭据不进入错误文本。 */
  private async request(path: string, parameters: Record<string, unknown>, cookie: string, signal?: AbortSignal, protocol: "weapi" | "eapi" = "weapi"): Promise<{ payload: Record<string, unknown>; cookie: string }> {
    const checkedCookie = validateNeteaseCookie(cookie);
    const csrf = readNeteaseCsrf(checkedCookie);
    const isQrRequest = protocol === "eapi";
    const url = isQrRequest ? new URL(path.replace(/^\/api\//u, "/eapi/"), NETEASE_QR_ORIGIN) : new URL(path, NETEASE_ORIGIN);
    const headers: Record<string, string> = {
      Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": isQrRequest ? NETEASE_QR_USER_AGENT : NETEASE_LOGIN_USER_AGENT,
    };
    let body: URLSearchParams;
    if (isQrRequest) {
      // 关键变量：EAPI 设备 header 同时进入加密 JSON 和 Cookie，e_r=false 保持返回 JSON 正文。
      const deviceHeader = readQrDeviceHeader(checkedCookie);
      headers.Cookie = Object.entries(deviceHeader).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("; ");
      body = createNeteaseEapiBody(path, { ...parameters, header: deviceHeader, e_r: false });
    } else {
      url.searchParams.set("csrf_token", csrf);
      headers.Referer = `${NETEASE_ORIGIN}/`;
      if (checkedCookie) headers.Cookie = checkedCookie;
      body = createNeteaseWebBody({ ...parameters, csrf_token: csrf });
    }
    let response: Response;
    try {
      response = await providerFetch(url, {
        method: "POST", headers, body,
      }, { allowInsecureHttp: this.allowInsecureHttp }, signal);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof ApiError && error.code.startsWith("provider_")) {
        throw new ApiError(error.statusCode, error.code, error.message.replace(/网盘/gu, "网易音乐源").replace(/Provider/gu, "网易音乐源"));
      }
      throw error;
    }
    signal?.throwIfAborted();
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) throw new ApiError(502, "content_music_login_response_too_large", "网易登录响应超过大小限制");
    let payload: Record<string, unknown> | null;
    try { payload = readLoginObject(JSON.parse(text)); }
    catch { throw new ApiError(502, "content_music_login_json_invalid", "网易登录接口未返回有效 JSON"); }
    if (!payload) throw new ApiError(502, "content_music_login_json_invalid", "网易登录接口未返回有效 JSON");
    // 关键变量：创建及各次轮询共享匿名 Cookie，源站授权后将登录 Cookie 合并到同一次会话。
    const setCookies = response.headers.getSetCookie();
    const mergedCookie = mergeNeteaseCookies(checkedCookie, setCookies, isQrRequest ? "interface.music.163.com" : "music.163.com");
    return { payload, cookie: mergedCookie };
  }

  /** 创建网易扫码登录内容，调用方负责将临时 key 与当前用户绑定并生成二维码图像。 */
  public async createQr(signal?: AbortSignal): Promise<{ key: string; qrCodeContent: string; cookie: string }> {
    const deviceCookie = createQrDeviceCookie();
    const { payload, cookie } = await this.request("/api/login/qrcode/unikey", { type: NETEASE_QR_TYPE }, deviceCookie, signal, "eapi");
    if (Number(payload.code) !== 200 || typeof payload.unikey !== "string") {
      throw new ApiError(502, "content_music_login_qr_failed", `网易登录二维码创建失败，请稍后重试${loginSourceCodeSuffix(payload.code)}`);
    }
    const key = payload.unikey;
    validateQrKey(key);
    const url = new URL("/login", NETEASE_ORIGIN);
    url.searchParams.set("codekey", key);
    return { key, qrCodeContent: url.href, cookie };
  }

  /** 使用同一临时 Cookie 查询扫码状态，只向宿主提供更新后的 Cookie，不输出源站确认信息。 */
  public async checkQr(key: string, signal?: AbortSignal, deviceCookie = ""): Promise<NeteaseQrCheckResult> {
    validateQrKey(key);
    const { payload, cookie } = await this.request("/api/login/qrcode/client/login", { key, type: NETEASE_QR_TYPE }, deviceCookie, signal, "eapi");
    const code = Number(payload.code);
    if (code === 800) return { status: "expired", cookie };
    if (code === 801) return { status: "waiting", cookie };
    if (code === 802) return { status: "scanned", cookie };
    if (code === 8821) {
      const verificationUrl = readLoginVerificationUrl(payload.redirectUrl);
      if (!verificationUrl) throw new ApiError(502, "content_music_login_verification_missing", "网易要求额外安全验证，未提供可用验证入口");
      return { status: "verification_required", cookie, verificationUrl: verificationUrl.href };
    }
    if (code === 803) {
      if (!readNeteaseCookiePairs(cookie).get("MUSIC_U")) throw new ApiError(502, "content_music_login_cookie_missing", "网易已确认授权，但没有返回可用登录凭据，请重新扫码");
      return { status: "authorized", cookie };
    }
    throw new ApiError(502, "content_music_login_qr_check_failed", `网易登录状态查询失败，请稍后重试${loginSourceCodeSuffix(payload.code)}`);
  }

  /** 查询账号资料；仅明确的未登录响应返回 null，网络或结构错误继续抛出。 */
  public async account(cookie: string, signal?: AbortSignal): Promise<NeteaseAccountProfile | null> {
    let payload: Record<string, unknown>;
    try { ({ payload } = await this.request("/weapi/w/nuser/account/get", {}, cookie, signal)); }
    catch (error) {
      // 关键变量：providerFetch 已将 HTTP 401 转为业务错误，此处仅把明确的认证失败视为未登录。
      if (error instanceof ApiError && error.code === "provider_authentication_failed") return null;
      throw error;
    }
    const code = Number(payload.code);
    if (code === 301) return null;
    if (code !== 200) throw new ApiError(502, "content_music_login_account_failed", `网易账号状态查询失败，请稍后重试${loginSourceCodeSuffix(payload.code)}`);
    if (payload.account === null && payload.profile === null) return null;
    const account = readLoginObject(payload.account);
    const profile = readLoginObject(payload.profile);
    const rawUserId = profile?.userId ?? account?.id;
    const userId = typeof rawUserId === "string" || typeof rawUserId === "number" ? String(rawUserId) : "";
    if (!account || !profile || !/^[1-9]\d{0,15}$/u.test(userId) || !Number.isSafeInteger(Number(userId))
      || typeof profile.nickname !== "string" || !profile.nickname.trim()) {
      throw new ApiError(502, "content_music_login_account_invalid", "网易账号接口未返回有效账号资料");
    }
    const vipType = Number(profile.vipType);
    return { userId, nickname: profile.nickname.trim(), avatarUrl: readAccountAvatar(profile.avatarUrl), vipType: Number.isSafeInteger(vipType) && vipType >= 0 ? vipType : 0 };
  }
}
