import { createHash, randomUUID } from "node:crypto";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import type { ServiceOrganizeManager } from "../organize/manager.js";
import type { ServiceOrganizeScheduler } from "../organize/schedule.js";
import { getServiceTransferDirectory } from "../resource-search/transfer-directory.js";
import { readShareTransferStatus, submitShareTransfer } from "../resource-search/share-transfer.js";
import { getScanRootsForMode } from "../routes/service-routes.js";
import { TelegramBotStore, type TelegramTransferTask } from "./store.js";

/** 转存后整理和扫描复用现有执行器，机器人只保存阶段及任务引用。 */
export class TelegramTransfers {
  private busy = false;
  /** 当前进程正在提交的任务不能被后台误判为中断任务。 */
  private readonly submitting = new Set<string>();

  public constructor(private readonly runtime: ApiRuntime, private readonly store: TelegramBotStore,
    private readonly manager: ServiceOrganizeManager, private readonly scheduler: ServiceOrganizeScheduler) {}

  /** 列出当前账号可转存的网盘，配置不完整时仍返回明确原因。 */
  public async targets(userId: string, providerType?: string) {
    const page = await this.runtime.repository.listServices({ userId, limit: 10000, offset: 0 });
    return Promise.all(page.items.filter((service) => ["guangya", "quark"].includes(service.providerType)
      && (!providerType || service.providerType === providerType)).map(async (service) => ({
      id: service.id, name: service.displayName, providerType: service.providerType,
      directory: await getServiceTransferDirectory(this.runtime.database, service.id),
      available: service.status === "active" && service.connectionStatus === "valid",
    })));
  }

