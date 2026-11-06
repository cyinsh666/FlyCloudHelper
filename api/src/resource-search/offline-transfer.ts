import { ApiError, validationError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { parseMagnetUrl } from "./magnet.js";
import { transferConnection } from "./share-transfer.js";
import { getServiceTransferDirectory, verifyServiceTransferDirectory } from "./transfer-directory.js";

export interface OfflineTransferSubmission { taskId: string; fileCount: number }
export interface OfflineTransferProgress { status: "pending" | "running" | "completed" | "partial" | "failed"; progress: number }

/** 使用已登录的光鸭服务，将磁力提交到该服务单独配置的转存目录。 */
export async function submitGuangyaOfflineTransfer(runtime: ApiRuntime, input: {
  serviceId: string; magnetUrl: string; actorUserId: string; ownerId?: string;
}): Promise<OfflineTransferSubmission> {
  const magnet = parseMagnetUrl(input.magnetUrl);
  if (!magnet) throw validationError("magnetUrl", "请输入有效的磁力链接");
  const { service, connection, persistConnection } = await transferConnection(runtime, input.serviceId, input.ownerId);
  if (service.providerType !== "guangya") throw new ApiError(422, "offline_provider_invalid", "磁力离线只支持光鸭服务");
  const configured = await getServiceTransferDirectory(runtime.database, service.id);
  if (!configured) throw new ApiError(422, "transfer_directory_missing", "请先在光鸭服务中设置转存目录");
  const directory = await verifyServiceTransferDirectory(runtime.providers.get("guangya"),
    connection, configured, { persistConnection });
  const client = runtime.providers.guangyaWebClient;
  const resolved = await client.mutateFile(connection, "/cloudcollection/v1/resolve_res",
    { url: magnet.url }, persistConnection);
  const btInfo = resolved.btResInfo && typeof resolved.btResInfo === "object"
    ? resolved.btResInfo as Record<string, unknown> : {};
  const suggestedName = typeof btInfo.fileName === "string" ? btInfo.fileName.trim() : "";
  const taskUrl = typeof resolved.url === "string" && resolved.url.trim() ? resolved.url.trim() : magnet.url;
  // 关键变量：不传 fileIndexes 时由光鸭选择整个磁力资源，视频和附属文件保持原有结构。
  const submitted = await client.mutateFile(connection, "/cloudcollection/v1/create_task",
    { url: taskUrl, parentId: directory.resourceId === "root" ? "" : directory.resourceId,
      newName: suggestedName.slice(0, 255) || "offline" },
    persistConnection);
  const taskId = String(submitted.taskId ?? "");
  if (!taskId) throw new ApiError(503, "offline_task_missing", "离线任务已提交，但未收到任务编号；请检查光鸭任务列表");
  runtime.logBusinessEvent("info", { 日志关键字: "codex-guangya-offline", 事件: "提交磁力离线任务",
    用户ID: input.actorUserId, 服务ID: service.id, 转存目录ID: directory.resourceId, 任务ID: taskId });
  return { taskId, fileCount: 1 };
}

/** 查询光鸭云添加任务；任务编号只传给固定的光鸭接口。 */
export async function readGuangyaOfflineTransfer(runtime: ApiRuntime, serviceId: string, taskId: string,
  ownerId?: string): Promise<OfflineTransferProgress> {
  if (!/^[0-9A-Za-z_-]{1,128}$/u.test(taskId)) throw validationError("taskId", "离线任务编号无效");
  const { service, connection, persistConnection } = await transferConnection(runtime, serviceId, ownerId);
  if (service.providerType !== "guangya") throw new ApiError(422, "offline_provider_invalid", "磁力离线只支持光鸭服务");
  const data = await runtime.providers.guangyaWebClient.mutateFile(connection, "/cloudcollection/v1/list_task",
    { taskIds: [taskId] }, persistConnection);
  const list = Array.isArray(data.list) ? data.list as Array<Record<string, unknown>> : [];
  const task = list.find((item) => String(item.taskId ?? "") === taskId);
  if (!task) throw new ApiError(404, "offline_task_not_found", "光鸭中未找到该离线任务");
  const code = Number(task.status);
  const status = code === 2 ? "completed" : code === 5 ? "partial" : code === 3 || code === 4 ? "failed"
    : code === 0 ? "pending" : "running";
  const progress = Number(task.progress);
  return { status, progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0 };
}
