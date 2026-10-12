import { constants, createCipheriv, publicEncrypt, randomInt } from "node:crypto";

// 关键变量：以下为网易公开网页请求协议中的固定 IV、第一层 AES 密钥和 RSA 公钥，不是账号凭据。
const NETEASE_WEB_IV = "0102030405060708";
const NETEASE_WEB_PRESET_KEY = "0CoJUm6Qyw8W8jud";
const NETEASE_WEB_KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NETEASE_WEB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

/** 按网易网页协议使用 AES-128-CBC 和 PKCS7 填充，将一层请求内容转为 Base64。 */
function encryptNeteaseWebText(text: string, key: string): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(NETEASE_WEB_IV, "utf8"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

/** 生成仅供本次网页请求使用的 16 位随机 AES 密钥，不保存临时请求密钥。 */
function createNeteaseWebSecretKey(): string {
  let key = "";
  for (let index = 0; index < 16; index += 1) {
    key += NETEASE_WEB_KEY_ALPHABET[randomInt(NETEASE_WEB_KEY_ALPHABET.length)];
  }
  return key;
}

/** 按网页协议反转临时 AES 密钥，再用公开 RSA 密钥执行无额外填充的封装。 */
function encryptNeteaseWebSecretKey(secretKey: string): string {
  // 关键变量：公开 RSA 公钥是 1024 位，反转后的 16 字节密钥在 128 字节整数块中左侧补零。
  const keyBlock = Buffer.alloc(128);
  const reversedKey = Buffer.from(secretKey.split("").reverse().join(""), "utf8");
  reversedKey.copy(keyBlock, keyBlock.length - reversedKey.length);
  return publicEncrypt({ key: NETEASE_WEB_PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, keyBlock).toString("hex");
}

/** 构建 WEAPI 表单，登录会话的 CSRF 由调用方传入，Cookie 不进入本函数。 */
export function createNeteaseWebBody(parameters: Record<string, unknown>): URLSearchParams {
  const secretKey = createNeteaseWebSecretKey();
  const requestText = JSON.stringify({ csrf_token: "", ...parameters });
  const firstLayer = encryptNeteaseWebText(requestText, NETEASE_WEB_PRESET_KEY);
  return new URLSearchParams({
    params: encryptNeteaseWebText(firstLayer, secretKey),
    encSecKey: encryptNeteaseWebSecretKey(secretKey),
  });
}
