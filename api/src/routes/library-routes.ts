import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseJsonObject, type LibraryScanJobRecord, type LibrarySourceRecord, type MediaType } from "../domain.js";
import { ApiError, toSafeErrorMessage, validationError } from "../errors.js";
import {
  readPagination,
  requireConfirmation,
  requireObject,
  requireRequestUser,
  requireString,
  requireSuperAdmin,
} from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import {
  buildAggregateScanCompletionMessage,
  createEmptyScanCreatedMediaCounts,
} from "../scan-notification.js";
import {
  consumeProviderAuthorization,
  getScanRootsForMode,
  readProviderDirectoryParent,
  readMusicMetadataLogFields,
  readVideoMetadataLogFields,
  resolveProviderConnection,
  validateConfiguredScanRoots,
  validateMetadataProfile,
  validateProviderAccess,
  validateProviderDataType,
  validateScanProfile,
  validateServiceDataType,
} from "./service-routes.js";

/** 云聚合视频库没有来源时使用的媒体库级默认扫描参数；具体根目录保存在各来源配置中。 */
function createCloudAggregateScanProfile(): Record<string, unknown> {
  return {
    fullRoots: [],
    incrementalRoots: [],
    mediaTypes: ["video"],
    removedRootPolicy: "protect",
  };
}

/** 云聚合首期视频库使用与现有影视库一致的 TMDB 默认配置。 */
function createCloudAggregateMetadataProfile(): Record<string, unknown> {
  return {
    profiles: {
      video: {
        providerId: "builtin.tmdb",
        language: "zh-CN",
        region: "CN",
        useNfo: true,
        syncDetails: false,
        analyzeMediaSpecs: false,
        aiCleaning: { enabled: false, modelId: "", triggerMode: "weak_or_unmatched", minConfidence: 0.75 },
      },
    },
  };
}

/** 队列中的全部来源被直接取消时，由请求线程补发唯一的父任务汇总通知。 */
export async function notifyFinishedLibraryScanJob(runtime: ApiRuntime, parentJobId: string, userId: string): Promise<void> {
  const parentJob = await runtime.repository.claimLibraryScanJobCompletionNotification(parentJobId, userId);
  if (!parentJob) return;
  const notificationEnabled = await runtime.repository.isLibraryNotificationEnabled(parentJob.libraryId);
  let createdMediaCounts = createEmptyScanCreatedMediaCounts();
  try {
    createdMediaCounts = await runtime.repository.getLibraryScanCreatedMediaCounts(parentJob);
  } catch (error) {
    runtime.logBusinessEvent("warn", {
      日志关键字: "codex-flycloud-helper-service-notification",
      事件: "请求线程统计云聚合扫描新增入库内容失败",
      父任务ID: parentJob.id,
      媒体库ID: parentJob.libraryId,
      错误信息: error instanceof Error ? error.message : "未知数据库错误",
    });
  }
  const hasFailure = parentJob.failedSourceCount > 0;
  const hasErrors = parentJob.errorCount > 0;
  const wasCancelled = parentJob.status === "cancelled" || parentJob.cancelledSourceCount > 0;
  await runtime.database.createNotificationSafely({
    userId,
    category: "task",
    tone: hasFailure || hasErrors || wasCancelled ? "warning" : "success",
    title: hasFailure || hasErrors || wasCancelled ? "云聚合扫描异常结束" : "云聚合扫描已完成",
    message: buildAggregateScanCompletionMessage(parentJob, createdMediaCounts),
    actionPath: "/app/jobs",
    deliverExternally: notificationEnabled,
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-library-scan-parent",
    事件: "请求线程发送云聚合父任务汇总通知",
    父任务ID: parentJob.id,
    媒体库ID: parentJob.libraryId,
    最终状态: parentJob.status,
    新增影视内容数量: createdMediaCounts.videoContentCount,
    通知展示影视数量: createdMediaCounts.videoContents.length,
  });
}

/** 读取媒体库配置条件更新使用的期望修订号。 */
function readExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw validationError("expectedRevision", "期望配置修订号必须是正整数");
  }
  return revision;
}

/** 在线内容由源插件同步目录，不能进入网盘路径、刮削和文件规格任务。 */
export function requireDriveLibrary(libraryKind: string): void {
  if (libraryKind === "content_source_video" || libraryKind === "content_source_music") {
    throw new ApiError(409, "content_source_requires_catalog_sync", "在线内容库请在内容源设置中同步目录");
  }
}

