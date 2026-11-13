import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { calculateNextScanRunAt, postponeQuietCandidate, type ScanScheduleConfiguration } from "../scan-schedule-service.js";
import type { ApiRuntime } from "../runtime.js";
import { ServiceOrganizeManager } from "./manager.js";
import { prepareOrganizeAi } from "./recognition-ai.js";
import type { OrganizeDirectory, OrganizeMode, WashPriority } from "./types.js";
import { readWashOptions } from "./wash.js";

/** 整理计划按服务保存到已有 /data 目录，不占用媒体库定时扫描表。 */
export interface OrganizeSchedule extends ScanScheduleConfiguration {
  serviceId: string;
  userId: string;
  sources: OrganizeDirectory[];
  target: OrganizeDirectory | null;
  mode: OrganizeMode;
  unrecognizedTransferEnabled?: boolean;
  unrecognizedDirectory?: OrganizeDirectory | null;
  aiAssistEnabled?: boolean;
  aiModelId?: string | null;
  washEnabled?: boolean;
  washPriorities?: WashPriority[];
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  lastRunMessage?: string | null;
  /** 同一任务、同一阻塞原因只提醒一次，服务重启后继续去重。 */
  lastBlockedNotificationKey?: string | null;
  pendingPlanId: string | null;
  pendingRunKind?: "scheduled" | "manual";
  updatedAt: string;
}

