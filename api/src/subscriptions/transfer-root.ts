import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { transferConnection } from "../resource-search/share-transfer.js";
import { getServiceTransferDirectory, getSubscriptionTransferRename, verifyServiceTransferDirectory,
  type ServiceTransferDirectory } from "../resource-search/transfer-directory.js";
import type { MovieSubscription } from "./store.js";

/** 未完成的接收目录使用固定前缀，进程中断且记录未落盘时仍能阻止整理。 */
export const subscriptionReceivingPrefix = "订阅转存中-";

/** 每次提交保存独立目录及身份快照，后续设置变化和取消订阅不改变该批次。 */
export interface SubscriptionTransferRoot {
  parent: ServiceTransferDirectory;
  directory: ServiceTransferDirectory | null;
  temporaryName: string;
  baseName: string;
  finalName: string | null;
  renameTaskId: string | null;
  replaceName: boolean;
  ready: boolean;
  identity: Pick<MovieSubscription, "title" | "year" | "mediaType" | "tmdbId">;
}

/** 只清理网盘名称非法字符，不把片名当路径。 */
function legalName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "").trim().slice(0, 140);
}

/** 仅匹配指定接收根的子树，避免相同前缀目录串片。 */
export function insideSubscriptionRoot(filePath: string, rootPath: string): boolean {
  return filePath === rootPath || filePath.startsWith(`${rootPath.replace(/\/$/u, "")}/`);
}

