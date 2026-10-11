import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError, validationError } from "../errors.js";
import type { ContentSourceManager } from "./manager.js";

/** 一库一份自动同步计划，未保存的库始终返回默认关闭配置。 */
export interface ContentSourceAutoSyncSettings {
  enabled: boolean;
  intervalMinutes: number;
  mode: "latest";
  pageCount: 1;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastError: string | null;
}

/** PATCH 仅修改计划参数，不允许调用方覆盖执行时间和错误状态。 */
export interface ContentSourceAutoSyncInput {
  enabled?: boolean;
  intervalMinutes?: number;
  mode?: "latest";
  pageCount?: number;
}

interface AutoSyncPlanRow {
  library_id: string;
  user_id: string;
  enabled: number | string | boolean;
  interval_minutes: number | string;
  mode: "latest" | "refresh" | "next";
  page_count: number | string;
  next_run_at: string | null;
  last_triggered_at: string | null;
  last_error: string | null;
  revision: number | string;
  claim_token: string | null;
}

interface AutoSyncLibraryState {
  library_status: string;
  source_status: string;
  instance_status: string;
  plugin_status: string;
  owner_status: string;
  sync_status: string;
}

interface ClaimedAutoSyncPlan {
  row: AutoSyncPlanRow;
  token: string;
  nextRunAt: string;
}

type AutoSyncLogger = (level: "info" | "warn", fields: Record<string, string | number | boolean | null>) => void;

/** 默认计划只供读取和首次保存，不自动创建数据库记录或开启任务。 */
function defaultSettings(): ContentSourceAutoSyncSettings {
  return { enabled: false, intervalMinutes: 60, mode: "latest", pageCount: 1, nextRunAt: null, lastTriggeredAt: null, lastError: null };
}

/** 三种数据库的布尔和整数字段转换为一致的公开设置。 */
function mapSettings(row: AutoSyncPlanRow): ContentSourceAutoSyncSettings {
  return {
    enabled: row.enabled === true || Number(row.enabled) === 1,
    intervalMinutes: Number(row.interval_minutes), mode: "latest", pageCount: 1,
    nextRunAt: row.next_run_at, lastTriggeredAt: row.last_triggered_at, lastError: row.last_error,
  };
}

/** 严格校验部分更新，不把字符串或小数悄悄当成有效的计划参数。 */
function validateInput(input: ContentSourceAutoSyncInput): void {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw validationError("enabled", "自动同步启用状态必须为布尔值");
  if (input.intervalMinutes !== undefined && (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 10 || input.intervalMinutes > 10080)) throw validationError("intervalMinutes", "自动同步间隔必须为 10 至 10080 分钟的整数");
  if (input.mode !== undefined && input.mode !== "latest") throw validationError("mode", "自动同步固定读取已选分类的第一页，模式必须为 latest");
  if (input.pageCount !== undefined && input.pageCount !== 1) throw validationError("pageCount", "自动同步固定读取每个已选分类的第一页，页数必须为 1");
}

/** 保存固定错误文案，数据库异常和驱动错误原文不能进入接口或日志。 */
function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      content_sync_running: "已有同步正在执行，自动同步已推迟一分钟",
      content_library_disabled: "媒体库已停用，本次自动同步未启动",
      content_source_disabled: "内容源实例已停用，本次自动同步未启动",
      content_plugin_disabled: "内容源插件未启用，本次自动同步未启动",
      content_auto_sync_owner_disabled: "媒体库所有者已停用，本次自动同步未启动",
      content_library_not_found: "内容源媒体库不存在，本次自动同步未启动",
      content_source_stopping: "服务正在停止，本次自动同步未启动",
      content_auto_sync_plan_changed: "自动同步计划已修改或关闭，本次任务未启动",
    };
    if (messages[error.code]) return messages[error.code]!;
  }
  return "自动同步未能启动，请检查内容源与数据库状态";
}

/** 独立内容源自动同步后台；只启动已有同步流程，不直接处理源目录或播放地址。 */
export class ContentSourceAutoSyncWorker {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollPromise: Promise<void> | null = null;
  private initialized = false;
  private stopping = true;
  private static readonly POLL_INTERVAL_MS = 30_000;
  private static readonly BUSY_DELAY_MS = 60_000;

