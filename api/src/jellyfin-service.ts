import { readVideoSeason, videoSeasonTitle, encodeVideoSeasonNumber, decodeVideoSeasonNumber } from "./media/video-season.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hashSessionToken } from "./auth.js";
import { parseJsonObject, type MediaItemRecord, type VideoRegionGroup } from "./domain.js";
import { JellyfinCatalogSort, readJellyfinSortQuery, type JellyfinSortEntry, type JellyfinSortFilters } from "./jellyfin-catalog-sort.js";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";
import { hydrateRealtimeVideoDetails } from "./media/realtime-video-details.js";
import { prepareNextEpisodeResume } from "./media/episode-resume.js";
import { readProtocolItemIdentityFilter, matchesProtocolItemIdentity, resolveProtocolItemIdentityIds } from "./media/protocol-item-identity-filter.js";
import {
  parseCompletedMediaProbeResult,
  readJellyfinRunTimeTicks,
  type MediaProbeResult,
} from "./media/media-probe.js";

/** Jellyfin 媒体库和图片读取共用的服务上下文。 */
export interface JellyfinLibraryContext {
  serviceId: string;
  ownerUserId: string;
  libraryId: string;
  libraryKind: string;
  /** 是否按节目地区拆分 Jellyfin 虚拟媒体库。 */
  regionLibrariesEnabled: boolean;
}

export interface JellyfinContext extends JellyfinLibraryContext {
  accountId: string;
  accountUsername: string;
  accountHasPassword: boolean;
  credentialRevision: number;
  accessToken: string;
  /** 当前媒体库是否允许 Jellyfin 客户端下载原始影片文件。 */
  downloadEnabled: boolean;
}

interface JellyfinFileSummary {
  fileId: string;
  name: string;
  sourceName: string;
  providerType: string;
  size: number;
  /** 当前源文件已经完成的 ffprobe 结果；尚未完成或失败时为空。 */
  mediaProbe: MediaProbeResult | null;
}

interface JellyfinItemMappingContext {
  progressByItemId: Map<string, Record<string, unknown>>;
  /** 当前账号已收藏的内部媒体条目 ID。 */
  favoriteItemIds: Set<string>;
  filesByItemId: Map<string, JellyfinFileSummary[]>;
}

type JellyfinCollectionType = "movies" | "tvshows";

interface JellyfinLibraryDefinition {
  /** 云助手内部用于识别虚拟媒体库的旧 ID。 */
  internalId: string;
  /** 返回给 Jellyfin 客户端的标准 UUID。 */
  id: string;
  name: string;
  collectionType: JellyfinCollectionType;
  itemType: "video.movie" | "video.series";
  regionGroup?: VideoRegionGroup;
}

interface JellyfinGenreSummary {
  name: string;
  itemCount: number;
}

interface JellyfinSeasonReference {
  seriesId: string;
  seasonNumber: number;
}

/** Jellyfin 标准图片接口实际需要代理的远端图片。 */
export interface JellyfinImageSource {
  url: string;
  imageTag: string;
  updatedAt: string;
  sourceType: "media" | "person";
}

interface JellyfinPersonSummary {
  id: string;
  name: string;
  sourceId: string;
  profileUrl: string;
  imageTag: string;
  updatedAt: string;
  /** 当前演员直接关联的顶层电影或节目 ID。 */
  itemIds: Set<string>;
}

interface JellyfinPersonCache {
  catalogVersion: number;
  peopleById: Map<string, JellyfinPersonSummary>;
}

const JELLYFIN_ITEM_UUID_PREFIX = "f10c0000";
const JELLYFIN_SEASON_UUID_PREFIX = "f2";
const JELLYFIN_USER_STATE_BATCH_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INTERNAL_ITEM_ID_PATTERN = /^itm_([0-9a-f]{24})$/iu;

