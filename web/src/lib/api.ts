export type AuthRole = "user" | "super_admin";

export interface AuthUser {
  userId: string;
  username: string;
  role: AuthRole;
  status: "active" | "disabled" | "pending_delete";
  createdAt: string;
}

/** 公共健康接口返回的服务版本与运行状态。 */
export interface ServiceHealth {
  status: "ok";
  version: string;
}

export type ConsoleNotificationTone = "info" | "success" | "warning" | "danger";

/** 控制台右上角展示的账号通知。 */
export interface ConsoleNotification {
  id: string;
  userId: string;
  category: "task" | "security" | "system";
  tone: ConsoleNotificationTone;
  title: string;
  message: string;
  actionPath: string | null;
  createdAt: string;
}

export type TelegramNotificationDestinationType = "chat" | "user";

/** 管理端可读取的 Telegram 脱敏配置，永远不包含 Bot Token 原文。 */
export interface TelegramNotificationSettings {
  enabled: boolean;
  botTokenConfigured: boolean;
  destinationType: TelegramNotificationDestinationType;
  destinationId: string;
  chatId: string;
  telegramUserId: string;
  configurationRevision: number;
}

/** 系统通知设置中的四类业务事件开关。 */
export interface NotificationEventSettings {
  credentialAbnormal: boolean;
  organizeCompleted: boolean;
  scanCompleted: boolean;
  mediaProbeCompleted: boolean;
  configurationRevision: number;
}

export interface AdminNotificationSettings {
  telegram: TelegramNotificationSettings;
  events: NotificationEventSettings;
}

/** 全局出站代理的脱敏配置，密码只返回是否已配置。 */
export interface AdminNetworkProxySettings {
  enabled: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  passwordConfigured: boolean;
  configurationRevision: number;
}

/** 读取全局出站代理设置。 */
export async function getAdminNetworkProxy(): Promise<AdminNetworkProxySettings> {
  const result = await requestJson<{ proxy: AdminNetworkProxySettings }>("/api/v1/admin/config/network-proxy");
  return result.proxy;
}

/** 保存出站代理；不传 password 时保留同一用户名已有的密码。 */
export async function updateAdminNetworkProxy(input: {
  enabled: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  password?: string;
}): Promise<AdminNetworkProxySettings> {
  const result = await requestJson<{ proxy: AdminNetworkProxySettings }>("/api/v1/admin/config/network-proxy", {
    method: "PUT", body: JSON.stringify(input),
  });
  return result.proxy;
}

/** 通过当前代理检查公开站点的连通性。 */
export async function testAdminNetworkProxy(): Promise<{ reachable: boolean; statusCode: number }> {
  const result = await requestJson<{ result: { reachable: boolean; statusCode: number } }>("/api/v1/admin/config/network-proxy/test", {
    method: "POST", body: "{}",
  });
  return result.result;
}

export interface CredentialKeyBackup {
  masterKey: string;
  fileName: string;
}

export interface InitializeSuperAdminResult {
  user: AuthUser;
  credentialKeyBackup: CredentialKeyBackup | null;
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

/** 表示 API 返回的可识别业务错误。 */
export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 生成扫描请求的幂等标识。
 * 普通 HTTP 页面不一定开放 crypto.randomUUID，因此回退到 Web Crypto 随机字节生成标准 UUID v4。
 */
function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    // UUID 使用的 16 字节随机数据。
    const randomBytes = new Uint8Array(16);
    cryptoApi.getRandomValues(randomBytes);
    randomBytes[6] = (randomBytes[6]! & 0x0f) | 0x40;
    randomBytes[8] = (randomBytes[8]! & 0x3f) | 0x80;

    // 每个字节固定输出两个十六进制字符。
    const hexadecimalBytes = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0"));
    console.info("codex-flycloudhelper-request-id 生成方式=WebCrypto随机字节 原因=randomUUID不可用");
    return `${hexadecimalBytes.slice(0, 4).join("")}-${hexadecimalBytes.slice(4, 6).join("")}`
      + `-${hexadecimalBytes.slice(6, 8).join("")}-${hexadecimalBytes.slice(8, 10).join("")}`
      + `-${hexadecimalBytes.slice(10, 16).join("")}`;
  }

  // 请求 ID 仅用于避免任务重复创建，不作为认证或加密凭据。
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2);
  console.warn("codex-flycloudhelper-request-id 生成方式=兼容随机值 原因=WebCrypto不可用");
  return `flycloud-helper-web-${timePart}-${randomPart}`;
}

