import { loadEnumerationPage } from "./types.js";
import type {
  ProviderAdapter, ProviderConnectionContext, ProviderDescriptor, ProviderDirectoryListing,
  ProviderEntry, ProviderEnumerationOptions, ProviderEnumerationWarning, ProviderFileAccess,
  ProviderFileStreamAccess, ProviderValidationResult, ScanRoot,
} from "./types.js";

/** 各网盘目录接口解析后的统一条目，只在 Provider 内部流转。 */
export interface CloudDriveItem {
  id: string;
  parentId: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  locator: Record<string, unknown>;
}

/** 单页目录结果。 */
export interface CloudDrivePage {
  items: CloudDriveItem[];
  hasMore: boolean;
  /** 游标分页由调用方独立持有，避免同目录并发请求互相覆盖。 */
  nextPageToken?: string;
}

/** 只读网盘共用目录浏览、枚举与文件访问编排，协议差异留给子类。 */
export abstract class CloudDriveProviderBase implements ProviderAdapter {
  public abstract readonly descriptor: ProviderDescriptor;
  protected abstract readonly rootResourceId: string;

  /** 验证账号并返回不含凭据的展示名称。 */
  protected abstract loadAccountLabel(
    connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext,
  ): Promise<string | null>;

  /** 读取指定目录的一页内容。 */
  protected abstract listPage(
    connection: Record<string, unknown>, parentId: string, page: number, signal?: AbortSignal,
    context?: ProviderConnectionContext,
    pageToken?: string,
  ): Promise<CloudDrivePage>;

  /** 把文件定位信息换成短期下载结果。 */
  protected abstract loadFileAccess(
    connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess>;

  /** 用账号接口和根目录首屏共同验证连接。 */
  public async validateConnection(connection: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderValidationResult> {
    const accountLabel = await this.loadAccountLabel(connection, signal, context);
    await this.listPage(connection, this.rootResourceId, 1, signal, context);
    return { valid: true, accountLabel, rootAccessible: true };
  }

  /** 校验每个配置根都能读取。 */
  public async validateRoots(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal, context?: ProviderConnectionContext): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: this.rootResourceId }];
    for (const root of selectedRoots) await this.listPage(connection, root.resourceId || this.rootResourceId, 1, signal, context);
  }

  /** 返回当前目录及全部直接子目录。 */
  public async browseDirectories(connection: Record<string, unknown>, parent?: ScanRoot, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderDirectoryListing> {
    const parentId = parent?.resourceId || this.rootResourceId;
    const parentPath = parent?.displayPath || "/";
    const items: ProviderDirectoryListing["items"] = [];
    let pageNumber = 1;
    let hasMore = false;
    let pageToken = "";
    do {
      const page = await this.listPage(connection, parentId, pageNumber, signal, context, pageToken);
      pageToken = page.nextPageToken ?? "";
      page.items.filter((item) => item.isDirectory).forEach((item) => items.push({
        name: item.name, resourceId: item.id,
        displayPath: `${parentPath.replace(/\/$/u, "")}/${item.name}`,
      }));
      hasMore = page.hasMore;
      pageNumber += 1;
    } while (hasMore);
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: { name: parentPath === "/" ? "/" : parentPath.split("/").filter(Boolean).pop() || "/", resourceId: parentId, displayPath: parentPath },
      items,
    };
  }

  /** 广度优先递归枚举文件，资源 ID 始终保留为字符串。 */
  public async *enumerate(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal, _onWarning?: (warning: ProviderEnumerationWarning) => void, options?: ProviderEnumerationOptions): AsyncGenerator<ProviderEntry> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: this.rootResourceId, displayPath: "/" }];
    for (let rootIndex = 0; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      await options?.onRootStart?.({ rootIndex, root, warningCount: 0 });
      const queue: Array<{ id: string; path: string }> = [{ id: root.resourceId || this.rootResourceId, path: root.displayPath || "/" }];
      const visited = new Set<string>();
      const concurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        signal?.throwIfAborted();
        const batch = queue.splice(0, concurrency).filter((directory) => !visited.has(directory.id));
        batch.forEach((directory) => visited.add(directory.id));
        // 目录并行、目录内分页串行，保证游标及同目录旁挂集合完整。
        const results = await Promise.all(batch.map(async (directory) => {
          let pageNumber = 1;
          let pageToken = "";
          const items: CloudDriveItem[] = [];
          let hasMore = false;
          do {
            signal?.throwIfAborted();
            const page = await loadEnumerationPage(options, directory.path, `${directory.id}:${pageNumber}:${pageToken}`, () =>
              this.listPage(connection, directory.id, pageNumber, signal, { persistConnection: options?.persistConnection }, pageToken));
            pageToken = page.nextPageToken ?? "";
            items.push(...page.items);
            hasMore = page.hasMore;
            pageNumber += 1;
          } while (hasMore);
          return { directory, items };
        }));
        for (const { directory, items } of results) {
          const siblingDirectoryNames = items.filter((item) => item.isDirectory).map((item) => item.name);
          for (const item of items) {
            const path = `${directory.path.replace(/\/$/u, "")}/${item.name}`;
            if (item.isDirectory) queue.push({ id: item.id, path });
            else yield { siblingDirectoryNames, resourceId: item.id, parentResourceId: item.parentId || directory.id,
              path, name: item.name, isDirectory: false, size: item.size, modifiedAt: item.modifiedAt, etag: item.etag, locator: item.locator };
          }
          await options?.onDirectoryComplete?.(directory.path);
        }
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: 0 });
    }
  }

  /** 解析浏览器可使用的下载地址。 */
  public resolveFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileAccess> {
    return this.loadFileAccess(connection, locator, signal, context);
  }

  /** 服务端中转复用同一下载结果与必要请求头。 */
  public async resolveFileStreamAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal, context?: ProviderConnectionContext): Promise<ProviderFileStreamAccess> {
    return this.loadFileAccess(connection, locator, signal, context);
  }
}
