import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { CloudDriveProviderBase, type CloudDrivePage } from "./cloud-drive-base.js";
import { parseCloudApiObject, readCloudNumber, readCloudRecord, readCloudText, readCloudTextFile, requestCloudApiText } from "./cloud-api.js";
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  readProviderRateLimitDelayMs,
  registerProviderSharedRateLimit,
  waitForProviderSharedRateLimit,
  type ProviderNetworkOptions,
} from "./network.js";
import { type ProviderConnectionContext, type ProviderDescriptor, type ProviderEntry, type ProviderFileAccess, createProviderRecommendedScanSettings, requireConnectionString } from "./types.js";

const QUARK_API = "https://drive.quark.cn/1/clouddrive";
const QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4";

/** 夸克网盘 Cookie 只读 Provider。 */
export class QuarkProvider extends CloudDriveProviderBase {
  protected readonly rootResourceId = "0";
  /** 同一账号的 Cookie 更新按响应到达顺序执行，避免连接副本互相覆盖。 */
  private readonly cookieMergeQueues = new Map<string, Promise<void>>();
  /** 保存进程内最新 Cookie，后续从旧密文解出的连接会先追上该快照。 */
  private readonly latestCookies = new Map<string, string>();
  public readonly descriptor: ProviderDescriptor = {
    type: "quark", displayName: "夸克网盘", adapterVersion: "1.0.0", credentialSchemaVersion: 1,
    supportedDataTypes: ["video", "music"],
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({ scanDirectoryConcurrency: { default: 3 } }),
    authenticationMode: "authorization_session", authMethods: [{ type: "qr", displayName: "扫码登录", interaction: "qr", recommended: true }],
    connectionFields: [],
  };

  public constructor(private readonly networkOptions: ProviderNetworkOptions) { super(); }

