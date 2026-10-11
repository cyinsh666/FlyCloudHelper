import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { buildJellyfinPath } from "../jellyfin-path.js";
import { parseCompletedMediaProbeResult, readJellyfinRunTimeTicks } from "../media/media-probe.js";
import { sendProtocolUserImage } from "../media/protocol-user-image.js";
import { JellyfinCompatibilityService, type JellyfinContext, type JellyfinLibraryContext } from "../jellyfin-service.js";
import { providerFetch, providerStream } from "../providers/network.js";
import type { ProviderConnectionContext, ProviderFileAccess } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import { enqueueProtocolScan, listProtocolVirtualFolders } from "../protocol-scan-service.js";
import { contentPlaybackServerRoot, isContentSourceLibrary, mapContentMediaSource, prepareContentPlaybackSources } from "../content-sources/playback.js";
import { sendContentPlayback, sendContentResource } from "../content-sources/hls-relay.js";
import {
  buildUpstreamHeaders,
  copyMediaResponseHeaders,
  handleProviderAuthenticationFailure,
  resolveRelayAccess,
  type RelayLibraryRow,
} from "./media-stream-routes.js";

/** 统一读取任意 Jellyfin 查询参数。 */
function readQuery(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** 读取 Jellyfin 查询参数或 PlaybackInfo POST 请求体中的媒体源 ID。 */
function readMediaSourceId(request: FastifyRequest): string {
  const query = readQuery(request);
  const body = request.body && typeof request.body === "object"
    ? request.body as Record<string, unknown>
    : {};
  return String(query.mediaSourceId ?? query.MediaSourceId ?? body.MediaSourceId ?? body.mediaSourceId ?? "");
}

/** 云聚合始终返回稳定文件版本 ID；旧单源库继续兼容“主版本等于条目 ID”的历史行为。 */
function toProtocolMediaSourceId(itemId: string, primaryFileId: string, fileId: string, stableVersionId: boolean): string {
  return stableVersionId || fileId !== primaryFileId ? fileId : itemId;
}

/** 按 Jellyfin 媒体源 ID 找到真实文件，条目 ID 表示主媒体源。 */
function findPlaybackFile<T extends { itemId?: unknown; fileId?: unknown }>(
  files: T[],
  itemId: string,
  mediaSourceId: string,
): T | undefined {
  if (!mediaSourceId || mediaSourceId === itemId) return files[0];
  return files.find((candidate) => String(candidate.fileId) === mediaSourceId);
}

/** 判断 Provider 是否已经明确确认源文件被删除。 */
function isMissingProviderFileError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "provider_file_not_found") return true;
  return error.code === "provider_request_failed" && error.message.trim() === "文件已删除";
}

/** 确认 URL 中的用户 ID 就是当前服务访问账号。 */
function requireProtocolUser(context: JellyfinContext, userId: string): void {
  if (userId !== context.accountId) throw new ApiError(403, "jellyfin_user_scope_mismatch", "不能访问其他服务账号的数据");
}

/** 构造 Jellyfin 官方 Items/Root 返回的 BaseItemDto。 */
function buildRootItem(context: JellyfinContext): Record<string, unknown> {
  return {
    Name: "媒体库",
    ServerId: context.libraryId,
    Id: context.libraryId,
    Type: "Folder",
    IsFolder: true,
  };
}

/** 把服务数据库行转换为媒体中转公共上下文。 */
function toRelayLibrary(service: Record<string, unknown>, file: Record<string, unknown>): RelayLibraryRow {
  return {
    id: String(service.library_id), service_id: String(service.id),
    library_source_id: String(file.librarySourceId ?? "") || undefined,
    provider_type: String(file.providerType ?? service.provider_type ?? ""),
    service_status: String(service.status), relay_playback_enabled: service.jellyfin_relay_playback_enabled as number,
    credential_revision: Number(service.credential_revision),
  };
}

/** 读取播放路由偏好；标准 Jellyfin 客户端默认自动选择 Provider 临时原始地址或服务端直放。 */
function readPlaybackRoute(request: FastifyRequest): "auto" | "server" | "origin" {
  const value = String(request.headers["x-flycloud-playback-route"] ?? readQuery(request).FlyCloudPlaybackRoute ?? "auto").toLowerCase();
  if (value === "server" || value === "origin") return value;
  if (value === "auto") return value;
  return "auto";
}

/** 构造官方 Jellyfin 服务内视频流地址，由服务端继续决定原始或中转。 */
function buildJellyfinStreamUrl(
  itemId: string,
  mediaSourceId: string,
  playbackRoute: "auto" | "server" | "origin",
): string {
  const query = new URLSearchParams({
    static: "true",
    mediaSourceId,
    FlyCloudPlaybackRoute: playbackRoute,
  });
  // 关键变量：Jellyfin 客户端会把服务基址与 DirectStreamUrl 拼接，因此这里只能返回服务内相对路径。
  return `/Videos/${encodeURIComponent(itemId)}/stream?${query.toString()}`;
}

/** 判断网盘是否支持使用当前 Jellyfin 播放器 UA 申请直连地址。 */
function supportsPlaybackUserAgent(providerType: string): boolean {
  return providerType === "cloud115" || providerType === "cloud123";
}

/** 115、123取址 UA 或百度固定 UA 与当前播放器一致时无需额外请求头；认证头仍保持原限制。 */
function hasRequiredPlaybackHeaders(access: ProviderFileAccess, request: FastifyRequest, providerType: string): boolean {
  return Object.entries(access.headers).some(([name, value]) => {
    if ((supportsPlaybackUserAgent(providerType) || providerType === "baidupan") && name.toLowerCase() === "user-agent") {
      const playerUserAgent = request.headers["user-agent"];
      return typeof playerUserAgent !== "string" || !playerUserAgent || value !== playerUserAgent;
    }
    return true;
  });
}

