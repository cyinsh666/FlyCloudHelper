import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { MediaLibraryRecord, LibrarySourceRecord } from "../domain.js";
import type { ProviderBrowseListing, ScanRoot } from "../providers/types.js";
import { readManualVideoMatchType } from "../media/manual-video-match.js";
import { createStableId } from "../media/filename.js";
import type { ApiRuntime } from "../runtime.js";
import { readProviderDirectoryParent } from "./service-routes.js";

interface BrowseContext {
  library: MediaLibraryRecord;
  source: LibrarySourceRecord;
}

interface FileBrowseSummary {
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

/** 目录缓存仅保存 Provider 文件信息，不保存连接凭据或播放地址。 */
const browseCache = new Map<string, { listing: ProviderBrowseListing; expiresAt: number }>();
const BROWSE_CACHE_MS = 30_000;

/** 核对视频库和来源的归属，管理员入口使用媒体库所属用户的凭据。 */
async function requireBrowseContext(runtime: ApiRuntime, libraryId: string, sourceId: string, userId?: string): Promise<BrowseContext> {
  const library = await runtime.repository.getLibrary(libraryId, userId);
  if (library.libraryKind === "content_source_video" || library.libraryKind === "content_source_music") {
    throw new ApiError(409, "content_source_has_no_drive_files", "在线内容库请使用目录同步管理内容");
  }
  if (library.dataType !== "video") throw new ApiError(409, "video_library_required", "文件浏览当前只支持视频媒体库");
  const source = await runtime.repository.getLibrarySource(sourceId, library.userId);
  if (source.libraryId !== library.id) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
  return { library, source };
}

/** 需要实时读取网盘时，检查媒体库来源和当前登录状态。 */
function requireReadySource(context: BrowseContext): void {
  const { source } = context;
  if (context.library.status !== "active" || source.status !== "active" || source.connectionStatus !== "valid"
    || !source.credentialConfigured || (source.serviceStatus !== null
      && source.serviceStatus !== "active" && source.serviceStatus !== "scanning")) {
    throw new ApiError(409, "library_source_not_ready", "网盘来源当前不可用，请先重新登录或启用来源");
  }
}

/** 解析浏览排序；文件夹始终排在文件前面。 */
function sortBrowseItems(listing: ProviderBrowseListing, sort: string, descending: boolean): ProviderBrowseListing["items"] {
  const factor = descending ? -1 : 1;
  return [...listing.items].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    let comparison = 0;
    if (sort === "modified") comparison = String(left.modifiedAt ?? "").localeCompare(String(right.modifiedAt ?? ""));
    if (sort === "size") comparison = left.size - right.size;
    return factor * (comparison || left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
  });
}

/** 读取当前目录完整直接子项；短时缓存用于分页避免每次翻页重复请求网盘。 */
async function loadBrowseListing(runtime: ApiRuntime, context: BrowseContext, parent: ScanRoot | undefined, refresh: boolean): Promise<ProviderBrowseListing> {
  const key = JSON.stringify([context.library.id, context.source.id, context.source.credentialRevision,
    parent?.resourceId ?? "", parent?.displayPath ?? "", parent?.driveId ?? ""]);
  const cached = browseCache.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.listing;
  const configuration = await runtime.repository.getLibrarySourceRuntimeConfiguration(context.source.id, context.library.userId);
  const listing = await runtime.providers.get(context.source.providerType).browseEntries(
    runtime.vault.decrypt(configuration.encryptedConnection), parent, undefined,
    { persistConnection: async (nextConnection) => runtime.repository.refreshLibrarySourceEncryptedConnection({
      librarySourceId: context.source.id,
      userId: context.library.userId,
      credentialRevision: configuration.credentialRevision,
      encryptedConnection: runtime.vault.encrypt(nextConnection),
    }) },
  );
  if (browseCache.size >= 80) browseCache.delete(browseCache.keys().next().value ?? "");
  browseCache.set(key, { listing, expiresAt: Date.now() + BROWSE_CACHE_MS });
  return listing;
}

/** 写操作重新读取目标文件，使用 Provider 返回的路径和父目录身份。 */
async function requireCurrentBrowseTarget(runtime: ApiRuntime, context: BrowseContext, body: {
  parent?: Record<string, unknown>; resourceId?: string; isDirectory?: boolean;
}) {
  requireReadySource(context);
  const parent = readProviderDirectoryParent(body.parent ?? {});
  if (typeof body.resourceId !== "string" || !body.resourceId || body.resourceId.length > 2000
    || typeof body.isDirectory !== "boolean") throw validationError("resourceId", "请选择有效的文件或文件夹");
  const listing = await loadBrowseListing(runtime, context, parent, true);
  const target = listing.items.find((entry) => entry.resourceId === body.resourceId && entry.isDirectory === body.isDirectory);
  if (!target) throw new ApiError(404, "browse_target_missing", "目标文件已不存在，请刷新文件浏览");
  return { listing, target };
}

