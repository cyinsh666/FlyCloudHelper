import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MediaType } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
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
  getScanRootsForMode,
  readMusicMetadataLogFields,
  readVideoMetadataLogFields,
  validateConfiguredScanRoots,
  validateMetadataProfile,
  validateProviderDataType,
  validateScanProfile,
  validateServiceDataType,
} from "./service-routes.js";

/** 读取媒体库配置条件更新使用的期望修订号。 */
function readExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw validationError("expectedRevision", "期望配置修订号必须是正整数");
  }
  return revision;
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

  /** 从一个尚未使用的网盘服务创建媒体库；接口保留独立来源实体。 */
  server.post<{ Body: Record<string, unknown> }>("/api/v1/libraries", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const sourceServiceId = requireString(request.body, "sourceServiceId", "来源服务 ID", 200);
    const displayName = requireString(request.body, "displayName", "媒体库名称", 100);
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
      serviceId: library.sourceServiceId,
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
    return { library: await runtime.repository.updateLibrary(request.params.libraryId, user.id, patch) };
  });

  server.put<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/scan-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
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
    if (library.dataType !== "video") throw new ApiError(409, "media_probe_video_only", "只有影视媒体库可以分析视频规格");
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
    if (await runtime.repository.findUnfinishedLibraryScanJob(library.id, user.id)) {
      throw new ApiError(409, "scan_job_conflict", "当前媒体库已有未结束任务，不能重复启动");
    }
    const profiles = await runtime.repository.getLibraryProfiles(library.id, user.id);
    if (getScanRootsForMode(profiles.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: user.id,
      libraryId: library.id,
      requestedByUserId: user.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
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

  server.delete<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/catalog", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.libraryId);
    const library = await runtime.repository.getLibrary(request.params.libraryId, user.id);
    const cleared = await runtime.repository.clearServiceCatalog(library.sourceServiceId, user.id);
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
    const cleared = await runtime.repository.clearServiceCatalog(library.sourceServiceId, library.userId);
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
    await runtime.repository.deleteLibrary(library.id, user.id);
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
    await runtime.repository.deleteLibrary(library.id);
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
