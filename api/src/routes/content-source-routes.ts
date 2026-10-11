import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireObject, requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import type { ContentSourcePlaybackMode, ContentSourcePlaybackProtocol } from "../content-sources/types.js";

/** 读取用户选择的视频分类，创建库不允许默认为全站。 */
function readCategoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id || id.length > 128)) throw validationError("categoryIds", "请选择有效的视频分类");
  return value as string[];
}

/** 读取同步模式，连续导入和刷新已有目录保持独立语义。 */
function readSyncOptions(body: Record<string, unknown> | undefined): { pageCount?: number; mode?: "next" | "refresh" } {
  if (body?.mode !== undefined && body.mode !== "next" && body.mode !== "refresh") throw validationError("mode", "同步模式只支持 next 或 refresh");
  return { ...(body?.pageCount !== undefined ? { pageCount: Number(body.pageCount) } : {}), ...(body?.mode ? { mode: body.mode as "next" | "refresh" } : {}) };
}

/** 严格校验协议和三种播放模式，避免未知值写入在线库配置。 */
function readPlaybackMode(value: unknown): { protocol: ContentSourcePlaybackProtocol; mode: ContentSourcePlaybackMode } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("playbackModes", "播放模式配置格式无效");
  const body = value as Record<string, unknown>;
  if (body.protocol !== "jellyfin" && body.protocol !== "emby") throw validationError("protocol", "播放协议只支持 jellyfin 或 emby");
  if (body.mode !== "auto" && body.mode !== "direct" && body.mode !== "relay") throw validationError("mode", "播放模式只支持 auto、direct 或 relay");
  return { protocol: body.protocol, mode: body.mode };
}

/** 注册独立源插件、用户配置实例和在线库同步接口。 */
export async function registerContentSourceRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/content-source-plugins", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.contentSources.listPlugins(user.role === "super_admin") };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/content-source-plugins/import", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    const manifest = requireObject(request.body, "manifest", "内容源插件清单");
    const plugin = await runtime.contentSources.importPlugin(manifest);
    reply.code(201);
    return { plugin };
  });

  for (const [action, status] of [["enable", "enabled"], ["disable", "disabled"], ["uninstall", "uninstalled"]] as const) {
    server.post<{ Params: { pluginId: string; version: string } }>(`/api/v1/admin/content-source-plugins/:pluginId/:version/${action}`, async (request) => {
      await requireSuperAdmin(request, runtime.database);
      return { plugin: await runtime.contentSources.setPluginStatus(request.params.pluginId, request.params.version, status) };
    });
  }

  server.get("/api/v1/content-sources", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.contentSources.listInstances(user.id) };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/content-sources", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const source = await runtime.contentSources.createInstance(user.id, {
      pluginId: requireString(request.body, "pluginId", "插件 ID", 128),
      pluginVersion: requireString(request.body, "pluginVersion", "插件版本", 64),
      displayName: requireString(request.body, "displayName", "源实例名称", 100),
    });
    reply.code(201);
    return { source };
  });

  for (const admin of [false, true]) {
    const base = admin ? "/api/v1/admin/content-sources/:id" : "/api/v1/content-sources/:id";
    server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(base, async (request) => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      let ownerUserId = user.id;
      if (admin) {
        const source = await runtime.database.query("content_source_instances").select("user_id").where({ id: request.params.id }).first();
        if (!source) throw new ApiError(404, "content_source_not_found", "内容源实例不存在");
        ownerUserId = String(source.user_id);
      }
      if (request.body.status !== undefined && request.body.status !== "active" && request.body.status !== "disabled") throw validationError("status", "实例状态只支持 active 或 disabled");
      return { source: await runtime.contentSources.updateInstance(request.params.id, ownerUserId, {
        ...(request.body.displayName !== undefined ? { displayName: requireString(request.body, "displayName", "源实例名称", 100) } : {}),
        ...(request.body.status ? { status: request.body.status as "active" | "disabled" } : {}),
      }) };
    });
  }

  server.get<{ Params: { id: string } }>("/api/v1/content-sources/:id/categories", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.contentSources.categories(request.params.id, user.id) };
  });

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/content-sources/:id/libraries", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const result = await runtime.contentSources.createLibrary(request.params.id, user.id, {
      displayName: requireString(request.body, "displayName", "媒体库名称", 100),
      categoryIds: readCategoryIds(request.body.categoryIds),
      ...(request.body.initialPageCount !== undefined ? { initialPageCount: Number(request.body.initialPageCount) } : {}),
    });
    reply.code(201);
    return result;
  });

  for (const admin of [false, true]) {
    const base = admin ? "/api/v1/admin/content-source-libraries/:libraryId" : "/api/v1/content-source-libraries/:libraryId";
    /** 管理员操作先解析实际所有者，目录仓储继续保留严格用户作用域。 */
    const ownerId = async (libraryId: string, request: Parameters<typeof requireRequestUser>[0]): Promise<string> => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      if (!admin) return user.id;
      return (await runtime.repository.getLibrary(libraryId)).userId;
    };
    server.get<{ Params: { libraryId: string } }>(base, async (request) => {
      return runtime.contentSources.getLibrary(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.get<{ Params: { libraryId: string } }>(`${base}/categories`, async (request) => {
      return { items: await runtime.contentSources.libraryCategories(request.params.libraryId, await ownerId(request.params.libraryId, request)) };
    });
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/categories`, async (request) => {
      return runtime.contentSources.updateLibraryCategories(request.params.libraryId, await ownerId(request.params.libraryId, request), readCategoryIds(request.body.categoryIds));
    });
    server.get<{ Params: { libraryId: string } }>(`${base}/playback-modes`, async (request) => {
      return runtime.contentSources.getLibraryPlaybackModes(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/playback-modes`, async (request) => {
      const userId = await ownerId(request.params.libraryId, request);
      const { protocol, mode } = readPlaybackMode(request.body);
      return runtime.contentSources.setLibraryPlaybackMode(request.params.libraryId, userId, protocol, mode);
    });
    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/sync`, async (request, reply) => {
      const sync = await runtime.contentSources.startLibrarySync(request.params.libraryId, await ownerId(request.params.libraryId, request), readSyncOptions(request.body));
      reply.code(202);
      return { sync };
    });
  }
}
