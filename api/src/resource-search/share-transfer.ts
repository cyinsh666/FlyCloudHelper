import { ApiError, validationError } from "../errors.js";
import type { QuarkProvider } from "../providers/quark.js";
import type { ApiRuntime } from "../runtime.js";
import { parseGuangyaShareUrl, parseQuarkShareUrl } from "./engine.js";
import { getServiceTransferDirectory, verifyServiceTransferDirectory } from "./transfer-directory.js";

/** 手动转存与订阅转存共用的提交结果。 */
export interface ShareTransferSubmission { taskId: string; fileCount: number; providerType: "guangya" | "quark" }
export type ShareTransferStatus = "pending" | "running" | "completed" | "failed";

/** 加载目标服务的有效凭据；自动任务也只允许光鸭和夸克网页登录。 */
async function transferConnection(runtime: ApiRuntime, serviceId: string, ownerId?: string) {
  const service = await runtime.repository.getServiceDetail(serviceId, ownerId);
  if (service.providerType !== "guangya" && service.providerType !== "quark") {
    throw new ApiError(422, "search_transfer_provider_invalid", "当前只支持光鸭和夸克分享转存");
  }
  if (service.status !== "active" || service.connectionStatus !== "valid") {
    throw new ApiError(409, "search_transfer_service_unavailable", "网盘服务当前不可用");
  }
  const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
  if (!runtime.providers.get(service.providerType).fileOrganizer?.supports(connection)) {
    throw new ApiError(422, "search_transfer_auth_unsupported", "当前网盘登录方式不支持转存");
  }
  /** Provider 更新登录凭据时回写原服务，后续请求继续使用最新凭据。 */
  const persistConnection = async (nextConnection: Record<string, unknown>): Promise<void> => {
    await runtime.repository.refreshActiveEncryptedConnection({
      serviceId: service.id, userId: service.userId, credentialRevision: service.credentialRevision,
      encryptedConnection: runtime.vault.encrypt(nextConnection),
    });
  };
  return { service, connection, persistConnection };
}