/** 把 32 位十六进制值格式化为 Jellyfin 可以解析的标准 UUID。 */
function formatProtocolUuid(hexValue: string): string {
  const hex = hexValue.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 为无法直接编码的虚拟实体生成稳定的 RFC 4122 version 5 形式 UUID。 */
function createProtocolUuid(scope: string, value: string): string {
  const digest = createHash("sha256").update(`flycloud-jellyfin\u0000${scope}\u0000${value}`, "utf8").digest();
  // 关键变量：版本位和变体位按 UUID v5/RFC 4122 设置，严格 SDK 可以直接反序列化。
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return formatProtocolUuid(digest.toString("hex").slice(0, 32));
}

/** 根据远端图片地址生成稳定的 Jellyfin ImageTag。 */
function createJellyfinImageTag(imageUrl: string): string {
  return createHash("sha256").update(imageUrl, "utf8").digest("hex").slice(0, 32);
}

/** 按 Jellyfin 图片类型读取媒体条目保存的图片地址。 */
function readJellyfinImageUrl(item: MediaItemRecord, imageType: string): string {
  const normalizedType = imageType.trim().toLowerCase();
  if (normalizedType === "backdrop") return String(item.backdropUrl ?? "").trim();
  if (normalizedType === "logo") return String(item.metadata.logoUrl ?? "").trim();
  return String(item.posterUrl ?? "").trim();
}

/** 将内部 itm_ ID 可逆编码为标准 UUID；已有 UUID 保持不变。 */
function encodeProtocolItemId(itemId: string): string {
  if (UUID_PATTERN.test(itemId)) return itemId.toLowerCase();
  const match = INTERNAL_ITEM_ID_PATTERN.exec(itemId);
  if (!match?.[1]) return createProtocolUuid("item", itemId);
  return formatProtocolUuid(`${JELLYFIN_ITEM_UUID_PREFIX}${match[1]}`);
}

/** 将协议 UUID 还原为云助手内部 itm_ ID，同时继续接受旧客户端传入的内部 ID。 */
function decodeProtocolItemId(itemId: string): string {
  const normalized = itemId.trim().toLowerCase();
  if (INTERNAL_ITEM_ID_PATTERN.test(normalized)) return normalized;
  const compact = normalized.replace(/-/gu, "");
  if (compact.length === 32 && compact.startsWith(JELLYFIN_ITEM_UUID_PREFIX)) {
    return `itm_${compact.slice(JELLYFIN_ITEM_UUID_PREFIX.length)}`;
  }
  if (UUID_PATTERN.test(normalized)) return normalized;
  return itemId;
}

/** 将内部节目和季编号编码为可逆的标准 UUID。 */
function encodeProtocolSeasonId(seriesId: string, seasonNumber: number): string {
  const match = INTERNAL_ITEM_ID_PATTERN.exec(seriesId);
  if (!match?.[1]) return createProtocolUuid("season", `${seriesId}:${seasonNumber}`);
  const normalizedSeason = encodeVideoSeasonNumber(seasonNumber);
  const seasonPrefix = `${JELLYFIN_SEASON_UUID_PREFIX}${normalizedSeason.toString(16).padStart(6, "0")}`;
  return formatProtocolUuid(`${seasonPrefix}${match[1]}`);
}

/** 把数据库日期转换为 Jellyfin SDK 使用的完整 ISO DateTime。 */
function toJellyfinDateTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** 将常见外部媒体库键名转换为 Jellyfin 使用的标准大小写。 */
function mapJellyfinProviderIds(providerIds: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  Object.entries(providerIds).forEach(([key, value]) => {
    const normalized = key.toLowerCase();
    const protocolKey = normalized === "tmdb" ? "Tmdb"
      : normalized === "imdb" ? "Imdb"
        : normalized === "tvdb" ? "Tvdb"
          : key;
    mapped[protocolKey] = value;
  });
  return mapped;
}

/** 将 TMDB/NFO 人员类型映射为 Jellyfin PersonKind。 */
function mapJellyfinPersonKind(person: Record<string, unknown>): string {
  const sourceType = String(person.type ?? "").toLowerCase();
  if (sourceType === "cast" || sourceType === "actor") return "Actor";
  const role = String(person.role ?? "").toLowerCase();
  if (role.includes("director")) return "Director";
  if (role.includes("producer")) return "Producer";
  if (role.includes("writer") || role.includes("screenplay") || role.includes("creator")) return "Writer";
  return "Unknown";
}

/** 把目录文件映射为不包含转码能力的标准 Jellyfin MediaSourceInfo。 */
function mapCatalogMediaSource(
  file: JellyfinFileSummary,
  mediaSpecsReady: boolean,
  protocolMediaSourceId: string,
): Record<string, unknown> {
  const fileName = String(file.name || "video.mp4");
  const mediaProbe = mediaSpecsReady ? file.mediaProbe : null;
  const fileRunTimeTicks = mediaProbe?.runTimeTicks ?? 0;
  return {
    Protocol: "File",
    // 关键变量：Jellyfin 客户端使用条目 ID 识别条目自身的主媒体源。
    Id: protocolMediaSourceId,
    Path: fileName,
    EncoderPath: null,
    EncoderProtocol: null,
    Type: "Default",
    Container: mediaProbe?.container || undefined,
    Size: mediaProbe?.size || undefined,
    Name: `${file.sourceName || "网盘来源"}（${file.providerType || "未知网盘"}） · ${fileName}`,
    IsRemote: false,
    ETag: null,
    RunTimeTicks: fileRunTimeTicks || undefined,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    OpenToken: null,
    RequiresClosing: false,
    LiveStreamId: null,
    BufferMs: null,
    RequiresLooping: false,
    SupportsProbing: false,
    MediaStreams: mediaProbe?.mediaStreams ?? [],
    MediaAttachments: [],
    Formats: [],
    Bitrate: mediaProbe?.bitRate || undefined,
    RequiredHttpHeaders: {},
    TranscodingUrl: null,
    TranscodingSubProtocol: null,
    TranscodingContainer: null,
    AnalyzeDurationMs: null,
    DefaultAudioStreamIndex: null,
    DefaultSubtitleStreamIndex: null,
  };
}

/** 从 MediaBrowser 认证头或 Jellyfin 常见参数中读取访问令牌。 */
export function readJellyfinToken(request: FastifyRequest): string {
  const direct = request.headers["x-emby-token"] ?? request.headers["x-mediabrowser-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const query = request.query as Record<string, unknown> | undefined;
  const queryToken = query?.api_key ?? query?.ApiKey ?? query?.access_token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  const authorization = request.headers.authorization ?? "";
  const match = authorization.match(/(?:Token|token)\s*=\s*"?([^",\s]+)"?/u);
  return match?.[1]?.trim() ?? "";
}

/** 读取认证头中的客户端和设备字段，仅用于会话展示。 */
function readAuthorizationAttribute(request: FastifyRequest, key: string): string | null {
  const mediaBrowserHeader = request.headers["x-emby-authorization"] ?? request.headers["x-mediabrowser-authorization"];
  const authorization = typeof mediaBrowserHeader === "string" ? mediaBrowserHeader : request.headers.authorization ?? "";
  const match = authorization.match(new RegExp(`${key}=(?:"([^"]*)"|([^,\\s]*))`, "iu"));
  return (match?.[1] ?? match?.[2])?.slice(0, 255) ?? null;
}

/** Jellyfin 协议的认证、目录和播放进度服务。 */
export class JellyfinCompatibilityService {
  // 关键变量：登录失败按服务和来源地址隔离，避免攻击一个服务影响其他服务。
  private readonly loginFailures = new Map<string, { count: number; firstFailedAt: number; blockedUntil: number }>();
  // 关键变量：演员 UUID 无法反解详情，按媒体库版本缓存演员实体及其关联作品索引。
  private readonly personCaches = new Map<string, JellyfinPersonCache>();
  /** Jellyfin 专属排序，不复用 Emby 或云盘 CatalogSort 的字段映射。 */
  private readonly catalogSort: JellyfinCatalogSort;

  public constructor(private readonly runtime: ApiRuntime) {
    this.catalogSort = new JellyfinCatalogSort(runtime);
  }

  /** 将数据库媒体条目 ID 转换为客户端使用的标准 UUID。 */
  public toProtocolItemId(itemId: string): string {
    return encodeProtocolItemId(itemId);
  }

  /** 将客户端 UUID 或旧内部 ID 转换为数据库媒体条目 ID。 */
  public toInternalItemId(itemId: string): string {
    return decodeProtocolItemId(itemId);
  }

  /** 将主媒体源 UUID 还原为内部条目 ID，其他文件媒体源 ID 保持不变。 */
  public toInternalMediaSourceId(itemId: string, mediaSourceId: string): string {
    if (!mediaSourceId) return mediaSourceId;
    const internalItemId = decodeProtocolItemId(itemId);
    return mediaSourceId === encodeProtocolItemId(internalItemId) || mediaSourceId === internalItemId
      ? internalItemId
      : mediaSourceId;
  }

  /** 根据媒体库自定义地址后缀解析媒体库 ID。 */
  public async resolveLibraryIdByPathSuffix(pathSuffix: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries as l")
      .select("l.id")
      .where("l.jellyfin_path_suffix_lookup", pathSuffix.toLowerCase())
      .first();
    if (!row) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务地址不存在");
    return String(row.id);
  }

  /** 校验媒体库与来源服务启用状态，不要求客户端已登录。 */
  public async requireEnabledService(libraryId: string) {
    const row = await this.runtime.database.query("media_libraries as l")
      .select(
        "l.id", "l.user_id", "l.id as library_id", "l.display_name", "l.status",
        "l.jellyfin_enabled", "l.jellyfin_relay_playback_enabled", "l.jellyfin_download_enabled",
        "l.jellyfin_region_libraries_enabled", "l.library_kind",
      )
      .where("l.id", libraryId).first();
    if (!row) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务不存在");
    if (Number(row.jellyfin_enabled) !== 1 || row.status === "disabled") throw new ApiError(404, "jellyfin_service_disabled", "Jellyfin 服务未启用");
    return row;
  }

  /** 为 Jellyfin 公开图片接口生成仅包含媒体归属的上下文。 */
  public async resolvePublicImageContext(libraryId: string): Promise<JellyfinLibraryContext> {
    const service = await this.requireEnabledService(libraryId);
    return {
      serviceId: String(service.id),
      ownerUserId: String(service.user_id),
      libraryId,
      libraryKind: String(service.library_kind ?? "single_source"),
      regionLibrariesEnabled: Number(service.jellyfin_region_libraries_enabled) === 1,
    };
  }

  /** 使用服务独立账号登录并创建仅属于该服务的 Jellyfin 会话。 */
  public async login(libraryId: string, request: FastifyRequest, body: Record<string, unknown>) {
    const service = await this.requireEnabledService(libraryId);
    const serviceId = String(service.id); // 关键变量：来源服务 ID 只用于网盘访问和诊断日志。
    const loginKey = `${libraryId}:${request.ip}`;
    this.requireLoginAllowed(loginKey);
    let account;
    try {
      account = await this.runtime.serviceAccess.authenticate(libraryId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password);
      this.loginFailures.delete(loginKey);
    } catch (error) {
      const blockedUntil = this.recordLoginFailure(loginKey);
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-jellyfin-compat",
        事件: "Jellyfin服务账号登录失败",
        服务ID: serviceId, 来源地址: request.ip, 是否已临时限制: blockedUntil > Date.now(),
      });
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const protocolSessionId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.runtime.config.refreshTokenTtlSeconds * 1000).toISOString();
    await this.runtime.database.query("library_protocol_sessions").insert({
      id: protocolSessionId,
      library_id: libraryId,
      account_id: account.id, protocol: "jellyfin",
      token_hash: hashSessionToken(token), credential_revision: account.credentialRevision,
      device_id: readAuthorizationAttribute(request, "DeviceId")
        ?? (String((request.query as Record<string, unknown>)?.DeviceId ?? "").slice(0, 255) || null),
      device_name: readAuthorizationAttribute(request, "Device"), client_name: readAuthorizationAttribute(request, "Client"),
      expires_at: expiresAt, last_seen_at: now, revoked_at: null, created_at: now,
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat",
      事件: "Jellyfin服务账号登录成功",
      服务ID: serviceId, 服务访问账号ID: account.id, 客户端名称: readAuthorizationAttribute(request, "Client") ?? "未知",
    });
    return {
      User: this.mapUser(
        account.id,
        account.username,
        libraryId,
        account.hasPassword,
        Number(service.jellyfin_download_enabled) === 1,
      ),
      SessionInfo: { Id: protocolSessionId, ServerId: libraryId, UserId: account.id, UserName: account.username, Client: readAuthorizationAttribute(request, "Client") ?? "Jellyfin" },
      AccessToken: token,
      ServerId: libraryId,
    };
  }

  /** 验证 Jellyfin 会话并强制 serviceId、账号和凭据修订一致。 */
  public async authenticate(libraryId: string, request: FastifyRequest): Promise<JellyfinContext> {
    const token = readJellyfinToken(request);
    if (!token) throw new ApiError(401, "jellyfin_token_required", "需要 Jellyfin 访问令牌");
    const row = await this.runtime.database.query("library_protocol_sessions as ps")
      .join("library_access_accounts as a", "a.id", "ps.account_id")
      .join("media_libraries as l", "l.id", "ps.library_id")
      .select(
        "ps.*", "a.username", "a.password_required", "a.credential_revision as account_revision",
        "a.status as account_status", "l.id as service_id", "l.user_id", "l.id as library_id", "l.status as service_status",
        "l.jellyfin_enabled", "l.jellyfin_region_libraries_enabled", "l.jellyfin_download_enabled", "l.library_kind",
      )
      .where("ps.token_hash", hashSessionToken(token)).where("ps.library_id", libraryId).where("ps.protocol", "jellyfin").whereNull("ps.revoked_at").first();
    if (!row || String(row.expires_at) <= new Date().toISOString() || Number(row.credential_revision) !== Number(row.account_revision)
      || row.account_status !== "active" || row.service_status === "disabled" || Number(row.jellyfin_enabled) !== 1) {
      throw new ApiError(401, "jellyfin_session_invalid", "Jellyfin 登录已失效，请重新登录");
    }
    // 关键变量：媒体 Range 和图片请求频繁，最多每五分钟落一次会话活跃时间，避免播放期间持续写库。
    if (String(row.last_seen_at) < new Date(Date.now() - 5 * 60 * 1000).toISOString()) {
      await this.runtime.database.query("library_protocol_sessions").where({ id: row.id }).update({ last_seen_at: new Date().toISOString() });
    }
    return {
      serviceId: String(row.service_id), ownerUserId: String(row.user_id), libraryId,
      libraryKind: String(row.library_kind ?? "single_source"),
      regionLibrariesEnabled: Number(row.jellyfin_region_libraries_enabled) === 1,
      accountId: String(row.account_id), accountUsername: String(row.username),
      accountHasPassword: Number(row.password_required ?? 1) !== 0,
      credentialRevision: Number(row.account_revision), accessToken: token,
      downloadEnabled: Number(row.jellyfin_download_enabled) === 1,
    };
  }

  /** 撤销当前 Jellyfin 会话。 */
  public async logout(libraryId: string, request: FastifyRequest): Promise<void> {
    const token = readJellyfinToken(request);
    if (!token) return;
    const now = new Date().toISOString();
    await this.runtime.database.query("library_protocol_sessions")
      .where({ library_id: libraryId, protocol: "jellyfin", token_hash: hashSessionToken(token) })
      .whereNull("revoked_at").update({ revoked_at: now });
  }

  /** 构造 Jellyfin 用户 DTO，服务访问账号没有管理权限。 */
  public mapUser(
    accountId: string,
    username: string,
    serviceId = "",
    hasPassword = true,
    downloadEnabled = true,
  ) {
    // 关键变量：Flymby 会依据 PrimaryImageTag 请求用户头像，使用账号和服务生成稳定缓存标记。
    const primaryImageTag = createJellyfinImageTag(`${serviceId}:${accountId}:${username}`);
    return {
      Name: username, ServerId: serviceId, Id: accountId,
      PrimaryImageTag: primaryImageTag,
      HasPassword: hasPassword, HasConfiguredPassword: hasPassword,
      EnableAutoLogin: false, Configuration: {}, Policy: {
        IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableMediaPlayback: true,
        EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false,
        EnableContentDownloading: downloadEnabled, EnableContentDeletion: false,
      },
    };
  }

  /** 根据媒体库开关返回电影和节目虚拟媒体库定义。 */
  private getLibraryDefinitions(context: JellyfinLibraryContext): JellyfinLibraryDefinition[] {
    const movieInternalId = `${context.libraryId}:movies`;
    const movieLibrary: JellyfinLibraryDefinition = {
      internalId: movieInternalId,
      id: createProtocolUuid("library", movieInternalId),
      name: "电影", collectionType: "movies", itemType: "video.movie",
    };
    if (!context.regionLibrariesEnabled) {
      const seriesInternalId = `${context.libraryId}:tvshows`;
      return [movieLibrary, {
        internalId: seriesInternalId,
        id: createProtocolUuid("library", seriesInternalId),
        name: "节目", collectionType: "tvshows", itemType: "video.series",
      }];
    }
    /** 地区媒体库使用内部旧 ID 查询，使用稳定 UUID 对外传输。 */
    const regionLibrary = (
      suffix: string,
      name: string,
      regionGroup: VideoRegionGroup,
    ): JellyfinLibraryDefinition => {
      const internalId = `${context.libraryId}:tvshows:${suffix}`;
      return {
        internalId,
        id: createProtocolUuid("library", internalId),
        name,
        collectionType: "tvshows",
        itemType: "video.series",
        regionGroup,
      };
    };
    return [
      movieLibrary,
      regionLibrary("chinese", "华语节目", "chinese"),
      regionLibrary("japan-korea", "日韩节目", "japan_korea"),
      regionLibrary("europe-america", "欧美节目", "europe_america"),
      regionLibrary("other", "其他节目", "other"),
    ];
  }

  /** 根据 Jellyfin 虚拟媒体库 ID 读取媒体类型约束。 */
  private findLibraryDefinition(context: JellyfinLibraryContext, libraryId: string): JellyfinLibraryDefinition | undefined {
    return this.getLibraryDefinitions(context).find((library) => library.id === libraryId || library.internalId === libraryId);
  }

  /** 解析云助手生成的虚拟季 ID，供季集查询和图片路由共用。 */
  private parseSeasonReference(value: string): JellyfinSeasonReference | null {
    const legacyMatch = value.match(/^season:([^:]+):(-2|\d+)$/u);
    if (legacyMatch?.[1]) return { seriesId: legacyMatch[1], seasonNumber: Number(legacyMatch[2] ?? 0) };
    const compact = value.trim().toLowerCase().replace(/-/gu, "");
    if (compact.length !== 32 || !compact.startsWith(JELLYFIN_SEASON_UUID_PREFIX)) return null;
    const seasonNumber = decodeVideoSeasonNumber(Number.parseInt(compact.slice(2, 8), 16));
    const itemPayload = compact.slice(8);
    if (!Number.isFinite(seasonNumber) || !/^[0-9a-f]{24}$/u.test(itemPayload)) return null;
    return { seriesId: `itm_${itemPayload}`, seasonNumber };
  }

  /** 只对显式排序的子项重新排序，未指定 SortBy 时保留原有季集顺序。 */
  private async sortChildRecords<T>(
    context: JellyfinContext, query: Record<string, unknown>, records: T[], readId: (record: T) => string,
  ): Promise<T[]> {
    if (!readJellyfinSortQuery(query, "SortBy") || records.length === 0) return records;
    const plan = this.catalogSort.readPlan(context, query);
    const entries = await this.catalogSort.load(context, { itemIds: records.map(readId) }, plan);
    const recordsById = new Map(records.map((record) => [readId(record), record]));
    this.catalogSort.log(context, plan, entries, 0, entries.length);
    return entries.map((entry) => recordsById.get(entry.id)).filter((record): record is T => record !== undefined);
  }

  /** 普通列表只装配当前页，并批量获取单集父节目，保持图片和播放信息映射不变。 */
  private async mapSortedMediaEntries(context: JellyfinContext, entries: JellyfinSortEntry[]): Promise<Array<Record<string, unknown>>> {
    if (entries.length === 0) return [];
    const ids = entries.map((entry) => entry.id);
    const records = await this.runtime.repository.listCatalogItemsByIds(ids, context.ownerUserId);
    const recordsById = new Map(records.filter((record) => record.libraryId === context.libraryId).map((record) => [record.id, record]));
    const episodeIds = records.filter((record) => record.itemType === "video.episode").map((record) => record.id);
    const relations = episodeIds.length === 0 ? [] : await this.runtime.database.query("media_relations")
      .where("user_id", context.ownerUserId).whereIn("child_item_id", episodeIds).select("child_item_id", "parent_item_id");
    const parents = await this.runtime.repository.listCatalogItemsByIds([...new Set(relations.map((row) => String(row.parent_item_id)))], context.ownerUserId);
    const parentsById = new Map(parents.filter((parent) => parent.libraryId === context.libraryId).map((parent) => [parent.id, parent]));
    const parentByChildId = new Map(relations.map((row) => [String(row.child_item_id), parentsById.get(String(row.parent_item_id))]));
    const mapping = await this.loadItemMappingContext(context, ids);
    const mapped: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      const record = recordsById.get(entry.id);
      if (record) mapped.push(await this.mapItem(context, record, parentByChildId.get(record.id), mapping));
    }
    return this.attachSortedDates(context, mapped, entries);
  }

  /** 返回本次排序实际采用的内容日期，便于客户端展示和定位；不改写数据库。 */
  private attachSortedDates(context: JellyfinContext, items: Array<Record<string, unknown>>, entries: JellyfinSortEntry[]): Array<Record<string, unknown>> {
    const valuesById = new Map(entries.map((entry) => [entry.id, entry.values]));
    return items.map((item) => {
      const values = valuesById.get(this.toInternalItemId(String(item.Id)));
      if (!values) return item;
      return {
        ...item,
        ...(typeof values.datelastcontentadded === "number" ? { DateLastMediaAdded: new Date(values.datelastcontentadded).toISOString() } : {}),
        ...(typeof values.lastcontentpremieredate === "number" ? { LastContentPremiereDate: new Date(values.lastcontentpremieredate).toISOString() } : {}),
      };
    });
  }

  /** 候选集合完成全局排序后再分页，文件、规格、图片仍使用原映射逻辑。 */
  private async listSortedCatalogPage(context: JellyfinContext, query: Record<string, unknown>, filters: JellyfinSortFilters) {
    const plan = this.catalogSort.readPlan(context, query);
    const entries = await this.catalogSort.load(context, filters, plan);
    const page = this.paginate(entries, { ...query, Limit: this.readQueryValue(query, "Limit") ?? 100 });
    const items = await this.mapSortedMediaEntries(context, page.Items);
    this.catalogSort.log(context, plan, entries, page.StartIndex, items.length);
    return { Items: items, TotalRecordCount: entries.length, StartIndex: page.StartIndex };
  }

  /** 获取媒体条目在 Jellyfin 中所属的电影或节目媒体库。 */
  private getItemLibraryDefinition(context: JellyfinContext, item: MediaItemRecord): JellyfinLibraryDefinition {
    const collectionType: JellyfinCollectionType = item.itemType === "video.movie" ? "movies" : "tvshows";
    return this.getLibraryDefinitions(context).find((library) => library.collectionType === collectionType
      && (collectionType === "movies" || !context.regionLibrariesEnabled || library.regionGroup === item.regionGroup))
      ?? this.getLibraryDefinitions(context)[0]!;
  }

  /** 将分类名称编码为标准且稳定的 Jellyfin 分类 UUID。 */
  private encodeGenreId(name: string): string {
    return createProtocolUuid("genre", name.trim());
  }

  /** 从 Jellyfin 分类 ID 还原分类名称，拒绝非本服务生成的格式。 */
  private decodeLegacyGenreId(genreId: string): string | null {
    if (!genreId.startsWith("genre:")) return null;
    try {
      const name = Buffer.from(genreId.slice("genre:".length), "base64url").toString("utf8").trim();
      return name || null;
    } catch {
      return null;
    }
  }

  /** 读取 Items 查询中的分类 ID 或分类名称。 */
  private async readGenreNames(context: JellyfinContext, query: Record<string, unknown>): Promise<string[]> {
    const genreIds = String(query.GenreIds ?? "").split(/[|,]/u).map((genreId) => genreId.trim()).filter(Boolean);
    const names = genreIds.map((genreId) => this.decodeLegacyGenreId(genreId))
      .filter((name): name is string => Boolean(name));
    String(query.Genres ?? "").split(/[|,]/u).map((name) => name.trim()).filter(Boolean).forEach((name) => names.push(name));
    const unresolvedIds = new Set(genreIds.filter((genreId) => !genreId.startsWith("genre:")));
    if (unresolvedIds.size > 0) {
      const rows = await this.runtime.database.query("media_items")
        .select("metadata_json")
        .where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" })
        .whereNull("deleted_at");
      // 关键变量：分类 UUID 是稳定单向值，只有收到 GenreIds 过滤时才从当前媒体库名称反查。
      rows.forEach((row) => {
        const metadata = parseJsonObject(row.metadata_json);
        if (!Array.isArray(metadata.genres)) return;
        metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).forEach((name) => {
          if (unresolvedIds.has(this.encodeGenreId(name))) names.push(name);
        });
      });
    }
    return [...new Set(names)];
  }

  /** 将分类名称映射为 Jellyfin Genre 条目。 */
  private mapGenre(context: JellyfinContext, genre: JellyfinGenreSummary) {
    return {
      Name: genre.name, ServerId: context.libraryId, Id: this.encodeGenreId(genre.name), Type: "Genre",
      IsFolder: true, ChildCount: genre.itemCount, RecursiveItemCount: genre.itemCount,
      ImageTags: {}, BackdropImageTags: [], UserData: this.mapUserData(null, 0),
    };
  }

  /** 将数据库媒体条目映射为 Flymby 所需的 Jellyfin BaseItemDto。 */
  public async mapItem(context: JellyfinContext, item: MediaItemRecord, parent?: MediaItemRecord, mapping?: JellyfinItemMappingContext) {
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const progress = mapping ? mapping.progressByItemId.get(item.id) : await this.readProgress(context, item.id);
    const metadata = item.metadata;
    const type = item.itemType === "video.series" ? "Series" : item.itemType === "video.episode" ? "Episode" : "Movie";
    const seasonNumber = Number(metadata.seasonNumber ?? 0);
    const episodeNumber = Number(metadata.episodeNumber ?? 0);
    const ownPrimaryTag = item.posterUrl ? String(Date.parse(item.updatedAt) || 1) : "";
    const parentPrimaryTag = parent?.posterUrl ? String(Date.parse(parent.updatedAt) || 1) : "";
    const ownLogoUrl = String(metadata.logoUrl ?? "").trim();
    const ownLogoTag = ownLogoUrl ? createJellyfinImageTag(ownLogoUrl) : "";
    const parentLogoUrl = String(parent?.metadata.logoUrl ?? "").trim();
    const parentLogoTag = parentLogoUrl ? createJellyfinImageTag(parentLogoUrl) : "";
    // 关键变量：单集没有独立海报时继承节目海报，并明确图片所属条目，避免客户端请求错误的单集图片。
    const primaryImageTag = ownPrimaryTag || (type === "Episode" ? parentPrimaryTag : "");
    const primaryImageItemId = ownPrimaryTag ? item.id : primaryImageTag ? parent?.id : undefined;
    const imageTags: Record<string, string> = {};
    if (primaryImageTag) imageTags.Primary = primaryImageTag;
    if (ownLogoTag) imageTags.Logo = ownLogoTag;
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    const genreNames = Array.isArray(metadata.genres)
      ? [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))]
      : [];
    const itemLibrary = this.getItemLibraryDefinition(context, item);
    const protocolItemId = encodeProtocolItemId(item.id);
    const protocolParentItemId = parent ? encodeProtocolItemId(parent.id) : undefined;
    let itemFiles: JellyfinFileSummary[];
    if (mapping) {
      itemFiles = mapping.filesByItemId.get(item.id) ?? [];
    } else {
      const linkedFiles = await this.runtime.repository.listItemFiles(item.id, context.ownerUserId);
      // 关键变量：单条回退查询可能带出节目子集文件，只有当前电影或单集自身的文件才能作为它的版本。
      itemFiles = linkedFiles.filter((file) => String(file.itemId) === item.id)
        .map((file) => ({
          fileId: String(file.fileId),
          name: String(file.name ?? ""),
          sourceName: String(file.sourceName ?? "网盘来源"),
          providerType: String(file.providerType ?? ""),
          size: Number(file.size ?? 0),
          mediaProbe: parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult),
        }));
    }
    const recentSourceId = String(progress?.media_source_id ?? "");
    if (recentSourceId) {
      // 关键变量：账号最近成功使用的版本优先，其余版本继续保持来源稳定顺序。
      itemFiles = [...itemFiles].sort((left, right) =>
        Number(right.fileId === recentSourceId) - Number(left.fileId === recentSourceId));
    }
    // 关键变量：规格分析开关只控制扫描后是否自动分析；Jellyfin 只判断现有数据是否完整。
    const mediaSpecsReady = itemFiles.length > 0
      && itemFiles.every((file) => file.mediaProbe !== null);
    const runTimeTicks = mediaSpecsReady
      ? readJellyfinRunTimeTicks(itemFiles.map((file) => file.mediaProbe))
      : 0;
    const primaryProbe = mediaSpecsReady ? itemFiles[0]?.mediaProbe ?? null : null;
    if (!mapping) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-media-specs",
        事件: mediaSpecsReady ? "返回Jellyfin媒体规格" : "省略未完成的Jellyfin媒体规格",
        服务ID: context.serviceId,
        媒体条目ID: item.id,
        实际文件数量: itemFiles.length,
        已完成规格文件数量: itemFiles.filter((file) => file.mediaProbe !== null).length,
      });
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-artwork",
        事件: "返回Jellyfin详情图片字段",
        服务ID: context.serviceId,
        媒体条目ID: item.id,
        标题Logo标记是否存在: Boolean(ownLogoTag || parentLogoTag),
        演职人员数量: people.length,
        包含头像标记人员数量: people.filter((person) => {
          const profileUrl = String((person as Record<string, unknown>).profileUrl ?? "").trim();
          return Boolean(profileUrl);
        }).length,
      });
    }
    return {
      Name: item.title, OriginalTitle: String(metadata.originalTitle ?? ""), ServerId: context.libraryId,
      Id: protocolItemId, Etag: String(Date.parse(item.updatedAt) || 1), DateCreated: toJellyfinDateTime(item.createdAt),
      SortName: item.sortTitle, PremiereDate: toJellyfinDateTime(item.premiereDate), ProductionYear: item.year,
      Overview: item.overview, CommunityRating: Number(metadata.rating ?? 0) || undefined,
      OfficialRating: metadata.officialRating ? String(metadata.officialRating) : undefined,
      CriticRating: metadata.criticRating === undefined || metadata.criticRating === null || metadata.criticRating === ""
        ? undefined : Number.isFinite(Number(metadata.criticRating)) ? Number(metadata.criticRating) : undefined,
      Type: type, MediaType: "Video", IsFolder: type === "Series", LocationType: "FileSystem",
      CanDownload: context.downloadEnabled && type !== "Series" && itemFiles.length > 0,
      Genres: genreNames,
      GenreItems: genreNames.map((name) => ({ Name: name, Id: this.encodeGenreId(name) })),
      People: people.map((person) => {
        const personRecord = person as Record<string, unknown>;
        const personName = String(personRecord.name ?? "").trim();
        const personSourceId = String(personRecord.id ?? "").trim();
        const profileUrl = String(personRecord.profileUrl ?? "").trim();
        return {
          Name: personName,
          Id: createProtocolUuid("person", personSourceId ? `source:${personSourceId}` : `name:${personName}`),
          Role: String(personRecord.role ?? ""),
          Type: mapJellyfinPersonKind(personRecord),
          PrimaryImageTag: profileUrl ? createJellyfinImageTag(profileUrl) : undefined,
        };
      }),
      ProviderIds: mapJellyfinProviderIds(item.externalIds), ImageTags: imageTags,
      PrimaryImageTag: primaryImageTag || undefined,
      PrimaryImageItemId: primaryImageItemId ? encodeProtocolItemId(primaryImageItemId) : undefined,
      BackdropImageTags: item.backdropUrl ? [String(Date.parse(item.updatedAt) || 1)] : [],
      RunTimeTicks: runTimeTicks || undefined,
      Container: primaryProbe?.container || undefined,
      Bitrate: primaryProbe?.bitRate || undefined,
      MediaStreams: primaryProbe?.mediaStreams,
      MediaSources: itemFiles.map((file, index) => mapCatalogMediaSource(
        file,
        mediaSpecsReady,
        context.libraryKind === "cloud_aggregate_video" || index > 0 ? file.fileId : protocolItemId,
      )),
      SeriesId: type === "Episode" ? protocolParentItemId : undefined, SeriesName: type === "Episode" ? parent?.title ?? item.subtitle : undefined,
      ParentIndexNumber: type === "Episode" ? seasonNumber : undefined, IndexNumber: type === "Episode" ? episodeNumber : undefined,
      SeasonId: type === "Episode" && parent ? encodeProtocolSeasonId(parent.id, seasonNumber) : undefined,
      SeasonName: type === "Episode" ? videoSeasonTitle(seasonNumber) : undefined,
      ParentId: type === "Episode" && parent ? encodeProtocolSeasonId(parent.id, seasonNumber) : itemLibrary.id,
      ParentPrimaryImageItemId: type === "Episode" && parentPrimaryTag ? protocolParentItemId : undefined,
      ParentPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      SeriesPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      ParentLogoItemId: type === "Episode" && parentLogoTag ? protocolParentItemId : undefined,
      ParentLogoImageTag: type === "Episode" ? parentLogoTag || undefined : undefined,
      ParentBackdropItemId: type === "Episode" && parent?.backdropUrl ? protocolParentItemId : undefined,
      ParentBackdropImageTags: type === "Episode" && parent?.backdropUrl
        ? [String(Date.parse(parent.updatedAt) || 1)]
        : [],
      DatePlayed: progress?.last_played_at ?? undefined,
      UserData: this.mapUserData(progress, runTimeTicks, mapping?.favoriteItemIds.has(item.id) ?? await this.isMediaItemFavorite(context, item.id), protocolItemId),
    };
  }

  /** 映射一个电影或节目虚拟媒体库。 */
  public mapLibrary(context: JellyfinContext, library: JellyfinLibraryDefinition, itemCount = 0, coverItem?: MediaItemRecord) {
    const primaryImageTag = coverItem?.posterUrl ? String(Date.parse(coverItem.updatedAt) || 1) : "";
    const backdropImageTag = coverItem?.backdropUrl ? String(Date.parse(coverItem.updatedAt) || 1) : "";
    return {
      Name: library.name, ServerId: context.libraryId, Id: library.id, Type: "CollectionFolder",
      CollectionType: library.collectionType, IsFolder: true, LocationType: "FileSystem",
      ChildCount: itemCount, RecursiveItemCount: itemCount,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined,
      PrimaryImageItemId: primaryImageTag && coverItem ? encodeProtocolItemId(coverItem.id) : undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag && coverItem ? encodeProtocolItemId(coverItem.id) : undefined,
      UserData: this.mapUserData(null, 0),
    };
  }

  /** 返回指定媒体条目所属的电影或节目媒体库 DTO。 */
  public mapItemLibrary(context: JellyfinContext, item: MediaItemRecord) {
    return this.mapLibrary(context, this.getItemLibraryDefinition(context, item), 0, item);
  }

  /** 按协议条目 ID 读取当前 Jellyfin 服务的媒体详情。 */
  public async getItemDetail(context: JellyfinContext, protocolItemId: string): Promise<Record<string, unknown>> {
    const sourceItem = await this.runtime.repository.getCatalogItem(
      this.toInternalItemId(protocolItemId),
      context.ownerUserId,
    );
    const item = await hydrateRealtimeVideoDetails(this.runtime, sourceItem);
    const parentRelation = item.itemType === "video.episode"
      ? await this.runtime.database.query("media_relations").where({ child_item_id: item.id }).first()
      : null;
    const parent = parentRelation
      ? await this.runtime.repository.getCatalogItem(String(parentRelation.parent_item_id), context.ownerUserId)
      : undefined;
    return await this.mapItem(context, item, parent) as Record<string, unknown>;
  }

  /** 返回条目的 Jellyfin 面包屑。 */
  public async listItemAncestors(context: JellyfinContext, protocolItemId: string): Promise<Array<Record<string, unknown>>> {
    const item = await this.runtime.repository.getCatalogItem(this.toInternalItemId(protocolItemId), context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    if (item.itemType !== "video.episode") return [this.mapItemLibrary(context, item)];
    const relation = await this.runtime.database.query("media_relations").where({ child_item_id: item.id }).first();
    if (!relation) return [this.mapItemLibrary(context, item)];
    const parent = await this.runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    return [this.mapItemLibrary(context, parent), await this.mapItem(context, parent)];
  }

  /** 返回当前服务的电影媒体库，以及按开关决定是否拆分地区的节目媒体库。 */
  public async listLibraries(context: JellyfinContext) {
    const libraries = this.getLibraryDefinitions(context);
    const counts = await Promise.all(libraries.map((library) => this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, libraryId: context.libraryId, mediaType: "video", itemType: library.itemType,
      regionGroup: library.regionGroup,
      sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
    })));
    const items = libraries.map((library, index) => {
      const result = counts[index];
      // 关键变量：虚拟媒体库使用最近更新且真实拥有海报的条目作为封面，不生成无效的虚拟图片地址。
      const coverItem = result?.items.find((item) => Boolean(item.posterUrl))
        ?? result?.items.find((item) => Boolean(item.backdropUrl));
      return this.mapLibrary(context, library, result?.total ?? 0, coverItem);
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 使用当前服务目录和账号状态处理 Jellyfin 条目排序。 */
  public async listItems(context: JellyfinContext, query: Record<string, unknown>) {
    if (this.queryIncludesFilter(query, "IsFavorite", "IsFavorite")) return this.listFavoriteItems(context, query);
    if (this.queryIncludesFilter(query, "IsPlayed", "IsPlayed")) return this.listPlayedItems(context, query);
    const identityFilter = readProtocolItemIdentityFilter(query, decodeProtocolItemId);
    const identityIds = await resolveProtocolItemIdentityIds(this.runtime, context, identityFilter);
    if (identityIds?.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const include = String(this.readQueryValue(query, "IncludeItemTypes") ?? "").split(",").map((type) => type.trim()).filter(Boolean);
    const parentId = String(this.readQueryValue(query, "ParentId") ?? "");
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    if (parentId && parentId !== context.libraryId && !virtualLibrary) {
      const virtualSeason = this.parseSeasonReference(parentId);
      if (virtualSeason) return this.listEpisodes(context, virtualSeason.seriesId, { ...query, SeasonId: parentId });
      const internalParentId = decodeProtocolItemId(parentId);
      const parent = await this.runtime.repository.getCatalogItem(internalParentId, context.ownerUserId);
      if (parent.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
      const children = (await this.runtime.repository.listCatalogChildren(internalParentId, context.ownerUserId))
        .filter((item) => matchesProtocolItemIdentity(identityFilter, item.id, item.externalIds));
      const ordered = await this.sortChildRecords(context, query, children, (item) => item.id);
      const hydratedChildren = await Promise.all(ordered.map((item) => (
        item.itemType === "video.episode" ? hydrateRealtimeVideoDetails(this.runtime, item) : item
      )));
      const mapping = await this.loadItemMappingContext(context, hydratedChildren.map((item) => item.id));
      const items = await Promise.all(hydratedChildren.map((item) => this.mapItem(context, item, parent, mapping)));
      return this.paginate(items, query);
    }
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "").filter(Boolean);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    // 关键变量：虚拟媒体库与请求类型取交集，地区分组不会因排序改动而失效。
    const effectiveTypes = virtualLibrary
      ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
      : requestedTypes;
    if (virtualLibrary && effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const personIds = String(this.readQueryValue(query, "PersonIds") ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
    let itemIds = identityIds;
    if (personIds.length > 0) {
      const cache = await this.loadPersonCache(context);
      const personItemIds = new Set(personIds.flatMap((id) => [...(cache.peopleById.get(id)?.itemIds ?? [])]));
      itemIds = itemIds === undefined ? [...personItemIds] : itemIds.filter((id) => personItemIds.has(id));
    }
    return this.listSortedCatalogPage(context, query, {
      itemTypes: effectiveTypes, itemIds, topLevel: identityFilter.itemIds === undefined,
      regionGroup: virtualLibrary?.regionGroup, genres: await this.readGenreNames(context, query),
      search: String(this.readQueryValue(query, "SearchTerm") ?? ""),
    });
  }

  /** 按当前 Jellyfin 账号返回收藏，保留单服务的 Person 虚拟收藏。 */
  public async listFavoriteItems(context: JellyfinContext, query: Record<string, unknown>) {
    return this.listSortedStateItems(context, query, true);
  }

  /** 已观看列表也遵循客户端排序，不改变已观看、清零进度或继续观看的写入逻辑。 */
  public async listPlayedItems(context: JellyfinContext, query: Record<string, unknown>) {
    return this.listSortedStateItems(context, query, false);
  }

  /** 用户状态过滤、媒体库范围和排序都在分页前完成。 */
  private async listSortedStateItems(context: JellyfinContext, query: Record<string, unknown>, favorite: boolean) {
    const identityFilter = readProtocolItemIdentityFilter(query, decodeProtocolItemId);
    const identityIds = await resolveProtocolItemIdentityIds(this.runtime, context, identityFilter);
    const include = String(this.readQueryValue(query, "IncludeItemTypes") ?? "").split(",").map((type) => type.trim()).filter(Boolean);
    let types = include.length === 0 ? ["video.movie", "video.series", "video.episode"]
      : include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "").filter(Boolean);
    const parentId = String(this.readQueryValue(query, "ParentId") ?? "");
    const library = this.findLibraryDefinition(context, parentId);
    if (library) types = types.filter((type) => library.itemType === "video.movie" ? type === "video.movie" : type !== "video.movie");
    const season = this.parseSeasonReference(parentId);
    const internalParentId = !parentId || parentId === context.libraryId || library ? undefined
      : season?.seriesId ?? decodeProtocolItemId(parentId);
    const plan = this.catalogSort.readPlan(context, query);
    const search = String(this.readQueryValue(query, "SearchTerm") ?? "").trim();
    // 未指定排序时保留原账号列表习惯；显式 SortBy 才覆盖收藏/已观看的默认顺序。
    if (!this.readQueryValue(query, "SortBy")) {
      if (!favorite) plan.fields = [{ name: "dateplayed", descending: true }];
    }
    const entries = types.length === 0 ? [] : await this.catalogSort.load(context, {
      itemTypes: types, itemIds: identityIds, favorite, played: !favorite, regionGroup: library?.regionGroup,
      parentId: internalParentId, seasonNumber: season?.seasonNumber,
      search, genres: await this.readGenreNames(context, query),
    }, plan);
    const peopleById = new Map<string, Record<string, unknown>>();
    if (favorite && (include.length === 0 || include.includes("Person"))) {
      const rows = await this.runtime.database.query("library_jellyfin_virtual_preferences").select("protocol_item_id", "starred_at")
        .where({ library_id: context.libraryId, account_id: context.accountId, item_type: "Person" });
      // 关键变量：只装配已收藏的人物，不因媒体排序改动丢掉虚拟条目。
      for (const row of rows) {
        const person = await this.getPersonItem(context, String(row.protocol_item_id));
        if (!person || (search && !String(person.Name ?? "").toLocaleLowerCase("zh-CN").includes(search.toLocaleLowerCase("zh-CN")))) continue;
        if (!matchesProtocolItemIdentity(identityFilter, decodeProtocolItemId(String(person.Id)),
          (person.ProviderIds ?? {}) as Record<string, unknown>)) continue;
        const id = String(person.Id);
        peopleById.set(id, person);
        entries.push({ id, itemType: "Person", values: {
          name: String(person.Name ?? ""), sortname: String(person.SortName ?? person.Name ?? ""),
          datecreated: Date.parse(String(person.DateCreated ?? "")) || null,
        } });
      }
      this.catalogSort.sort(entries, plan);
    }
    const page = this.paginate(entries, query);
    const mediaEntries = page.Items.filter((entry) => entry.itemType !== "Person");
    const mediaItems = await this.mapSortedMediaEntries(context, mediaEntries);
    const mediaById = new Map(mediaItems.map((item) => [String(item.Id), item]));
    const items = page.Items.map((entry) => entry.itemType === "Person" ? peopleById.get(entry.id)
      : mediaById.get(encodeProtocolItemId(entry.id)))
      .filter((item): item is Record<string, unknown> => Boolean(item));
    this.catalogSort.log(context, plan, entries, page.StartIndex, items.length);
    return { Items: items, TotalRecordCount: entries.length, StartIndex: page.StartIndex };
  }

  /** 返回当前电影或节目媒体库的 Jellyfin 分类列表。 */
  public async listGenres(context: JellyfinContext, query: Record<string, unknown>) {
    const parentId = String(query.ParentId ?? "");
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    const include = String(query.IncludeItemTypes ?? "").split(",").filter(Boolean);
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : "")
      .filter((type) => type.length > 0);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const effectiveTypes = virtualLibrary
      ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
      : requestedTypes.length > 0 ? requestedTypes : ["video.movie", "video.series"];
    if (effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const rowsQuery = this.runtime.database.query("media_items")
      .select("metadata_json").where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" })
      .whereIn("item_type", effectiveTypes).whereNull("deleted_at");
    if (virtualLibrary?.regionGroup) rowsQuery.where("region_group", virtualLibrary.regionGroup);
    const rows = await rowsQuery;
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      if (!Array.isArray(metadata.genres)) return;
      const itemGenres = [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))];
      itemGenres.forEach((genre) => counts.set(genre, (counts.get(genre) ?? 0) + 1));
    });
    const searchTerm = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
    const sortDirection = String(query.SortOrder ?? "Ascending").toLowerCase() === "descending" ? -1 : 1;
    const summaries = [...counts].map(([name, itemCount]) => ({ name, itemCount }))
      .filter((genre) => !searchTerm || genre.name.toLocaleLowerCase("zh-CN").includes(searchTerm))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") * sortDirection);
    const response = this.paginate(summaries.map((genre) => this.mapGenre(context, genre)), query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin分类列表", 服务ID: context.serviceId,
      媒体库类型: virtualLibrary?.collectionType ?? "movies+tvshows", 分类数量: summaries.length,
    });
    return response;
  }

  /** 返回 Flymby 媒体中心读取的电影、节目和单集数量。 */
  public async getItemCounts(context: JellyfinContext) {
    const rows = await this.runtime.database.query("media_items")
      .select("item_type").count<{ item_type: string; count: string | number }[]>({ count: "id" })
      .where({ user_id: context.ownerUserId, library_id: context.libraryId, media_type: "video" })
      .whereIn("item_type", ["video.movie", "video.series", "video.episode"])
      .whereNull("deleted_at").groupBy("item_type");
    const countByType = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
    const response = {
      MovieCount: countByType.get("video.movie") ?? 0,
      SeriesCount: countByType.get("video.series") ?? 0,
      EpisodeCount: countByType.get("video.episode") ?? 0,
      AlbumCount: 0, SongCount: 0,
    };
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin媒体数量", 服务ID: context.serviceId,
      电影数量: response.MovieCount, 节目数量: response.SeriesCount, 单集数量: response.EpisodeCount,
    });
    return response;
  }

  /** 按同类型和共同分类返回相关推荐，未命中时返回空列表而不是中断详情页。 */
  public async listSimilar(context: JellyfinContext, itemId: string, query: Record<string, unknown>) {
    const internalItemId = decodeProtocolItemId(itemId);
    const current = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (current.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const genreNames = Array.isArray(current.metadata.genres)
      ? current.metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).slice(0, 3)
      : [];
    const requestedLimit = Math.min(100, Math.max(1, Number(query.Limit ?? 20)));
    const result = await this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, libraryId: context.libraryId, mediaType: "video", itemType: current.itemType,
      genres: genreNames, sort: "updated_desc", limit: requestedLimit + 1, offset: 0, includeFileCounts: false,
    });
    const records = result.items.filter((item) => item.id !== current.id).slice(0, requestedLimit);
    const mapping = await this.loadItemMappingContext(context, records.map((item) => item.id));
    const items = await Promise.all(records.map((item) => this.mapItem(context, item, undefined, mapping)));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 获取节目季列表，季使用可逆虚拟 ID，不新增重复媒体实体。 */
  public async listSeasons(context: JellyfinContext, seriesId: string) {
    const internalSeriesId = decodeProtocolItemId(seriesId);
    const series = await this.runtime.repository.getCatalogItem(internalSeriesId, context.ownerUserId);
    if (series.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = await this.runtime.repository.listCatalogChildren(internalSeriesId, context.ownerUserId);
    const seasons = [...new Set(children.map((item) => readVideoSeason(item.metadata.seasonNumber)))].sort((left, right) => left - right);
    const primaryImageTag = series.posterUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const backdropImageTag = series.backdropUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const protocolSeriesId = encodeProtocolItemId(series.id);
    const items = seasons.map((number) => ({
      Name: videoSeasonTitle(number), Id: encodeProtocolSeasonId(series.id, number), ServerId: context.libraryId,
      Type: "Season", IsFolder: true, SeriesId: protocolSeriesId, SeriesName: series.title,
      IndexNumber: number, ParentId: protocolSeriesId,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined, PrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined,
      SeriesPrimaryImageTag: primaryImageTag || undefined,
      ParentPrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined, ParentPrimaryImageTag: primaryImageTag || undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag ? protocolSeriesId : undefined,
      ParentBackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      UserData: this.mapUserData(null, 0),
    }));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目季列表", 服务ID: context.serviceId,
      节目ID: internalSeriesId, 季数量: items.length, 单集数量: children.length, 是否有节目封面: Boolean(primaryImageTag),
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 获取节目单集并按季集排序。 */
  public async listEpisodes(context: JellyfinContext, seriesId: string, query: Record<string, unknown>) {
    const identityFilter = readProtocolItemIdentityFilter(query, decodeProtocolItemId);
    const pathSeason = this.parseSeasonReference(seriesId);
    const querySeason = this.parseSeasonReference(String(query.SeasonId ?? ""));
    const requestedSeriesId = String(query.SeriesId ?? "").trim() || pathSeason?.seriesId || querySeason?.seriesId || seriesId;
    const actualSeriesId = decodeProtocolItemId(requestedSeriesId);
    const explicitSeasonNumber = Number(query.Season ?? query.SeasonNumber);
    const seasonNumber = pathSeason?.seasonNumber ?? querySeason?.seasonNumber
      ?? (Number.isFinite(explicitSeasonNumber) ? explicitSeasonNumber : null);
    const series = await this.runtime.repository.getCatalogItem(actualSeriesId, context.ownerUserId);
    if (series.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(actualSeriesId, context.ownerUserId))
      .filter((item) => matchesProtocolItemIdentity(identityFilter, item.id, item.externalIds))
      .filter((item) => seasonNumber === null || Number(item.metadata.seasonNumber ?? 0) === seasonNumber)
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    // 关键变量：关闭同步刮削详情时，Jellyfin 客户端无法自行访问云助手的实时详情接口，需要在标准单集接口中补全。
    const orderedChildren = await this.sortChildRecords(context, query, children, (item) => item.id);
    const hydratedChildren = await Promise.all(orderedChildren.map((item) => hydrateRealtimeVideoDetails(this.runtime, item)));
    const mapping = await this.loadItemMappingContext(context, hydratedChildren.map((item) => item.id));
    const items = await Promise.all(hydratedChildren.map((item) => this.mapItem(context, item, series, mapping)));
    const response = this.paginate(items, query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目单集列表", 服务ID: context.serviceId,
      节目ID: actualSeriesId, 季编号: seasonNumber ?? "全部", 返回数量: response.Items.length,
      总数量: response.TotalRecordCount,
    });
    return response;
  }

  /** 为普通条目、虚拟媒体库和虚拟季解析实际承载图片的媒体条目。 */
  public async resolveImageItem(context: JellyfinLibraryContext, itemId: string, imageType: string): Promise<MediaItemRecord> {
    const library = this.findLibraryDefinition(context, itemId);
    if (library) {
      const result = await this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, libraryId: context.libraryId, mediaType: "video", itemType: library.itemType,
        regionGroup: library.regionGroup,
        sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
      });
      const coverItem = result.items.find((item) => Boolean(readJellyfinImageUrl(item, imageType)))
        ?? result.items.find((item) => Boolean(item.posterUrl || item.backdropUrl));
      if (!coverItem) throw new ApiError(404, "jellyfin_image_not_found", "媒体库没有可用封面");
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: coverItem.id, 图片类型: imageType,
      });
      return coverItem;
    }
    const season = this.parseSeasonReference(itemId);
    const resolvedItemId = season?.seriesId ?? decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(resolvedItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
    if (resolvedItemId !== itemId) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: resolvedItemId, 图片类型: imageType,
      });
    }
    const requestedImageUrl = readJellyfinImageUrl(item, imageType);
    if (requestedImageUrl || item.itemType !== "video.episode") return item;
    // 单集 DTO 可以继承节目海报和背景图；图片请求使用单集 ID 时同样要回退到所属节目。
    const relation = await this.runtime.database.query("media_relations")
      .where({ library_id: context.libraryId, child_item_id: item.id }).first();
    if (!relation) return item;
    const parent = await this.runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    const parentImageUrl = readJellyfinImageUrl(parent, imageType);
    if (parent.libraryId !== context.libraryId || !parentImageUrl) return item;
    return parent;
  }

  /** 解析标准图片接口的媒体图片或演员头像来源。 */
  public async resolveImageSource(
    context: JellyfinLibraryContext,
    itemId: string,
    imageType: string,
  ): Promise<JellyfinImageSource> {
    const normalizedType = imageType.trim().toLowerCase();
    if (normalizedType === "primary" && this.isPotentialPersonId(context, itemId)) {
      const personImage = await this.resolvePersonImageSource(context, itemId);
      if (personImage) {
        this.logArtworkResolution(context, itemId, imageType, "演员头像");
        return personImage;
      }
    }
    const item = await this.resolveImageItem(context, itemId, imageType);
    const imageUrl = readJellyfinImageUrl(item, imageType);
    if (!imageUrl) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
    const imageTag = normalizedType === "logo"
      ? createJellyfinImageTag(imageUrl)
      : String(Date.parse(item.updatedAt) || 1);
    this.logArtworkResolution(context, itemId, imageType, normalizedType === "logo" ? "标题Logo" : "媒体图片");
    return { url: imageUrl, imageTag, updatedAt: item.updatedAt, sourceType: "media" };
  }

  /** 判断协议 ID 是否可能指向不可逆编码的演员实体。 */
  private isPotentialPersonId(context: JellyfinLibraryContext, itemId: string): boolean {
    const compactItemId = itemId.trim().toLowerCase().replace(/-/gu, "");
    return !INTERNAL_ITEM_ID_PATTERN.test(itemId)
      && !compactItemId.startsWith(JELLYFIN_ITEM_UUID_PREFIX)
      && !this.parseSeasonReference(itemId)
      && !this.findLibraryDefinition(context, itemId);
  }

  /** 按媒体库版本建立演员实体、头像和关联作品索引。 */
  private async loadPersonCache(context: JellyfinLibraryContext): Promise<JellyfinPersonCache> {
    const library = await this.runtime.database.query("media_libraries")
      .select("catalog_version")
      .where({ id: context.libraryId })
      .first();
    const catalogVersion = Number(library?.catalog_version ?? 0);
    const cacheKey = `${context.ownerUserId}:${context.libraryId}`;
    let cache = this.personCaches.get(cacheKey);
    if (cache && cache.catalogVersion === catalogVersion) return cache;
    // 关键变量：只读取顶层影视条目，单集会重复节目演职人员且不应扩大索引扫描量。
    const rows = await this.runtime.database.query("media_items")
      .select("id", "metadata_json", "updated_at")
      .where({
        user_id: context.ownerUserId,
        library_id: context.libraryId,
        media_type: "video",
      })
      .whereIn("item_type", ["video.movie", "video.series"])
      .whereNull("deleted_at")
      .orderBy("updated_at", "desc");
    const peopleById = new Map<string, JellyfinPersonSummary>();
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata_json);
      const people = Array.isArray(metadata.people) ? metadata.people : [];
      for (const person of people) {
        const personRecord = person as Record<string, unknown>;
        const personName = String(personRecord.name ?? "").trim();
        const personSourceId = String(personRecord.id ?? "").trim();
        const profileUrl = String(personRecord.profileUrl ?? "").trim();
        if (!personName) continue;
        const protocolPersonId = createProtocolUuid(
          "person",
          personSourceId ? `source:${personSourceId}` : `name:${personName}`,
        );
        const existing = peopleById.get(protocolPersonId);
        if (existing) {
          existing.itemIds.add(String(row.id));
          if (!existing.profileUrl && /^https?:\/\//iu.test(profileUrl)) {
            existing.profileUrl = profileUrl;
            existing.imageTag = createJellyfinImageTag(profileUrl);
            existing.updatedAt = String(row.updated_at);
          }
          continue;
        }
        const validProfileUrl = /^https?:\/\//iu.test(profileUrl) ? profileUrl : "";
        peopleById.set(protocolPersonId, {
          id: protocolPersonId,
          name: personName,
          sourceId: personSourceId,
          profileUrl: validProfileUrl,
          imageTag: validProfileUrl ? createJellyfinImageTag(validProfileUrl) : "",
          updatedAt: String(row.updated_at),
          itemIds: new Set([String(row.id)]),
        });
      }
    }
    cache = { catalogVersion, peopleById };
    this.personCaches.set(cacheKey, cache);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-person",
      事件: "建立Jellyfin演员索引",
      媒体库ID: context.libraryId,
      目录版本: catalogVersion,
      影视条目数量: rows.length,
      演员数量: peopleById.size,
    });
    return cache;
  }

  /** 返回标准 Jellyfin Person DTO；非演员协议 ID 返回空。 */
  public async getPersonItem(context: JellyfinContext, personId: string) {
    if (!this.isPotentialPersonId(context, personId)) return null;
    const cache = await this.loadPersonCache(context);
    const person = cache.peopleById.get(personId.trim().toLowerCase());
    if (!person) return null;
    const favorite = await this.isVirtualItemFavorite(context, person.id);
    const item = {
      Name: person.name,
      ServerId: context.libraryId,
      Id: person.id,
      Etag: person.imageTag || String(Date.parse(person.updatedAt) || 1),
      DateCreated: toJellyfinDateTime(person.updatedAt),
      SortName: person.name,
      Type: "Person",
      IsFolder: false,
      LocationType: "FileSystem",
      Overview: "",
      ProductionLocations: [],
      ProviderIds: person.sourceId ? { Tmdb: person.sourceId } : {},
      ImageTags: person.imageTag ? { Primary: person.imageTag } : {},
      PrimaryImageTag: person.imageTag || undefined,
      PrimaryImageAspectRatio: person.profileUrl ? 2 / 3 : undefined,
      UserData: this.mapUserData(null, 0, favorite, person.id),
    };
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-artwork",
      事件: "返回Jellyfin演员详情",
      服务ID: context.serviceId,
      演员协议ID: person.id,
      演员名称: person.name,
      是否包含头像: Boolean(person.profileUrl),
      关联作品数量: person.itemIds.size,
    });
    return item;
  }

  /** 返回 Jellyfin 标准演员列表。 */
  public async listPersons(context: JellyfinContext, query: Record<string, unknown>) {
    const cache = await this.loadPersonCache(context);
    const searchTerm = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
    const descending = String(query.SortOrder ?? "Ascending").toLowerCase() === "descending";
    const people = [...cache.peopleById.values()]
      .filter((person) => !searchTerm || person.name.toLocaleLowerCase("zh-CN").includes(searchTerm))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") * (descending ? -1 : 1));
    const offset = Math.max(0, Number(query.StartIndex ?? 0));
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? 100)));
    const selectedPeople = people.slice(offset, offset + limit);
    const items = await Promise.all(selectedPeople.map((person) => this.getPersonItem(context, person.id)));
    return { Items: items.filter(Boolean), TotalRecordCount: people.length, StartIndex: offset };
  }

  /** 按演员名称读取标准 Jellyfin Person DTO。 */
  public async getPersonByName(context: JellyfinContext, personName: string) {
    const cache = await this.loadPersonCache(context);
    const requestedName = personName.trim().toLocaleLowerCase("zh-CN");
    const person = [...cache.peopleById.values()].find(
      (candidate) => candidate.name.toLocaleLowerCase("zh-CN") === requestedName,
    );
    return person ? this.getPersonItem(context, person.id) : null;
  }

  /** 从演员实体索引读取头像地址。 */
  private async resolvePersonImageSource(
    context: JellyfinLibraryContext,
    personId: string,
  ): Promise<JellyfinImageSource | null> {
    const cache = await this.loadPersonCache(context);
    const person = cache.peopleById.get(personId.trim().toLowerCase());
    if (!person?.profileUrl) return null;
    return {
      url: person.profileUrl,
      imageTag: person.imageTag,
      updatedAt: person.updatedAt,
      sourceType: "person",
    };
  }

  /** 记录 Jellyfin 图片协议解析结果，便于区分 DTO 缺字段和图片代理失败。 */
  private logArtworkResolution(
    context: JellyfinLibraryContext,
    itemId: string,
    imageType: string,
    sourceName: string,
  ): void {
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-artwork",
      事件: "解析Jellyfin图片来源",
      服务ID: context.serviceId,
      请求条目ID: itemId,
      图片类型: imageType,
      图片来源: sourceName,
    });
  }

  /** 查询继续观看条目。 */
  public async listResume(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("library_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id")
      .join("file_links as fl", "fl.item_id", "m.id")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .distinct("m.id", "p.updated_at").where({ "p.library_id": context.libraryId, "p.account_id": context.accountId, "p.played": 0, "p.hidden_from_resume": 0, "f.status": "active" })
      // 关键变量：普通试播仍要求 60 秒，完播生成的下一集则允许零进度续播。
      .where((builder) => builder.where("p.position_ticks", ">=", 600_000_000).orWhere("p.resume_pending", 1))
      .whereNull("m.deleted_at").orderBy("p.updated_at", "desc").limit(500);
    const rawRecords = await Promise.all(rows.map(async (row) => {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      return { item, parent };
    }));
    const seenResumeGroups = new Set<string>();
    // 关键变量：单集按父节目聚合，排序后只保留最近播放的一集作为续播入口。
    const records = rawRecords.filter((record) => {
      const groupId = record.item.itemType === "video.episode" && record.parent
        ? `series:${record.parent.id}`
        : `item:${record.item.id}`;
      if (seenResumeGroups.has(groupId)) return false;
      seenResumeGroups.add(groupId);
      return true;
    });
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    const progressItems = items.filter((item) => Number(item.UserData?.PlaybackPositionTicks ?? 0) > 0);
    const percentageItems = progressItems.filter((item) => Number(item.UserData?.PlayedPercentage ?? 0) > 0);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "返回Jellyfin继续观看进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      聚合前记录数量: rawRecords.length,
      继续观看数量: items.length,
      包含已观看时间数量: progressItems.length,
      包含进度百分比数量: percentageItems.length,
    });
    return this.paginate(items, query);
  }

  /** 查询去重后的最近播放记录。 */
  public async listHistory(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("library_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id").select("m.id")
      .where({ "p.library_id": context.libraryId, "p.account_id": context.accountId })
      .whereNotNull("p.last_played_at").whereNull("m.deleted_at").orderBy("p.last_played_at", "desc").limit(500);
    const records = await Promise.all(rows.map(async (row) => {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      return { item, parent };
    }));
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    return this.paginate(items, query);
  }

  /** 获取单条用户进度 DTO。 */
  public async getUserData(context: JellyfinContext, itemId: string) {
    if (this.isPotentialPersonId(context, itemId)) {
      const personCache = await this.loadPersonCache(context);
      const protocolPersonId = itemId.trim().toLowerCase();
      if (personCache.peopleById.has(protocolPersonId)) {
        return this.mapUserData(null, 0, await this.isVirtualItemFavorite(context, protocolPersonId), protocolPersonId);
      }
    }
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    return this.mapUserData(progress, runTimeTicks, await this.isMediaItemFavorite(context, internalItemId), encodeProtocolItemId(internalItemId));
  }

  /** 接收 Jellyfin 用户数据更新，同步处理续播、已观看和收藏状态。 */
  public async updateUserData(context: JellyfinContext, itemId: string, body: Record<string, unknown>) {
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    if (Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")) {
      const positionTicks = Math.max(0, Math.floor(Number(body.PlaybackPositionTicks ?? 0)));
      const now = new Date().toISOString();
      const existing = await this.runtime.database.query("library_playback_progress")
        .where({ library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId }).first();
      const patch = {
        position_ticks: positionTicks,
        played: 0,
        hidden_from_resume: 0,
        resume_pending: 0,
        updated_at: now,
      };
      if (existing) await this.runtime.database.query("library_playback_progress").where({ id: existing.id }).update(patch);
      else await this.runtime.database.query("library_playback_progress").insert({
        id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId,
        media_source_id: null, play_count: 0, last_played_at: null, ...patch,
      });
    }
    if (typeof body.Played === "boolean") await this.setPlayed(context, itemId, body.Played);
    // 仅写入播放位置也会撤销单集已观看状态，需要同步刷新父节目汇总。
    if (item.itemType === "video.episode"
      && Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")
      && typeof body.Played !== "boolean") {
      await this.synchronizeParentSeriesProgress(context, internalItemId, new Date().toISOString());
    }
    if (typeof body.IsFavorite === "boolean") await this.setFavorite(context, itemId, body.IsFavorite);
    return this.getUserData(context, itemId);
  }

  /** 查询指定节目的下一集。 */
  public async listNextUp(context: JellyfinContext, query: Record<string, unknown>) {
    const requestedSeriesId = String(query.SeriesId ?? "");
    if (!requestedSeriesId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const seriesId = decodeProtocolItemId(requestedSeriesId);
    const series = await this.runtime.repository.getCatalogItem(seriesId, context.ownerUserId);
    if (series.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(seriesId, context.ownerUserId))
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    const progressRows = await this.runtime.database.query("library_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId }).whereIn("item_id", children.map((item) => item.id));
    const progressById = new Map(progressRows.map((row) => [String(row.item_id), row]));
    const next = children.find((item) => Number(progressById.get(item.id)?.played ?? 0) !== 1);
    const hydratedNext = next ? await hydrateRealtimeVideoDetails(this.runtime, next) : undefined;
    const items = hydratedNext ? [await this.mapItem(context, hydratedNext, series)] : [];
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 写入 Playing、Progress 或 Stopped 事件，保证停止事件幂等。 */
  public async reportPlayback(context: JellyfinContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    const protocolItemId = String(body.ItemId ?? "");
    if (!protocolItemId) throw new ApiError(422, "playback_item_required", "播放条目 ID 不能为空");
    const itemId = decodeProtocolItemId(protocolItemId);
    const mediaSourceId = body.MediaSourceId
      ? this.toInternalMediaSourceId(itemId, String(body.MediaSourceId))
      : undefined;
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const playSessionId = String(body.PlaySessionId ?? "") || randomUUID();
    const positionTicks = Math.max(0, Math.floor(Number(body.PositionTicks ?? 0)));
    // 关键变量：播放进度只与服务端媒体库中的总时长计算，不接受非标准的客户端总时长字段。
    const durationTicks = await this.readItemRunTimeTicks(
      item,
      mediaSourceId,
    );
    const progressPercentage = durationTicks > 0
      ? Math.min(100, positionTicks * 100 / durationTicks)
      : 0;
    // 关键变量：任意播放进度上报达到 90% 即完成，不等待 Stopped 事件。
    const completed = durationTicks > 0 && progressPercentage >= 90;
    const now = new Date().toISOString();
    let automaticallyMarkedPlayed = false;
    await this.runtime.database.query.transaction(async (transaction) => {
      const existing = await transaction("library_playback_sessions").where({ id: playSessionId, library_id: context.libraryId, account_id: context.accountId }).first();
      const existingHistory = kind === "stopped"
        ? await transaction("library_playback_history").where({ play_session_id: playSessionId }).first()
        : null;
      const sessionPatch = { item_id: itemId, media_source_id: mediaSourceId ?? null, status: kind === "stopped" ? "stopped" : "playing", position_ticks: positionTicks, paused: body.IsPaused ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (existing) await transaction("library_playback_sessions").where({ id: playSessionId }).update(sessionPatch);
      else await transaction("library_playback_sessions").insert({ id: playSessionId, library_id: context.libraryId, account_id: context.accountId, ...sessionPatch, started_at: now });
      automaticallyMarkedPlayed = await this.upsertProgress(
        transaction,
        context,
        itemId,
        mediaSourceId ?? null,
        positionTicks,
        kind === "stopped" && !existingHistory,
        completed,
        now,
      );
      if (item.itemType === "video.episode" && automaticallyMarkedPlayed) {
        await prepareNextEpisodeResume(transaction, "library_playback_progress", context, itemId, now);
      }
      if (kind === "stopped") {
        if (!existingHistory) await transaction("library_playback_history").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: itemId, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: existing?.started_at ?? now, stopped_at: now });
      }
    });
    // 自动播放进度也属于单集状态变化，最后一集完播后应立即更新整剧完成标记。
    if (item.itemType === "video.episode" && automaticallyMarkedPlayed) {
      await this.synchronizeParentSeriesProgress(context, itemId, now);
    }
    if (automaticallyMarkedPlayed) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-user-state",
        事件: "Jellyfin播放进度达到90%自动标记已观看",
        服务ID: context.serviceId,
        账号ID: context.accountId,
        媒体条目ID: itemId,
        上报类型: kind,
        已观看Ticks: positionTicks,
        总时长Ticks: durationTicks,
        进度百分比: progressPercentage,
      });
    }
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "保存Jellyfin播放进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: itemId,
      上报类型: kind,
      已观看Ticks: positionTicks,
      总时长Ticks: durationTicks,
      进度百分比: progressPercentage,
    });
  }

  /** 设置已播放状态。 */
  public async setPlayed(context: JellyfinContext, itemId: string, played: boolean) {
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const episodeIds = item.itemType === "video.series"
      ? (await this.runtime.repository.listCatalogChildren(internalItemId, context.ownerUserId))
        .filter((child) => child.libraryId === context.libraryId && child.itemType === "video.episode")
        .map((episode) => episode.id)
      : [];
    // 关键变量：节目和所有单集在同一事务中更新，避免父子观看状态不一致。
    const targetItemIds = [...new Set([internalItemId, ...episodeIds])];
    await this.runtime.database.query.transaction(async (transaction) => {
      const existingRows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < targetItemIds.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        existingRows.push(...await transaction("library_playback_progress")
          .where({ library_id: context.libraryId, account_id: context.accountId })
          .whereIn("item_id", targetItemIds.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE)));
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
          updated_at: now,
          last_played_at: played ? now : null,
        };
      });
      for (let offset = 0; offset < rows.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        await transaction("library_playback_progress")
          .insert(rows.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE))
          .onConflict(["library_id", "account_id", "item_id"])
          .merge(["played", "position_ticks", "hidden_from_resume", "resume_pending", "play_count", "last_played_at", "updated_at"]);
      }
    });
    if (item.itemType === "video.episode") {
      await this.synchronizeParentSeriesProgress(context, internalItemId, now);
    }
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    const userData = this.mapUserData(
      progress,
      runTimeTicks,
      await this.isMediaItemFavorite(context, internalItemId),
      encodeProtocolItemId(internalItemId),
    );
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "更新Jellyfin已观看状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: internalItemId,
      媒体类型: item.itemType,
      是否已观看: played,
      级联单集数量: episodeIds.length,
      清零进度条目数量: targetItemIds.length,
    });
    return userData;
  }

  /** 设置媒体或虚拟 Person 条目的 Jellyfin 收藏状态。 */
  public async setFavorite(context: JellyfinContext, itemId: string, favorite: boolean) {
    const protocolItemId = itemId.trim().toLowerCase();
    const now = new Date().toISOString();
    if (this.isPotentialPersonId(context, protocolItemId)) {
      const personCache = await this.loadPersonCache(context);
      if (personCache.peopleById.has(protocolItemId)) {
        const existing = await this.runtime.database.query("library_jellyfin_virtual_preferences")
          .where({ library_id: context.libraryId, account_id: context.accountId, protocol_item_id: protocolItemId }).first();
        if (favorite && existing) {
          await this.runtime.database.query("library_jellyfin_virtual_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
        } else if (favorite) {
          await this.runtime.database.query("library_jellyfin_virtual_preferences").insert({
            id: randomUUID(), library_id: context.libraryId, account_id: context.accountId,
            protocol_item_id: protocolItemId, item_type: "Person", starred_at: now, updated_at: now,
          });
        } else if (existing) {
          await this.runtime.database.query("library_jellyfin_virtual_preferences").where({ id: existing.id }).delete();
        }
        this.logUserFavoriteChange(context, protocolItemId, "Person", favorite);
        return this.mapUserData(null, 0, favorite, protocolItemId);
      }
    }

    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const existing = await this.runtime.database.query("library_item_preferences")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId }).first();
    if (favorite && existing) {
      await this.runtime.database.query("library_item_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
    } else if (favorite) {
      await this.runtime.database.query("library_item_preferences").insert({
        id: randomUUID(), library_id: context.libraryId, account_id: context.accountId,
        item_id: internalItemId, starred_at: now, rating: 0, updated_at: now,
      });
    } else if (existing && Number(existing.rating ?? 0) === 0) {
      await this.runtime.database.query("library_item_preferences").where({ id: existing.id }).delete();
    } else if (existing) {
      await this.runtime.database.query("library_item_preferences").where({ id: existing.id }).update({ starred_at: null, updated_at: now });
    }
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    this.logUserFavoriteChange(context, internalItemId, item.itemType, favorite);
    return this.mapUserData(progress, runTimeTicks, favorite, encodeProtocolItemId(internalItemId));
  }

  /** 记录 Jellyfin 收藏状态写入结果。 */
  private logUserFavoriteChange(
    context: JellyfinContext,
    itemId: string,
    itemType: string,
    favorite: boolean,
  ): void {
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "更新Jellyfin收藏状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      条目ID: itemId,
      条目类型: itemType,
      是否收藏: favorite,
    });
  }

  /** 从继续观看隐藏或恢复条目。 */
  public async setHiddenFromResume(context: JellyfinContext, itemId: string, hidden: boolean) {
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("library_playback_progress").where({ library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId }).first();
    if (existing) await this.runtime.database.query("library_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
    else await this.runtime.database.query("library_playback_progress").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
  }

  /** 根据当前有效单集计算节目整体观看状态，新增单集会立即使整剧恢复为未看完。 */
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

  /** 读取单条进度；节目状态不直接相信历史父记录，而是按当前有效单集重新汇总。 */
  private async readProgress(context: JellyfinContext, itemId: string) {
    const currentProgress = await this.runtime.database.query("library_playback_progress")
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
    const episodeProgressRows = await this.runtime.database.query("library_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId })
      .whereIn("item_id", episodeIds);
    const progressByItemId = new Map(episodeProgressRows.map((row) =>
      [String(row.item_id), row as Record<string, unknown>]));
    return this.buildSeriesProgress(itemId, currentProgress as Record<string, unknown> | undefined,
      episodeIds, progressByItemId);
  }

  /** 为列表中的节目批量补齐按现有单集汇总的观看状态。 */
  private async applySeriesProgressToMapping(
    context: JellyfinContext,
    itemIds: string[],
    progressByItemId: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    const relationRows = await this.runtime.database.query("media_relations as relation")
      .join("media_items as episode", "episode.id", "relation.child_item_id")
      .select("relation.parent_item_id", "relation.child_item_id")
      .whereIn("relation.parent_item_id", itemIds)
      .where({
        "relation.library_id": context.libraryId,
        "relation.relation_type": "series_episode",
        "episode.library_id": context.libraryId,
        "episode.item_type": "video.episode",
      })
      .whereNull("episode.deleted_at");
    if (relationRows.length === 0) return;
    const episodeIds = [...new Set(relationRows.map((row) => String(row.child_item_id)))];
    const episodeProgressRows = await this.runtime.database.query("library_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId })
      .whereIn("item_id", episodeIds);
    const episodeProgressByItemId = new Map(episodeProgressRows.map((row) =>
      [String(row.item_id), row as Record<string, unknown>]));
    const episodeIdsBySeriesId = new Map<string, string[]>();
    relationRows.forEach((row) => {
      const seriesId = String(row.parent_item_id);
      const currentEpisodeIds = episodeIdsBySeriesId.get(seriesId) ?? [];
      currentEpisodeIds.push(String(row.child_item_id));
      episodeIdsBySeriesId.set(seriesId, currentEpisodeIds);
    });
    episodeIdsBySeriesId.forEach((seriesEpisodeIds, seriesId) => {
      const seriesProgress = this.buildSeriesProgress(
        seriesId, progressByItemId.get(seriesId), seriesEpisodeIds, episodeProgressByItemId);
      if (seriesProgress) progressByItemId.set(seriesId, seriesProgress);
    });
  }

  /** 单集状态变化后持久化整剧汇总，保证已观看筛选与普通列表使用同一结果。 */
  private async synchronizeParentSeriesProgress(
    context: JellyfinContext,
    episodeItemId: string,
    now: string,
  ): Promise<void> {
    const relation = await this.runtime.database.query("media_relations")
      .select("parent_item_id")
      .where({
        library_id: context.libraryId,
        child_item_id: episodeItemId,
        relation_type: "series_episode",
      }).first();
    if (!relation) return;
    const seriesItemId = String(relation.parent_item_id); // 关键变量：需要随当前单集重新汇总的节目条目。
    const seriesProgress = await this.readProgress(context, seriesItemId);
    if (!seriesProgress) return;
    const existing = await this.runtime.database.query("library_playback_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: seriesItemId }).first();
    const patch = {
      played: Number(seriesProgress.played ?? 0),
      position_ticks: 0,
      hidden_from_resume: Number(seriesProgress.hidden_from_resume ?? 0),
      play_count: Number(seriesProgress.play_count ?? 0),
      last_played_at: seriesProgress.last_played_at ?? null,
      updated_at: now,
    };
    if (existing) {
      await this.runtime.database.query("library_playback_progress").where({ id: existing.id }).update(patch);
    } else {
      await this.runtime.database.query("library_playback_progress").insert({
        id: randomUUID(), library_id: context.libraryId, account_id: context.accountId,
        item_id: seriesItemId, media_source_id: null, ...patch,
      });
    }
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-series-watched-state",
      事件: "单集状态变化后重算Jellyfin整剧观看状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      节目条目ID: seriesItemId,
      单集条目ID: episodeItemId,
      是否整剧已观看: Number(seriesProgress.played ?? 0) === 1,
      未观看单集数: Number(seriesProgress.unplayed_item_count ?? 0),
    });
  }

  /** 读取电影或单集实际源文件时长，指定媒体源时只使用该版本。 */
  private async readItemRunTimeTicks(
    item: MediaItemRecord,
    mediaSourceId?: string,
  ): Promise<number> {
    const query = this.runtime.database.query("file_links as fl")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
      .select("fl.source_file_id", "p.status", "p.result_json")
      // 关键变量：只按当前条目仍然有效的实际文件判断完整性，与条目详情和 PlaybackInfo 保持一致。
      .where({
        "fl.user_id": item.userId,
        "fl.item_id": item.id,
        "f.library_id": item.libraryId,
        "f.status": "active",
      })
      .orderBy("f.path", "asc");
    const rows = await query;
    const probes = rows.map((row) => parseCompletedMediaProbeResult(row.status, row.result_json));
    if (rows.length === 0 || probes.some((probe) => probe === null)) return 0;
    if (mediaSourceId) {
      // 关键变量：客户端上报条目 ID 时，对应当前条目的主媒体源。
      const selectedIndex = mediaSourceId === item.id
        ? 0
        : rows.findIndex((row) => String(row.source_file_id) === mediaSourceId);
      return selectedIndex >= 0 ? probes[selectedIndex]?.runTimeTicks ?? 0 : 0;
    }
    return readJellyfinRunTimeTicks(probes);
  }

  /** 批量加载列表 DTO 所需的用户进度和文件摘要，避免对每个条目重复查询。 */
  private async loadItemMappingContext(context: JellyfinContext, itemIds: string[]): Promise<JellyfinItemMappingContext> {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return { progressByItemId: new Map(), favoriteItemIds: new Set(), filesByItemId: new Map() };
    const [progressRows, preferenceRows, fileRows] = await Promise.all([
      this.runtime.database.query("library_playback_progress")
        .where({ library_id: context.libraryId, account_id: context.accountId }).whereIn("item_id", uniqueItemIds),
      this.runtime.database.query("library_item_preferences")
        .select("item_id")
        .where({ library_id: context.libraryId, account_id: context.accountId })
        .whereIn("item_id", uniqueItemIds)
        .whereNotNull("starred_at"),
      this.runtime.database.query("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .join("library_sources as ls", "ls.id", "f.library_source_id")
        .leftJoin("cloud_services as source_service", "source_service.id", "ls.service_id")
        .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
        .select("fl.item_id", "f.id as file_id", "f.name", "f.size", "ls.display_name as source_name", "ls.provider_type", "p.status", "p.result_json")
        .whereIn("fl.item_id", uniqueItemIds)
        .where({ "f.library_id": context.libraryId, "f.status": "active" })
        .where((builder) => builder
          .where((owned) => owned.where({
            "ls.source_mode": "owned_copy",
            "ls.status": "active",
            "ls.connection_status": "valid",
          }))
          .orWhere((linkedSource) => linkedSource.where({
            "ls.source_mode": "linked_service",
            "ls.status": "active",
            "source_service.connection_status": "valid",
          }).whereIn("source_service.status", ["active", "scanning"])))
        // 关键变量：列表和详情保持同一文件顺序，保证主媒体源选择稳定。
        .orderBy("ls.sort_order", "asc")
        .orderBy("f.path", "asc"),
    ]);
    const progressByItemId = new Map(progressRows.map((row) => [String(row.item_id), row as Record<string, unknown>]));
    await this.applySeriesProgressToMapping(context, uniqueItemIds, progressByItemId);
    const favoriteItemIds = new Set(preferenceRows.map((row) => String(row.item_id)));
    const filesByItemId = new Map<string, JellyfinFileSummary[]>();
    for (const row of fileRows) {
      const itemId = String(row.item_id);
      const files = filesByItemId.get(itemId) ?? [];
      files.push({
        fileId: String(row.file_id),
        name: String(row.name ?? ""),
        sourceName: String(row.source_name ?? "网盘来源"),
        providerType: String(row.provider_type ?? ""),
        size: Number(row.size ?? 0),
        mediaProbe: parseCompletedMediaProbeResult(row.status, row.result_json),
      });
      filesByItemId.set(itemId, files);
    }
    return { progressByItemId, favoriteItemIds, filesByItemId };
  }

  /** 映射 Jellyfin UserItemDataDto。 */
  private mapUserData(
    progress: Record<string, unknown> | null | undefined,
    runTimeTicks: number,
    favorite = false,
    protocolItemId?: string,
  ) {
    const positionTicks = Number(progress?.position_ticks ?? 0);
    const played = Number(progress?.played ?? 0) === 1;
    const itemId = String(progress?.item_id ?? "");
    const mediaSourceId = String(progress?.media_source_id ?? "");
    // 关键变量：Jellyfin 完播后清零播放位置；播放百分比只根据仍然存在的播放位置派生。
    const playbackPositionTicks = played ? 0 : positionTicks;
    return {
      PlaybackPositionTicks: playbackPositionTicks, PlayCount: Number(progress?.play_count ?? 0), IsFavorite: favorite,
      Played: played, LastPlayedDate: progress?.last_played_at ?? undefined,
      UnplayedItemCount: progress?.unplayed_item_count === undefined
        ? undefined
        : Number(progress.unplayed_item_count),
      PlayedPercentage: runTimeTicks > 0 && playbackPositionTicks > 0
        ? playbackPositionTicks / runTimeTicks * 100
        : undefined,
      Key: "",
      ItemId: protocolItemId ?? (itemId ? encodeProtocolItemId(itemId) : undefined),
      MediaSourceId: mediaSourceId
        ? INTERNAL_ITEM_ID_PATTERN.test(mediaSourceId) ? encodeProtocolItemId(mediaSourceId) : mediaSourceId
        : undefined,
    };
  }

  /** 读取当前账号的媒体条目收藏状态。 */
  private async isMediaItemFavorite(context: JellyfinContext, itemId: string): Promise<boolean> {
    const preference = await this.runtime.database.query("library_item_preferences")
      .select("id")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId })
      .whereNotNull("starred_at")
      .first();
    return Boolean(preference);
  }

  /** 读取 Person 等虚拟 Jellyfin 条目的收藏状态。 */
  private async isVirtualItemFavorite(context: JellyfinContext, protocolItemId: string): Promise<boolean> {
    const preference = await this.runtime.database.query("library_jellyfin_virtual_preferences")
      .select("id")
      .where({ library_id: context.libraryId, account_id: context.accountId, protocol_item_id: protocolItemId.toLowerCase() })
      .first();
    return Boolean(preference);
  }

  /** 判断 Items 查询是否要求某个用户状态过滤。 */
  private queryIncludesFilter(query: Record<string, unknown>, filterName: string, booleanKey: string): boolean {
    const filters = String(this.readQueryValue(query, "Filters") ?? "").split(",").map((value) => value.trim());
    if (filters.includes(filterName)) return true;
    return String(this.readQueryValue(query, booleanKey) ?? "").toLowerCase() === "true";
  }

  /** 读取 Jellyfin 旧客户端 PascalCase 或新 SDK camelCase 查询参数。 */
  private readQueryValue(query: Record<string, unknown>, key: string): unknown {
    const camelCaseKey = `${key.charAt(0).toLowerCase()}${key.slice(1)}`;
    return query[key] ?? query[camelCaseKey];
  }

  /** 跨数据库执行播放进度新增或更新。 */
  private async upsertProgress(
    transaction: Knex | Knex.Transaction,
    context: JellyfinContext,
    itemId: string,
    mediaSourceId: string | null,
    positionTicks: number,
    stopped: boolean,
    completed: boolean,
    now: string,
  ): Promise<boolean> {
    const existing = await transaction("library_playback_progress").where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId }).first();
    // 关键变量：只有从未观看切换为已观看时才记录自动标记日志。
    const alreadyPlayed = Number(existing?.played ?? 0) === 1;
    const newlyCompleted = completed && !alreadyPlayed;
    const patch = {
      media_source_id: mediaSourceId ?? existing?.media_source_id ?? null,
      position_ticks: completed ? 0 : positionTicks,
      // 已观看状态只由显式“标记未观看”撤销，后续播放上报不能反向清除。
      played: completed || alreadyPlayed ? 1 : 0,
      hidden_from_resume: completed || alreadyPlayed ? 1 : 0,
      // 从下一集入口开始播放时保留待播标记，避免前 60 秒又从继续观看消失。
      resume_pending: completed || alreadyPlayed ? 0 : Number(existing?.resume_pending ?? 0),
      last_played_at: now,
      updated_at: now,
    };
    const existingPlayCount = Number(existing?.play_count ?? 0);
    // 进度首次达标时立即保证 PlayCount 至少为 1，Stopped 事件不再对同一次完播重复计数。
    const playCount = newlyCompleted
      ? Math.max(1, existingPlayCount)
      : existingPlayCount + (stopped && !completed ? 1 : 0);
    if (existing) await transaction("library_playback_progress").where({ id: existing.id }).update({ ...patch, play_count: playCount });
    else await transaction("library_playback_progress").insert({ id: randomUUID(), library_id: context.libraryId, account_id: context.accountId, item_id: itemId, ...patch, play_count: playCount });
    return newlyCompleted;
  }

  /** 查找单集父节目。 */
  private async findParent(itemId: string, userId: string): Promise<MediaItemRecord | undefined> {
    const relation = await this.runtime.database.query("media_relations").where({ child_item_id: itemId }).first();
    return relation ? this.runtime.repository.getCatalogItem(String(relation.parent_item_id), userId) : undefined;
  }

  /** 对已经映射的 DTO 执行 Jellyfin 风格分页。 */
  private paginate<T>(items: T[], query: Record<string, unknown>) {
    const start = Math.max(0, Number(this.readQueryValue(query, "StartIndex") ?? 0));
    const limit = Math.min(500, Math.max(1, Number(this.readQueryValue(query, "Limit") ?? (items.length || 100))));
    return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start };
  }

  /** 登录连续失败达到阈值时拒绝继续校验密码。 */
  private requireLoginAllowed(key: string): void {
    const attempt = this.loginFailures.get(key);
    if (!attempt || attempt.blockedUntil <= Date.now()) return;
    throw new ApiError(429, "jellyfin_login_rate_limited", "登录失败次数过多，请稍后再试");
  }

  /** 记录十分钟窗口内的失败；第八次失败后限制十五分钟。 */
  private recordLoginFailure(key: string): number {
    const now = Date.now();
    const previous = this.loginFailures.get(key);
    const current = !previous || now - previous.firstFailedAt > 10 * 60 * 1000
      ? { count: 1, firstFailedAt: now, blockedUntil: 0 }
      : { ...previous, count: previous.count + 1 };
    if (current.count >= 8) current.blockedUntil = now + 15 * 60 * 1000;
    this.loginFailures.set(key, current);
    // 限制异常来源长期堆积内存；这里只删除已经过期的失败窗口。
    if (this.loginFailures.size > 10_000) {
      for (const [attemptKey, attempt] of this.loginFailures) {
        if (attempt.blockedUntil < now && now - attempt.firstFailedAt > 10 * 60 * 1000) this.loginFailures.delete(attemptKey);
      }
    }
    return current.blockedUntil;
  }
}
