import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ProviderAdapter, ProviderBrowseEntry, ProviderConnectionContext, ProviderFileOrganizer, ScanRoot } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import type { CatalogMovieFile, ExistingVideoFile, MovieFileCheckResult } from "../service-repository.js";

// 同一进程内对同一影片串行执行检测和删除，避免确认窗口重复提交远端写操作。
const activeMovieOperations = new Set<string>();

/** 只认文件接口的明确缺失结果，授权失败、限流和异常响应保留原记录。 */
function isFileMissing(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === "provider_file_not_found" || error.code === "provider_resource_not_found"
    || ["文件已删除", "文件不存在"].includes(error.message.trim());
}

/** 列表请求报告目录不存在时，继续按文件定位单独确认。 */
function isDirectoryMissing(error: unknown): boolean {
  return isFileMissing(error) || (error instanceof ApiError && error.message.trim() === "目录不存在");
}

/** 检查原文件定位，支持稳定资源 ID 的网盘可识别已移到其他目录的文件。 */
async function checkFile(adapter: ProviderAdapter, connection: Record<string, unknown>, file: ExistingVideoFile,
  signal: AbortSignal, context: ProviderConnectionContext): Promise<boolean> {
  try {
    if (adapter.checkFileExists) return await adapter.checkFileExists(connection, file.locator, signal, context);
    if (!adapter.resolveFileAccess) throw new ApiError(502, "provider_file_check_unsupported", "当前网盘无法核对文件状态");
    await adapter.resolveFileAccess(connection, file.locator, signal, context);
    return true;
  } catch (error) {
    signal.throwIfAborted();
    if (isFileMissing(error)) return false;
    throw error;
  }
}

/** 按盘、原父目录和目录路径分组，同一目录只需要一次完整列表。 */
function groupVideoFilesByDirectory<File extends ExistingVideoFile>(files: File[], webdav: boolean) {
  const byDirectory = new Map<string, { parent: ScanRoot; files: File[] }>();
  for (const file of files) {
    const parentPath = path.posix.dirname(file.path);
    const driveId = typeof file.locator.driveId === "string" ? file.locator.driveId : undefined;
    const parentId = webdav ? parentPath : file.parentResourceId ?? undefined;
    const key = JSON.stringify([driveId, parentId, parentPath]);
    const group = byDirectory.get(key) ?? { parent: { resourceId: parentId, displayPath: parentPath, driveId }, files: [] };
    group.files.push(file);
    byDirectory.set(key, group);
  }
  return byDirectory.values();
}

/** 先读取已入库文件所在目录，目录里没看到的文件再向 Provider 单独核对。 */
export async function checkExistingVideoFiles(input: {
  adapter: ProviderAdapter;
  connection: Record<string, unknown>;
  files: ExistingVideoFile[];
  signal: AbortSignal;
  context: ProviderConnectionContext;
  beforeDirectory: () => Promise<boolean>;
  onResult: (parentPath: string, fileCount: number, missing: ExistingVideoFile[], errorCount: number, error?: unknown) => Promise<void>;
}): Promise<void> {
  const { adapter, connection, files, signal, context } = input;
  const webdav = adapter.descriptor.type === "webdav";
  for (const group of groupVideoFilesByDirectory(files, webdav)) {
    if (!(await input.beforeDirectory())) return;
    signal.throwIfAborted();
    const parentPath = group.parent.displayPath ?? "/";
    let entries: ProviderBrowseEntry[] = [];
    if (group.parent.resourceId) {
      try {
        entries = (await adapter.browseEntries(connection, group.parent, signal, context)).items;
      } catch (error) {
        signal.throwIfAborted();
        // 原目录已移除时仍核对每个文件的稳定 ID，区分文件迁移和删除。
        if (!isDirectoryMissing(error)) {
          await input.onResult(parentPath, group.files.length, [], group.files.length, error);
          continue;
        }
      }
    }
    const present = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => webdav ? entry.displayPath : entry.resourceId));
    const missing: ExistingVideoFile[] = [];
    let errorCount = 0;
    let firstError: unknown;
    for (const file of group.files) {
      signal.throwIfAborted();
      if (present.has(webdav ? file.path : file.providerResourceId)) continue;
      try {
        if (!(await checkFile(adapter, connection, file, signal, context))) missing.push(file);
      } catch (error) {
        signal.throwIfAborted();
        errorCount += 1;
        firstError ??= error;
      }
    }
    await input.onResult(parentPath, group.files.length, missing, errorCount, firstError);
  }
}

