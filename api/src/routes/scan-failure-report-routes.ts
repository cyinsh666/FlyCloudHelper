import { Readable } from "node:stream";
import { listMusicStageTasks } from "../music/task-query.js";
import type { ScanJobRecord } from "../domain.js";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 音乐报告按当前阶段状态分页生成，已重试成功的历史错误不重复导出。 */
async function* musicFailureLines(runtime: ApiRuntime, job: ScanJobRecord): AsyncGenerator<string> {
  if (job.errorCode) yield JSON.stringify({ jobId: job.id, stage: "task", errorCode: job.errorCode, error: job.errorMessage, recovered: false }) + "\n";
  for (const stage of ["directory", "file", "online"]) {
    let offset = 0;
    while (true) {
      const page = await listMusicStageTasks(runtime.database.query, job, { stage, status: "problems", offset, limit: 200 });
      for (const item of page.items) yield JSON.stringify({ jobId: job.id, stage, errorCode: `music_${stage}_${item.status}`, error: item.error,
        resourceId: item.resourceId, mediaPath: item.path, fileName: item.name, recovered: false,
        context: { 音乐阶段: stage, 可以重试: true, 处理说明: "已有资料保留，可按阶段重试" } }) + "\n";
      offset += page.items.length;
      if (!page.items.length || offset >= page.total) break;
    }
  }
}

/** 发送已完成归属校验的扫描或 AI 补充失败报告文件。 */
async function sendFailureReport(
  runtime: ApiRuntime,
  reply: FastifyReply,
  jobId: string,
  userId?: string,
): Promise<FastifyReply> {
  const job = await runtime.repository.getJob(jobId, userId);
  if (job.dataType === "music" && job.jobType === "scan" && await runtime.database.query("music_scan_runs").where({ job_id: job.id }).first()) {
    reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="scan-failures-${job.id}.jsonl"`);
    reply.header("Cache-Control", "private, no-store");
    runtime.logBusinessEvent("info", { 日志关键字: "codex-flycloud-music", 事件: "下载当前音乐阶段失败报告", 任务ID: job.id });
    return reply.send(Readable.from(musicFailureLines(runtime, job)));
  }
  const filePath = await runtime.failureReports.getDownloadPath(job);
  const aiSupplementTask = job.snapshot.taskPurpose === "ai_supplement_unmatched";
  const downloadFileName = `${aiSupplementTask ? "ai-supplement-failures" : "scan-failures"}-${path.basename(filePath)}`;
  reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${downloadFileName}"`);
  reply.header("Cache-Control", "private, no-store");
  runtime.logBusinessEvent("info", {
    日志关键字: aiSupplementTask ? "codex-flycloud-helper-ai-clean" : "codex-scan-failure-report",
    事件: aiSupplementTask ? "下载AI补充失败报告" : "下载扫描失败报告",
    任务ID: job.id,
    服务ID: job.serviceId,
    用户ID: job.userId,
  });
  return reply.send(fs.createReadStream(filePath));
}

/** 注册普通用户和超级管理员的任务失败报告下载接口。 */
export async function registerScanFailureReportRoutes(
  server: FastifyInstance,
  runtime: ApiRuntime,
): Promise<void> {
  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/failure-report", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    return sendFailureReport(runtime, reply, request.params.jobId, user.id);
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/failure-report", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    return sendFailureReport(runtime, reply, request.params.jobId);
  });
}
