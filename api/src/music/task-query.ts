import type { Knex } from "knex";
import { ApiError } from "../errors.js";
import type { ScanJobRecord } from "../domain.js";
import { readPagination } from "../http.js";

/** 调用方先验证任务归属，只返回阶段展示字段，不返回 Provider locator 和原始正文。 */
export async function listMusicStageTasks(database: Knex, job: ScanJobRecord, query: Record<string, unknown>) {
  if (job.dataType !== "music" || job.jobType !== "scan") throw new ApiError(422, "music_job_required", "该任务不是音乐扫描");
  const stage = String(query.stage ?? "");
  if (!["directory", "file", "online"].includes(stage)) throw new ApiError(422, "music_stage_invalid", "请选择音乐阶段");
  const status = String(query.status ?? "problems");
  if (!["all", "problems", "pending", "running", "succeeded", "failed", "skipped", "unmatched"].includes(status)) throw new ApiError(422, "music_status_invalid", "阶段状态无效");
  const { limit, offset } = readPagination(query);
  const base = database("music_scan_tasks").where({ job_id: job.id, stage });
  if (status === "problems") base.whereIn("status", ["failed", "unmatched"]);
  else if (status === "pending") base.whereIn("status", ["pending", "blocked"]);
  else if (status !== "all") base.where({ status });
  const [rows, count] = await Promise.all([base.clone().select("id", "stage", "status", "payload", "error").orderBy("id").limit(limit).offset(offset), base.clone().count({ total: "*" }).first()]);
  return { total: Number(count?.total ?? 0), limit, offset, items: rows.map((row) => {
    const payload = JSON.parse(String(row.payload)) as { path?: string; entry?: { path?: string; name?: string; resourceId?: string } };
    return { id: String(row.id), stage: String(row.stage), status: String(row.status), path: payload.entry?.path ?? payload.path ?? "",
      name: payload.entry?.name ?? "", resourceId: payload.entry?.resourceId ?? "", error: String(row.error || (row.status === "unmatched" ? "未找到可信候选，文件资料和播放已保留" : "")) };
  }) };
}
