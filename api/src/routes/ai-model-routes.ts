import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CreateAiModelInput, UpdateAiModelInput } from "../ai/ai-model-manager.js";
import { readAiCleaningSettings } from "../ai/ai-model-manager.js";
import type { AiModelRecord } from "../domain.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 写入 AI 模型管理审计，不保存地址、API Key 或请求响应原文。 */
async function auditAiModel(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  modelId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType: "ai_model",
    targetId: modelId,
    result: "success",
    detail,
  });
}

/** 记录模型配置操作的统一诊断日志，不输出任何 Secret。 */
function logModelConfiguration(
  runtime: ApiRuntime,
  operatorId: string,
  event: string,
  model: AiModelRecord,
): void {
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-ai-clean",
    事件: event,
    管理员ID: operatorId,
    模型ID: model.id,
    模型修订: model.configurationRevision,
    模型状态: model.status,
    Key是否配置: model.apiKeyConfigured,
  });
}

/** 删除前检查当前媒体库配置、未完成扫描任务和影片整理计划是否仍引用模型。 */
async function ensureAiModelUnused(runtime: ApiRuntime, modelId: string): Promise<void> {
  const profiles = await runtime.database.query("library_metadata_profiles as p")
    .join("media_libraries as l", function joinCurrentProfile() {
      this.on("l.id", "=", "p.library_id").andOn("l.metadata_profile_revision", "=", "p.revision");
    })
    .select("p.configuration_json");
  if (profiles.some((profile) => {
    const settings = readAiCleaningSettings(parseJsonObject(profile.configuration_json));
    return settings.enabled && settings.modelId === modelId;
  })) throw new ApiError(409, "ai_model_in_use", "有媒体库正在使用此模型，请先修改媒体库元数据配置");

  const jobs = await runtime.database.query("scan_jobs")
    .whereIn("status", ["queued", "running", "retry_waiting", "paused"])
    .select("snapshot_json");
  if (jobs.some((job) => parseJsonObject(parseJsonObject(job.snapshot_json).aiModel).modelId === modelId)) {
    throw new ApiError(409, "ai_model_in_use", "有未完成的扫描任务正在使用此模型，请等待任务结束");
  }

  // 关键变量：整理计划保存在导出目录的 JSON 文件中，与媒体库配置不在同一张表。
  const scheduleDirectory = path.join(runtime.config.exportDirectory, "service-organize");
  const scheduleFiles = await fs.readdir(scheduleDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const fileName of scheduleFiles) {
    if (!/^schedule-[0-9a-f-]{36}\.json$/iu.test(fileName)) continue;
    const schedule = parseJsonObject(JSON.parse(await fs.readFile(path.join(scheduleDirectory, fileName), "utf8")));
    if (schedule.aiAssistEnabled === true && schedule.aiModelId === modelId) {
      throw new ApiError(409, "ai_model_in_use", "有影片整理计划正在使用此模型，请先修改整理计划");
    }
  }
}

/** 查询单个扫描任务采用 AI 查询词的总数和最近 20 条记录。 */
async function readJobAiSupplements(
  runtime: ApiRuntime,
  jobId: string,
  userId?: string,
): Promise<Record<string, unknown>> {
  const job = await runtime.repository.getJob(jobId, userId);
  const totalRow = await runtime.database.query("ai_video_name_clean_usages")
    .where({ job_id: job.id })
    .count({ total: "id" })
    .first();
  const rows = await runtime.database.query("ai_video_name_clean_usages as u")
    .leftJoin("ai_model_profiles as p", "p.id", "u.model_id")
    .select("u.*", "p.display_name as model_display_name")
    .where("u.job_id", job.id)
    .orderBy("u.created_at", "desc")
    .limit(20);
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-ai-clean",
    事件: "查看任务AI补充详情",
    任务ID: job.id,
    服务ID: job.serviceId,
    用户ID: job.userId,
    AI补充总数: Number(totalRow?.total ?? 0),
    最近记录数量: rows.length,
  });
  return {
    total: Number(totalRow?.total ?? 0),
    items: rows.map((row) => ({
      id: String(row.id),
      mediaType: row.media_type === "tv" ? "tv" : "movie",
      triggerReason: String(row.trigger_reason),
      ruleTitle: String(row.rule_title),
      cleanedTitle: String(row.cleaned_title),
      alternateTitle: String(row.alternate_title ?? ""),
      confidence: Number(row.confidence),
      fileCount: Number(row.file_count),
      modelId: String(row.model_id),
      modelDisplayName: row.model_display_name ? String(row.model_display_name) : "已删除模型",
      modelRevision: Number(row.model_revision),
      createdAt: String(row.created_at),
    })),
  };
}