/** 生成 Jellyfin 标准 MediaSourceInfo 的公共默认字段。 */
function buildStandardMediaSourceDefaults(): Record<string, unknown> {
  return {
    EncoderPath: null,
    EncoderProtocol: null,
    ETag: null,
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
    MediaStreams: [],
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    TranscodingUrl: null,
    TranscodingSubProtocol: null,
    TranscodingContainer: null,
    AnalyzeDurationMs: null,
    DefaultAudioStreamIndex: null,
    DefaultSubtitleStreamIndex: null,
  };
}

/** 解析文件访问地址，并在 Provider 刷新令牌时安全持久化。 */
async function resolveFileAccess(runtime: ApiRuntime, file: Record<string, unknown>, ownerUserId: string, locator: Record<string, unknown>, signal: AbortSignal, playbackRequest?: FastifyRequest) {
  // 关键变量：只有明确适配播放器 UA 的网盘才覆盖本次取址标识，不修改其他网盘的固定访问头。
  const sourceRuntime = await runtime.repository.getLibrarySourceRuntimeConfiguration(String(file.librarySourceId), ownerUserId);
  const providerType = sourceRuntime.providerType;
  const adapter = runtime.providers.get(providerType);
  const connection = runtime.vault.decrypt(sourceRuntime.encryptedConnection);
  const providerContext: ProviderConnectionContext = {
    // 只在实际访问 Videos/stream 时传入播放器 UA，不能把 PlaybackInfo 的 API 客户端 UA 当成播放 UA。
    playbackUserAgent: supportsPlaybackUserAgent(providerType) && playbackRequest
      ? playbackRequest.headers["user-agent"] || undefined
      : undefined,
    persistConnection: async (nextConnection) => runtime.repository.refreshLibrarySourceEncryptedConnection({
      librarySourceId: sourceRuntime.source.id, userId: ownerUserId, credentialRevision: sourceRuntime.credentialRevision,
      encryptedConnection: runtime.vault.encrypt(nextConnection),
    }),
  };
  let access: ProviderFileAccess | null;
  try {
    access = adapter.resolveFileAccess ? await adapter.resolveFileAccess(connection, locator, signal, providerContext) : null;
  } catch (error) {
    await handleProviderAuthenticationFailure(runtime, {
      librarySourceId: sourceRuntime.source.id,
      serviceId: sourceRuntime.source.serviceId ?? sourceRuntime.source.id,
      userId: ownerUserId,
      credentialRevision: sourceRuntime.credentialRevision,
      providerType,
    }, error);
    throw error;
  }
  if (playbackRequest) {
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-cloud-direct",
      事件: "网盘直连请求头检查",
      媒体库源ID: sourceRuntime.source.id,
      网盘类型: providerType,
      请求方法: playbackRequest.method,
      请求播放路由: readPlaybackRoute(playbackRequest),
      使用播放器UA: Boolean(providerContext.playbackUserAgent),
      是否取得原始地址: Boolean(access && /^https?:\/\//iu.test(access.url)),
      请求头名称: access ? Object.keys(access.headers).join(",") : "",
      是否仍需额外请求头: access ? hasRequiredPlaybackHeaders(access, playbackRequest, providerType) : null,
    });
  }
  if (providerType === "cloud115" && playbackRequest) {
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-115-direct", 事件: "115直连取址完成", 媒体库源ID: sourceRuntime.source.id,
      使用播放器UA: Boolean(providerContext.playbackUserAgent), 请求方法: playbackRequest.method,
      是否取得原始地址: Boolean(access && /^https?:\/\//iu.test(access.url)),
      是否仍需额外请求头: access ? hasRequiredPlaybackHeaders(access, playbackRequest, "cloud115") : null,
    });
  }
  return access;
}

