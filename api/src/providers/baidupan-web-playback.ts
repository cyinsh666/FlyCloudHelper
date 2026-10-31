import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { providerFetch, type ProviderNetworkOptions } from "./network.js";
import type { ProviderFileAccess } from "./types.js";

const BAIDU_SITE = "https://pan.baidu.com";
const BAIDU_WEB_AGENT = "netdisk;13.35.7;24031PN0DC;android-android;12;JSbridge4.4.0;jointBridge;1.1.0;";
export const BAIDU_WEB_PLAYER_AGENT = "com.android.chrome/131.0.6778.200 (Linux;Android 10) AndroidXMedia3/1.5.1";
const verifiedCookies = new Map<string, number>(); // 同一网页登录凭据五分钟内只核对一次账号。

/** 保留百度网页会话所需的 Cookie，避免把无关域的浏览数据写入连接。 */
export function selectBaiduWebCookies(cookies: Array<{ name: string; value: string; domain: string }>): string {
  const selected = new Map<string, string>();
  // 百度网盘域最后处理，同名凭据优先使用网盘实际写入的值。
  const ordered = [...cookies].sort((left, right) => Number(left.domain.includes("pan.baidu.com")) - Number(right.domain.includes("pan.baidu.com")));
  for (const cookie of ordered) {
    if (!/(^|\.)baidu\.com$/iu.test(cookie.domain.replace(/^\./u, ""))) continue;
    if (!/^[A-Za-z0-9_]+$/u.test(cookie.name) || /[;\r\n]/u.test(cookie.value)) continue;
    selected.set(cookie.name, cookie.value);
  }
  return [...selected].map(([name, value]) => `${name}=${value}`).join("; ").slice(0, 16_000);
}

/** 只从百度明确返回的 uk 读取网盘账号，避免数字精度损失。 */
function readBaiduJson(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/("uk"\s*:\s*)(\d+)/gu, '$1"$2"')) as Record<string, unknown>;
}

/** 使用原 OAuth 令牌读取当前网盘账号和会员类型。 */
export async function readBaiduOAuthIdentity(
  accessToken: string, options: ProviderNetworkOptions, signal?: AbortSignal,
): Promise<{ userId: string; vipType: number | null }> {
  const url = new URL("/rest/2.0/xpan/nas", BAIDU_SITE);
  url.searchParams.set("method", "uinfo");
  url.searchParams.set("vip_version", "v2");
  url.searchParams.set("access_token", accessToken);
  const response = await providerFetch(url, { method: "GET" }, options, signal);
  const result = readBaiduJson(await response.text());
  const userId = String(result.uk ?? "").trim();
  if (Number(result.errno ?? 0) !== 0 || !/^\d+$/u.test(userId)) {
    throw new ApiError(502, "baidupan_web_oauth_identity_missing", "百度网盘未返回原连接的账号标识，请重新验证连接");
  }
  const vipType = Number(result.vip_type);
  return { userId, vipType: [0, 1, 2].includes(vipType) ? vipType : null };
}

/** 验证网页登录凭据属于现有 OAuth 网盘账号，不把 Cookie 返回给页面。 */
export async function validateBaiduWebCookie(
  cookie: string, expectedUserId: string, options: ProviderNetworkOptions, signal?: AbortSignal,
): Promise<void> {
  if (!/(?:^|;\s*)BDUSS(?:_BFESS)?=[^;]+/iu.test(cookie) || cookie.length > 16_000) {
    throw new ApiError(422, "baidupan_web_cookie_missing", "请先在百度网页完成扫码登录");
  }
  const cacheKey = createHash("sha256").update(`${expectedUserId}\n${cookie}`).digest("hex");
  if ((verifiedCookies.get(cacheKey) ?? 0) > Date.now()) return;
  const headers = { "User-Agent": BAIDU_WEB_AGENT, Cookie: cookie, Referer: `${BAIDU_SITE}/`,
    Origin: BAIDU_SITE, Accept: "application/json" };
  let webUserId = "";
  try {
    const response = await providerFetch(`${BAIDU_SITE}/api/gettemplatevariable?clienttype=0&app_id=250528&web=1`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ fields: JSON.stringify(["uk", "username", "loginstate"]) }),
    }, options, signal);
    const result = readBaiduJson(await response.text());
    const info = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
    if ([401, 403, -6, -9].includes(Number(result.errno))) {
      throw new ApiError(422, "baidupan_web_cookie_invalid", "百度网页登录状态未通过，请重新扫码");
    }
    webUserId = String(info.uk ?? "").trim();
  } catch (error) {
    if (signal?.aborted || (error instanceof ApiError && error.code === "baidupan_web_cookie_invalid")) throw error;
    // 旧账号资料接口暂时不可用时，按鸿蒙版行为再查询一次网页登录状态。
  }
  if (!webUserId) {
    const response = await providerFetch(`${BAIDU_SITE}/api/loginStatus?clienttype=1&web=1&channel=web&version=0`,
      { method: "GET", headers }, options, signal);
    const result = readBaiduJson(await response.text());
    const info = result.login_info && typeof result.login_info === "object"
      ? result.login_info as Record<string, unknown> : {};
    webUserId = String(info.uk ?? "").trim();
  }
  if (!/^\d+$/u.test(webUserId)) {
    throw new ApiError(422, "baidupan_web_cookie_invalid", "百度网页登录状态未通过，请重新扫码");
  }
  if (webUserId !== expectedUserId) {
    throw new ApiError(409, "baidupan_web_account_mismatch", "扫码账号与当前百度网盘服务不是同一账号");
  }
  verifiedCookies.set(cacheKey, Date.now() + 5 * 60_000);
  if (verifiedCookies.size > 32) verifiedCookies.delete(verifiedCookies.keys().next().value!);
}