/** 文件关联写入避开同来源正在运行或等待恢复的扫描任务。 */
async function requireNoSourceScan(runtime: ApiRuntime, context: BrowseContext): Promise<void> {
  const active = await runtime.database.query("scan_jobs").select("id")
    .where({ user_id: context.library.userId, library_source_id: context.source.id })
    .whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first();
  if (active) throw new ApiError(409, "browse_source_scanning", "当前来源有未结束的扫描任务，请先等待任务完成");
}

/** 返回不含 Provider 内部定位信息的文件列表页。 */
async function browseLibraryFiles(runtime: ApiRuntime, context: BrowseContext, query: Record<string, unknown>) {
  requireReadySource(context);
  const parent = readProviderDirectoryParent(query);
  const sort = typeof query.sort === "string" ? query.sort : "name";
  if (sort !== "name" && sort !== "modified" && sort !== "size") throw validationError("sort", "不支持的文件排序方式");
  const descending = query.descending === "true";
  const offset = Number(query.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0) throw validationError("offset", "分页位置无效");
  const listing = await loadBrowseListing(runtime, context, parent, query.refresh === "true");
  const sorted = sortBrowseItems(listing, sort, descending);
  const limit = 100;
  return {
    current: listing.current,
    items: sorted.slice(offset, offset + limit).map(({ locator: _locator, ...item }) => item),
    total: sorted.length,
    nextOffset: offset + limit < sorted.length ? offset + limit : null,
  };
}

/** 查询一个文件或目录子树内的有效视频关联摘要。 */
async function readBrowseSummary(runtime: ApiRuntime, context: BrowseContext, target: {
  resourceId: string; displayPath: string; isDirectory: boolean;
}): Promise<FileBrowseSummary> {
  const files = runtime.database.query("source_files as f")
    .where({ "f.library_id": context.library.id, "f.library_source_id": context.source.id, "f.status": "active" });
  if (target.isDirectory) {
    const prefix = `${target.displayPath.replace(/\/+$/u, "")}/`;
    files.whereRaw("f.path LIKE ? ESCAPE '!'", [`${prefix.replace(/[!%_]/gu, "!$&")}%`]);
  } else {
    files.where({ "f.provider_resource_id": target.resourceId.length > 500
      ? createStableId("resource", target.resourceId) : target.resourceId });
  }
  const rows = await files.join("file_links as fl", "fl.source_file_id", "f.id")
    .join("media_items as linked", "linked.id", "fl.item_id")
    .leftJoin("media_relations as relation", "relation.child_item_id", "linked.id")
    .leftJoin("media_items as parent", "parent.id", "relation.parent_item_id")
    .leftJoin("media_relations as grand_relation", "grand_relation.child_item_id", "parent.id")
    .leftJoin("media_items as grandparent", "grandparent.id", "grand_relation.parent_item_id")
    .select("f.id as file_id", "linked.id as linked_id", "linked.item_type as linked_type",
      "linked.title as linked_title", "linked.year as linked_year", "linked.poster_url as linked_poster",
      "linked.match_state as linked_match", "linked.metadata_json as linked_metadata",
      "parent.id as parent_id", "parent.item_type as parent_type", "parent.title as parent_title", "parent.year as parent_year",
      "parent.poster_url as parent_poster", "parent.match_state as parent_match", "parent.metadata_json as parent_metadata",
      "grandparent.id as grand_id", "grandparent.item_type as grand_type", "grandparent.title as grand_title",
      "grandparent.year as grand_year", "grandparent.poster_url as grand_poster",
      "grandparent.match_state as grand_match", "grandparent.metadata_json as grand_metadata")
    .whereNull("linked.deleted_at");
  const fileIds = new Set<string>();
  const items = new Map<string, { id: string; title: string; year: number | null; posterUrl: string | null; matchState: string; metadata: string }>();
  for (const row of rows) {
    fileIds.add(String(row.file_id));
    const grandIsVideo = row.grand_id && (row.grand_type === "video.movie" || row.grand_type === "video.series");
    const parentIsVideo = row.parent_id && (row.parent_type === "video.movie" || row.parent_type === "video.series");
    const selected = grandIsVideo ? { id: row.grand_id, title: row.grand_title, year: row.grand_year,
      poster: row.grand_poster, match: row.grand_match, metadata: row.grand_metadata }
      : parentIsVideo ? { id: row.parent_id, title: row.parent_title, year: row.parent_year,
        poster: row.parent_poster, match: row.parent_match, metadata: row.parent_metadata }
        : { id: row.linked_id, title: row.linked_title, year: row.linked_year,
          poster: row.linked_poster, match: row.linked_match, metadata: row.linked_metadata };
    const id = String(selected.id);
    items.set(id, { id, title: String(selected.title), year: Number(selected.year) || null,
      posterUrl: selected.poster ?? null, matchState: String(selected.match), metadata: String(selected.metadata) });
  }
  const item = items.size === 1 ? [...items.values()][0] : null;
  let manualMatched = false;
  if (item) {
    try {
      const metadata = JSON.parse(item.metadata) as Record<string, unknown>;
      manualMatched = Boolean(metadata.manualMatch && typeof metadata.manualMatch === "object"
        && Object.keys(metadata.manualMatch).length > 0);
    } catch { manualMatched = false; }
  }
  return { resourceId: target.resourceId, linkedFileCount: fileIds.size, itemCount: items.size,
    itemId: item?.id ?? null, title: item?.title ?? null, year: item?.year ?? null,
    posterUrl: item?.posterUrl ?? null, matchState: item?.matchState ?? null, manualMatched };
}

