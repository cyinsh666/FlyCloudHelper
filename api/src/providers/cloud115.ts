import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudNumber, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import { type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess, createProviderRecommendedScanSettings, requireConnectionString } from "./types.js";
import { CLOUD115_CLIENT_TYPES } from "./auth/cloud115-client-types.js";
import { waitForProviderRateLimit, type ProviderNetworkOptions } from "./network.js";

const CLOUD115_API = "https://proapi.115.com";
const CLOUD115_AUTH = "https://qrcodeapi.115.com";
const CLOUD115_UA = "Flymby/115Open";
/** 实例内115目录、播放地址等请求共用间隔，避免多个服务和任务叠加突发请求。 */
const CLOUD115_REQUEST_INTERVAL_MS = 1_000;
/** 115业务限流最多等待三轮，持续受限时交回任务队列处理。 */
const CLOUD115_RATE_LIMIT_DELAYS_MS = [10_000, 20_000, 30_000];

/** 115网盘 OpenAPI 只读 Provider。 */
export class Cloud115Provider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "0";
  /** 下一次允许发出115业务请求的时间；共享给本实例所有115服务。 */
  private nextRequestAtMs = 0;
  /** 业务码770004触发的共享冷却截止时间，已在排队的请求也必须遵守。 */
  private cooldownUntilMs = 0;
  public readonly descriptor: ProviderDescriptor = {
    type: "cloud115", displayName: "115网盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 4 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "qr", displayName: "扫码登录", interaction: "qr", recommended: true }],
    authSources: CLOUD115_CLIENT_TYPES.map((item) => ({ value: item.value, label: item.label, recommended: item.recommended })),
    connectionFields: [],
  };

  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 读取115稳定用户身份。 */
  protected async loadAccountLabel(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<string | null> {
    const payload = await this.request(connection, "/open/user/info", { method: "GET" }, signal, context);
    const data = readCloudRecord(payload.data);
    const userId = readCloudText(data, ["user_id"]);
    if (!userId) throw new ApiError(502, "cloud115_user_invalid", "115网盘未返回用户身份");
    connection.userId = userId;
    connection.userName = readCloudText(data, ["user_name"]);
    await context?.persistConnection?.(connection);
    return readCloudText(data, ["user_name"]) || `115账号 ${userId.slice(-4)}`;
  }

  /** 读取115目录分页。 */
  protected async listPage(connection: Record<string, unknown>, parentId: string, page: number, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<CloudDrivePage> {
    const limit = 200;
    const offset = (page - 1) * limit;
    const query = new URLSearchParams({ cid: parentId, limit: String(limit), offset: String(offset), asc: "1", o: "file_name", show_dir: "1" });
    const payload = await this.request(connection, `/open/ufile/files?${query}`, { method: "GET" }, signal, context);
    const container = readCloudRecord(payload.data);
    const rawItems = Array.isArray(container.data) ? container.data : Array.isArray(payload.data) ? payload.data : [];
    const total = readCloudNumber(container.count ?? payload.count);
    return {
      items: rawItems.map((value) => readCloudRecord(value)).map((item) => {
        const id = readCloudText(item, ["fid", "file_id", "cid"]);
        const isDirectory = readCloudText(item, ["fc"]) === "0" || item.is_dir === true || readCloudText(item, ["file_type"]) === "folder";
        return {
          id, parentId: readCloudText(item, ["pid", "parent_id"]) || parentId,
          name: readCloudText(item, ["fn", "file_name", "name"]) || id, isDirectory,
          size: readCloudNumber(item.fs ?? item.file_size ?? item.size),
          modifiedAt: readCloudText(item, ["upt", "update_time", "modified_at"]) || null,
          etag: readCloudText(item, ["sha1"]) || null,
          locator: { providerType: "cloud115", fileId: id, pickCode: readCloudText(item, ["pc", "pick_code"]), fileName: readCloudText(item, ["fn", "file_name", "name"]) },
        };
      }).filter((item) => item.id),
      hasMore: total > 0 ? offset + rawItems.length < total : rawItems.length >= limit,
    };
  }

  /** 使用 pick_code 换取115原画地址。 */
  protected async loadFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileAccess> {
    const pickCode = requireConnectionString(locator, "pickCode", "115 Pick Code");
    // 关键变量：取址和下载使用同一个 UA；只对本次请求生效，不能改 Provider 全局 UA 影响并发中转。
    const downloadUserAgent = context?.playbackUserAgent || CLOUD115_UA;
    const payload = await this.request(connection, "/open/ufile/downurl", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": downloadUserAgent }, body: new URLSearchParams({ pick_code: pickCode }),
    }, signal, context);
    const data = readCloudRecord(payload.data);
    const first = readCloudRecord(data[Object.keys(data)[0] ?? ""]);
    const url = readCloudText(readCloudRecord(first.url), ["url"]);
    if (!url) throw new ApiError(502, "cloud115_download_url_missing", "115网盘未返回原画地址");
    return { url, expiresAt: null, headers: { "User-Agent": downloadUserAgent } };
  }

  /** 读取115小型文本文件。 */
  public async readText(connection: Record<string, unknown>, entry: ProviderEntry, signal?: AbortSignal): Promise<string> {
    return readCloudTextFile(await this.loadFileAccess(connection, entry.locator, signal), this.networkOptions, signal);
  }

  /** 等待115请求时间窗口；每次唤醒重新检查冷却，暂停或取消时立即退出。 */
  private async waitForRequestSlot(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new ApiError(499, "provider_request_aborted", "115网盘请求已取消");
      const now = Date.now();
      const allowedAt = Math.max(this.nextRequestAtMs, this.cooldownUntilMs);
      if (now >= allowedAt) {
        // 检查与占用窗口之间没有异步操作，其他任务不能在同一窗口同时发出请求。
        this.nextRequestAtMs = now + CLOUD115_REQUEST_INTERVAL_MS;
        return;
      }
      await waitForProviderRateLimit(allowedAt - now, signal);
    }
  }

  /** 令牌到期前刷新；401/99只刷新一次，770004按共享冷却有限重试。 */
  private async request(connection: Record<string, unknown>, path: string, init: RequestInit, signal?: AbortSignal, context?: ProviderConnectionContext, retried = false): Promise<Record<string, unknown>> {
    await this.refreshIfNeeded(connection, signal, context);
    for (let retryCount = 0; ; retryCount += 1) {
      await this.waitForRequestSlot(signal);
      // 等待期间其他请求可能刷新同一连接，发出请求前读取当前Token。
      const accessToken = requireConnectionString(connection, "accessToken", "115 Access Token");
      try {
        const result = await requestCloudApiText(`${CLOUD115_API}${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": CLOUD115_UA, ...init.headers } }, this.networkOptions, signal);
        const payload = parseCloudApiObject(result.text, ["fid", "pid", "file_id", "parent_id", "user_id"]);
        if (payload.state !== false) {
          if (retryCount > 0) {
            this.networkOptions.logConnectionFailure?.({
              日志关键字: "codex-cloud115-rate-limit",
              事件: "115限流等待后请求恢复",
              网盘类型: "cloud115",
              请求路径: path.split("?", 1)[0] ?? "",
              已重试次数: retryCount,
            });
          }
          return payload;
        }
        const businessCode = Number(payload.code ?? payload.errno);
        if (!retried && businessCode === 99) return this.refreshAndRetry(connection, path, init, signal, context);
        if (businessCode === 770004) {
          const delayMs = CLOUD115_RATE_LIMIT_DELAYS_MS[retryCount];
          this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + (delayMs ?? 30_000));
          this.networkOptions.logConnectionFailure?.({
            日志关键字: "codex-cloud115-rate-limit",
            事件: delayMs === undefined ? "115限流重试后仍未恢复" : "115访问上限触发共享冷却",
            网盘类型: "cloud115",
            请求路径: path.split("?", 1)[0] ?? "",
            上游业务码: businessCode,
            已重试次数: retryCount,
            等待毫秒: delayMs ?? 30_000,
          });
          if (delayMs === undefined) {
            throw new ApiError(503, "provider_rate_limited", "115网盘已达到当前访问上限，等待重试后仍未恢复，请稍后重试");
          }
          continue;
        }
        this.networkOptions.logConnectionFailure?.({
          日志关键字: "codex-cloud115-business",
          事件: "115接口返回业务错误",
          请求路径: path.split("?", 1)[0] ?? "",
          上游业务码: Number.isFinite(businessCode) ? businessCode : null,
        });
        throw new ApiError(502, "cloud115_business_failed", `115网盘接口返回业务错误（业务码：${Number.isFinite(businessCode) ? businessCode : "未知"}）`);
      } catch (error) {
        if (!retried && error instanceof ApiError && error.code === "provider_authentication_failed") return this.refreshAndRetry(connection, path, init, signal, context);
        throw error;
      }
    }
  }

  /** 立即刷新并重试原请求。 */
  private async refreshAndRetry(connection: Record<string, unknown>, path: string, init: RequestInit, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<Record<string, unknown>> {
    await this.refreshToken(connection, signal, context);
    return this.request(connection, path, init, signal, context, true);
  }

  /** 在令牌临近过期时主动轮换。 */
  private async refreshIfNeeded(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<void> {
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (expiresAt > 0 && expiresAt <= Date.now() + 5 * 60_000) await this.refreshToken(connection, signal, context);
  }

  /** 直接调用115官方刷新端点并保存轮换后的两个 Token。 */
  private async refreshToken(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<void> {
    const refreshToken = requireConnectionString(connection, "refreshToken", "115 Refresh Token");
    const result = await requestCloudApiText(`${CLOUD115_AUTH}/open/refreshToken`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "FlyCloudHelper/115Open" }, body: new URLSearchParams({ refresh_token: refreshToken }),
    }, this.networkOptions, signal);
    const data = readCloudRecord(parseCloudApiObject(result.text).data);
    const nextAccessToken = readCloudText(data, ["access_token", "accessToken"]);
    const nextRefreshToken = readCloudText(data, ["refresh_token", "refreshToken"]);
    if (!nextAccessToken || !nextRefreshToken) throw new ApiError(410, "cloud115_refresh_expired", "115登录已失效，请重新扫码");
    connection.accessToken = nextAccessToken;
    connection.refreshToken = nextRefreshToken;
    const expiresIn = readCloudNumber(data.expires_in);
    connection.expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1_000 : 0;
    await context?.persistConnection?.(connection);
  }
}
