import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ServiceRepository } from "../service-repository.js";
import { persistCmsContent } from "./catalog.js";
import { contentKey } from "./cms-adapter.js";
import type { ContentSourceCategory, ContentSourceManifest, VideoSourceAdapter } from "./types.js";

/** 已完成用户、媒体库和插件校验的单部 CMS 或 Python 内容定位。 */
export interface ContentItemDetailContext {
  libraryId: string;
  userId: string;
  itemId: string;
  instanceId: string;
  remoteItemId: string;
  manifest: ContentSourceManifest;
  categories: ContentSourceCategory[];
  adapter: VideoSourceAdapter;
}

interface DetailRequest {
  libraryId: string;
  instanceId: string;
  controller: AbortController;
  promise: Promise<void>;
}

/** 单部详情按需补齐；不同协议和分集共用同一部影片的在途请求。 */
export class ContentItemDetailLoader {
  private readonly requests = new Map<string, DetailRequest>();
  private readonly pausedLibraries = new Set<string>();
  private closing = false;
  // 关键变量：节目详情短时复用，过期后可发现新集；不缓存临时媒体地址。
  private static readonly DETAIL_TTL_MS = 5 * 60_000;

  /** 分类定位和写入队列由管理器提供，详情状态保存在既有元数据中。 */
  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    private readonly repository: ServiceRepository,
    private readonly loadContext: (libraryId: string, userId: string, itemId: string) => Promise<ContentItemDetailContext | null>,
    private readonly withWrite: (context: ContentItemDetailContext, operation: () => Promise<void>, signal: AbortSignal) => Promise<void>,
  ) {}

  /** 只由详情、选集或播放入口调用；普通列表继续读取卡片。 */
  public async ensure(libraryId: string, userId: string, itemId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.requireAvailable(libraryId);
    const context = await this.loadContext(libraryId, userId, itemId);
    if (!context) return;
    this.requireAvailable(libraryId);
    const key = JSON.stringify([userId, libraryId, context.instanceId, context.remoteItemId]);
    let request = this.requests.get(key);
    if (!request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      const promise = this.withWrite(context, () => this.loadDetail(context, controller.signal), controller.signal)
        .finally(() => { clearTimeout(timer); if (this.requests.get(key)?.promise === promise) this.requests.delete(key); });
      request = { libraryId, instanceId: context.instanceId, controller, promise };
      this.requests.set(key, request);
    }
    await this.waitForRequest(request.promise, signal);
  }

  /** 调用方取消只结束自己的等待，不取消其他详情或选集请求正在复用的工作。 */
  private async waitForRequest(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new ApiError(499, "content_source_cancelled", "内容源调用已取消"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (error: unknown) => {
        signal.removeEventListener("abort", abort); reject(error);
      });
      if (signal.aborted) abort();
    });
  }

  /** 受写入队列保护后重读父记录，卡片更新不会覆盖刚补好的详情。 */
  private async loadDetail(context: ContentItemDetailContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const identityKey = `content:${context.instanceId}:${contentKey(context.remoteItemId)}`;
    const parent = await this.database.query("media_items").select("metadata_json")
      .where({ library_id: context.libraryId, user_id: context.userId, identity_key: identityKey }).whereNull("deleted_at").first();
    if (!parent) throw new ApiError(404, "content_source_item_missing", "内容源中的条目已经不可用");
    const source = parseJsonObject(parent.metadata_json).contentSource as Record<string, unknown> | undefined;
    const updated = typeof source?.detailUpdatedAt === "string" ? Date.parse(source.detailUpdatedAt) : NaN;
    if (source?.detailState === "complete" && Number.isFinite(updated)
      && updated <= Date.now() && Date.now() - updated < ContentItemDetailLoader.DETAIL_TTL_MS) return;
    const content = await context.adapter.detail(context.remoteItemId, signal);
    if (!content.episodes.length) throw new ApiError(404, "content_source_item_missing", "内容源暂未返回这部影片的有效分集或线路");
    // 关键变量：联网期间可能停用、清空或切换插件，落库前再次确认当前定位。
    const current = await this.loadContext(context.libraryId, context.userId, context.itemId);
    signal.throwIfAborted();
    if (!current || current.instanceId !== context.instanceId || current.remoteItemId !== context.remoteItemId
      || current.manifest.pluginId !== context.manifest.pluginId || current.manifest.version !== context.manifest.version
      || current.manifest.adapter !== context.manifest.adapter || current.manifest.scriptHash !== context.manifest.scriptHash
      || current.manifest.endpoint !== context.manifest.endpoint
      || JSON.stringify(current.manifest.headers) !== JSON.stringify(context.manifest.headers)) {
      throw new ApiError(409, "content_catalog_changed", "内容源已变化，请重新打开详情");
    }
    await persistCmsContent({ database: this.database, repository: this.repository, userId: current.userId,
      libraryId: current.libraryId, instanceId: current.instanceId, manifest: current.manifest,
      categories: current.categories, content });
    signal.throwIfAborted();
  }

  /** 清空期间和服务关闭后禁止创建新的详情工作。 */
  private requireAvailable(libraryId: string): void {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后打开详情");
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "content_catalog_changing", "媒体库目录正在修改，请稍后打开详情");
  }

  /** 清空或删除前取消并等待详情写入，避免旧请求在操作后重新回填。 */
  public async withLibraryChange<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    this.requireAvailable(libraryId);
    this.pausedLibraries.add(libraryId);
    try { await this.stopMatching((request) => request.libraryId === libraryId); return await operation(); }
    finally { this.pausedLibraries.delete(libraryId); }
  }

  /** 停用源时同时释放该实例的详情任务。 */
  public async stopInstance(instanceId: string): Promise<void> {
    await this.stopMatching((request) => request.instanceId === instanceId);
  }

  /** 停机等待全部详情任务收尾后才允许关闭数据库。 */
  public async close(): Promise<void> {
    this.closing = true;
    await this.stopMatching(() => true);
  }

  /** 先取消全部匹配请求，再并行等待，避免顺序等待造成遗漏。 */
  private async stopMatching(matches: (request: DetailRequest) => boolean): Promise<void> {
    const requests = [...this.requests.values()].filter(matches);
    for (const request of requests) request.controller.abort();
    await Promise.allSettled(requests.map((request) => request.promise));
  }
}