  /** 开启自动入库前检查转存落点、整理来源和关联媒体库的扫描路径。 */
  public async validateImport(userId: string, serviceId: string): Promise<void> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, userId);
    if (!["guangya", "quark"].includes(service.providerType)) throw new Error("当前仅支持光鸭、夸克自动入库");
    const directory = await getServiceTransferDirectory(this.runtime.database, serviceId);
    const schedule = await this.scheduler.get(serviceId, userId);
    if (!directory || !schedule.target || !schedule.sources.length) {
      throw new Error("请先在网页配置转存目录和整理来源、目标目录");
    }
    if (!schedule.sources.some((source) => this.contains(source.displayPath, directory.displayPath))) {
      throw new Error("转存目录必须位于已配置的整理来源目录内");
    }
    if (!(await this.scanSources(userId, serviceId, schedule.target.displayPath)).length) {
      throw new Error("请先为该网盘关联的视频库配置覆盖整理目标的增量扫描路径");
    }
    if (!(await this.manager.capabilities(serviceId, userId)).supported) throw new Error("当前网盘登录方式不支持整理");
  }

  /** 提交前落库；失败或结果不明时不自动再次调用网盘转存接口。 */
  public async submit(userId: string, serviceId: string, shareUrl: string, password: string, title: string) {
    const preferences = await this.store.preferences(userId);
    const autoImport = preferences.autoImportServiceIds.includes(serviceId);
    if (autoImport) await this.validateImport(userId, serviceId);
    const task: TelegramTransferTask = { id: randomUUID(), userId, serviceId, title: title.slice(0, 200),
      origin: "telegram", remoteTaskId: null, stage: "submitting", autoImport, error: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.store.insertTask(task);
    this.submitting.add(task.id);
    try {
      const result = await submitShareTransfer(this.runtime, { serviceId, shareUrl, password, ownerId: userId, actorUserId: userId });
      task.remoteTaskId = result.taskId;
      task.stage = "transfer";
      await this.save(task);
      return task;
    } catch (error) {
      await this.fail(task, error instanceof Error ? error.message : "转存提交失败，请检查网盘后再手动操作");
      throw error;
    } finally { this.submitting.delete(task.id); }
  }

  /** 网页提交和订阅完成使用稳定任务键，重复通知不会重复整理入库。 */
  public async track(userId: string, serviceId: string, remoteTaskId: string, title: string,
    origin: "web" | "subscription", completed = false): Promise<void> {
    const id = createHash("sha256").update(`${serviceId}:${remoteTaskId}`).digest("hex").slice(0, 32);
    const preferences = await this.store.preferences(userId);
    const autoImport = preferences.autoImportServiceIds.includes(serviceId);
    const previous = await this.store.get<TelegramTransferTask | null>("task:" + id, null);
    if (previous) {
      if (completed && previous.origin === "subscription" && previous.stage === "transfer" && !previous.subscriptionReady) {
        previous.subscriptionReady = true;
        previous.stage = previous.autoImport ? "organize_wait" : "completed";
        await this.save(previous);
      }
      return;
    }
    await this.store.insertTask({ id, userId, serviceId, title: title.slice(0, 200), remoteTaskId,
      origin, autoImport, stage: completed ? autoImport ? "organize_wait" : "completed" : "transfer",
      ...(origin === "subscription" ? { subscriptionReady: completed } : {}),
      error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  /** 订阅网盘明确失败时立即结束已跟踪任务，不等待后续轮询超时。 */
  public async subscriptionFailed(serviceId: string, remoteTaskId: string): Promise<void> {
    const id = createHash("sha256").update(`${serviceId}:${remoteTaskId}`).digest("hex").slice(0, 32);
    const task = await this.store.get<TelegramTransferTask | null>("task:" + id, null);
    if (task?.origin === "subscription" && task.stage === "transfer") await this.fail(task, "订阅转存失败，已放弃本次后续操作");
  }

  /** 逐任务推进；一个任务的异常不会退出本轮其他任务。 */
  public async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const tasks = await this.store.list<TelegramTransferTask>("task:");
      // 关键变量：旧任务先执行，同服务有正在整理或扫描的任务时后续任务继续等待。
      const activeServices = new Set<string>();
      for (const task of tasks.reverse()) {
        if (this.submitting.has(task.id)) continue;
        if (task.stage === "completed" || task.stage === "failed") {
          if (task.notificationPending) await this.notify(task).catch(() => undefined);
          continue;
        }
        try {
          await this.runtime.repository.getServiceDetail(task.serviceId, task.userId);
          const user = await this.runtime.database.findPublicUserById(task.userId);
          if (user.status !== "active") throw new Error("所属用户不可用，本任务已结束");
          if (Date.now() - Date.parse(task.createdAt) > 24 * 60 * 60_000) throw new Error("任务超过 24 小时仍未结束，已放弃后续自动操作，请检查网盘实际状态");
          if (task.stage === "submitting" || task.stage === "organize_starting") {
            throw new Error("服务中断时提交结果未确认，已放弃自动重试，请检查实际任务状态");
          }
          if (task.stage === "transfer" && (task.origin !== "subscription" || task.subscriptionReady)) await this.pollTransfer(task);
          if (task.stage === "organize_wait" && !activeServices.has(task.serviceId)) await this.beginOrganize(task);
          if (task.stage === "organize") await this.pollOrganize(task);
          if (task.stage === "scan") await this.pollScan(task);
          if (["organize_wait", "organize", "scan"].includes(task.stage)) activeServices.add(task.serviceId);
        } catch (error) {
          await this.fail(task, error instanceof Error ? error.message : "任务处理失败");
        }
      }
    } finally { this.busy = false; }
  }

  /** 网盘明确失败即结束，查询异常同样不占用后续整理队列。 */
  private async pollTransfer(task: TelegramTransferTask): Promise<void> {
    if (!task.remoteTaskId) throw new Error("缺少网盘任务编号，请检查实际转存状态");
    const status = await readShareTransferStatus(this.runtime, task.serviceId, task.remoteTaskId, task.userId);
    if (status === "failed") throw new Error("网盘转存失败，已放弃本任务");
    if (status !== "completed") return;
    if (task.autoImport) { task.stage = "organize_wait"; await this.save(task); }
    else await this.complete(task);
  }

  /** 等待已有任务结束，随后通过同一个整理调度器启动已保存配置。 */
  private async beginOrganize(task: TelegramTransferTask): Promise<void> {
    await this.validateImport(task.userId, task.serviceId);
    const schedule = await this.scheduler.get(task.serviceId, task.userId);
    if (schedule.pendingPlanId) return;
    if ((await this.manager.listJobs(task.serviceId, task.userId)).some((job) => ["queued", "running", "paused"].includes(job.status))) return;
    const scanning = await this.runtime.repository.listJobs({ userId: task.userId, serviceId: task.serviceId,
      statuses: ["queued", "running", "paused", "retry_waiting"], limit: 1, offset: 0 });
    if (scanning.total) return;
    task.stage = "organize_starting";
    await this.save(task);
    try {
      const started = await this.scheduler.runNow(task.serviceId, task.userId);
      task.planId = started.pendingPlanId!;
      task.stage = "organize";
      await this.save(task);
    } catch (error) {
      // 关键变量：仅明确未创建的占用冲突可等待，业务失败不重试。
      if (error instanceof ApiError && ["organize_schedule_busy", "organize_schedule_pending", "organize_job_active", "organize_scan_active"].includes(error.code)) {
        task.stage = "organize_wait";
        await this.save(task);
        return;
      }
      throw error;
    }
  }

  /** 只跟踪本任务的预览和整理，不把其他定时任务误当成本次完成。 */
  private async pollOrganize(task: TelegramTransferTask): Promise<void> {
    if (!task.planId) throw new Error("整理预览编号缺失，已结束本次自动入库");
    const plan = await this.manager.getPlan(task.serviceId, task.planId, task.userId);
    if (plan.status === "preparing") return;
    if (plan.status === "failed") throw new Error(plan.error || "整理预览失败");
    const job = (await this.manager.listJobs(task.serviceId, task.userId)).find((item) => item.planId === task.planId);
    if (!job) {
      const schedule = await this.scheduler.get(task.serviceId, task.userId);
      if (schedule.pendingPlanId === task.planId) return;
      throw new Error(schedule.lastError || "整理未成功启动，已结束本次自动入库");
    }
    task.organizeJobId = job.id;
    if (["failed", "cancelled"].includes(job.status)) throw new Error(job.error || "整理失败或已取消");
    if (job.status !== "completed") return;
    if (job.items.some((item) => item.stage === "failed")) throw new Error("整理包含失败项，已放弃本次后续入库");
    task.stage = "scan";
    await this.save(task);
  }

  /** 幂等创建已关联来源的增量扫描；已有扫描任务由现有执行器串行处理。 */
  private async pollScan(task: TelegramTransferTask): Promise<void> {
    if (!task.scanSources) {
      const plan = await this.manager.getPlan(task.serviceId, task.planId!, task.userId);
      const sources = await this.scanSources(task.userId, task.serviceId, plan.targetDirectory.displayPath);
      if (!sources.length) throw new Error("关联媒体库或增量扫描路径已变更，无法自动入库");
      task.scanJobIds = [];
      task.scanSources = sources.map(({ library, source }) => ({ libraryId: library.id, sourceId: source.id }));
      await this.save(task);
    }
    const ids = task.scanJobIds ?? [];
    const jobs = await Promise.all(ids.map((id) => this.runtime.repository.getJob(id, task.userId)));
    if (jobs.some((job) => ["failed", "cancelled"].includes(job.status))) throw new Error("媒体库扫描失败或已取消，已结束本任务");
    const waiting = jobs.find((job) => job.status === "retry_waiting");
    if (waiting) {
      // 关键变量：本链路创建的扫描不自动重试，取消等待恢复以释放网盘任务占用。
      await this.runtime.repository.requestJobControl(waiting.id, task.userId, "cancel");
      throw new Error("媒体库扫描暂时无法继续，已放弃自动重试并结束本任务");
    }
    if (jobs.some((job) => job.status !== "completed")) return;
    if (jobs.some((job) => job.errorCount > 0)) throw new Error("媒体库扫描包含失败项，请查看扫描记录");
    const next = task.scanSources[ids.length];
    if (next) {
      const profiles = await this.runtime.repository.getLibraryProfiles(next.libraryId, task.userId);
      const aiModel = await this.runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile);
      const pluginVersions = await this.runtime.plugins.buildTaskSnapshots(profiles.metadataProfile);
      try {
        const job = await this.runtime.repository.createScanJob({ jobId: randomUUID(), userId: task.userId,
          libraryId: next.libraryId, librarySourceId: next.sourceId, requestedByUserId: task.userId,
          requestId: `telegram:${task.id}:${next.sourceId}`, clientDeviceId: "telegram-bot", scanMode: "incremental",
          runtimeRevision: "scanner-worker-v1", tmdbKeyPoolRevision: this.runtime.tmdb.revision, aiModel, pluginVersions });
        ids.push(job.id);
        task.scanJobIds = ids;
        await this.save(task);
      } catch (error) {
        // 关键变量：其他入口正在扫描或整理时继续等待，不创建重复任务。
        if (error instanceof ApiError && ["scan_job_conflict", "organize_job_active"].includes(error.code)) return;
        throw error;
      }
      return;
    }
    await this.complete(task);
  }

  /** 只选择本用户下、关联同一网盘且覆盖整理目标的有效视频来源。 */
  private async scanSources(userId: string, serviceId: string, targetPath: string) {
    const libraries = await this.runtime.repository.listLibraries({ userId, dataType: "video", status: "active", limit: 10000, offset: 0 });
    return libraries.items.flatMap((library) => library.sources.filter((source) => source.serviceId === serviceId
      && source.sourceMode === "linked_service" && source.status === "active" && source.connectionStatus === "valid"
      && getScanRootsForMode((source.configuration.scan ?? {}) as Record<string, unknown>, "incremental")
        .some((root) => typeof root.displayPath === "string" && this.contains(root.displayPath, targetPath))).map((source) => ({ library, source })));
  }

  /** 使用目录边界判断祖先关系，避免 /电影 与 /电影旧版 误匹配。 */
  private contains(parent: string, child: string): boolean {
    const parentPath = parent.replace(/\\/gu, "/").replace(/\/+$/u, "");
    const childPath = child.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return childPath === parentPath || childPath.startsWith(parentPath + "/");
  }

  /** 成功阶段先持久化，再异步投递个人和原有管理员通知。 */
  private async complete(task: TelegramTransferTask): Promise<void> {
    task.stage = "completed";
    task.notificationPending = true;
    await this.save(task);
    await this.notify(task).catch(() => undefined);
  }

  /** 失败终态不会再次推进整理或扫描，不影响其他任务。 */
  private async fail(task: TelegramTransferTask, error: string): Promise<void> {
    task.stage = "failed";
    task.error = error.slice(0, 500);
    task.notificationPending = true;
    await this.save(task);
    this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-telegram-bot", 事件: "转存入库任务已放弃",
      用户ID: task.userId, 任务ID: task.id, 错误信息: task.error });
    await this.notify(task).catch(() => undefined);
  }

  /** 通知写入失败只重试通知，不会重新执行失败业务。 */
  private async notify(task: TelegramTransferTask): Promise<void> {
    await this.runtime.database.createNotification({ userId: task.userId, category: "task",
      tone: task.stage === "failed" ? "danger" : "success",
      title: task.stage === "failed" ? "转存入库任务失败" : task.autoImport ? "转存整理入库已完成" : "资源转存已完成",
      message: `${task.title}\n任务：${task.id}${task.error ? `\n${task.error}\n本次已放弃，不自动重试。` : ""}`,
      actionPath: "/app/jobs" });
    task.notificationPending = false;
    await this.save(task);
  }

  /** 每次阶段变化都保存，外部完成后绝不回退到提交阶段。 */
  private async save(task: TelegramTransferTask): Promise<void> {
    task.updatedAt = new Date().toISOString();
    await this.store.put("task:" + task.id, task, task.userId);
  }
}