/** 文件 ID 之外还要匹配入库时记录的文件属性，避免删除同路径的其他文件。 */
function matchesOriginalVideoFile(file: CatalogMovieFile, current: ProviderBrowseEntry): boolean {
  return !current.isDirectory && current.displayPath === file.path && current.name === file.name
    && current.size === file.size && (file.modifiedAt === null || current.modifiedAt === file.modifiedAt);
}

/** 网盘异步任务成功后才确认，超时或失败由调用方重新核对文件。 */
async function waitForFileDeletion(organizer: ProviderFileOrganizer, connection: Record<string, unknown>,
  taskId: string | undefined, signal: AbortSignal, context: ProviderConnectionContext): Promise<boolean> {
  if (!taskId) return true;
  while (!signal.aborted) {
    const status = await organizer.taskStatus(connection, taskId, context);
    if (status === "completed") return true;
    if (status === "failed") return false;
    await delay(500, undefined, { signal });
  }
  return false;
}

/** 只删除仍与入库身份一致的单个原文件，异步网盘操作完成后才确认成功。 */
async function removeMovieFile(adapter: ProviderAdapter, connection: Record<string, unknown>, file: CatalogMovieFile,
  signal: AbortSignal, context: ProviderConnectionContext): Promise<void> {
  const organizer = adapter.fileOrganizer;
  if (!organizer?.supports(connection)) {
    throw new ApiError(422, "movie_file_delete_unsupported", "当前网盘或登录方式不支持删除原文件");
  }
  const parentPath = path.posix.dirname(file.path);
  const webdav = adapter.descriptor.type === "webdav";
  const parent: ScanRoot = { resourceId: webdav ? parentPath : file.parentResourceId ?? undefined, displayPath: parentPath,
    driveId: typeof file.locator.driveId === "string" ? file.locator.driveId : undefined };
  let entries: ProviderBrowseEntry[] = [];
  try {
    entries = (await adapter.browseEntries(connection, parent, signal, context)).items;
  } catch (error) {
    if (!isDirectoryMissing(error)) throw error;
  }
  const current = entries.find((entry) => webdav ? entry.displayPath === file.path : entry.resourceId === file.providerResourceId);
  if (!current && !(await checkFile(adapter, connection, file, signal, context))) return;
  if (!current || !matchesOriginalVideoFile(file, current)) {
    throw new ApiError(409, "movie_file_changed", "网盘原文件已变化，请重新扫描后再删除");
  }
  try {
    signal.throwIfAborted();
    const { taskId } = await organizer.remove(connection, current.resourceId, context);
    if (await waitForFileDeletion(organizer, connection, taskId, signal, context)) return;
  } catch (error) {
    if (isFileMissing(error)) return;
  }
  if (!signal.aborted && !(await checkFile(adapter, connection, file, signal, context))) return;
  throw new ApiError(503, "movie_file_delete_unconfirmed", "网盘删除未能确认，请稍后重新检测");
}