  /** 复用宿主数据库、内容源管理器和安全业务日志。 */
  public constructor(private readonly options: {
    database: FlyCloudHelperDatabase;
    contentSources: ContentSourceManager;
    logBusinessEvent: AutoSyncLogger;
  }) {}

  /** 创建计划表并迁移旧模式，不新增旧库计划；每次 schema 操作使用新的 Knex builder。 */
  public async initialize(): Promise<void> {
    const database = this.options.database;
    if (!(await database.query.schema.hasTable("content_source_auto_sync_plans"))) {
      await database.query.schema.createTable("content_source_auto_sync_plans", (table) => {
        table.string("library_id", 64).primary().references("id").inTable("media_libraries").onDelete("CASCADE");
        table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
        table.integer("enabled").notNullable().defaultTo(0);
        table.integer("interval_minutes").notNullable().defaultTo(60);
        table.string("mode", 16).notNullable().defaultTo("latest");
        table.integer("page_count").notNullable().defaultTo(1);
        table.string("next_run_at", 40).nullable();
        table.string("last_triggered_at", 40).nullable();
        table.text("last_error").nullable();
        table.integer("revision").notNullable().defaultTo(1);
        table.string("claim_token", 64).nullable();
        table.string("created_at", 40).notNullable();
        table.string("updated_at", 40).notNullable();
        table.index(["enabled", "next_run_at"], "idx_content_auto_sync_due");
      });
    }
    // 关键变量：迁移只改变固定任务参数和领取修订，原启用状态、执行时间及历史记录保持不变。
    await database.query("content_source_auto_sync_plans").whereIn("mode", ["refresh", "next"]).update({
      mode: "latest", page_count: 1, revision: database.query.raw("?? + ?", ["revision", 1]),
      claim_token: null, updated_at: new Date().toISOString(),
    });
    this.initialized = true;
  }

  /** 查询个人或管理员已解析归属的在线库计划，未保存时只返回默认值。 */
  public async get(libraryId: string, ownerUserId: string): Promise<ContentSourceAutoSyncSettings> {
    await this.libraryState(libraryId, ownerUserId);
    const row = await this.options.database.query("content_source_auto_sync_plans").where({ library_id: libraryId, user_id: ownerUserId }).first() as AutoSyncPlanRow | undefined;
    return row ? mapSettings(row) : defaultSettings();
  }

  /** 保存时锁定媒体库，只改计划；启用或改参数后等待一个完整间隔再启动。 */
  public async save(libraryId: string, ownerUserId: string, input: ContentSourceAutoSyncInput): Promise<ContentSourceAutoSyncSettings> {
    validateInput(input);
    return this.options.database.query.transaction(async (transaction) => {
      const libraryQuery = transaction("media_libraries").where({ id: libraryId, user_id: ownerUserId, library_kind: "content_source_video" });
      if (this.options.database.databaseType !== "sqlite") libraryQuery.forUpdate();
      if (!(await libraryQuery.first())) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      await this.libraryState(libraryId, ownerUserId, transaction);
      const planQuery = transaction("content_source_auto_sync_plans").where({ library_id: libraryId, user_id: ownerUserId });
      if (this.options.database.databaseType !== "sqlite") planQuery.forUpdate();
      const previousRow = await planQuery.first() as AutoSyncPlanRow | undefined;
      const previous = previousRow ? mapSettings(previousRow) : defaultSettings();
      // 关键变量：只编辑启用状态和间隔，任务始终读取已选分类第一页，不能让 PATCH 覆盖执行记录。
      const settings: ContentSourceAutoSyncSettings = {
        ...previous, enabled: input.enabled ?? previous.enabled, intervalMinutes: input.intervalMinutes ?? previous.intervalMinutes,
        mode: "latest", pageCount: 1,
      };
      const changed = settings.enabled !== previous.enabled || settings.intervalMinutes !== previous.intervalMinutes
        || (previousRow !== undefined && (previousRow.mode !== "latest" || Number(previousRow.page_count) !== 1));
      if (previousRow && !changed) return previous;
      const now = new Date();
      settings.nextRunAt = settings.enabled ? new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString() : null;
      settings.lastError = null;
      const values = {
        enabled: settings.enabled ? 1 : 0, interval_minutes: settings.intervalMinutes, mode: settings.mode, page_count: settings.pageCount,
        next_run_at: settings.nextRunAt, last_error: null, revision: Number(previousRow?.revision ?? 0) + 1,
        claim_token: null, updated_at: now.toISOString(),
      };
      if (previousRow) await transaction("content_source_auto_sync_plans").where({ library_id: libraryId, user_id: ownerUserId }).update(values);
      else await transaction("content_source_auto_sync_plans").insert({ library_id: libraryId, user_id: ownerUserId, last_triggered_at: null, created_at: now.toISOString(), ...values });
      return settings;
    });
  }

