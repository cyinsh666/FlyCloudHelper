import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import { cloud139Headers, CLOUD139_ORIGIN, CLOUD139_UA, parseCloud139Credential } from "./cloud139-protocol.js";
import { registerProviderSharedRateLimit, waitForProviderSharedRateLimit, type ProviderNetworkOptions } from "./network.js";
import { setTimeout as delay } from "node:timers/promises";
import { createProviderRecommendedScanSettings, requireConnectionString, type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess } from "./types.js";

/** 移动个人云只读文件适配，音乐、协议播放与目录浏览共用同一取址。 */
export class Cloud139Provider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "/";
  private readonly routes = new Map<string, Promise<string>>(); // 账号凭据版本隔离路由查询。
  public readonly descriptor: ProviderDescriptor = {
    type: "cloud139", displayName: "移动云盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music", "audiobook"], capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 4 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "qr", displayName: "移动云盘 App 扫码登录", interaction: "qr", recommended: true }], connectionFields: [],
  };

  /** 使用实例网络策略，保留既有 HTTP 与日志配置。 */
  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 凭据内真实账号必须与连接账号一致。 */
  private credential(connection: Record<string, unknown>) {
    const credential = parseCloud139Credential(requireConnectionString(connection, "authorization", "移动云盘授权"));
    if (connection.account && connection.account !== credential.account) throw new ApiError(409, "cloud139_account_changed", "扫码账号与原服务不一致，请添加新服务");
    if (credential.expiresAt && credential.expiresAt <= Date.now()) throw new ApiError(410, "cloud139_authentication_expired", "移动云盘登录已失效，请重新扫码");
    return credential;
  }

  /** 验证真实个人云路由并保存账号摘要。 */
  protected async loadAccountLabel(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<string> {
    const credential = this.credential(connection);
    await this.personalHost(connection, signal);
    Object.assign(connection, credential, { accountSummary: credential.account });
    await context?.persistConnection?.(connection);
    return credential.account;
  }

  /** 游标原样传给上游，重复游标或空中间页不能作为成功结束。 */
  protected async listPage(connection: Record<string, unknown>, parentId: string, _page: number, signal?: AbortSignal, _context?: ProviderConnectionContext, pageToken = ""): Promise<CloudDrivePage> {
    const data = await this.request(connection, "/file/list", { parentFileId: parentId || "/", pageInfo: { pageCursor: pageToken, pageSize: 100 }, orderBy: "updated_at", orderDirection: "DESC", imageThumbnailStyleList: ["Small", "Large"] }, signal);
    if (!Array.isArray(data.items)) throw new ApiError(502, "cloud139_list_invalid", "移动云盘目录数据异常");
    if (data.nextPageCursor != null && typeof data.nextPageCursor !== "string") throw new ApiError(502, "cloud139_cursor_invalid", "移动云盘游标数据异常");
    const next = String(data.nextPageCursor ?? "");
    if (next && (next === pageToken || !data.items.length)) throw new ApiError(502, "cloud139_cursor_repeated", "移动云盘目录分页异常，请重试");
    return { hasMore: Boolean(next), nextPageToken: next, items: data.items.map((raw) => {
      const item = readCloudRecord(raw);
      const id = readCloudText(item, ["fileId", "catalogId"]);
      const name = readCloudText(item, ["name", "catalogName"]);
      if (!id || !name) throw new ApiError(502, "cloud139_item_invalid", "移动云盘目录项缺少文件标识或名称");
      const timestamp = typeof item.updatedAt === "string" && !/^\d+$/u.test(item.updatedAt) ? Date.parse(item.updatedAt) : Number(item.updatedAt);
      return { id, name, parentId, isDirectory: String(item.type).toLowerCase() === "folder", size: Math.max(0, Number(item.size) || 0),
        modifiedAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null, etag: null,
        locator: { providerType: "cloud139", fileId: id } };
    }) };
  }

  /** 只获取原文件地址，CDN 请求不携带业务 Authorization。 */
  protected async loadFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderFileAccess> {
    const data = await this.request(connection, "/file/getDownloadUrl", { fileId: requireConnectionString(locator, "fileId", "移动云盘文件标识") }, signal);
    const url = readCloudText(data, ["cdnUrl", "url"]);
    if (!/^https?:\/\//iu.test(url)) throw new ApiError(502, "cloud139_download_invalid", "移动云盘未返回原文件地址");
    return { url, expiresAt: new Date(Date.now() + 300_000).toISOString(), headers: { "User-Agent": CLOUD139_UA, Referer: `${CLOUD139_ORIGIN}/`, Origin: CLOUD139_ORIGIN } };
  }

  /** 读取字幕、NFO 或音乐旁挂歌词。 */
  public async readText(connection: Record<string, unknown>, entry: ProviderEntry, signal?: AbortSignal): Promise<string> {
    return readCloudTextFile(await this.loadFileAccess(connection, entry.locator, signal), this.networkOptions, signal);
  }

  /** 凭据版本隔离路由，失败任务不留在缓存。 */
  private async personalHost(connection: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const credential = this.credential(connection);
    let task = this.routes.get(credential.authorization);
    if (!task) {
      task = this.signed(connection, "https://user-njs.yun.139.com/user/route/qryRoutePolicy", { userInfo: { userType: 1, accountType: 1, accountName: credential.account }, modAddrType: 1 }, signal).then((data) => {
        for (const raw of Array.isArray(data.routePolicyList) ? data.routePolicyList : []) {
          const route = readCloudRecord(raw);
          if (String(route.modName).toLowerCase() !== "personal") continue;
          const host = new URL(String(route.httpsUrl));
          if (host.protocol === "https:" && !host.username && !host.password && !host.search && !host.hash && (!host.port || host.port === "443")) return host.href.replace(/\/+$/u, "");
        }
        throw new ApiError(502, "cloud139_route_invalid", "移动云盘未返回个人云路由");
      });
      if (this.routes.size >= 100) this.routes.clear();
      this.routes.set(credential.authorization, task);
    }
    try { return await task; } catch (error) { this.routes.delete(credential.authorization); throw error; }
  }

  /** 读取个人云业务数据，网络失败时让后续任务重新发现路由。 */
  private async request(connection: Record<string, unknown>, route: string, body: Record<string, unknown>, signal?: AbortSignal) {
    try { return await this.signed(connection, `${await this.personalHost(connection, signal)}${route}`, body, signal); }
    catch (error) { this.routes.delete(String(connection.authorization)); throw error; }
  }

  /** 5xx 和业务限流有限重试，授权或权限问题直接报告。 */
  private async signed(connection: Record<string, unknown>, url: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try { return await this.signedOnce(connection, url, values, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ApiError) || attempt >= 2) throw error;
        if (error.code === "cloud139_rate_limited") {
          registerProviderSharedRateLimit(url, (attempt + 1) * 2000);
          await waitForProviderSharedRateLimit(url, signal);
        } else if (error.code === "provider_request_failed" && /状态码 5\d\d/u.test(error.message)) {
          await delay((attempt + 1) * 1500, undefined, { signal });
        } else throw error;
      }
    }
  }

  /** 统一签名与业务错误分类。 */
  private async signedOnce(connection: Record<string, unknown>, url: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = JSON.stringify(values);
    const result = await requestCloudApiText(url, { method: "POST", body, headers: cloud139Headers(body, this.credential(connection).authorization) }, this.networkOptions, signal);
    const payload = parseCloudApiObject(result.text, ["fileId", "catalogId"]);
    const code = String(payload.code ?? "");
    if (["9000", "9008", "9100", "100002"].includes(code)) throw new ApiError(410, "cloud139_authentication_expired", "移动云盘登录已失效，请重新扫码");
    if (["403", "100403"].includes(code)) throw new ApiError(403, "cloud139_permission_denied", "移动云盘文件访问权限不足");
    if (code === "429") throw new ApiError(429, "cloud139_rate_limited", "移动云盘请求频繁，请稍后重试");
    if (payload.success === false || (!["", "0", "0000"].includes(code) && payload.success !== true)) {
      throw new ApiError(502, "cloud139_business_failed", `移动云盘接口返回业务错误（业务码：${code || "未返回"}）`);
    }
    return readCloudRecord(payload.data);
  }
}
