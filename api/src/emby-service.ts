import { readVideoSeason, videoSeasonTitle, encodeVideoSeasonNumber, decodeVideoSeasonNumber } from "./media/video-season.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hashSessionToken } from "./auth.js";
import { parseJsonObject, type CatalogSort, type MediaItemRecord, type VideoRegionGroup } from "./domain.js";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";
import { hydrateRealtimeVideoDetails } from "./media/realtime-video-details.js";
import { getProtocolUserImageTag } from "./media/protocol-user-image.js";
import { prepareNextEpisodeResume } from "./media/episode-resume.js";
import { contentPlaybackServerRoot, isContentSourceLibrary, mapContentMediaSource, prepareContentPlaybackSources, prioritizeContentSources, readContentRunTimeTicks } from "./content-sources/playback.js";
import { readProtocolItemIdentityFilter, matchesProtocolItemIdentity, resolveProtocolItemIdentityIds } from "./media/protocol-item-identity-filter.js";
import { matchesContentFilterDto, readContentFilterNames, readProtocolContentFilters } from "./media/protocol-content-filters.js";
import { parseCompletedMediaProbeResult, readJellyfinRunTimeTicks, type MediaProbeResult } from "./media/media-probe.js";
import { JellyfinCatalogSort, type JellyfinSortFilters, type JellyfinSortPlan } from "./jellyfin-catalog-sort.js";
import type { ContentSourceCategoryDefinition } from "./content-sources/types.js";
import { matchesJellyfinSourceCategory, readJellyfinSourceCategoryId } from "./jellyfin-source-category.js";

/** Emby 媒体库读取使用的服务范围；与 Jellyfin 的账号和用户状态完全隔离。 */
export interface EmbyLibraryContext {
  serviceId: string;
  ownerUserId: string;
  libraryId: string;
  libraryKind: string;
  /** 是否按媒体地区返回 Emby 虚拟媒体库。 */
  regionLibrariesEnabled: boolean;
  /** 在线库源分类快照；普通网盘不读取内容源配置。 */
  sourceCategoryDefinitions?: ContentSourceCategoryDefinition[];
}

/** 已完成 Emby 会话认证后的上下文。 */
export interface EmbyContext extends EmbyLibraryContext {
  accountId: string;
  accountUsername: string;
  accountHasPassword: boolean;
  credentialRevision: number;
  accessToken: string;
  /** 当前请求实际使用的协议根地址，避免在线来源详情 Path 丢失 /e 前缀。 */
  contentServerRoot?: string;
  downloadEnabled: boolean;
}

interface EmbyFileSummary {
  fileId: string;
  name: string;
  size: number;
  mediaProbe: MediaProbeResult | null;
}

interface EmbyLibraryDefinition {
  internalId: string;
  id: string;
  name: string;
  collectionType?: "movies" | "tvshows";
  itemType?: "video.movie" | "video.series";
  regionGroup?: VideoRegionGroup;
  /** 精确源分类 ID；null 仅表示历史未分类。 */
  sourceCategoryId?: string | null;
}

interface EmbyPersonSummary {
  id: string;
  name: string;
  profileUrl: string;
  imageTag: string;
  itemIds: Set<string>;
}

interface EmbyPersonCache {
  catalogVersion: number;
  peopleById: Map<string, EmbyPersonSummary>;
}

interface EmbyAccessAccount {
  id: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
}

/** emby-access.ts 的最小调用约束，避免协议层依赖管理端 DTO。 */
interface EmbyAccessServiceLike {
  authenticate(serviceId: string, username: unknown, password: unknown): Promise<EmbyAccessAccount>;
}

const ITEM_UUID_PREFIX = "f10c0000";
const SEASON_UUID_PREFIX = "f2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INTERNAL_ITEM_ID_PATTERN = /^itm_([0-9a-f]{24})$/iu;
/** 单次写入 Emby 用户状态的最大条目数，避免长剧集超过数据库参数上限。 */
const EMBY_USER_STATE_BATCH_SIZE = 50;