  /** 默认只轮询已明确开启且到期的持久计划，不为现有库生成任务。 */
  public start(): void {
    if (!this.initialized) throw new ApiError(503, "content_auto_sync_uninitialized", "自动同步后台尚未初始化");
    if (this.pollTimer || this.pollPromise) return;
    this.stopping = false;
    this.scheduleNextPoll();
  }

  /** 先停止新增触发并等待当前轮询收尾；已入队同步由管理器的 shutdown 统一等待。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.pollPromise;
  }

  /** 安排下一轮轮询，定时器不独自阻止宿主进程退出。 */
  private scheduleNextPoll(): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollPromise = this.poll();
    }, ContentSourceAutoSyncWorker.POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /** 每轮最多处理二十个到期计划；单个计划失败不阻断其他媒体库。 */
  private async poll(): Promise<void> {
    try {
      const now = new Date().toISOString();
      const rows = await this.options.database.query("content_source_auto_sync_plans")
        .where({ enabled: 1 }).whereNotNull("next_run_at").where("next_run_at", "<=", now)
        .orderBy("next_run_at", "asc").limit(20) as AutoSyncPlanRow[];
      for (const row of rows) {
        if (this.stopping) break;
        await this.trigger(row);
      }
    } catch (error) {
      this.logFailure("轮询内容源自动同步失败", null, error);
    } finally {
      this.pollPromise = null;
      this.scheduleNextPoll();
    }
  }

  /** 到期时间和修订号原子比较，领取后先推进下一周期，避免多进程重复启动本轮。 */
  private async claim(row: AutoSyncPlanRow): Promise<ClaimedAutoSyncPlan | null> {
    const now = new Date();
    const token = randomUUID();
    const nextRunAt = new Date(now.getTime() + Number(row.interval_minutes) * 60_000).toISOString();
    const changed = await this.options.database.query("content_source_auto_sync_plans")
      .where({ library_id: row.library_id, user_id: row.user_id, enabled: 1, revision: row.revision, next_run_at: row.next_run_at })
      .update({ next_run_at: nextRunAt, claim_token: token, updated_at: now.toISOString() });
    return Number(changed) === 1 ? { row, token, nextRunAt } : null;
  }

  /** 检查源和当前同步状态后复用 startLibrarySync，不修改分类、账号或播放模式。 */
  private async trigger(row: AutoSyncPlanRow): Promise<void> {
    let claimed: ClaimedAutoSyncPlan | null = null;
    let started = false; // 关键变量：入队成功后的记录错误不能被描述成任务没有启动。
    try {
      claimed = await this.claim(row);
      if (!claimed) return;
      if (this.stopping) {
        await this.finish(claimed, { next_run_at: row.next_run_at, last_error: null });
        return;
      }
      // 关键变量：领取期间用户可能保存或关闭计划，旧修订不能继续启动或覆盖新设置。
      const stillClaimed = await this.options.database.query("content_source_auto_sync_plans")
        .where({ library_id: row.library_id, user_id: row.user_id, enabled: 1, revision: row.revision, claim_token: claimed.token }).first();
      if (!stillClaimed) return;
      const state = await this.libraryState(row.library_id, row.user_id);
      if (state.owner_status !== "active") throw new ApiError(409, "content_auto_sync_owner_disabled", "媒体库所有者已停用");
      if (state.library_status !== "active") throw new ApiError(409, "content_library_disabled", "媒体库已停用");
      if (state.source_status !== "active" || state.instance_status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
      if (state.plugin_status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件未启用");
      if (state.sync_status === "queued" || state.sync_status === "running") throw new ApiError(409, "content_sync_running", "已有同步正在执行");
      if (this.stopping) {
        await this.finish(claimed, { next_run_at: row.next_run_at, last_error: null });
        return;
      }
      await this.options.contentSources.startLibrarySync(row.library_id, row.user_id, {
        mode: "latest", pageCount: 1,
        // 最终领取校验与入队在管理器的同一库行锁内完成，事务外预检查只用于减少无效工作。
        autoSyncClaim: { revision: Number(row.revision), token: claimed.token },
      });
      started = true;
      await this.finish(claimed, { last_triggered_at: new Date().toISOString(), last_error: null });
      this.options.logBusinessEvent("info", { 日志关键字: "codex-content-source-auto-sync", 事件: "内容源自动同步已启动", 媒体库ID: row.library_id, 同步模式: "latest", 每次页数: 1, 下次执行时间: claimed.nextRunAt });
    } catch (error) {
      if (claimed) {
        const busy = error instanceof ApiError && error.code === "content_sync_running";
        const nextRunAt = busy ? new Date(Date.now() + ContentSourceAutoSyncWorker.BUSY_DELAY_MS).toISOString() : claimed.nextRunAt;
        try {
          await this.finish(claimed, { next_run_at: nextRunAt, last_error: started ? "自动同步已启动，但保存执行记录失败" : failureMessage(error) });
        } catch (recordError) {
          // 数据库状态写入失败仍逐条收尾，不把原始 SQL 或异常正文打印出来。
          this.logFailure("记录自动同步计划结果失败", row.library_id, recordError);
        }
      }
      this.logFailure(started ? "记录自动同步启动结果失败" : "内容源自动同步未启动", row.library_id, error);
    }
  }

  /** 仅领取者的原修订可以记录结果，保存计划后旧触发的回写自然失效。 */
  private async finish(claimed: ClaimedAutoSyncPlan, values: { next_run_at?: string | null; last_triggered_at?: string; last_error: string | null }): Promise<void> {
    await this.options.database.query("content_source_auto_sync_plans")
      .where({ library_id: claimed.row.library_id, user_id: claimed.row.user_id, revision: claimed.row.revision, claim_token: claimed.token })
      .update({ ...values, claim_token: null, updated_at: new Date().toISOString() });
  }

  /** 个人和管理员都传真实所有者，停用状态允许查看和编辑计划，但执行时会跳过。 */
  private async libraryState(libraryId: string, ownerUserId: string, query: Knex | Knex.Transaction = this.options.database.query): Promise<AutoSyncLibraryState> {
    const row = await query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .join("library_sources as ls", "ls.id", "b.library_source_id")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinAutoSyncPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .join("user_accounts as u", "u.id", "b.user_id")
      .select("l.status as library_status", "ls.status as source_status", "i.status as instance_status", "p.status as plugin_status", "u.status as owner_status", "b.sync_status")
      .where({ "b.library_id": libraryId, "b.user_id": ownerUserId, "l.user_id": ownerUserId, "ls.user_id": ownerUserId, "i.user_id": ownerUserId, "l.library_kind": "content_source_video" }).first();
    if (!row) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
    return row as AutoSyncLibraryState;
  }

  /** 日志只保留错误代码、类型和库身份，不输出异常原文或数据库参数。 */
  private logFailure(event: string, libraryId: string | null, error: unknown): void {
    const details = error && typeof error === "object" ? error as { code?: unknown; name?: unknown } : {};
    this.options.logBusinessEvent("warn", { 日志关键字: "codex-content-source-auto-sync", 事件: event, 媒体库ID: libraryId, 错误代码: typeof details.code === "string" ? details.code : "unknown", 错误类型: typeof details.name === "string" ? details.name : typeof error });
  }
}
