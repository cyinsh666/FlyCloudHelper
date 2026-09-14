import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { ScanJobRecord } from "../domain.js";
import { createStableId } from "../media/filename.js";

/** 原音乐任务按阶段重新入队，已经成功的文件快照继续保留。 */
export async function retryMusicScan(runtime: ApiRuntime, job: ScanJobRecord, stage: unknown): Promise<ScanJobRecord> {
  if (!["completed", "failed", "cancelled"].includes(job.status)) throw new ApiError(409, "job_not_retryable", "请等待扫描结束后再重试");
  if (stage !== undefined && !["directory", "file", "online"].includes(String(stage))) throw new ApiError(422, "music_stage_invalid", "音乐重试阶段无效");
  await runtime.database.query.transaction(async (transaction) => {
    const service = await transaction("cloud_services").where({ id: job.serviceId, user_id: job.userId }).whereNull("deleted_at").forUpdate().first();
    if (!service) throw new ApiError(404, "service_not_found", "音乐服务不存在");
    if (service.status === "disabled") throw new ApiError(409, "service_disabled", "请先启用音乐服务再重试");
    const current = await transaction("scan_jobs").where({ id: job.id }).forUpdate().first();
    if (!current || !["completed", "failed", "cancelled"].includes(String(current.status))) throw new ApiError(409, "job_operation_in_progress", "任务已进入重试，请等待刷新");
    const other = await transaction("scan_jobs").where({ service_id: job.serviceId }).whereNot({ id: job.id }).whereIn("status", ["running", "queued", "paused", "retry_waiting"]).first();
    if (other) throw new ApiError(409, "scan_job_conflict", "当前服务已有未结束的扫描任务");
    const run = await transaction("music_scan_runs").where({ job_id: job.id }).first();
    if (!run) throw new ApiError(409, "music_legacy_job", "这是旧版音乐任务，请从服务页面发起新的扫描");
    const selected = stage ? [String(stage)] : ["directory", "file", "online"];
    if (selected.includes("directory")) {
      const directories = await transaction("music_scan_tasks").select("parent_key").where({ job_id: job.id, stage: "directory" }).whereIn("status", ["failed", "running", "pending"]);
      for (const directory of directories) await transaction("music_scan_pages").where({ job_id: job.id, directory_key: directory.parent_key }).delete();
    }
    // 文件重试会生成新快照，下游旧成功结果必须一起重新评估。
    if (selected.includes("file")) {
      const failures = await transaction("music_scan_tasks").select("id").where({ job_id: job.id, stage: "file" }).whereIn("status", ["failed", "running"]);
      for (const row of failures) await transaction("music_scan_tasks").where({ id: createStableId("mst", job.id, "online", String(row.id)) }).delete();
    }
    await transaction("music_scan_tasks").where({ job_id: job.id }).whereIn("stage", selected).whereIn("status", ["failed", "unmatched", "running"]).update({ status: "pending", error: "", lease: "" });
    const snapshot = JSON.parse(String(current.snapshot_json)) as Record<string, unknown>;
    await transaction("music_scan_runs").where({ job_id: job.id }).update({ epoch: randomUUID(), ...(selected.includes("directory") ? { discovery_closed: 0 } : {}) });
    await transaction("scan_jobs").where({ id: job.id }).update({ status: "queued", stage: "queued", control_action: "none", error_code: null, error_message: null, finished_at: null,
      snapshot_json: JSON.stringify({ ...snapshot, retryOfJobId: job.id, musicRetryStage: stage ?? "all" }), updated_at: new Date().toISOString() });
  });
  runtime.logBusinessEvent("info", { 日志关键字: "codex-flycloud-music", 事件: "音乐按阶段重试", 任务ID: job.id, 阶段: String(stage ?? "全部") });
  return runtime.repository.getJob(job.id, job.userId);
}