/** 格式化为 Emby SDK 可解析的标准 UUID。 */
function formatUuid(value: string): string {
  const hex = value.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 为虚拟库、季和人物生成稳定 UUID；Emby 与 Jellyfin 共用媒体 ID 编码但不共用状态数据。 */
function protocolUuid(scope: string, value: string): string {
  const digest = createHash("sha256").update(`flycloud-jellyfin\u0000${scope}\u0000${value}`, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return formatUuid(digest.toString("hex").slice(0, 32));
}

/** 内部媒体 ID 与既有 Jellyfin 保持同一可逆 UUID，方便客户端跨协议识别同一目录实体。 */
function encodeItemId(itemId: string): string {
  if (UUID_PATTERN.test(itemId)) return itemId.toLowerCase();
  const match = INTERNAL_ITEM_ID_PATTERN.exec(itemId);
  return match?.[1] ? formatUuid(`${ITEM_UUID_PREFIX}${match[1]}`) : protocolUuid("item", itemId);
}

/** 将协议 ID 还原为内部媒体 ID，同时保留旧客户端传入 itm_ ID 的兼容性。 */
function decodeItemId(itemId: string): string {
  const normalized = itemId.trim().toLowerCase();
  if (INTERNAL_ITEM_ID_PATTERN.test(normalized)) return normalized;
  const compact = normalized.replace(/-/gu, "");
  if (compact.length === 32 && compact.startsWith(ITEM_UUID_PREFIX)) return `itm_${compact.slice(ITEM_UUID_PREFIX.length)}`;
  return itemId;
}

/** 将节目和季号转换成无须新建媒体实体的虚拟 UUID。 */
function encodeSeasonId(seriesId: string, seasonNumber: number): string {
  const match = INTERNAL_ITEM_ID_PATTERN.exec(seriesId);
  if (!match?.[1]) return protocolUuid("season", `${seriesId}:${seasonNumber}`);
  const normalizedSeason = encodeVideoSeasonNumber(seasonNumber);
  return formatUuid(`${SEASON_UUID_PREFIX}${normalizedSeason.toString(16).padStart(6, "0")}${match[1]}`);
}

/** 解析 Emby 虚拟季 ID。 */
function decodeSeasonId(value: string): { seriesId: string; seasonNumber: number } | null {
  const compact = value.trim().toLowerCase().replace(/-/gu, "");
  if (!/^f2[0-9a-f]{30}$/u.test(compact)) return null;
  return { seriesId: `itm_${compact.slice(8)}`, seasonNumber: decodeVideoSeasonNumber(Number.parseInt(compact.slice(2, 8), 16)) };
}

/** 读取 Emby/MediaBrowser 兼容认证令牌。 */
export function readEmbyToken(request: FastifyRequest): string {
  const direct = request.headers["x-emby-token"] ?? request.headers["x-mediabrowser-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const query = request.query as Record<string, unknown> | undefined;
  const queryToken = query?.api_key ?? query?.ApiKey ?? query?.access_token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  const authorization = request.headers.authorization
    ?? request.headers["x-emby-authorization"]
    ?? request.headers["x-mediabrowser-authorization"]
    ?? "";
  // 关键变量：部分 Emby 客户端只在 X-Emby-Authorization 中携带 Token，不应误判为未登录。
  return (typeof authorization === "string" ? authorization : "")
    .match(/(?:Token|token)\s*=\s*"?([^",\s]+)"?/u)?.[1]?.trim() ?? "";
}

/** 从 Emby Authorization 头读取客户端设备字段。 */
function authorizationAttribute(request: FastifyRequest, key: string): string | null {
  const source = request.headers["x-emby-authorization"] ?? request.headers["x-mediabrowser-authorization"] ?? request.headers.authorization ?? "";
  const header = typeof source === "string" ? source : "";
  const match = header.match(new RegExp(`${key}=(?:"([^"]*)"|([^,\\s]*))`, "iu"));
  return (match?.[1] ?? match?.[2])?.slice(0, 255) ?? null;
}

/** 输出协议图片字段所需的稳定 ETag。 */
function imageTag(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex").slice(0, 32);
}

/** 转换外部媒体库 ID 为 Emby 通用 ProviderIds 键。 */
function mapProviderIds(providerIds: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(providerIds).map(([key, value]) => {
    const normalized = key.toLowerCase();
    return [normalized === "tmdb" ? "Tmdb" : normalized === "imdb" ? "Imdb" : normalized === "tvdb" ? "Tvdb" : key, value];
  }));
}

/** Emby 兼容协议服务；其所有用户数据只读写 service_emby_* 表。 */
export class EmbyCompatibilityService {
  private readonly loginFailures = new Map<string, { count: number; firstFailedAt: number; blockedUntil: number }>();
  private readonly personCaches = new Map<string, EmbyPersonCache>();
  /** 只复用目录字段排序与分类筛选，Emby 账号状态仍由自己的表读取。 */
  private readonly catalogSort: JellyfinCatalogSort;

  /** 使用同一运行环境，不创建独立数据库或同步任务。 */
  public constructor(private readonly runtime: ApiRuntime) { this.catalogSort = new JellyfinCatalogSort(runtime); }

  /** 转为公开协议条目 ID。 */
  public toProtocolItemId(itemId: string): string { return encodeItemId(itemId); }

  /** 转为内部目录条目 ID。 */
  public toInternalItemId(itemId: string): string { return decodeItemId(itemId); }

  /** 解析当前条目的主媒体源 ID，额外版本 ID 直接使用 source_files 主键。 */
  public toInternalMediaSourceId(itemId: string, mediaSourceId: string): string {
    if (!mediaSourceId) return mediaSourceId;
    const internalItemId = decodeItemId(itemId);
    return mediaSourceId === encodeItemId(internalItemId) || mediaSourceId === internalItemId ? internalItemId : mediaSourceId;
  }

  /** 根据 /e/{路径} 的自定义后缀找到所属媒体库。 */
  public async resolveLibraryIdByPathSuffix(pathSuffix: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries as l")
      .select("l.id").where("l.emby_path_suffix_lookup", pathSuffix.toLowerCase()).first();
    if (!row) throw new ApiError(404, "emby_service_not_found", "Emby 服务地址不存在");
    return String(row.id);
  }

  /** 检查 Emby 服务开关，并返回路由、下载和地区库配置。 */
  public async requireEnabledService(libraryId: string) {
    const row = await this.runtime.database.query("media_libraries as l")
      .select(
        "l.id", "l.user_id", "l.id as library_id", "l.display_name", "l.status",
        "l.emby_enabled", "l.emby_relay_playback_enabled", "l.emby_download_enabled",
        "l.emby_region_libraries_enabled", "l.library_kind",
      )
      .where("l.id", libraryId).first();
    if (!row) throw new ApiError(404, "emby_service_not_found", "Emby 服务不存在");
    if (Number(row.emby_enabled) !== 1 || row.status === "disabled") throw new ApiError(404, "emby_service_disabled", "Emby 服务未启用");
    return row;
  }

  /** 图片入口无需认证时使用的媒体归属上下文。 */
  public async resolvePublicImageContext(libraryId: string): Promise<EmbyLibraryContext> {
    const service = await this.requireEnabledService(libraryId);
    return {
      serviceId: String(service.id), ownerUserId: String(service.user_id), libraryId,
      libraryKind: String(service.library_kind ?? "single_source"), regionLibrariesEnabled: Number(service.emby_region_libraries_enabled) === 1,
      sourceCategoryDefinitions: isContentSourceLibrary(service.library_kind)
        ? await this.runtime.contentSources.listLibraryCategoryDefinitions(libraryId, String(service.user_id)) : undefined,
    };
  }

  /** 服务独立 Emby 账号登录并创建 library_emby_sessions 会话。 */
  public async login(libraryId: string, request: FastifyRequest, body: Record<string, unknown>) {
    const service = await this.requireEnabledService(libraryId);
    const serviceId = String(service.id); // 关键变量：来源服务 ID 只用于网盘取址和诊断日志。
    const key = `${libraryId}:${request.ip}`;
    this.requireLoginAllowed(key);
    let account: EmbyAccessAccount;
    try {
      const access = (this.runtime as unknown as { embyAccess: EmbyAccessServiceLike }).embyAccess;
      account = await access.authenticate(libraryId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password);
      this.loginFailures.delete(key);
    } catch (error) {
      const blockedUntil = this.recordLoginFailure(key);
      this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-emby-compat", 事件: "Emby服务账号登录失败", 服务ID: serviceId, 来源地址: request.ip, 是否已临时限制: blockedUntil > Date.now() });
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    await this.runtime.database.query("library_emby_sessions").insert({
      id: sessionId, library_id: libraryId, account_id: account.id, token_hash: hashSessionToken(token), credential_revision: account.credentialRevision,
      device_id: authorizationAttribute(request, "DeviceId") ?? null, device_name: authorizationAttribute(request, "Device"), client_name: authorizationAttribute(request, "Client"),
      expires_at: new Date(Date.now() + this.runtime.config.refreshTokenTtlSeconds * 1000).toISOString(), last_seen_at: now, revoked_at: null, created_at: now,
    });
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-compat", 事件: "Emby服务账号登录成功", 服务ID: serviceId, 服务访问账号ID: account.id, 客户端名称: authorizationAttribute(request, "Client") ?? "Emby" });
    return { User: this.mapUser(account.id, account.username, libraryId, account.hasPassword, Number(service.emby_download_enabled) === 1), SessionInfo: { Id: sessionId, ServerId: libraryId, UserId: account.id, UserName: account.username, Client: authorizationAttribute(request, "Client") ?? "Emby" }, AccessToken: token, ServerId: libraryId };
  }

  /** 验证 library_emby_sessions 和 library_emby_accounts，不访问 Jellyfin 会话或账号表。 */
  public async authenticate(libraryId: string, request: FastifyRequest): Promise<EmbyContext> {
    const token = readEmbyToken(request);
    if (!token) {
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-emby-auth",
        事件: "Emby请求缺少访问令牌",
        媒体库ID: libraryId,
        请求方法: request.method,
        请求路径: request.url.split("?", 1)[0] ?? request.url,
        是否携带令牌请求头: Boolean(request.headers["x-emby-token"] || request.headers["x-mediabrowser-token"]),
        是否携带查询令牌: Boolean((request.query as Record<string, unknown> | undefined)?.api_key),
      });
      throw new ApiError(401, "emby_token_required", "需要 Emby 访问令牌");
    }
    const row = await this.runtime.database.query("library_emby_sessions as es").join("library_emby_accounts as a", "a.id", "es.account_id")
      .join("media_libraries as l", "l.id", "es.library_id")
      .select("es.*", "a.username", "a.password_required", "a.credential_revision as account_revision", "a.status as account_status", "l.id as service_id", "l.user_id", "l.id as library_id", "l.status as service_status", "l.library_kind", "l.emby_enabled", "l.emby_region_libraries_enabled", "l.emby_download_enabled")
      .where("es.token_hash", hashSessionToken(token)).where("es.library_id", libraryId).whereNull("es.revoked_at").first();
    const now = new Date().toISOString();
    // 关键变量：会话失效原因只记录布尔状态，绝不输出实际访问令牌。
    const sessionInvalid = !row || String(row.expires_at) <= now || Number(row.credential_revision) !== Number(row.account_revision)
      || row.account_status !== "active" || row.service_status === "disabled" || Number(row.emby_enabled) !== 1;
    if (sessionInvalid) {
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-emby-auth",
        事件: "Emby会话校验失败",
        媒体库ID: libraryId,
        请求方法: request.method,
        请求路径: request.url.split("?", 1)[0] ?? request.url,
        是否找到会话: Boolean(row),
        是否会话过期: row ? String(row.expires_at) <= now : false,
        是否凭据版本一致: row ? Number(row.credential_revision) === Number(row.account_revision) : false,
        账号是否启用: row ? row.account_status === "active" : false,
        服务是否启用: row ? row.service_status !== "disabled" && Number(row.emby_enabled) === 1 : false,
      });
      throw new ApiError(401, "emby_session_invalid", "Emby 登录已失效，请重新登录");
    }
    if (String(row.last_seen_at) < new Date(Date.now() - 5 * 60 * 1000).toISOString()) await this.runtime.database.query("library_emby_sessions").where({ id: row.id }).update({ last_seen_at: new Date().toISOString() });
    return {
      serviceId: String(row.service_id), ownerUserId: String(row.user_id), libraryId,
      libraryKind: String(row.library_kind ?? "single_source"), regionLibrariesEnabled: Number(row.emby_region_libraries_enabled) === 1,
      sourceCategoryDefinitions: isContentSourceLibrary(row.library_kind)
        ? await this.runtime.contentSources.listLibraryCategoryDefinitions(libraryId, String(row.user_id)) : undefined,
      accountId: String(row.account_id), accountUsername: String(row.username), accountHasPassword: Number(row.password_required ?? 1) !== 0,
      credentialRevision: Number(row.account_revision), accessToken: token,
      contentServerRoot: isContentSourceLibrary(row.library_kind) ? contentPlaybackServerRoot(request) : undefined,
      downloadEnabled: Number(row.emby_download_enabled) === 1,
    };
  }

  /** 注销当前 Emby 令牌。 */
  public async logout(libraryId: string, request: FastifyRequest): Promise<void> {
    const token = readEmbyToken(request);
    if (token) await this.runtime.database.query("library_emby_sessions").where({ library_id: libraryId, token_hash: hashSessionToken(token) }).whereNull("revoked_at").update({ revoked_at: new Date().toISOString() });
  }

  /** 构造 Emby UserDto，账号不拥有服务管理权限。 */
  public mapUser(accountId: string, username: string, serviceId = "", hasPassword = true, downloadEnabled = true) {
    // 关键变量：默认头像使用 Emby 图标的内容版本，替换图标时客户端更新图片缓存。
    const primaryImageTag = getProtocolUserImageTag("emby");
    return { Name: username, ServerId: serviceId, Id: accountId, PrimaryImageTag: primaryImageTag, HasPassword: hasPassword, HasConfiguredPassword: hasPassword, EnableAutoLogin: false, Configuration: {}, Policy: { IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableMediaPlayback: true, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnableContentDownloading: downloadEnabled, EnableContentDeletion: false } };
  }

  /** 在线库返回源分类入口，普通网盘保留电影、节目及地区分组。 */
  public async listLibraries(context: EmbyContext) {
    const definitions = this.libraryDefinitions(context);
    const items = await Promise.all(definitions.map(async (library) => {
      const result = await this.readLibraryCatalog(context, library);
      const cover = result.items.find((item) => Boolean(item.posterUrl)) ?? result.items.find((item) => Boolean(item.backdropUrl));
      return this.mapLibrary(context, library, result.total, cover);
    }));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 源分类与普通搜索按源窗口分页；用户状态、复杂筛选和最新内容保留本地目录。 */
  public async listItems(context: EmbyContext, query: Record<string, unknown>, options: { localOnly?: boolean } = {}) {
    // 在线高级筛选先校验，Ids、人物、空类型及动态旁路均不能绕过非法条件。
    if (isContentSourceLibrary(context.libraryKind)) readProtocolContentFilters(query);
    const include = this.queryString(query, "IncludeItemTypes").split(",").map((value) => value.trim()).filter(Boolean);
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "").filter(Boolean);
    // APP 的人物作品页直接通过 PersonIds 查询，必须先按人物索引限定条目。
    const personIds = this.queryString(query, "PersonIds").split(",").map((value) => value.trim()).filter(Boolean);
    if (personIds.length > 0) return this.listItemsByPerson(context, personIds, query);
    // APP 会使用 Ids 批量回查条目；保持请求顺序并忽略已经删除的条目。
    const explicitIds = this.queryString(query, "Ids").split(",").map((value) => value.trim()).filter(Boolean);
    if (explicitIds.length > 0) {
      const records: MediaItemRecord[] = [];
      for (const protocolItemId of explicitIds) {
        try { records.push(await this.requireItem(context, decodeItemId(protocolItemId))); } catch { /* 已删除条目不阻断整批返回。 */ }
      }
      return this.filterAndPaginate(await this.filterOnlineParentItems(context, await this.mapItems(context, records), query), query, context);
    }
    const parentId = this.queryString(query, "ParentId");
    const library = this.findLibraryDefinition(context, parentId);
    const season = decodeSeasonId(parentId);
    if (season) return this.listEpisodes(context, encodeItemId(season.seriesId), { ...query, Season: season.seasonNumber });
    // 关键变量：部分第三方 Emby 播放器会缓存或自行构造非 UUID 的媒体库 ParentId；不能因此返回空列表。
    // 只有可识别为条目 ID 的父级才按节目读取单集，其他父级退回当前媒体库根列表。
    const parentSeriesId = parentId && !library && (parentId !== context.libraryId || !isContentSourceLibrary(context.libraryKind))
      && (UUID_PATTERN.test(parentId) || INTERNAL_ITEM_ID_PATTERN.test(parentId))
      ? decodeItemId(parentId)
      : "";
    if (parentSeriesId) return this.listEpisodes(context, encodeItemId(parentSeriesId), query);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const identityFilter = readProtocolItemIdentityFilter(query, decodeItemId);
    const identityIds = await resolveProtocolItemIdentityIds(this.runtime, context, identityFilter);
    if (identityIds?.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const types = requestedTypes.length > 0 ? requestedTypes : library?.itemType ? [library.itemType] : ["video.movie", "video.series"];
    const search = this.queryString(query, "SearchTerm");
    // 关键变量：源搜索以整部影片/节目为单位，混入 Episode/BoxSet/Person 不影响有效 Movie/Series。
    const sourceSearchTypes = types.filter((type) => (type === "video.movie" || type === "video.series")
      && (!library?.itemType || type === library.itemType));
    const sourceSearchScope = !parentId || parentId === context.libraryId || typeof library?.sourceCategoryId === "string"
      || Boolean(library?.itemType && !library.regionGroup);
    if (!options.localOnly && isContentSourceLibrary(context.libraryKind) && search && sourceSearchScope
      && identityFilter.itemIds === undefined && identityFilter.providerIds === undefined
      && sourceSearchTypes.length > 0
      && !this.hasLocalContentFilters(query)) {
      const sourcePage = await this.listContentSourcePage(context, query,
        typeof library?.sourceCategoryId === "string" ? library.sourceCategoryId : undefined, sourceSearchTypes, search);
      if (sourcePage) return sourcePage;
    }
    if (!options.localOnly && isContentSourceLibrary(context.libraryKind) && typeof library?.sourceCategoryId === "string"
      && identityFilter.itemIds === undefined && identityFilter.providerIds === undefined
      && types.every((type) => type === "video.movie" || type === "video.series")
      && !search && !this.hasLocalContentFilters(query)) {
      const dynamicPage = await this.listContentSourcePage(context, query, library.sourceCategoryId, types);
      if (dynamicPage) return dynamicPage;
    }
    // 外部编号先限定真实条目，再按原有类型、地区和搜索条件排序，不能只匹配原列表前 500 项。
    let records = isContentSourceLibrary(context.libraryKind)
      ? await this.readOnlineCatalogRecords(context, query, {
        itemTypes: types, itemIds: identityIds, sourceCategoryId: library?.sourceCategoryId,
        regionGroup: library?.regionGroup, search: this.queryString(query, "SearchTerm") || undefined,
      })
      : (await Promise.all(types.map((itemType) => this.runtime.repository.listCatalogItems({ userId: context.ownerUserId, libraryId: context.libraryId, itemIds: identityIds, mediaType: "video", itemType, regionGroup: library?.regionGroup, search: this.queryString(query, "SearchTerm") || undefined, sort: this.readSort(query), limit: Math.max(500, identityIds?.length ?? 0), offset: 0, includeFileCounts: false })))).flatMap((result) => result.items);
    // 关键变量：Genres 返回的是稳定协议 ID，Flymby 会把该 ID 原样传入 GenreIds。
    const genreIds = new Set(this.queryString(query, "GenreIds").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    if (genreIds.size > 0) {
      records = records.filter((item) => Array.isArray(item.metadata.genres) && item.metadata.genres.some((genre) => genreIds.has(protocolUuid("genre", String(genre).trim()).toLowerCase())));
    }
    const genres = this.queryString(query, "Genres").split(/[|,]/u).map((value) => value.trim()).filter(Boolean);
    if (isContentSourceLibrary(context.libraryKind) && genres.length > 0) {
      records = records.filter((item) => Array.isArray(item.metadata.genres) && item.metadata.genres.some((genre) => genres.includes(String(genre).trim())));
    }
    if (this.queryString(query, "SortBy").split(",").some((value) => value.trim().toLowerCase() === "random")) {
      records = records.map((item) => ({ item, order: Math.random() })).sort((left, right) => left.order - right.order).map((entry) => entry.item);
    }
    const mapped = await this.mapItems(context, records);
    const result = this.filterAndPaginate(mapped, query, context);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-emby-route",
      事件: "返回Emby媒体列表",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      父级ID: parentId || null,
      请求条目类型: include.join(",") || "未指定",
      返回条目数量: result.Items.length,
      总条目数量: result.TotalRecordCount,
    });
    return result;
  }

  /** 返回节目季，季仅为协议虚拟项。 */
  public async listSeasons(context: EmbyContext, seriesId: string) {
    const series = await this.requireItemDetail(context, decodeItemId(seriesId));
    const children = await this.runtime.repository.listCatalogChildren(series.id, context.ownerUserId);
    const tag = series.posterUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const seasons = [...new Set(children.map((item) => readVideoSeason(item.metadata.seasonNumber))).values()].sort((a, b) => a - b).map((number) => ({ Name: videoSeasonTitle(number), Id: encodeSeasonId(series.id, number), ServerId: context.libraryId, Type: "Season", IsFolder: true, SeriesId: encodeItemId(series.id), SeriesName: series.title, IndexNumber: number, ParentId: encodeItemId(series.id), ImageTags: tag ? { Primary: tag } : {}, PrimaryImageTag: tag || undefined, PrimaryImageItemId: tag ? encodeItemId(series.id) : undefined, UserData: this.emptyUserData() }));
    return { Items: seasons, TotalRecordCount: seasons.length, StartIndex: 0 };
  }

  /** 返回节目单集，并补全实时详情以保持单集简介一致。 */
  public async listEpisodes(context: EmbyContext, seriesId: string, query: Record<string, unknown>) {
    if (isContentSourceLibrary(context.libraryKind)) readProtocolContentFilters(query);
    const identityFilter = readProtocolItemIdentityFilter(query, decodeItemId);
    const seasonRef = decodeSeasonId(seriesId) ?? decodeSeasonId(this.queryString(query, "SeasonId"));
    const rawSeriesId = this.queryString(query, "SeriesId") || seasonRef?.seriesId || decodeItemId(seriesId);
    const series = await this.requireItemDetail(context, decodeItemId(rawSeriesId));
    // 关键变量：未传季筛选时必须保留全部单集，不能把 Number("") 得到的 0 当作特辑季。
    const rawSeason = this.queryString(query, "Season") || this.queryString(query, "SeasonNumber");
    const requestedSeason = seasonRef?.seasonNumber ?? (rawSeason ? Number(rawSeason) : undefined);
    const useSeason = requestedSeason !== undefined && Number.isFinite(requestedSeason);
    const children = (await this.runtime.repository.listCatalogChildren(series.id, context.ownerUserId)).filter((item) => item.itemType === "video.episode" && (!useSeason || Number(item.metadata.seasonNumber ?? 0) === requestedSeason)).sort((a, b) => Number(a.metadata.seasonNumber ?? 0) - Number(b.metadata.seasonNumber ?? 0) || Number(a.metadata.episodeNumber ?? 0) - Number(b.metadata.episodeNumber ?? 0));
    const matchedChildren = children.filter((item) => matchesProtocolItemIdentity(identityFilter, item.id, item.externalIds));
    const hydrated = await Promise.all(matchedChildren.map((item) => hydrateRealtimeVideoDetails(this.runtime, item)));
    const items = await this.mapItems(context, hydrated, new Map(hydrated.map((item) => [item.id, series])));
    return isContentSourceLibrary(context.libraryKind) ? this.filterAndPaginate(items, query, context) : this.paginate(items, query);
  }

  /** 单条详情补齐在线卡片；收藏、历史与续播装配显式关闭详情预读。 */
  public async getItem(context: EmbyContext, itemId: string, options: { loadDetail?: boolean } = {}) {
    const item = options.loadDetail === false
      ? await this.requireItem(context, decodeItemId(itemId))
      : await this.requireItemDetail(context, decodeItemId(itemId));
    const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
    return this.mapItem(context, item, parent);
  }

  /** 返回媒体条目或人物详情，兼容 Flymby 对两种实体共用的详情接口。 */
  public async getItemDetail(context: EmbyContext, itemId: string) {
    const library = this.findLibraryDefinition(context, itemId);
    if (library && isContentSourceLibrary(context.libraryKind)) {
      const result = await this.readLibraryCatalog(context, library);
      const cover = result.items.find((item) => Boolean(item.posterUrl)) ?? result.items.find((item) => Boolean(item.backdropUrl));
      return this.mapLibrary(context, library, result.total, cover);
    }
    const person = await this.getPersonItem(context, itemId);
    return person ?? this.getItem(context, itemId);
  }

  /** 按当前 Emby 账户返回收藏媒体及演员虚拟项。 */
  public async listFavoriteItems(context: EmbyContext, query: Record<string, unknown>) {
    const onlineLibrary = isContentSourceLibrary(context.libraryKind);
    if (onlineLibrary) readProtocolContentFilters(query, { favorite: true });
    const allowedIds = await this.readOnlineParentItemIds(context, query);
    const rowsQuery = this.runtime.database.query("library_emby_item_preferences as pref").join("media_items as m", "m.id", "pref.item_id").select("pref.item_id").where({ "pref.library_id": context.libraryId, "pref.account_id": context.accountId }).whereNotNull("pref.starred_at").whereNull("m.deleted_at").orderBy("pref.starred_at", "desc");
    if (!onlineLibrary && !allowedIds) rowsQuery.limit(500);
    const scopedRows = (await rowsQuery).filter((row) => !allowedIds || allowedIds.has(String(row.item_id)));
    const rows = onlineLibrary ? scopedRows : scopedRows.slice(0, 500);
    const media: Record<string, unknown>[] = [];
    for (const row of rows) { try { media.push(await this.getItem(context, encodeItemId(String(row.item_id)), { loadDetail: false })); } catch { /* 目录变更后忽略已删除条目。 */ } }
    const include = this.queryString(query, "IncludeItemTypes");
    if (!include || include.split(",").includes("Person")) {
      const personRows = await this.runtime.database.query("library_emby_virtual_preferences").select("protocol_item_id").where({ library_id: context.libraryId, account_id: context.accountId, item_type: "Person" }).orderBy("starred_at", "desc").limit(500);
      for (const row of personRows) { const person = await this.getPersonItem(context, String(row.protocol_item_id)); if (person) media.push(person); }
    }
    return this.filterAndPaginate(await this.filterOnlineParentItems(context, media, query), query, context, { favorite: true });
  }

  /** 返回明确已观看的 Emby 条目。 */
  public async listPlayedItems(context: EmbyContext, query: Record<string, unknown>) {
    const allowedIds = await this.readOnlineParentItemIds(context, query);
    if (isContentSourceLibrary(context.libraryKind)) {
      // 关键变量：在线节目必须使用当前有效单集汇总，不能先用历史父 played 截断候选。
      const records = await this.readOnlineCatalogRecords(context, query, {
        itemTypes: ["video.movie", "video.series", "video.episode"],
        itemIds: allowedIds ? [...allowedIds] : undefined,
        search: this.queryString(query, "SearchTerm") || undefined,
        contentFilters: readProtocolContentFilters(query, { played: true }),
      });
      const items = await this.mapItems(context, records);
      if (!this.queryString(query, "SortBy")) items.sort((left, right) =>
        String(right.DatePlayed ?? "").localeCompare(String(left.DatePlayed ?? "")));
      return this.filterAndPaginate(items, query, context, { played: true });
    }
    const rowsQuery = this.runtime.database.query("library_emby_playback_progress as p").join("media_items as m", "m.id", "p.item_id").select("m.id").where({ "p.library_id": context.libraryId, "p.account_id": context.accountId, "p.played": 1 }).whereNull("m.deleted_at").orderBy("p.last_played_at", "desc");
    if (!allowedIds) rowsQuery.limit(500);
    const rows = (await rowsQuery).filter((row) => !allowedIds || allowedIds.has(String(row.id))).slice(0, 500);
    const items: Record<string, unknown>[] = [];
    for (const row of rows) { try { items.push(await this.getItem(context, encodeItemId(String(row.id)), { loadDetail: false })); } catch { /* 扫描移除后跳过。 */ } }
    return this.filterAndPaginate(await this.filterOnlineParentItems(context, items, query), query, context);
  }

  /** 继续观看返回已有进度和单集完播生成的待播入口，排除已看完或隐藏的条目。 */
  public async listResume(context: EmbyContext, query: Record<string, unknown>) {
    const allowedIds = await this.readOnlineParentItemIds(context, query);
    const rowsQuery = this.runtime.database.query("library_emby_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id").select("m.id")
      .where({ "p.library_id": context.libraryId, "p.account_id": context.accountId, "p.played": 0, "p.hidden_from_resume": 0 })
      .where((builder) => builder.where("p.position_ticks", ">", 0).orWhere("p.resume_pending", 1))
      .whereNull("m.deleted_at").orderBy("p.updated_at", "desc");
    if (!allowedIds) rowsQuery.limit(500);
    const rows = (await rowsQuery).filter((row) => !allowedIds || allowedIds.has(String(row.id))).slice(0, 500);
    const items: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        const item = await this.getItem(context, encodeItemId(String(row.id)), { loadDetail: false });
        if (!isContentSourceLibrary(context.libraryKind) || (Array.isArray(item.MediaSources) && item.MediaSources.length > 0)) items.push(item);
      } catch { /* 删除条目不返回。 */ }
    }
    return this.paginate(await this.filterOnlineParentItems(context, items, query), query);
  }

  /** 返回播放历史，避免把单纯进度数据误当作历史。 */
  public async listHistory(context: EmbyContext, query: Record<string, unknown>) {
    const allowedIds = await this.readOnlineParentItemIds(context, query);
    const rowsQuery = this.runtime.database.query("library_emby_playback_history as h").join("media_items as m", "m.id", "h.item_id").select("m.id").where({ "h.library_id": context.libraryId, "h.account_id": context.accountId }).whereNull("m.deleted_at").orderBy("h.stopped_at", "desc");
    if (!allowedIds) rowsQuery.limit(500);
    const rows = (await rowsQuery).filter((row) => !allowedIds || allowedIds.has(String(row.id))).slice(0, 500);
    const seen = new Set<string>(); const items: Record<string, unknown>[] = [];
    for (const row of rows) { const id = String(row.id); if (seen.has(id)) continue; seen.add(id); try { items.push(await this.getItem(context, encodeItemId(id), { loadDetail: false })); } catch { /* 删除条目不返回。 */ } }
    return this.paginate(await this.filterOnlineParentItems(context, items, query), query);
  }

  /** 返回演员详情，支持演员收藏和演员图片路由。 */
  public async getPersonItem(context: EmbyContext, personId: string): Promise<Record<string, unknown> | null> {
    const person = (await this.loadPersonCache(context)).peopleById.get(personId.toLowerCase());
    if (!person) return null;
    const favorite = await this.isVirtualFavorite(context, person.id);
    return { Name: person.name, Id: person.id, ServerId: context.libraryId, Type: "Person", IsFolder: true, ImageTags: person.imageTag ? { Primary: person.imageTag } : {}, PrimaryImageTag: person.imageTag || undefined, UserData: this.userData(null, 0, favorite, person.id) };
  }

  /** 列出演员，支持 SearchTerm 和分页。 */
  public async listPersons(context: EmbyContext, query: Record<string, unknown>) {
    const search = this.queryString(query, "SearchTerm").toLocaleLowerCase("zh-CN");
    const cache = await this.loadPersonCache(context);
    const items = await Promise.all([...cache.peopleById.values()].filter((person) => !search || person.name.toLocaleLowerCase("zh-CN").includes(search)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((person) => this.getPersonItem(context, person.id)));
    return this.paginate(await this.filterOnlineParentItems(context, items.filter(Boolean) as Record<string, unknown>[], query), query);
  }

  /** 返回演员关联的电影和节目。 */
  public async listItemsByPerson(context: EmbyContext, personIds: string[], query: Record<string, unknown>) {
    const cache = await this.loadPersonCache(context); const ids = new Set<string>();
    personIds.forEach((personId) => cache.peopleById.get(personId.toLowerCase())?.itemIds.forEach((itemId) => ids.add(itemId)));
    const records: MediaItemRecord[] = [];
    for (const id of ids) { try { const item = await this.requireItem(context, id); if (item.itemType !== "video.episode") records.push(item); } catch { /* 条目已删除。 */ } }
    return this.filterAndPaginate(await this.filterOnlineParentItems(context, await this.mapItems(context, records), query), query, context);
  }

  /** 按人物名称返回详情，名称不存在时返回 null。 */
  public async getPersonByName(context: EmbyContext, personName: string): Promise<Record<string, unknown> | null> {
    const normalizedName = personName.trim().toLocaleLowerCase("zh-CN");
    if (!normalizedName) return null;
    const cache = await this.loadPersonCache(context);
    const matched = [...cache.peopleById.values()].find((person) => person.name.toLocaleLowerCase("zh-CN") === normalizedName);
    return matched ? this.getPersonItem(context, matched.id) : null;
  }

  /** 返回条目所属虚拟媒体库和节目父项，结构与 Emby Ancestors 接口一致。 */
  public async listItemAncestors(context: EmbyContext, itemId: string): Promise<Array<Record<string, unknown>>> {
    if (isContentSourceLibrary(context.libraryKind) && this.findLibraryDefinition(context, itemId)) return [];
    const item = await this.requireItem(context, decodeItemId(itemId));
    const definition = this.libraryForItem(context, item);
    // 关键变量：取消类别的旧条目仍保留原面包屑，只从本地映射，不把类别重新加入 Views。
    let library: Record<string, unknown> | undefined;
    if (isContentSourceLibrary(context.libraryKind)) {
      const catalog = await this.readLibraryCatalog(context, definition);
      library = this.mapLibrary(context, definition, catalog.total, catalog.items.find((record) => Boolean(record.posterUrl)));
    } else {
      const libraries = await this.listLibraries(context);
      library = libraries.Items.find((candidate) => String(candidate.Id) === definition.id);
    }
    const ancestors: Array<Record<string, unknown>> = library ? [library] : [];
    if (item.itemType === "video.episode") {
      const parent = await this.findParent(item.id, context.ownerUserId);
      if (parent) ancestors.push(await this.mapItem(context, parent));
    }
    return ancestors;
  }

  /** 按同媒体类型和共同分类返回相关推荐。 */
  public async listSimilar(context: EmbyContext, itemId: string, query: Record<string, unknown>) {
    const current = await this.requireItem(context, decodeItemId(itemId));
    const genres = Array.isArray(current.metadata.genres)
      ? current.metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).slice(0, 3)
      : [];
    const requestedLimit = Math.min(100, Math.max(1, Number(this.queryString(query, "Limit") || 20)));
    const library = this.findLibraryDefinition(context, this.queryString(query, "ParentId"));
    if (isContentSourceLibrary(context.libraryKind) && library) {
      const entries = await this.catalogSort.load(context, {
        itemTypes: [current.itemType], sourceCategoryId: library.sourceCategoryId, regionGroup: library.regionGroup, genres,
      }, { fields: [{ name: "datemodified", descending: true }], randomSeed: "" });
      const ids = entries.filter((entry) => entry.id !== current.id).slice(0, requestedLimit).map((entry) => entry.id);
      const records = await this.runtime.repository.listCatalogItemsByIds(ids, context.ownerUserId);
      const byId = new Map(records.filter((record) => record.libraryId === context.libraryId).map((record) => [record.id, record]));
      const ordered = ids.map((id) => byId.get(id)).filter((record): record is MediaItemRecord => Boolean(record));
      const items = await this.mapItems(context, ordered);
      return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
    }
    const result = await this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, libraryId: context.libraryId, mediaType: "video", itemType: current.itemType,
      genres, sort: "updated_desc", limit: requestedLimit + 1, offset: 0, includeFileCounts: false,
    });
    const records = result.items.filter((item) => item.id !== current.id).slice(0, requestedLimit);
    const items = await this.mapItems(context, records);
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 返回指定节目尚未看完的下一集。 */
  public async listNextUp(context: EmbyContext, query: Record<string, unknown>) {
    const requestedSeriesId = this.queryString(query, "SeriesId");
    if (!requestedSeriesId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const sourceSeries = await this.requireItem(context, decodeItemId(requestedSeriesId));
    const initialAllowedIds = await this.readOnlineParentItemIds(context, query);
    const requestedParentId = this.queryString(query, "ParentId");
    const parentSeason = decodeSeasonId(requestedParentId);
    const libraryParent = this.findLibraryDefinition(context, requestedParentId);
    if (initialAllowedIds && (libraryParent ? !initialAllowedIds.has(sourceSeries.id)
      : (parentSeason?.seriesId ?? decodeItemId(requestedParentId)) !== sourceSeries.id)) {
      return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    }
    const series = await this.requireItemDetail(context, sourceSeries.id);
    // 关键变量：首次详情会创建分集，父级身份集合必须重读，不能沿用原卡片的空子集。
    const allowedIds = isContentSourceLibrary(context.libraryKind)
      ? await this.readOnlineParentItemIds(context, query) : initialAllowedIds;
    const children = (await this.runtime.repository.listCatalogChildren(series.id, context.ownerUserId))
      .filter((item) => item.itemType === "video.episode" && (!allowedIds || allowedIds.has(item.id)))
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    const progressRows = children.length === 0 ? [] : await this.runtime.database.query("library_emby_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId }).whereIn("item_id", children.map((item) => item.id));
    const progressById = new Map(progressRows.map((row) => [String(row.item_id), row]));
    const next = children.find((item) => Number(progressById.get(item.id)?.played ?? 0) !== 1);
    const hydrated = next ? await hydrateRealtimeVideoDetails(this.runtime, next) : undefined;
    const items = hydrated ? [await this.mapItem(context, hydrated, series)] : [];
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 返回分类名称，供 Emby 浏览页面使用。 */
  public async listGenres(context: EmbyContext, query: Record<string, unknown>) {
    const library = this.findLibraryDefinition(context, this.queryString(query, "ParentId"));
    const rowsQuery = this.runtime.database.query("media_items").select("metadata_json").where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" }).whereIn("item_type", library?.itemType ? [library.itemType] : ["video.movie", "video.series"]).whereNull("deleted_at");
    if (library?.regionGroup) rowsQuery.where("region_group", library.regionGroup);
    const rows = await rowsQuery;
    const counts = new Map<string, number>();
    rows.forEach((row) => { try { const metadata = JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>; if (isContentSourceLibrary(context.libraryKind) && !matchesJellyfinSourceCategory(metadata, library?.sourceCategoryId)) return; if (Array.isArray(metadata.genres)) metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1)); } catch { /* 无效旧元数据不阻断列表。 */ } });
    const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([name, count]) => ({ Name: name, Id: protocolUuid("genre", name), Type: "Genre", IsFolder: true, ChildCount: count, RecursiveItemCount: count, UserData: this.emptyUserData() }));
    return this.paginate(items, query);
  }

  /** 返回电影、节目和单集总数。 */
  public async getItemCounts(context: EmbyContext) {
    const rows = await this.runtime.database.query("media_items").select("item_type").count<{ item_type: string; count: string | number }[]>({ count: "id" }).where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" }).whereNull("deleted_at").groupBy("item_type");
    const counts = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
    return { MovieCount: counts.get("video.movie") ?? 0, SeriesCount: counts.get("video.series") ?? 0, EpisodeCount: counts.get("video.episode") ?? 0, AlbumCount: 0, SongCount: 0 };
  }

  /** 读取图片来源；路由应代理该 URL，不能把第三方图片地址直接返回客户端。 */
  public async resolveImageSource(context: EmbyLibraryContext, itemId: string, imageType: string): Promise<{ url: string; imageTag: string; updatedAt: string; sourceType: "media" | "person" }> {
    const library = this.findLibraryDefinition(context, itemId);
    if (library && isContentSourceLibrary(context.libraryKind)) {
      const result = await this.readLibraryCatalog(context, library);
      const cover = result.items.find((item) => imageType.toLowerCase() === "backdrop" ? Boolean(item.backdropUrl)
        : imageType.toLowerCase() === "logo" ? Boolean(item.metadata.logoUrl) : Boolean(item.posterUrl));
      if (!cover) throw new ApiError(404, "emby_image_not_found", "分类图片不存在");
      const url = imageType.toLowerCase() === "backdrop" ? String(cover.backdropUrl)
        : imageType.toLowerCase() === "logo" ? String(cover.metadata.logoUrl) : String(cover.posterUrl);
      return { url, imageTag: imageTag(url), updatedAt: cover.updatedAt, sourceType: "media" };
    }
    const person = (await this.loadPersonCache(context)).peopleById.get(itemId.toLowerCase());
    if (person && imageType.toLowerCase() === "primary" && person.profileUrl) return { url: person.profileUrl, imageTag: person.imageTag, updatedAt: new Date().toISOString(), sourceType: "person" };
    const season = decodeSeasonId(itemId); const actualItemId = season?.seriesId ?? decodeItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(actualItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "emby_image_not_found", "图片条目不存在");
    const type = imageType.toLowerCase(); const url = type === "backdrop" ? String(item.backdropUrl ?? "") : type === "logo" ? String(item.metadata.logoUrl ?? "") : String(item.posterUrl ?? "");
    if (!url) throw new ApiError(404, "emby_image_not_found", "图片不存在");
    return { url, imageTag: imageTag(url), updatedAt: item.updatedAt, sourceType: "media" };
  }

  /** 建立 Emby PlaybackInfo，并登记独立播放会话。 */
  public async buildPlaybackInfo(context: EmbyContext, itemId: string, input: { mediaSourceId?: string; playSessionId?: string; route?: "auto" | "origin" | "server"; serverRoot?: string }) {
    const service = await this.requireEnabledService(context.serviceId); const internalItemId = decodeItemId(itemId); const item = await this.requireItem(context, internalItemId);
    if (isContentSourceLibrary(service.library_kind)) {
      const progress = await this.runtime.database.query("library_emby_playback_progress").select("media_source_id")
        .where({ library_id: context.libraryId, account_id: context.accountId, item_id: item.id }).first();
      const requestedSource = this.toInternalMediaSourceId(item.id, input.mediaSourceId ?? "");
      const sources = await prepareContentPlaybackSources(this.runtime, item.id, context.ownerUserId, context.libraryId, requestedSource, String(progress?.media_source_id ?? ""));
      const playSessionId = input.playSessionId || randomUUID();
      const now = new Date().toISOString();
      await this.runtime.database.query("library_emby_playback_sessions").insert({
        id: playSessionId, library_id: context.libraryId, account_id: context.accountId, item_id: item.id,
        media_source_id: sources[0]?.id ?? null, status: "created", position_ticks: 0, paused: 0,
        started_at: now, updated_at: now, stopped_at: null,
      }).onConflict("id").ignore();
      // 标准媒体地址保持稳定，仅显式路线随地址传递，自动模式在真正取流时读取库配置。
      return { MediaSources: sources.map((source) => mapContentMediaSource(source, encodeItemId(item.id), context.accessToken, playSessionId, input.serverRoot, input.route)), PlaySessionId: playSessionId, ErrorCode: null };
    }
    const itemFiles = (await this.runtime.repository.listItemFiles(item.id, context.ownerUserId)).filter((file) => String(file.itemId) === item.id);
    const progress = await this.runtime.database.query("library_emby_playback_progress").select("media_source_id").where({ library_id: context.libraryId, account_id: context.accountId, item_id: item.id }).first();
    const recentSourceId = String(progress?.media_source_id ?? "");
    // 关键变量：Emby 未指定版本时优先返回该账号最近成功使用的版本，其后保持来源稳定顺序。
    const files = recentSourceId ? [...itemFiles].sort((left, right) => Number(String(right.fileId) === recentSourceId) - Number(String(left.fileId) === recentSourceId)) : itemFiles;
    if (files.length === 0) throw new ApiError(404, "emby_media_source_not_found", "媒体条目没有可播放文件");
    const requested = this.toInternalMediaSourceId(item.id, input.mediaSourceId ?? "");
    const selectedFiles = requested ? files.filter((file, index) => String(file.fileId) === requested || (index === 0 && requested === item.id)) : files;
    if (requested && selectedFiles.length === 0) throw new ApiError(404, "emby_media_source_not_found", "指定媒体源不存在");
    const playSessionId = input.playSessionId || randomUUID(); const protocolId = encodeItemId(item.id);
    const probes = selectedFiles.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); const ready = probes.every(Boolean); const duration = ready ? readJellyfinRunTimeTicks(probes) : 0;
    const sources = selectedFiles.map((file, index) => {
      // 关键变量：云聚合版本不能随来源排序改变 ID；旧单源库仍保留主版本等于条目 ID 的兼容行为。
      const sourceId = String(service.library_kind) === "cloud_aggregate_video"
        ? String(file.fileId)
        : index === 0 ? protocolId : String(file.fileId);
      const probe = probes[index]; const route = input.route ?? "auto";
      // 关键变量：部分播放器不会处理 AddApiKeyToDirectStreamUrl，直放地址必须自行携带当前 Emby 会话令牌。
      const query = new URLSearchParams({ static: "true", MediaSourceId: sourceId, PlaySessionId: playSessionId, FlyCloudPlaybackRoute: route, api_key: context.accessToken });
      // 关键变量：Emby 客户端会将相对 /Videos 地址拼接到当前服务器根路径；不能重复写入 /e/{路径}，否则部分播放器会产生双重路径并返回 404。
      const container = probe?.container || "mp4";
      return { Protocol: "File", Id: sourceId, Path: String(file.name ?? "video.mp4"), Name: `${String(file.sourceName ?? "网盘来源")}（${String(file.providerType ?? "未知网盘")}） · ${String(file.name ?? "video.mp4")}`, Type: "Default", Container: probe?.container || undefined, Size: Number(file.size ?? 0) || undefined, Bitrate: probe?.bitRate || undefined, RunTimeTicks: probe?.runTimeTicks || duration || undefined, MediaStreams: probe?.mediaStreams ?? [], SupportsTranscoding: false, SupportsDirectStream: true, SupportsDirectPlay: true, IsRemote: false, DirectStreamUrl: `/Videos/${protocolId}/stream.${container}?${query.toString()}`, AddApiKeyToDirectStreamUrl: false, RequiredHttpHeaders: {} };
    });
    const now = new Date().toISOString(); const selectedId = this.toInternalMediaSourceId(item.id, String(sources[0]?.Id ?? ""));
    await this.runtime.database.query("library_emby_playback_sessions").insert({ id: playSessionId, library_id: context.libraryId, account_id: context.accountId, item_id: item.id, media_source_id: selectedId || null, status: "created", position_ticks: 0, paused: 0, started_at: now, updated_at: now, stopped_at: null }).onConflict("id").ignore();
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-playback", 事件: "生成Emby直放信息", 服务ID: context.serviceId, 账号ID: context.accountId, 媒体条目ID: item.id, 媒体源数量: sources.length, 请求播放路由: input.route ?? "auto", 直放相对路径: String(sources[0]?.DirectStreamUrl ?? "").split("?", 1)[0] ?? "", 地址是否携带鉴权: true, 是否允许中转: Number(service.emby_relay_playback_enabled) === 1 });
    return { MediaSources: sources, PlaySessionId: playSessionId, ErrorCode: null };
  }

  /** 接收 /Sessions/Playing、/Progress、/Stopped 并写入 service_emby_* 播放表。 */
  public async reportPlayback(context: EmbyContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    const rawItemId = String(body.ItemId ?? body.itemId ?? ""); if (!rawItemId) return;
    const item = await this.requireItem(context, decodeItemId(rawItemId)); const playSessionId = String(body.PlaySessionId ?? body.playSessionId ?? randomUUID());
    const positionTicks = Math.max(0, Number(body.PositionTicks ?? body.positionTicks ?? 0)); const mediaSourceId = this.toInternalMediaSourceId(item.id, String(body.MediaSourceId ?? body.mediaSourceId ?? ""));
    const durationTicks = await this.readItemRunTimeTicks(item, mediaSourceId); const completed = durationTicks > 0 && positionTicks / durationTicks >= 0.9; const now = new Date().toISOString();
    // 关键变量：只有从未观看变为已观看时，才需要重新汇总父节目并输出状态日志。
    let automaticallyMarkedPlayed = false;
    await this.runtime.database.query.transaction(async (transaction: Knex.Transaction) => {
      const existingSession = await transaction("library_emby_playback_sessions").where({ id: playSessionId, library_id: context.libraryId, account_id: context.accountId }).first();
      const sessionPatch = { item_id: item.id, media_source_id: mediaSourceId || null, status: kind === "stopped" ? "stopped" : kind, position_ticks: positionTicks, paused: body.IsPaused === true || body.isPaused === true ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (existingSession) await transaction("library_emby_playback_sessions").where({ id: playSessionId }).update(sessionPatch); else await transaction("library_emby_playback_sessions").insert({ id: playSessionId, library_id: context.libraryId, account_id: context.accountId, ...sessionPatch, started_at: now });
      automaticallyMarkedPlayed = await this.upsertProgress(transaction, context, item.id,
        mediaSourceId || null, positionTicks, kind === "stopped", completed, now);
      if (item.itemType === "video.episode" && automaticallyMarkedPlayed) {
        await prepareNextEpisodeResume(transaction, "library_emby_playback_progress", context, item.id, now);
      }
      if (kind === "stopped") { const history = await transaction("library_emby_playback_history").where({ library_id: context.libraryId, account_id: context.accountId, play_session_id: playSessionId }).first(); if (!history) await transaction("library_emby_playback_history").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: item.id, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: existingSession?.started_at ?? now, stopped_at: now }); }
    });
    // 自动播放进度也属于单集状态变化，最后一集完播后应立即更新整剧完成标记。
    if (item.itemType === "video.episode" && automaticallyMarkedPlayed) {
      await this.synchronizeParentSeriesProgress(context, item.id, now);
    }
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-playback", 事件: completed ? "Emby播放进度达到90%自动标记已观看" : "保存Emby播放进度", 服务ID: context.serviceId, 账号ID: context.accountId, 媒体条目ID: item.id, 上报类型: kind, 已观看Ticks: positionTicks, 总时长Ticks: durationTicks });
  }

  /** 获取 Flymby 详情页需要的单条 Emby 用户状态。 */
  public async getUserData(context: EmbyContext, itemId: string) {
    const person = await this.getPersonItem(context, itemId);
    if (person) return person.UserData ?? this.userData(null, 0, false, itemId);
    const item = await this.requireItem(context, decodeItemId(itemId));
    return this.userData(
      await this.readProgress(context, item.id),
      await this.readItemRunTimeTicks(item),
      await this.isFavorite(context, item.id),
      encodeItemId(item.id),
    );
  }

  /** 接收 Emby UserData 更新，同步处理进度、已观看和收藏字段。 */
  public async updateUserData(context: EmbyContext, itemId: string, body: Record<string, unknown>) {
    const person = await this.getPersonItem(context, itemId);
    if (person) {
      if (typeof body.IsFavorite === "boolean") await this.setFavorite(context, itemId, body.IsFavorite);
      return this.getUserData(context, itemId);
    }
    const item = await this.requireItem(context, decodeItemId(itemId));
    if (Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")) {
      const positionTicks = Math.max(0, Math.floor(Number(body.PlaybackPositionTicks ?? 0)));
      const now = new Date().toISOString();
      const existing = await this.readProgress(context, item.id);
      // 关键变量：客户端显式写入进度时恢复继续观看可见性，并清除之前的已观看状态。
      const patch = { position_ticks: positionTicks, played: 0, hidden_from_resume: 0, resume_pending: 0, updated_at: now };
      if (existing) await this.runtime.database.query("library_emby_playback_progress").where({ id: existing.id }).update(patch);
      else await this.runtime.database.query("library_emby_playback_progress").insert({
        id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: item.id,
        media_source_id: null, play_count: 0, last_played_at: null, ...patch,
      });
    }
    if (typeof body.Played === "boolean") await this.setPlayed(context, itemId, body.Played);
    // 仅写入播放位置也会撤销单集已观看状态，需要同步刷新父节目汇总。
    if (item.itemType === "video.episode"
      && Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")
      && typeof body.Played !== "boolean") {
      await this.synchronizeParentSeriesProgress(context, item.id, new Date().toISOString());
    }
    if (typeof body.IsFavorite === "boolean") await this.setFavorite(context, itemId, body.IsFavorite);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-emby-app-api",
      事件: "更新Emby用户条目状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: item.id,
      是否包含播放进度: Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks"),
      是否包含已观看状态: typeof body.Played === "boolean",
      是否包含收藏状态: typeof body.IsFavorite === "boolean",
    });
    return this.getUserData(context, itemId);
  }

  /** 手动切换已观看状态。 */
  public async setPlayed(context: EmbyContext, itemId: string, played: boolean) {
    const item = await this.requireItem(context, decodeItemId(itemId));
    const now = new Date().toISOString();
    const episodeIds = item.itemType === "video.series"
      ? (await this.runtime.repository.listCatalogChildren(item.id, context.ownerUserId))
        .filter((child) => child.libraryId === context.libraryId && child.itemType === "video.episode")
        .map((episode) => episode.id)
      : [];
    // 关键变量：整剧操作覆盖当前存在的全部单集，新增单集仍由扫描关系使整剧状态失效。
    const targetItemIds = [...new Set([item.id, ...episodeIds])];
    await this.runtime.database.query.transaction(async (transaction: Knex.Transaction) => {
      const existingRows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < targetItemIds.length; offset += EMBY_USER_STATE_BATCH_SIZE) {
        existingRows.push(...await transaction("library_emby_playback_progress")
          .where({ library_id: context.libraryId, account_id: context.accountId })
          .whereIn("item_id", targetItemIds.slice(offset, offset + EMBY_USER_STATE_BATCH_SIZE)));
      }
      const existingByItemId = new Map(existingRows.map((row) => [String(row.item_id), row]));
      const rows = targetItemIds.map((targetItemId) => {
        const existing = existingByItemId.get(targetItemId);
        return {
          id: String(existing?.id ?? randomUUID()),
          library_id: context.libraryId,
          account_id: context.accountId,
          item_id: targetItemId,
          media_source_id: existing?.media_source_id ?? null,
          played: played ? 1 : 0,
          position_ticks: 0,
          hidden_from_resume: played ? 1 : 0,
          resume_pending: 0,
          play_count: played ? Math.max(1, Number(existing?.play_count ?? 0)) : 0,
          last_played_at: played ? now : null,
          updated_at: now,
        };
      });
      for (let offset = 0; offset < rows.length; offset += EMBY_USER_STATE_BATCH_SIZE) {
        await transaction("library_emby_playback_progress")
          .insert(rows.slice(offset, offset + EMBY_USER_STATE_BATCH_SIZE))
          .onConflict(["library_id", "account_id", "item_id"])
          .merge(["played", "position_ticks", "hidden_from_resume", "resume_pending", "play_count", "last_played_at", "updated_at"]);
      }
    });
    if (item.itemType === "video.episode") {
      await this.synchronizeParentSeriesProgress(context, item.id, now);
    }
    const progress = await this.readProgress(context, item.id);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-series-watched-state",
      事件: "更新Emby观看状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: item.id,
      媒体类型: item.itemType,
      是否已观看: played,
      级联单集数量: episodeIds.length,
    });
    return this.userData(progress, await this.readItemRunTimeTicks(item),
      await this.isFavorite(context, item.id), encodeItemId(item.id));
  }

  /** 收藏媒体条目，或收藏 Emby Person 虚拟条目。 */
  public async setFavorite(context: EmbyContext, itemId: string, favorite: boolean) {
    const person = await this.getPersonItem(context, itemId); const now = new Date().toISOString();
    if (person) {
      const existing = await this.runtime.database.query("library_emby_virtual_preferences").where({ library_id: context.libraryId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase() }).first();
      if (favorite && existing) await this.runtime.database.query("library_emby_virtual_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
      else if (favorite) await this.runtime.database.query("library_emby_virtual_preferences").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase(), item_type: "Person", starred_at: now, updated_at: now });
      else if (existing) await this.runtime.database.query("library_emby_virtual_preferences").where({ id: existing.id }).delete();
      return this.userData(null, 0, favorite, itemId);
    }
    const item = await this.requireItem(context, decodeItemId(itemId)); const existing = await this.runtime.database.query("library_emby_item_preferences").where({ library_id: context.libraryId, account_id: context.accountId, item_id: item.id }).first();
    if (favorite && existing) await this.runtime.database.query("library_emby_item_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
    else if (favorite) await this.runtime.database.query("library_emby_item_preferences").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: item.id, starred_at: now, rating: 0, updated_at: now });
    else if (existing && Number(existing.rating ?? 0) === 0) await this.runtime.database.query("library_emby_item_preferences").where({ id: existing.id }).delete();
    else if (existing) await this.runtime.database.query("library_emby_item_preferences").where({ id: existing.id }).update({ starred_at: null, updated_at: now });
    return this.userData(await this.readProgress(context, item.id), await this.readItemRunTimeTicks(item), favorite, encodeItemId(item.id));
  }

  /** 从继续观看隐藏或恢复项目。 */
  public async setHiddenFromResume(context: EmbyContext, itemId: string, hidden: boolean): Promise<void> {
    const item = await this.requireItem(context, decodeItemId(itemId)); const existing = await this.readProgress(context, item.id); const now = new Date().toISOString();
    if (existing) await this.runtime.database.query("library_emby_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
    else await this.runtime.database.query("library_emby_playback_progress").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: item.id, media_source_id: null, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
  }

  /** 在线库按当前选中源分类输出标准 CollectionFolder，不依赖 Movie/Series 类型筛选。 */
  private libraryDefinitions(context: EmbyLibraryContext): EmbyLibraryDefinition[] {
    if (isContentSourceLibrary(context.libraryKind)) {
      return (context.sourceCategoryDefinitions ?? []).map((category) => this.sourceCategoryLibrary(context, category));
    }
    return this.legacyLibraryDefinitions(context);
  }

  /** 源分类身份与 Jellyfin 共用稳定 UUID，改名或重选分类不改变媒体入口。 */
  private sourceCategoryLibrary(context: EmbyLibraryContext, category: ContentSourceCategoryDefinition): EmbyLibraryDefinition {
    const identity = category.categoryId === null ? "unknown" : `id:${encodeURIComponent(category.categoryId)}`;
    const internalId = `${context.libraryId}:source-category:${identity}`;
    return { internalId, id: protocolUuid("content_source_category", internalId), name: category.name,
      collectionType: category.collectionType, sourceCategoryId: category.categoryId };
  }

  /** 普通网盘维持原电影、节目和地区入口，在线库仅兼容旧客户端缓存的入口 ID。 */
  private legacyLibraryDefinitions(context: EmbyLibraryContext): EmbyLibraryDefinition[] {
    const roots: EmbyLibraryDefinition[] = [{ internalId: `${context.libraryId}:movies`, id: protocolUuid("library", `${context.libraryId}:movies`), name: "电影", collectionType: "movies", itemType: "video.movie" }, { internalId: `${context.libraryId}:tvshows`, id: protocolUuid("library", `${context.libraryId}:tvshows`), name: "剧集", collectionType: "tvshows", itemType: "video.series" }];
    if (!context.regionLibrariesEnabled) return roots;
    const regions: Array<[VideoRegionGroup, string]> = [["chinese", "国语"], ["japan_korea", "日韩"], ["europe_america", "欧美"], ["other", "其他"]];
    return roots.flatMap((root) => regions.map(([regionGroup, name]) => ({ ...root, internalId: `${root.internalId}:${regionGroup}`, id: protocolUuid("library", `${root.internalId}:${regionGroup}`), name: `${root.name}-${name}`, regionGroup })));
  }

  /** 入口查找兼容原 ID；旧聚合库只查询本地，不继续向取消选择的分类查源。 */
  private findLibraryDefinition(context: EmbyLibraryContext, id: string): EmbyLibraryDefinition | undefined {
    const current = this.libraryDefinitions(context).find((entry) => entry.id === id || entry.internalId === id);
    if (current || !isContentSourceLibrary(context.libraryKind)) return current;
    return [...this.legacyLibraryDefinitions(context), ...this.legacyLibraryDefinitions({ ...context, regionLibrariesEnabled: false })]
      .find((entry) => entry.id === id || entry.internalId === id);
  }

  /** 只读取已建立目录的分类统计与封面，Views 和图片不会触发源站分页。 */
  private async readLibraryCatalog(context: EmbyLibraryContext, library: EmbyLibraryDefinition): Promise<{ total: number; items: MediaItemRecord[] }> {
    if (!isContentSourceLibrary(context.libraryKind)) {
      return this.runtime.repository.listCatalogItems({ userId: context.ownerUserId, libraryId: context.libraryId,
        mediaType: "video", itemType: library.itemType, regionGroup: library.regionGroup,
        sort: "updated_desc", limit: 1, offset: 0, includeFileCounts: false });
    }
    const entries = await this.catalogSort.load({ ...context, accountId: "", accessToken: "" }, {
      itemTypes: library.itemType ? [library.itemType] : undefined, topLevel: true,
      sourceCategoryId: library.sourceCategoryId, regionGroup: library.regionGroup,
    }, { fields: [{ name: "datemodified", descending: true }], randomSeed: "" });
    const records = await this.runtime.repository.listCatalogItemsByIds(entries.slice(0, 60).map((entry) => entry.id), context.ownerUserId);
    const byId = new Map(records.filter((item) => item.libraryId === context.libraryId).map((item) => [item.id, item]));
    return { total: entries.length, items: entries.slice(0, 60).map((entry) => byId.get(entry.id)).filter((item): item is MediaItemRecord => Boolean(item)) };
  }

  /** 使用标准库 DTO，未知类型省略 CollectionType，客户端仍可普通浏览。 */
  private mapLibrary(context: EmbyContext, library: EmbyLibraryDefinition, total: number, cover?: MediaItemRecord): Record<string, unknown> {
    const tag = cover?.posterUrl ? String(Date.parse(cover.updatedAt) || 1) : "";
    return { Name: library.name, ServerId: context.libraryId, Id: library.id, Type: "CollectionFolder",
      CollectionType: library.collectionType, IsFolder: true,
      ...(isContentSourceLibrary(context.libraryKind) ? { LocationType: "FileSystem" } : {}),
      ChildCount: total, RecursiveItemCount: total, ImageTags: tag ? { Primary: tag } : {},
      PrimaryImageTag: tag || undefined, PrimaryImageItemId: tag && cover ? encodeItemId(cover.id) : undefined,
      UserData: this.emptyUserData() };
  }

  /** 沿 Emby 现有本地排序支持范围生成目录字段排序，不读取 Jellyfin 账号状态。 */
  private readOnlineSortPlan(context: EmbyContext, query: Record<string, unknown>): JellyfinSortPlan {
    if (this.queryString(query, "SortBy").split(",").some((name) => name.trim().toLowerCase() === "random")) {
      return this.catalogSort.readPlan(context, { ...query, SortBy: "Random" });
    }
    const sort = this.readSort(query);
    const field = sort.startsWith("title_") ? "sortname" : sort.startsWith("year_") ? "productionyear"
      : sort.startsWith("premiere_date_") ? "premieredate" : "datecreated";
    return { fields: [{ name: field, descending: sort.endsWith("_desc") }], randomSeed: "" };
  }

  /** 在线库按精确分类筛选后加载条目，防止先截断全库再筛分类造成空页。 */
  private async readOnlineCatalogRecords(context: EmbyContext, query: Record<string, unknown>, filters: JellyfinSortFilters): Promise<MediaItemRecord[]> {
    const contentFilters = filters.contentFilters ?? readProtocolContentFilters(query);
    const entries = await this.catalogSort.load(context, { ...filters, contentFilters, stateProtocol: "emby" }, this.readOnlineSortPlan(context, query));
    const records = await this.runtime.repository.listCatalogItemsByIds(entries.map((entry) => entry.id), context.ownerUserId);
    const byId = new Map(records.filter((item) => item.libraryId === context.libraryId).map((item) => [item.id, item]));
    return entries.map((entry) => byId.get(entry.id)).filter((item): item is MediaItemRecord => Boolean(item));
  }

  /** 有本地筛选的请求继续查目录，不能在动态页上忽略筛选或二次分页。 */
  private hasLocalContentFilters(query: Record<string, unknown>): boolean {
    const keys = ["Filters", "IsFavorite", "IsPlayed", "IsUnplayed", "IsResumable", "GenreIds", "Genres", "Years", "Tags",
      "Studios", "StudioIds", "Person", "PersonIds", "PersonTypes", "MinCommunityRating", "MaxOfficialRating", "MinOfficialRating",
      "HasOverview", "HasImdbId", "HasTmdbId", "HasTvdbId", "IsMissing", "IsUnaired", "IsFolder"];
    return keys.some((key) => this.queryString(query, key).trim() !== "");
  }

  /** 源搜索与分类窗口已过滤并落库，只按稳定 ID 装配 Emby DTO，不再排序或分页。 */
  private async listContentSourcePage(context: EmbyContext, query: Record<string, unknown>, categoryId: string | undefined, itemTypes: string[], searchTerm?: string) {
    const requestedStart = Number(this.queryString(query, "StartIndex") || 0);
    const requestedLimit = Number(this.queryString(query, "Limit") || 100);
    const startIndex = Number.isFinite(requestedStart) ? Math.max(0, Math.floor(requestedStart)) : 0;
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 100;
    // 关键变量：搜索与分类共用源窗口参数，后端完成类型筛选后一次性分页。
    const sourceOptions = { startIndex, limit, itemTypes: itemTypes as Array<"video.movie" | "video.series"> };
    const page = searchTerm
      ? await this.runtime.contentSources.searchLibrary(context.libraryId, context.ownerUserId, { ...sourceOptions, searchTerm, categoryId })
      : categoryId !== undefined
        ? await this.runtime.contentSources.browseLibraryCategory(context.libraryId, context.ownerUserId, { ...sourceOptions, categoryId })
        : null;
    // 关键变量：不支持实时搜索或源停用才回本地，不能吞掉源请求或权限错误。
    if (!page) return null;
    const records = await this.runtime.repository.listCatalogItemsByIds(page.itemIds, context.ownerUserId);
    const byId = new Map(records.filter((item) => item.libraryId === context.libraryId).map((item) => [item.id, item]));
    const ordered = page.itemIds.map((id) => byId.get(id));
    if (ordered.some((item) => !item)) throw new ApiError(409, "content_category_changed", "内容源目录已变化，请重新加载当前页");
    const items = await this.mapItems(context, ordered as MediaItemRecord[]);
    // 临时分页诊断：只记录安全的数量与分类身份，用户确认修复后清理此日志。
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-content-source-browse", 协议: "Emby", 操作: searchTerm ? "实时搜索" : "分类浏览",
      媒体库ID: context.libraryId, 源分类ID: categoryId ?? null,
      请求起点: startIndex, 请求条数: limit,
      排序字段: this.queryString(query, "SortBy"), 排序方向: this.queryString(query, "SortOrder"),
      返回条数: items.length, 当前目录总数: page.totalRecordCount, 是否还有下一页: startIndex + limit < page.totalRecordCount,
    });
    return { Items: items, TotalRecordCount: page.totalRecordCount, StartIndex: page.startIndex };
  }

  /** 明确 ParentId 时读取本地身份集合；根与未知旧别名维持原全库查询行为。 */
  private async readOnlineParentItemIds(context: EmbyContext, query: Record<string, unknown>): Promise<Set<string> | undefined> {
    if (!isContentSourceLibrary(context.libraryKind)) return undefined;
    const parentId = this.queryString(query, "ParentId");
    if (!parentId || parentId === context.libraryId) return undefined;
    const library = this.findLibraryDefinition(context, parentId);
    const season = decodeSeasonId(parentId);
    const filters: JellyfinSortFilters = library ? {
      sourceCategoryId: library.sourceCategoryId, regionGroup: library.regionGroup,
      itemTypes: library.itemType === "video.movie" ? ["video.movie"] : library.itemType === "video.series" ? ["video.series", "video.episode"] : undefined,
    } : season ? { parentId: season.seriesId, seasonNumber: season.seasonNumber }
      : UUID_PATTERN.test(parentId) || INTERNAL_ITEM_ID_PATTERN.test(parentId) ? { parentId: decodeItemId(parentId) } : {};
    if (!library && !season && !filters.parentId) return undefined;
    const entries = await this.catalogSort.load({ ...context, accountId: "", accessToken: "" }, filters,
      { fields: [{ name: "sortname", descending: false }], randomSeed: "" });
    return new Set(entries.map((entry) => entry.id));
  }

  /** 已看、收藏、历史、演员等列表仅做本地分类交集，不调用源分页。 */
  private async filterOnlineParentItems(context: EmbyContext, items: Record<string, unknown>[], query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const allowedIds = await this.readOnlineParentItemIds(context, query);
    if (!allowedIds) return items;
    const people = items.some((item) => item.Type === "Person") ? (await this.loadPersonCache(context)).peopleById : undefined;
    return items.filter((item) => item.Type === "Person"
      ? [...(people?.get(String(item.Id).toLowerCase())?.itemIds ?? [])].some((id) => allowedIds.has(id))
      : allowedIds.has(decodeItemId(String(item.Id))));
  }

  private async mapItems(context: EmbyContext, records: MediaItemRecord[], parents = new Map<string, MediaItemRecord | undefined>) { return Promise.all(records.map(async (item) => this.mapItem(context, item, parents.get(item.id) ?? (item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined)))); }

  private async mapItem(context: EmbyContext, item: MediaItemRecord, parent?: MediaItemRecord): Promise<Record<string, unknown>> {
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "emby_item_not_found", "媒体条目不存在");
    // 关键变量：在线库独立读取线路定位，不构造网盘文件。
    const onlineLibrary = isContentSourceLibrary(context.libraryKind);
    let files = onlineLibrary ? [] : (await this.runtime.repository.listItemFiles(item.id, context.ownerUserId)).filter((file) => String(file.itemId) === item.id);
    const progress = await this.readProgress(context, item.id);
    const recentSourceId = String(progress?.media_source_id ?? "");
    const onlineSources = onlineLibrary ? prioritizeContentSources(await this.runtime.contentSources.listPlaybackSources(item.id, context.ownerUserId), recentSourceId) : [];
    // 详情沿用标准本地媒体入口，不读取源站地址；真正播放时执行该 Emby 库的三模式策略。
    if (recentSourceId) files = [...files].sort((left, right) => Number(String(right.fileId) === recentSourceId) - Number(String(left.fileId) === recentSourceId));
    const probes = files.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); const specsReady = files.length > 0 && probes.every(Boolean); const ticks = onlineLibrary ? readContentRunTimeTicks(onlineSources) : specsReady ? readJellyfinRunTimeTicks(probes) : 0;
    const type = item.itemType === "video.series" ? "Series" : item.itemType === "video.episode" ? "Episode" : "Movie"; const primaryTag = item.posterUrl ? String(Date.parse(item.updatedAt) || 1) : type === "Episode" && parent?.posterUrl ? String(Date.parse(parent.updatedAt) || 1) : "";
    const ownLogo = String(item.metadata.logoUrl ?? ""); const people = Array.isArray(item.metadata.people) ? item.metadata.people as Array<Record<string, unknown>> : []; const protocolId = encodeItemId(item.id);
    const season = Number(item.metadata.seasonNumber ?? 0); const favorite = await this.isFavorite(context, item.id);
    return { Name: item.title, OriginalTitle: String(item.metadata.originalTitle ?? ""), ServerId: context.libraryId, Id: protocolId, Etag: String(Date.parse(item.updatedAt) || 1), DateCreated: item.createdAt, SortName: item.sortTitle, PremiereDate: item.premiereDate ?? undefined, ProductionYear: item.year ?? undefined, Overview: item.overview, CommunityRating: Number(item.metadata.rating ?? 0) || undefined, Type: type, MediaType: "Video", IsFolder: type === "Series", LocationType: onlineLibrary ? "Remote" : "FileSystem", CanDownload: context.downloadEnabled && type !== "Series" && files.length > 0, ProviderIds: mapProviderIds(item.externalIds), ...(onlineLibrary ? { Tags: readContentFilterNames(item.metadata.tags), Studios: readContentFilterNames(item.metadata.studios).map((Name) => ({ Name })) } : {}), Genres: Array.isArray(item.metadata.genres) ? item.metadata.genres.map(String) : [], ImageTags: { ...(primaryTag ? { Primary: primaryTag } : {}), ...(ownLogo ? { Logo: imageTag(ownLogo) } : {}) }, PrimaryImageTag: primaryTag || undefined, PrimaryImageItemId: item.posterUrl ? protocolId : parent?.posterUrl ? encodeItemId(parent.id) : undefined, BackdropImageTags: item.backdropUrl ? [String(Date.parse(item.updatedAt) || 1)] : [], RunTimeTicks: ticks || undefined, Container: onlineSources[0]?.container ?? probes[0]?.container ?? undefined, Bitrate: probes[0]?.bitRate || undefined, MediaStreams: probes[0]?.mediaStreams ?? [], MediaSources: onlineLibrary ? onlineSources.map((source) => mapContentMediaSource(source, protocolId, context.accessToken, "", context.contentServerRoot)) : files.map((file, index) => ({ Protocol: "File", Id: context.libraryKind === "cloud_aggregate_video" || index > 0 ? String(file.fileId) : protocolId, Path: String(file.name ?? "video.mp4"), Name: `${String(file.sourceName ?? "网盘来源")}（${String(file.providerType ?? "未知网盘")}） · ${String(file.name ?? "video.mp4")}`, Type: "Default", Size: Number(file.size ?? 0) || undefined, Container: probes[index]?.container || undefined, SupportsTranscoding: false, SupportsDirectStream: true, SupportsDirectPlay: true })), SeriesId: type === "Episode" && parent ? encodeItemId(parent.id) : undefined, SeriesName: type === "Episode" ? parent?.title ?? item.subtitle : undefined, ParentIndexNumber: type === "Episode" ? season : undefined, IndexNumber: type === "Episode" ? Number(item.metadata.episodeNumber ?? 0) : undefined, SeasonId: type === "Episode" && parent ? encodeSeasonId(parent.id, season) : undefined, SeasonName: type === "Episode" ? videoSeasonTitle(season) : undefined, ParentId: type === "Episode" && parent ? encodeSeasonId(parent.id, season) : this.libraryForItem(context, item).id, People: people.map((person) => { const name = String(person.name ?? "").trim(); const profile = String(person.profileUrl ?? "").trim(); return { Name: name, Id: this.personId(person), Role: String(person.role ?? ""), Type: String(person.type ?? "").toLowerCase() === "cast" ? "Actor" : "Unknown", PrimaryImageTag: profile ? imageTag(profile) : undefined }; }), UserData: this.userData(progress, ticks, favorite, protocolId), DatePlayed: progress?.last_played_at ?? undefined };
  }

  /** 顶层条目属于其原源分类，单集仍保持原节目和季关系。 */
  private libraryForItem(context: EmbyLibraryContext, item: MediaItemRecord): EmbyLibraryDefinition {
    const roots = this.libraryDefinitions(context);
    if (isContentSourceLibrary(context.libraryKind)) {
      const categoryId = readJellyfinSourceCategoryId(item.metadata);
      const source = item.metadata.contentSource as Record<string, unknown> | undefined;
      return roots.find((entry) => entry.sourceCategoryId === categoryId) ?? this.sourceCategoryLibrary(context, {
        categoryId, name: categoryId === null ? "未分类" : String(source?.categoryName ?? `分类 ${categoryId}`),
        parentId: source?.parentCategoryId === undefined || source.parentCategoryId === null ? null : String(source.parentCategoryId),
      });
    }
    return roots.find((entry) => entry.itemType === (item.itemType === "video.movie" ? "video.movie" : "video.series")
      && entry.regionGroup === (context.regionLibrariesEnabled ? item.regionGroup : undefined)) ?? roots[0]!;
  }
  private personId(person: Record<string, unknown>): string { const source = String(person.id ?? "").trim(); const name = String(person.name ?? "").trim(); return protocolUuid("person", source ? `source:${source}` : `name:${name}`).toLowerCase(); }
  private async requireItem(context: EmbyLibraryContext, itemId: string): Promise<MediaItemRecord> { const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId); if (item.libraryId !== context.libraryId) throw new ApiError(404, "emby_item_not_found", "媒体条目不存在"); return item; }

  /** 详情和选集入口先验证账号所属媒体库，再按需补齐 Python 节目或电影。 */
  private async requireItemDetail(context: EmbyContext, itemId: string): Promise<MediaItemRecord> {
    const item = await this.requireItem(context, itemId);
    if (!isContentSourceLibrary(context.libraryKind)) return item;
    await this.runtime.contentSources.ensureItemDetail(context.libraryId, context.ownerUserId, item.id);
    // 关键变量：详情写入后的元数据与子集关系不能继续使用原列表卡片。
    return this.requireItem(context, item.id);
  }
  private async findParent(itemId: string, userId: string) { const relation = await this.runtime.database.query("media_relations").where({ child_item_id: itemId }).first(); return relation ? this.runtime.repository.getCatalogItem(String(relation.parent_item_id), userId) : undefined; }
  /** 根据当前有效单集计算节目整体观看状态，不能永久沿用历史父记录。 */
  private buildSeriesProgress(
    itemId: string,
    currentProgress: Record<string, unknown> | undefined,
    episodeIds: string[],
    progressByItemId: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> | undefined {
    if (episodeIds.length === 0) return currentProgress;
    const playedEpisodeCount = episodeIds.filter((episodeId) =>
      Number(progressByItemId.get(episodeId)?.played ?? 0) === 1).length;
    const allEpisodesPlayed = playedEpisodeCount === episodeIds.length; // 关键变量：整剧完成必须覆盖当前目录中的全部有效单集。
    const latestEpisodePlayedAt = episodeIds.map((episodeId) =>
      String(progressByItemId.get(episodeId)?.last_played_at ?? ""))
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    return {
      ...(currentProgress ?? {}),
      item_id: itemId,
      played: allEpisodesPlayed ? 1 : 0,
      position_ticks: 0,
      hidden_from_resume: allEpisodesPlayed ? 1 : 0,
      play_count: allEpisodesPlayed ? Math.max(1, Number(currentProgress?.play_count ?? 0)) : 0,
      last_played_at: allEpisodesPlayed ? currentProgress?.last_played_at ?? latestEpisodePlayedAt : null,
      unplayed_item_count: episodeIds.length - playedEpisodeCount,
    };
  }

  /** 读取单条进度；节目状态按当前有效单集动态汇总。 */
  private async readProgress(context: EmbyContext, itemId: string) {
    const currentProgress = await this.runtime.database.query("library_emby_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId }).first();
    const episodeRows = await this.runtime.database.query("media_relations as relation")
      .join("media_items as episode", "episode.id", "relation.child_item_id")
      .select("relation.child_item_id")
      .where({
        "relation.library_id": context.libraryId,
        "relation.parent_item_id": itemId,
        "relation.relation_type": "series_episode",
        "episode.library_id": context.libraryId,
        "episode.item_type": "video.episode",
      })
      .whereNull("episode.deleted_at");
    const episodeIds = episodeRows.map((row) => String(row.child_item_id));
    if (episodeIds.length === 0) return currentProgress;
    const episodeProgressRows = await this.runtime.database.query("library_emby_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId })
      .whereIn("item_id", episodeIds);
    const progressByItemId = new Map(episodeProgressRows.map((row) =>
      [String(row.item_id), row as Record<string, unknown>]));
    return this.buildSeriesProgress(itemId, currentProgress as Record<string, unknown> | undefined,
      episodeIds, progressByItemId);
  }

  /** 单集状态变化后持久化整剧汇总，保证 Emby 已观看筛选结果同步更新。 */
  private async synchronizeParentSeriesProgress(context: EmbyContext, episodeItemId: string, now: string): Promise<void> {
    const relation = await this.runtime.database.query("media_relations")
      .select("parent_item_id")
      .where({ library_id: context.libraryId, child_item_id: episodeItemId, relation_type: "series_episode" })
      .first();
    if (!relation) return;
    const seriesItemId = String(relation.parent_item_id); // 关键变量：需要随当前单集重新汇总的节目条目。
    const seriesProgress = await this.readProgress(context, seriesItemId);
    if (!seriesProgress) return;
    const existing = await this.runtime.database.query("library_emby_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: seriesItemId }).first();
    const patch = {
      played: Number(seriesProgress.played ?? 0), position_ticks: 0,
      hidden_from_resume: Number(seriesProgress.hidden_from_resume ?? 0),
      play_count: Number(seriesProgress.play_count ?? 0),
      last_played_at: seriesProgress.last_played_at ?? null, updated_at: now,
    };
    if (existing) await this.runtime.database.query("library_emby_playback_progress").where({ id: existing.id }).update(patch);
    else await this.runtime.database.query("library_emby_playback_progress").insert({
      id: randomUUID(), library_id: context.libraryId, account_id: context.accountId,
      item_id: seriesItemId, media_source_id: null, ...patch,
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-series-watched-state",
      事件: "单集状态变化后重算Emby整剧观看状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      节目条目ID: seriesItemId,
      单集条目ID: episodeItemId,
      是否整剧已观看: Number(seriesProgress.played ?? 0) === 1,
      未观看单集数: Number(seriesProgress.unplayed_item_count ?? 0),
    });
  }
  private async isFavorite(context: EmbyContext, itemId: string) { return Boolean(await this.runtime.database.query("library_emby_item_preferences").select("id").where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId }).whereNotNull("starred_at").first()); }
  private async isVirtualFavorite(context: EmbyContext, itemId: string) { return Boolean(await this.runtime.database.query("library_emby_virtual_preferences").select("id").where({ library_id: context.libraryId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase() }).first()); }
  private emptyUserData() { return this.userData(null, 0, false); }
  private userData(progress: Record<string, unknown> | null | undefined, runTimeTicks: number, favorite: boolean, protocolItemId?: string) { const played = Number(progress?.played ?? 0) === 1; const position = played ? 0 : Number(progress?.position_ticks ?? 0); const source = String(progress?.media_source_id ?? ""); return { PlaybackPositionTicks: position, PlayCount: Number(progress?.play_count ?? 0), IsFavorite: favorite, Played: played, LastPlayedDate: progress?.last_played_at ?? undefined, UnplayedItemCount: progress?.unplayed_item_count === undefined ? undefined : Number(progress.unplayed_item_count), PlayedPercentage: runTimeTicks > 0 && position > 0 ? position / runTimeTicks * 100 : undefined, Key: "", ItemId: protocolItemId, MediaSourceId: source ? (INTERNAL_ITEM_ID_PATTERN.test(source) ? encodeItemId(source) : source) : undefined }; }
  /** 在线来源按已探测时长计算进度，网盘仍沿用已完成的文件规格。 */
  private async readItemRunTimeTicks(item: MediaItemRecord, mediaSourceId?: string): Promise<number> {
    if (item.metadata.contentSource && typeof item.metadata.contentSource === "object") {
      const sources = await this.runtime.contentSources.listPlaybackSources(item.id, item.userId);
      if (sources.length > 0 && mediaSourceId && mediaSourceId !== item.id && !sources.some((source) => source.id === mediaSourceId)) {
        throw new ApiError(404, "content_playback_source_not_found", "指定在线播放来源不存在");
      }
      return readContentRunTimeTicks(sources, mediaSourceId, item.id);
    }
    const files = (await this.runtime.repository.listItemFiles(item.id, item.userId)).filter((file) => String(file.itemId) === item.id); const probes = files.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); if (files.length === 0 || probes.some((probe) => !probe)) return 0; if (mediaSourceId) { const index = mediaSourceId === item.id ? 0 : files.findIndex((file) => String(file.fileId) === mediaSourceId); return index >= 0 ? probes[index]?.runTimeTicks ?? 0 : 0; } return readJellyfinRunTimeTicks(probes); }
  /** 新增或更新播放进度，并返回本次是否首次达到完播阈值。 */
  private async upsertProgress(
    transaction: Knex | Knex.Transaction,
    context: EmbyContext,
    itemId: string,
    mediaSourceId: string | null,
    position: number,
    stopped: boolean,
    completed: boolean,
    now: string,
  ): Promise<boolean> {
    const existing = await transaction("library_emby_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId }).first();
    const alreadyPlayed = Number(existing?.played ?? 0) === 1;
    const newlyCompleted = completed && !alreadyPlayed;
    const playCount = newlyCompleted
      ? Math.max(1, Number(existing?.play_count ?? 0))
      : Number(existing?.play_count ?? 0) + (stopped && !completed ? 1 : 0);
    const patch = {
      media_source_id: mediaSourceId ?? existing?.media_source_id ?? null,
      position_ticks: completed ? 0 : position,
      played: completed || alreadyPlayed ? 1 : 0,
      hidden_from_resume: completed || alreadyPlayed ? 1 : 0,
      // 关键变量：待播入口开始播放后仍可续播，完播时清除待播标记。
      resume_pending: completed || alreadyPlayed ? 0 : Number(existing?.resume_pending ?? 0),
      last_played_at: now,
      updated_at: now,
      play_count: playCount,
    };
    if (existing) await transaction("library_emby_playback_progress").where({ id: existing.id }).update(patch);
    else await transaction("library_emby_playback_progress").insert({
      id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: itemId, ...patch,
    });
    return newlyCompleted;
  }
  /** 按媒体库目录版本建立完整演员索引，供标准人物详情、头像和关联作品接口共用。 */
  private async loadPersonCache(context: EmbyLibraryContext): Promise<EmbyPersonCache> {
    const cacheKey = `${context.serviceId}:${context.libraryId}`;
    const catalogVersion = Number((await this.runtime.database.query("media_libraries")
      .select("catalog_version").where({ id: context.libraryId }).first())?.catalog_version ?? 0);
    const cached = this.personCaches.get(cacheKey);
    if (cached?.catalogVersion === catalogVersion) return cached;

    // 关键变量：演员索引必须覆盖全部电影和节目，不能只读取每类最近 5000 条。
    const rows = await this.runtime.database.query("media_items")
      .select("id", "metadata_json")
      .where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" })
      .whereIn("item_type", ["video.movie", "video.series"])
      .whereNull("deleted_at");
    const peopleById = new Map<string, EmbyPersonSummary>();
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata_json);
      const people = Array.isArray(metadata.people) ? metadata.people as Array<Record<string, unknown>> : [];
      for (const person of people) {
        const name = String(person.name ?? "").trim();
        if (!name) continue;
        const personId = this.personId(person);
        const profileUrl = String(person.profileUrl ?? "").trim();
        const validProfileUrl = /^https?:\/\//iu.test(profileUrl) ? profileUrl : "";
        const existing = peopleById.get(personId);
        if (existing) {
          existing.itemIds.add(String(row.id));
          if (!existing.profileUrl && validProfileUrl) {
            existing.profileUrl = validProfileUrl;
            existing.imageTag = imageTag(validProfileUrl);
          }
          continue;
        }
        peopleById.set(personId, {
          id: personId,
          name,
          profileUrl: validProfileUrl,
          imageTag: validProfileUrl ? imageTag(validProfileUrl) : "",
          itemIds: new Set([String(row.id)]),
        });
      }
    }

    const next = { catalogVersion, peopleById };
    this.personCaches.set(cacheKey, next);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-emby-person",
      事件: "建立Emby演员索引",
      媒体库ID: context.libraryId,
      目录版本: catalogVersion,
      影视条目数量: rows.length,
      演员数量: peopleById.size,
    });
    return next;
  }
  private queryString(query: Record<string, unknown>, key: string): string { const camel = `${key.charAt(0).toLowerCase()}${key.slice(1)}`; return String(query[key] ?? query[camel] ?? "").trim(); }
  /** 保留支持的首个排序字段；显式未知排序统一回退标题升序，未指定时沿用默认顺序。 */
  private readSort(query: Record<string, unknown>): CatalogSort {
    const names = this.queryString(query, "SortBy").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (names.length === 0) return "created_desc";
    const supportedIndex = names.findIndex((name) => ["productionyear", "premieredate", "sortname", "name", "datecreated", "random"].includes(name));
    if (supportedIndex < 0) return "title_asc";
    const directions = this.queryString(query, "SortOrder").split(",").map((value) => value.trim().toLowerCase());
    const desc = (directions[supportedIndex] ?? directions[0]) === "descending";
    const name = names[supportedIndex];
    if (name === "productionyear") return desc ? "year_desc" : "year_asc";
    if (name === "premieredate") return desc ? "premiere_date_desc" : "premiere_date_asc";
    if (name === "sortname" || name === "name") return desc ? "title_desc" : "title_asc";
    return desc ? "created_desc" : "created_asc";
  }

  /** 在筛选后按标题完成排序回退，兼顾混合类型、人物作品和批量回查；不改变默认季集顺序。 */
  private sortFallbackItems(items: Record<string, unknown>[], query: Record<string, unknown>): Record<string, unknown>[] {
    if (!this.queryString(query, "SortBy") || items.length === 0) return items;
    const sort = this.readSort(query);
    if (this.queryString(query, "SortBy").split(",").some((name) => name.trim().toLowerCase() === "random")) return items;
    const isTitleSort = sort === "title_asc" || sort === "title_desc";
    const valueField = sort === "year_asc" || sort === "year_desc" ? "ProductionYear"
      : sort === "premiere_date_asc" || sort === "premiere_date_desc" ? "PremiereDate" : "DateCreated";
    const hasSortValues = items.some((item) => item[valueField] !== null && item[valueField] !== undefined && item[valueField] !== "");
    if (!isTitleSort && hasSortValues) return items;
    // 关键变量：缺值或未知字段固定标题升序，支持的标题降序仍保持客户端指定方向。
    const direction = sort === "title_desc" ? -1 : 1;
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    return items.sort((left, right) => direction * collator.compare(String(left.SortName ?? left.Name ?? ""), String(right.SortName ?? right.Name ?? ""))
      || String(left.Id).localeCompare(String(right.Id)));
  }
  private paginate<T>(items: T[], query: Record<string, unknown>) { const start = Math.max(0, Number(this.queryString(query, "StartIndex") || 0)); const limit = Math.min(500, Math.max(1, Number(this.queryString(query, "Limit") || items.length || 100))); return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start }; }
  /** Ids、外部编号、条目类型和账号状态共同筛选完成后再分页。 */
  private filterAndPaginate(items: Record<string, unknown>[], query: Record<string, unknown>, context?: EmbyContext, required: { favorite?: boolean; played?: boolean } = {}) {
    const favorite = this.queryString(query, "IsFavorite") === "true" || this.queryString(query, "Filters").split(",").includes("IsFavorite");
    const played = this.queryString(query, "IsPlayed") === "true" || this.queryString(query, "Filters").split(",").includes("IsPlayed");
    const include = this.queryString(query, "IncludeItemTypes").split(",").map((type) => type.trim()).filter(Boolean);
    const identityFilter = readProtocolItemIdentityFilter(query, decodeItemId);
    const contentFilters = isContentSourceLibrary(context?.libraryKind) ? readProtocolContentFilters(query, required) : undefined;
    const matchedItems = items.filter((item) => {
      if (include.length > 0 && !include.includes(String(item.Type))) return false;
      if (!matchesProtocolItemIdentity(identityFilter, decodeItemId(String(item.Id)),
        (item.ProviderIds ?? {}) as Record<string, unknown>)) return false;
      const userData = item.UserData as Record<string, unknown> | undefined;
      if (contentFilters) return matchesContentFilterDto(contentFilters, item);
      return (!favorite || Boolean(userData?.IsFavorite)) && (!played || Boolean(userData?.Played));
    });
    return this.paginate(this.sortFallbackItems(matchedItems, query), query);
  }
  private requireLoginAllowed(key: string) { const value = this.loginFailures.get(key); if (value && value.blockedUntil > Date.now()) throw new ApiError(429, "emby_login_rate_limited", "登录失败次数过多，请稍后再试"); }
  private recordLoginFailure(key: string) { const now = Date.now(); const old = this.loginFailures.get(key); const next = !old || now - old.firstFailedAt > 10 * 60 * 1000 ? { count: 1, firstFailedAt: now, blockedUntil: 0 } : { ...old, count: old.count + 1 }; if (next.count >= 8) next.blockedUntil = now + 15 * 60 * 1000; this.loginFailures.set(key, next); return next.blockedUntil; }
}