/** 限量探测临时播放地址，并区分原文件、HLS 清单和登录错误页。 */
async function probeBaiduWebStream(
  url: string, userAgent: string, options: ProviderNetworkOptions, signal?: AbortSignal,
): Promise<{ playableFile: boolean; finalUrl: string }> {
  const response = await providerFetch(url, {
    method: "GET", headers: { "User-Agent": userAgent, Range: "bytes=0-4095", "Accept-Encoding": "identity" },
  }, options, signal);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const reader = response.body?.getReader();
  let preview = "";
  try {
    const chunk = await reader?.read();
    preview = new TextDecoder().decode(chunk?.value?.subarray(0, 256) ?? new Uint8Array()).trimStart();
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
  }
  const isError = contentType.includes("json") || contentType.includes("text/html")
    || preview.startsWith("{") || /^<!doctype|^<html/iu.test(preview);
  const isHls = contentType.includes("mpegurl") || preview.startsWith("#EXTM3U");
  return { playableFile: response.status === 206 && !isError && !isHls && Boolean(preview), finalUrl: response.url };
}

/** 只对视频尝试网页登录取链；其他格式继续使用原开放接口。 */
export function supportsBaiduWebPlayback(path: string): boolean {
  return /\.(mp4|mkv|mov|avi|flv|wmv|ts|m4v)$/iu.test(path);
}

/** 取得网页登录媒体直链，客户端 UA 可用时不附加额外请求头。 */
export async function resolveBaiduWebPlayback(
  path: string, cookie: string, expectedUserId: string, playbackUserAgent: string | undefined,
  options: ProviderNetworkOptions, signal?: AbortSignal,
): Promise<ProviderFileAccess> {
  await validateBaiduWebCookie(cookie, expectedUserId, options, signal);
  const url = new URL("/api/mediainfo", BAIDU_SITE);
  url.searchParams.set("type", "M3U8_FLV_264_480");
  url.searchParams.set("path", path);
  url.searchParams.set("origin", "dlna");
  url.searchParams.set("check_blue", "1");
  url.searchParams.set("app_id", "250528");
  url.searchParams.set("devuid", `${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 32)}|${Date.now()}`);
  url.searchParams.set("clienttype", "80");
  url.searchParams.set("channel", "android_12_V2238A_bd-netdisk_1024266g");
  url.searchParams.set("network_type", "wifi");
  url.searchParams.set("version", "12.11.9");
  const response = await providerFetch(url, {
    method: "GET", headers: {
      "User-Agent": BAIDU_WEB_AGENT, Cookie: cookie, Referer: `${BAIDU_SITE}/`, Origin: BAIDU_SITE,
      Accept: "application/json",
    },
  }, options, signal);
  const result = readBaiduJson(await response.text());
  const info = result.info && typeof result.info === "object" ? result.info as Record<string, unknown> : {};
  const mediaUrl = String(info.dlink ?? "");
  const errno = Number(result.errno ?? 0);
  if ((errno !== 0 && errno !== 133) || !/^https?:\/\//iu.test(mediaUrl)) {
    throw new ApiError(502, "baidupan_web_media_unavailable", "百度补充网页登录暂未返回可播放地址");
  }
  if (playbackUserAgent) {
    try {
      const direct = await probeBaiduWebStream(mediaUrl, playbackUserAgent, options, signal);
      if (direct.playableFile) return { url: direct.finalUrl, expiresAt: null, headers: {} };
    } catch (error) {
      if (signal?.aborted) throw error;
      // 当前播放器 UA 不可直读时继续尝试服务端固定 UA，中转仍可播放。
    }
  }
  const relay = await probeBaiduWebStream(mediaUrl, BAIDU_WEB_PLAYER_AGENT, options, signal);
  if (!relay.playableFile) throw new ApiError(502, "baidupan_web_stream_unavailable", "百度补充网页登录返回的流暂不适合文件直放");
  return { url: relay.finalUrl, expiresAt: null, headers: { "User-Agent": BAIDU_WEB_PLAYER_AGENT } };
}