/** 发起同源 API 请求并统一处理错误响应。 */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // 关键变量：没有请求体时不能声明 JSON，否则 Fastify 会把空请求体判定为 JSON 解析失败。
    const requestHeaders = new Headers(init?.headers);
    if (init?.body !== undefined && !requestHeaders.has("Content-Type")) {
      requestHeaders.set("Content-Type", "application/json");
    }
    response = await fetch(path, {
      ...init,
      // 鉴权失败可能返回可缓存的410；API请求必须绕过浏览器和反向代理缓存，重新授权后立即读取最新状态。
      cache: init?.cache ?? "no-store",
      credentials: "include",
      headers: requestHeaders,
    });
  } catch {
    throw new ApiClientError(0, "network_error", "无法连接 FlyCloudHelper API");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? "request_failed",
      payload.error?.message ?? "请求失败",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export type MediaType = "video" | "music" | "audiobook";
export type MediaLibraryKind = "legacy_single_source" | "cloud_aggregate_video" | "content_source_video" | "content_source_music" | "content_source_audiobook" | "content_source_live";
export type CatalogSort = "created_desc" | "year_desc" | "premiere_date_desc" | "title_asc";
export type MatchState = "matched" | "needs_review" | "unmatched" | "processing";
export type ServiceStatus = "active" | "scanning" | "disabled" | "reauthorization_required";
export type JobStatus = "queued" | "running" | "retry_waiting" | "paused" | "completed" | "failed" | "cancelled";

/** 云助手本地缓存的影视推荐榜单入口。 */
export interface RecommendationBlock {
  id: string; title: string; description: string | null; group: string; category: string | null;
  mediaType: string | null; itemCount: number; posterUrl: string | null; lastUpdated: string | null;
}

/** 榜单内的竖版海报条目。 */
export interface RecommendationItem {
  rank: number; title: string; overview: string | null; posterUrl: string | null;
  tmdbId: number | null; mediaType: string | null; rating: number | null; releaseDate: string | null;
}

export interface RecommendationDetail extends RecommendationBlock {
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  items: RecommendationItem[];
}

/** 榜单条目读取到的 TMDB 作品详情；缺失时页面仍展示榜单原始资料。 */
export interface RecommendationItemDetail {
  block: RecommendationBlock;
  item: RecommendationItem;
  tmdb: {
    id: number; mediaType: "movie" | "tv"; title: string; originalTitle: string; overview: string;
    year: number | null; releaseDate: string; rating: number; genres: string[]; originCountries: string[];
    posterUrl: string | null; backdropUrl: string | null; episodeCount: number;
    people: Array<{ name: string; role: string; type: "cast" | "crew"; profileUrl: string | null }>;
  } | null;
  tmdbError: string | null;
}

/** 当前作品的 TMDB 关联推荐摘要。 */
export interface RecommendationRelatedItem {
  id: number; mediaType: "movie" | "tv"; title: string; posterUrl: string | null;
  releaseDate: string; rating: number;
}

/** TMDB 标题搜索返回的电影或剧集候选。 */
export interface RecommendationTmdbCandidate {
  id: number; mediaType: "movie" | "tv"; title: string; originalTitle: string; overview: string;
  year: number | null; releaseDate: string; posterUrl: string | null; backdropUrl: string | null;
  rating: number; popularity: number;
}

/** 按当前控制台身份选用影视推荐接口。 */
function recommendationPath(admin: boolean): string {
  return admin ? "/api/v1/admin/recommendations" : "/api/v1/recommendations";
}

/** 读取云助手已同步的全部榜单入口。 */
export function listRecommendations(admin = false): Promise<{ total: number; updatedAt: string; items: RecommendationBlock[] }> {
  return requestJson(recommendationPath(admin));
}

/** 立即从榜单上游同步完整快照，失败时服务端保留旧缓存。 */
export function syncRecommendations(admin = false): Promise<{ total: number; updatedAt: string; items: RecommendationBlock[] }> {
  return requestJson(`${recommendationPath(admin)}/sync`, { method: "POST" });
}

/** 从本地快照分页读取一个榜单，不请求 FlymbyServer。 */
export function getRecommendationDetail(blockId: string, page = 1, admin = false): Promise<RecommendationDetail> {
  return requestJson(`${recommendationPath(admin)}/${encodeURIComponent(blockId)}?page=${page}&pageSize=24`);
}

/** 按榜单内的原始名次读取条目及其 TMDB 详情。 */
export function getRecommendationItemDetail(blockId: string, rank: number, admin = false): Promise<RecommendationItemDetail> {
  return requestJson(`${recommendationPath(admin)}/${encodeURIComponent(blockId)}/items/${rank}`);
}

/** 单独读取关联推荐，避免 TMDB 推荐请求阻塞作品详情。 */
export async function getRecommendationRelatedItems(blockId: string, rank: number, admin = false): Promise<RecommendationRelatedItem[]> {
  const result = await requestJson<{ items: RecommendationRelatedItem[] }>(
    `${recommendationPath(admin)}/${encodeURIComponent(blockId)}/items/${rank}/related`,
  );
  return result.items;
}

/** 使用已配置的 TMDB Key 同时搜索电影和剧集。 */
export function searchRecommendationTmdb(query: string, admin = false): Promise<{ items: RecommendationTmdbCandidate[]; errors: string[] }> {
  return requestJson(`${recommendationPath(admin)}/tmdb/search?query=${encodeURIComponent(query)}`);
}

/** 按 TMDB 类型和 ID 读取与榜单条目相同的详情字段。 */
export function getRecommendationTmdbDetail(mediaType: "movie" | "tv", tmdbId: number, admin = false):
  Promise<Pick<RecommendationItemDetail, "tmdb" | "tmdbError">> {
  return requestJson(`${recommendationPath(admin)}/tmdb/${mediaType}/${tmdbId}`);
}

/** 单独读取 TMDB 搜索结果的关联推荐。 */
export async function getRecommendationTmdbRelatedItems(mediaType: "movie" | "tv", tmdbId: number, admin = false):
  Promise<RecommendationRelatedItem[]> {
  const result = await requestJson<{ items: RecommendationRelatedItem[] }>(
    `${recommendationPath(admin)}/tmdb/${mediaType}/${tmdbId}/related`,
  );
  return result.items;
}

/** 搜索引擎的公开 Telegram 频道配置。 */
export interface ResourceSearchSource { kind: string; key: string; enabled: boolean }
/** 个人订阅设置中的网盘服务与已关注频道。 */
export interface ServiceSubscriptionChannels {
  serviceId: string; serviceName: string; providerType: string; channelKeys: string[];
}
/** 频道最近三页的分享类型样本，以及历次扫描累计发现的类型。 */
export interface ChannelCloudTypes {
  channel: string; recentCounts: Record<string, number>; observedTypes: string[]; sampledMessages: number;
  oldestMessageId: number | null; newestMessageId: number | null;
  checkedAt: string | null; lastAttemptAt: string; error: string | null;
}
/** 系统设置中手动分析 Telegram 频道资源类型的进度。 */
export interface ChannelTypeAnalysisStatus {
  running: boolean; startedAt: string | null; finishedAt: string | null;
  total: number; completed: number; succeeded: number; failed: number; error: string | null;
}
/** 已启用频道的类型缓存及本次分析进度。 */
export interface AdminChannelTypeAnalysis {
  totalChannels: number; automaticEnabled: boolean;
  cache: { pageLimit: number; updatedAt: string | null; items: ChannelCloudTypes[] };
  status: ChannelTypeAnalysisStatus;
}
/** 一个 TMDB 作品与用户网盘服务之间的订阅记录。 */
export interface MovieSubscription {
  serviceId: string; mediaType: "movie" | "tv"; tmdbId: number; title: string;
  originalTitle: string; year: number | null; posterUrl: string | null; createdAt: string;
}
/** 一个 TG 消息中单条分享的自动转存处理状态。 */
export interface MovieSubscriptionActivity {
  id: string; channel: string; channelId: string; messageId: number; messageUrl: string; title: string;
  mediaType: "movie" | "tv" | null; tmdbId: number | null;
  status: "skipped" | "submitting" | "pending" | "running" | "completed" | "failed" | "needs_review";
  reason: string | null; taskId: string | null; createdAt: string; updatedAt: string;
}
/** 各网盘分享的统一搜索结果；目前仅光鸭支持站内转存。 */
export interface ResourceSearchItem {
  title: string; shareUrl: string; cloudType: string; password: string; source: string; sourceKind: string; sourceName: string;
  postedAt: string | null; messageUrl: string;
}
/** 可转存服务及服务级独立转存目录。 */
export interface ResourceSearchTarget {
  serviceId: string; serviceName: string; providerType: "guangya" | "quark";
  directory: Pick<ProviderDirectory, "resourceId" | "displayPath" | "driveId"> | null; reason: string | null;
}

/** 搜索引擎接口前缀按当前控制台身份选择。 */
function resourceSearchPath(admin: boolean): string {
  return admin ? "/api/v1/admin/resource-search" : "/api/v1/resource-search";
}

/** 读取系统预置及自定义搜索来源。 */
export async function getResourceSearchSources(admin = false): Promise<ResourceSearchSource[]> {
  return (await requestJson<{ items: ResourceSearchSource[] }>(`${resourceSearchPath(admin)}/sources`)).items;
}

/** 读取当前账户的网盘服务和系统中可选择的 TG 频道。 */
export function getSubscriptionChannels(): Promise<{ channels: string[]; services: ServiceSubscriptionChannels[];
  channelTypes: { pageLimit: number; updatedAt: string | null; enabled: boolean; items: ChannelCloudTypes[] } }> {
  return requestJson<{ channels: string[]; services: ServiceSubscriptionChannels[];
    channelTypes: { pageLimit: number; updatedAt: string | null; enabled: boolean; items: ChannelCloudTypes[] } }>(
    "/api/v1/resource-search/subscription-channels");
}

/** 读取频道资源类型分析的缓存和进度。 */
export function getAdminChannelTypeAnalysis(): Promise<AdminChannelTypeAnalysis> {
  return requestJson("/api/v1/admin/resource-search/channel-types");
}

/** 立即启动全量频道类型分析，服务器异步执行并分批保存缓存。 */
export function startAdminChannelTypeAnalysis(): Promise<{ status: ChannelTypeAnalysisStatus }> {
  return requestJson("/api/v1/admin/resource-search/channel-types/analyze", { method: "POST" });
}

/** 为当前账户的一个网盘服务保存关注频道。 */
export async function saveServiceSubscriptionChannels(serviceId: string, channelKeys: string[]): Promise<string[]> {
  const result = await requestJson<{ channelKeys: string[] }>(
    `/api/v1/resource-search/subscription-channels/${encodeURIComponent(serviceId)}`,
    { method: "PUT", body: JSON.stringify({ channelKeys }) });
  return result.channelKeys;
}

/** 读取当前账号加入的影片订阅。 */
export async function listMovieSubscriptions(): Promise<MovieSubscription[]> {
  const result = await requestJson<{ items: MovieSubscription[] }>("/api/v1/resource-search/subscriptions");
  return result.items;
}

/** 查看当前用户一个网盘服务的最近订阅巡检和转存记录。 */
export function getMovieSubscriptionActivity(serviceId: string): Promise<{
  lastRunAt: string | null; nextRunAt: string; lastError: string | null; items: MovieSubscriptionActivity[];
}> {
  return requestJson(`/api/v1/resource-search/subscriptions/activity?serviceId=${encodeURIComponent(serviceId)}`);
}

/** 立即检查一个服务关注频道中的新消息。 */
export function checkMovieSubscriptionNow(serviceId: string): Promise<void> {
  return requestJson("/api/v1/resource-search/subscriptions/check",
    { method: "POST", body: JSON.stringify({ serviceId }) });
}

/** 从 TMDB 详情页把电影或剧集加入一个网盘服务。 */
export async function addMovieSubscription(input: { serviceId: string; mediaType: "movie" | "tv"; tmdbId: number }):
  Promise<{ item: MovieSubscription; alreadySubscribed: boolean }> {
  return requestJson("/api/v1/resource-search/subscriptions", { method: "POST", body: JSON.stringify(input) });
}

/** 从个人订阅列表中移除指定作品。 */
export function deleteMovieSubscription(item: Pick<MovieSubscription, "serviceId" | "mediaType" | "tmdbId">): Promise<void> {
  return requestJson(`/api/v1/resource-search/subscriptions/${encodeURIComponent(item.serviceId)}/${item.mediaType}/${item.tmdbId}`,
    { method: "DELETE" });
}

/** 保存频道和公开搜索站的启用状态及频道增删改。 */
export async function saveResourceSearchSources(items: ResourceSearchSource[], admin = false): Promise<ResourceSearchSource[]> {
  return (await requestJson<{ items: ResourceSearchSource[] }>(`${resourceSearchPath(admin)}/sources`,
    { method: "PUT", body: JSON.stringify({ items }) })).items;
}

/** 从云助手内部来源适配器搜索各网盘分享。 */
export function searchResources(keyword: string, admin = false): Promise<{ items: ResourceSearchItem[]; errors: string[] }> {
  return requestJson(`${resourceSearchPath(admin)}/search?keyword=${encodeURIComponent(keyword)}`);
}

/** 读取已有光鸭、夸克服务与各自独立转存目录。 */
export async function getResourceSearchTargets(admin = false): Promise<ResourceSearchTarget[]> {
  return (await requestJson<{ items: ResourceSearchTarget[] }>(`${resourceSearchPath(admin)}/targets`)).items;
}

/** 读取网盘服务自己保存的转存目录。 */
export async function getServiceTransferDirectory(serviceId: string, admin = false): Promise<ResourceSearchTarget["directory"]> {
  const prefix = admin ? "/api/v1/admin/services" : "/api/v1/services";
  return (await requestJson<{ directory: ResourceSearchTarget["directory"] }>(
    `${prefix}/${encodeURIComponent(serviceId)}/transfer-directory`)).directory;
}

/** 保存或清空独立转存目录，不修改影片整理配置。 */
export async function saveServiceTransferDirectory(serviceId: string, directory: ResourceSearchTarget["directory"],
  admin = false): Promise<ResourceSearchTarget["directory"]> {
  const prefix = admin ? "/api/v1/admin/services" : "/api/v1/services";
  return (await requestJson<{ directory: ResourceSearchTarget["directory"] }>(
    `${prefix}/${encodeURIComponent(serviceId)}/transfer-directory`,
    { method: "PUT", body: JSON.stringify({ directory }) })).directory;
}

/** 提交同网盘分享转存，收到任务编号后由页面继续查询。 */
export function transferResource(input: { shareUrl: string; password: string; serviceId: string }, admin = false):
  Promise<{ taskId: string; fileCount: number }> {
  return requestJson(`${resourceSearchPath(admin)}/transfer`, { method: "POST", body: JSON.stringify(input) });
}

/** 查询已提交分享转存任务的执行状态。 */
export function getResourceTransferStatus(serviceId: string, taskId: string, admin = false):
  Promise<{ status: "pending" | "running" | "completed" | "failed" }> {
  return requestJson(`${resourceSearchPath(admin)}/transfer-tasks/${encodeURIComponent(taskId)}?serviceId=${encodeURIComponent(serviceId)}`);
}
export type ScanScheduleType = "interval" | "daily" | "weekly" | "monthly";

export interface OverviewResult {
  serviceCount: number;
  mediaCount: number;
  activeJobCount: number;
  failedJobCount: number;
  needsReviewCount: number;
}

export interface WorkerStatus {
  enabled: boolean;
  running: boolean;
  activeWorkers: number;
  schedulingMode: "per_source_exclusive";
}

export interface AdminRuntimeStatus extends OverviewResult {
  service: string;
  serviceInstanceId: string;
  schemaVersion: number;
  userCount: number;
  worker: WorkerStatus;
  database: { type: "sqlite" | "postgres" | "mysql"; connected: boolean };
}

export type BuiltinMusicSourceId = "musicbrainz" | "netease" | "qmusic" | "kugou" | "migu" | "kuwo";

export interface AdminMusicSourceSettings {
  enabledSources: BuiltinMusicSourceId[];
  configurationRevision: number;
  source: "default" | "database";
}

export interface AdminConfigStatus {
  database: { type: "sqlite" | "postgres" | "mysql"; schemaVersion: number };
  tmdb: {
    source: "system" | "missing";
    configurationRevision: number;
    configuredCount: number;
    healthyCount: number;
    coolingCount: number;
    disabledCount: number;
    effectiveConcurrency: number;
    apiBaseUrl: string;
    imageBaseUrl: string;
    baseUrlSource: "default" | "database";
    baseUrlConfigurationRevision: number;
    revision: string;
  };
  publicAccess: {
    publicBaseUrl: string | null;
    source: "environment" | "database" | "missing";
    editable: boolean;
  };
  music: {
    sources: AdminMusicSourceSettings;
    musicBrainz: { status: string };
    acoustId: { status: string; configured: boolean; reasonCode: string };
    fingerprint: { status: string; configured: boolean; reasonCode: string };
  };
  credentials: { configured: boolean; source: "file" | "environment" | "generated" };
  plugins: { directoryReady: boolean; installedCount: number; enabledCount: number };
  aiModels: {
    configuredCount: number;
    enabledCount: number;
    availableCount: number;
    unavailableCount: number;
  };
  worker: WorkerStatus;
}

export type AiModelProtocol = "openai_chat_completions";
export type AiModelStatus = "enabled" | "disabled";
export type AiModelCheckStatus = "unknown" | "available" | "unavailable";

/** 管理端 AI 模型记录；API Key 永远不从服务端回显。 */
export interface AiModel {
  id: string;
  displayName: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  configurationRevision: number;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
  maxConcurrency: number;
  apiKeyConfigured: boolean;
  lastCheckStatus: AiModelCheckStatus;
  lastCheckErrorCode: string | null;
  lastCheckErrorMessage: string | null;
  lastCheckLatencyMs: number | null;
  lastCheckStructuredOutput: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAiModelInput {
  displayName: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
  maxConcurrency: number;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface AiModelAvailabilityResult {
  available: boolean;
  structuredOutput: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 服务配置页可读取的最小 AI 模型信息，不包含接口地址和 Secret 状态。 */
export interface AvailableAiModel {
  id: string;
  displayName: string;
  status: AiModelStatus;
  available: boolean;
}

export interface CloudService {
  id: string;
  userId: string;
  ownerUsername: string;
  displayName: string;
  /** 展示在服务标题下方的可选描述。 */
  description: string;
  providerType: string;
  status: ServiceStatus;
  connectionStatus: string;
  connectionAuthMode?: "official_api" | "web_qr" | "web_sms" | null;
  credentialRevision: number;
  canCreateLibrary: boolean;
  canDeleteService: boolean;
  /** 旧页面编译期兼容字段；服务接口不再返回这些媒体库数据。 */
  libraryId: string;
  dataType: MediaType;
  relayPlaybackEnabled: boolean;
  notificationEnabled: boolean;
  jellyfinEnabled: boolean;
  scanProfileRevision: number;
  metadataProfileRevision: number;
  catalogVersion: number;
  itemCount: number;
  recentJobs?: ScanJob[];
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 云聚合媒体库中一份完全独立的网盘来源配置。 */
export interface LibrarySource {
  id: string;
  libraryId: string;
  sourceMode: "linked_service" | "owned_copy" | "content_source";
  serviceId: string | null;
  displayName: string;
  providerType: string;
  serviceStatus: "active" | "scanning" | "disabled" | "reauthorization_required" | null;
  status: "active" | "disabled" | "reauthorization_required";
  connectionStatus: string;
  sortOrder: number;
  credentialRevision: number;
  /** 来源是否已有可用登录凭据；接口只返回状态，不返回凭据内容。 */
  credentialConfigured: boolean;
  configuration: Record<string, unknown>;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 媒体库及其来源摘要；旧单源库继续保留兼容字段。 */
export interface MediaLibrary {
  id: string;
  userId: string;
  ownerUsername: string;
  displayName: string;
  /** 媒体库备注，不影响客户端协议名称。 */
  description: string;
  dataType: MediaType;
  status: "active" | "disabled";
  libraryKind: MediaLibraryKind;
  sourceCount: number;
  sources: LibrarySource[];
  sourceId: string;
  sourceServiceId: string;
  sourceServiceName: string;
  providerType: string;
  sourceConnectionStatus: string;
  notificationEnabled: boolean;
  jellyfinEnabled: boolean;
  embyEnabled: boolean;
  navidromeEnabled: boolean;
  /** 有声书库独立的 Audiobookshelf 协议开关。 */
  absEnabled?: boolean;
  scanProfileRevision: number;
  metadataProfileRevision: number;
  catalogVersion: number;
  itemCount: number;
  /** 普通媒体库详情会返回最近任务；管理端详情不包含该字段。 */
  recentJobs?: ScanJob[];
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryDetailResult {
  library: MediaLibrary;
  scanProfile: Record<string, unknown>;
  metadataProfile: Record<string, unknown>;
}

/** 管理端全部服务和全部媒体库共用的服务摘要筛选条件。 */
export interface ServiceListFilters {
  search?: string;
  userId?: string;
  providerType?: string;
  dataType?: MediaType;
  status?: ServiceStatus;
  jellyfinEnabled?: boolean;
}

/** 创建云端服务时由 Web 端提交的完整配置。 */
export interface CreateCloudServiceInput {
  displayName: string;
  description?: string;
  provider: { type: string; connection: Record<string, string> };
  userId?: string;
}

export interface CreateLegacyMediaLibraryInput {
  displayName: string;
  dataType: MediaType;
  sourceServiceId: string;
  scan: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CreateCloudAggregateVideoLibraryInput {
  libraryKind: "cloud_aggregate_video";
  displayName: string;
  dataType: "video";
  sourceServiceIds: string[];
  metadata: Record<string, unknown>;
}

export type CreateMediaLibraryInput = CreateLegacyMediaLibraryInput | CreateCloudAggregateVideoLibraryInput;


export interface ServiceAccessAccount {
  id: string;
  libraryId: string;
  username: string;
  hasPassword: boolean;
  /** 旧密码账号可能需要重新设置一次密码，才能使用 Subsonic token+salt 登录。 */
  subsonicTokenAuthReady: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ServiceAccessSettings {
  relayPlaybackSupported: boolean;
  jellyfinRelayPlaybackEnabled: boolean;
  /** Jellyfin 客户端是否允许下载原始影片文件。 */
  jellyfinDownloadEnabled: boolean;
  /** 是否将 Jellyfin 节目媒体库按地区拆分。 */
  jellyfinRegionLibrariesEnabled: boolean;
  /** 各虚拟媒体库是否使用八张海报生成拼贴封面。 */
  jellyfinCollageCoverEnabled: boolean;
  jellyfinEnabled: boolean;
  jellyfinUrl: string | null;
  jellyfinPath: string;
  /** 固定 /j/ 前缀之后的单层可编辑地址后缀。 */
  jellyfinPathSuffix: string;
  /** Emby 与 Jellyfin 完全独立的协议开关和访问地址。 */
  embyEnabled: boolean;
  embyUrl: string | null;
  embyPath: string;
  embyPathSuffix: string;
  embyRelayPlaybackEnabled: boolean;
  embyDownloadEnabled: boolean;
  embyRegionLibrariesEnabled: boolean;
  embyCollageCoverEnabled: boolean;
  embyAccounts: ServiceAccessAccount[];
  /** 仅音乐类型服务支持公开 Navidrome/Subsonic 协议。 */
  navidromeSupported: boolean;
  navidromeEnabled: boolean;
  navidromeRelayPlaybackEnabled: boolean;
  navidromeUrl: string | null;
  navidromePath: string;
  /** 固定 /n/ 前缀之后的单层可编辑地址后缀。 */
  navidromePathSuffix: string;
  /** 历史最早账号；尚未启用协议的新在线视频库没有账号。 */
  account: ServiceAccessAccount | null;
  /** 同一个 Jellyfin 地址下按创建时间排列的全部账号。 */
  accounts: ServiceAccessAccount[];
}

export interface CreateCloudServiceResult { service: ServiceDetail; }
export interface CreateMediaLibraryResult {
  library: MediaLibrary;
  accessCredentials: { account: ServiceAccessAccount; password: string } | null;
}


export interface ScanJob {
  id: string;
  /** 后台任务类型；scan 为扫描刮削，media_probe 为视频规格分析。 */
  jobType: "scan" | "media_probe";
  userId: string;
  serviceId: string;
  libraryId: string;
  librarySourceId: string;
  parentJobId: string | null;
  ownerUsername: string;
  serviceName: string;
  dataType: MediaType;
  scanMode: "incremental" | "full";
  status: JobStatus;
  stage: string;
  processedCount: number;
  totalCount: number | null;
  discoveredCount: number;
  skippedCount: number;
  matchedCount: number | null;
  unmatchedCount: number | null;
  errorCount: number;
  currentPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  retryCount: number;
  controlAction: "none" | "pause" | "cancel";
  snapshot: Record<string, unknown>;
  checkpointUpdatedAt: string | null;
  resumeSupported: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  waitingReason: "scan_worker_capacity" | "scan_queue_order" | "service_scan_priority" | "media_probe_worker_capacity" | "worker_dispatch" | null;
  waitingForJobs: Array<{
    id: string;
    jobType: "scan" | "media_probe";
    serviceId: string;
    serviceName: string;
    ownerUsername: string;
    status: JobStatus;
  }>;
  hiddenWaitingJobCount: number;
  queueAheadCount: number;
  updatedAt: string;
}

/** 云聚合扫描父任务；每个来源对应一个可并行执行的子任务。 */
export interface LibraryScanJob {
  id: string;
  userId: string;
  libraryId: string;
  scanMode: "incremental" | "full";
  status: "pending" | "running" | "paused" | "completed" | "completed_with_errors" | "partial_failed" | "failed" | "cancelled";
  controlAction: "none" | "pause" | "cancel";
  sourceCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  cancelledSourceCount: number;
  processedCount: number;
  discoveredCount: number;
  errorCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  sourceJobs: ScanJob[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** 单个扫描任务采用的一条 AI 查询词补充记录。 */
export interface AiSupplementRecord {
  id: string;
  mediaType: "movie" | "tv";
  triggerReason: string;
  ruleTitle: string;
  cleanedTitle: string;
  alternateTitle: string;
  confidence: number;
  fileCount: number;
  modelId: string;
  modelDisplayName: string;
  modelRevision: number;
  createdAt: string;
}

export interface JobAiSupplementResult {
  total: number;
  items: AiSupplementRecord[];
}

/** 媒体库级扫描或视频规格分析定时任务。 */
export interface ScanSchedule {
  id: string;
  userId: string;
  libraryId: string;
  scanMode: "incremental" | "full" | "media_probe";
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezoneOffsetMinutes: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string | null;
  quietEndTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateScanScheduleInput {
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezoneOffsetMinutes: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string;
  quietEndTime: string;
}

/** 视频规格后台任务详情中的失败文件。 */
export interface MediaProbeFailure {
  sourceFileId: string;
  fileName: string;
  errorCode: string;
  errorMessage: string;
}

export interface ServiceDetail extends CloudService {
  connectionAuthMode: "official_api" | "web_qr" | "web_sms" | null;
  credentialConfigured: boolean;
  scanProfile: Record<string, unknown>;
  metadataProfile: Record<string, unknown>;
  bindings: Array<{ bindingId: string; clientDeviceId: string; clientServiceId: string; providerType: string; updatedAt: string }>;
  recentJobs: ScanJob[];
}


export interface MediaItem {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  libraryKind: MediaLibraryKind;
  mediaType: MediaType;
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  premiereDate: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  matchState: MatchState;
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
  fileCount: number;
  /** 当前条目及其剧集已完成的 ffprobe 规格汇总。 */
  mediaProbeSummary: MediaProbeSummary | null;
  ownerUsername: string;
  serviceName: string;
  /** 云聚合条目及其直接子项实际所属的网盘来源。 */
  sourceNames: string[];
  createdAt: string;
  updatedAt: string;
}

/** 海报卡片和媒体详情使用的视频规格汇总。 */
export interface MediaProbeSummary {
  analyzedFileCount: number;
  durationMs: number;
  container: string;
  bitRate: number;
  videoCodec: string;
  width: number;
  height: number;
  videoRange: string;
  videoRangeType: string;
  audioCodec: string;
  audioChannels: number;
  audioChannelLayout: string;
  audioStreamCount: number;
  subtitleStreamCount: number;
}

/** 单个源文件已经完成的 ffprobe 结果。 */
export interface MediaProbeResult {
  probeVersion: number;
  container: string;
  runTimeTicks: number;
  bitRate: number;
  size: number;
  mediaStreams: Array<Record<string, unknown>>;
}

export interface MediaPathItem {
  fileId: string;
  resourceId: string;
  linkedItemId: string;
  linkedItemTitle: string;
  sourceName: string;
  providerType: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  /** 当前源文件已经完成的 ffprobe 结果；未分析时为空。 */
  mediaProbe: MediaProbeResult | null;
}

export type ManualVideoMatchType = "movie" | "tv";

export interface ManualVideoMatchCandidate {
  id: number;
  mediaType: ManualVideoMatchType;
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  releaseDate: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number;
  popularity: number;
}

export interface ProviderDescriptor {
  type: string;
  displayName: string;
  adapterVersion: string;
  credentialSchemaVersion: number;
  /** Provider 可以完成扫描、刮削和协议访问的数据类型。 */
  supportedDataTypes: Array<"video" | "music">;
  capabilities: string[];
  recommendedScanSettings: {
    scanDirectoryConcurrency: { default: number };
    scrapeTaskConcurrency: { default: number };
  };
  authenticationMode?: "form" | "web_qr" | "authorization_session";
  authMethods?: Array<{
    type: string;
    displayName: string;
    interaction: "qr" | "sms";
    recommended: boolean;
  }>;
  authSources?: Array<{
    value: string;
    label: string;
    recommended: boolean;
  }>;
  connectionFields: Array<{
    name: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    secret: boolean;
  }>;
}

/** 光鸭网页登录状态；手机号、验证码和 Token 始终不会由接口回显。 */
export interface GuangyaAuthorizationStatus {
  authorizationSessionId: string;
  authMethod: "qr" | "sms";
  status: "pending" | "authorized" | "expired" | "failed";
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
  accountLabel: string | null;
  maskedPhone: string | null;
  errorMessage: string | null;
}

/** 启动短信登录后的服务端结果；光鸭要求交互时先打开官方人机验证页面。 */
export interface GuangyaSmsAuthorizationStartResult {
  authorization: GuangyaAuthorizationStatus | null;
  captcha: {
    captchaSessionId: string;
    verificationUri: string;
    expiresAt: string;
  } | null;
}

/** 新网盘统一扫码状态；Token、Cookie 和设备码只保留在 API 内存。 */
export interface CloudAuthorizationStatus {
  authorizationSessionId: string;
  providerType: string;
  authMethod: string;
  state: "waiting" | "scanned" | "confirmed" | "authorized" | "rejected" | "expired" | "cancelled" | "failed";
  qrCodeContent: string;
  qrCodeImageUrl: string;
  authorizationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  accountSummary: string | null;
  errorCode: string | null;
  message: string | null;
}

/** 路径选择器显示并保存的网盘目录。 */
export interface ProviderDirectory {
  name: string;
  resourceId: string;
  displayPath: string;
  driveId?: string;
}

export interface ProviderDirectoryListing {
  current: ProviderDirectory;
  items: ProviderDirectory[];
}

/** 服务级整理预览与执行任务只使用网盘资源编号，不依赖媒体库。 */
export interface OrganizePlanItem {
  sourceId: string;
  sourcePath: string;
  sourceName: string;
  isDirectory?: boolean;
  action?: "organize" | "unrecognized";
  targetParts: string[];
  targetName: string;
  willOverwrite: boolean;
  status: "ready" | "skipped";
  reason: string | null;
}

export interface OrganizePlan {
  id: string;
  serviceId: string;
  mode: "move" | "copy";
  unrecognizedTransferEnabled?: boolean;
  unrecognizedDirectory?: ProviderDirectory | null;
  aiAssistEnabled?: boolean;
  aiModelId?: string | null;
  aiFailureCount?: number;
  status: "preparing" | "ready" | "failed";
  error: string | null;
  items: OrganizePlanItem[];
  scannedDirectories: ProviderDirectory[];
  directoryCount: number;
  itemCount: number;
  readyCount: number;
  overwriteCount: number;
  nextOffset: number | null;
  createdAt: string;
}

export interface OrganizeJob {
  id: string;
  planId: string;
  serviceId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  items: Array<{ index: number; stage: string; error: string | null }>;
  itemCount: number;
  completedCount: number;
  error: string | null;
  autoRetryCount?: number;
  nextRetryAt?: string | null;
  createdAt: string;
}

/** 后台任务页中的整理任务摘要；识别阶段尚无可计算的文件总数。 */
export interface OrganizeTaskSummary {
  id: string;
  serviceId: string;
  serviceName: string;
  status: "preparing" | OrganizeJob["status"];
  completedCount: number;
  failedCount: number;
  totalCount: number | null;
  error: string | null;
  autoRetryCount?: number;
  nextRetryAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 服务级影片整理计划沿用媒体库定时扫描的时间配置。 */
export interface OrganizeSchedule extends Omit<ScanSchedule, "id" | "libraryId" | "scanMode" | "createdAt"> {
  serviceId: string;
  sources: ProviderDirectory[];
  target: ProviderDirectory | null;
  mode: "move" | "copy";
  unrecognizedTransferEnabled?: boolean;
  unrecognizedDirectory?: ProviderDirectory | null;
  aiAssistEnabled?: boolean;
  aiModelId?: string | null;
  pendingPlanId: string | null;
  pendingRunKind?: "scheduled" | "manual";
  lastRunMessage?: string | null;
}

export type UpdateOrganizeScheduleInput = Pick<OrganizeSchedule,
  "enabled" | "scheduleType" | "intervalMinutes" | "timeOfDay" | "dayOfWeek" | "dayOfMonth" |
  "timezoneOffsetMinutes" | "quietPeriodEnabled" | "quietStartTime" | "quietEndTime" |
  "sources" | "target" | "mode" | "unrecognizedTransferEnabled" | "unrecognizedDirectory" |
  "aiAssistEnabled" | "aiModelId">;

/** 视频媒体库文件浏览的当前目录条目。 */
export interface LibraryBrowseEntry extends ProviderDirectory {
  parentResourceId: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
}

export interface LibraryBrowsePage {
  current: ProviderDirectory;
  items: LibraryBrowseEntry[];
  total: number;
  nextOffset: number | null;
}

export interface LibraryBrowseSummary {
  resourceId: string;
  linkedFileCount: number;
  itemCount: number;
  itemId: string | null;
  title: string | null;
  year: number | null;
  posterUrl: string | null;
  matchState: string | null;
  manualMatched: boolean;
}

/** 读取媒体库来源当前目录的直接子项，分页时沿用同一完整目录排序。 */
export function browseLibraryFiles(
  libraryId: string, sourceId: string, parent: ProviderDirectory | undefined,
  sort: "name" | "modified" | "size", descending: boolean, offset: number, admin = false, refresh = false,
): Promise<LibraryBrowsePage> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson(withQuery(`${prefix}/${libraryId}/sources/${sourceId}/browse`, {
    resourceId: parent?.resourceId, displayPath: parent?.displayPath, driveId: parent?.driveId,
    sort, descending: String(descending), offset, refresh: String(refresh),
  }));
}

/** 批量查询本页网盘条目在当前视频媒体库中的刮削摘要。 */
export async function listLibraryBrowseSummaries(
  libraryId: string, sourceId: string, entries: LibraryBrowseEntry[], admin = false,
): Promise<LibraryBrowseSummary[]> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  const result = await requestJson<{ items: LibraryBrowseSummary[] }>(
    `${prefix}/${libraryId}/sources/${sourceId}/browse/summaries`, {
      method: "POST", body: JSON.stringify({ targets: entries.map((entry) => ({
        resourceId: entry.resourceId, displayPath: entry.displayPath, isDirectory: entry.isDirectory,
      })) }),
    });
  return result.items;
}

/** 从文件浏览对指定来源的文件或目录创建精确视频扫描任务。 */
export function createLibraryTargetedScan(
  libraryId: string, sourceId: string, entry: LibraryBrowseEntry,
  parent: ProviderDirectory | undefined, admin = false,
): Promise<{ job: ScanJob }> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson(`${prefix}/${libraryId}/sources/${sourceId}/browse/scan`, {
    method: "POST",
    body: JSON.stringify({ resourceId: entry.resourceId, isDirectory: entry.isDirectory, parent }),
  });
}

export interface LibraryBrowseUnmatchPreview {
  fileCount: number;
  itemCount: number;
  examples: string[];
  revision: string;
}

/** 解除前预览当前来源目标范围的有效文件关联。 */
export function previewLibraryBrowseUnmatch(libraryId: string, sourceId: string,
  entry: LibraryBrowseEntry, parent: ProviderDirectory | undefined, admin = false,
): Promise<LibraryBrowseUnmatchPreview> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson(`${prefix}/${libraryId}/sources/${sourceId}/browse/unmatch/preview`, {
    method: "POST", body: JSON.stringify({ resourceId: entry.resourceId, isDirectory: entry.isDirectory, parent }),
  });
}

/** 确认预览版本后解除文件关联，网盘文件和扫描路径保持原状。 */
export function unmatchLibraryBrowseRange(libraryId: string, sourceId: string,
  entry: LibraryBrowseEntry, parent: ProviderDirectory | undefined, expectedRevision: string, admin = false,
): Promise<{ fileCount: number; removedItemCount: number; retainedItemCount: number }> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson(`${prefix}/${libraryId}/sources/${sourceId}/browse/unmatch`, {
    method: "POST", body: JSON.stringify({ resourceId: entry.resourceId, isDirectory: entry.isDirectory, parent, expectedRevision }),
  });
}

/** 以当前来源文件范围搜索 TMDB 候选，允许目录包含多个原始影视条目。 */
export function searchLibraryBrowseRangeMatch(libraryId: string, sourceId: string,
  input: { query: string; mediaType: ManualVideoMatchType; year?: number | null }, admin = false,
): Promise<ManualVideoMatchCandidate[]> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson<{ items: ManualVideoMatchCandidate[] }>(withQuery(
    `${prefix}/${libraryId}/sources/${sourceId}/browse/manual-match/search`,
    { query: input.query, mediaType: input.mediaType, year: input.year ?? undefined },
  )).then((result) => result.items);
}

/** 把已预览范围内的所有视频绑定到同一个电影或节目。 */
export function applyLibraryBrowseRangeMatch(libraryId: string, sourceId: string,
  entry: LibraryBrowseEntry, parent: ProviderDirectory | undefined, expectedRevision: string,
  input: { mediaType: ManualVideoMatchType; tmdbId: number }, admin = false,
): Promise<{ itemId: string; fileCount: number }> {
  const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
  return requestJson(`${prefix}/${libraryId}/sources/${sourceId}/browse/manual-match`, {
    method: "POST", body: JSON.stringify({ resourceId: entry.resourceId,
      isDirectory: entry.isDirectory, parent, expectedRevision, ...input }),
  });
}

export interface AdminUser extends AuthUser {
  serviceCount: number;
  mediaCount: number;
  lastLoginAt?: string | null;
}

export interface PluginVersion {
  pluginId: string;
  version: string;
  displayName: string;
  status: "imported" | "enabled" | "disabled";
  sha256: string;
  manifest: Record<string, unknown>;
  configurationRevision: number;
  configurationState: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  operatorUsername: string | null;
  operationType: string;
  targetType: string;
  targetId: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 为分页和筛选接口构造查询字符串。 */
function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([name, value]) => {
    if (value !== undefined && value !== "") query.set(name, String(value));
  });
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

/** 读取当前用户概览。 */
export function getOverview(): Promise<OverviewResult> {
  return requestJson("/api/v1/overview");
}

/** 读取当前 FlyCloudHelper 实例的真实服务版本。 */
export function getServiceHealth(): Promise<ServiceHealth> {
  return requestJson("/api/v1/health");
}

/** 读取用户或管理端服务列表，管理端筛选由服务端作用于完整数据集。 */
export function listServices(
  admin = false,
  filters: ServiceListFilters = {},
): Promise<{ items: CloudService[]; total: number }> {
  return requestJson(withQuery(admin ? "/api/v1/admin/services" : "/api/v1/services", {
    search: filters.search,
    userId: admin ? filters.userId : undefined,
    providerType: filters.providerType,
    dataType: filters.dataType,
    status: filters.status,
    jellyfinEnabled: filters.jellyfinEnabled === undefined ? undefined : String(filters.jellyfinEnabled),
    limit: 200,
  }));
}

/** 读取用户或管理端服务详情。 */
export async function getService(serviceId: string, admin = false): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}` : `/api/v1/services/${serviceId}`,
  );
  return result.service;
}

/** 保存服务名称和描述，返回服务端最终详情。 */
export async function updateServiceProfile(
  serviceId: string,
  input: { displayName: string; description: string; expectedUpdatedAt: string },
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}` : `/api/v1/services/${serviceId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.service;
}

/** 读取媒体库列表。 */
export function listLibraries(admin = false, filters: ServiceListFilters = {}): Promise<{ items: MediaLibrary[]; total: number }> {
  return requestJson(withQuery(admin ? "/api/v1/admin/libraries" : "/api/v1/libraries", {
    search: filters.search,
    userId: admin ? filters.userId : undefined,
    dataType: filters.dataType,
    status: filters.status === "active" || filters.status === "disabled" ? filters.status : undefined,
    limit: 200,
  }));
}

/** 读取单个媒体库及其当前配置。 */
export function getLibrary(libraryId: string, admin = false): Promise<LibraryDetailResult> {
  return requestJson(admin ? `/api/v1/admin/libraries/${libraryId}` : `/api/v1/libraries/${libraryId}`);
}

/** 修改媒体库名称和备注，管理员使用媒体库资料专属接口。 */
export async function updateContentLibraryName(libraryId: string, displayName: string, description: string, admin = false): Promise<MediaLibrary> {
  const encodedId = encodeURIComponent(libraryId);
  const result = await requestJson<{ library: MediaLibrary }>(
    admin ? `/api/v1/admin/libraries/${encodedId}/name` : `/api/v1/libraries/${encodedId}`,
    { method: "PATCH", body: JSON.stringify({ displayName: displayName.trim(), description: description.trim() }) },
  );
  return result.library;
}

/** 从一个尚未关联的网盘服务创建媒体库。 */
export function createLibrary(input: CreateMediaLibraryInput): Promise<CreateMediaLibraryResult> {
  return requestJson("/api/v1/libraries", { method: "POST", body: JSON.stringify(input) });
}

/** 保存媒体库扫描配置，并返回服务端最终媒体库摘要。 */
export async function updateLibraryScanProfile(
  libraryId: string,
  scan: Record<string, unknown>,
  admin = false,
  updateScope: "paths" | "profile" = "profile",
): Promise<MediaLibrary> {
  const result = await requestJson<{ library: MediaLibrary }>(
    admin ? `/api/v1/admin/libraries/${libraryId}/scan-profile` : `/api/v1/libraries/${libraryId}/scan-profile`,
    { method: "PUT", body: JSON.stringify({ scan, updateScope }) },
  );
  return result.library;
}

/** 保存媒体库元数据配置，并返回服务端最终媒体库摘要。 */
export async function updateLibraryMetadataProfile(
  libraryId: string,
  metadata: Record<string, unknown>,
  admin = false,
): Promise<MediaLibrary> {
  const result = await requestJson<{ library: MediaLibrary }>(
    admin ? `/api/v1/admin/libraries/${libraryId}/metadata-profile` : `/api/v1/libraries/${libraryId}/metadata-profile`,
    { method: "PUT", body: JSON.stringify({ metadata }) },
  );
  return result.library;
}

/** 保存媒体库任务完成通知开关。 */
export async function updateLibraryNotificationSettings(
  libraryId: string,
  notificationEnabled: boolean,
  admin = false,
): Promise<MediaLibrary> {
  const result = await requestJson<{ library: MediaLibrary }>(
    admin
      ? `/api/v1/admin/libraries/${libraryId}/notification-settings`
      : `/api/v1/libraries/${libraryId}/notification-settings`,
    { method: "PATCH", body: JSON.stringify({ notificationEnabled }) },
  );
  return result.library;
}

/** 删除媒体库并保留来源网盘服务。 */
export function deleteLibrary(libraryId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/libraries/${libraryId}` : `/api/v1/libraries/${libraryId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: libraryId }),
  });
}

/** 读取单个服务中某个目录的直接子目录。 */
export function browseServiceDirectories(
  serviceId: string,
  parent?: Pick<ProviderDirectory, "resourceId" | "displayPath" | "driveId">,
  admin = false,
): Promise<ProviderDirectoryListing> {
  const path = admin
    ? `/api/v1/admin/services/${serviceId}/directories`
    : `/api/v1/services/${serviceId}/directories`;
  // 关键变量：每次目录读取使用新地址，避免浏览器或反向代理继续复用重新授权前的410响应。
  const cacheKey = Date.now();
  return requestJson(withQuery(path, {
    resourceId: parent?.resourceId,
    displayPath: parent?.displayPath,
    driveId: parent?.driveId,
    cacheKey,
  }));
}

/** 读取当前服务的文件整理能力与登录方式限制。 */
export function getServiceOrganizeCapabilities(serviceId: string, admin = false): Promise<{ supported: boolean; mode: string; reason: string | null }> {
  return requestJson<{ supported: boolean; mode: string; reason: string | null }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/capabilities`);
}

/** 返回整理页可选的已启用 AI 模型，不返回凭据。 */
export function getServiceOrganizeAiModels(serviceId: string, admin = false): Promise<{ items: AvailableAiModel[] }> {
  return requestJson<{ items: AvailableAiModel[] }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/ai-models`);
}

/** 启动后台识别预览，页面无需等待整棵目录扫描。 */
export async function createServiceOrganizePlan(serviceId: string, input: {
  sources: ProviderDirectory[]; target: ProviderDirectory; mode: "move" | "copy";
  unrecognizedTransferEnabled?: boolean; unrecognizedDirectory?: ProviderDirectory | null;
  aiAssistEnabled?: boolean; aiModelId?: string | null;
}, admin = false): Promise<OrganizePlan> {
  const result = await requestJson<{ plan: OrganizePlan }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/plans`,
    { method: "POST", body: JSON.stringify(input) });
  return result.plan;
}

/** 轮询识别预览。 */
export async function getServiceOrganizePlan(serviceId: string, planId: string, admin = false, offset = 0): Promise<OrganizePlan> {
  const result = await requestJson<{ plan: OrganizePlan }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/plans/${planId}?offset=${offset}`);
  return result.plan;
}

/** 启动已确认预览的文件执行任务。 */
export async function createServiceOrganizeJob(serviceId: string, planId: string, admin = false): Promise<OrganizeJob> {
  const result = await requestJson<{ job: OrganizeJob }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/jobs`,
    { method: "POST", body: JSON.stringify({ planId }) });
  return result.job;
}

/** 刷新页面时找回服务的历史任务。 */
export function listServiceOrganizeJobs(serviceId: string, admin = false): Promise<{ items: OrganizeJob[] }> {
  return requestJson<{ items: OrganizeJob[] }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/jobs`);
}

/** 按当前用户或管理员权限读取整理任务及识别中的预览。 */
export function listOrganizeTasks(admin = false, filters: { status?: string; limit?: number; offset?: number } = {}):
  Promise<{ items: OrganizeTaskSummary[]; total: number }> {
  const query = new URLSearchParams({ status: filters.status ?? "all", limit: String(filters.limit ?? 8),
    offset: String(filters.offset ?? 0) });
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/organize/tasks?${query.toString()}`);
}

/** 清除当前账号或管理员范围内已完成、失败或取消的整理任务记录。 */
export async function clearFinishedOrganizeTasks(admin = false): Promise<number> {
  const result = await requestJson<{ deletedCount: number }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/organize/tasks/completed`,
    { method: "DELETE", body: JSON.stringify({ confirmation: "completed" }) },
  );
  return result.deletedCount;
}

/** 读取当前网盘服务的整理定时任务。 */
export async function getServiceOrganizeSchedule(serviceId: string, admin = false): Promise<OrganizeSchedule> {
  const result = await requestJson<{ schedule: OrganizeSchedule }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/schedule`);
  return result.schedule;
}

