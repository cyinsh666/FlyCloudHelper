import { createCipheriv, createHash } from "node:crypto";
import { validationError } from "../errors.js";

// 关键变量：网易 EAPI 使用的公开协议密钥与分隔符，不是用户账号凭据。
const NETEASE_EAPI_KEY = "e82ckenh8dichen8";
const NETEASE_EAPI_SEPARATOR = "-36cd479b6b5-";

/** 按原始 EAPI 的 /api 路径、MD5 和 AES-128-ECB/PKCS7 构建表单，不保存账号会话。 */
export function createNeteaseEapiBody(canonicalPath: string, parameters: Record<string, unknown>): URLSearchParams {
  if (!/^\/api\/[A-Za-z\d/_-]+$/u.test(canonicalPath)) throw validationError("path", "网易 EAPI 请求路径无效");
  // 关键变量：参与签名的是 /api 原始路径，不能使用实际传输的 /eapi 路径。
  const requestText = JSON.stringify(parameters);
  const digest = createHash("md5").update(`nobody${canonicalPath}use${requestText}md5forencrypt`, "utf8").digest("hex");
  const framedText = `${canonicalPath}${NETEASE_EAPI_SEPARATOR}${requestText}${NETEASE_EAPI_SEPARATOR}${digest}`;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(NETEASE_EAPI_KEY, "utf8"), null);
  const encrypted = Buffer.concat([cipher.update(framedText, "utf8"), cipher.final()]).toString("hex").toUpperCase();
  return new URLSearchParams({ params: encrypted });
}
