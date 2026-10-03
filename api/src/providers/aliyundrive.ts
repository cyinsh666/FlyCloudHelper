import { loadEnumerationPage } from "./types.js";
import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import { CredentialRefreshCoordinator } from "./credential-refresh-coordinator.js";
import { ApiError, validationError } from "../errors.js";
import {
  type ProviderAdapter,
  type ProviderConnectionContext,
  type ProviderDescriptor,
  type ProviderBrowseListing,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderValidationResult,
  type ProviderFileAccess,
  type ScanRoot,
  createProviderRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

interface AliyunFileItem {
  file_id?: string;
  parent_file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  updated_at?: string;
  content_hash?: string;
}

interface AliyunDriveInfo {
  defaultDriveId: string;
  resourceDriveId: string;
  backupDriveId: string;
}

/** 阿里云盘一次完整的令牌轮换结果。 */
interface AliyunTokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshUrl: string;
}

const DEFAULT_ALIYUN_REFRESH_URL = "https://api.oplist.org/alicloud/renewapi";
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const ALIYUN_RESOURCE_DRIVE_NAME = "资源库";
const ALIYUN_BACKUP_DRIVE_NAME = "备份盘";
const ALIYUN_DIRECTORY_SCOPE_LOG_KEY = "codex-aliyundrive-directory-scope";