/** 保存定时规则与本服务的来源、目标目录。 */
export async function updateServiceOrganizeSchedule(serviceId: string, input: UpdateOrganizeScheduleInput,
  admin = false): Promise<OrganizeSchedule> {
  const result = await requestJson<{ schedule: OrganizeSchedule }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/schedule`,
    { method: "PUT", body: JSON.stringify(input) });
  return result.schedule;
}

/** 以已保存配置立即启动后台识别，识别完成后自动整理。 */
export async function runServiceOrganizeNow(serviceId: string, admin = false): Promise<OrganizeSchedule> {
  const result = await requestJson<{ schedule: OrganizeSchedule }>(
    `${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/schedule/run-now`,
    { method: "POST" });
  return result.schedule;
}

/** 读取后台执行阶段。 */
export async function getServiceOrganizeJob(serviceId: string, jobId: string, admin = false): Promise<OrganizeJob> {
  const result = await requestJson<{ job: OrganizeJob }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/jobs/${jobId}`);
  return result.job;
}

/** 在文件边界暂停、继续或取消整理任务。 */
export async function controlServiceOrganizeJob(serviceId: string, jobId: string,
  action: "pause" | "resume" | "cancel", admin = false): Promise<OrganizeJob> {
  const result = await requestJson<{ job: OrganizeJob }>(`${admin ? "/api/v1/admin" : "/api/v1"}/services/${serviceId}/organize/jobs/${jobId}/control`,
    { method: "POST", body: JSON.stringify({ action }) });
  return result.job;
}

