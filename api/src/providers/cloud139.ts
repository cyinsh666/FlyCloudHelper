import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import { cloud139Headers, CLOUD139_ORIGIN, CLOUD139_UA, parseCloud139Credential } from "./cloud139-protocol.js";
import { registerProviderSharedRateLimit, waitForProviderSharedRateLimit, type ProviderNetworkOptions } from "./network.js";
import { setTimeout as delay } from "node:timers/promises";
import { createProviderRecommendedScanSettings, requireConnectionString, type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess, type ProviderFileOrganizer, type ProviderMutationResult } from "./types.js";

/** 移动个人云文件适配，音乐、协议播放、目录浏览与整理共用同一连接。 */
export class Cloud139Provider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "/";
  private readonly routes = new Map<string, Promise<string>>(); // 账号凭据版本隔离路由查询。
  /** 写接口按 LitePan 的 300 毫秒节奏错峰，扫描读请求保持原有限流策略。 */
  private nextOrganizeRequestAt = 0;
  /** 个人云写接口与现有扫码凭据、路由和签名请求共用同一连接。 */
  public readonly fileOrganizer: ProviderFileOrganizer = {
    supports: (connection) => typeof connection.authorization === "string" && Boolean(connection.authorization.trim()),
    createDirectory: (connection, parentId, name) => this.createOrganizeDirectory(connection, parentId, name),
    rename: (connection, resourceId, name) => this.renameOrganizeFile(connection, resourceId, name),
    move: (connection, resourceId, parentId) => this.transferOrganizeFiles(connection, "move", [resourceId], parentId),
    moveMany: (connection, resourceIds, parentId) => this.transferOrganizeFiles(connection, "move", resourceIds, parentId),
    copy: (connection, resourceId, parentId) => this.transferOrganizeFiles(connection, "copy", [resourceId], parentId),
    copyMany: (connection, resourceIds, parentId) => this.transferOrganizeFiles(connection, "copy", resourceIds, parentId),
    remove: (connection, resourceId) => this.removeOrganizeFiles(connection, [resourceId]),
    removeMany: (connection, resourceIds) => this.removeOrganizeFiles(connection, resourceIds),
    taskStatus: async () => "completed",
  };
  public readonly descriptor: ProviderDescriptor = {
    type: "cloud139", displayName: "移动云盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music", "audiobook"], capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 4 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "qr", displayName: "移动云盘 App 扫码登录", interaction: "qr", recommended: true }], connectionFields: [],
  };

  /** 使用实例网络策略，保留既有 HTTP 与日志配置。 */
  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 检查整理文件 ID，避免个人云根目录被作为普通文件写入。 */
  private organizeIds(resourceIds: string[]): string[] {
    if (!resourceIds.length || resourceIds.some((id) => !id || ["/", "0", "root"].includes(id))) {
      throw new ApiError(422, "cloud139_organize_id_invalid", "移动云盘整理文件编号无效");
    }
    return resourceIds;
  }

  /** 仅整理写操作使用固定间隔，避免同一批任务形成瞬时突发。 */
  private async organizeRequest(connection: Record<string, unknown>, route: string,
    body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const scheduledAt = Math.max(Date.now(), this.nextOrganizeRequestAt);
    this.nextOrganizeRequestAt = scheduledAt + 300;
    if (scheduledAt > Date.now()) await delay(scheduledAt - Date.now());
    return this.request(connection, route, body);
  }

  /** 个人云创建目录返回稳定文件 ID，最终名称仍由公共整理流程核对。 */
  private async createOrganizeDirectory(connection: Record<string, unknown>, parentId: string, name: string): Promise<ProviderMutationResult> {
    if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f]/u.test(name)) {
      throw new ApiError(422, "cloud139_organize_name_invalid", "移动云盘目录名称无效");
    }
    const data = await this.organizeRequest(connection, "/file/create", {
      parentFileId: parentId || "/", name, description: "", type: "folder", fileRenameMode: "force_rename",
    });
    const resourceId = readCloudText(data, ["fileId"]);
    return resourceId ? { resourceId } : {};
  }

  /** 通过个人云批量接口移动或复制同一目标目录的文件。 */
  private async transferOrganizeFiles(connection: Record<string, unknown>, operation: "move" | "copy",
    resourceIds: string[], parentId: string): Promise<ProviderMutationResult> {
    await this.organizeRequest(connection, operation === "move" ? "/file/batchMove" : "/file/batchCopy", {
      fileIds: this.organizeIds(resourceIds), toParentFileId: parentId || "/",
    });
    return {};
  }

  /** 删除进入回收站，公共整理流程随后重新读取目标目录确认。 */
  private async removeOrganizeFiles(connection: Record<string, unknown>, resourceIds: string[]): Promise<ProviderMutationResult> {
    await this.organizeRequest(connection, "/recyclebin/batchTrash", { fileIds: this.organizeIds(resourceIds) });
    return {};
  }

  /** 同一资源的改名由稳定文件 ID 定位，不改变整理命名规则。 */
  private async renameOrganizeFile(connection: Record<string, unknown>, resourceId: string, name: string): Promise<ProviderMutationResult> {
    if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f]/u.test(name)) {
      throw new ApiError(422, "cloud139_organize_name_invalid", "移动云盘文件名称无效");
    }
    await this.organizeRequest(connection, "/file/update", { fileId: this.organizeIds([resourceId])[0], name, description: "" });
    return {};
  }

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