/** 注册视频媒体库文件浏览入口，普通用户与管理员共享相同的来源隔离逻辑。 */
export async function registerLibraryFileRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
    server.get<{ Params: { libraryId: string; sourceId: string }; Querystring: Record<string, unknown> }>(
      `${prefix}/:libraryId/sources/:sourceId/browse`, async (request) => {
        const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
        const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
        return browseLibraryFiles(runtime, context, request.query);
      });
    server.post<{ Params: { libraryId: string; sourceId: string }; Body: { targets?: Array<{ resourceId: string; displayPath: string; isDirectory: boolean }> } }>(
      `${prefix}/:libraryId/sources/:sourceId/browse/summaries`, async (request) => {
        const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
        const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
        const targets = request.body?.targets;
        if (!Array.isArray(targets) || targets.length > 100) throw validationError("targets", "一次最多查询 100 个文件摘要");
        const items: FileBrowseSummary[] = [];
        for (const target of targets) {
          if (typeof target.resourceId !== "string" || typeof target.displayPath !== "string"
            || typeof target.isDirectory !== "boolean") throw validationError("targets", "文件摘要参数无效");
          items.push(await readBrowseSummary(runtime, context, target));
        }
        return { items };
      });
    server.post<{ Params: { libraryId: string; sourceId: string }; Body: {
      parent?: Record<string, unknown>; resourceId?: string; isDirectory?: boolean;
    } }>(`${prefix}/:libraryId/sources/:sourceId/browse/scan`, async (request, reply) => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
      // 关键变量：重新从网盘读取目标，避免用过期路径或其他来源的资源编号创建扫描任务。
      const { listing, target } = await requireCurrentBrowseTarget(runtime, context, request.body ?? {});
      if (!target.isDirectory && !/\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|mpg|mpeg|rmvb|webm|3gp|iso|strm)$/iu.test(target.name)) {
        throw new ApiError(422, "browse_target_not_video", "只能对视频文件或文件夹执行定向扫描");
      }
      const profiles = await runtime.repository.getLibraryProfiles(context.library.id, context.library.userId);
      const job = await runtime.repository.createScanJob({
        jobId: randomUUID(), userId: context.library.userId, libraryId: context.library.id,
        librarySourceId: context.source.id, requestedByUserId: user.id,
        requestId: randomUUID(), clientDeviceId: "library-file-browser", scanMode: "incremental",
        runtimeRevision: "scanner-worker-v1", tmdbKeyPoolRevision: runtime.tmdb.revision,
        aiModel: await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile),
        pluginVersions: await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile),
        targetedScope: {
          kind: target.isDirectory ? "folder" : "video", resourceId: target.resourceId,
          parentResourceId: listing.current.resourceId, displayPath: target.displayPath,
          parentDisplayPath: listing.current.displayPath,
          ...(target.driveId || listing.current.driveId ? { driveId: target.driveId || listing.current.driveId } : {}),
        },
      });
      return reply.status(202).send({ job });
    });
    server.post<{ Params: { libraryId: string; sourceId: string }; Body: {
      parent?: Record<string, unknown>; resourceId?: string; isDirectory?: boolean;
    } }>(`${prefix}/:libraryId/sources/:sourceId/browse/unmatch/preview`, async (request) => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
      const { target } = await requireCurrentBrowseTarget(runtime, context, request.body ?? {});
      return runtime.repository.previewBrowseUnmatch({ userId: context.library.userId,
        libraryId: context.library.id, librarySourceId: context.source.id,
        resourceId: target.resourceId, displayPath: target.displayPath, isDirectory: target.isDirectory });
    });
    server.post<{ Params: { libraryId: string; sourceId: string }; Body: {
      parent?: Record<string, unknown>; resourceId?: string; isDirectory?: boolean; expectedRevision?: string;
    } }>(`${prefix}/:libraryId/sources/:sourceId/browse/unmatch`, async (request) => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
      const { target } = await requireCurrentBrowseTarget(runtime, context, request.body ?? {});
      await requireNoSourceScan(runtime, context);
      if (typeof request.body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/u.test(request.body.expectedRevision)) {
        throw validationError("expectedRevision", "请先预览解除范围");
      }
      return runtime.repository.unmatchBrowseRange({ userId: context.library.userId,
        libraryId: context.library.id, librarySourceId: context.source.id,
        resourceId: target.resourceId, displayPath: target.displayPath, isDirectory: target.isDirectory,
        expectedRevision: request.body.expectedRevision });
    });
    server.get<{ Params: { libraryId: string; sourceId: string }; Querystring: Record<string, unknown> }>(
      `${prefix}/:libraryId/sources/:sourceId/browse/manual-match/search`, async (request) => {
        const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
        await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
        const query = request.query.query;
        if (typeof query !== "string" || !query.trim() || [...query.trim()].length > 200) {
          throw validationError("query", "请输入不超过 200 字的影视名称");
        }
        const mediaType = readManualVideoMatchType(request.query.mediaType);
        const year = request.query.year === undefined || request.query.year === "" ? null : Number(request.query.year);
        if (year !== null && (!Number.isInteger(year) || year < 1800 || year > 2200)) {
          throw validationError("year", "年份必须在 1800 到 2200 之间");
        }
        const status = runtime.tmdb.getStatus();
        if (status.configuredCount === 0) {
          throw new ApiError(503, "tmdb_not_configured", "系统尚未配置 TMDB Key");
        }
        const temporaryError = runtime.tmdb.getTemporaryUnavailableError();
        if (temporaryError) throw temporaryError;
        if (status.healthyCount === 0) {
          throw new ApiError(503, "tmdb_unavailable", "已配置的 TMDB Key 无法使用，请检查 Key 或代理地址；Key 配置仍然保留");
        }
        return { items: await runtime.tmdb.searchVideoCandidates({
          mediaType, title: query.trim(), year, language: "zh-CN", region: "CN",
        }) };
      });
    server.post<{ Params: { libraryId: string; sourceId: string }; Body: {
      parent?: Record<string, unknown>; resourceId?: string; isDirectory?: boolean;
      expectedRevision?: string; mediaType?: unknown; tmdbId?: unknown;
    } }>(`${prefix}/:libraryId/sources/:sourceId/browse/manual-match`, async (request) => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      const context = await requireBrowseContext(runtime, request.params.libraryId, request.params.sourceId, admin ? undefined : user.id);
      const { target } = await requireCurrentBrowseTarget(runtime, context, request.body ?? {});
      await requireNoSourceScan(runtime, context);
      if (typeof request.body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/u.test(request.body.expectedRevision)) {
        throw validationError("expectedRevision", "请先预览手动匹配范围");
      }
      const mediaType = readManualVideoMatchType(request.body.mediaType);
      const tmdbId = Number(request.body.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw validationError("tmdbId", "请选择有效的 TMDB 条目");
      if (runtime.tmdb.getStatus().configuredCount === 0) {
        throw new ApiError(503, "tmdb_not_configured", "系统尚未配置 TMDB Key");
      }
      const metadata = await runtime.tmdb.readVideoMetadata(mediaType, tmdbId, "zh-CN", "CN");
      if (!metadata) throw new ApiError(502, "tmdb_item_unavailable", "无法读取所选 TMDB 条目");
      return runtime.repository.applyBrowseManualMatch({ userId: context.library.userId,
        libraryId: context.library.id, librarySourceId: context.source.id,
        resourceId: target.resourceId, displayPath: target.displayPath, isDirectory: target.isDirectory,
        expectedRevision: request.body.expectedRevision, metadata });
    });
  }
}