/** 为本次唯一来源写入稳定来源 ID，供后续多来源目录隔离直接复用。 */
export function attachLibrarySourceId(
  profile: Record<string, unknown>,
  librarySourceId: string,
): Record<string, unknown> {
  const attachRoots = (value: unknown): unknown => Array.isArray(value)
    ? value.map((root) => root && typeof root === "object" && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>), librarySourceId }
      : root)
    : value;
  return {
    ...profile,
    fullRoots: attachRoots(profile.fullRoots),
    incrementalRoots: attachRoots(profile.incrementalRoots),
  };
}

/** 注册媒体库本体、配置、扫描和删除接口。 */
export async function registerLibraryRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/libraries", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const rawDataType = typeof request.query.dataType === "string" ? request.query.dataType : "";
    const dataType = rawDataType ? validateServiceDataType(rawDataType) : undefined;
    const rawStatus = typeof request.query.status === "string" ? request.query.status : "";
    if (rawStatus && rawStatus !== "active" && rawStatus !== "disabled") {
      throw validationError("status", "媒体库状态只支持 active 或 disabled");
    }
    return runtime.repository.listLibraries({
      userId: user.id,
      dataType,
      status: rawStatus ? rawStatus as "active" | "disabled" : undefined,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...readPagination(request.query),
    });
  });

  /** 管理员按用户、类型和状态读取全部媒体库。 */
  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/libraries", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const rawDataType = typeof request.query.dataType === "string" ? request.query.dataType : "";
    const rawStatus = typeof request.query.status === "string" ? request.query.status : "";
    if (rawStatus && rawStatus !== "active" && rawStatus !== "disabled") {
      throw validationError("status", "媒体库状态只支持 active 或 disabled");
    }
    return runtime.repository.listLibraries({
      userId: typeof request.query.userId === "string" ? request.query.userId : undefined,
      dataType: rawDataType ? validateServiceDataType(rawDataType) : undefined,
      status: rawStatus ? rawStatus as "active" | "disabled" : undefined,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...readPagination(request.query),
    });
  });

  /** 从网盘服务创建媒体库；同一服务可同时作为单媒体库来源和云聚合来源。 */
  server.post<{ Body: Record<string, unknown> }>("/api/v1/libraries", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const displayName = requireString(request.body, "displayName", "媒体库名称", 100);
    if (request.body.libraryKind === "cloud_aggregate_video") {
      const rawSourceServiceIds = request.body.sourceServiceIds;
      if (rawSourceServiceIds !== undefined && !Array.isArray(rawSourceServiceIds)) {
        throw validationError("sourceServiceIds", "初始网盘来源必须是数组");
      }
      const sourceServiceIds = [...new Set((rawSourceServiceIds ?? []).map((value) => {
        if (typeof value !== "string" || !value.trim() || value.length > 200) {
          throw validationError("sourceServiceIds", "初始网盘来源 ID 格式无效");
        }
        return value.trim();
      }))];
      const metadataProfile = request.body.metadata === undefined
        ? createCloudAggregateMetadataProfile()
        : validateMetadataProfile(requireObject(request.body, "metadata", "元数据配置"), "video");
      await runtime.aiModels.validateMetadataProfile(metadataProfile);
      const created = await runtime.repository.createCloudAggregateVideoLibrary({
        libraryId: randomUUID(),
        userId: user.id,
        displayName,
        scanProfile: createCloudAggregateScanProfile(),
        metadataProfile,
      });
      // 关键变量：初始来源只建立服务引用；任一引用失败都回滚本次创建，避免留下半成品媒体库。
      const sourceResults: Array<{
        serviceId: string;
        source: LibrarySourceRecord | null;
        copied: boolean;
        errorCode: string | null;
      }> = [];
      for (const serviceId of sourceServiceIds) {
        try {
          const source = await runtime.repository.copyServiceToLibrarySource({
            sourceId: randomUUID(), libraryId: created.library.id, userId: user.id, serviceId,
          });
          sourceResults.push({ serviceId, source, copied: true, errorCode: null });
        } catch (error) {
          const apiError = error instanceof ApiError ? error : null;
          const errorMessage = error instanceof Error ? error.message : "未知错误";
          sourceResults.push({ serviceId, source: null, copied: false, errorCode: apiError?.code ?? "source_copy_failed" });
          runtime.logBusinessEvent("warn", {
            日志关键字: "codex-library-source-config",
            事件: "创建云聚合库时添加来源失败",
            用户ID: user.id,
            媒体库ID: created.library.id,
            原服务ID: serviceId,
            错误码: apiError?.code ?? "source_copy_failed",
            错误信息: errorMessage,
          });
        }
      }
      const failedSourceCount = sourceResults.filter((item) => !item.copied).length; // 关键变量：任一初始来源失败都不能向用户报告创建成功。
      if (failedSourceCount > 0) {
        try {
          await runtime.repository.deleteLibrary(created.library.id, user.id);
        } catch (error) {
          runtime.logBusinessEvent("warn", {
            日志关键字: "codex-library-source-config",
            事件: "初始来源失败后回滚媒体库失败",
            用户ID: user.id,
            媒体库ID: created.library.id,
            错误信息: error instanceof Error ? error.message : "未知错误",
          });
          throw new ApiError(500, "initial_library_source_rollback_failed", "网盘来源添加失败，媒体库清理未完成，请查看后台日志");
        }
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-library-source-config",
          事件: "初始来源失败后已回滚媒体库",
          用户ID: user.id,
          媒体库ID: created.library.id,
          失败来源数量: failedSourceCount,
        });
        throw new ApiError(500, "initial_library_source_copy_failed", "网盘来源添加失败，媒体库未创建，请重试");
      }
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-source-config",
        事件: "创建云聚合视频库并复制初始来源",
        用户ID: user.id,
        媒体库ID: created.library.id,
        初始来源数量: sourceServiceIds.length,
        复制成功数量: sourceResults.filter((item) => item.copied).length,
      });
      return reply.status(201).send({
        ...created,
        library: await runtime.repository.getLibrary(created.library.id, user.id),
        sourceResults,
      });
    }
    const sourceServiceId = requireString(request.body, "sourceServiceId", "来源服务 ID", 200);
    const dataType = validateServiceDataType(request.body.dataType);
    const service = await runtime.repository.getServiceDetail(sourceServiceId, user.id);
    if (!service.canCreateLibrary) {
      throw new ApiError(409, "service_library_conflict", "该网盘服务已经关联媒体库");
    }
    const adapter = runtime.providers.get(service.providerType);
    validateProviderDataType(adapter, dataType);
    const sourceId = randomUUID();
    const scanProfile = attachLibrarySourceId(validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      service.providerType,
      dataType,
      adapter.descriptor.recommendedScanSettings,
    ), sourceId);
    const metadataProfile = validateMetadataProfile(
      requireObject(request.body, "metadata", "元数据配置"),
      dataType,
    );
    await runtime.aiModels.validateMetadataProfile(metadataProfile);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, user.id),
    );
    await validateConfiguredScanRoots(adapter, connection, scanProfile, {
      persistConnection: async (nextConnection) => {
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: service.id,
          userId: user.id,
          credentialRevision: service.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
      },
    });
    const created = await runtime.repository.createLibrary({
      libraryId: randomUUID(),
      sourceId,
      serviceId: service.id,
      userId: user.id,
      displayName,
      dataType,
      scanProfile,
      metadataProfile,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-create",
      事件: "从网盘服务创建媒体库",
      用户ID: user.id,
      服务ID: service.id,
      媒体库ID: created.library.id,
      来源ID: sourceId,
      媒体类型: dataType,
    });
    return reply.status(201).send(created);
  });

  server.get<{ Params: { libraryId: string } }>("/api/v1/libraries/:libraryId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const [library, profiles] = await Promise.all([
      runtime.repository.getLibrary(request.params.libraryId, user.id),
      runtime.repository.getLibraryProfiles(request.params.libraryId, user.id),
    ]);
    const recentJobs = await runtime.repository.listJobs({
      userId: user.id,
      libraryId: library.id,
      limit: 10,
      offset: 0,
    });
    // 旧 APP 仍读取 libraryId、serviceId 和 recentJobs，新增媒体库配置保持同一详情接口。
    return {
      library: {
        ...library,
        libraryId: library.id,
        serviceId: library.sourceServiceId,
        recentJobs: recentJobs.items,
      },
      ...profiles,
    };
  });

  server.get<{ Params: { libraryId: string } }>("/api/v1/admin/libraries/:libraryId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    const profiles = await runtime.repository.getLibraryProfiles(library.id, library.userId);
    return { library, ...profiles };
  });

  /** 云聚合来源成员属于当前媒体库；路径和本地启停独立，连接状态与凭据由网盘服务统一管理。 */
  server.get<{ Params: { libraryId: string } }>("/api/v1/libraries/:libraryId/sources", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    return { items: library.sources };
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/sources", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    if (library.libraryKind !== "cloud_aggregate_video") {
      throw new ApiError(409, "library_source_copy_not_supported", "只有云聚合视频库可以添加网盘来源");
    }
    const serviceId = requireString(request.body, "sourceServiceId", "来源服务 ID", 200);
    const displayName = request.body.displayName === undefined
      ? undefined
      : requireString(request.body, "displayName", "来源名称", 100);
    let source: LibrarySourceRecord;
    try {
      source = await runtime.repository.copyServiceToLibrarySource({
        sourceId: randomUUID(), libraryId: library.id, userId: user.id, serviceId, displayName,
      });
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-library-source-config",
        事件: "添加云聚合库来源失败",
        用户ID: user.id,
        媒体库ID: library.id,
        原服务ID: serviceId,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "library_source_copy_failed", "网盘来源添加失败，请查看后台日志");
    }
    return reply.status(201).send({ source });
  });

  server.patch<{ Params: { libraryId: string; sourceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/sources/:sourceId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const source = await runtime.repository.getLibrarySource(request.params.sourceId, user.id);
      if (source.libraryId !== request.params.libraryId) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
      const patch: { displayName?: string; status?: "active" | "disabled"; sortOrder?: number } = {};
      if (request.body.displayName !== undefined) patch.displayName = requireString(request.body, "displayName", "来源名称", 100);
      if (request.body.status !== undefined) {
        if (request.body.status !== "active" && request.body.status !== "disabled") {
          throw validationError("status", "来源状态只支持 active 或 disabled");
        }
        patch.status = request.body.status;
      }
      if (request.body.sortOrder !== undefined) {
        const sortOrder = Number(request.body.sortOrder);
        if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
          throw validationError("sortOrder", "来源顺序必须是 0 到 10000 的整数");
        }
        patch.sortOrder = sortOrder;
      }
      if (Object.keys(patch).length === 0) throw validationError("source", "没有可更新的来源字段");
      return { source: await runtime.repository.updateLibrarySource({ librarySourceId: source.id, userId: user.id, ...patch }) };
    },
  );

  server.put<{ Params: { libraryId: string; sourceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/sources/:sourceId/scan-profile",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const source = await runtime.repository.getLibrarySource(request.params.sourceId, user.id);
      if (source.libraryId !== request.params.libraryId) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
      if (source.status !== "active" || source.connectionStatus !== "valid" || !source.credentialConfigured
        || (source.serviceStatus !== null && source.serviceStatus !== "active")) {
        throw new ApiError(409, "library_source_not_ready", "当前网盘来源状态异常，不能配置扫描路径");
      }
      const adapter = runtime.providers.get(source.providerType);
      const scanProfile = attachLibrarySourceId(validateScanProfile(
        requireObject(request.body, "scan", "扫描配置"),
        source.providerType,
        "video",
        adapter.descriptor.recommendedScanSettings,
      ), source.id);
      const runtimeConfiguration = await runtime.repository.getLibrarySourceRuntimeConfiguration(source.id, user.id);
      const connection = runtime.vault.decrypt(runtimeConfiguration.encryptedConnection);
      await validateConfiguredScanRoots(adapter, connection, scanProfile, {
        persistConnection: async (nextConnection) => runtime.repository.refreshLibrarySourceEncryptedConnection({
          librarySourceId: source.id,
          userId: user.id,
          credentialRevision: runtimeConfiguration.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        }),
      });
      return {
        source: await runtime.repository.updateLibrarySource({
          librarySourceId: source.id,
          userId: user.id,
          configuration: { ...source.configuration, scan: scanProfile },
        }),
      };
    },
  );

  server.get<{ Params: { libraryId: string; sourceId: string }; Querystring: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/sources/:sourceId/directories",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const source = await runtime.repository.getLibrarySource(request.params.sourceId, user.id);
      if (source.libraryId !== request.params.libraryId) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
      // 关键变量：路径选择只允许读取启用、凭据完整且连接正常的网盘服务。
      if (source.status !== "active" || source.connectionStatus !== "valid" || !source.credentialConfigured
        || (source.serviceStatus !== null && source.serviceStatus !== "active")) {
        throw new ApiError(409, "library_source_not_ready", "当前网盘来源状态异常，不能选择扫描路径");
      }
      const runtimeConfiguration = await runtime.repository.getLibrarySourceRuntimeConfiguration(source.id, user.id);
      const listing = await runtime.providers.get(source.providerType).browseDirectories(
        runtime.vault.decrypt(runtimeConfiguration.encryptedConnection),
        readProviderDirectoryParent(request.query),
        undefined,
        {
          persistConnection: async (nextConnection) => runtime.repository.refreshLibrarySourceEncryptedConnection({
            librarySourceId: source.id, userId: user.id,
            credentialRevision: runtimeConfiguration.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          }),
        },
      );
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-source-config",
        事件: "浏览云聚合来源目录",
        用户ID: user.id,
        媒体库ID: source.libraryId,
        媒体库源ID: source.id,
        子目录数量: listing.items.length,
      });
      return listing;
    },
  );

  server.put<{ Params: { libraryId: string; sourceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/sources/:sourceId/connection",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const source = await runtime.repository.getLibrarySource(request.params.sourceId, user.id);
      if (source.libraryId !== request.params.libraryId) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
      if (source.sourceMode !== "owned_copy") throw new ApiError(409, "linked_source_connection_managed_by_service", "来源连接由网盘服务统一管理，请到网盘服务连接管理中修改");
      const resolved = resolveProviderConnection(runtime, user.id, user.id, source.providerType, requireObject(request.body, "connection", "连接配置"));
      const adapter = runtime.providers.get(source.providerType);
      const configuredScan = source.configuration.scan && typeof source.configuration.scan === "object" && !Array.isArray(source.configuration.scan)
        ? source.configuration.scan as Record<string, unknown>
        : { fullRoots: [], incrementalRoots: [] };
      await validateProviderAccess(adapter, resolved.connection, configuredScan);
      const updated = await runtime.repository.updateLibrarySourceConnection({
        librarySourceId: source.id,
        userId: user.id,
        encryptedConnection: runtime.vault.encrypt(resolved.connection),
        providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
        expectedRevision: readExpectedRevision(request.body.expectedRevision),
      });
      consumeProviderAuthorization(runtime, user.id, resolved.authorizationSessionId);
      return { source: updated };
    },
  );

  server.delete<{ Params: { libraryId: string; sourceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/sources/:sourceId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const source = await runtime.repository.getLibrarySource(request.params.sourceId, user.id);
      if (source.libraryId !== request.params.libraryId) throw new ApiError(404, "library_source_not_found", "媒体库来源不存在");
      requireConfirmation(request.body, source.id);
      return runtime.repository.deleteLibrarySource(source.id, user.id);
    },
  );

  server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const patch: { displayName?: string; dataType?: MediaType; status?: "active" | "disabled"; notificationEnabled?: boolean } = {};
    if (request.body.displayName !== undefined) {
      patch.displayName = requireString(request.body, "displayName", "媒体库名称", 100);
    }
    if (request.body.dataType !== undefined) patch.dataType = validateServiceDataType(request.body.dataType);
    if (request.body.status !== undefined) {
      if (request.body.status !== "active" && request.body.status !== "disabled") {
        throw validationError("status", "媒体库状态只支持 active 或 disabled");
      }
      patch.status = request.body.status;
    }
    if (request.body.notificationEnabled !== undefined) {
      if (typeof request.body.notificationEnabled !== "boolean") {
        throw validationError("notificationEnabled", "通知开关必须是布尔值");
      }
      patch.notificationEnabled = request.body.notificationEnabled;
    }
    if (Object.keys(patch).length === 0) throw validationError("library", "没有可更新的媒体库字段");
    // 关键变量：先沿用仓储的同步任务与停用校验，成功提交 disabled 后再停止在线视频请求。
    const library = await runtime.repository.updateLibrary(request.params.libraryId, user.id, patch);
    if (patch.status === "disabled" && library.libraryKind === "content_source_video") {
      // 关键变量：按库所属用户和绑定版本判断视频源，停用插件也能完成详情及目录清理。
      const binding = await runtime.database.query("content_source_libraries as b")
        .join("content_source_instances as i", "i.id", "b.instance_id")
        .join("content_source_plugins as p", /** 只读取实例绑定的固定插件版本。 */ function joinLibraryPluginVersion() {
          this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version");
        })
        .select("p.manifest_json")
        .where({ "b.library_id": library.id, "b.user_id": user.id, "i.user_id": user.id }).first();
      const adapterType = parseJsonObject(binding?.manifest_json).adapter;
      if (adapterType === "python_spider" || adapterType === "cms_json") {
        // 关键变量：取消 CMS／Python 详情及动态请求、失效窗口，并按需释放 Python 宿主。
        await runtime.contentSources.withLibraryCatalogChange(library.id, async () => undefined);
      }
    }
    return { library };
  });

  /** 管理员仅修改独立在线库名称，沿用所属用户的媒体库更新入口和管理审计。 */
  server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/name", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const displayName = requireString(request.body, "displayName", "媒体库名称", 100);
    if (Object.keys(request.body).some((field) => field !== "displayName")) {
      throw validationError("library", "此接口只支持修改媒体库名称");
    }
    // 关键变量：管理员读取库的真实归属，再按所属用户调用更新，不扩展其他编辑权限。
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    if (library.libraryKind !== "content_source_video" && library.libraryKind !== "content_source_music") {
      throw new ApiError(409, "content_library_name_only", "此接口仅支持修改在线媒体库名称");
    }
    const updated = await runtime.repository.updateLibrary(library.id, library.userId, { displayName });
    await runtime.database.addAudit({
      id: randomUUID(),
      operatorUserId: operator.id,
      operatorUsername: operator.username,
      operationType: "update_library_name",
      targetType: "library",
      targetId: library.id,
      result: "success",
      detail: { 原媒体库名称: library.displayName, 媒体库名称: updated.displayName, 目标用户ID: library.userId },
    });
    return { library: updated };
  });

  server.put<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/scan-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    requireDriveLibrary(library.libraryKind);
    if (library.libraryKind === "cloud_aggregate_video") {
      throw new ApiError(409, "aggregate_scan_profile_is_source_scoped", "云聚合扫描路径需要在各来源中分别配置");
    }
    const profile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      library.providerType,
      library.dataType,
      runtime.providers.get(library.providerType).descriptor.recommendedScanSettings,
      request.body.updateScope === "paths",
    );
    // 关键变量：配置修订时沿用创建阶段写入的来源 ID，避免路径重新保存后丢失来源归属。
    const nextProfile = attachLibrarySourceId(profile, library.sourceId);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(library.sourceServiceId, user.id),
    );
    await validateConfiguredScanRoots(runtime.providers.get(library.providerType), connection, nextProfile, {
      persistConnection: async (nextConnection) => runtime.repository.refreshActiveEncryptedConnection({
        serviceId: library.sourceServiceId,
        userId: user.id,
        credentialRevision: (await runtime.repository.getServiceDetail(library.sourceServiceId, user.id)).credentialRevision,
        encryptedConnection: runtime.vault.encrypt(nextConnection),
      }),
    });
    const updated = await runtime.repository.updateScanProfile(
      library.id,
      user.id,
      nextProfile,
      readExpectedRevision(request.body.expectedRevision),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-scan-profile",
      事件: "更新媒体库扫描配置",
      用户ID: user.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      原配置修订: library.scanProfileRevision,
      当前配置修订: updated.scanProfileRevision,
      全量路径数: getScanRootsForMode(nextProfile, "full").length,
      增量路径数: getScanRootsForMode(nextProfile, "incremental").length,
    });
    return { library: updated };
  });

  server.put<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/metadata-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    requireDriveLibrary(library.libraryKind);
    const profile = validateMetadataProfile(requireObject(request.body, "metadata", "元数据配置"), library.dataType);
    await runtime.aiModels.validateMetadataProfile(profile);
    const updated = await runtime.repository.updateMetadataProfile(
      library.id,
      user.id,
      profile,
      readExpectedRevision(request.body.expectedRevision),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-metadata-profile",
      事件: library.dataType === "music" ? "更新音乐媒体库元数据配置" : "更新影视媒体库元数据配置",
      用户ID: user.id,
      媒体库ID: library.id,
      ...(library.dataType === "music" ? readMusicMetadataLogFields(profile) : readVideoMetadataLogFields(profile)),
    });
    return { library: updated };
  });

  server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/notification-settings", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    if (typeof request.body.notificationEnabled !== "boolean") {
      throw validationError("notificationEnabled", "任务完成通知开关必须是布尔值");
    }
    return {
      library: await runtime.repository.updateServiceNotificationEnabled(
        request.params.libraryId,
        user.id,
        request.body.notificationEnabled,
      ),
    };
  });

  /** 手动为已有视频目录创建规格分析任务。 */
  server.post<{ Params: { libraryId: string } }>("/api/v1/libraries/:libraryId/media-probes/backfill", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    requireDriveLibrary(library.libraryKind);
    if (library.dataType !== "video") throw new ApiError(409, "media_probe_video_only", "只有影视媒体库可以分析视频规格");
    if (library.libraryKind === "cloud_aggregate_video") {
      const result = await runtime.repository.enqueueExistingLibraryMediaProbes(library.id, user.id, user.id);
      const jobs = await Promise.all(result.jobIds.map((jobId) => runtime.repository.getJob(jobId, user.id)));
      return reply.status(result.jobIds.length > 0 ? 202 : 200).send({ jobs, queuedCount: result.queuedCount });
    }
    const result = await runtime.repository.enqueueExistingServiceMediaProbes(library.sourceServiceId, user.id, user.id);
    const job = result.jobId ? await runtime.repository.getJob(result.jobId, user.id) : null;
    return reply.status(result.jobId ? 202 : 200).send({ job, queuedCount: result.queuedCount });
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/scan-jobs", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const scanMode = request.body.scanMode;
    if (scanMode !== "incremental" && scanMode !== "full") {
      throw validationError("scanMode", "扫描模式只支持 incremental 或 full");
    }
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    if (library.status !== "active") throw new ApiError(409, "library_not_active", "请先启用媒体库");
    requireDriveLibrary(library.libraryKind);
    if (await runtime.repository.findUnfinishedLibraryScanJob(library.id, user.id)) {
      throw new ApiError(409, "scan_job_conflict", "当前媒体库已有未结束任务，不能重复启动");
    }
    const profiles = await runtime.repository.getLibraryProfiles(library.id, user.id);
    const requestId = requireString(request.body, "requestId", "请求 ID", 200);
    const clientDeviceId = requireString(request.body, "clientDeviceId", "客户端设备 ID", 200);
    if (library.libraryKind === "cloud_aggregate_video") {
      const readySources = library.sources.filter((source) => source.status === "active"
        && source.connectionStatus === "valid"
        && source.credentialConfigured
        && (source.serviceStatus === null || source.serviceStatus === "active"));
      if (readySources.length === 0) {
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-library-scan-trigger",
          事件: "云聚合扫描没有可用来源",
          用户ID: user.id,
          媒体库ID: library.id,
          扫描模式: scanMode,
          来源总数: library.sources.length,
        });
        throw new ApiError(409, "library_sources_not_ready", "请先添加并授权至少一个可用来源");
      }
      // 关键变量：没有配置当前模式路径的来源不创建子任务，也不再隐式扫描网盘根目录。
      const scanSources = readySources.filter((source) => {
        const scan = source.configuration.scan;
        return Boolean(scan && typeof scan === "object" && !Array.isArray(scan)
          && getScanRootsForMode(scan as Record<string, unknown>, scanMode).length > 0);
      });
      if (scanSources.length === 0) {
        throw new ApiError(409, "scan_paths_not_configured", `请先为至少一个可用来源配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
      }
      let aggregateJob: LibraryScanJobRecord;
      let creationStage = "冻结任务配置";
      try {
        // 关键变量：同一父任务的所有来源共享创建时快照，且快照失败发生在父任务落库之前。
        const aiModelSnapshot = await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile);
        const pluginSnapshots = await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile);
        creationStage = "创建扫描父任务";
        const parent = await runtime.repository.createLibraryScanJob({
          id: randomUUID(), userId: user.id, libraryId: library.id, requestedByUserId: user.id,
          requestId, clientDeviceId, scanMode, sourceCount: scanSources.length,
        });
        if (parent.sourceJobs.length === 0) {
          for (const source of scanSources) {
            creationStage = `创建来源子任务：${source.displayName}`;
            await runtime.repository.createScanJob({
              jobId: randomUUID(),
              userId: user.id,
              libraryId: library.id,
              librarySourceId: source.id,
              parentJobId: parent.id,
              requestedByUserId: user.id,
              requestId: `${requestId.slice(0, 130)}:${source.id}`,
              clientDeviceId,
              scanMode,
              runtimeRevision: "scanner-worker-v1",
              tmdbKeyPoolRevision: runtime.tmdb.revision,
              aiModel: aiModelSnapshot,
              pluginVersions: pluginSnapshots,
            });
          }
        }
        creationStage = "汇总扫描父任务";
        aggregateJob = await runtime.repository.refreshLibraryScanJob(parent.id);
      } catch (error) {
        const errorMessage = toSafeErrorMessage(error, "未知错误");
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-library-scan-trigger",
          事件: "云聚合扫描父子任务创建失败",
          用户ID: user.id,
          媒体库ID: library.id,
          扫描模式: scanMode,
          创建阶段: creationStage,
          错误类型: error instanceof Error ? error.name : "未知错误",
          错误信息: errorMessage,
        });
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, "cloud_aggregate_scan_creation_failed", `云聚合扫描任务创建失败（${creationStage}）：${errorMessage}`);
      }
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-scan-parent",
        事件: "创建云聚合媒体库扫描父任务",
        用户ID: user.id,
        媒体库ID: library.id,
        父任务ID: aggregateJob.id,
        来源子任务数量: aggregateJob.sourceJobs.length,
      });
      return reply.status(202).send({ job: aggregateJob });
    }
    if (getScanRootsForMode(profiles.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: user.id,
      libraryId: library.id,
      librarySourceId: library.sourceId,
      requestedByUserId: user.id,
      requestId,
      clientDeviceId,
      scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      aiModel: await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile),
      pluginVersions: await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-scan-job",
      事件: "创建媒体库扫描任务",
      用户ID: user.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      任务ID: job.id,
    });
    return reply.status(202).send({ job });
  });

  server.get<{ Params: { libraryId: string; jobId: string } }>(
    "/api/v1/libraries/:libraryId/library-scan-jobs/:jobId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const existingJob = await runtime.repository.getLibraryScanJob(request.params.jobId, user.id);
      if (existingJob.libraryId !== request.params.libraryId) {
        throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      }
      return { job: await runtime.repository.refreshLibraryScanJob(existingJob.id) };
    },
  );

  server.post<{ Params: { libraryId: string; jobId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/library-scan-jobs/:jobId/control",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const action = request.body.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw validationError("action", "控制动作只支持 pause、resume 或 cancel");
      }
      const job = await runtime.repository.getLibraryScanJob(request.params.jobId, user.id);
      if (job.libraryId !== request.params.libraryId) throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      const updatedJob = await runtime.repository.requestLibraryScanJobControl(job.id, user.id, action);
      if (action !== "resume") {
        for (const child of job.sourceJobs.filter((sourceJob) => sourceJob.status === "running")) {
          runtime.worker.interruptJobControl(child.id, action);
        }
      }
      await notifyFinishedLibraryScanJob(runtime, updatedJob.id, user.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-scan-parent",
        事件: "用户控制云聚合扫描父任务",
        用户ID: user.id,
        媒体库ID: job.libraryId,
        父任务ID: job.id,
        控制动作: action,
        来源子任务数量: job.sourceJobs.length,
      });
      return { job: updatedJob };
    },
  );

  server.delete<{ Params: { libraryId: string; jobId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/library-scan-jobs/:jobId",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      requireConfirmation(request.body, request.params.jobId);
      const job = await runtime.repository.getLibraryScanJob(request.params.jobId, user.id);
      if (job.libraryId !== request.params.libraryId) throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      await runtime.repository.deleteLibraryScanJob(job.id, user.id);
      for (const child of job.sourceJobs) await runtime.failureReports.remove(child);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-scan-parent",
        事件: "用户删除云聚合扫描父任务",
        用户ID: user.id,
        媒体库ID: job.libraryId,
        父任务ID: job.id,
        来源子任务数量: job.sourceJobs.length,
      });
      return reply.status(204).send();
    },
  );

  server.delete<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/catalog", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.libraryId);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    // 关键变量：在线库清空前暂停动态入库并清理窗口，避免旧分页缓存或正在写入的内容回填。
    const cleared = library.libraryKind === "content_source_video"
      ? await runtime.contentSources.withLibraryCatalogChange(library.id, () => runtime.repository.clearLibraryCatalog(library.id, user.id))
      : library.libraryKind === "content_source_music"
        ? await runtime.contentMusic.withLibraryCatalogChange(library.id, () => runtime.repository.clearLibraryCatalog(library.id, user.id))
      : await runtime.repository.clearLibraryCatalog(library.id, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-catalog-clear",
      事件: "清空媒体库目录",
      用户ID: user.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      清空媒体条目数: cleared.mediaItemCount,
      清空源文件数: cleared.sourceFileCount,
    });
    return cleared;
  });

  server.delete<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/catalog", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.libraryId);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    // 管理员清空在线库也等待该库动态写入收尾，再沿用原目录清空流程。
    const cleared = library.libraryKind === "content_source_video"
      ? await runtime.contentSources.withLibraryCatalogChange(library.id, () => runtime.repository.clearLibraryCatalog(library.id, library.userId))
      : library.libraryKind === "content_source_music"
        ? await runtime.contentMusic.withLibraryCatalogChange(library.id, () => runtime.repository.clearLibraryCatalog(library.id, library.userId))
      : await runtime.repository.clearLibraryCatalog(library.id, library.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-catalog-clear",
      事件: "管理员清空媒体库目录",
      管理员ID: operator.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      清空媒体条目数: cleared.mediaItemCount,
      清空源文件数: cleared.sourceFileCount,
    });
    return cleared;
  });

  server.delete<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.libraryId);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    // 删除在线库前暂停新分页并等待已有动态请求，避免删除后继续使用旧库写入。
    if (library.libraryKind === "content_source_video") {
      await runtime.contentSources.withLibraryCatalogChange(library.id, () => runtime.repository.deleteLibrary(library.id, user.id));
    } else if (library.libraryKind === "content_source_music") {
      await runtime.contentMusic.withLibraryCatalogChange(library.id, () => runtime.repository.deleteLibrary(library.id, user.id));
    } else {
      await runtime.repository.deleteLibrary(library.id, user.id);
    }
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-delete",
      事件: "删除媒体库并保留来源服务",
      用户ID: user.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
    });
    return reply.status(204).send();
  });

  server.delete<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.libraryId);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    // 管理员删除在线库与个人入口使用相同的动态浏览生命周期。
    if (library.libraryKind === "content_source_video") {
      await runtime.contentSources.withLibraryCatalogChange(library.id, () => runtime.repository.deleteLibrary(library.id));
    } else if (library.libraryKind === "content_source_music") {
      await runtime.contentMusic.withLibraryCatalogChange(library.id, () => runtime.repository.deleteLibrary(library.id));
    } else {
      await runtime.repository.deleteLibrary(library.id);
    }
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-library-delete",
      事件: "管理员删除媒体库并保留来源服务",
      管理员ID: operator.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
    });
    return reply.status(204).send();
  });
}