/** 读取原子写入的订阅状态；旧批次无根目录记录时保持历史行为。 */
export async function readSubscriptionTransferRoots(runtime: ApiRuntime, serviceId: string): Promise<SubscriptionTransferRoot[]> {
  if (!/^[0-9a-f-]{36}$/iu.test(serviceId)) throw new Error("订阅服务 ID 无效");
  try {
    const state = JSON.parse(await fs.readFile(path.join(runtime.config.exportDirectory,
      "movie-subscriptions", `${serviceId}.json`), "utf8")) as { serviceId: string; activities: Array<{ transferRoot?: SubscriptionTransferRoot }> };
    if (state.serviceId !== serviceId || !Array.isArray(state.activities)) throw new Error("订阅状态文件内容无效");
    return state.activities.flatMap((activity) => activity.transferRoot ? [activity.transferRoot] : []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 先保存目录意图再创建；提交前保存真实资源 ID，崩溃恢复不凭同名猜目录。 */
export async function prepareSubscriptionTransferRoot(runtime: ApiRuntime, serviceId: string,
  subscription: MovieSubscription, publishedTitle: string,
  save: (root: SubscriptionTransferRoot) => Promise<void>): Promise<SubscriptionTransferRoot> {
  const { service, connection, persistConnection } = await transferConnection(runtime, serviceId);
  const adapter = runtime.providers.get(service.providerType);
  const organizer = adapter.fileOrganizer!;
  const selected = await getServiceTransferDirectory(runtime.database, serviceId);
  if (!selected) throw new ApiError(422, "transfer_directory_missing", "请先在网盘服务中设置转存目录");
  const parent = await verifyServiceTransferDirectory(adapter, connection, selected, { persistConnection });
  const replaceName = await getSubscriptionTransferRename(runtime.database, serviceId);
  // 关键变量：缺少年份时补取一次详情；仍不可用则省略年份，不编造年份或丢弃已知身份。
  let year = subscription.year;
  if (replaceName && !year) {
    try {
      year = (await runtime.tmdb.readVideoMetadata(subscription.mediaType, subscription.tmdbId, "zh-CN", "CN"))?.year ?? null;
    } catch (error) {
      runtime.logBusinessEvent("warn", { 日志关键字: "codex-movie-subscription", 事件: "订阅命名年份暂不可用，省略年份",
        服务ID: serviceId, TMDB编号: subscription.tmdbId, 错误信息: error instanceof Error ? error.message : String(error) });
    }
  }
  const title = legalName(subscription.title);
  if (replaceName && !title) throw new Error("订阅片名无法生成合法目录名称");
  const root: SubscriptionTransferRoot = {
    parent, directory: null, temporaryName: `${subscriptionReceivingPrefix}${randomUUID()}`,
    baseName: replaceName ? `${title}${year ? `(${year})` : ""}{tmdbid-${subscription.tmdbId}}`
      : legalName(publishedTitle) || "订阅转存",
    finalName: null, renameTaskId: null, replaceName, ready: false,
    identity: { title: subscription.title, year, mediaType: subscription.mediaType, tmdbId: subscription.tmdbId },
  };
  await save(root);
  const created = await organizer.createDirectory(connection, parent.resourceId, root.temporaryName, { persistConnection });
  if (created.taskId) {
    // 创建失败或等待超时不会继续提交转存；临时目录保留供核实。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await organizer.taskStatus(connection, created.taskId, { persistConnection });
      if (status === "failed") throw new Error("订阅接收目录创建失败");
      if (status === "completed") break;
      if (attempt === 29) throw new Error("订阅接收目录创建结果待核实");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const listing = await adapter.browseEntries(connection, parent, undefined, { persistConnection });
  const entry = listing.items.find((item) => item.isDirectory && item.name === root.temporaryName
    && (!created.resourceId || item.resourceId === created.resourceId));
  if (!entry) throw new Error("订阅接收目录尚未同步，请核实后处理");
  root.directory = { resourceId: entry.resourceId, displayPath: entry.displayPath, driveId: parent.driveId };
  await save(root);
  return root;
}

/** 转存完成后只命名本次根目录；响应不明时先按 ID 复查，绝不重新提交转存。 */
export async function finishSubscriptionTransferRoot(runtime: ApiRuntime, serviceId: string,
  root: SubscriptionTransferRoot, save: () => Promise<void>): Promise<boolean> {
  if (root.ready) return true;
  if (!root.directory) throw new Error("订阅接收目录身份缺失，请核实后处理");
  const { service, connection, persistConnection } = await transferConnection(runtime, serviceId);
  const adapter = runtime.providers.get(service.providerType);
  const organizer = adapter.fileOrganizer!;
  if (root.renameTaskId) {
    const status = await organizer.taskStatus(connection, root.renameTaskId, { persistConnection });
    if (status === "pending" || status === "running") return false;
    root.renameTaskId = null;
    await save();
    if (status === "failed") throw new Error("订阅根目录命名失败，稍后重试");
  }
  const listing = await adapter.browseEntries(connection, root.parent, undefined, { persistConnection });
  const current = listing.items.find((item) => item.resourceId === root.directory!.resourceId && item.isDirectory);
  if (!current) throw new Error("订阅接收根目录已移动或不存在，请核实后处理");
  // 改名已生效但上次状态保存失败时，仅补记完成状态。
  if (root.finalName && current.name === root.finalName) {
    root.directory.displayPath = current.displayPath;
    root.ready = true;
    await save();
    return true;
  }
  if (current.name !== root.temporaryName) throw new Error("订阅接收根目录名称已被外部修改，请核实后处理");
  const occupied = new Set(listing.items.filter((item) => item.resourceId !== current.resourceId).map((item) => item.name));
  let name = root.finalName ?? root.baseName;
  if (occupied.has(name)) {
    name = root.baseName;
    if (occupied.has(name)) {
      let suffix = 1;
      while (occupied.has(`${root.baseName}(${suffix})`)) suffix += 1;
      name = `${root.baseName}(${suffix})`;
    }
  }
  root.finalName = name;
  await save();
  const result = await organizer.rename(connection, current.resourceId, name, { persistConnection });
  if (result.resourceId) root.directory.resourceId = result.resourceId;
  root.renameTaskId = result.taskId ?? null;
  await save();
  // 即使接口同步返回，也在下一轮按资源 ID 核实真实名称，再开放整理。
  return false;
}