/** 提交一条分享链接，目标始终是服务独立配置的转存目录。 */
export async function submitShareTransfer(runtime: ApiRuntime, input: {
  serviceId: string; shareUrl: string; password: string; actorUserId: string; ownerId?: string;
}): Promise<ShareTransferSubmission> {
  const guangyaShare = parseGuangyaShareUrl(input.shareUrl);
  const quarkShare = parseQuarkShareUrl(input.shareUrl);
  if (!guangyaShare && !quarkShare) throw validationError("shareUrl", "请输入有效的光鸭或夸克分享链接");
  if (input.password.length > 32) throw validationError("password", "提取码过长");
  const { service, connection, persistConnection } = await transferConnection(runtime, input.serviceId, input.ownerId);
  if ((service.providerType === "guangya" && !guangyaShare) || (service.providerType === "quark" && !quarkShare)) {
    throw new ApiError(422, "search_transfer_provider_mismatch", "分享链接与目标网盘服务类型不一致");
  }
  const configuredDirectory = await getServiceTransferDirectory(runtime.database, service.id);
  if (!configuredDirectory) throw new ApiError(422, "transfer_directory_missing", "请先在网盘服务中设置转存目录");
  const directory = await verifyServiceTransferDirectory(runtime.providers.get(service.providerType),
    connection, configuredDirectory, { persistConnection });
  if (quarkShare) {
    const provider = runtime.providers.get("quark") as QuarkProvider;
    const context = { persistConnection };
    const token = await provider.getShareToken(connection, quarkShare.shareId, input.password || quarkShare.code, context);
    const entries = await provider.listShareRoot(connection, quarkShare.shareId, token, context);
    if (!entries.length) throw new ApiError(422, "search_share_empty", "分享中没有可转存文件");
    // 关键变量：提交一旦发出，网络异常时不能再次提交，避免重复转存。
    const taskId = await provider.saveShareRoot(connection, quarkShare.shareId, token, entries, directory.resourceId, context);
    runtime.logBusinessEvent("info", { 日志关键字: "codex-resource-search-transfer", 事件: "提交夸克分享转存",
      用户ID: input.actorUserId, 服务ID: service.id, 转存目录ID: directory.resourceId, 文件数量: entries.length, 任务ID: taskId });
    return { taskId, fileCount: entries.length, providerType: "quark" };
  }
  if (!guangyaShare) throw validationError("shareUrl", "请输入有效的光鸭分享链接");
  const client = runtime.providers.guangyaWebClient;
  const tokenData = await client.mutateFile(connection, "/userres/v1/get_share_access_token",
    { shareId: guangyaShare.shareId, code: input.password || guangyaShare.code }, persistConnection);
  const accessToken = typeof tokenData.accessToken === "string" ? tokenData.accessToken : "";
  if (!accessToken) throw new ApiError(422, "search_share_unavailable", "分享链接无效或提取码错误");
  const fileIds: string[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 50; page += 1) {
    // 关键变量：光鸭分享列表的 cursor 必须保持数字类型，按响应值继续翻页。
    const payload: Record<string, unknown> = { pageSize: 100, accessToken, orderBy: 0, sortType: 0, parentId: "" };
    if (cursor !== undefined) payload.cursor = cursor;
    const data = await client.mutateFile(connection, "/userres/v1/get_share_page_files_list", payload, persistConnection);
    const list = Array.isArray(data.list) ? data.list as Array<Record<string, unknown>> : [];
    for (const item of list) if (typeof item.fileId === "string" && item.fileId) fileIds.push(item.fileId);
    const next = Number(data.cursor);
    if (list.length === 0 || !Number.isFinite(next) || next <= 0 || next === cursor || data.hasMore === false) break;
    if (page === 49) throw new ApiError(422, "search_share_too_large", "分享目录过大，无法完整读取");
    cursor = next;
  }
  if (!fileIds.length) throw new ApiError(422, "search_share_empty", "分享中没有可转存文件");
  // 发送后可能已到达光鸭，结果不明时由任务记录标记待核实，不自动重试。
  const submitted = await client.mutateFile(connection, "/userres/v1/restore_share",
    { accessToken, fileIds, parentId: directory.resourceId }, persistConnection);
  const taskId = String(submitted.taskId ?? "");
  if (!taskId) throw new ApiError(503, "search_transfer_task_missing", "转存已提交，但未收到任务编号；请检查目标目录");
  runtime.logBusinessEvent("info", { 日志关键字: "codex-resource-search-transfer", 事件: "提交光鸭分享转存",
    用户ID: input.actorUserId, 服务ID: service.id, 转存目录ID: directory.resourceId, 文件数量: fileIds.length, 任务ID: taskId });
  return { taskId, fileCount: fileIds.length, providerType: "guangya" };
}

/** 查询已提交任务的远端状态，不再次提交分享链接。 */
export async function readShareTransferStatus(runtime: ApiRuntime, serviceId: string, taskId: string,
  ownerId?: string): Promise<ShareTransferStatus> {
  if (!/^[0-9A-Za-z_-]{1,128}$/u.test(taskId)) throw validationError("taskId", "转存任务参数无效");
  const { service, connection, persistConnection } = await transferConnection(runtime, serviceId, ownerId);
  if (service.providerType === "quark") {
    const provider = runtime.providers.get("quark") as QuarkProvider;
    return provider.shareTransferTaskStatus(connection, taskId, { persistConnection });
  }
  if (!/^\d+$/u.test(taskId)) throw validationError("taskId", "光鸭转存任务参数无效");
  const data = await runtime.providers.guangyaWebClient.mutateFile(connection, "/userres/v1/get_task_status",
    { taskId }, persistConnection);
  const status = Number(data.status ?? -1);
  return status === 2 ? "completed" : status === 3 ? "failed" : status === 0 ? "pending" : "running";
}
