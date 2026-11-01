import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import { ServiceOrganizeManager } from "../organize/manager.js";
import { ServiceOrganizeScheduler } from "../organize/schedule.js";
import type { OrganizeDirectory, OrganizeMode } from "../organize/types.js";
import type { OrganizeJob, OrganizePlan } from "../organize/types.js";
import type { ApiRuntime } from "../runtime.js";

/** 预览逐页返回，避免几千个源文件一次塞进浏览器响应。 */
function planPage(plan: OrganizePlan, offset: number) {
  const limit = 100;
  return { ...plan, scannedDirectories: [], directoryCount: plan.scannedDirectories.length,
    items: plan.items.slice(offset, offset + limit), itemCount: plan.items.length,
    readyCount: plan.items.filter((item) => item.status === "ready").length,
    overwriteCount: plan.items.filter((item) => item.status === "ready" && item.willOverwrite).length,
    nextOffset: offset + limit < plan.items.length ? offset + limit : null };
}

/** 列表和轮询只传进度及少量失败项，不重复传完整任务流水。 */
function jobSummary(job: OrganizeJob) {
  return { ...job, items: job.items.filter((item) => item.stage === "failed").slice(0, 50),
    itemCount: job.items.length, completedCount: job.items.filter((item) => item.stage === "completed").length };
}

/** 服务级影片整理入口；普通用户和管理员共享同一归属校验与执行器。 */
export async function registerOrganizeRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const manager = new ServiceOrganizeManager(runtime);
  const scheduler = new ServiceOrganizeScheduler(runtime, manager);
  void manager.resumePending().catch((error) => server.log.error({ err: error }, "恢复影片整理任务失败"))
    .finally(() => scheduler.start());
  server.addHook("onClose", async () => scheduler.stop());
  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/services" : "/api/v1/services";
    /** 当前请求的用户 ID；管理员可操作任意已存在服务。 */
    async function actorId(request: Parameters<typeof requireRequestUser>[0]): Promise<string | undefined> {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      return admin ? undefined : user.id;
    }
    server.get<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/organize/capabilities`, async (request) =>
      manager.capabilities(request.params.serviceId, await actorId(request)));
    server.get<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/organize/ai-models`, async (request) => {
      await runtime.repository.getServiceDetail(request.params.serviceId, await actorId(request));
      return { items: await runtime.aiModels.listAvailableModels() };
    });
    server.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
      `${admin ? "/api/v1/admin" : "/api/v1"}/organize/tasks`, async (request) => {
        const ownerId = await actorId(request);
        const status = request.query.status ?? "all";
        const supportedStatuses = ["all", "active", "preparing", "queued", "running", "paused", "completed", "failed", "cancelled"];
        if (!supportedStatuses.includes(status)) throw validationError("status", "整理任务状态筛选值无效");
        const limit = Number(request.query.limit ?? 8);
        const offset = Number(request.query.offset ?? 0);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
          throw validationError("pagination", "整理任务分页参数无效");
        }
        const all = await manager.listTaskSummaries(ownerId);
        const filtered = all.filter((task) => {
          if (status === "all") return true;
          if (status === "active") return ["preparing", "queued", "running", "paused"].includes(task.status);
          return task.status === status;
        });
        const page = filtered.slice(offset, offset + limit);
        // 关键变量：仅查询当前页的服务名称，避免历史任务增加数据库读取量。
        const serviceNames = new Map<string, string>();
        for (const serviceId of new Set(page.map((task) => task.serviceId))) {
          const service = await runtime.repository.getServiceDetail(serviceId, ownerId).catch((error: unknown) => {
            if (error instanceof ApiError && error.statusCode === 404) return null;
            throw error;
          });
          serviceNames.set(serviceId, service?.displayName ?? "已删除的网盘服务");
        }
        return { items: page.map((task) => ({ ...task,
          serviceName: serviceNames.get(task.serviceId) ?? "网盘服务" })), total: filtered.length };
      });
    server.get<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/organize/schedule`, async (request) =>
      ({ schedule: await scheduler.get(request.params.serviceId, await actorId(request)) }));
    server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(
      `${prefix}/:serviceId/organize/schedule`, async (request) => {
        if (!request.body || typeof request.body !== "object") throw validationError("schedule", "定时计划无效");
        return { schedule: await scheduler.update(request.params.serviceId, await actorId(request), request.body) };
      });
    server.post<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/organize/schedule/run-now`, async (request, reply) =>
      reply.status(202).send({ schedule: await scheduler.runNow(request.params.serviceId, await actorId(request)) }));
    server.post<{ Params: { serviceId: string }; Body: { sources: OrganizeDirectory[]; target: OrganizeDirectory; mode: OrganizeMode;
      unrecognizedTransferEnabled?: boolean; unrecognizedDirectory?: OrganizeDirectory | null;
      aiAssistEnabled?: boolean; aiModelId?: string | null } }>(
      `${prefix}/:serviceId/organize/plans`, async (request, reply) => {
        if (!request.body || typeof request.body !== "object") throw validationError("sources", "请选择有效的整理目录");
        const plan = await manager.createPlan(request.params.serviceId, await actorId(request), request.body);
        return reply.status(202).send({ plan: planPage(plan, 0) });
      });
    server.get<{ Params: { serviceId: string; planId: string }; Querystring: { offset?: string } }>(
      `${prefix}/:serviceId/organize/plans/:planId`, async (request) => {
        const offset = Number(request.query.offset ?? 0);
        if (!Number.isInteger(offset) || offset < 0) throw validationError("offset", "预览分页位置无效");
        return { plan: planPage(await manager.getPlan(request.params.serviceId, request.params.planId, await actorId(request)), offset) };
      });
    server.get<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/organize/jobs`, async (request) =>
      ({ items: (await manager.listJobs(request.params.serviceId, await actorId(request))).slice(0, 30).map(jobSummary) }));
    server.post<{ Params: { serviceId: string }; Body: { planId: string } }>(`${prefix}/:serviceId/organize/jobs`, async (request, reply) => {
      if (!request.body || typeof request.body.planId !== "string") throw validationError("planId", "请选择已完成的预览");
      const job = await manager.createJob(request.params.serviceId, request.body.planId, await actorId(request));
      return reply.status(202).send({ job: jobSummary(job) });
    });
    server.get<{ Params: { serviceId: string; jobId: string } }>(`${prefix}/:serviceId/organize/jobs/:jobId`, async (request) =>
      ({ job: jobSummary(await manager.getJob(request.params.serviceId, request.params.jobId, await actorId(request))) }));
    server.post<{ Params: { serviceId: string; jobId: string }; Body: { action: "pause" | "resume" | "cancel" } }>(
      `${prefix}/:serviceId/organize/jobs/:jobId/control`, async (request) => {
        const action = request.body?.action;
        if (action !== "pause" && action !== "resume" && action !== "cancel") throw validationError("action", "无效的任务操作");
        return { job: jobSummary(await manager.controlJob(request.params.serviceId, request.params.jobId, action, await actorId(request))) };
      });
  }
}