/** 用原子替换保存计划，避免中途退出写坏配置。 */
async function saveSchedule(fileName: string, schedule: OrganizeSchedule): Promise<void> {
  await fs.mkdir(path.dirname(fileName), { recursive: true, mode: 0o700 });
  const temporary = `${fileName}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(schedule), { mode: 0o600 });
  await fs.rename(temporary, fileName);
}

/** 读取当前服务的计划；未保存时保持关闭并沿用扫描任务默认值。 */
function defaultSchedule(serviceId: string, userId: string): OrganizeSchedule {
  return {
    serviceId, userId, sources: [], target: null, mode: "move", enabled: false,
    unrecognizedTransferEnabled: false, unrecognizedDirectory: null, aiAssistEnabled: false, aiModelId: null,
    washEnabled: false, washPriorities: ["resolution"],
    scheduleType: "interval", intervalMinutes: 24 * 60, timeOfDay: "03:00", dayOfWeek: 1,
    dayOfMonth: 1, timezoneOffsetMinutes: -new Date().getTimezoneOffset(), quietPeriodEnabled: false,
    quietStartTime: "00:00", quietEndTime: "07:00", nextRunAt: null, lastTriggeredAt: null,
    lastJobId: null, lastError: null, lastRunMessage: null, pendingPlanId: null, updatedAt: new Date().toISOString(),
  };
}

/** 校验与媒体库定时扫描相同的执行方式和时间范围。 */
export function readOrganizeScheduleInput(body: Record<string, unknown>): Pick<OrganizeSchedule,
  "enabled" | "scheduleType" | "intervalMinutes" | "timeOfDay" | "dayOfWeek" | "dayOfMonth" |
  "timezoneOffsetMinutes" | "quietPeriodEnabled" | "quietStartTime" | "quietEndTime" | "sources" | "target" | "mode" |
  "unrecognizedTransferEnabled" | "unrecognizedDirectory" | "aiAssistEnabled" | "aiModelId" | "washEnabled" | "washPriorities"> {
  const integer = (name: string, min: number, max: number): number => {
    const value = body[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ApiError(422, "organize_schedule_invalid", `${name} 必须是 ${min} 至 ${max} 的整数`);
    }
    return value;
  };
  const clock = (name: string): string => {
    const value = body[name];
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
      throw new ApiError(422, "organize_schedule_invalid", `${name} 必须使用 HH:mm 格式`);
    }
    return value;
  };
  if (typeof body.enabled !== "boolean") throw new ApiError(422, "organize_schedule_invalid", "请选择是否启用计划");
  if (!["interval", "daily", "weekly", "monthly"].includes(String(body.scheduleType))) {
    throw new ApiError(422, "organize_schedule_invalid", "执行方式无效");
  }
  if (typeof body.quietPeriodEnabled !== "boolean") throw new ApiError(422, "organize_schedule_invalid", "暂停时段状态无效");
  if (body.mode !== "move" && body.mode !== "copy") throw new ApiError(422, "organize_schedule_invalid", "整理方式无效");
  const sources = body.sources;
  const target = body.target;
  if (!Array.isArray(sources) || sources.length > 20 || sources.some((item) => !item ||
    typeof item.resourceId !== "string" || typeof item.displayPath !== "string") ||
    (target !== null && (!target || typeof target !== "object" ||
      typeof (target as OrganizeDirectory).resourceId !== "string" ||
      typeof (target as OrganizeDirectory).displayPath !== "string"))) {
    throw new ApiError(422, "organize_schedule_invalid", "来源或目标目录无效");
  }
  if (body.enabled && (sources.length === 0 || !target)) {
    throw new ApiError(422, "organize_schedule_paths_missing", "请先选择来源目录和目标目录");
  }
  const unrecognizedTransferEnabled = body.unrecognizedTransferEnabled === true;
  const unrecognizedDirectory = body.unrecognizedDirectory;
  if (unrecognizedTransferEnabled && (!unrecognizedDirectory || typeof unrecognizedDirectory !== "object"
    || typeof (unrecognizedDirectory as OrganizeDirectory).resourceId !== "string"
    || typeof (unrecognizedDirectory as OrganizeDirectory).displayPath !== "string")) {
    throw new ApiError(422, "organize_schedule_unrecognized_missing", "请选择未识别内容的转移目录");
  }
  const aiAssistEnabled = body.aiAssistEnabled === true;
  const aiModelId = aiAssistEnabled && typeof body.aiModelId === "string" ? body.aiModelId.trim() : null;
  if (aiAssistEnabled && !aiModelId) throw new ApiError(422, "organize_schedule_ai_model_missing", "请选择 AI 模型");
  const scheduleType = body.scheduleType as OrganizeSchedule["scheduleType"];
  const quietPeriodEnabled = body.quietPeriodEnabled;
  const quietStartTime = quietPeriodEnabled ? clock("quietStartTime") : "00:00";
  const quietEndTime = quietPeriodEnabled ? clock("quietEndTime") : "07:00";
  if (quietPeriodEnabled && quietStartTime === quietEndTime) {
    throw new ApiError(422, "organize_schedule_invalid", "暂停开始和结束时间不能相同");
  }
  return {
    enabled: body.enabled, scheduleType,
    intervalMinutes: scheduleType === "interval" ? integer("intervalMinutes", 5, 525_600) : null,
    timeOfDay: scheduleType === "interval" ? null : clock("timeOfDay"),
    dayOfWeek: scheduleType === "weekly" ? integer("dayOfWeek", 1, 7) : null,
    dayOfMonth: scheduleType === "monthly" ? integer("dayOfMonth", 1, 31) : null,
    timezoneOffsetMinutes: integer("timezoneOffsetMinutes", -720, 840),
    quietPeriodEnabled, quietStartTime, quietEndTime,
    sources: sources as OrganizeDirectory[], target: target as OrganizeDirectory | null, mode: body.mode,
    unrecognizedTransferEnabled, unrecognizedDirectory: unrecognizedTransferEnabled ? unrecognizedDirectory as OrganizeDirectory : null,
    aiAssistEnabled, aiModelId,
    ...readWashOptions(body),
  };
}

/** 单服务串行运行定时预览与创建任务；进度只存在 /data，不改数据库结构。 */
export class ServiceOrganizeScheduler {
  private readonly directory: string;
  private readonly busy = new Set<string>();
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  public constructor(private readonly runtime: ApiRuntime, private readonly manager: ServiceOrganizeManager) {
    this.directory = path.join(runtime.config.exportDirectory, "service-organize");
  }

  /** 按服务归属读取配置。 */
  public async get(serviceId: string, actorUserId?: string): Promise<OrganizeSchedule> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    const fileName = this.fileName(serviceId);
    try {
      const saved = JSON.parse(await fs.readFile(fileName, "utf8")) as OrganizeSchedule;
      if (saved.serviceId !== serviceId || saved.userId !== service.userId) throw new Error("整理计划归属不匹配");
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return defaultSchedule(serviceId, service.userId);
    }
  }

  /** 保存新的来源、目标、模式和触发时间；现有待执行预览保持原配置完成。 */
  public async update(serviceId: string, actorUserId: string | undefined, body: Record<string, unknown>): Promise<OrganizeSchedule> {
    if (this.busy.has(serviceId)) throw new ApiError(409, "organize_schedule_busy", "整理定时计划正在触发，请稍后保存");
    this.busy.add(serviceId);
    try {
      const previous = await this.get(serviceId, actorUserId);
      const input = readOrganizeScheduleInput(body);
      if (input.aiAssistEnabled) await prepareOrganizeAi(this.runtime, input.aiModelId ?? "");
      if (input.enabled && !(await this.manager.capabilities(serviceId, actorUserId)).supported) {
        throw new ApiError(409, "organize_service_unavailable", "网盘服务当前不支持影片整理");
      }
      const now = new Date();
      const schedule: OrganizeSchedule = { ...previous, ...input,
        nextRunAt: calculateNextScanRunAt(input, now), lastError: null, updatedAt: now.toISOString() };
      await saveSchedule(this.fileName(serviceId), schedule);
      return schedule;
    } finally { this.busy.delete(serviceId); }
  }

  /** 使用已保存配置立即生成预览，完成后由轮询器自动启动整理；不改定时触发时间。 */
  public async runNow(serviceId: string, actorUserId?: string): Promise<OrganizeSchedule> {
    if (this.busy.has(serviceId)) throw new ApiError(409, "organize_schedule_busy", "整理计划正在处理，请稍后重试");
    this.busy.add(serviceId);
    try {
      const schedule = await this.get(serviceId, actorUserId);
      if (!schedule.sources.length || !schedule.target) {
        throw new ApiError(422, "organize_schedule_paths_missing", "请先保存来源目录和目标目录");
      }
      if (schedule.pendingPlanId) throw new ApiError(409, "organize_schedule_pending", "已有整理预览正在准备");
      const active = (await this.manager.listJobs(serviceId, actorUserId))
        .find((job) => ["queued", "running", "paused"].includes(job.status));
      if (active) throw new ApiError(409, "organize_job_active", "当前服务已有排队、运行或暂停的整理任务");
      if (!(await this.manager.capabilities(serviceId, actorUserId)).supported) {
        throw new ApiError(409, "organize_service_unavailable", "网盘服务当前不支持影片整理");
      }
      if (schedule.aiAssistEnabled) await prepareOrganizeAi(this.runtime, schedule.aiModelId ?? "");
      const plan = await this.manager.createPlan(serviceId, actorUserId, {
        sources: schedule.sources, target: schedule.target, mode: schedule.mode,
        unrecognizedTransferEnabled: schedule.unrecognizedTransferEnabled,
        unrecognizedDirectory: schedule.unrecognizedDirectory,
        aiAssistEnabled: schedule.aiAssistEnabled, aiModelId: schedule.aiModelId,
        washEnabled: schedule.washEnabled, washPriorities: schedule.washPriorities,
      });
      const now = new Date().toISOString();
      schedule.pendingPlanId = plan.id;
      schedule.pendingRunKind = "manual";
      schedule.lastTriggeredAt = now;
      schedule.lastError = null;
      schedule.lastRunMessage = null;
      schedule.updatedAt = now;
      await saveSchedule(this.fileName(serviceId), schedule);
      this.schedulePendingProcess(serviceId);
      return schedule;
    } finally { this.busy.delete(serviceId); }
  }

  /** 进程启动后开始轮询，关闭服务时不再创建新任务。 */
  public start(): void { this.stopping = false; this.schedulePoll(2000); }
  public stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /** 待预览完成时只加速该服务的检查，不提高所有定时计划的轮询频率。 */
  private schedulePendingProcess(serviceId: string): void {
    if (this.stopping || this.pendingTimers.has(serviceId)) return;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(serviceId);
      if (this.stopping) return;
      if (this.busy.has(serviceId)) { this.schedulePendingProcess(serviceId); return; }
      this.busy.add(serviceId);
      void this.process(serviceId).catch((error) => this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-organize-schedule", 事件: "整理预览进度检查失败",
        服务ID: serviceId, 错误信息: error instanceof Error ? error.message : String(error),
      })).finally(() => this.busy.delete(serviceId));
    }, 2500);
    this.pendingTimers.set(serviceId, timer);
  }

  /** 固定 30 秒轮询一次，不在 HTTP 请求线程中扫描网盘。 */
  private schedulePoll(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => { void this.poll().finally(() => this.schedulePoll(30_000)); }, delay);
  }

  /** 逐服务处理到期计划；单个源失败不阻塞其他服务。 */
  private async poll(): Promise<void> {
    try {
      const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
      for (const name of names) {
        if (this.stopping) return;
        const match = /^schedule-([0-9a-f-]{36})\.json$/iu.exec(name);
        if (!match || this.busy.has(match[1]!)) continue;
        this.busy.add(match[1]!);
        try { await this.process(match[1]!); }
        catch (error) { this.runtime.logBusinessEvent("warn", {
          日志关键字: "codex-flycloud-organize-schedule", 事件: "定时整理处理失败",
          服务ID: match[1]!, 错误信息: error instanceof Error ? error.message : String(error),
        }); }
        finally { this.busy.delete(match[1]!); }
      }
    } catch (error) {
      this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-flycloud-organize-schedule",
        事件: "读取定时整理计划失败", 错误信息: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 待执行预览优先完成；进程重启后继续同一计划，避免重复整理。 */
  private async process(serviceId: string): Promise<void> {
    const schedule = await this.get(serviceId);
    if (!schedule.enabled && schedule.pendingRunKind !== "manual") {
      if (schedule.pendingPlanId) {
        schedule.pendingPlanId = null;
        schedule.pendingRunKind = undefined;
        await saveSchedule(this.fileName(serviceId), schedule);
      }
      return;
    }
    if (!schedule.pendingPlanId && (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > new Date().toISOString())) return;
    const now = new Date();
    if (!schedule.pendingPlanId) {
      const postponed = postponeQuietCandidate(now.getTime(), schedule);
      if (postponed > now.getTime()) {
        schedule.nextRunAt = new Date(postponed).toISOString();
        await saveSchedule(this.fileName(serviceId), schedule);
        return;
      }
      const jobs = await this.manager.listJobs(serviceId);
      const active = jobs.find((job) => ["queued", "running", "paused"].includes(job.status));
      if (active) { await this.retry(schedule, "当前服务已有排队、运行或暂停的整理任务", active.id); return; }
      try {
        const plan = await this.manager.createPlan(serviceId, schedule.userId, {
          sources: schedule.sources, target: schedule.target!, mode: schedule.mode,
          unrecognizedTransferEnabled: schedule.unrecognizedTransferEnabled,
          unrecognizedDirectory: schedule.unrecognizedDirectory,
          aiAssistEnabled: schedule.aiAssistEnabled, aiModelId: schedule.aiModelId,
          washEnabled: schedule.washEnabled, washPriorities: schedule.washPriorities });
        schedule.lastTriggeredAt = now.toISOString();
        schedule.nextRunAt = calculateNextScanRunAt(schedule, now);
        schedule.pendingPlanId = plan.id;
        schedule.pendingRunKind = "scheduled";
        schedule.lastError = null;
        schedule.lastRunMessage = null;
        schedule.updatedAt = now.toISOString();
        await saveSchedule(this.fileName(serviceId), schedule);
        this.schedulePendingProcess(serviceId);
      } catch (error) { await this.retry(schedule, error instanceof Error ? error.message : "生成预览失败"); }
      return;
    }
    try {
      const plan = await this.manager.getPlan(serviceId, schedule.pendingPlanId, schedule.userId);
      if (plan.status === "preparing") { this.schedulePendingProcess(serviceId); return; }
      if (plan.status === "failed") throw new Error(plan.error ?? "识别预览失败");
      const hasReadyItems = plan.items.some((item) => item.status === "ready");
      // 关键变量：任务创建后、计划保存前若重启，用 planId 找回已有任务。
      const existing = (await this.manager.listJobs(serviceId)).find((job) => job.planId === plan.id);
      const job = existing ?? await this.manager.createJob(serviceId, plan.id, schedule.userId, !hasReadyItems);
      schedule.lastJobId = job.id;
      schedule.lastError = null;
      schedule.lastBlockedNotificationKey = null;
      schedule.lastRunMessage = hasReadyItems ? "已启动整理任务" : "本次没有可整理的内容";
      schedule.pendingPlanId = null;
      schedule.pendingRunKind = undefined;
      schedule.updatedAt = new Date().toISOString();
      await saveSchedule(this.fileName(serviceId), schedule);
    } catch (error) {
      await this.retry(schedule, error instanceof Error ? error.message : "启动整理任务失败");
    }
  }

  /** 占用时稍后检查；预览或创建失败则放弃本轮，按原配置等待下一轮。 */
  private async retry(schedule: OrganizeSchedule, message: string, blockingJobId?: string): Promise<void> {
    // 关键变量：手动任务失败不应改变原有定时任务的下次执行时间。
    const manualRun = schedule.pendingRunKind === "manual";
    const notificationKey = `${blockingJobId ?? ""}:${message}`;
    const shouldNotify = schedule.lastBlockedNotificationKey !== notificationKey;
    schedule.lastError = message;
    schedule.lastRunMessage = null;
    schedule.pendingPlanId = null;
    schedule.pendingRunKind = undefined;
    if (!manualRun) schedule.nextRunAt = blockingJobId
      ? schedule.enabled ? new Date(Date.now() + 5 * 60_000).toISOString() : null
      : calculateNextScanRunAt(schedule, new Date());
    schedule.updatedAt = new Date().toISOString();
    schedule.lastBlockedNotificationKey = notificationKey;
    await saveSchedule(this.fileName(schedule.serviceId), schedule);
    if (!shouldNotify) return;
    const service = await this.runtime.repository.getServiceDetail(schedule.serviceId, schedule.userId).catch(() => null);
    await this.runtime.database.createNotificationSafely({
      userId: schedule.userId, category: "task", tone: blockingJobId ? "warning" : "danger",
      title: blockingJobId ? "影片整理受阻" : "影片整理失败",
      message: `服务“${service?.displayName ?? "网盘服务"}”的${manualRun ? "本次整理" : "定时整理"}未能继续：${message}。`
        + (blockingJobId && schedule.enabled && !manualRun ? "五分钟后再次检查，同一阻塞原因不重复提醒。"
          : "本轮已放弃，不自动重试，后续定时计划按原配置执行。"),
      actionPath: `/app/services/${schedule.serviceId}/organize`,
    });
  }

  /** 仅允许服务 UUID 构成配置文件名。 */
  private fileName(serviceId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(serviceId)) throw new ApiError(404, "organize_service_missing", "网盘服务不存在");
    return path.join(this.directory, `schedule-${serviceId}.json`);
  }
}