/** 为媒体库现有未识别内容创建一次不访问 Provider 的 AI 补充后台任务。 */
async function createManualAiSupplementJob(
  runtime: ApiRuntime,
  service: {
    libraryId: string;
    librarySourceId: string;
    userId: string;
    status: string;
    metadataProfile: Record<string, unknown>;
  },
  requestedByUserId: string,
  body: Record<string, unknown>,
) {
  const unfinishedJob = await runtime.repository.findUnfinishedLibraryScanJob(service.libraryId, service.userId);
  if (service.status === "scanning" || unfinishedJob) {
    throw new ApiError(409, "scan_job_conflict", "当前服务正在扫描或已有未结束任务，不能启动 AI 补充");
  }
  const configuredSnapshot = await runtime.aiModels.buildUnmatchedSupplementTaskSnapshot(service.metadataProfile);
  if (!configuredSnapshot) {
    throw new ApiError(409, "ai_cleaning_not_enabled", "请先在服务元数据配置中启用 AI 目录文件清洗");
  }
  // 关键变量：手动任务直接处理数据库未匹配记录，并强制跳过此前成功的 AI 清洗缓存。
  const manualSnapshot = configuredSnapshot;
  const job = await runtime.repository.createScanJob({
    jobId: randomUUID(),
    userId: service.userId,
    libraryId: service.libraryId,
    librarySourceId: service.librarySourceId,
    requestedByUserId,
    requestId: requireString(body, "requestId", "请求 ID", 200),
    clientDeviceId: requireString(body, "clientDeviceId", "客户端设备 ID", 200),
    // 保留数据库现有必填字段；Worker 根据 taskPurpose 进入独立流程，不读取该扫描模式和扫描路径。
    scanMode: "incremental",
    runtimeRevision: "scanner-worker-v1",
    tmdbKeyPoolRevision: runtime.tmdb.revision,
    aiModel: manualSnapshot,
    taskPurpose: "ai_supplement_unmatched",
    pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-ai-clean",
    事件: "手动创建未识别内容AI补充任务",
    操作用户ID: requestedByUserId,
    归属用户ID: service.userId,
    媒体库ID: service.libraryId,
    任务ID: job.id,
    内容来源: "媒体库未匹配记录",
    是否访问Provider: false,
    模型ID: manualSnapshot.modelId,
    模型修订: manualSnapshot.configurationRevision,
    跳过AI缓存: true,
  });
  return job;
}

/** 读取 AI 补充任务上下文；云聚合任务只借用一个可用来源作为任务归属，不访问其 Provider。 */
async function getAiSupplementLibraryContext(runtime: ApiRuntime, libraryId: string, userId?: string) {
  const library = await runtime.repository.getLibrary(libraryId, userId);
  const profiles = await runtime.repository.getLibraryProfiles(library.id, library.userId);
  const source = library.sources.find((item) => item.status === "active"
    && item.connectionStatus === "valid"
    && item.credentialConfigured
    && (item.serviceStatus === null || item.serviceStatus === "active"));
  if (!source) throw new ApiError(409, "library_sources_not_ready", "请先配置至少一个可用来源，再执行 AI 补充");
  return {
    libraryId: library.id,
    librarySourceId: source.id,
    userId: library.userId,
    status: library.status,
    metadataProfile: profiles.metadataProfile,
  };
}