/** 将已有网盘服务关联为云聚合库来源；连接状态和凭据继续由服务统一管理。 */
export async function addLibrarySource(libraryId: string, sourceServiceId: string): Promise<LibrarySource> {
  const result = await requestJson<{ source: LibrarySource }>(`/api/v1/libraries/${libraryId}/sources`, {
    method: "POST",
    body: JSON.stringify({ sourceServiceId }),
  });
  return result.source;
}

/** 保存云聚合来源的显示名称、启用状态或稳定展示顺序。 */
export async function updateLibrarySource(
  libraryId: string,
  sourceId: string,
  patch: { displayName?: string; status?: "active" | "disabled"; sortOrder?: number },
): Promise<LibrarySource> {
  const result = await requestJson<{ source: LibrarySource }>(`/api/v1/libraries/${libraryId}/sources/${sourceId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return result.source;
}

/** 保存单个云聚合来源自己的扫描路径和并发配置。 */
export async function updateLibrarySourceScanProfile(
  libraryId: string,
  sourceId: string,
  scan: Record<string, unknown>,
): Promise<LibrarySource> {
  const result = await requestJson<{ source: LibrarySource }>(`/api/v1/libraries/${libraryId}/sources/${sourceId}/scan-profile`, {
    method: "PUT",
    body: JSON.stringify({ scan }),
  });
  return result.source;
}

/** 兼容遗留独立来源的连接更新；新来源连接统一在网盘服务中管理。 */
export async function updateLibrarySourceConnection(
  libraryId: string,
  sourceId: string,
  connection: Record<string, string>,
  expectedRevision: number,
): Promise<LibrarySource> {
  const result = await requestJson<{ source: LibrarySource }>(`/api/v1/libraries/${libraryId}/sources/${sourceId}/connection`, {
    method: "PUT",
    body: JSON.stringify({ connection, ...(expectedRevision > 0 ? { expectedRevision } : {}) }),
  });
  return result.source;
}

/** 浏览云聚合来源自己的网盘目录。 */
export function browseLibrarySourceDirectories(
  libraryId: string,
  sourceId: string,
  parent?: Pick<ProviderDirectory, "resourceId" | "displayPath" | "driveId">,
): Promise<ProviderDirectoryListing> {
  return requestJson(withQuery(`/api/v1/libraries/${libraryId}/sources/${sourceId}/directories`, {
    resourceId: parent?.resourceId,
    displayPath: parent?.displayPath,
    driveId: parent?.driveId,
    cacheKey: Date.now(),
  }));
}

/** 删除云聚合库中的来源成员，不影响被引用的网盘服务和其他媒体库。 */
export function deleteLibrarySource(libraryId: string, sourceId: string): Promise<void> {
  return requestJson(`/api/v1/libraries/${libraryId}/sources/${sourceId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: sourceId }),
  });
}