/** 生成不包含转码能力的 PlaybackInfo。 */
async function buildPlaybackInfo(runtime: ApiRuntime, compatibility: JellyfinCompatibilityService, context: JellyfinContext, request: FastifyRequest, itemId: string) {
  const service = await compatibility.requireEnabledService(context.libraryId);
  const internalItemId = compatibility.toInternalItemId(itemId);
  const protocolItemId = compatibility.toProtocolItemId(internalItemId);
  const item = await runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
  if (isContentSourceLibrary(service.library_kind)) {
    const progress = await runtime.database.query("library_playback_progress").select("media_source_id")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId }).first();
    const requestedSource = compatibility.toInternalMediaSourceId(internalItemId, readMediaSourceId(request));
    const sources = await prepareContentPlaybackSources(runtime, internalItemId, context.ownerUserId, context.libraryId, requestedSource, String(progress?.media_source_id ?? ""));
    const playbackQuery = readQuery(request);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const playSessionId = String(playbackQuery.PlaySessionId ?? playbackQuery.playSessionId ?? body.CurrentPlaySessionId ?? "") || randomUUID();
    // 关键变量：在线源只保留客户端显式路线；自动请求由实际取流时的库配置决定。
    const contentRoute = readPlaybackRoute(request);
    const now = new Date().toISOString();
    await runtime.database.query("library_playback_sessions").insert({
      id: playSessionId, library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId,
      media_source_id: sources[0]?.id ?? null, status: "created", position_ticks: 0, paused: 0,
      started_at: now, updated_at: now, stopped_at: null,
    }).onConflict("id").ignore();
    return {
      MediaSources: sources.map((source) => mapContentMediaSource(source, protocolItemId, context.accessToken, playSessionId, contentPlaybackServerRoot(request), contentRoute)),
      PlaySessionId: playSessionId,
      ErrorCode: null,
    };
  }
  const files = await runtime.repository.listItemFiles(internalItemId, context.ownerUserId);
  const requestedSource = readMediaSourceId(request);
  const internalRequestedSource = compatibility.toInternalMediaSourceId(internalItemId, requestedSource);
  // 关键变量：节目查询可能连带返回所有单集文件，PlaybackInfo 只能暴露当前电影或单集自身的多版本文件。
  const itemFiles = files.filter((candidate) => String(candidate.itemId) === internalItemId);
  const progress = await runtime.database.query("library_playback_progress")
    .select("media_source_id")
    .where({ library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId })
    .first();
  const recentSourceId = String(progress?.media_source_id ?? "");
  // 关键变量：未明确指定版本时优先返回该账号最近成功使用的版本，其后保持来源稳定顺序。
  const playableFiles = recentSourceId
    ? [...itemFiles].sort((left, right) => Number(String(right.fileId) === recentSourceId) - Number(String(left.fileId) === recentSourceId))
    : itemFiles;
  const requestedFile = requestedSource
    ? findPlaybackFile(playableFiles, internalItemId, internalRequestedSource)
    : undefined;
  if (playableFiles.length === 0) {
    throw new ApiError(404, "jellyfin_media_source_not_found", "媒体条目没有可播放文件");
  }
  if (requestedSource && !requestedFile) {
    throw new ApiError(404, "jellyfin_media_source_not_found", "指定媒体源不存在");
  }
  // PlaybackInfo 明确指定版本时只返回该版本；真正取流失败后再最多回退一个其他版本。
  const candidateFiles = requestedFile
    ? [
      requestedFile,
      ...playableFiles.filter((file) => file !== requestedFile && String(file.path) === String(requestedFile.path)),
    ]
    : playableFiles;
  const shouldStopAfterFirstUsableSource = Boolean(requestedFile);
  const preference = readPlaybackRoute(request);
  // 关键变量：Jellyfin 中转开关只约束服务器媒体入口，不影响临时原始地址直连。
  const jellyfinRelayPlaybackEnabled = Number(service.jellyfin_relay_playback_enabled) === 1
    || service.jellyfin_relay_playback_enabled === true;
  const usesStableVersionIds = String(service.library_kind) === "cloud_aggregate_video";
  const itemMediaProbes = itemFiles.map((file) =>
    parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult));
  // 关键变量：规格开关只控制自动入队；已有规格完整时，PlaybackInfo 必须始终返回。
  const mediaSpecsReady = itemFiles.length > 0
    && itemMediaProbes.every((probe) => probe !== null);
  const mediaProbeByFileId = new Map(itemFiles.map((file, index) => [
    String(file.fileId),
    mediaSpecsReady ? itemMediaProbes[index] ?? null : null,
  ]));
  const runTimeTicks = mediaSpecsReady ? readJellyfinRunTimeTicks(itemMediaProbes) : 0;
  const routeNames = new Set<string>();
  const mediaSources: Array<Record<string, unknown>> = [];
  let missingProviderFileCount = 0;
  for (const file of candidateFiles) {
    const protocolMediaSourceId = toProtocolMediaSourceId(
      protocolItemId,
      String(playableFiles[0]?.fileId ?? ""),
      String(file.fileId),
      usesStableVersionIds,
    );
    const fileName = String(file.name ?? "video.mp4");
    const mediaProbe = mediaProbeByFileId.get(String(file.fileId)) ?? null;
    const locator = file.playbackLocator && typeof file.playbackLocator === "object"
      ? file.playbackLocator as Record<string, unknown>
      : {};
    let originAccess: ProviderFileAccess | null = null;
    // 自动模式开启 Jellyfin 中转时直接声明服务器媒体源；只有原始路线才预先申请 Provider 临时地址。
    const selectedRoute = preference === "server" || (preference === "auto" && jellyfinRelayPlaybackEnabled)
      ? "server"
      : "origin";
    if (selectedRoute === "origin") {
      try {
        originAccess = await resolveFileAccess(
          runtime,
          file,
          context.ownerUserId,
          locator,
          new AbortController().signal,
        );
      } catch (error) {
        if (isMissingProviderFileError(error)) {
          await runtime.repository.markSourceFileMissingFromPlayback(String(file.fileId), context.ownerUserId);
          missingProviderFileCount += 1;
          continue;
        }
        if (preference === "origin" || !jellyfinRelayPlaybackEnabled) throw error;
      }
      if (originAccess && !/^https?:\/\//iu.test(originAccess.url)) originAccess = null;
    }
    if (selectedRoute === "origin" && !originAccess) continue;
    const directStreamUrl = buildJellyfinStreamUrl(protocolItemId, protocolMediaSourceId, preference);
    // 关键变量：百度直链要求固定 UA；只在原始路线声明给播放器，中转路线不改变客户端请求头。
    const requiredHttpHeaders = selectedRoute === "origin" && String(file.providerType ?? "") === "baidupan"
      ? { "User-Agent": "pan.baidu.com" }
      : {};
    routeNames.add(selectedRoute === "origin" ? "Jellyfin原始跳转" : "服务器中转");
    mediaSources.push({
      ...buildStandardMediaSourceDefaults(),
      // 关键变量：所有 Jellyfin 客户端统一接收标准 File 媒体源和服务内相对播放地址。
      Protocol: "File", Id: protocolMediaSourceId, Path: fileName,
      Type: "Default", Container: mediaProbe?.container || undefined, Size: mediaProbe?.size || undefined,
      // 多版本名称明确展示来源，APP 只需要使用标准 Jellyfin MediaSources。
      Name: `${String(file.sourceName ?? "网盘来源")}（${String(file.providerType ?? "未知网盘")}） · ${fileName}`,
      Bitrate: mediaProbe?.bitRate || undefined,
      IsRemote: false,
      DirectStreamUrl: directStreamUrl, AddApiKeyToDirectStreamUrl: true,
      RequiredHttpHeaders: requiredHttpHeaders,
      RunTimeTicks: mediaProbe?.runTimeTicks || runTimeTicks || undefined,
      MediaStreams: mediaProbe?.mediaStreams ?? [],
    });
    if (shouldStopAfterFirstUsableSource) break;
  }
  if (missingProviderFileCount === candidateFiles.length) {
    throw new ApiError(404, "jellyfin_provider_file_not_found", "当前播放版本对应的网盘文件已删除");
  }
  if (mediaSources.length === 0 && preference === "origin") {
    throw new ApiError(409, "jellyfin_origin_direct_unavailable", "当前媒体文件无法生成网盘原始播放地址");
  }
  if (mediaSources.length === 0 && preference === "auto" && !jellyfinRelayPlaybackEnabled) {
    throw new ApiError(409, "jellyfin_playback_route_unavailable", "当前媒体文件没有可用原始地址，且媒体库未启用 Jellyfin 中转播放");
  }
  if (mediaSources.length === 0) throw new ApiError(409, "jellyfin_direct_play_unavailable", "当前媒体文件没有可用的直放地址");
  const playbackQuery = readQuery(request);
  const playSessionId = String(playbackQuery.playSessionId ?? playbackQuery.PlaySessionId ?? "") || randomUUID();
  // 关键变量：播放会话必须记录实际返回的媒体源，主文件切换后不能继续保存原主媒体源编号。
  const selectedSourceId = compatibility.toInternalMediaSourceId(
    internalItemId,
    String(mediaSources[0]?.Id ?? ""),
  );
  const now = new Date().toISOString();
  // PlaybackInfo 先登记 created 会话；Playing、Progress、Stopped 将在相同会话上继续更新。
  await runtime.database.query("library_playback_sessions").insert({
    id: playSessionId, library_id: context.libraryId, account_id: context.accountId, item_id: internalItemId,
    media_source_id: selectedSourceId || null, status: "created", position_ticks: 0, paused: 0,
    started_at: now, updated_at: now, stopped_at: null,
  }).onConflict("id").ignore();
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-jellyfin-compat", 事件: "生成Jellyfin直放信息", 服务ID: context.serviceId,
    媒体条目ID: internalItemId, 播放路由: [...routeNames].join("+"), 路由偏好: preference, 媒体源数量: mediaSources.length,
    影片规格是否全部完成: mediaSpecsReady,
    包含已完成规格媒体源数量: candidateFiles.filter((file) => mediaProbeByFileId.get(String(file.fileId)) !== null).length,
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-jellyfin-standard-id",
    事件: "标准UUID播放信息反向解析成功",
    服务ID: context.serviceId,
    协议条目ID: protocolItemId,
    内部条目ID: internalItemId,
    协议媒体源ID: String(mediaSources[0]?.Id ?? "无"),
  });
  return {
    MediaSources: mediaSources, PlaySessionId: playSessionId, ErrorCode: null,
  };
}

