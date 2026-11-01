import { refreshBaiduOfficialToken } from "./baidupan-official-refresh.js";
import { readBaiduOAuthIdentity, resolveBaiduWebPlayback, supportsBaiduWebPlayback,
  validateBaiduWebCookie } from "./baidupan-web-playback.js";
import path from "node:path";
import { loadEnumerationPage } from "./types.js";
import { ApiError } from "../errors.js";
import { CredentialRefreshCoordinator } from "./credential-refresh-coordinator.js";
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  providerFetch,
  readProviderRateLimitDelayMs,
  registerProviderSharedRateLimit,
  validateProviderUrl,
  waitForProviderSharedRateLimit,
  type ProviderNetworkOptions,
} from "./network.js";
import {
  type ProviderAdapter,
  type ProviderConnectionContext,
  type ProviderDescriptor,
  type ProviderBrowseListing,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderFileAccess,
  type ProviderValidationResult,
  type ProviderFileStreamAccess,
  type ProviderFileOrganizer,
  type ProviderMutationResult,
  type ScanRoot,
  createProviderRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

interface BaiduFileItem {
  fs_id?: number | string;
  path?: string;
  server_filename?: string;
  isdir?: number;
  size?: number;
  server_mtime?: number;
  md5?: string;
}

/** 百度网盘一次完整的令牌轮换结果。 */
interface BaiduTokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshUrl: string;
}

const DEFAULT_BAIDUPAN_REFRESH_URL = "https://api.oplist.org/baiduyun/renewapi";
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
// 关键变量：这些 errno 明确表示 Access Token 失效，可以刷新一次；其他业务码不能误判成登录失效。
const BAIDUPAN_AUTHENTICATION_ERROR_CODES = new Set([2, 110, 111, -6, 401]);

