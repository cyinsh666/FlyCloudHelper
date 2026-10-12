import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireObject, requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import type { ContentSourcePlaybackMode, ContentSourcePlaybackProtocol } from "../content-sources/types.js";
import { importPythonSource, PYTHON_SOURCE_MAX_BYTES } from "../content-sources/python-import.js";

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

  /** 读取插件分类只做预览，不提前创建用户源记录。 */
  server.get<{ Params: { pluginId: string; version: string } }>("/api/v1/content-source-plugins/:pluginId/:version/categories", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.contentSources.previewPluginCategories(request.params.pluginId, request.params.version, user.id) };
  });

  /** 从已启用插件提交建库，服务端准备唯一内部实例，页面无需新增或选择源实例。 */
  server.post<{ Params: { pluginId: string; version: string }; Body: Record<string, unknown> }>("/api/v1/content-source-plugins/:pluginId/:version/libraries", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const manifest = await runtime.contentSources.manifestForPlugin(request.params.pluginId, request.params.version);
    const displayName = requireString(request.body, "displayName", "媒体库名称", 100);
    if (manifest.adapter === "netease_http") {
      const input = {
        displayName,
        ...(request.body.albumIds !== undefined ? { albumIds: readMusicIds(request.body.albumIds, "albumIds") } : {}),
        ...(request.body.playlistIds !== undefined ? { playlistIds: readMusicIds(request.body.playlistIds, "playlistIds") } : {}),
      };
      const source = await runtime.contentSources.createInstance(user.id, { pluginId: manifest.pluginId, pluginVersion: manifest.version, displayName: manifest.displayName });
      const result = await runtime.contentMusic.createLibrary(source.id, user.id, input);
      reply.code(201);
      return result;
    }
    const input = {
      displayName,
      categoryIds: readCategoryIds(request.body.categoryIds),
      ...(request.body.initialPageCount !== undefined ? { initialPageCount: Number(request.body.initialPageCount) } : {}),
    };
    const source = await runtime.contentSources.createInstance(user.id, { pluginId: manifest.pluginId, pluginVersion: manifest.version, displayName: manifest.displayName });
    const result = await runtime.contentSources.createLibrary(source.id, user.id, input);
    reply.code(201);
    return result;
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/content-source-plugins/import", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    const manifest = requireObject(request.body, "manifest", "内容源插件清单");
    const plugin = await runtime.contentSources.importPlugin(manifest);
    reply.code(201);
    return { plugin };
  });

  /** 管理员在统一插件入口上传 Python 文件，完成静态检查后登记待启用版本。 */
  server.post("/api/v1/admin/content-source-plugins/import-python", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    const part = await request.file({ limits: { fileSize: PYTHON_SOURCE_MAX_BYTES, files: 1 } });
    if (!part) throw new ApiError(400, "python_source_file_required", "请选择 Python 内容源文件");
    if (!part.filename.toLowerCase().endsWith(".py")) {
      part.file.resume();
      throw new ApiError(415, "python_source_file_type_invalid", "请选择 .py 内容源文件");
    }
    const bytes = await part.toBuffer(); // 关键变量：最多读取 2 MB，UTF-8 校验后仍保存原始上传字节。
    if (part.file.truncated) throw new ApiError(413, "python_source_too_large", "Python 源文件不能超过 2 MB");
    const plugin = await importPythonSource(runtime, part.filename, bytes);
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
    const manifest = await runtime.contentSources.manifestForInstance(request.params.id, user.id);
    if (manifest.adapter === "netease_http") {
      const result = await runtime.contentMusic.createLibrary(request.params.id, user.id, {
        displayName: requireString(request.body, "displayName", "媒体库名称", 100),
        ...(request.body.albumIds !== undefined ? { albumIds: readMusicIds(request.body.albumIds, "albumIds") } : {}),
        ...(request.body.playlistIds !== undefined ? { playlistIds: readMusicIds(request.body.playlistIds, "playlistIds") } : {}),
      });
      reply.code(201);
      return result;
    }
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
    server.get<{ Params: { libraryId: string } }>(`${base}/auto-sync`, async (request) => {
      return runtime.contentSourceAutoSync.get(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/auto-sync`, async (request) => {
      const body = request.body ?? {};
      return runtime.contentSourceAutoSync.save(request.params.libraryId, await ownerId(request.params.libraryId, request), {
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
        ...(body.intervalMinutes !== undefined ? { intervalMinutes: body.intervalMinutes as number } : {}),
        ...(body.mode !== undefined ? { mode: body.mode as "latest" } : {}),
        ...(body.pageCount !== undefined ? { pageCount: body.pageCount as number } : {}),
      });
    });
    server.get<{ Params: { libraryId: string } }>(`${base}/diagnostics`, async (request) => {
      return runtime.contentSourceDiagnostics.get(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/diagnostics`, async (request) => {
      const checkPlayback = request.body?.checkPlayback;
      if (checkPlayback !== undefined && typeof checkPlayback !== "boolean") throw validationError("checkPlayback", "线路抽查开关必须为布尔值");
      return runtime.contentSourceDiagnostics.check(request.params.libraryId, await ownerId(request.params.libraryId, request), checkPlayback === true);
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

/** 读取网易专辑或歌单身份；空数组明确表示不建立该类初始目录。 */
function readMusicIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((id) => typeof id !== "string" || !/^\d{1,20}$/u.test(id))) throw validationError(field, "请提供不超过 50 个有效的网易数字 ID");
  return [...new Set(value as string[])];
}

/** 注册独立音乐源配置和手动同步，不复用网盘扫描接口。 */
export async function registerContentMusicRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const base = admin ? "/api/v1/admin/libraries/:libraryId/content-music" : "/api/v1/libraries/:libraryId/content-music";
    /** 管理入口使用真实库所有者，普通入口保持当前用户隔离。 */
    const ownerId = async (libraryId: string, request: Parameters<typeof requireRequestUser>[0]): Promise<string> => {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      return admin ? (await runtime.repository.getLibrary(libraryId)).userId : user.id;
    };
    server.get<{ Params: { libraryId: string } }>(base, async (request) => runtime.contentMusic.getLibrary(request.params.libraryId, await ownerId(request.params.libraryId, request)));
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(base, async (request) => {
      const body = request.body ?? {};
      if (body.playbackMode !== undefined && body.playbackMode !== "auto" && body.playbackMode !== "direct" && body.playbackMode !== "relay") throw validationError("playbackMode", "播放模式只支持 auto、direct 或 relay");
      return runtime.contentMusic.updateLibraryConfiguration(request.params.libraryId, await ownerId(request.params.libraryId, request), {
        ...(body.albumIds !== undefined ? { albumIds: readMusicIds(body.albumIds, "albumIds") } : {}),
        ...(body.playlistIds !== undefined ? { playlistIds: readMusicIds(body.playlistIds, "playlistIds") } : {}),
        ...(body.playbackMode !== undefined ? { playbackMode: body.playbackMode as ContentSourcePlaybackMode } : {}),
      });
    });
    // 网易账号独立于 Navidrome 协议账号，所有操作继续使用当前媒体库归属检查。
    const accountBase = `${base}/account`;
    server.get<{ Params: { libraryId: string } }>(accountBase, async (request) => {
      return runtime.contentMusic.getNeteaseAccount(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.post<{ Params: { libraryId: string } }>(`${accountBase}/qr`, async (request, reply) => {
      const session = await runtime.contentMusic.startNeteaseQr(request.params.libraryId, await ownerId(request.params.libraryId, request));
      reply.code(201);
      return session;
    });
    server.post<{ Params: { libraryId: string; sessionId: string } }>(`${accountBase}/qr/:sessionId/check`, async (request) => {
      return runtime.contentMusic.checkNeteaseQr(request.params.libraryId, await ownerId(request.params.libraryId, request), request.params.sessionId);
    });
    server.post<{ Params: { libraryId: string } }>(`${accountBase}/check`, async (request) => {
      return runtime.contentMusic.checkNeteaseAccount(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${accountBase}/session`, async (request) => {
      return runtime.contentMusic.importNeteaseSession(request.params.libraryId, await ownerId(request.params.libraryId, request),
        requireString(request.body ?? {}, "cookie", "网易网页登录凭据", 32 * 1024));
    });
    server.delete<{ Params: { libraryId: string } }>(accountBase, async (request) => {
      return runtime.contentMusic.logoutNeteaseAccount(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.post<{ Params: { libraryId: string } }>(`${base}/sync`, async (request, reply) => {
      const sync = await runtime.contentMusic.syncLibrary(request.params.libraryId, await ownerId(request.params.libraryId, request));
      reply.code(202);
      return { sync };
    });
  }
}