/** 读取可配置的 Provider 描述。 */
export async function listProviders(): Promise<ProviderDescriptor[]> {
  return (await requestJson<{ items: ProviderDescriptor[] }>("/api/v1/providers")).items;
}

/** 启动光鸭网页二维码登录；管理员需要同时绑定目标用户。 */
export function startGuangyaAuthorization(
  admin = false,
  userId?: string,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? "/api/v1/admin/providers/guangya/auth-sessions"
      : "/api/v1/providers/guangya/auth-sessions",
    {
      method: "POST",
      body: JSON.stringify(admin ? { userId } : {}),
    },
  );
}

/** 发送光鸭网页验证码；服务端只返回脱敏手机号和短期会话 ID。 */
export function startGuangyaSmsAuthorization(
  phoneNumber: string,
  captchaRedirectUri: string,
  admin = false,
  userId?: string,
): Promise<GuangyaSmsAuthorizationStartResult> {
  return requestJson(
    admin
      ? "/api/v1/admin/providers/guangya/sms-auth-sessions"
      : "/api/v1/providers/guangya/sms-auth-sessions",
    {
      method: "POST",
      body: JSON.stringify(admin
        ? { userId, phoneNumber, captchaRedirectUri }
        : { phoneNumber, captchaRedirectUri }),
    },
  );
}

/** 提交光鸭官方人机验证回调 Token，并真正发送短信验证码。 */
export function completeGuangyaSmsCaptcha(
  captchaSessionId: string,
  captchaToken: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/sms-auth-sessions/${captchaSessionId}/captcha`
      : `/api/v1/providers/guangya/sms-auth-sessions/${captchaSessionId}/captcha`,
    {
      method: "POST",
      body: JSON.stringify({ captchaToken }),
    },
  );
}

/** 提交光鸭网页短信验证码并换取仅服务端可见的连接。 */
export function verifyGuangyaSmsAuthorization(
  authorizationSessionId: string,
  verificationCode: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/sms-auth-sessions/${authorizationSessionId}/verify`
      : `/api/v1/providers/guangya/sms-auth-sessions/${authorizationSessionId}/verify`,
    {
      method: "POST",
      body: JSON.stringify({ verificationCode }),
    },
  );
}