/** 百度网盘开放接口 Provider。 */
export class BaiduPanProvider implements ProviderAdapter {
  /** 百度写接口使用路径；每次操作前按 fs_id 查询实时路径。 */
  public readonly fileOrganizer: ProviderFileOrganizer = {
    supports: (connection) => typeof connection.accessToken === "string" && Boolean(connection.accessToken.trim())
      && typeof connection.refreshToken === "string" && Boolean(connection.refreshToken.trim())
      && ["openlist", "flymby_server", "baidu_official"].includes(String(connection.authSource || "openlist")),
    createDirectory: (connection, parentId, name, context) => this.createOrganizeDirectory(connection, parentId, name, context),
    rename: (connection, resourceId, name, context) => this.renameOrganizeFile(connection, resourceId, name, context),
    move: (connection, resourceId, parentId, context) => this.transferOrganizeFile(connection, "move", resourceId, parentId, context),
    moveMany: (connection, resourceIds, parentId, context) => this.transferOrganizeFiles(connection, "move", resourceIds, parentId, context),
    copy: (connection, resourceId, parentId, context) => this.transferOrganizeFile(connection, "copy", resourceId, parentId, context),
    copyMany: (connection, resourceIds, parentId, context) => this.transferOrganizeFiles(connection, "copy", resourceIds, parentId, context),
    remove: (connection, resourceId, context) => this.removeOrganizeFile(connection, resourceId, context),
    removeMany: (connection, resourceIds, context) => this.removeOrganizeFiles(connection, resourceIds, context),
    taskStatus: async () => "completed",
  };
  public readonly descriptor: ProviderDescriptor = {
    type: "baidupan",
    displayName: "百度网盘",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 2,
    supportedDataTypes: ["video", "music", "audiobook"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({
      // 百度单页可以读取 1000 项，但业务码 31034 对突发并发更敏感。
      scanDirectoryConcurrency: { default: 4 },
    }),
    connectionFields: [
      { name: "accessToken", label: "Access Token", type: "password", required: true, secret: true },
      { name: "refreshToken", label: "Refresh Token", type: "password", required: true, secret: true },
      { name: "refreshUrl", label: "Token 刷新地址", type: "url", required: false, secret: false },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;
  /** 按旧 Refresh Token 合并跨请求刷新，并接住稍晚到达的旧连接副本。 */
  private readonly tokenRefreshCoordinator = new CredentialRefreshCoordinator<BaiduTokenRefreshResult>();

  /** 创建百度请求适配器，官方应用密钥始终由 FlymbyServer 保存。 */
  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 从现有 OAuth 连接读取网盘账号，供独立网页登录核对。 */
  public async readWebLoginIdentity(connection: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>): Promise<{ userId: string; vipType: number | null }> {
    await this.ensureValidToken(connection, persistConnection);
    return readBaiduOAuthIdentity(requireConnectionString(connection, "accessToken", "Access Token"), this.networkOptions);
  }

  /** 校验浏览器取得的 Cookie 与当前网盘服务为同一账号。 */
  public async validateWebLoginCookie(cookie: string, userId: string): Promise<void> {
    await validateBaiduWebCookie(cookie, userId, this.networkOptions);
  }

  /** 网页补充凭据只作用于视频取链，失败后保持原有 OAuth 播放路径。 */
  private async tryWebPlaybackAccess(
    connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess | null> {
    const cookie = typeof connection.webPlaybackCookie === "string" ? connection.webPlaybackCookie.trim() : "";
    const userId = typeof connection.webPlaybackUserId === "string" ? connection.webPlaybackUserId.trim() : "";
    const filePath = typeof locator.path === "string" ? locator.path : "";
    if (!cookie || !/^\d+$/u.test(userId) || !supportsBaiduWebPlayback(filePath)) return null;
    const fsId = requireConnectionString(locator, "fsId", "文件 ID");
    const currentPath = await this.organizePath(connection, fsId, context);
    return resolveBaiduWebPlayback(currentPath, cookie, userId,
      typeof context?.playbackUserAgent === "string" ? context.playbackUserAgent : undefined,
      this.networkOptions, signal);
  }

  /** 读取实时文件路径；根目录在百度 API 中没有 fs_id。 */
  private async organizePath(
    connection: Record<string, unknown>, resourceId: string, context?: ProviderConnectionContext,
    retriedAuthentication = false,
  ): Promise<string> {
    if (resourceId === "/") return "/";
    if (!/^\d+$/u.test(resourceId)) throw new ApiError(422, "baidupan_organize_id_invalid", "百度网盘资源编号无效");
    await this.ensureValidToken(connection, context?.persistConnection);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl ? connection.apiBaseUrl : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/multimedia", baseUrl);
    url.searchParams.set("method", "filemetas");
    url.searchParams.set("access_token", accessToken);
    // 关键变量：百度 fs_id 可能超过安全整数，直接放入 JSON 数组文本，不经过 Number。
    url.searchParams.set("fsids", `[${resourceId}]`);
    url.searchParams.set("dlink", "0");
    const payload = await this.requestBaiduJsonWithRateLimitRetry<{ errno?: number; list?: BaiduFileItem[] }>(url);
    const businessCode = Number(payload.errno ?? -1);
    if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(businessCode) && !retriedAuthentication) {
      await this.refreshAfterAuthenticationFailure(connection, accessToken, context?.persistConnection);
      return this.organizePath(connection, resourceId, context, true);
    }
    if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(businessCode)) {
      throw new ApiError(410, "baidupan_authentication_expired", "百度网盘登录已失效，请重新登录");
    }
    if (businessCode !== 0) throw new ApiError(502, "baidupan_organize_metadata_failed", `百度网盘文件信息查询失败（业务码：${businessCode}）`);
    const item = payload.list?.[0];
    if (String(item?.fs_id ?? "") !== resourceId || typeof item?.path !== "string" || !item.path.startsWith("/")) {
      throw new ApiError(404, "baidupan_organize_file_missing", "百度网盘文件已变化，请重新预览");
    }
    return item.path;
  }

  /** 提交百度表单写接口，并检查顶层及逐项业务结果。 */
  private async organizeMutation(
    connection: Record<string, unknown>, method: "create" | "filemanager", fields: Record<string, string>,
    context?: ProviderConnectionContext, operation?: "copy" | "move" | "rename" | "delete",
    retriedAuthentication = false,
  ): Promise<ProviderMutationResult> {
    await this.ensureValidToken(connection, context?.persistConnection);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl ? connection.apiBaseUrl : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/file", baseUrl);
    url.searchParams.set("method", method);
    url.searchParams.set("access_token", accessToken);
    if (operation) url.searchParams.set("opera", operation);
    const body = new URLSearchParams(fields);
    for (let retryCount = 0; ; retryCount += 1) {
      const response = await providerFetch(url, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      }, this.networkOptions);
      const payload = await response.json() as { errno?: number; info?: Array<{ errno?: number }>; taskid?: number | string };
      const businessCode = Number(payload.errno ?? -1);
      if (businessCode === 31034) {
        if (retryCount >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
          throw new ApiError(503, "provider_rate_limited", "百度网盘访问频率受限，请稍后继续整理");
        }
        registerProviderSharedRateLimit(url, readProviderRateLimitDelayMs(null, retryCount));
        await waitForProviderSharedRateLimit(url);
        continue;
      }
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(businessCode) && !retriedAuthentication) {
        await this.refreshAfterAuthenticationFailure(connection, accessToken, context?.persistConnection);
        return this.organizeMutation(connection, method, fields, context, operation, true);
      }
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(businessCode)) {
        throw new ApiError(410, "baidupan_authentication_expired", "百度网盘登录已失效，请重新登录");
      }
      if (businessCode !== 0) throw new ApiError(502, "baidupan_organize_failed", `百度网盘文件操作失败（业务码：${businessCode}）`);
      const failedItem = payload.info?.find((item) => Number(item.errno ?? 0) !== 0);
      if (failedItem) throw new ApiError(502, "baidupan_organize_item_failed", `百度网盘文件操作失败（业务码：${Number(failedItem.errno)}）`);
      // 当前调用明确要求同步完成；若上游意外改为异步，不能把任务提交当成文件已落盘。
      if (payload.taskid) throw new ApiError(502, "baidupan_organize_async_unexpected", "百度网盘返回了未预期的异步任务，请稍后检查目录");
      return {};
    }
  }

  /** 创建目录前把父级资源 ID 转为百度路径，目录是否落盘由公共层再次列出确认。 */
  private async createOrganizeDirectory(
    connection: Record<string, unknown>, parentId: string, name: string, context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    if (!name || name === "." || name === ".." || name.includes("/")) {
      throw new ApiError(422, "baidupan_organize_name_invalid", "百度网盘目录名称无效");
    }
    const parentPath = await this.organizePath(connection, parentId, context);
    return this.organizeMutation(connection, "create", {
      path: path.posix.join(parentPath, name), size: "0", isdir: "1", rtype: "0",
    }, context);
  }

  /** 百度重命名只接受文件当前路径和新名称。 */
  private async renameOrganizeFile(
    connection: Record<string, unknown>, resourceId: string, name: string, context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    const sourcePath = await this.organizePath(connection, resourceId, context);
    return this.organizeMutation(connection, "filemanager", {
      async: "0", filelist: JSON.stringify([{ path: sourcePath, newname: name }]), ondup: "fail",
    }, context, "rename");
  }

  /** 复制和移动都使用实时源路径及目标目录路径。 */
  private async transferOrganizeFile(
    connection: Record<string, unknown>, operation: "copy" | "move", resourceId: string, parentId: string,
    context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    const sourcePath = await this.organizePath(connection, resourceId, context);
    const targetPath = await this.organizePath(connection, parentId, context);
    return this.organizeMutation(connection, "filemanager", {
      async: "0", filelist: JSON.stringify([{ path: sourcePath, dest: targetPath,
        newname: path.posix.basename(sourcePath) }]), ondup: "fail",
    }, context, operation);
  }

  /** 百度写接口以路径提交文件列表；先逐项确认实时路径，再一次提交同目录文件。 */
  private async transferOrganizeFiles(
    connection: Record<string, unknown>, operation: "copy" | "move", resourceIds: string[], parentId: string,
    context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    const targetPath = await this.organizePath(connection, parentId, context);
    const sourcePaths = await this.organizePaths(connection, resourceIds, context);
    return this.organizeMutation(connection, "filemanager", {
      async: "0", filelist: JSON.stringify(sourcePaths.map((sourcePath) => ({ path: sourcePath,
        dest: targetPath, newname: path.posix.basename(sourcePath) }))), ondup: "fail",
    }, context, operation);
  }

  /** 仅删除传入资源 ID 实时对应的文件或空目录。 */
  private async removeOrganizeFile(
    connection: Record<string, unknown>, resourceId: string, context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    const sourcePath = await this.organizePath(connection, resourceId, context);
    return this.organizeMutation(connection, "filemanager", {
      async: "0", filelist: JSON.stringify([sourcePath]), ondup: "fail",
    }, context, "delete");
  }

  /** 批量删除前逐项核对 fs_id 的实时路径，避免移动后误删旧路径上的新文件。 */
  private async removeOrganizeFiles(
    connection: Record<string, unknown>, resourceIds: string[], context?: ProviderConnectionContext,
  ): Promise<ProviderMutationResult> {
    const sourcePaths = await this.organizePaths(connection, resourceIds, context);
    return this.organizeMutation(connection, "filemanager", {
      async: "0", filelist: JSON.stringify(sourcePaths), ondup: "fail",
    }, context, "delete");
  }

  /** 限制批量写入前的元数据查询并发，避免一次发出几十个百度请求。 */
  private async organizePaths(
    connection: Record<string, unknown>, resourceIds: string[], context?: ProviderConnectionContext,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (let index = 0; index < resourceIds.length; index += 4) {
      const group = resourceIds.slice(index, index + 4);
      paths.push(...await Promise.all(group.map((resourceId) => this.organizePath(connection, resourceId, context))));
    }
    return paths;
  }

  /** 官方与原来源显式区分，未知来源不能静默退回 OpenList。 */
  private readAuthSource(connection: Record<string, unknown>): string {
    const source = String(connection.authSource || "openlist").trim();
    if (!["openlist", "flymby_server", "baidu_official"].includes(source)) {
      throw new ApiError(422, "baidupan_auth_source_invalid", "不支持的百度网盘登录来源");
    }
    return source;
  }

  /** 读取根目录验证百度网盘 Access Token。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderValidationResult> {
    this.readAuthSource(connection);
    await this.listDirectory(connection, "/", 0, signal, context?.persistConnection);
    return { valid: true, accountLabel: null, rootAccessible: true };
  }

  /** 验证每个百度网盘扫描根路径可以正常列目录。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.displayPath || root.resourceId || "/", 0, signal,
        context?.persistConnection);
    }
  }

  /** 返回百度网盘当前路径的直接子目录，供前端目录选择器使用。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderDirectoryListing> {
    const directory = parent?.displayPath || parent?.resourceId || "/";
    let start = 0;
    const items: ProviderDirectoryListing["items"] = [];
    while (true) {
      const page = await this.listDirectory(connection, directory, start, signal, context?.persistConnection);
      for (const item of page.items) {
        if (item.isdir !== 1) continue;
        const displayPath = item.path || `${directory.replace(/\/$/u, "")}/${item.server_filename ?? ""}`;
        const resourceId = String(item.fs_id ?? displayPath);
        items.push({
          name: item.server_filename || displayPath.split("/").pop() || resourceId,
          resourceId,
          displayPath,
        });
      }
      if (!page.hasMore || page.items.length === 0) break;
      start += page.items.length;
    }
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: directory === "/" ? "/" : directory.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parent?.resourceId || directory,
        displayPath: directory,
      },
      items,
    };
  }

  /** 使用百度文件列表分页读取当前目录的直接子项。 */
  public async browseEntries(connection: Record<string, unknown>, parent?: ScanRoot, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderBrowseListing> {
    const directory = parent?.displayPath || parent?.resourceId || "/";
    const items: ProviderBrowseListing["items"] = [];
    let start = 0;
    while (true) {
      const page = await this.listDirectory(connection, directory, start, signal, context?.persistConnection);
      for (const item of page.items) {
        const displayPath = item.path || `${directory.replace(/\/$/u, "")}/${item.server_filename ?? ""}`;
        const resourceId = String(item.fs_id ?? displayPath);
        items.push({ name: item.server_filename || displayPath.split("/").pop() || resourceId,
          resourceId, parentResourceId: directory, displayPath, isDirectory: item.isdir === 1,
          size: toFileSize(item.size), modifiedAt: item.server_mtime ? new Date(item.server_mtime * 1000).toISOString() : null,
          etag: item.md5 ?? null, locator: { providerType: "baidupan", fsId: resourceId, path: displayPath } });
      }
      if (!page.hasMore || page.items.length === 0) break;
      start += page.items.length;
    }
    return { current: { name: directory === "/" ? "/" : directory.replace(/\/$/u, "").split("/").pop() || "/",
      resourceId: parent?.resourceId || directory, displayPath: directory }, items };
  }

  /** 按目录 path 递归枚举百度网盘文件。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    _onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (let rootIndex = 0; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      // 根目录只有完整枚举后才允许扫描收尾清理旧文件；中止或异常不会提交完成状态。
      await options?.onRootStart?.({ rootIndex, root, warningCount: 0 });
      const queue = [root.displayPath || root.resourceId || "/"];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(directory));
        directoryBatch.forEach((directory) => visited.add(directory));
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          let start = 0;
          const entries: BaiduFileItem[] = [];
          while (true) {
            const page = await loadEnumerationPage(options, directory, String(start), () => this.listDirectory(connection, directory, start, signal, options?.persistConnection));
            entries.push(...page.items);
            if (!page.hasMore || page.items.length === 0) break;
            start += page.items.length;
          }
          return { directory, entries };
        }));
        for (const { directory, entries } of batchResults) {
          const siblingDirectoryNames = entries.filter((item) => item.isdir === 1).map((item) => String(item.server_filename ?? ""));
          for (const item of entries) {
            const path = item.path || `${directory.replace(/\/$/u, "")}/${item.server_filename ?? ""}`;
            const resourceId = String(item.fs_id ?? path);
            const name = item.server_filename || path.split("/").pop() || resourceId;
            if (item.isdir === 1) {
              queue.push(path);
            } else {
              yield {
                siblingDirectoryNames,
                resourceId,
                parentResourceId: directory,
                path,
                name,
                isDirectory: false,
                size: toFileSize(item.size),
                modifiedAt: item.server_mtime ? new Date(item.server_mtime * 1000).toISOString() : null,
                etag: item.md5 ?? null,
                locator: { providerType: "baidupan", fsId: resourceId, path },
              };
            }
          }
          await options?.onDirectoryComplete?.(directory);
        }
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: 0 });
    }
  }

  /** 使用 fs_id 换取百度网盘 dlink，并把本次播放需要的 Token 和请求头临时下发给 APP。 */
  public async resolveFileAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    try {
      const webAccess = await this.tryWebPlaybackAccess(connection, locator, signal, context);
      if (webAccess) return webAccess;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-web-playback", 事件: "补充网页登录取链失败，使用原有播放",
        错误码: error instanceof ApiError ? error.code : "upstream_unavailable",
      });
    }
    return this.resolvePlaybackAccess(connection, locator, signal, context);
  }

  /** 使用与直连一致的百度播放地址作为云助手中转上游。 */
  public async resolveFileStreamAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileStreamAccess> {
    return this.resolveFileAccess(connection, locator, signal, context);
  }

  /** 统一解析百度网盘直连和中转播放需要的临时访问数据。 */
  private async resolvePlaybackAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
    retriedAuthentication = false,
  ): Promise<ProviderFileAccess> {
    await this.ensureValidToken(connection, context?.persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const fsId = requireConnectionString(locator, "fsId", "文件 ID");
    if (!/^\d+$/u.test(fsId)) {
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-cloud-playback",
        事件: "百度网盘播放文件ID格式无效",
        文件ID长度: fsId.length,
        文件ID是否纯数字: false,
      });
      throw new ApiError(422, "baidupan_file_id_invalid", "百度网盘播放文件 ID 无效，请重新扫描后重试");
    }
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl ? connection.apiBaseUrl : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/multimedia", baseUrl);
    url.searchParams.set("method", "filemetas");
    url.searchParams.set("access_token", accessToken);
    // 关键变量：fs_id 可能超过 JavaScript 安全整数范围，直接拼接数字 JSON，不能先转换成 Number。
    url.searchParams.set("fsids", `[${fsId}]`);
    url.searchParams.set("dlink", "1");
    const payload = await this.requestBaiduJsonWithRateLimitRetry<{
      errno?: number;
      list?: Array<{ dlink?: string }>;
    }>(url, signal);
    if (payload.errno && payload.errno !== 0) {
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(payload.errno) && !retriedAuthentication) {
        await this.refreshAfterAuthenticationFailure(connection, accessToken, context?.persistConnection, signal);
        return this.resolvePlaybackAccess(connection, locator, signal, context, true);
      }
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(payload.errno)) {
        throw new ApiError(410, "baidupan_authentication_expired", "百度网盘登录已失效，请重新登录");
      }
      throw new ApiError(502, "baidupan_business_failed", `百度网盘下载接口返回业务错误（业务码：${payload.errno}）`);
    }
    const dlink = payload.list?.[0]?.dlink;
    if (!dlink) {
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-cloud-playback",
        事件: "百度网盘播放地址为空",
        文件ID长度: fsId.length,
      });
      throw new Error("百度网盘开放接口未返回下载地址");
    }
    const downloadUrl = new URL(dlink);
    downloadUrl.searchParams.set("access_token", accessToken);
    return { url: downloadUrl.href, expiresAt: null, headers: { "User-Agent": "pan.baidu.com" } };
  }

  /** 请求百度网盘 xpan 文件列表接口。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    directory: string,
    start: number,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    retriedAuthentication = false,
  ): Promise<{ items: BaiduFileItem[]; hasMore: boolean }> {
    await this.ensureValidToken(connection, persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl
      ? connection.apiBaseUrl
      : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/file", baseUrl);
    url.searchParams.set("method", "list");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("dir", directory);
    url.searchParams.set("start", String(start));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("web", "1");
    const payload = await this.requestBaiduJsonWithRateLimitRetry<{
      errno?: number;
      list?: BaiduFileItem[];
      has_more?: number;
    }>(url, signal);
    if (payload.errno && payload.errno !== 0) {
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(payload.errno) && !retriedAuthentication) {
        await this.refreshAfterAuthenticationFailure(connection, accessToken, persistConnection, signal);
        return this.listDirectory(connection, directory, start, signal, persistConnection, true);
      }
      if (BAIDUPAN_AUTHENTICATION_ERROR_CODES.has(payload.errno)) {
        throw new ApiError(410, "baidupan_authentication_expired", "百度网盘登录已失效，请重新登录");
      }
      throw new ApiError(502, "baidupan_business_failed", `百度网盘接口返回业务错误（业务码：${payload.errno}）`);
    }
    return { items: Array.isArray(payload.list) ? payload.list : [], hasMore: payload.has_more === 1 };
  }

  /** 处理百度网盘以 HTTP 200 返回 errno=31034 的业务限流。 */
  private async requestBaiduJsonWithRateLimitRetry<T extends { errno?: number }>(
    url: URL,
    signal?: AbortSignal,
  ): Promise<T> {
    let retryCount = 0;
    while (true) {
      // HTTP 429 由 providerFetch 统一退避，这里只处理响应体中的百度业务限流码。
      const response = await providerFetch(url, { method: "GET" }, this.networkOptions, signal);
      const responseText = await response.text();
      // 关键变量：百度 fs_id 可能超过安全整数范围，必须在 JSON.parse 前转成字符串保留原始十进制值。
      const stableIdResponseText = responseText.replace(/("fs_id"\s*:\s*)(-?\d+)/gu, "$1\"$2\"");
      const payload = JSON.parse(stableIdResponseText) as T;
      if (payload.errno !== 31034) return payload;
      if (retryCount >= PROVIDER_RATE_LIMIT_MAX_RETRIES || signal?.aborted) {
        this.networkOptions.logConnectionFailure?.({
          日志关键字: "codex-flycloud-provider-rate-limit",
          性能日志关键字: "codex-flycloud-scan-performance",
          事件: "百度网盘业务限流重试后仍未恢复",
          请求路径: url.pathname,
          业务错误码: payload.errno,
          已重试次数: retryCount,
        });
        throw new ApiError(503, "provider_rate_limited", "百度网盘访问频率受限，自动重试后仍未恢复，请稍后重试");
      }
      const retryDelayMs = readProviderRateLimitDelayMs(null, retryCount);
      retryCount += 1;
      const sharedCooldownUntilMs = registerProviderSharedRateLimit(url, retryDelayMs);
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-flycloud-provider-rate-limit",
        性能日志关键字: "codex-flycloud-scan-performance",
        事件: "百度网盘业务限流后等待重试",
        请求路径: url.pathname,
        业务错误码: payload.errno,
        当前重试次数: retryCount,
        最大重试次数: PROVIDER_RATE_LIMIT_MAX_RETRIES,
        等待毫秒: retryDelayMs,
        共享冷却截止时间: new Date(sharedCooldownUntilMs).toISOString(),
      });
      await waitForProviderSharedRateLimit(url, signal);
    }
  }

  /** Access Token 被上游明确拒绝时刷新一次；并发请求发现连接已经更新则直接复用。 */
  private async refreshAfterAuthenticationFailure(
    connection: Record<string, unknown>,
    failedAccessToken: string,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (String(connection.accessToken ?? "").trim() !== failedAccessToken) return;
    await this.ensureValidToken(connection, persistConnection, signal, true);
  }

  /** 临近过期或上游明确拒绝时刷新百度令牌，并把轮换后的 Refresh Token 原位加密保存。 */
  private async ensureValidToken(
    connection: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<void> {
    const authSource = this.readAuthSource(connection);
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (!forceRefresh && accessToken && (expiresAt <= 0 || Date.now() + TOKEN_REFRESH_AHEAD_MS < expiresAt)) return;
    const refreshToken = requireConnectionString(connection, "refreshToken", "Refresh Token");
    const configuredRefreshUrl = typeof connection.refreshUrl === "string" && connection.refreshUrl.trim()
      ? connection.refreshUrl.trim()
      : DEFAULT_BAIDUPAN_REFRESH_URL;
    // 强制刷新把被拒绝的 Access Token 纳入键，避免复用刚刚已被上游判定失效的近期结果。
    const refreshCoordinationKey = forceRefresh
      ? `${configuredRefreshUrl}\n${refreshToken}\n${accessToken}`
      : `${configuredRefreshUrl}\n${refreshToken}`;
    const sharedRefresh = await this.tokenRefreshCoordinator.execute(
      `${authSource}\n${refreshCoordinationKey}`,
      // 轮换独立使用 Provider 的30秒超时，避免首个等待任务取消后丢失已经轮换的令牌。
      () => this.performTokenRefresh(refreshToken, configuredRefreshUrl, authSource),
    );
    connection.accessToken = sharedRefresh.result.accessToken;
    connection.refreshToken = sharedRefresh.result.refreshToken;
    connection.expiresAt = sharedRefresh.result.expiresAt;
    connection.refreshUrl = sharedRefresh.result.refreshUrl;
    await persistConnection?.(connection);
  }

  /** 官方令牌交回 FlymbyServer 使用同一应用续期，不发送到 OpenList。 */
  private async performOfficialTokenRefresh(refreshToken: string, signal?: AbortSignal): Promise<BaiduTokenRefreshResult> {
    const payload = await refreshBaiduOfficialToken(refreshToken, this.networkOptions, signal);
    const accessToken = typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    const nextRefreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken.trim() : "";
    if (!accessToken || !nextRefreshToken) {
      throw new ApiError(410, "baidupan_official_refresh_failed", "百度官方应用登录已失效，请通过原来的官方应用方式重新登录");
    }
    const expiresIn = Number(payload.expiresIn ?? 0);
    return { accessToken, refreshToken: nextRefreshToken,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
      refreshUrl: "" };
  }

  /** 向百度刷新端点提交一次旧 Refresh Token，只返回结果，不修改调用方连接。 */
  private async performTokenRefresh(
    refreshToken: string,
    configuredRefreshUrl: string,
    authSource: string,
    signal?: AbortSignal,
  ): Promise<BaiduTokenRefreshResult> {
    if (authSource === "baidu_official") return this.performOfficialTokenRefresh(refreshToken, signal);
    const refreshUrl = new URL(configuredRefreshUrl);
    if (refreshUrl.protocol !== "https:") throw new Error("百度网盘 Token 刷新地址必须使用 HTTPS");
    refreshUrl.searchParams.set("refresh_ui", refreshToken);
    refreshUrl.searchParams.set("server_use", "true");
    refreshUrl.searchParams.set("driver_txt", "baiduyun_go");
    const safeRefreshUrl = await validateProviderUrl(refreshUrl.href, this.networkOptions);
    const response = await providerFetch(safeRefreshUrl, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as Record<string, unknown>;
    const nextAccessToken = typeof payload.access_token === "string" ? payload.access_token.trim()
      : typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    if (!nextAccessToken) {
      throw new ApiError(410, "baidupan_refresh_expired", "百度网盘登录已失效，请重新登录");
    }
    const nextRefreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : typeof payload.refreshToken === "string" && payload.refreshToken.trim()
        ? payload.refreshToken.trim() : refreshToken;
    // 关键变量：刷新站响应可能不包含有效期，避免将 NaN 写入加密连接。
    const rawExpiresIn = Number(payload.expires_in ?? payload.expiresIn ?? 0);
    const expiresIn = Number.isFinite(rawExpiresIn) ? Math.max(0, rawExpiresIn) : 0;
    return {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
      refreshUrl: configuredRefreshUrl,
    };
  }
}
