import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudNumber, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  providerProbeStream,
  readProviderRateLimitDelayMs,
  registerProviderSharedRateLimit,
  waitForProviderRateLimit,
  type ProviderNetworkOptions,
  type ProviderStreamResponse,
} from "./network.js";
import { type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess, createProviderRecommendedScanSettings, requireConnectionString } from "./types.js";

const CLOUD123_API = "https://www.123pan.cn";
const CLOUD123_DOWNLOAD_PROBE_MAX_BYTES = 64 * 1024;
/** 与 APP 保持一致的123业务接口最小请求间隔，避免扫描并发形成瞬时突发。 */
const CLOUD123_REQUEST_INTERVAL_MS = 150;

/** 123云盘 Android 客户端协议只读 Provider。 */
export class Cloud123Provider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "0";
  /** FlyCloudHelper 实例内所有123请求共享下一次允许发出的时间。 */
  private nextRequestAtMs = 0;
  public readonly descriptor: ProviderDescriptor = {
    type: "cloud123", displayName: "123云盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 4 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "app_qr", displayName: "123 App扫码登录", interaction: "qr", recommended: true }],
    connectionFields: [],
  };

  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 验证123账号并保存稳定 UID。 */
  protected async loadAccountLabel(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<string | null> {
    const payload = await this.request(connection, "/b/api/user/info", { method: "GET" }, signal);
    const data = readCloudRecord(payload.data);
    const userId = readCloudText(data, ["UID", "uid"]);
    if (!userId) throw new ApiError(502, "cloud123_user_invalid", "123云盘未返回用户身份");
    connection.userId = userId;
    connection.accountSummary = readCloudText(data, ["Passport", "passport", "Nickname", "nickname"]);
    await context?.persistConnection?.(connection);
    return String(connection.accountSummary || `123账号 ${userId.slice(-4)}`);
  }

  /** 按页读取123目录。 */
  protected async listPage(connection: Record<string, unknown>, parentId: string, page: number, signal?: AbortSignal): Promise<CloudDrivePage> {
    const limit = 100;
    const query = new URLSearchParams({ driveId: "0", limit: String(limit), next: "0", orderBy: "file_id", orderDirection: "asc", parentFileId: parentId, trashed: "false", SearchData: "", Page: String(page), OnlyLookAbnormalFile: "0" });
    const payload = await this.request(connection, `/api/file/list/new?${query}`, { method: "GET" }, signal);
    const data = readCloudRecord(payload.data);
    const rawItems = Array.isArray(data.InfoList) ? data.InfoList : Array.isArray(data.infoList) ? data.infoList : [];
    const total = readCloudNumber(data.Total ?? data.total);
    return {
      items: rawItems.map((value) => readCloudRecord(value)).map((item) => {
        const id = readCloudText(item, ["FileId"]);
        const name = readCloudText(item, ["FileName"]);
        const modifiedSeconds = readCloudNumber(item.UpdateAt ?? item.CreateAt);
        return {
          id, parentId: readCloudText(item, ["ParentFileId"]) || parentId, name: name || id,
          isDirectory: Number(item.Type ?? 0) === 1, size: readCloudNumber(item.Size),
          modifiedAt: modifiedSeconds > 0 ? new Date(modifiedSeconds * 1_000).toISOString() : null,
          etag: readCloudText(item, ["Etag"]) || null,
          locator: { providerType: "cloud123", fileId: id, fileName: name, size: readCloudNumber(item.Size), etag: readCloudText(item, ["Etag"]), s3KeyFlag: readCloudText(item, ["S3KeyFlag"]), type: Number(item.Type ?? 0) },
        };
      }).filter((item) => item.id),
      hasMore: total > 0 ? page * limit < total : rawItems.length >= limit,
    };
  }

  /** 获取123文件下载地址；Jellyfin 直连取址和下载节点解析沿用实际播放器 UA。 */
  protected async loadFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileAccess> {
    // 关键变量：只覆盖当前直连请求的 UA，APP 关联播放、中转和刮削继续返回原有123客户端 UA。
    const userAgent = context?.playbackUserAgent || this.createUserAgent(connection);
    const payload = await this.request(connection, "/a/api/file/download_info", {
      method: "POST", headers: { "User-Agent": userAgent }, body: JSON.stringify({ driveId: 0, etag: String(locator.etag ?? ""), fileId: requireConnectionString(locator, "fileId", "123文件 ID"), s3keyFlag: String(locator.s3KeyFlag ?? ""), type: Number(locator.type ?? 0), fileName: String(locator.fileName ?? ""), size: Number(locator.size ?? 0) }),
    }, signal);
    const data = readCloudRecord(payload.data);
    const directUrl = readCloudText(data, ["RedirectUrl", "redirect_url"]);
    const downloadUrl = readCloudText(data, ["DownloadUrl", "downloadUrl"]);
    if (!directUrl && !downloadUrl) throw new ApiError(502, "cloud123_download_url_missing", "123云盘未返回下载地址");
    // 关键变量：RedirectUrl 已是接口给出的直达地址，不能再次包装成会返回 HTML 的 download-v2 页面。
    const resolvedUrl = directUrl && !directUrl.includes("/download-v2/")
      ? directUrl
      : await this.resolveDownloadUrl(directUrl || downloadUrl, userAgent, signal);
    return { url: resolvedUrl, expiresAt: null, headers: { "User-Agent": userAgent } };
  }

  /** 读取123小型文本文件。 */
  public async readText(connection: Record<string, unknown>, entry: ProviderEntry, signal?: AbortSignal): Promise<string> {
    return readCloudTextFile(await this.loadFileAccess(connection, entry.locator, signal), this.networkOptions, signal);
  }

  /** 等待123请求时间窗口，扫描取消时立即结束等待。 */
  private async waitForRequestSlot(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new ApiError(499, "provider_request_aborted", "123云盘请求已取消");
      const now = Date.now();
      if (now >= this.nextRequestAtMs) {
        // 检查与占用窗口之间没有异步操作，并发目录不能在同一时刻一起发出。
        this.nextRequestAtMs = now + CLOUD123_REQUEST_INTERVAL_MS;
        return;
      }
      await waitForProviderRateLimit(this.nextRequestAtMs - now, signal);
    }
  }

  /** 请求123业务接口，区分登录失效、限流、安全验证和普通业务失败。 */
  private async request(connection: Record<string, unknown>, path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = requireConnectionString(connection, "accessToken", "123登录 Token");
    for (let retryCount = 0; ; retryCount += 1) {
      await this.waitForRequestSlot(signal);
      const result = await requestCloudApiText(`${CLOUD123_API}${path}`, {
        ...init,
        headers: { ...this.createHeaders(connection, token), ...init.headers },
      }, this.networkOptions, signal);
      const payload = parseCloudApiObject(result.text, ["FileId", "ParentFileId", "UID"]);
      const code = Number(payload.code ?? -1);
      const message = readCloudText(payload, ["message", "msg", "Message"]).slice(0, 200);
      if ([0, 5113, 5114].includes(code)) {
        return payload;
      }
      if (code === 2) {
        throw new ApiError(410, "cloud123_authentication_expired", "123云盘登录已失效，请重新扫码");
      }
      if (/验证码|安全验证|账号被限制|账号已冻结/u.test(message)) {
        throw new ApiError(423, "cloud123_account_attention_required", "123云盘账号需要完成安全验证，请处理后重试");
      }
      if (code === 429) {
        const delayMs = readProviderRateLimitDelayMs(result.response.headers.get("retry-after"), retryCount);
        registerProviderSharedRateLimit(CLOUD123_API, delayMs);
        if (retryCount < PROVIDER_RATE_LIMIT_MAX_RETRIES) continue;
        throw new ApiError(503, "provider_rate_limited", "123云盘请求频繁，等待重试后仍未恢复，请稍后再试");
      }
      throw new ApiError(502, "cloud123_business_failed",
        `123云盘接口返回业务错误（业务码：${Number.isFinite(code) ? code : "未知"}）`);
    }
  }

  /** 构造123 Android 设备头。 */
  private createHeaders(connection: Record<string, unknown>, token: string): Record<string, string> {
    return {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json",
      platform: "android", devicename: "Xiaomi", devicetype: String(connection.deviceType || "M2012K11AC"),
      osversion: String(connection.osVersion || "Android_13"), loginuuid: String(connection.loginUuid || ""),
      "app-version": "61", "x-app-version": "2.4.0", "User-Agent": this.createUserAgent(connection),
    };
  }

  /** 返回播放使用的123客户端标识。 */
  private createUserAgent(connection: Record<string, unknown>): string { return `123pan/v2.4.0(${String(connection.osVersion || "Android_13")};Xiaomi)`; }

  /** 按参考客户端流程把 download-v2 中间地址解析为可直接读取的文件地址。 */
  private async resolveDownloadUrl(downloadUrl: string, userAgent: string, signal?: AbortSignal): Promise<string> {
    const rewrittenUrl = this.rewriteDownloadUrl(downloadUrl);
    const decodedUrl = this.decodeDownloadV2Url(rewrittenUrl);
    if (decodedUrl) {
      const resolvedDecodedUrl = await this.probeDownloadUrl(decodedUrl, userAgent, signal);
      if (resolvedDecodedUrl) return resolvedDecodedUrl;
    }

    const resolvedProxyUrl = await this.probeDownloadUrl(rewrittenUrl, userAgent, signal);
    if (resolvedProxyUrl) return resolvedProxyUrl;

    // 关键变量：代理页无法给出真实地址时回退到解码后的内层地址，绝不把已确认的 HTML 页面交给 ffprobe。
    return decodedUrl || rewrittenUrl;
  }

  /** 用小范围 GET 识别重定向、210 JSON、HTML 链接或真实媒体响应。 */
  private async probeDownloadUrl(
    url: string,
    userAgent: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!url.startsWith("https://")) return "";
    let response: ProviderStreamResponse | null = null;
    try {
      response = await providerProbeStream(url, {
        method: "GET",
        headers: {
          Accept: "application/json, */*",
          Range: "bytes=0-4095",
          "User-Agent": userAgent,
        },
      }, this.networkOptions, signal);
      const responseBody = await this.readProbeBody(response.body);
      const responseText = responseBody.toString("utf8");
      const contentType = String(response.headers["content-type"] ?? "").slice(0, 100);
      const jsonRedirectUrl = this.readJsonRedirectUrl(responseText);
      if (jsonRedirectUrl) {
        return jsonRedirectUrl;
      }

      const htmlRedirectUrl = this.readHtmlRedirectUrl(responseText);
      if (htmlRedirectUrl) {
        return htmlRedirectUrl;
      }

      if (this.isDirectFileResponse(response.statusCode, contentType, responseBody)) {
        return response.finalUrl.href;
      }
      return "";
    } catch {
      return "";
    } finally {
      response?.body.destroy();
    }
  }

  /** 最多读取探测响应前64KB，达到上限后主动断开上游流。 */
  private async readProbeBody(body: ProviderStreamResponse["body"]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const cleanup = () => {
        body.removeListener("data", onData);
        body.removeListener("end", onEnd);
        body.removeListener("error", onError);
        body.removeListener("aborted", onAborted);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        body.destroy();
        resolve(Buffer.concat(chunks, totalBytes));
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        body.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const remainingBytes = CLOUD123_DOWNLOAD_PROBE_MAX_BYTES - totalBytes;
        if (remainingBytes <= 0) {
          finish();
          return;
        }
        const retainedChunk = buffer.length > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
        chunks.push(retainedChunk);
        totalBytes += retainedChunk.length;
        if (totalBytes >= CLOUD123_DOWNLOAD_PROBE_MAX_BYTES) finish();
      };
      const onEnd = () => finish();
      const onError = (error: Error) => fail(error);
      const onAborted = () => finish();
      body.on("data", onData);
      body.once("end", onEnd);
      body.once("error", onError);
      body.once("aborted", onAborted);
    });
  }

  /** 从123下载节点的 JSON 响应中提取真实文件地址。 */
  private readJsonRedirectUrl(responseText: string): string {
    const trimmedText = responseText.trim();
    if (!trimmedText.startsWith("{")) return "";
    try {
      const body = readCloudRecord(JSON.parse(trimmedText));
      if (Number(body.code ?? -1) !== 0) return "";
      const data = readCloudRecord(body.data);
      const redirectUrl = readCloudText(data, ["RedirectUrl", "redirect_url", "download_url", "downloadUrl", "url", "link"])
        || readCloudText(body, ["RedirectUrl", "redirect_url"]);
      return redirectUrl.startsWith("https://") ? redirectUrl : "";
    } catch {
      return "";
    }
  }

  /** 从123中间 HTML 页面中提取 HTTPS 下载链接。 */
  private readHtmlRedirectUrl(responseText: string): string {
    const match = /href=["'](https:\/\/[^"']+)["']/iu.exec(responseText.slice(0, CLOUD123_DOWNLOAD_PROBE_MAX_BYTES));
    return match?.[1]?.replaceAll("&amp;", "&") ?? "";
  }

  /** 判断成功响应正文是否为文件字节，而不是 JSON 或 HTML 中间页。 */
  private isDirectFileResponse(statusCode: number, contentType: string, responseBody: Buffer): boolean {
    if (statusCode !== 200 && statusCode !== 206) return false;
    const normalizedContentType = contentType.toLowerCase();
    if (normalizedContentType.includes("json") || normalizedContentType.includes("html")) return false;
    const textPrefix = responseBody.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    return !textPrefix.startsWith("<!doctype html")
      && !textPrefix.startsWith("<html")
      && !textPrefix.startsWith("{");
  }

  /** 解码 download-v2 的 params，获得实际下载候选地址。 */
  private decodeDownloadV2Url(url: string): string {
    if (!url.includes("/download-v2/")) return "";
    try {
      const encodedValue = new URL(url).searchParams.get("params") ?? "";
      if (!encodedValue) return "";
      const decodedUrl = Buffer.from(encodedValue, "base64url").toString("utf8").trim();
      return decodedUrl.startsWith("https://") ? decodedUrl : "";
    } catch {
      return "";
    }
  }

  /** 123中间下载地址转换为桌面协议地址。 */
  private rewriteDownloadUrl(value: string): string {
    if (value.includes("/download-v2/")) return value;
    const target = `${value}${value.includes("?") ? "&" : "?"}auto_redirect=0`;
    return `https://web-pro2.123952.com/download-v2/?params=${Buffer.from(target, "utf8").toString("base64url")}&is_s3=0`;
  }
}