/** 读取由服务端轮询光鸭官网推进的授权状态。 */
export function pollGuangyaAuthorization(
  authorizationSessionId: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/auth-sessions/${authorizationSessionId}`
      : `/api/v1/providers/guangya/auth-sessions/${authorizationSessionId}`,
  );
}

/** 在FlyCloudHelper内按可选来源启动指定网盘扫码会话。 */
export function startCloudAuthorization(
  providerType: string,
  admin = false,
  userId?: string,
  options: { clientType?: string } = {},
): Promise<CloudAuthorizationStatus> {
  return requestJson(
    admin ? `/api/v1/admin/providers/${encodeURIComponent(providerType)}/auth-sessions` : `/api/v1/providers/${encodeURIComponent(providerType)}/auth-sessions`,
    { method: "POST", body: JSON.stringify(admin ? { userId, ...options } : options) },
  );
}

/** 读取指定网盘扫码状态。 */
export function pollCloudAuthorization(providerType: string, authorizationSessionId: string, admin = false): Promise<CloudAuthorizationStatus> {
  return requestJson(admin
    ? `/api/v1/admin/providers/${encodeURIComponent(providerType)}/auth-sessions/${encodeURIComponent(authorizationSessionId)}`
    : `/api/v1/providers/${encodeURIComponent(providerType)}/auth-sessions/${encodeURIComponent(authorizationSessionId)}`);
}

/** 扫码确认后由服务端完成 Token 或 Cookie 交换。 */
export function completeCloudAuthorization(providerType: string, authorizationSessionId: string, admin = false): Promise<CloudAuthorizationStatus> {
  return requestJson(admin
    ? `/api/v1/admin/providers/${encodeURIComponent(providerType)}/auth-sessions/${encodeURIComponent(authorizationSessionId)}/complete`
    : `/api/v1/providers/${encodeURIComponent(providerType)}/auth-sessions/${encodeURIComponent(authorizationSessionId)}/complete`, {
    method: "POST", body: JSON.stringify({}),
  });
}

/** 创建用户或管理员代建的云端服务。 */
export async function createService(
  input: CreateCloudServiceInput,
  admin = false,
): Promise<CreateCloudServiceResult> {
  return requestJson<CreateCloudServiceResult>(admin ? "/api/v1/admin/services" : "/api/v1/services", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 创建扫描任务；Web 控制台使用稳定设备标识和随机请求 ID。 */
export async function createScanJob(serviceId: string, scanMode: "incremental" | "full", admin = false): Promise<ScanJob | LibraryScanJob> {
  const result = await requestJson<{ job: ScanJob | LibraryScanJob }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/scan-jobs` : `/api/v1/libraries/${serviceId}/scan-jobs`,
    {
      method: "POST",
      body: JSON.stringify({
        scanMode,
        requestId: createRequestId(),
        clientDeviceId: "flycloud-helper-web",
      }),
    },
  );
  return result.job;
}

/** 对云聚合父任务统一下发暂停、继续或取消动作。 */
export async function controlLibraryScanJob(
  libraryId: string,
  jobId: string,
  action: "pause" | "resume" | "cancel",
  admin = false,
): Promise<LibraryScanJob> {
  const result = await requestJson<{ job: LibraryScanJob }>(
    admin
      ? `/api/v1/admin/libraries/${libraryId}/library-scan-jobs/${jobId}/control`
      : `/api/v1/libraries/${libraryId}/library-scan-jobs/${jobId}/control`,
    { method: "POST", body: JSON.stringify({ action }) },
  );
  return result.job;
}

/** 读取云聚合父任务及各来源子任务的最新汇总状态。 */
export async function getLibraryScanJob(libraryId: string, jobId: string, admin = false): Promise<LibraryScanJob> {
  const result = await requestJson<{ job: LibraryScanJob }>(
    admin
      ? `/api/v1/admin/libraries/${libraryId}/library-scan-jobs/${jobId}`
      : `/api/v1/libraries/${libraryId}/library-scan-jobs/${jobId}`,
  );
  return result.job;
}

/** 删除已经结束的云聚合父任务及其全部来源子任务。 */
export function deleteLibraryScanJob(libraryId: string, jobId: string, admin = false): Promise<void> {
  return requestJson(
    admin
      ? `/api/v1/admin/libraries/${libraryId}/library-scan-jobs/${jobId}`
      : `/api/v1/libraries/${libraryId}/library-scan-jobs/${jobId}`,
    { method: "DELETE", body: JSON.stringify({ confirmation: jobId }) },
  );
}

/** 读取媒体库的扫描和视频规格分析计划。 */
export async function getLibraryScanSchedules(libraryId: string, admin = false): Promise<ScanSchedule[]> {
  const result = await requestJson<{ schedules: ScanSchedule[] }>(
    admin ? `/api/v1/admin/libraries/${libraryId}/scan-schedules` : `/api/v1/libraries/${libraryId}/scan-schedules`,
  );
  return result.schedules;
}

/** 保存媒体库一种后台任务的定时计划。 */
export async function updateLibraryScanSchedule(
  libraryId: string,
  scanMode: "incremental" | "full" | "media_probe",
  input: UpdateScanScheduleInput,
  admin = false,
): Promise<ScanSchedule> {
  const result = await requestJson<{ schedule: ScanSchedule }>(
    admin
      ? `/api/v1/admin/libraries/${libraryId}/scan-schedules/${scanMode}`
      : `/api/v1/libraries/${libraryId}/scan-schedules/${scanMode}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.schedule;
}

/** 为失败或已取消任务创建一条保留原扫描模式的新任务。 */
export async function retryScanJob(jobId: string, admin = false, musicStage?: string): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/retry` : `/api/v1/scan-jobs/${jobId}/retry`,
    {
      method: "POST",
      body: JSON.stringify({ musicStage,
        requestId: createRequestId(),
        clientDeviceId: "flycloud-helper-web",
      }),
    },
  );
  return result.job;
}

/** 请求终止排队中、运行中或已暂停的扫描任务。 */
export async function cancelScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/cancel` : `/api/v1/scan-jobs/${jobId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 请求在安全检查点暂停排队中或运行中的扫描任务。 */
export async function pauseScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/pause` : `/api/v1/scan-jobs/${jobId}/pause`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 继续已暂停任务；服务端复用原扫描会话和目录检查点。 */
export async function resumeScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/resume` : `/api/v1/scan-jobs/${jobId}/resume`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 删除已经结束的扫描任务记录。 */
export async function deleteScanJob(jobId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/jobs/${jobId}` : `/api/v1/scan-jobs/${jobId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: jobId }),
  });
}

/** 清除当前用户或管理范围内的全部已完成和失败后台任务。 */
export async function clearCompletedAndFailedScanJobs(admin = false): Promise<number> {
  const result = await requestJson<{ deletedCount: number }>(
    admin ? "/api/v1/admin/jobs/completed" : "/api/v1/scan-jobs/completed",
    { method: "DELETE", body: JSON.stringify({ confirmation: "completed", includeFailed: true }) },
  );
  return result.deletedCount;
}

/** 下载任务级扫描或 AI 补充失败报告，并使用服务端文件名保存到本地。 */
export async function downloadScanFailureReport(jobId: string, admin = false): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      admin ? `/api/v1/admin/jobs/${jobId}/failure-report` : `/api/v1/scan-jobs/${jobId}/failure-report`,
      { credentials: "include" },
    );
  } catch {
    throw new ApiClientError(0, "network_error", "无法连接 FlyCloudHelper API");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? "scan_failure_report_download_failed",
      payload.error?.message ?? "扫描失败报告下载失败",
    );
  }

  const contentDisposition = response.headers.get("Content-Disposition") ?? "";
  // 关键变量：接口文件名只包含任务 ID；解析失败时仍使用可识别的本地文件名。
  const fileName = contentDisposition.match(/filename="?([^";]+)"?/iu)?.[1]
    ?? `scan-failures-${jobId}.jsonl`;
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 浏览器需要在点击事件结束后继续读取 Blob URL，延迟释放可避免部分环境没有实际触发下载。
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

/** 读取当前任务 AI 补充查询词的总数和最近 20 条采用记录。 */
export function getJobAiSupplements(jobId: string, admin = false): Promise<JobAiSupplementResult> {
  return requestJson(
    admin
      ? `/api/v1/admin/jobs/${encodeURIComponent(jobId)}/ai-supplements`
      : `/api/v1/scan-jobs/${encodeURIComponent(jobId)}/ai-supplements`,
  );
}

/** 创建一次只读取媒体库未匹配记录、并强制刷新 AI 结果的后台任务。 */
export async function createManualAiSupplementJob(libraryId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin
      ? `/api/v1/admin/libraries/${encodeURIComponent(libraryId)}/ai-supplements/retry`
      : `/api/v1/libraries/${encodeURIComponent(libraryId)}/ai-supplements/retry`,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: createRequestId(),
        clientDeviceId: "flycloud-helper-web",
      }),
    },
  );
  return result.job;
}

/** 清空单个服务的扫描与刮削结果，保留服务连接和配置。 */
export function clearServiceCatalog(
  serviceId: string,
  admin = false,
): Promise<{ mediaItemCount: number; sourceFileCount: number }> {
  return requestJson(admin ? `/api/v1/admin/libraries/${serviceId}/catalog` : `/api/v1/libraries/${serviceId}/catalog`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: serviceId }),
  });
}

/** 删除单个云端服务，并由服务端同时解除 APP 服务关联。 */
export function deleteCloudService(serviceId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}` : `/api/v1/services/${serviceId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: serviceId }),
  });
}

/** 用完整新凭据替换服务连接；Secret 不从服务端回显。 */
export async function updateServiceConnection(
  serviceId: string,
  connection: Record<string, string>,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/connection` : `/api/v1/services/${serviceId}/connection`,
    { method: "PUT", body: JSON.stringify({ connection }) },
  );
  return result.service;
}

/** 使用服务端当前保存的连接配置重新验证并恢复连接状态。 */
export async function reconnectServiceConnection(
  serviceId: string,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/connection/reconnect`
      : `/api/v1/services/${serviceId}/connection/reconnect`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.service;
}

export interface BaiduWebLoginStatus {
  state: "waiting" | "authorized" | "failed";
  message: string;
  imageDataUrl: string | null;
}

/** 百度补充网页登录只更新已有服务的加密连接，不替换 OAuth。 */
function baiduWebLoginPath(serviceId: string, admin: boolean): string {
  return `${admin ? "/api/v1/admin" : "/api/v1"}/services/${encodeURIComponent(serviceId)}/baidu-web-login`;
}

/** 读取百度补充网页登录是否已配置，永不返回 Cookie。 */
export function getBaiduWebLoginConfiguration(serviceId: string, admin = false): Promise<{ configured: boolean }> {
  return requestJson<{ configured: boolean }>(baiduWebLoginPath(serviceId, admin));
}

/** 启动云助手独立的百度官网扫码会话。 */
export function startBaiduWebLogin(serviceId: string, admin = false): Promise<{ sessionId: string; expiresAt: number }> {
  return requestJson<{ sessionId: string; expiresAt: number }>(`${baiduWebLoginPath(serviceId, admin)}/sessions`, { method: "POST" });
}

/** 读取扫码页面截图和状态，不包含浏览器 Cookie。 */
export function getBaiduWebLoginStatus(serviceId: string, sessionId: string, admin = false): Promise<BaiduWebLoginStatus> {
  return requestJson<BaiduWebLoginStatus>(`${baiduWebLoginPath(serviceId, admin)}/sessions/${encodeURIComponent(sessionId)}`);
}

/** 用户关闭页面时释放服务端浏览器会话。 */
export function cancelBaiduWebLogin(serviceId: string, sessionId: string, admin = false): Promise<{ cancelled: boolean }> {
  return requestJson<{ cancelled: boolean }>(`${baiduWebLoginPath(serviceId, admin)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/** 清除补充网页登录凭据，保留原百度网盘 OAuth 连接。 */
export function clearBaiduWebLogin(serviceId: string, admin = false): Promise<{ configured: boolean }> {
  return requestJson<{ configured: boolean }>(baiduWebLoginPath(serviceId, admin), { method: "DELETE" });
}

/** 保存新的扫描配置修订。 */
export async function updateServiceScanProfile(
  serviceId: string,
  scan: Record<string, unknown>,
  admin = false,
  updateScope: "paths" | "profile" = "profile",
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/scan-profile` : `/api/v1/libraries/${serviceId}/scan-profile`,
    { method: "PUT", body: JSON.stringify({ scan, updateScope }) },
  );
  return result.service;
}