/** 阿里云盘开放接口 Provider，使用 APP 上送的开放平台访问令牌。 */
export class AliyunDriveProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "aliyundrive",
    displayName: "阿里云盘",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 2,
    supportedDataTypes: ["video", "music"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({
      // 阿里开放接口单页最多读取 200 项，允许多个目录并行但限制峰值请求数。
      scanDirectoryConcurrency: { default: 8 },
    }),
    connectionFields: [
      { name: "accessToken", label: "Access Token", type: "password", required: true, secret: true },
      { name: "refreshToken", label: "Refresh Token", type: "password", required: true, secret: true },
      { name: "refreshUrl", label: "Token 刷新地址", type: "url", required: false, secret: false },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;
  private cachedDriveInfo: { accessToken: string; info: AliyunDriveInfo } | null = null;
  /** 按旧 Refresh Token 合并跨请求刷新，并接住稍晚到达的旧连接副本。 */
  private readonly tokenRefreshCoordinator = new CredentialRefreshCoordinator<AliyunTokenRefreshResult>();

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 通过自动读取 Drive 信息和根目录首个分页验证 Token。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderValidationResult> {
    const driveId = await this.resolveDefaultDriveId(connection, signal, context?.persistConnection);
    await this.listDirectory(connection, driveId, "root", null, 1, signal, context?.persistConnection);
    return { valid: true, accountLabel: "阿里云盘", rootAccessible: true };
  }

  /** 验证每个阿里云盘扫描根的 Drive ID 和目录资源 ID。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<void> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal, context?.persistConnection);
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", driveId: defaultDriveId }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.driveId || defaultDriveId, root.resourceId || "root", null, 1,
        signal, context?.persistConnection);
    }
  }

  /** 返回阿里云盘当前目录的直接子目录，保留稳定的 Drive ID 与 file_id。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderDirectoryListing> {
    const driveInfo = await this.resolveDriveInfo(connection, signal, context?.persistConnection);
    // 关键变量：未携带资源 ID 和盘 ID 时表示 APP 正在浏览阿里云盘的虚拟总根目录。
    const isVirtualRoot = !parent?.resourceId && !parent?.driveId;
    if (isVirtualRoot) {
      return this.createVirtualDriveListing(driveInfo);
    }
    const driveId = parent?.driveId || driveInfo.defaultDriveId;
    const parentFileId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    let marker: string | null = null;
    const items: ProviderDirectoryListing["items"] = [];
    do {
      const page = await this.listDirectory(connection, driveId, parentFileId, marker, 200, signal,
        context?.persistConnection);
      for (const item of page.items) {
        const resourceId = String(item.file_id ?? "");
        const name = String(item.name ?? resourceId);
        if (!resourceId || item.type !== "folder") continue;
        items.push({
          name,
          resourceId,
          displayPath: `${parentPath.replace(/\/$/u, "")}/${name}`,
          driveId,
        });
      }
      marker = page.nextMarker;
    } while (marker);
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: parentFileId === "root" ? "/" : parentPath.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parentFileId,
        displayPath: parentPath,
        driveId,
      },
      items,
    };
  }

  /** 列出虚拟盘根或真实目录的全部直接子项，保留盘 ID 和文件 ID。 */
  public async browseEntries(connection: Record<string, unknown>, parent?: ScanRoot, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderBrowseListing> {
    const driveInfo = await this.resolveDriveInfo(connection, signal, context?.persistConnection);
    if (!parent?.resourceId && !parent?.driveId) {
      const virtual = this.createVirtualDriveListing(driveInfo);
      return { current: virtual.current, items: virtual.items.map((item) => ({
        ...item, parentResourceId: "", isDirectory: true, size: 0, modifiedAt: null, etag: null, locator: {},
      })) };
    }
    const driveId = parent?.driveId || driveInfo.defaultDriveId;
    const parentId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    const items: ProviderBrowseListing["items"] = [];
    let marker: string | null = null;
    do {
      const page = await this.listDirectory(connection, driveId, parentId, marker, 200, signal, context?.persistConnection);
      for (const item of page.items) {
        const resourceId = String(item.file_id ?? "");
        if (!resourceId) continue;
        const name = String(item.name ?? resourceId);
        items.push({ name, resourceId, parentResourceId: item.parent_file_id || parentId,
          displayPath: `${parentPath.replace(/\/$/u, "")}/${name}`, driveId,
          isDirectory: item.type === "folder", size: toFileSize(item.size), modifiedAt: item.updated_at ?? null,
          etag: item.content_hash ?? null, locator: { providerType: "aliyundrive", driveId, fileId: resourceId } });
      }
      marker = page.nextMarker;
    } while (marker);
    return { current: { name: parentPath === "/" ? "/" : parentPath.split("/").filter(Boolean).pop() || "/",
      resourceId: parentId, displayPath: parentPath, driveId }, items };
  }

  /** 构造与 APP 本地阿里云盘一致的资源库、备份盘虚拟根目录。 */
  private createVirtualDriveListing(driveInfo: AliyunDriveInfo): ProviderDirectoryListing {
    const items: ProviderDirectoryListing["items"] = [];
    if (driveInfo.resourceDriveId.length > 0) {
      items.push(this.createVirtualDriveDirectory(ALIYUN_RESOURCE_DRIVE_NAME, driveInfo.resourceDriveId));
    }
    if (driveInfo.backupDriveId.length > 0 && driveInfo.backupDriveId !== driveInfo.resourceDriveId) {
      items.push(this.createVirtualDriveDirectory(ALIYUN_BACKUP_DRIVE_NAME, driveInfo.backupDriveId));
    }
    console.info(`${ALIYUN_DIRECTORY_SCOPE_LOG_KEY} [阶段=浏览根目录] [结果=返回多盘入口] `
      + `[资源库=${driveInfo.resourceDriveId.length > 0 ? "可用" : "不可用"}] `
      + `[备份盘=${driveInfo.backupDriveId.length > 0 ? "可用" : "不可用"}] [入口数量=${items.length}]`);
    return {
      current: { name: "/", resourceId: "", displayPath: "/", driveId: "" },
      items,
    };
  }

  /** 构造单个阿里云盘虚拟盘入口，真实目录从该盘的 root 开始浏览。 */
  private createVirtualDriveDirectory(name: string, driveId: string): ProviderDirectoryListing["items"][number] {
    return {
      name,
      resourceId: "root",
      displayPath: `/${name}`,
      driveId,
    };
  }

  /** 按稳定 file_id 广度优先递归枚举文件。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    _onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal, options?.persistConnection);
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", driveId: defaultDriveId }];
    for (let rootIndex = 0; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      // 根目录只有完整枚举后才允许扫描收尾清理旧文件；中止或异常不会提交完成状态。
      await options?.onRootStart?.({ rootIndex, root, warningCount: 0 });
      const driveId = root.driveId || defaultDriveId;
      const queue: Array<{ id: string; path: string }> = [{
        id: root.resourceId || "root",
        path: root.displayPath || "/",
      }];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(`${driveId}:${directory.id}`));
        directoryBatch.forEach((directory) => visited.add(`${driveId}:${directory.id}`));
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          let marker: string | null = null;
          const entries: AliyunFileItem[] = [];
          do {
            const page: { items: AliyunFileItem[]; nextMarker: string | null } = await loadEnumerationPage(options, directory.path, `${driveId}:${directory.id}:${marker ?? ""}`, () => this.listDirectory(connection, driveId, directory.id, marker, 200, signal,
              options?.persistConnection));
            entries.push(...page.items);
            marker = page.nextMarker;
          } while (marker);
          return { directory, entries };
        }));
        for (const { directory, entries } of batchResults) {
          const siblingDirectoryNames = entries.filter((item) => item.type === "folder").map((item) => String(item.name ?? ""));
          for (const item of entries) {
            const id = String(item.file_id ?? "");
            const name = String(item.name ?? id);
            if (!id) continue;
            const itemPath = `${directory.path.replace(/\/$/u, "")}/${name}`;
            const isDirectory = item.type === "folder";
            if (isDirectory) {
              queue.push({ id, path: itemPath });
            } else {
              yield {
                siblingDirectoryNames,
                resourceId: id,
                parentResourceId: item.parent_file_id ?? directory.id,
                path: itemPath,
                name,
                isDirectory: false,
                size: toFileSize(item.size),
                modifiedAt: item.updated_at ?? null,
                etag: item.content_hash ?? null,
                locator: { providerType: "aliyundrive", driveId, fileId: id },
              };
            }
          }
          await options?.onDirectoryComplete?.(directory.path);
        }
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: 0 });
    }
  }

  /** 使用开放平台 file_id 换取短期下载地址，可直接下发或作为中转上游。 */
  public async resolveFileAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    const driveId = requireConnectionString(locator, "driveId", "Drive ID");
    const fileId = requireConnectionString(locator, "fileId", "File ID");
    const payload = await this.requestAliyunJson<{ url?: string; expiration?: string }>(
      connection,
      "/adrive/v1.0/openFile/getDownloadUrl",
      { drive_id: driveId, file_id: fileId },
      context?.persistConnection,
      signal,
    );
    if (!payload.url) throw new Error("阿里云盘开放接口未返回下载地址");
    return { url: payload.url, expiresAt: payload.expiration ?? null, headers: {} };
  }

  /** 阿里云盘短期地址不含额外请求凭据，可直接复用为中转上游。 */
  public async resolveFileStreamAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    return this.resolveFileAccess(connection, locator, signal, context);
  }

  /** 请求阿里云盘开放接口文件分页。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    driveId: string,
    parentFileId: string,
    marker: string | null,
    limit: number,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<{ items: AliyunFileItem[]; nextMarker: string | null }> {
    const payload = await this.requestAliyunJson<{ items?: AliyunFileItem[]; next_marker?: string }>(
      connection,
      "/adrive/v1.0/openFile/list",
      { drive_id: driveId, parent_file_id: parentFileId, limit, marker: marker ?? "" },
      persistConnection,
      signal,
    );
    return { items: Array.isArray(payload.items) ? payload.items : [], nextMarker: payload.next_marker || null };
  }

  /** 返回默认盘 ID，具体盘信息读取和缓存统一交给 resolveDriveInfo。 */
  private async resolveDefaultDriveId(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<string> {
    const info = await this.resolveDriveInfo(connection, signal, persistConnection);
    return info.defaultDriveId;
  }

  /** 自动读取账号下的默认、资源库和备份盘 Drive ID，旧字段仅作为响应缺失时的兼容兜底。 */
  private async resolveDriveInfo(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<AliyunDriveInfo> {
    const legacyDriveId = typeof connection.driveId === "string" ? connection.driveId.trim() : "";
    await this.ensureValidToken(connection, persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const cached = this.cachedDriveInfo;
    if (cached !== null && cached.accessToken === accessToken && cached.info.defaultDriveId.length > 0) {
      return cached.info;
    }
    const payload = await this.requestAliyunJson<{
      default_drive_id?: string;
      resource_drive_id?: string;
      backup_drive_id?: string;
    }>(connection, "/adrive/v1.0/user/getDriveInfo", {}, persistConnection, signal);
    const info: AliyunDriveInfo = {
      defaultDriveId: `${payload.default_drive_id ?? payload.resource_drive_id ?? payload.backup_drive_id ?? ""}`.trim(),
      resourceDriveId: `${payload.resource_drive_id ?? ""}`.trim(),
      backupDriveId: `${payload.backup_drive_id ?? ""}`.trim(),
    };
    if (info.defaultDriveId.length === 0 && legacyDriveId.length === 0) {
      throw validationError("accessToken", "阿里云盘授权未返回 Drive ID");
    }
    if (info.defaultDriveId.length === 0) {
      info.defaultDriveId = legacyDriveId;
    }
    if (info.resourceDriveId.length === 0) {
      info.resourceDriveId = info.defaultDriveId;
    }
    const responseAccessToken = requireConnectionString(connection, "accessToken", "Access Token");
    this.cachedDriveInfo = { accessToken: responseAccessToken, info };
    return info;
  }

  /** 统一解析阿里云盘开放接口地址，未配置时使用官方固定地址。 */
  private resolveApiBaseUrl(connection: Record<string, unknown>): string {
    const configured = typeof connection.apiBaseUrl === "string" ? connection.apiBaseUrl.trim() : "";
    return configured || "https://openapi.alipan.com";
  }

  /** 统一请求阿里开放接口；Access Token 被明确拒绝时强制刷新一次后重试原请求。 */
  private async requestAliyunJson<T>(
    connection: Record<string, unknown>,
    path: string,
    body: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
    retriedAuthentication = false,
  ): Promise<T> {
    await this.ensureValidToken(connection, persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const baseUrl = await validateProviderUrl(this.resolveApiBaseUrl(connection), this.networkOptions);
    try {
      const response = await providerFetch(new URL(path, baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, this.networkOptions, signal);
      return await response.json() as T;
    } catch (error) {
      if (!retriedAuthentication && error instanceof ApiError && error.code === "provider_authentication_failed") {
        // 同一连接已经由并发请求刷新时直接复用，避免重复提交 Refresh Token。
        if (String(connection.accessToken ?? "").trim() === accessToken) {
          await this.ensureValidToken(connection, persistConnection, signal, true);
        }
        return this.requestAliyunJson<T>(connection, path, body, persistConnection, signal, true);
      }
      throw error;
    }
  }

  /** 临近过期或上游明确拒绝时刷新令牌，并原位保存同一凭据修订。 */
  private async ensureValidToken(
    connection: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<void> {
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (!forceRefresh && accessToken && (expiresAt <= 0 || Date.now() + TOKEN_REFRESH_AHEAD_MS < expiresAt)) return;
    const refreshToken = requireConnectionString(connection, "refreshToken", "Refresh Token");
    const configuredRefreshUrl = typeof connection.refreshUrl === "string" && connection.refreshUrl.trim()
      ? connection.refreshUrl.trim()
      : DEFAULT_ALIYUN_REFRESH_URL;
    // 强制刷新把被拒绝的 Access Token 纳入键，避免复用刚刚被上游判定失效的近期结果。
    const refreshCoordinationKey = forceRefresh
      ? `${configuredRefreshUrl}\n${refreshToken}\n${accessToken}`
      : `${configuredRefreshUrl}\n${refreshToken}`;
    const sharedRefresh = await this.tokenRefreshCoordinator.execute(
      refreshCoordinationKey,
      // 轮换独立使用 Provider 的30秒超时，避免首个等待任务取消后丢失已经轮换的令牌。
      () => this.performTokenRefresh(refreshToken, configuredRefreshUrl),
    );
    connection.accessToken = sharedRefresh.result.accessToken;
    connection.refreshToken = sharedRefresh.result.refreshToken;
    connection.expiresAt = sharedRefresh.result.expiresAt;
    connection.refreshUrl = sharedRefresh.result.refreshUrl;
    this.cachedDriveInfo = null;
    await persistConnection?.(connection);
  }

  /** 向阿里刷新端点提交一次旧 Refresh Token，只返回结果，不修改调用方连接。 */
  private async performTokenRefresh(
    refreshToken: string,
    configuredRefreshUrl: string,
    signal?: AbortSignal,
  ): Promise<AliyunTokenRefreshResult> {
    const refreshUrl = new URL(configuredRefreshUrl);
    if (refreshUrl.protocol !== "https:") throw validationError("refreshUrl", "阿里云盘 Token 刷新地址必须使用 HTTPS");
    refreshUrl.searchParams.set("refresh_ui", refreshToken);
    refreshUrl.searchParams.set("server_use", "true");
    refreshUrl.searchParams.set("driver_txt", "alicloud_qr");
    const safeRefreshUrl = await validateProviderUrl(refreshUrl.href, this.networkOptions);
    const response = await providerFetch(safeRefreshUrl, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as Record<string, unknown>;
    const nextAccessToken = typeof payload.access_token === "string" ? payload.access_token.trim()
      : typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    if (!nextAccessToken) {
      throw new ApiError(410, "aliyundrive_refresh_expired", "阿里云盘登录已失效，请重新登录");
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
