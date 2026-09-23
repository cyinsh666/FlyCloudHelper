import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";

/** Emby/Jellyfin 协议触发扫描时需要的账号和服务范围。 */
export interface ProtocolScanContext {
  serviceId: string;
  libraryId: string;
  ownerUserId: string;
  accountId: string;
}

/** APP 读取媒体库物理路径时需要的最小虚拟目录结构。 */
interface ProtocolLibraryItem {
  Id?: unknown;
  Name?: unknown;
  CollectionType?: unknown;
  PrimaryImageItemId?: unknown;
  PrimaryImageTag?: unknown;
}

/** 从全量、增量和旧版 roots 配置中读取去重后的显示路径。 */
function readConfiguredScanPaths(profile: Record<string, unknown>): string[] {
  const candidates = [profile.fullRoots, profile.incrementalRoots, profile.roots];
  const paths = new Set<string>();
  candidates.forEach((candidate) => {
    if (!Array.isArray(candidate)) return;
    candidate.forEach((root) => {
      if (!root || typeof root !== "object") return;
      const path = String((root as Record<string, unknown>).displayPath ?? "").trim();
      if (path) paths.add(path);
    });
  });
  return [...paths];
}

/** 返回 Flymby 扫描入口使用的 VirtualFolderInfo 数组。 */
export async function listProtocolVirtualFolders(
  runtime: ApiRuntime,
  context: ProtocolScanContext,
  libraries: ProtocolLibraryItem[],
): Promise<Array<Record<string, unknown>>> {
  const service = await runtime.repository.getLibraryMediaContext(context.libraryId, context.ownerUserId);
  const paths = readConfiguredScanPaths(service.scanProfile);
  return libraries.map((library) => ({
    Name: String(library.Name ?? "媒体库"),
    Id: String(library.Id ?? ""),
    ItemId: String(library.Id ?? ""),
    CollectionType: String(library.CollectionType ?? ""),
    Locations: paths,
    LibraryOptions: {
      PathInfos: paths.map((path) => ({ Path: path })),
      ContentType: String(library.CollectionType ?? ""),
      EnableRealtimeMonitor: false,
    },
    PrimaryImageItemId: library.PrimaryImageItemId,
    PrimaryImageTag: library.PrimaryImageTag,
  }));
}

/** 由 Emby/Jellyfin 协议创建一次增量扫描任务。 */
export async function enqueueProtocolScan(
  runtime: ApiRuntime,
  context: ProtocolScanContext,
  protocol: "emby" | "jellyfin",
  trigger: string,
  itemId?: string,
): Promise<void> {
  const service = await runtime.repository.getLibraryMediaContext(context.libraryId, context.ownerUserId);
  const unfinishedJob = await runtime.repository.findUnfinishedLibraryScanJob(context.libraryId, context.ownerUserId);
  if (service.status === "scanning" || unfinishedJob) throw new ApiError(409, "scan_job_conflict", "当前服务正在扫描或已有未结束任务");
  const incrementalRoots = Array.isArray(service.scanProfile.incrementalRoots)
    ? service.scanProfile.incrementalRoots
    : Array.isArray(service.scanProfile.roots) ? service.scanProfile.roots : [];
  if (incrementalRoots.length === 0) throw new ApiError(409, "scan_paths_not_configured", "请先配置增量扫描路径");
  // 关键变量：协议扫描使用独立请求 ID，设备 ID 固定到协议账号，便于任务审计和幂等排查。
  const requestId = randomUUID();
  const job = await runtime.repository.createScanJob({
    jobId: randomUUID(),
    userId: context.ownerUserId,
    libraryId: service.libraryId,
    requestedByUserId: context.ownerUserId,
    requestId,
    clientDeviceId: `protocol:${protocol}:${context.accountId}`,
    scanMode: "incremental",
    runtimeRevision: "scanner-worker-v1",
    tmdbKeyPoolRevision: runtime.tmdb.revision,
    aiModel: await runtime.aiModels.buildTaskSnapshot(service.metadataProfile),
    pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-protocol-scan",
    事件: "协议接口创建增量扫描任务",
    协议: protocol,
    触发接口: trigger,
    服务ID: context.serviceId,
    媒体库ID: context.libraryId,
    账号ID: context.accountId,
    媒体条目ID: itemId ?? null,
    任务ID: job.id,
  });
}