/** 光鸭支持同目录批量删除文件 ID，每批重新浏览目录核对文件身份和删除结果。 */
async function removeGuangyaSeriesFiles(input: {
  adapter: ProviderAdapter;
  organizer: ProviderFileOrganizer;
  connection: Record<string, unknown>;
  files: CatalogMovieFile[];
  signal: AbortSignal;
  context: ProviderConnectionContext;
  onResult: (fileCount: number, removed: CatalogMovieFile[], issue?: string) => void;
}): Promise<void> {
  const { adapter, organizer, connection, files, signal, context } = input;
  for (const group of groupVideoFilesByDirectory(files, false)) {
    for (let offset = 0; offset < group.files.length; offset += 50) {
      signal.throwIfAborted();
      const batch = group.files.slice(offset, offset + 50);
      let entries: ProviderBrowseEntry[] = [];
      try {
        entries = (await adapter.browseEntries(connection, group.parent, signal, context)).items;
      } catch (error) {
        if (!isDirectoryMissing(error)) {
          input.onResult(batch.length, [], error instanceof ApiError ? error.message : "读取网盘目录失败");
          continue;
        }
      }
      // 只提交当前目录里身份相符的原文件，已移动或变化的文件继续保留。
      const present = new Map(entries.map((entry) => [entry.resourceId, entry]));
      const pending = batch.filter((file) => {
        const current = present.get(file.providerResourceId);
        return current && matchesOriginalVideoFile(file, current);
      });
      const removed: CatalogMovieFile[] = [];
      let issue: string | undefined;
      if (pending.length > 0) {
        let completed = false;
        try {
          signal.throwIfAborted();
          const ids = pending.map((file) => file.providerResourceId);
          const { taskId } = await organizer.removeMany!(connection, ids, context);
          completed = await waitForFileDeletion(organizer, connection, taskId, signal, context);
        } catch (error) {
          issue = error instanceof ApiError ? error.message : "网盘批量删除未能确认";
        }
        if (completed && !signal.aborted) {
          // 批量任务成功后，仍逐个 ID 对照删除后的目录结果。
          try {
            const listing = await adapter.browseEntries(connection, group.parent, signal, context);
            const remaining = new Set(listing.items.map((entry) => entry.resourceId));
            removed.push(...pending.filter((file) => !remaining.has(file.providerResourceId)));
          } catch {
            issue ??= "删除后的目录状态未能确认";
          }
        }
      }
      for (const file of batch) {
        if (signal.aborted || present.has(file.providerResourceId)) continue;
        try {
          if (!await checkFile(adapter, connection, file, signal, context)) removed.push(file);
        } catch (error) {
          issue ??= error instanceof ApiError ? error.message : "网盘文件状态未能确认";
        }
      }
      if (removed.length < batch.length) issue ??= "部分网盘文件已变化或删除结果未能确认";
      input.onResult(batch.length, removed, issue);
    }
  }
}

type MovieFileOperation = "check" | "catalog_only" | "with_files";

interface MovieFileOperationResult {
  item: MediaItemRecord | null;
  fileCount: number;
  removedFileIds: string[];
  unconfirmedCount: number;
  issue: string | null;
}

/** 按影片限制并行操作，未确认的网盘版本继续保留。 */
export async function updateCatalogMovieFiles(runtime: ApiRuntime, item: MediaItemRecord,
  operation: MovieFileOperation = "check"): Promise<MovieFileOperationResult> {
  if (!isMovieOrSeries(item) || (item.libraryKind !== "legacy_single_source" && item.libraryKind !== "cloud_aggregate_video")) {
    throw new ApiError(422, "movie_file_operation_not_supported", "此操作仅支持网盘媒体库中的电影和剧集");
  }
  if (activeMovieOperations.has(item.id)) throw new ApiError(409, "movie_file_operation_active", "影片文件正在处理，请稍后重试");
  activeMovieOperations.add(item.id);
  try {
    return await runCatalogMovieFileOperation(runtime, item, operation);
  } finally {
    activeMovieOperations.delete(item.id);
  }
}

/** 确认当前条目属于有文件的影视详情类型。 */
function isMovieOrSeries(item: MediaItemRecord): boolean {
  return item.itemType === "video.movie" || item.itemType === "video.series";
}