/** 注册超级管理员 AI 模型配置、启停、删除和可用性测试接口。 */
export async function registerAiModelRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  /** 返回服务配置页可选择的模型；已停用但仍被服务选中的模型仅用于回显。 */
  server.get<{ Querystring: { libraryId?: string } }>("/api/v1/ai-models/available", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    let selectedModelId: string | undefined;
    if (request.query.libraryId) {
      const library = await runtime.repository.getLibrary(
        request.query.libraryId,
        user.role === "super_admin" ? undefined : user.id,
      );
      const profiles = await runtime.repository.getLibraryProfiles(library.id, library.userId);
      selectedModelId = readAiCleaningSettings(profiles.metadataProfile).modelId ?? undefined;
    }
    const models = await runtime.aiModels.listAvailableModels(selectedModelId);
    return { items: models, total: models.length };
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/ai-supplements", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return readJobAiSupplements(runtime, request.params.jobId, user.id);
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/ai-supplements", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return readJobAiSupplements(runtime, request.params.jobId);
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(
    "/api/v1/libraries/:libraryId/ai-supplements/retry",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const service = await getAiSupplementLibraryContext(runtime, request.params.libraryId, user.id);
      const job = await createManualAiSupplementJob(runtime, service, user.id, request.body ?? {});
      return reply.status(202).send({ job });
    },
  );

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/libraries/:libraryId/ai-supplements/retry",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const service = await getAiSupplementLibraryContext(runtime, request.params.libraryId);
      const job = await createManualAiSupplementJob(runtime, service, operator.id, request.body ?? {});
      return reply.status(202).send({ job });
    },
  );

  server.get("/api/v1/admin/ai-models", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const models = await runtime.aiModels.listModels();
    return { items: models, total: models.length };
  });

  server.post<{ Body: CreateAiModelInput }>("/api/v1/admin/ai-models", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const model = await runtime.aiModels.createModel(request.body ?? {});
    logModelConfiguration(runtime, operator.id, "创建AI模型配置", model);
    await auditAiModel(runtime, operator, "create_ai_model", model.id, {
      模型修订: model.configurationRevision,
      模型状态: model.status,
      Key是否配置: model.apiKeyConfigured,
    });
    return reply.status(201).send({ model });
  });

  server.put<{ Params: { modelId: string }; Body: UpdateAiModelInput }>(
    "/api/v1/admin/ai-models/:modelId",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const model = await runtime.aiModels.updateModel(request.params.modelId, request.body ?? {});
      logModelConfiguration(runtime, operator.id, "更新AI模型配置", model);
      await auditAiModel(runtime, operator, "update_ai_model", model.id, {
        模型修订: model.configurationRevision,
        模型状态: model.status,
        Key是否配置: model.apiKeyConfigured,
      });
      return { model };
    },
  );

  server.patch<{ Params: { modelId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/ai-models/:modelId/status",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const model = await runtime.aiModels.updateStatus(request.params.modelId, request.body?.status);
      logModelConfiguration(runtime, operator.id, model.status === "enabled" ? "启用AI模型" : "停用AI模型", model);
      await auditAiModel(runtime, operator, `${model.status === "enabled" ? "enable" : "disable"}_ai_model`, model.id, {
        模型状态: model.status,
      });
      return { model };
    },
  );

  server.delete<{ Params: { modelId: string } }>("/api/v1/admin/ai-models/:modelId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const model = await runtime.aiModels.getModel(request.params.modelId);
    await ensureAiModelUnused(runtime, model.id);
    await runtime.aiModels.deleteModel(model.id);
    logModelConfiguration(runtime, operator.id, "删除AI模型配置", model);
    await auditAiModel(runtime, operator, "delete_ai_model", model.id, { 模型名称: model.displayName });
    return reply.status(204).send();
  });

  server.post<{ Params: { modelId: string } }>(
    "/api/v1/admin/ai-models/:modelId/test",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const result = await runtime.aiModels.testAvailability(request.params.modelId);
      runtime.logBusinessEvent(result.available ? "info" : "warn", {
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "测试AI模型可用性",
        管理员ID: operator.id,
        模型ID: request.params.modelId,
        可用状态: result.available,
        结构化输出: result.structuredOutput,
        耗时毫秒: result.latencyMs,
        错误码: result.errorCode,
      });
      await auditAiModel(runtime, operator, "test_ai_model_availability", request.params.modelId, {
        可用状态: result.available,
        结构化输出: result.structuredOutput,
        耗时毫秒: result.latencyMs,
        错误码: result.errorCode,
      });
      return { result, model: await runtime.aiModels.getModel(request.params.modelId) };
    },
  );
}
