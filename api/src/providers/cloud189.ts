import { createHmac, randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudNumber, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import type { ProviderNetworkOptions } from "./network.js";
import { type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess, createProviderRecommendedScanSettings, requireConnectionString } from "./types.js";

const CLOUD189_API = "https://api.cloud.189.cn";
const CLOUD189_AUTH = "https://open.e.189.cn";
const CLOUD189_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

/** 天翼云盘个人云签名接口 Provider。 */
export class Cloud189Provider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "-11";
  public readonly descriptor: ProviderDescriptor = {
    type: "cloud189", displayName: "天翼云盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay", "personalCloud"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 2 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "qr", displayName: "扫码登录", interaction: "qr", recommended: true }],
    connectionFields: [],
  };

  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 天翼账号摘要已经由扫码交换返回；根目录请求负责最终验证会话。 */
  protected async loadAccountLabel(connection: Record<string, unknown>): Promise<string | null> {
    const loginName = String(connection.loginName ?? "").trim();
    return loginName ? this.maskAccount(loginName) : "天翼云盘个人云";
  }

  /** 按页读取个人云目录。 */
  protected async listPage(connection: Record<string, unknown>, parentId: string, page: number, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<CloudDrivePage> {
    const limit = 1000;
    const payload = await this.signedGet(connection, "/listFiles.action", {
      folderId: parentId, fileType: "0", mediaAttr: "0", iconOption: "5", recursive: "0",
      orderBy: "filename", descending: "false", pageNum: String(page), pageSize: String(limit),
    }, signal, context);
    const list = readCloudRecord(payload.fileListAO);
    const folders = Array.isArray(list.folderList) ? list.folderList : [];
    const files = Array.isArray(list.fileList) ? list.fileList : [];
    const mapItem = (value: unknown, isDirectory: boolean) => {
      const item = readCloudRecord(value);
      const id = readCloudText(item, ["id", "fileId", "folderId"]);
      const modified = readCloudText(item, ["lastOpTime", "lastOpDate", "modifyDate", "createDate", "createTime"]);
      return {
        id, parentId: readCloudText(item, ["parentId", "parentFolderId"]) || parentId,
        name: readCloudText(item, ["name", "fileName", "folderName"]).replace(/\\'/gu, "'") || id,
        isDirectory, size: isDirectory ? 0 : readCloudNumber(item.size),
        modifiedAt: this.parseModifiedAt(modified), etag: readCloudText(item, ["md5"]) || null,
        locator: { providerType: "cloud189", fileId: id, md5: readCloudText(item, ["md5"]) },
      };
    };
    const total = readCloudNumber(list.count ?? list.totalCount ?? list.total);
    const items = [...folders.map((item) => mapItem(item, true)), ...files.map((item) => mapItem(item, false))].filter((item) => item.id);
    return { items, hasMore: total > 0 ? page * limit < total : items.length >= limit };
  }

  /** 获取天翼个人云短时下载地址。 */
  protected async loadFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileAccess> {
    const payload = await this.signedGet(connection, "/getFileDownloadUrl.action", {
      fileId: requireConnectionString(locator, "fileId", "天翼文件 ID"), dt: "3", flag: "1",
    }, signal, context);
    const url = readCloudText(payload, ["fileDownloadUrl", "downloadUrl", "url"]).replace(/&amp;/gu, "&").replace(/^http:\/\//iu, "https://");
    if (!url) throw new ApiError(502, "cloud189_download_url_missing", "天翼云盘未返回下载地址");
    return { url, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), headers: { "User-Agent": CLOUD189_UA, Referer: "https://cloud.189.cn" } };
  }

  /** 读取天翼小型文本文件。 */
  public async readText(connection: Record<string, unknown>, entry: ProviderEntry, signal?: AbortSignal): Promise<string> {
    return readCloudTextFile(await this.loadFileAccess(connection, entry.locator, signal), this.networkOptions, signal);
  }

  /** 执行带 HMAC-SHA1 签名的个人云 GET 请求。 */
  private async signedGet(connection: Record<string, unknown>, path: string, parameters: Record<string, string>, signal?: AbortSignal, context?: ProviderConnectionContext, retried = false): Promise<Record<string, unknown>> {
    await this.ensureSession(connection, signal, context);
    const sessionKey = requireConnectionString(connection, "sessionKey", "天翼 SessionKey");
    const sessionSecret = requireConnectionString(connection, "sessionSecret", "天翼 SessionSecret");
    const date = new Date().toUTCString();
    const signatureSource = `SessionKey=${sessionKey}&Operate=GET&RequestURI=${path}&Date=${date}`;
    const signature = createHmac("sha1", sessionSecret).update(signatureSource).digest("hex").toUpperCase();
    const query = new URLSearchParams({ clientType: "TELEPC", version: "6.2", channelId: "web_cloud.189.cn", rand: `${Math.floor(Math.random() * 100000)}_${Date.now()}`, ...parameters });
    try {
      const result = await requestCloudApiText(`${CLOUD189_API}${path}?${query}`, { method: "GET", headers: {
        Accept: "application/json;charset=UTF-8", "Accept-Language": "zh-CN,zh;q=0.9", "User-Agent": CLOUD189_UA,
        Referer: "https://cloud.189.cn", Date: date, SessionKey: sessionKey, Signature: signature, "X-Request-ID": randomUUID(),
      } }, this.networkOptions, signal);
      const payload = parseCloudApiObject(result.text, ["id", "fileId", "folderId", "parentId", "parentFolderId"]);
      const code = readCloudText(payload, ["res_code", "code", "errorCode"]);
      if (code && code !== "0" && code.toUpperCase() !== "SUCCESS") throw new ApiError(410, "cloud189_session_expired", "天翼云盘登录会话已失效");
      return payload;
    } catch (error) {
      if (!retried && error instanceof ApiError && ["provider_authentication_failed", "cloud189_session_expired"].includes(error.code)) {
        await this.refreshToken(connection, signal, context);
        return this.signedGet(connection, path, parameters, signal, context, true);
      }
      throw error;
    }
  }

  /** 缺少 PC Session 时通过 Access Token 初始化。 */
  private async ensureSession(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<void> {
    if (String(connection.sessionKey ?? "").trim() && String(connection.sessionSecret ?? "").trim()) return;
    const accessToken = requireConnectionString(connection, "accessToken", "天翼 Access Token");
    const query = new URLSearchParams({ clientType: "TELEPC", version: "6.2", channelId: "web_cloud.189.cn", rand: `${Math.floor(Math.random() * 100000)}_${Date.now()}`, appId: "8025431004", accessToken });
    const result = await requestCloudApiText(`${CLOUD189_API}/getSessionForPC.action?${query}`, { method: "GET", headers: { "User-Agent": CLOUD189_UA, Referer: "https://cloud.189.cn", "X-Request-ID": randomUUID() } }, this.networkOptions, signal);
    const payload = parseCloudApiObject(result.text);
    const sessionKey = readCloudText(payload, ["sessionKey"]);
    const sessionSecret = readCloudText(payload, ["sessionSecret"]);
    if (!sessionKey || !sessionSecret) throw new ApiError(410, "cloud189_session_invalid", "天翼云盘登录会话不完整，请重新扫码");
    connection.sessionKey = sessionKey;
    connection.sessionSecret = sessionSecret;
    connection.loginName = readCloudText(payload, ["loginName"]) || connection.loginName;
    connection.refreshToken = readCloudText(payload, ["refreshToken"]) || connection.refreshToken;
    await context?.persistConnection?.(connection);
  }

  /** 刷新 OAuth Token 后重新初始化 PC Session。 */
  private async refreshToken(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<void> {
    const refreshToken = requireConnectionString(connection, "refreshToken", "天翼 Refresh Token");
    const result = await requestCloudApiText(`${CLOUD189_AUTH}/api/oauth2/refreshToken.do`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: CLOUD189_AUTH },
      body: new URLSearchParams({ clientId: "8025431004", refreshToken, grantType: "refresh_token", format: "json" }),
    }, this.networkOptions, signal);
    const payload = parseCloudApiObject(result.text);
    const accessToken = readCloudText(payload, ["accessToken", "access_token"]);
    if (!accessToken) throw new ApiError(410, "cloud189_refresh_expired", "天翼云盘登录已失效，请重新扫码");
    connection.accessToken = accessToken;
    connection.refreshToken = readCloudText(payload, ["refreshToken"]) || refreshToken;
    connection.expiresAt = readCloudNumber(payload.expiresIn ?? payload.expires_in) > 0 ? Date.now() + readCloudNumber(payload.expiresIn ?? payload.expires_in) * 1_000 : 0;
    connection.sessionKey = "";
    connection.sessionSecret = "";
    await this.ensureSession(connection, signal, context);
  }

  /** 解析秒、毫秒或日期文本。 */
  private parseModifiedAt(value: string): string | null {
    if (!value) return null;
    const number = Number(value);
    const timestamp = Number.isFinite(number) && number > 0 ? (number > 1_000_000_000_000 ? number : number * 1_000) : Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  /** 仅展示脱敏登录名。 */
  private maskAccount(value: string): string { return value.length <= 4 ? `${value.slice(0, 1)}***` : `${value.slice(0, 2)}***${value.slice(-2)}`; }
}
