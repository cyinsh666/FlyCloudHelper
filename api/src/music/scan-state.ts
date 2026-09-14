import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { createStableId } from "../media/filename.js";

export type MusicStage = "directory" | "file" | "online";
export type MusicTaskState = "blocked" | "pending" | "running" | "succeeded" | "failed" | "skipped" | "unmatched";
export interface MusicStageTask {
  id: string;
  stage: MusicStage;
  status: MusicTaskState;
  parent_key: string;
  payload: string;
  result: string;
  lease: string;
  error: string;
}

/** 追加音乐任务结构，外键级联沿用现有任务与服务清理入口。 */
export async function createMusicScanTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("music_scan_runs"))) {
    await database.schema.createTable("music_scan_runs", (table) => {
      table.string("job_id", 64).primary().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("epoch", 64).notNullable();
      table.integer("discovery_closed").notNullable().defaultTo(0);
      table.text("settings", "longtext").notNullable();
    });
  }
  if (!(await database.schema.hasTable("music_scan_tasks"))) {
    await database.schema.createTable("music_scan_tasks", (table) => {
      table.string("id", 64).primary();
      table.string("job_id", 64).notNullable().references("job_id").inTable("music_scan_runs").onDelete("CASCADE");
      table.string("stage", 16).notNullable();
      table.string("status", 16).notNullable();
      table.string("parent_key", 64).notNullable();
      table.string("lease", 64).notNullable().defaultTo("");
      table.text("payload", "longtext").notNullable();
      table.text("result", "longtext").notNullable();
      table.text("error").notNullable();
      table.index(["job_id", "stage", "status"], "idx_music_stage_claim");
      table.index(["job_id", "parent_key", "stage"], "idx_music_directory_files");
    });
  }
  if (!(await database.schema.hasTable("music_scan_pages"))) {
    await database.schema.createTable("music_scan_pages", (table) => {
      table.string("id", 64).primary();
      table.string("job_id", 64).notNullable().references("job_id").inTable("music_scan_runs").onDelete("CASCADE");
      table.string("directory_key", 64).notNullable();
      table.text("payload", "longtext").notNullable();
      table.index(["job_id", "directory_key"], "idx_music_directory_pages");
    });
  }
  if (!(await database.schema.hasTable("music_scan_changes"))) {
    await database.schema.createTable("music_scan_changes", (table) => {
      table.string("job_id", 64).notNullable().references("job_id").inTable("music_scan_runs").onDelete("CASCADE");
      table.string("item_id", 64).notNullable();
      table.primary(["job_id", "item_id"]);
    });
  }
  if (!(await database.schema.hasTable("music_file_snapshots"))) {
    await database.schema.createTable("music_file_snapshots", (table) => {
      table.string("source_file_id", 64).primary().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("file_fingerprint", 128).notNullable();
      table.string("online_fingerprint", 128).notNullable();
      table.text("file_result", "longtext").notNullable();
      table.text("online_result", "longtext").notNullable();
      table.string("online_status", 16).notNullable();
    });
  }
}

/** 三阶段持久化队列；父任务排他执行，代次拒绝旧执行器迟到完成。 */
export class MusicScanState {
  public epoch = randomUUID();
  /** 使用业务数据库，所有表名固定，不从请求拼接 SQL。 */
  public constructor(public readonly database: Knex, public readonly jobId: string) {}

