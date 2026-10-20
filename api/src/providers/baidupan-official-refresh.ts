import { constants, createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { ApiError } from "../errors.js";
import { providerFetch, type ProviderNetworkOptions } from "./network.js";

// 与鸿蒙客户端使用相同的公开请求配置，不包含百度应用密钥。
const KEY_ID = "flymby-rsa-2026-01";
const PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvTQtbHRUMPt3NIR3TJcXBjQCvFPLKJ4uyp6KGloriZweZkzxcsCOiyUXGAXBZ8N4As6f0YsN1j2hQWWUEWmxSxO0d0g7A2NwHuE9cOW+fdYyc3DU6hvcoPwTioA3GJjn/xXh7/SofXnyCPO+OxGkOC5120n3KmEIamOE0oJijsNXfeJGWqhspPWNHBx5HxHK7VpRP5gBQPkM8AWCZgEzn7tPLKV/D2ttNeDqcJnOmCGoQH7/fq0CsRGi3/oW6tYqwBhIYQuc8FnM5Q4shqKa+BVz9MuK6Mrj28U4VfIB8UbE++E+B0IJkA4HrFRRrSyKXVe+hy7KNwU4OTiu7UW8twIDAQAB";
const REGISTRATION_KEY = "4gpXtjya6HppGwtFJlB-L9iiZv_PMnQEpDifOgLLxiE";
const REFRESH_PATH = "/api/v1/cloud-drive/auth/token/refresh";
const SERVER_BASE_URL = "https://wzhi.top";

/** 官方百度令牌仍由 FlymbyServer 使用应用密钥续期，云助手只持有用户授权凭据。 */
export async function refreshBaiduOfficialToken(
  refreshToken: string,
  networkOptions: ProviderNetworkOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const aesKey = randomBytes(32); // 每次请求独立使用 AES 密钥及随机 IV。
  const iv = randomBytes(12);
  const nonce = randomBytes(18).toString("base64url");
  const timestamp = Date.now();
  const aad = Buffer.from(`FLYMBY-REQUEST\nPOST\n${REFRESH_PATH}\n${KEY_ID}\n${timestamp}\n${nonce}`);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(aad);
  const payload = JSON.stringify({ registrationKey: REGISTRATION_KEY, provider: "baidupan",
    authSource: "baidu_official", refreshToken });
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const publicKey = createPublicKey({ key: Buffer.from(PUBLIC_KEY, "base64"), format: "der", type: "spki" });
  const encryptedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256" }, aesKey);
  const response = await providerFetch(`${SERVER_BASE_URL}${REFRESH_PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ keyId: KEY_ID, encryptedKey: encryptedKey.toString("base64url"),
      iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"), timestamp, nonce }),
  }, networkOptions, signal);
  if (!response.ok) throw new ApiError(502, "baidupan_official_refresh_unavailable", "百度官方应用续期失败，请检查 FlymbyServer 配置或重新登录");
  try {
    const envelope = await response.json() as Record<string, unknown>;
    if (envelope.keyId !== KEY_ID) throw new Error("响应密钥版本不匹配");
    const responseAad = Buffer.from(`FLYMBY-RESPONSE\n${REFRESH_PATH}\n${KEY_ID}\n${nonce}\n${envelope.timestamp}\n${envelope.nonce}`);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(String(envelope.iv), "base64url"));
    decipher.setAAD(responseAad);
    decipher.setAuthTag(Buffer.from(String(envelope.authTag), "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), "base64url")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  } catch (_) {
    throw new ApiError(502, "baidupan_official_response_invalid", "百度官方应用续期结果校验失败，请稍后重试");
  } finally {
    aesKey.fill(0);
  }
}