/** 通过 Jellyfin 图片接口代理媒体库已经保存的公开 HTTP 图片。 */
async function sendItemImage(compatibility: JellyfinCompatibilityService, context: JellyfinLibraryContext, request: FastifyRequest, reply: FastifyReply, itemId: string, imageType: string) {
  const imageSource = await compatibility.resolveImageSource(context, itemId, imageType);
  const rawUrl = imageSource.url;
  let imageUrl: URL;
  try { imageUrl = new URL(rawUrl); } catch { throw new ApiError(404, "jellyfin_image_not_found", "图片地址不可用"); }
  if (imageUrl.protocol !== "https:" && imageUrl.protocol !== "http:") {
    throw new ApiError(422, "jellyfin_image_source_unsupported", "当前图片来源暂不支持协议代理");
  }
  const responseEtag = `"${imageSource.imageTag}"`;
  reply.header("ETag", responseEtag);
  reply.header("Last-Modified", new Date(imageSource.updatedAt).toUTCString());
  if (request.headers["if-none-match"] === responseEtag) return reply.status(304).send();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await providerFetch(imageUrl, { method: request.method === "HEAD" ? "HEAD" : "GET" }, {
      // 图片 URL 已经是媒体库元数据的一部分；协议层同时兼容 NFO 中常见的 HTTP 图片地址。
      allowInsecureHttp: true,
    }, controller.signal);
    if (!response.ok) throw new ApiError(502, "jellyfin_image_upstream_failed", "图片服务暂时不可用");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 20 * 1024 * 1024) throw new ApiError(413, "jellyfin_image_too_large", "图片文件过大");
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) throw new ApiError(502, "jellyfin_image_content_invalid", "图片服务返回了非图片内容");
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "private, max-age=86400");
    if (length > 0) reply.header("Content-Length", length);
    if (request.method === "HEAD") return reply.send();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 20 * 1024 * 1024) throw new ApiError(413, "jellyfin_image_too_large", "图片文件过大");
    return reply.send(body);
  } finally { clearTimeout(timer); }
}