  /** 恢复时只释放上一执行器领取中的项目，保留成功阶段。 */
  public async initialize(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction("music_scan_runs").where({ job_id: this.jobId }).first();
      if (!existing) await transaction("music_scan_runs").insert({ job_id: this.jobId, epoch: this.epoch, discovery_closed: 0, settings: JSON.stringify(settings) });
      else await transaction("music_scan_runs").where({ job_id: this.jobId }).update({ epoch: this.epoch });
      await transaction("music_scan_tasks").where({ job_id: this.jobId, status: "running" }).update({ status: "pending", lease: "" });
      return existing ? JSON.parse(String(existing.settings)) as Record<string, unknown> : settings;
    });
  }

  /** 目录路径保持 Provider 的实际大小写，仅消除尾部目录分隔符。 */
  public directoryKey(path: string): string { return createStableId("mdir", path.replace(/\/+$/u, "") || "/"); }

  /** 重放枚举时不覆盖已存在的任务结果。 */
  public async enqueue(stage: MusicStage, key: string, parentKey: string, payload: unknown, blocked = false): Promise<string> {
    const id = createStableId("mst", this.jobId, stage, key);
    await this.database("music_scan_tasks").insert({ id, job_id: this.jobId, stage, status: blocked ? "blocked" : "pending", parent_key: parentKey,
      lease: "", payload: JSON.stringify(payload), result: "{}", error: "" }).onConflict("id").ignore();
    return id;
  }

  /** 目录所有分页完成后才释放文件任务，旁挂集合与释放在同一事务提交。 */
  public async closeDirectory(path: string, sidecars: unknown[]): Promise<void> {
    const key = this.directoryKey(path);
    await this.enqueue("directory", key, key, { path });
    await this.database.transaction(async (transaction) => {
      await this.guard(transaction);
      await transaction("music_scan_tasks").where({ job_id: this.jobId, stage: "directory", parent_key: key }).update({ status: "succeeded", result: JSON.stringify({ sidecars }), error: "" });
      await transaction("music_scan_tasks").where({ job_id: this.jobId, stage: "file", parent_key: key, status: "blocked" }).update({ status: "pending" });
    });
  }

  /** 分页正文先持久化后交给枚举器，重启重放已存分页并继续未完成分页。 */
  public async loadPage<T>(directoryPath: string, pageKey: string, load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const key = this.directoryKey(directoryPath);
    const id = createStableId("mpage", this.jobId, key, pageKey);
    const saved = await this.database("music_scan_pages").where({ id }).first();
    if (saved) return JSON.parse(String(saved.payload)) as T;
    const taskId = await this.enqueue("directory", key, key, { path: directoryPath });
    await this.database("music_scan_tasks").where({ id: taskId }).update({ status: "running", error: "" });
    try {
      const result = await load();
      signal.throwIfAborted();
      await this.database.transaction(async (transaction) => {
        await this.guard(transaction);
        await transaction("music_scan_pages").insert({ id, job_id: this.jobId, directory_key: key, payload: JSON.stringify(result) }).onConflict("id").ignore();
      });
      return result;
    } catch (error) {
      signal.throwIfAborted();
      await this.database("music_scan_tasks").where({ id: taskId }).update({ status: "failed", error: (error instanceof Error ? error.message : "目录读取失败").slice(0, 600) });
      throw error;
    }
  }

  /** 变更条目持久化，暂停或重启后仍能发布完整目录版本。 */
  public async recordChanges(ids: string[]): Promise<void> {
    for (const itemId of ids) await this.database("music_scan_changes").insert({ job_id: this.jobId, item_id: itemId }).onConflict(["job_id", "item_id"]).ignore();
  }

  /** 发布本轮各次执行共同产生的变更，不依赖进程内集合。 */
  public async changedItemIds(): Promise<string[]> {
    return (await this.database("music_scan_changes").select("item_id").where({ job_id: this.jobId })).map((row) => String(row.item_id));
  }

  /** 查询本目录已冻结的旁挂集合。 */
  public async sidecars(parentKey: string): Promise<unknown[]> {
    const row = await this.database("music_scan_tasks").where({ job_id: this.jobId, stage: "directory", parent_key: parentKey }).first();
    return row ? (JSON.parse(String(row.result)) as { sidecars?: unknown[] }).sidecars ?? [] : [];
  }

  /** 领取使用父轮次行锁，多个文件/在线 worker 不会领到同一项目。 */
  public async claim(stage: MusicStage): Promise<MusicStageTask | null> {
    return this.database.transaction(async (transaction) => {
      await this.guard(transaction);
      const row = await transaction("music_scan_tasks").where({ job_id: this.jobId, stage, status: "pending" }).orderBy("id").first();
      if (!row) return null;
      const lease = randomUUID();
      await transaction("music_scan_tasks").where({ id: row.id }).update({ status: "running", lease });
      return { ...row, lease, status: "running" } as MusicStageTask;
    });
  }

  /** 保存结果并原子创建在线任务；文件局部失败仍允许在线补充已有信息。 */
  public async finish(task: MusicStageTask, status: MusicTaskState, result: unknown, error = "", next?: unknown): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.guard(transaction);
      const updated = await transaction("music_scan_tasks").where({ id: task.id, lease: task.lease, status: "running" }).update({ status, result: JSON.stringify(result), error: error.slice(0, 600) });
      if (!updated) throw new Error("音乐阶段领取已失效");
      if (next) await transaction("music_scan_tasks").insert({ id: createStableId("mst", this.jobId, "online", task.id), job_id: this.jobId,
        stage: "online", status: "pending", parent_key: task.parent_key, lease: "", payload: JSON.stringify(next), result: "{}", error: "" }).onConflict("id").ignore();
    });
  }

  /** 暂停和失败退出后释放领取，恢复沿用原有已完成结果。 */
  public async releaseRunning(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.guard(transaction);
      await transaction("music_scan_tasks").where({ job_id: this.jobId, status: "running" }).update({ status: "pending", lease: "" });
    });
  }

  /** 背压只读取至阈值数量的索引，不在每首领取时聚合全部阶段。 */
  public async hasBacklog(stage: MusicStage, threshold: number): Promise<boolean> {
    const rows = await this.database("music_scan_tasks").select("id").where({ job_id: this.jobId, stage, status: "pending" }).limit(threshold);
    return rows.length >= threshold;
  }

  /** 返回可以处理的工作数量，阻塞于未完成目录的文件保留给目录恢复。 */
  public async runnableCount(stage: MusicStage): Promise<number> {
    const row = await this.database("music_scan_tasks").where({ job_id: this.jobId, stage }).whereIn("status", ["pending", "running"]).count({ count: "*" }).first();
    return Number(row?.count ?? 0);
  }

  /** 父任务持有唯一执行权，恢复后的新代次阻止旧结果覆盖。 */
  private async guard(transaction: Knex.Transaction): Promise<void> {
    const row = await transaction("music_scan_runs").where({ job_id: this.jobId }).forUpdate().first();
    if (!row || row.epoch !== this.epoch) throw new Error("音乐扫描执行代次已失效");
  }

  /** 阶段计数只读取状态索引的 SQL 聚合，不加载曲目正文。 */
  public async progress() {
    const rows = await this.database("music_scan_tasks").select("stage", "status").count({ count: "*" }).where({ job_id: this.jobId }).groupBy("stage", "status") as unknown as Array<{ stage: MusicStage; status: MusicTaskState; count: number | string }>;
    const run = await this.database("music_scan_runs").where({ job_id: this.jobId }).first();
    return (["directory", "file", "online"] as MusicStage[]).map((stage) => {
      const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, unmatched: 0 };
      for (const row of rows) if (row.stage === stage) {
        const status = row.status === "blocked" ? "pending" : row.status as keyof typeof counts;
        if (status in counts) counts[status as keyof typeof counts] += Number(row.count);
      }
      return { stage, ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0), discoveryClosed: Boolean(run?.discovery_closed) };
    });
  }

  /** 保留目录完成标识，服务重启恢复时不再次遍历已完成的一轮。 */
  public async closeDiscovery(): Promise<void> { await this.database("music_scan_runs").where({ job_id: this.jobId, epoch: this.epoch }).update({ discovery_closed: 1 }); }
  /** 判断本轮是否需要继续枚举。 */
  public async discoveryClosed(): Promise<boolean> { return Boolean((await this.database("music_scan_runs").where({ job_id: this.jobId }).first())?.discovery_closed); }
}