/** 保存新的元数据配置修订。 */
export async function updateServiceMetadataProfile(
  serviceId: string,
  metadata: Record<string, unknown>,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/metadata-profile` : `/api/v1/libraries/${serviceId}/metadata-profile`,
    { method: "PUT", body: JSON.stringify({ metadata }) },
  );
  return result.service;
}

/** 手动为已有但缺少规格的视频创建独立后台任务。 */
export function backfillExistingMediaProbes(
  serviceId: string,
  admin = false,
): Promise<{ job: ScanJob | null; queuedCount: number }> {
  return requestJson(
    admin
      ? `/api/v1/admin/libraries/${serviceId}/media-probes/backfill`
      : `/api/v1/libraries/${serviceId}/media-probes/backfill`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** 启用或停用云端服务。 */
export async function updateServiceStatus(
  serviceId: string,
  status: "active" | "disabled",
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/status` : `/api/v1/services/${serviceId}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
  return result.service;
}

/** 开启或关闭单个服务的后台任务完成通知。 */
export async function updateServiceNotificationSettings(
  serviceId: string,
  notificationEnabled: boolean,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/libraries/${serviceId}/notification-settings`
      : `/api/v1/libraries/${serviceId}/notification-settings`,
    { method: "PATCH", body: JSON.stringify({ notificationEnabled }) },
  );
  return result.service;
}

/** 兼容旧版 APP：开启或关闭单个媒体库的 APP 专用中转播放。 */
export async function updateServiceRelayPlayback(
  serviceId: string,
  relayPlaybackEnabled: boolean,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/playback-settings`
      : `/api/v1/services/${serviceId}/playback-settings`,
    { method: "PATCH", body: JSON.stringify({ relayPlaybackEnabled }) },
  );
  return result.service;
}

/** 读取当前服务的协议账号和 Jellyfin 地址。 */
export async function getServiceAccessSettings(serviceId: string, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/libraries/${serviceId}/access-account` : `/api/v1/libraries/${serviceId}/access-account`);
  return result.settings;
}

/** 修改服务协议用户名或密码。 */
export async function updateServiceAccessCredentials(serviceId: string, input: { username?: string; password?: string }, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/libraries/${serviceId}/access-account` : `/api/v1/libraries/${serviceId}/access-account`, { method: "PATCH", body: JSON.stringify(input) });
  return result.settings;
}

/** 为当前媒体库的同一个 Jellyfin 地址新增登录账号。 */
export async function createServiceAccessAccount(
  serviceId: string,
  input: { username: string; password?: string },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/access-accounts` : `/api/v1/libraries/${serviceId}/access-accounts`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 修改、启用或停用指定 Jellyfin 账号。 */
export async function updateServiceAccessAccount(
  serviceId: string,
  accountId: string,
  input: { username?: string; password?: string; status?: "active" | "disabled" },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/access-accounts/${accountId}` : `/api/v1/libraries/${serviceId}/access-accounts/${accountId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 删除指定 Jellyfin 账号及其独立观看记录。 */
export function deleteServiceAccessAccount(serviceId: string, accountId: string, admin = false): Promise<void> {
  return requestJson(
    admin ? `/api/v1/admin/libraries/${serviceId}/access-accounts/${accountId}` : `/api/v1/libraries/${serviceId}/access-accounts/${accountId}`,
    { method: "DELETE", body: JSON.stringify({ confirmation: accountId }) },
  );
}

/** 仅撤销指定 Jellyfin 账号的全部登录会话。 */
export function revokeServiceAccessAccountSessions(serviceId: string, accountId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(
    admin ? `/api/v1/admin/libraries/${serviceId}/access-accounts/${accountId}/revoke-sessions` : `/api/v1/libraries/${serviceId}/access-accounts/${accountId}/revoke-sessions`,
    { method: "POST", body: "{}" },
  );
}

/** 重置服务协议密码，明文只在本次响应返回。 */
export function resetServiceAccessPassword(serviceId: string, admin = false): Promise<{ settings: ServiceAccessSettings; password: string }> {
  return requestJson(admin ? `/api/v1/admin/libraries/${serviceId}/access-account/reset-password` : `/api/v1/libraries/${serviceId}/access-account/reset-password`, { method: "POST", body: "{}" });
}

/** 撤销当前服务的全部 Jellyfin/Emby 兼容会话。 */
export function revokeServiceAccessSessions(serviceId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(admin ? `/api/v1/admin/libraries/${serviceId}/access-account/revoke-sessions` : `/api/v1/libraries/${serviceId}/access-account/revoke-sessions`, { method: "POST", body: "{}" });
}

/** 修改单个媒体库的 Jellyfin 开关、自定义地址后缀、下载权限或节目地区分组。 */
export async function updateServiceJellyfinSettings(
  serviceId: string,
  input: {
    jellyfinEnabled?: boolean;
    jellyfinPathSuffix?: string;
    jellyfinDownloadEnabled?: boolean;
    jellyfinRegionLibrariesEnabled?: boolean;
    jellyfinCollageCoverEnabled?: boolean;
  },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/libraries/${serviceId}/jellyfin-settings` : `/api/v1/libraries/${serviceId}/jellyfin-settings`, { method: "PATCH", body: JSON.stringify(input) });
  return result.settings;
}

/** 修改单个媒体库的独立 Emby 开关、地址、下载权限或节目地区分组。 */
export async function updateServiceEmbySettings(
  serviceId: string,
  input: {
    embyEnabled?: boolean;
    embyPathSuffix?: string;
    embyDownloadEnabled?: boolean;
    embyRegionLibrariesEnabled?: boolean;
    embyCollageCoverEnabled?: boolean;
  },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/emby-settings` : `/api/v1/libraries/${serviceId}/emby-settings`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 创建独立 Emby 协议账号；不会创建或修改 Jellyfin 账号。 */
export async function createServiceEmbyAccount(serviceId: string, input: { username: string; password: string }, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/emby-access-accounts` : `/api/v1/libraries/${serviceId}/emby-access-accounts`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 修改独立 Emby 账号凭据或状态。 */
export async function updateServiceEmbyAccount(serviceId: string, accountId: string, input: { username?: string; password?: string; status?: "active" | "disabled" }, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/emby-access-accounts/${accountId}` : `/api/v1/libraries/${serviceId}/emby-access-accounts/${accountId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 删除独立 Emby 账号及其 Emby 用户状态。 */
export function deleteServiceEmbyAccount(serviceId: string, accountId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/libraries/${serviceId}/emby-access-accounts/${accountId}` : `/api/v1/libraries/${serviceId}/emby-access-accounts/${accountId}`, { method: "DELETE", body: JSON.stringify({ confirmation: accountId }) });
}

/** 撤销一个 Emby 账号的全部 Emby 会话，不影响 Jellyfin 登录会话。 */
export function revokeServiceEmbyAccountSessions(serviceId: string, accountId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(
    admin ? `/api/v1/admin/libraries/${serviceId}/emby-access-accounts/${accountId}/revoke-sessions` : `/api/v1/libraries/${serviceId}/emby-access-accounts/${accountId}/revoke-sessions`,
    { method: "POST", body: "{}" },
  );
}

/** 开启或关闭音乐媒体库的 Navidrome/Subsonic 公开协议。 */
export async function updateServiceNavidromeSettings(
  serviceId: string,
  input: { navidromeEnabled?: boolean; navidromePathSuffix?: string; navidromeRelayPlaybackEnabled?: boolean },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/libraries/${serviceId}/navidrome-settings` : `/api/v1/libraries/${serviceId}/navidrome-settings`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 分别修改媒体库的 APP 专用中转与 Jellyfin 中转开关。 */
export async function updateLibraryPlaybackSettings(
  serviceId: string,
  input: { jellyfinRelayPlaybackEnabled?: boolean; embyRelayPlaybackEnabled?: boolean },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin
      ? `/api/v1/admin/libraries/${serviceId}/library-playback-settings`
      : `/api/v1/libraries/${serviceId}/library-playback-settings`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 后台任务列表支持的服务端筛选条件。 */
export interface JobListFilters {
  /** active 同时表示排队、运行、等待恢复和暂停。 */
  status?: JobStatus | "active";
  jobType?: "scan" | "media_probe";
  /** 以云聚合父任务作为分页单位，并返回该组全部来源子任务。 */
  groupParentJobs?: boolean;
  limit?: number;
  offset?: number;
}

/** 读取用户或管理员作用域后台任务，并由服务端完成状态和类型筛选。 */
export function listJobs(admin = false, filters: JobListFilters = {}): Promise<{ items: ScanJob[]; total: number }> {
  const query = new URLSearchParams({
    limit: String(filters.limit ?? 200),
    offset: String(filters.offset ?? 0),
  });
  if (filters.status) query.set("status", filters.status);
  if (filters.jobType) query.set("jobType", filters.jobType);
  if (filters.groupParentJobs) query.set("groupParentJobs", "true");
  return requestJson(`${admin ? "/api/v1/admin/jobs" : "/api/v1/scan-jobs"}?${query.toString()}`);
}

/** 读取视频规格后台任务最终失败的文件列表。 */
export function listMediaProbeJobFailures(jobId: string, admin = false): Promise<{ items: MediaProbeFailure[] }> {
  return requestJson(admin
    ? `/api/v1/admin/jobs/${jobId}/media-probe-failures`
    : `/api/v1/scan-jobs/${jobId}/media-probe-failures`);
}

/** 读取单个媒体库的海报墙条目。 */
export function listLibraryItems(
  libraryId: string,
  options: {
    search?: string;
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    sort?: CatalogSort;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: MediaItem[]; total: number; catalogVersion: number }> {
  return requestJson(withQuery(`/api/v1/libraries/${libraryId}/items`, {
    search: options.search,
    mediaType: options.mediaType,
    itemType: options.itemType,
    matchState: options.matchState,
    sort: options.sort,
    limit: options.limit ?? 200,
    offset: options.offset ?? 0,
  }));
}

/** 读取管理端指定媒体库的海报墙条目，云聚合库不再被第一个来源限制。 */
export function listAdminLibraryItems(
  libraryId: string,
  options: {
    search?: string;
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    sort?: CatalogSort;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: MediaItem[]; total: number }> {
  return requestJson(withQuery("/api/v1/admin/catalog/items", {
    libraryId,
    search: options.search,
    mediaType: options.mediaType,
    itemType: options.itemType,
    matchState: options.matchState,
    sort: options.sort,
    limit: options.limit ?? 200,
    offset: options.offset ?? 0,
  }));
}

/** 读取普通用户或管理员作用域的单个媒体详情。 */
export async function getMediaItem(item: Pick<MediaItem, "id" | "libraryId">, admin = false): Promise<MediaItem> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}`;
  return (await requestJson<{ item: MediaItem }>(path)).item;
}

/** 读取节目、专辑或有声书作品下的子项，不返回播放定位。 */
export async function listMediaItemChildren(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem[]> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}/children`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}/children`;
  return (await requestJson<{ items: MediaItem[] }>(path)).items;
}

/** 读取音乐专辑或歌曲关联的艺术家，不返回播放定位。 */
export async function listMediaItemArtists(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem[]> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}/artists`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}/artists`;
  return (await requestJson<{ items: MediaItem[] }>(path)).items;
}

/** 构造普通用户或管理员作用域下的媒体条目 API 根路径。 */
function getMediaItemApiPath(item: Pick<MediaItem, "id" | "libraryId">, admin: boolean): string {
  return admin
    ? `/api/v1/admin/catalog/items/${item.id}`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}`;
}

/** 读取媒体条目及其子项关联的只读网盘路径，不读取播放定位。 */
export async function listMediaItemPaths(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaPathItem[]> {
  return (await requestJson<{ items: MediaPathItem[] }>(`${getMediaItemApiPath(item, admin)}/paths`)).items;
}

/** 使用系统 TMDB 配置搜索电影或节目候选。 */
export async function searchManualVideoMatches(
  item: Pick<MediaItem, "id" | "libraryId">,
  input: { query: string; mediaType: ManualVideoMatchType; year?: number | null },
  admin = false,
): Promise<ManualVideoMatchCandidate[]> {
  const path = withQuery(`${getMediaItemApiPath(item, admin)}/manual-match/search`, {
    query: input.query,
    mediaType: input.mediaType,
    year: input.year ?? undefined,
  });
  return (await requestJson<{ items: ManualVideoMatchCandidate[] }>(path)).items;
}

/** 提交用户选中的 TMDB 条目并返回更新后的媒体详情。 */
export async function applyManualVideoMatch(
  item: Pick<MediaItem, "id" | "libraryId">,
  input: { mediaType: ManualVideoMatchType; tmdbId: number },
  admin = false,
): Promise<MediaItem> {
  return (await requestJson<{ item: MediaItem }>(`${getMediaItemApiPath(item, admin)}/manual-match`, {
    method: "POST",
    body: JSON.stringify(input),
  })).item;
}

/** 清除当前媒体条目的外部匹配结果。 */
export async function clearMediaItemMatch(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem> {
  return (await requestJson<{ item: MediaItem }>(`${getMediaItemApiPath(item, admin)}/manual-match/clear`, {
    method: "POST",
    body: "{}",
  })).item;
}

/** 读取管理后台用户列表。 */
export async function listAdminUsers(): Promise<{ items: AdminUser[]; total: number }> {
  const result = await requestJson<{
    items: Array<Omit<AdminUser, "userId"> & { id: string }>;
    total: number;
  }>("/api/v1/admin/users?limit=200");
  return {
    total: result.total,
    items: result.items.map(({ id, ...user }) => ({ ...user, userId: id })),
  };
}

/** 创建一个普通用户。 */
export async function createAdminUser(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthUser> {
  return (await requestJson<{ user: AuthUser }>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  })).user;
}

/** 启用或停用指定用户。 */
export async function updateAdminUserStatus(userId: string, status: "active" | "disabled"): Promise<AuthUser> {
  return (await requestJson<{ user: AuthUser }>(`/api/v1/admin/users/${userId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })).user;
}

