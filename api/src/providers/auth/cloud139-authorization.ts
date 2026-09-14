import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ApiError } from "../../errors.js";
import { cloud139Headers, parseCloud139Credential } from "../cloud139-protocol.js";
import { readAuthText } from "./http.js";
import type { CloudAuthorizationDriver, CloudAuthorizationPollResult, CloudAuthorizationStartOptions } from "./types.js";

// 公开网页协议常量，与用户账号密钥无关；移植自 Server 的 cloud139_protocol。
const TRANSPORT_KEY = Buffer.from("UqEZkrjCKfa02pP6jntzFmkzOz86zHUC");
const DATA_KEY = Buffer.from("qPqDw263XgFgL3u8");

/** 严格解析协议对象，错误正文不进入日志。 */
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
  return value as Record<string, unknown>;
}

/** 解密扫码信封或内部登录数据，保留系统 PKCS7 校验。 */
function decryptObject(bytes: Buffer, inner: boolean): Record<string, unknown> {
  const decipher = createDecipheriv(inner ? "aes-128-ecb" : "aes-256-cbc", inner ? DATA_KEY : TRANSPORT_KEY, inner ? null : bytes.subarray(0, 16));
  return parseObject(Buffer.concat([decipher.update(inner ? bytes : bytes.subarray(16)), decipher.final()]).toString("utf8"));
}

/** 移动云盘独立二维码授权，不通过 FlymbyServer，不支持自动续期。 */
export class Cloud139AuthorizationDriver implements CloudAuthorizationDriver {
  public readonly providerType = "cloud139";

  /** 创建网页二维码，凭据直到扫码确认后才存在。 */
  public async start(_options: CloudAuthorizationStartOptions) {
    const sid = randomBytes(8).toString("hex");
    const visitorId = randomBytes(16).toString("hex");
    console.info("codex-flycloud-cloud139-auth", { 事件: "创建二维码" });
    return { authMethod: "qr", qrCodeContent: `https://yun.139.com/w/#/qrcLogin?sID=${sid}&dID=${visitorId}&cType=9`,
      expiresInSeconds: 300, pollIntervalSeconds: 2, driverState: { sid, visitorId, authorization: "" } };
  }

  /** 每次执行一次加密查询；等待码不作为授权失败。 */
  public async poll(state: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult> {
    if (!state.sid) return { state: "cancelled", retryAfterSeconds: 2 };
    if (state.authorization) return { state: "confirmed", retryAfterSeconds: 2 };
    const values: Record<string, unknown> = { msisdn: "", random: "", dycpwd: state.sid, cpid: 292, clienttype: 670,
      version: "mCloud_4.3.0_536", pintype: 21, secinfo: createHash("sha1").update(`fetion.com.cn:${state.sid}`).digest("hex").toUpperCase(), loginMode: "0", extInfo: {} };
    const body = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right, "en"))));
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", TRANSPORT_KEY, iv);
    let response: Response;
    try {
      response = await fetch("https://user-njs.yun.139.com/user/thirdlogin", { method: "POST", redirect: "error",
        headers: cloud139Headers(body, "", String(state.visitorId)),
        body: JSON.stringify(Buffer.concat([iv, cipher.update(body), cipher.final()]).toString("base64")),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) });
    } catch {
      signal?.throwIfAborted();
      throw new ApiError(503, "cloud139_auth_upstream_unavailable", "移动云盘授权暂时不可用，请稍后重试");
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return { state: "waiting", retryAfterSeconds: 5, message: "上游繁忙，稍后继续查询" };
    }
    try {
      if (!response.ok) throw new Error("http");
      // 限制真实读取量，扫码接口不应返回大文件。
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("large response");
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      const envelope = raw.startsWith("{") ? parseObject(raw) : decryptObject(Buffer.from(raw.startsWith('"') ? JSON.parse(raw) as string : raw, "base64"), false);
      let code = String(envelope.code ?? "").trim();
      let data: Record<string, unknown> = {};
      if (["", "0", "0000", "200"].includes(code)) {
        if (envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)) data = envelope.data as Record<string, unknown>;
        else if (typeof envelope.data === "string" && envelope.data.trim()) {
          const text = envelope.data.trim();
          data = text.startsWith("{") ? parseObject(text) : decryptObject(Buffer.from(text, /^[0-9a-f]+$/iu.test(text) && text.length % 2 === 0 ? "hex" : "base64"), true);
        }
        const nested = data.result as Record<string, unknown> | undefined;
        if (nested && !["", "0", "0000"].includes(String(nested.resultCode ?? ""))) code = String(nested.resultCode);
      }
      const token = readAuthText(data, ["token", "authToken", "accessToken"]);
      if (["200059541", "200059548", "9999"].includes(code) || (!code && !token && envelope.success !== true && String(envelope.statusCode) !== "200")) {
        return { state: "waiting", retryAfterSeconds: 2 };
      }
      if (code === "200059542") return { state: "expired", retryAfterSeconds: 2 };
      if (code === "200059549") return { state: "cancelled", retryAfterSeconds: 2 };
      if (!["", "0", "0000", "200"].includes(code)) return { state: "failed", retryAfterSeconds: 2, message: "移动云盘扫码失败，请重新扫码" };
      const account = readAuthText(data, ["account", "msisdn", "phoneNumber"]) || (typeof data.encryptAccount === "string" ? Buffer.from(data.encryptAccount, "base64").toString("utf8").trim() : "");
      if (!account || account.includes(":") || !token) throw new Error("credential missing");
      if (!state.sid) return { state: "cancelled", retryAfterSeconds: 2 };
      state.authorization = Buffer.from(`pc:${account}:${token}`).toString("base64");
      console.info("codex-flycloud-cloud139-auth", { 事件: "扫码已确认" });
      return { state: "confirmed", retryAfterSeconds: 2 };
    } catch {
      signal?.throwIfAborted();
      throw new ApiError(502, "cloud139_auth_response_invalid", "移动云盘扫码响应异常，请重新扫码");
    }
  }

  /** 交付已确认的网页凭据，账号验证由创建服务流程继续执行。 */
  public async complete(state: Record<string, unknown>) {
    if (!state.authorization) throw new ApiError(409, "provider_auth_not_confirmed", "请先扫码确认");
    const credential = parseCloud139Credential(String(state.authorization));
    if (credential.expiresAt && credential.expiresAt <= Date.now()) throw new ApiError(410, "cloud139_authentication_expired", "移动云盘登录已过期，请重新扫码");
    return { connection: { ...credential, accountSummary: credential.account }, accountSummary: credential.account };
  }

  /** 会话结束清除所有敏感中间值。 */
  public dispose(state: Record<string, unknown>): void {
    state.sid = ""; state.visitorId = ""; state.authorization = "";
  }
}