/** 将 Provider 原始媒体流转发给 Jellyfin 客户端，用途决定播放路线或强制原文件下载。 */
async function sendMediaStream(
  runtime: ApiRuntime,
  compatibility: JellyfinCompatibilityService,
  context: JellyfinContext,
  request: FastifyRequest,
  reply: FastifyReply,
  itemId: string,
  responseMode: "playback" | "download" = "playback",
) {
  const service = await compatibility.requireEnabledService(context.libraryId);
  if (responseMode === "download" && !context.downloadEnabled) {
    runtime.logBusinessEvent("warn", {
      日志关键字: "codex-jellyfin-download",
      事件: "拦截已关闭的Jellyfin影片下载",
      服务ID: context.serviceId,
      协议条目ID: itemId,
      是否允许下载: false,
    });
    throw new ApiError(403, "jellyfin_download_disabled", "当前 Jellyfin 服务未允许下载影片");
  }
  const requestedRoute = readPlaybackRoute(request);
  // Jellyfin 标准 Videos 接口使用独立媒体库开关；自动模式开启时优先服务器中转，保证第三方客户端无需处理 Provider 请求头。
  const jellyfinRelayPlaybackEnabled = Number(service.jellyfin_relay_playback_enabled) === 1
    || service.jellyfin_relay_playback_enabled === true;
  // 关键变量：媒体库开关决定普通客户端的自动路线；显式 server 表示当前客户端主动要求中转。
  // 关键变量：下载始终由云助手转发原文件字节，不受播放中转开关影响，也不执行转码。
  const effectiveRoute = responseMode === "download"
    ? "server"
    : requestedRoute === "auto"
      ? jellyfinRelayPlaybackEnabled ? "server" : "origin"
      : requestedRoute;
  const internalItemId = compatibility.toInternalItemId(itemId);
  const item = await runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
  if (isContentSourceLibrary(service.library_kind)) {
    if (responseMode === "download") throw new ApiError(422, "content_download_unsupported", "在线内容源暂不提供原文件下载");
    return sendContentPlayback(runtime, context, request, reply, internalItemId,
      compatibility.toProtocolItemId(internalItemId), compatibility.toInternalMediaSourceId(internalItemId, readMediaSourceId(request)),
      { protocol: "jellyfin", route: requestedRoute });
  }
  const files = await runtime.repository.listItemFiles(internalItemId, context.ownerUserId);
  const requestedSource = readMediaSourceId(request);
  const fileId = compatibility.toInternalMediaSourceId(internalItemId, requestedSource);
  const itemFiles = files.filter((candidate) => String(candidate.itemId) === internalItemId);
  const requestedFile = findPlaybackFile(itemFiles, internalItemId, fileId);
  if (!requestedFile) throw new ApiError(404, "jellyfin_media_source_not_found", "媒体源不存在");
  // 关键变量：指定版本失效时最多回退一个其他来源版本，避免客户端连续等待多个异常来源。
  const fallbackFile = itemFiles.find((file) => file !== requestedFile);
  const candidateFiles = fallbackFile ? [requestedFile, fallbackFile] : [requestedFile];
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.raw.once("aborted", abort); reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    let file: Record<string, unknown> | undefined;
    let access: ProviderFileAccess | undefined;
    for (const candidateFile of candidateFiles) {
      const locator = candidateFile.playbackLocator && typeof candidateFile.playbackLocator === "object"
        ? candidateFile.playbackLocator as Record<string, unknown>
        : {};
      try {
        if (effectiveRoute === "origin") {
          const originAccess = await resolveFileAccess(
            runtime,
            candidateFile,
            context.ownerUserId,
            locator,
            abortController.signal,
            request,
          );
          if (!originAccess || !/^https?:\/\//iu.test(originAccess.url)) {
            throw new ApiError(409, "jellyfin_origin_direct_unavailable", "当前文件无法生成原始播放地址，请启用 Jellyfin 中转播放");
          }
          // 关键变量：百度直链仅在播放器实际使用指定 UA 时跳转，避免无专用请求头的客户端接收不可播地址。
          const requiresExtraHeaders = hasRequiredPlaybackHeaders(originAccess, request, String(candidateFile.providerType ?? ""));
          if (!requiresExtraHeaders) {
            reply.header("Cache-Control", "private, no-store");
            return reply.redirect(originAccess.url, 307);
          }
          if (!jellyfinRelayPlaybackEnabled) {
            throw new ApiError(409, "jellyfin_origin_headers_required", "当前网盘原始地址依赖专用请求头，请启用 Jellyfin 中转播放");
          }
          // 关键变量：标准播放器无法在 307 跳转时附加 Provider 请求头，此时自动改由云助手安全中转。
          access = originAccess;
        } else {
          access = await resolveRelayAccess(
            runtime,
            toRelayLibrary(service, candidateFile),
            context.ownerUserId,
            locator,
            abortController.signal,
          );
        }
        file = candidateFile;
        break;
      } catch (error) {
        if (!isMissingProviderFileError(error)) throw error;
        await runtime.repository.markSourceFileMissingFromPlayback(String(candidateFile.fileId), context.ownerUserId);
      }
    }
    if (!file || !access) {
      throw new ApiError(404, "jellyfin_provider_file_not_found", "当前播放版本对应的网盘文件已删除");
    }
    const upstreamHeaders = buildUpstreamHeaders(request, access.headers);
    // 下载客户端可能沿用 JSON API 的 Accept，向 Provider 请求原始文件时必须改为接受任意媒体类型。
    if (responseMode === "download") upstreamHeaders.Accept = "*/*";
    const upstream = await providerStream(access.url, { method: request.method, headers: upstreamHeaders }, {
      allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
      logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields),
    }, abortController.signal);
    upstreamBody = upstream.body;
    copyMediaResponseHeaders(reply, upstream.headers);
    if (responseMode === "download") {
      const downloadFileName = String(file.name ?? item.title).trim() || item.title;
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`);
    }
    reply.status(upstream.statusCode);
    runtime.logBusinessEvent("info", responseMode === "download" ? {
      日志关键字: "codex-jellyfin-download",
      事件: "建立Jellyfin影片下载连接",
      服务ID: context.serviceId,
      媒体条目ID: internalItemId,
      源文件ID: String(file.fileId),
      是否Range请求: Boolean(request.headers.range),
      上游状态码: upstream.statusCode,
    } : {
      日志关键字: "codex-jellyfin-compat", 事件: "建立Jellyfin服务器直放连接", 服务ID: context.serviceId,
      媒体条目ID: internalItemId, 源文件ID: String(file.fileId), 是否Range请求: Boolean(request.headers.range), 上游状态码: upstream.statusCode,
    });
    return reply.send(upstream.body);
  } finally {
    if (!upstreamBody) { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", abort); }
  }
}

/**
 * 返回客户端可访问的 Jellyfin 服务地址。
 * 显式配置的公开地址用于覆盖反向代理、HTTPS 域名或端口映射；未配置时使用当前请求的协议和 Host。
 */
async function buildJellyfinLocalAddress(runtime: ApiRuntime, request: FastifyRequest, pathSuffix: string): Promise<string> {
  const configuredUrl = await runtime.publicAccess.buildJellyfinUrl(pathSuffix);
  if (configuredUrl) return configuredUrl;
  // 关键变量：反向代理后的协议和主机优先使用标准转发头，直接访问时再使用 Fastify 当前请求值。
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0]?.trim().toLowerCase();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",", 1)[0]?.trim();
  const requestProtocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : request.protocol;
  /** Host 保留当前请求实际使用的端口，适用于直接访问云助手 API 的场景。 */
  const requestHost = forwardedHost || String(request.headers.host ?? "").trim();
  const jellyfinPath = buildJellyfinPath(pathSuffix);
  if (!requestHost) return jellyfinPath;
  try {
    return `${new URL(`${requestProtocol}://${requestHost}`).origin}${jellyfinPath}`;
  } catch {
    return jellyfinPath;
  }
}

/** 注册 Jellyfin API 前缀，同时保留 Flymby 仍在使用的 /emby 兼容路径。 */
function registerProtocolPrefix(server: FastifyInstance, runtime: ApiRuntime, compatibility: JellyfinCompatibilityService, prefix: string): void {
  /** 读取路由中的单层自定义后缀。 */
  const readPathSuffix = (request: FastifyRequest): string => String((request.params as { jellyfinPathSuffix: string }).jellyfinPathSuffix);
  /** 使用自定义后缀找到真实媒体库 ID。 */
  const resolveLibraryId = async (request: FastifyRequest): Promise<string> => compatibility.resolveLibraryIdByPathSuffix(readPathSuffix(request));
  const authenticated = async (request: FastifyRequest) => compatibility.authenticate(await resolveLibraryId(request), request);
  /** 图片读取按 Jellyfin 标准不要求客户端图片组件附带访问令牌。 */
  const publicImageContext = async (request: FastifyRequest) => compatibility.resolvePublicImageContext(await resolveLibraryId(request));
  server.get(`${prefix}/System/Info/Public`, async (request) => {
    const libraryId = await resolveLibraryId(request);
    const library = await compatibility.requireEnabledService(libraryId);
    return { LocalAddress: await buildJellyfinLocalAddress(runtime, request, readPathSuffix(request)), ServerName: library.display_name, Version: "10.10.0", ProductName: "FlyCloudHelper", OperatingSystem: process.platform, Id: libraryId, StartupWizardCompleted: true };
  });
  server.get(`${prefix}/System/Info`, async (request) => {
    const context = await authenticated(request); const service = await compatibility.requireEnabledService(context.libraryId);
    return { LocalAddress: await buildJellyfinLocalAddress(runtime, request, readPathSuffix(request)), ServerName: service.display_name, Version: "10.10.0", ProductName: "FlyCloudHelper", OperatingSystem: process.platform, Id: context.libraryId, StartupWizardCompleted: true };
  });
  server.route({ method: ["GET", "POST"], url: `${prefix}/System/Ping`, handler: async (_request, reply) => reply.type("text/plain; charset=utf-8").send("FlyCloudHelper") });
  server.post(`${prefix}/Users/AuthenticateByName`, async (request) => compatibility.login(await resolveLibraryId(request), request, (request.body ?? {}) as Record<string, unknown>));
  server.post(`${prefix}/Sessions/Logout`, async (request, reply) => { await compatibility.logout(await resolveLibraryId(request), request); return reply.status(204).send(); });
  server.get(`${prefix}/Users/:userId`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.mapUser(context.accountId, context.accountUsername, context.libraryId, context.accountHasPassword, context.downloadEnabled); });
  server.get(`${prefix}/Users/Me`, async (request) => { const context = await authenticated(request); return compatibility.mapUser(context.accountId, context.accountUsername, context.libraryId, context.accountHasPassword, context.downloadEnabled); });
  server.get(`${prefix}/Users/Public`, async (request) => { await resolveLibraryId(request); return []; });
  // 默认头像只有第 0 张，兼容标准的无索引及带索引图片路径。
  for (const userImagePath of [`${prefix}/Users/:userId/Images/Primary`, `${prefix}/Users/:userId/Images/Primary/0`]) {
    server.route({ method: ["GET", "HEAD"], url: userImagePath, handler: async (request, reply) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return sendProtocolUserImage("jellyfin", request, reply); } });
  }
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/UserImage`, handler: async (request, reply) => { const context = await authenticated(request); const requestedUserId = String(readQuery(request).userId ?? readQuery(request).UserId ?? context.accountId); requireProtocolUser(context, requestedUserId); return sendProtocolUserImage("jellyfin", request, reply); } });
  server.get(`${prefix}/Users/:userId/Views`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.listLibraries(context); });
  server.get(`${prefix}/UserViews`, async (request) => compatibility.listLibraries(await authenticated(request)));
  server.get(`${prefix}/Users/:userId/Items/Resume`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.listResume(context, readQuery(request)); });
  server.get(`${prefix}/Users/:userId/Items/Root`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return buildRootItem(context); });
  server.get(`${prefix}/Items/Root`, async (request) => { const context = await authenticated(request); const requestedUserId = String(readQuery(request).userId ?? readQuery(request).UserId ?? context.accountId); requireProtocolUser(context, requestedUserId); return buildRootItem(context); });
  server.get(`${prefix}/Users/:userId/Items/Latest`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); const result = await compatibility.listItems(context, { ...readQuery(request), SortBy: "DateCreated", SortOrder: "Descending" }, { localOnly: true }); return result.Items; });
  server.get(`${prefix}/Users/:userId/Items/:itemId`, async (request) => {
    const context = await authenticated(request);
    const params = request.params as { userId: string; itemId: string };
    requireProtocolUser(context, params.userId);
    const personItem = await compatibility.getPersonItem(context, params.itemId);
    if (personItem) return personItem;
    return compatibility.getItemDetail(context, params.itemId);
  });
  server.get(`${prefix}/Users/:userId/Items`, async (request) => {
    const context = await authenticated(request);
    requireProtocolUser(context, String((request.params as { userId: string }).userId));
    const query = readQuery(request);
    // 关键变量：在线库的播放日期是列表排序，不能因尚无历史而丢掉影片；原网盘历史入口继续保留。
    const hasStateFilter = String(query.Filters ?? query.filters ?? "").split(",").some((value) => ["IsFavorite", "IsPlayed"].includes(value.trim()))
      || String(query.IsFavorite ?? query.isFavorite ?? "").toLowerCase() === "true"
      || String(query.IsPlayed ?? query.isPlayed ?? "").toLowerCase() === "true";
    const sortFields = String(query.SortBy ?? query.sortBy ?? "").split(",").map((field) => field.trim().toLowerCase());
    return context.libraryKind !== "content_source_video" && !hasStateFilter && sortFields[0] === "dateplayed"
      ? compatibility.listHistory(context, query)
      : compatibility.listItems(context, query);
  });
  server.get(`${prefix}/Users/:userId/Items/:itemId/UserData`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.getUserData(context, params.itemId); });
  server.post(`${prefix}/Users/:userId/Items/:itemId/UserData`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.updateUserData(context, params.itemId, (request.body ?? {}) as Record<string, unknown>); });
  server.get(`${prefix}/Items/Counts`, async (request) => compatibility.getItemCounts(await authenticated(request)));
  server.get(`${prefix}/Items/:itemId/Similar`, async (request) => compatibility.listSimilar(await authenticated(request), String((request.params as { itemId: string }).itemId), readQuery(request)));
  server.get(`${prefix}/Items/:itemId`, async (request) => {
    const context = await authenticated(request);
    const protocolItemId = String((request.params as { itemId: string }).itemId);
    const personItem = await compatibility.getPersonItem(context, protocolItemId);
    if (personItem) return personItem;
    return compatibility.getItemDetail(context, protocolItemId);
  });
  server.get(`${prefix}/Items`, async (request) => compatibility.listItems(await authenticated(request), readQuery(request)));
  server.get(`${prefix}/Persons`, async (request) => compatibility.listPersons(await authenticated(request), readQuery(request)));
  server.get(`${prefix}/Persons/:name`, async (request) => {
    const context = await authenticated(request);
    const personName = String((request.params as { name: string }).name);
    const personItem = await compatibility.getPersonByName(context, personName);
    if (!personItem) throw new ApiError(404, "jellyfin_person_not_found", "演员不存在");
    return personItem;
  });
  server.get(`${prefix}/Items/:itemId/Ancestors`, async (request) => {
    const context = await authenticated(request);
    const protocolItemId = String((request.params as { itemId: string }).itemId);
    return compatibility.listItemAncestors(context, protocolItemId);
  });
  server.get(`${prefix}/Genres`, async (request) => compatibility.listGenres(await authenticated(request), readQuery(request)));
  server.get(`${prefix}/Library/VirtualFolders`, async (request) => { const context = await authenticated(request); const libraries = await compatibility.listLibraries(context); return listProtocolVirtualFolders(runtime, context, libraries.Items); });
  server.post(`${prefix}/Library/Media/Updated`, async (request, reply) => { const context = await authenticated(request); await enqueueProtocolScan(runtime, context, "jellyfin", "Library/Media/Updated"); return reply.status(204).send(); });
  server.post(`${prefix}/Library/Refresh`, async (request, reply) => { const context = await authenticated(request); await enqueueProtocolScan(runtime, context, "jellyfin", "Library/Refresh"); return reply.status(204).send(); });
  server.post(`${prefix}/Items/:itemId/Refresh`, async (request, reply) => { const context = await authenticated(request); const itemId = String((request.params as { itemId: string }).itemId); const libraries = await compatibility.listLibraries(context); const isLibrary = libraries.Items.some((item) => String(item.Id) === itemId); if (!isLibrary) await compatibility.getItemDetail(context, itemId); await enqueueProtocolScan(runtime, context, "jellyfin", "Items/{ItemId}/Refresh", itemId); return reply.status(204).send(); });
  server.get(`${prefix}/Search/Hints`, async (request) => {
    const context = await authenticated(request);
    const query = readQuery(request);
    // 关键变量：非空关键词允许实时源搜索，空词仍走原本地提示列表。
    const searchTerm = String(query.SearchTerm ?? query.searchTerm ?? "").trim();
    const result = await compatibility.listItems(context, { ...query, SearchTerm: searchTerm, Limit: query.Limit ?? query.limit ?? 50 }, { localOnly: !searchTerm });
    return { SearchHints: result.Items.map((item: Record<string, unknown>) => ({ ItemId: item.Id, Id: item.Id, Name: item.Name, Type: item.Type, ProductionYear: item.ProductionYear, PrimaryImageTag: (item.ImageTags as Record<string, unknown>)?.Primary })), TotalRecordCount: result.TotalRecordCount };
  });
  server.get(`${prefix}/Shows/:seriesId/Seasons`, async (request) => compatibility.listSeasons(await authenticated(request), String((request.params as { seriesId: string }).seriesId)));
  server.get(`${prefix}/Shows/:seriesId/Episodes`, async (request) => compatibility.listEpisodes(await authenticated(request), String((request.params as { seriesId: string }).seriesId), readQuery(request)));
  server.get(`${prefix}/Shows/NextUp`, async (request) => compatibility.listNextUp(await authenticated(request), readQuery(request)));
  server.route({ method: ["GET", "POST"], url: `${prefix}/Items/:itemId/PlaybackInfo`, handler: async (request) => buildPlaybackInfo(runtime, compatibility, await authenticated(request), request, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Download`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId), "download") });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/File`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId), "download") });
  // 官方 Jellyfin 使用 /Videos；Fastify 已按 Jellyfin 行为配置为大小写不敏感，Flymby 的 /videos 同样命中。
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream.:container`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/master.m3u8`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/content/:ticket`, handler: async (request, reply) => {
    const context = await authenticated(request);
    if (!isContentSourceLibrary(context.libraryKind)) throw new ApiError(404, "content_resource_not_found", "播放资源不存在");
    const params = request.params as { itemId: string; ticket: string };
    const internalItemId = compatibility.toInternalItemId(params.itemId);
    return sendContentResource(runtime, context, request, reply, internalItemId, compatibility.toProtocolItemId(internalItemId), params.ticket);
  } });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  // 兼容 Jellyfin 旧客户端仍在使用的完整图片路径参数形式，实际缩放参数由上游图片承担。
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index/:tag/:format/:maxWidth/:maxHeight/:percentPlayed/:unplayedCount`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  server.post(`${prefix}/Sessions/Playing`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "playing", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Playing/Progress`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "progress", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Playing/Stopped`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "stopped", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  // Jellyfin 10.8 及旧客户端的用户路径，响应直接返回 UserItemDataDto。
  server.post(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.setPlayed(context, params.itemId, true); });
  server.delete(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.setPlayed(context, params.itemId, false); });
  server.post(`${prefix}/Users/:userId/FavoriteItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.setFavorite(context, params.itemId, true); });
  server.delete(`${prefix}/Users/:userId/FavoriteItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.setFavorite(context, params.itemId, false); });
  // Jellyfin 10.9+ SDK 使用的当前用户标准路径，用户由访问令牌确定。
  server.post(`${prefix}/UserPlayedItems/:itemId`, async (request) => compatibility.setPlayed(await authenticated(request), String((request.params as { itemId: string }).itemId), true));
  server.delete(`${prefix}/UserPlayedItems/:itemId`, async (request) => compatibility.setPlayed(await authenticated(request), String((request.params as { itemId: string }).itemId), false));
  server.post(`${prefix}/UserFavoriteItems/:itemId`, async (request) => compatibility.setFavorite(await authenticated(request), String((request.params as { itemId: string }).itemId), true));
  server.delete(`${prefix}/UserFavoriteItems/:itemId`, async (request) => compatibility.setFavorite(await authenticated(request), String((request.params as { itemId: string }).itemId), false));
  server.get(`${prefix}/UserItems/:itemId/UserData`, async (request) => compatibility.getUserData(await authenticated(request), String((request.params as { itemId: string }).itemId)));
  server.post(`${prefix}/UserItems/:itemId/UserData`, async (request) => compatibility.updateUserData(await authenticated(request), String((request.params as { itemId: string }).itemId), (request.body ?? {}) as Record<string, unknown>));
  server.post(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, true); return reply.status(204).send(); });
  server.delete(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, false); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Capabilities`, async (request, reply) => { await authenticated(request); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Capabilities/Full`, async (request, reply) => { await authenticated(request); return reply.status(204).send(); });
}

/** 注册 Jellyfin 协议兼容接口。 */
export async function registerJellyfinRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const compatibility = new JellyfinCompatibilityService(runtime);
  registerProtocolPrefix(server, runtime, compatibility, "/j/:jellyfinPathSuffix");
  // 关键变量：这是 Jellyfin 的历史路径兼容入口，仍使用 Jellyfin 服务、账号和用户状态，绝不会转到独立 Emby 协议。
  registerProtocolPrefix(server, runtime, compatibility, "/j/:jellyfinPathSuffix/emby");
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-jellyfin-route",
    事件: "已注册Jellyfin标准与历史兼容入口",
    标准入口: "/j/{路径}",
    历史兼容入口: "/j/{路径}/emby",
  });
}
