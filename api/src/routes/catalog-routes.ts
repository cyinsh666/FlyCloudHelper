import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CatalogSort, MatchState, MediaType } from "../domain.js";
import { ApiError } from "../errors.js";
import { readPagination, requireRequestUser } from "../http.js";
import {
  applyManualVideoMatch,
  clearManualVideoMatch,
  searchManualVideoMatches,
} from "../media/manual-video-match.js";
import { hydrateRealtimeVideoDetails } from "../media/realtime-video-details.js";
import type { ApiRuntime } from "../runtime.js";
import { ensureContentAudiobookDetail } from "../audiobooks/content-source-detail.js";

/** 查询媒体库并强制当前用户归属。 */
async function requireLibrary(runtime: ApiRuntime, libraryId: string, userId: string) {
  const row = await runtime.database.query("media_libraries as l")
    .select("l.id", "l.catalog_version", "l.library_kind")
    .where("l.id", libraryId)
    .where("l.user_id", userId)
    .first();
  if (!row) throw new ApiError(404, "library_not_found", "媒体库不存在");
  return row;
}

/** 验证媒体条目属于 URL 指定媒体库。 */
async function requireLibraryItem(runtime: ApiRuntime, userId: string, libraryId: string, itemId: string) {
  const item = await runtime.repository.getCatalogItem(itemId, userId);
  if (item.libraryId !== libraryId) {
    throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
  }
  return item;
}

/** 记录普通用户对媒体匹配结果的人工修改。 */
async function auditCatalogAction(
  runtime: ApiRuntime,
  user: { id: string; username: string },
  operationType: string,
  itemId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: user.id,
    operatorUsername: user.username,
    operationType,
    targetType: "media_item",
    targetId: itemId,
    result: "success",
    detail,
  });
}

/** 注册网页管理和普通用户使用的媒体目录接口。 */
export async function registerCatalogRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  /** 执行带媒体库作用域的目录列表和搜索。 */
  const listLibraryItems = async (
    request: FastifyRequest<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>,
  ) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const sortValue = request.query.sort;
    const supportedSorts = new Set([
      "created_desc", "created_asc", "updated_desc", "updated_asc",
      "year_desc", "year_asc", "premiere_date_desc", "premiere_date_asc",
      "title_asc", "title_desc",
    ]);
    const sort = typeof sortValue === "string" && supportedSorts.has(sortValue)
      ? sortValue as CatalogSort
      : "created_desc";
    const pagination = readPagination(request.query);
    const searchTerm = typeof request.query.search === "string" ? request.query.search : typeof request.query.q === "string" ? request.query.q : "";
    const remoteIds = library.library_kind === "content_source_audiobook" && searchTerm.trim()
      ? await runtime.contentAudiobooks.search(request.params.libraryId, user.id, searchTerm, Math.min(200, pagination.offset + pagination.limit))
      : undefined;
    // 关键变量：实时搜索可能写入新摘要，返回写入后的目录版本。
    const catalogVersion = remoteIds === undefined
      ? Number(library.catalog_version)
      : Number((await requireLibrary(runtime, request.params.libraryId, user.id)).catalog_version);
    if (remoteIds?.length === 0) return { items: [], total: 0, catalogVersion };
    // 关键变量：目录查询耗时用于判断 SQLite 是否再次被扫描任务或慢查询阻塞。
    const queryStartedAt = Date.now();
    request.log.info({
      日志关键字: "codex-catalog-query",
      事件: "媒体目录查询开始",
      媒体库ID: request.params.libraryId,
      排序方式: sort,
      返回上限: pagination.limit,
      偏移量: pagination.offset,
    });
    try {
      const result = await runtime.repository.listCatalogItems({
        userId: user.id,
        libraryId: request.params.libraryId,
        itemIds: remoteIds ?? (typeof request.query.ids === "string"
          ? request.query.ids.split(",").map((value) => value.trim()).filter((value) => value.length > 0).slice(0, 200)
          : undefined),
        mediaType: typeof request.query.mediaType === "string" ? request.query.mediaType as MediaType : undefined,
        itemType: typeof request.query.itemType === "string" ? request.query.itemType : undefined,
        matchState: typeof request.query.matchState === "string" ? request.query.matchState as MatchState : undefined,
        categoryKey: typeof request.query.categoryKey === "string" ? request.query.categoryKey : undefined,
        genre: typeof request.query.genre === "string" ? request.query.genre : undefined,
        search: remoteIds === undefined ? searchTerm || undefined : undefined,
        sort,
        ...pagination,
      });
      request.log.info({
        日志关键字: "codex-catalog-query",
        事件: "媒体目录查询完成",
        媒体库ID: request.params.libraryId,
        查询耗时毫秒: Date.now() - queryStartedAt,
        返回数量: result.items.length,
        总数量: result.total,
      });
      return { ...result, catalogVersion };
    } catch (error) {
      request.log.warn({
        日志关键字: "codex-catalog-query",
        事件: "媒体目录查询失败",
        媒体库ID: request.params.libraryId,
        查询耗时毫秒: Date.now() - queryStartedAt,
        错误: error,
      });
      throw error;
    }
  };

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/items", listLibraryItems);
  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/search", listLibraryItems);

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    // 网页单条详情与标准协议共用 Python 补齐，权限检查完成后才请求源站。
    if (item.libraryKind === "content_source_audiobook") await ensureContentAudiobookDetail(runtime, item);
    else await runtime.contentSources.ensureItemDetail(request.params.libraryId, user.id, item.id);
    const detailed = await requireLibraryItem(runtime, user.id, request.params.libraryId, item.id);
    return { item: await hydrateRealtimeVideoDetails(runtime, detailed) };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/children", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    if (item.libraryKind === "content_source_audiobook") await ensureContentAudiobookDetail(runtime, item);
    else await runtime.contentSources.ensureItemDetail(request.params.libraryId, user.id, request.params.itemId);
    return { items: await runtime.repository.listCatalogChildren(request.params.itemId, user.id) };
  });

  /** 返回音乐专辑或歌曲关联的艺术家。 */
  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/artists", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    const artists = await runtime.repository.listCatalogMusicArtists(item.id, user.id);
    request.log.info({
      日志关键字: "codex-flycloud-helper-music-album-detail",
      事件: "读取音乐条目关联艺术家",
      媒体条目ID: item.id,
      媒体条目类型: item.itemType,
      艺术家数量: artists.length,
    });
    return { items: artists };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/paths", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return { items: await runtime.repository.listCatalogItemPaths(request.params.itemId, user.id) };
  });

  server.get<{
    Params: { libraryId: string; itemId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match/search", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return {
      items: await searchManualVideoMatches(runtime, item, {
        query: request.query.query,
        mediaType: request.query.mediaType,
        year: request.query.year,
      }),
    };
  });

  server.post<{
    Params: { libraryId: string; itemId: string };
    Body: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    const updatedItem = await applyManualVideoMatch(runtime, item, {
      mediaType: request.body.mediaType,
      tmdbId: request.body.tmdbId,
    });
    await auditCatalogAction(runtime, user, "manual_match_media_item", item.id, {
      匹配类型: request.body.mediaType,
      TMDB编号: request.body.tmdbId,
    });
    return { item: updatedItem };
  });

  server.post<{
    Params: { libraryId: string; itemId: string };
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match/clear", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    const updatedItem = await clearManualVideoMatch(runtime, item);
    await auditCatalogAction(runtime, user, "clear_media_item_match", item.id);
    return { item: updatedItem };
  });
}
