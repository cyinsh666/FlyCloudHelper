import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../errors.js";

export const CLOUD139_ORIGIN = "https://yun.139.com";
export const CLOUD139_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 读取网页凭据中的真实账号，移动登录不提供刷新令牌。 */
export function parseCloud139Credential(value: string) {
  const authorization = value.trim().replace(/^Basic\s+/iu, "");
  const match = Buffer.from(authorization, "base64").toString("utf8").match(/^pc:([^:]+):(.+)$/su);
  if (!match) throw new ApiError(422, "cloud139_credential_invalid", "移动云盘凭据无效，请重新扫码");
  const expiration = match[2]!.split("|")[3] ?? "";
  const expiresAt = /^\d+$/u.test(expiration) && Number.isSafeInteger(Number(expiration)) ? Number(expiration) : 0;
  return { authorization, account: match[1]!, expiresAt };
}

/** 按公开网页协议计算签名，三次 MD5 的中间值保持小写。 */
export function cloud139Signature(body: string, timestamp: string, nonce: string): string {
  const md5 = (value: string) => createHash("md5").update(value).digest("hex");
  const encoded = encodeURIComponent(body).replace(/[!'()*]/gu, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return md5(md5(Buffer.from(encoded.split("").sort().join("")).toString("base64")) + md5(`${timestamp}:${nonce}`)).toUpperCase();
}

/** 签名与发送共用同一正文，扫码请求通过 visitorId 绑定设备。 */
export function cloud139Headers(body: string, authorization = "", visitorId = ""): Record<string, string> {
  const version = visitorId ? "7.17.9" : "7.14.0";
  const timestamp = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const nonce = randomBytes(8).toString("hex");
  const device = `||9|${version}|chrome|120.0.0.0|${visitorId}||windows 10||zh-CN|||`;
  return {
    Accept: "application/json, text/plain, */*", "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": CLOUD139_UA, Origin: CLOUD139_ORIGIN, Referer: `${CLOUD139_ORIGIN}/w/`,
    "CMS-DEVICE": "default", "Inner-Hcy-Router-Https": "1", Caller: "web", "mcloud-channel": "1000101",
    "mcloud-client": "10701", "mcloud-route": "001", "mcloud-version": version,
    "mcloud-sign": `${timestamp},${nonce},${cloud139Signature(body, timestamp, nonce)}`,
    "x-DeviceInfo": device, "x-huawei-channelSrc": "10000034", "x-inner-ntwk": "2", "x-m4c-caller": "PC",
    "x-m4c-src": "10002", "x-SvcType": "1", "x-yun-api-version": "v1", "x-yun-app-channel": "10000034",
    "x-yun-channel-source": "10000034", "x-yun-client-info": `${device}dW5kZWZpbmVk||`,
    "x-yun-module-type": "100", "x-yun-svc-type": "1",
    ...(authorization ? { Authorization: `Basic ${authorization}` } : { "hcy-cool-flag": "1" }),
  };
}