/** 将指定的其他用户标记为待删除，并立即撤销其全部会话。 */
export async function deleteAdminUser(userId: string): Promise<void> {
  await requestJson<{ status: "pending_delete" }>(`/api/v1/admin/users/${userId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: userId }),
  });
}

/** 彻底删除一个已经进入待删除状态的其他用户。 */
export async function purgeAdminUser(userId: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/users/${userId}/purge`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: userId }),
  });
}

/** 撤销指定用户的全部 Web 和 APP 会话。 */
export async function revokeAdminUserSessions(userId: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/users/${userId}/sessions/revoke`, { method: "POST", body: "{}" });
}

/** 读取管理后台运行摘要。 */
export function getAdminStatus(): Promise<AdminRuntimeStatus> {
  return requestJson("/api/v1/admin/status");
}

/** 读取管理后台脱敏配置状态。 */
export function getAdminConfigStatus(): Promise<AdminConfigStatus> {
  return requestJson("/api/v1/admin/config/status");
}

/** 读取系统级外部通知渠道的脱敏设置。 */
export function getAdminNotificationSettings(): Promise<AdminNotificationSettings> {
  return requestJson("/api/v1/admin/notification-settings");
}

/** 保存通知项目开关，不修改 Telegram Bot 和发送目标。 */
export async function updateAdminNotificationEvents(input: Omit<NotificationEventSettings, "configurationRevision">): Promise<NotificationEventSettings> {
  const result = await requestJson<{ events: NotificationEventSettings }>("/api/v1/admin/notification-settings/events", {
    method: "PUT", body: JSON.stringify(input),
  });
  return result.events;
}

/** 保存 Telegram 通知渠道；Bot Token 留空时保留服务端已有值。 */
export async function updateAdminTelegramNotificationSettings(input: {
  enabled: boolean;
  botToken: string;
  chatId: string;
  telegramUserId: string;
}): Promise<TelegramNotificationSettings> {
  const result = await requestJson<{ telegram: TelegramNotificationSettings }>(
    "/api/v1/admin/notification-settings/telegram",
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.telegram;
}

/** 使用已经保存并启用的 Telegram 配置发送测试通知。 */
export async function testAdminTelegramNotification(input: {
  botToken: string;
  chatId: string;
  telegramUserId: string;
}): Promise<void> {
  await requestJson<{ sent: true }>("/api/v1/admin/notification-settings/telegram/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 读取系统级音乐刮削来源配置。 */
export async function getAdminMusicSourceSettings(): Promise<AdminMusicSourceSettings> {
  const result = await requestJson<{ musicSources: AdminMusicSourceSettings }>("/api/v1/admin/config/music-sources");
  return result.musicSources;
}

/** 保存系统级音乐刮削来源配置。 */
export async function updateAdminMusicSourceSettings(
  enabledSources: BuiltinMusicSourceId[],
): Promise<AdminMusicSourceSettings> {
  const result = await requestJson<{ musicSources: AdminMusicSourceSettings }>("/api/v1/admin/config/music-sources", {
    method: "PUT",
    body: JSON.stringify({ enabledSources }),
  });
  return result.musicSources;
}

/** 读取全部 AI 模型配置，响应不包含 API Key 原文。 */
export function listAdminAiModels(): Promise<{ items: AiModel[]; total: number }> {
  return requestJson("/api/v1/admin/ai-models");
}

/** 读取服务可选择的启用模型，并保留当前已选停用模型用于回显。 */
export function listAvailableAiModels(libraryId: string): Promise<{ items: AvailableAiModel[]; total: number }> {
  return requestJson(`/api/v1/ai-models/available?libraryId=${encodeURIComponent(libraryId)}`);
}

/** 创建 AI 模型和第一份配置修订。 */
export async function createAdminAiModel(input: SaveAiModelInput): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>("/api/v1/admin/ai-models", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.model;
}

/** 保存 AI 模型的新配置修订；空 API Key 由服务端解释为保留旧值。 */
export async function updateAdminAiModel(modelId: string, input: SaveAiModelInput): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>(`/api/v1/admin/ai-models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return result.model;
}

/** 启用或停用 AI 模型。 */
export async function updateAdminAiModelStatus(modelId: string, status: AiModelStatus): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>(
    `/api/v1/admin/ai-models/${encodeURIComponent(modelId)}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
  return result.model;
}

/** 删除未被媒体库、整理计划或未完成扫描任务使用的 AI 模型。 */
export async function deleteAdminAiModel(modelId: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/ai-models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

/** 使用模型当前配置执行真实对话与 JSON 结构化输出测试。 */
export async function testAdminAiModel(modelId: string): Promise<{
  result: AiModelAvailabilityResult;
  model: AiModel;
}> {
  return requestJson(`/api/v1/admin/ai-models/${encodeURIComponent(modelId)}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** 用系统配置中的完整新列表替换 TMDB Key 池，Key 原文不会回显。 */
export async function updateAdminTmdbKeys(keys: string[]): Promise<AdminConfigStatus["tmdb"]> {
  const result = await requestJson<{ tmdb: AdminConfigStatus["tmdb"] }>("/api/v1/admin/config/tmdb-keys", {
    method: "PUT",
    body: JSON.stringify({ keys }),
  });
  return result.tmdb;
}

/** 保存 TMDB API 与图片代理地址；两个地址留空时恢复默认值。 */
export async function updateAdminTmdbBaseUrls(
  apiBaseUrl: string,
  imageBaseUrl: string,
): Promise<AdminConfigStatus["tmdb"]> {
  const result = await requestJson<{ tmdb: AdminConfigStatus["tmdb"] }>("/api/v1/admin/config/tmdb-base-urls", {
    method: "PUT",
    body: JSON.stringify({ apiBaseUrl, imageBaseUrl }),
  });
  return result.tmdb;
}

/** 保存实例对外公开根地址；环境变量配置时服务端会拒绝修改。 */
export async function updateAdminPublicBaseUrl(publicBaseUrl: string): Promise<AdminConfigStatus["publicAccess"]> {
  const result = await requestJson<{ publicAccess: AdminConfigStatus["publicAccess"] }>("/api/v1/admin/config/public-access", { method: "PUT", body: JSON.stringify({ publicBaseUrl }) });
  return result.publicAccess;
}

/** 清空数据库、待写入队列和进程内的部署级 TMDB 共享缓存。 */
export function clearAdminTmdbCache(): Promise<{
  deletedCount: number;
  discardedPendingCount: number;
  clearedMemoryCount: number;
}> {
  return requestJson("/api/v1/admin/config/tmdb-cache", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "tmdb-cache" }),
  });
}

/** 读取已安装的声明式插件版本。 */
export function listPlugins(): Promise<{ items: PluginVersion[]; total: number }> {
  return requestJson("/api/v1/admin/plugins?limit=200");
}

/** 导入声明式插件包。 */
export async function importPlugin(file: File): Promise<PluginVersion> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/v1/admin/plugins/import", { method: "POST", body: form, credentials: "include" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(response.status, payload.error?.code ?? "request_failed", payload.error?.message ?? "插件导入失败");
  }
  return (await response.json() as { plugin: PluginVersion }).plugin;
}

/** 启用或停用一个插件版本。 */
export async function updatePluginStatus(plugin: PluginVersion, enabled: boolean): Promise<PluginVersion> {
  const result = await requestJson<{ plugin: PluginVersion }>(
    `/api/v1/admin/plugins/${encodeURIComponent(plugin.pluginId)}/versions/${encodeURIComponent(plugin.version)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", body: "{}" },
  );
  return result.plugin;
}

/** 读取脱敏审计记录。 */
export function listAuditEntries(): Promise<{ items: AuditEntry[]; total: number }> {
  return requestJson("/api/v1/admin/audit-logs?limit=200");
}

/** 查询实例首次初始化状态。 */
export async function getSetupStatus(): Promise<{
  setupRequired: boolean;
  credentialKeyBackupRequired: boolean;
}> {
  return requestJson("/api/v1/setup/status");
}

/** 原子创建首个超级管理员并建立 Web 会话。 */
export async function initializeSuperAdmin(input: {
  username: string;
  password: string;
  passwordConfirmation: string;
}): Promise<InitializeSuperAdminResult> {
  return requestJson<InitializeSuperAdminResult>("/api/v1/setup/super-admin", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 读取尚未确认备份的自动生成凭据主密钥。 */
export async function getCredentialKeyBackup(): Promise<CredentialKeyBackup> {
  return requestJson("/api/v1/setup/credential-key-backup");
}

/** 确认管理员已经把凭据主密钥保存到数据库之外。 */
export async function acknowledgeCredentialKeyBackup(): Promise<void> {
  await requestJson<void>("/api/v1/setup/credential-key-backup/acknowledge", {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  });
}

/** 使用用户名和密码登录。 */
export async function login(input: { username: string; password: string }): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.user;
}

/** 公开注册普通用户并建立 Web 会话。 */
export async function register(input: {
  username: string;
  password: string;
  passwordConfirmation: string;
}): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.user;
}

/** 查询当前 Web 会话用户。 */
export async function getCurrentUser(): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/me");
  return result.user;
}

/** 读取当前登录账号最近的通知。 */
export async function listNotifications(limit = 30): Promise<ConsoleNotification[]> {
  const result = await requestJson<{ notifications: ConsoleNotification[] }>(`/api/v1/notifications?limit=${limit}`);
  return result.notifications;
}

/** 清除当前账号的一条通知。 */
export async function deleteNotification(notificationId: string): Promise<void> {
  await requestJson<void>(`/api/v1/notifications/${notificationId}`, { method: "DELETE" });
}

/** 清除当前账号的全部通知。 */
export async function clearNotifications(): Promise<number> {
  const result = await requestJson<{ deletedCount: number }>("/api/v1/notifications", { method: "DELETE" });
  return result.deletedCount;
}

/** 撤销当前 Web 会话。 */
export async function logout(): Promise<void> {
  await requestJson<void>("/api/v1/auth/logout", { method: "POST" });
}

export interface MusicStageTask {
  id: string; stage: string; status: string; path: string; name: string; resourceId: string; error: string;
}

/** 分页读取当前用户或管理员有权查看的音乐阶段明细。 */
export function listMusicStageTasks(jobId: string, stage: string, offset: number, admin = false): Promise<{ items: MusicStageTask[]; total: number }> {
  const query = new URLSearchParams({ stage, offset: String(offset), limit: "20", status: "problems" });
  return requestJson(`${admin ? "/api/v1/admin/jobs" : "/api/v1/scan-jobs"}/${encodeURIComponent(jobId)}/music-tasks?${query}`);
}