/** 读取当前电影或剧集的来源，核对或删除原文件后提交目录结果。 */
async function runCatalogMovieFileOperation(runtime: ApiRuntime, item: MediaItemRecord,
  operation: MovieFileOperation): Promise<MovieFileOperationResult> {
  if (operation === "catalog_only") {
    await runtime.repository.applyMovieFileCheck(item, [], operation);
    const [remaining] = await runtime.repository.listCatalogItemsByIds([item.id], item.userId);
    return { item: remaining ?? null, fileCount: 0, removedFileIds: [], unconfirmedCount: 0, issue: null };
  }
  const files = await runtime.repository.listMovieFilesForCheck(item, operation);
  // 聚合库的每个版本必须用自己的网盘来源和凭据查询。
  const bySource = new Map<string, CatalogMovieFile[]>();
  for (const file of files) {
    const sourceFiles = bySource.get(file.librarySourceId) ?? [];
    sourceFiles.push(file);
    bySource.set(file.librarySourceId, sourceFiles);
  }
  const results: MovieFileCheckResult[] = [];
  let unconfirmedCount = 0;
  let issue: string | null = null;
  // 剧集通常跨多个目录，保留更长的核对时间；超时保留所有未确认的版本。
  const signal = AbortSignal.timeout(item.itemType === "video.series" ? 45_000 : 20_000);
  for (const [librarySourceId, sourceFiles] of bySource) {
    let processedCount = 0;
    try {
      signal.throwIfAborted();
      const configuration = await runtime.repository.getLibrarySourceRuntimeConfiguration(librarySourceId, item.userId);
      const source = configuration.source;
      if (source.libraryId !== item.libraryId || source.connectionStatus !== "valid"
        || (source.serviceStatus !== null && source.serviceStatus !== "active" && source.serviceStatus !== "scanning")) {
        unconfirmedCount += sourceFiles.length;
        issue ??= "网盘来源当前不可用";
        continue;
      }
      const result: MovieFileCheckResult = {
        librarySourceId, serviceId: source.sourceMode === "linked_service" ? source.serviceId : null,
        credentialRevision: configuration.credentialRevision, files: [],
      };
      results.push(result);
      const adapter = runtime.providers.get(configuration.providerType);
      const connection = runtime.vault.decrypt(configuration.encryptedConnection);
      const context: ProviderConnectionContext = { persistConnection: async (nextConnection) => {
        await runtime.repository.refreshLibrarySourceEncryptedConnection({
          librarySourceId, userId: item.userId, credentialRevision: configuration.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
      } };
      if (operation === "with_files") {
        const organizer = adapter.fileOrganizer;
        if (item.itemType === "video.series" && adapter.descriptor.type === "guangya"
          && organizer?.removeMany && organizer.supports(connection)) {
          await removeGuangyaSeriesFiles({ adapter, organizer, connection, files: sourceFiles, signal, context,
            onResult: (count, removed, reason) => {
              processedCount += count;
              unconfirmedCount += count - removed.length;
              result.files.push(...removed);
              issue ??= reason ?? null;
            } });
          continue;
        }
        for (const file of sourceFiles) {
          signal.throwIfAborted();
          try {
            await removeMovieFile(adapter, connection, file, signal, context);
            result.files.push(file);
          } catch (error) {
            unconfirmedCount += 1;
            issue ??= error instanceof ApiError ? error.message : "网盘文件删除未能确认";
          }
          processedCount += 1;
        }
        continue;
      }
      await checkExistingVideoFiles({
        adapter, connection, files: sourceFiles, signal, context,
        beforeDirectory: async () => true,
        onResult: async (_directory, fileCount, missing, unavailable) => {
          processedCount += fileCount;
          unconfirmedCount += unavailable;
          for (const file of missing) result.files.push(file);
        },
      });
    } catch (error) {
      unconfirmedCount += sourceFiles.length - processedCount;
      issue ??= error instanceof ApiError ? error.message : "网盘文件操作未能确认";
    }
  }

  const confirmedMissing = results.filter((result) => result.files.length > 0);
  const missingCount = confirmedMissing.reduce((count, result) => count + result.files.length, 0);
  const removedFileIds = missingCount > 0 || files.length === 0
    ? await runtime.repository.applyMovieFileCheck(item, confirmedMissing, operation) : [];
  const [updatedItem] = await runtime.repository.listCatalogItemsByIds([item.id], item.userId);
  return { item: updatedItem ?? null, fileCount: files.length, removedFileIds,
    unconfirmedCount: unconfirmedCount + missingCount - removedFileIds.length, issue };
}