  /** 验证夸克账号；UID 缺失时由根目录访问继续确认凭据。 */
  protected async loadAccountLabel(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<string | null> {
    const result = await this.request(connection, "https://pan.quark.cn/account/info?platform=pc&fr=pc", { method: "GET" }, signal, context, true);
    const data = readCloudRecord(result.data);
    const uid = readCloudText(data, ["uid"]);
    if (uid && connection.userId && connection.userId !== uid) throw new ApiError(409, "quark_account_mismatch", "扫码账号与原服务不一致，请添加为新服务");
    if (uid) connection.userId = uid;
    connection.accountSummary = readCloudText(data, ["nickname"]) || "夸克账号";
    await context?.persistConnection?.(connection);
    return String(connection.accountSummary);
  }

  /** 按页读取夸克目录。 */
  protected async listPage(connection: Record<string, unknown>, parentId: string, page: number, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<CloudDrivePage> {
    const size = 200;
    const query = new URLSearchParams({ pr: "ucpro", fr: "pc", pdir_fid: parentId, _page: String(page), _size: String(size), _fetch_total: "1", fetch_all_file: "1", fetch_risk_file_name: "1" });
    const payload = await this.request(connection, `${QUARK_API}/file/sort?${query}`, { method: "GET" }, signal, context);
    const data = readCloudRecord(payload.data);
    const rawItems = Array.isArray(data.list) ? data.list : [];
    const total = readCloudNumber(readCloudRecord(payload.metadata)._total);
    return {
      items: rawItems.map((value) => readCloudRecord(value)).map((item) => {
        const id = readCloudText(item, ["fid"]);
        const modified = readCloudNumber(item.updated_at);
        return {
          id, parentId: readCloudText(item, ["pdir_fid"]) || parentId,
          name: readCloudText(item, ["file_name"]) || id,
          isDirectory: item.dir === true || Number(item.file_type) === 0,
          size: readCloudNumber(item.size), modifiedAt: modified > 0 ? new Date(modified > 1_000_000_000_000 ? modified : modified * 1_000).toISOString() : null,
          etag: readCloudText(item, ["md5"]) || null,
          locator: { providerType: "quark", fileId: id, md5: readCloudText(item, ["md5"]) },
        };
      }).filter((item) => item.id),
      hasMore: total > 0 ? page * size < total : rawItems.length >= size,
    };
  }

  /** 获取夸克原文件签名地址。 */
  protected async loadFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileAccess> {
    const query = new URLSearchParams({ pr: "ucpro", fr: "pc" });
    const payload = await this.request(connection, `${QUARK_API}/file/download?${query}`, {
      method: "POST", body: JSON.stringify({ fids: [requireConnectionString(locator, "fileId", "夸克文件 ID")] }),
    }, signal, context);
    const data = Array.isArray(payload.data) ? readCloudRecord(payload.data[0]) : {};
    const url = readCloudText(data, ["download_url"]);
    if (!url) throw new ApiError(502, "quark_download_url_missing", "夸克未返回下载地址");
    return { url, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), headers: this.createHeaders(connection) };
  }

  /** 读取夸克小型文本文件。 */
  public async readText(connection: Record<string, unknown>, entry: ProviderEntry, signal?: AbortSignal): Promise<string> {
    return readCloudTextFile(await this.loadFileAccess(connection, entry.locator, signal), this.networkOptions, signal);
  }

  /** 请求夸克业务接口，只持久化允许轮换的两个主 Cookie，并处理响应体中的业务限流。 */
  private async request(connection: Record<string, unknown>, url: string, init: RequestInit, signal?: AbortSignal, context?: ProviderConnectionContext, account = false): Promise<Record<string, unknown>> {
    const cookieIdentityKey = this.createCookieIdentityKey(connection);
    for (let retryCount = 0; ; retryCount += 1) {
      this.applyLatestCookie(connection, cookieIdentityKey);
      const result = await requestCloudApiText(url, { ...init, headers: { ...this.createHeaders(connection), ...init.headers } }, this.networkOptions, signal);
      await this.mergeRotatingCookies(connection, result.response, context, cookieIdentityKey);
      const payload = parseCloudApiObject(result.text, ["uid"]);
      const status = Number(payload.status);
      const businessCode = Number(payload.code);
      if (status === 429 || businessCode === 429) {
        const delayMs = readProviderRateLimitDelayMs(result.response.headers.get("retry-after"), retryCount);
        registerProviderSharedRateLimit(QUARK_API, delayMs);
        if (retryCount < PROVIDER_RATE_LIMIT_MAX_RETRIES) {
          await waitForProviderSharedRateLimit(QUARK_API, signal);
          continue;
        }
        throw new ApiError(503, "provider_rate_limited", "夸克网盘请求频繁，等待重试后仍未恢复，请稍后再试");
      }
      if (account) {
        if (payload.success !== true) {
          if (status === 401 || businessCode === 401) {
            throw new ApiError(410, "quark_authentication_expired", "夸克登录已失效，请重新扫码");
          }
          throw new ApiError(502, "quark_business_failed",
            `夸克账号接口请求失败（业务码：${this.displayBusinessCode(status, businessCode)}）`);
        }
        return payload;
      }
      if (status === 401 || businessCode === 401) throw new ApiError(410, "quark_authentication_expired", "夸克登录已失效，请重新扫码");
      if (status === 403 || businessCode === 403) throw new ApiError(403, "quark_permission_denied", "夸克访问被拒绝，请检查账号权限");
      if (!Number.isFinite(status) || status >= 400 || businessCode !== 0) {
        throw new ApiError(502, "quark_business_failed",
          `夸克文件接口请求失败（业务码：${this.displayBusinessCode(status, businessCode)}）`);
      }
      return payload;
    }
  }

  /** 优先展示夸克业务码，缺失时退回业务状态。 */
  private displayBusinessCode(status: number, businessCode: number): string {
    if (Number.isFinite(businessCode)) return String(businessCode);
    return Number.isFinite(status) ? String(status) : "未知";
  }

  /** 返回夸克业务与下载所需的请求头。 */
  private createHeaders(connection: Record<string, unknown>): Record<string, string> {
    return { Cookie: requireConnectionString(connection, "cookie", "夸克 Cookie"), "User-Agent": QUARK_UA, Referer: "https://pan.quark.cn/", Accept: "application/json, text/plain, */*", "Content-Type": "application/json" };
  }

  /** 在共享最新快照上合并 __pus 和 __puus，避免旧连接副本覆盖新 Cookie。 */
  private async mergeRotatingCookies(
    connection: Record<string, unknown>,
    response: Response,
    context: ProviderConnectionContext | undefined,
    cookieIdentityKey: string,
  ): Promise<void> {
    const previousMerge = this.cookieMergeQueues.get(cookieIdentityKey) ?? Promise.resolve();
    const currentMerge = previousMerge.catch(() => undefined).then(async () => {
      await this.performCookieMerge(connection, response, context, cookieIdentityKey);
    });
    this.cookieMergeQueues.set(cookieIdentityKey, currentMerge);
    try {
      await currentMerge;
    } finally {
      if (this.cookieMergeQueues.get(cookieIdentityKey) === currentMerge) this.cookieMergeQueues.delete(cookieIdentityKey);
    }
  }

  /** 执行一次串行 Cookie 增量合并，并保存包含全部最新轮换字段的连接。 */
  private async performCookieMerge(
    connection: Record<string, unknown>,
    response: Response,
    context: ProviderConnectionContext | undefined,
    cookieIdentityKey: string,
  ): Promise<void> {
    const headers = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const latestCookie = this.latestCookies.get(cookieIdentityKey) || String(connection.cookie ?? "");
    const values = this.parseCookie(latestCookie);
    let changed = false;
    for (const raw of headers) {
      const pair = raw.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      if (separator <= 0 || !["__pus", "__puus"].includes(name)) continue;
      const value = pair.slice(separator + 1).trim();
      if (value && values.get(name) !== value) { values.set(name, value); changed = true; }
    }
    if (!changed) {
      connection.cookie = latestCookie;
      return;
    }
    connection.cookie = [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    await context?.persistConnection?.(connection);
    this.latestCookies.set(cookieIdentityKey, String(connection.cookie));
  }

  /** 让旧连接副本在发请求前使用本进程已经保存的最新 Cookie。 */
  private applyLatestCookie(connection: Record<string, unknown>, cookieIdentityKey: string): void {
    const latestCookie = this.latestCookies.get(cookieIdentityKey);
    if (!latestCookie || latestCookie === connection.cookie) return;
    connection.cookie = latestCookie;
  }

  /** 使用不会轮换的 Cookie 字段生成账号内存键，不保存也不输出原始 Cookie。 */
  private createCookieIdentityKey(connection: Record<string, unknown>): string {
    const values = this.parseCookie(String(connection.cookie ?? ""));
    values.delete("__pus");
    values.delete("__puus");
    const stableCookie = [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join(";");
    const identitySource = stableCookie || String(connection.userId ?? "") || String(connection.cookie ?? "");
    return createHash("sha256").update(identitySource).digest("hex");
  }

  /** 把 Cookie 文本解析成保留字段顺序的键值表。 */
  private parseCookie(cookie: string): Map<string, string> {
    return new Map(cookie.split(";")
      .map((part) => part.trim().split(/=(.*)/su, 2) as [string, string])
      .filter(([name, value]) => Boolean(name && value)));
  }
}
