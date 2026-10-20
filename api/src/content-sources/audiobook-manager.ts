import { randomUUID } from "node:crypto";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ServiceRepository } from "../service-repository.js";
import type { ContentSourceManager } from "./manager.js";
import type { ContentSourceCategory, ContentSourceInstance, ContentSourceManifest, ContentSourceSyncState } from "./types.js";
import { audiobookAudioExtension, PythonAudiobookSourceAdapter } from "./audiobook-adapter.js";
import { audiobookContentSource, audiobookSourceCategories, contentAudiobookItemId, persistContentAudiobook } from "./audiobook-catalog.js";
import { AUDIOBOOK_SEARCH_CATEGORY, type AudiobookSourceCard, type AudiobookSourceManifest, type ContentAudiobookConfiguration, type ContentAudiobookLocator } from "./audiobook-types.js";
import type { AudiobookDirectoryState, AudiobookSourceDetail } from "./audiobook-types.js";
import { claimAudiobookDirectory, failAudiobookDirectory, readAudiobookDirectory } from "./audiobook-directory-state.js";
import type { PythonInvocationOptions } from "./python-runtime.js";

/** 调度项只保存一次小操作；不同优先级不能破坏同库Spider的串行约束。 */
interface AudiobookQueuedOperation {
  priority: number;
  queueKey?: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  controller: AbortController;
}

/** 同步状态复用既有内容源表和标准状态结构。 */
function emptySync(): ContentSourceSyncState {
  return { status: "idle", processedCount: 0, pageCount: 0, nextPageByCategory: {}, startedAt: null, finishedAt: null, lastError: null };
}

/** 听书源必须显式声明媒体类型，不将视频或音乐脚本推断为听书源。 */
function audiobookManifest(manifest: ContentSourceManifest): AudiobookSourceManifest {
  if (manifest.adapter !== "python_spider" || (manifest as ContentSourceManifest & { mediaType?: string }).mediaType !== "audiobook") throw new ApiError(422, "audiobook_source_type_invalid", "请选择明确声明有声书能力的 Python 插件");
  return manifest as AudiobookSourceManifest;
}

/** 只选择真实叶分类；搜索虚拟分类不在新建分类列表中出现。 */
function selectableCategories(categories: ContentSourceCategory[]): ContentSourceCategory[] {
  const parentIds = new Set(categories.map((category) => category.parentId).filter(Boolean));
  return categories.filter((category) => !parentIds.has(category.id) && category.id !== AUDIOBOOK_SEARCH_CATEGORY);
}

/** 显式选择至少一个真实分类，保存时只使用源站提供的名称。 */
function selectedCategories(ids: string[], categories: ContentSourceCategory[]): { categoryIds: string[]; categories: ContentSourceCategory[] } {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw validationError("categoryIds", "听书分类必须是 ID 数组");
  const categoryIds = [...new Set(ids)];
  if (!categoryIds.length || categoryIds.some((id) => !categories.some((category) => category.id === id))) throw validationError("categoryIds", "请至少选择一个源站现有的听书叶分类");
  return { categoryIds, categories: categories.filter((category) => categoryIds.includes(category.id)) };
}

/** 同步页数受明确上限限制，首次导入始终固定一整页。 */
function pageCount(value?: number): number {
  const count = value ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw validationError("pageCount", "同步页数必须为 1 至 20 的整数");
  return count;
}

/** 读取既有配置 JSON，不会把非法历史分类猜成新的源分类。 */
function configuration(value: unknown): ContentAudiobookConfiguration {
  const raw = parseJsonObject(value);
  return { categoryIds: Array.isArray(raw.categoryIds) ? raw.categoryIds.filter((id): id is string => typeof id === "string") : [], categories: Array.isArray(raw.categories) ? raw.categories as ContentSourceCategory[] : [], categoryCatalog: Array.isArray(raw.categoryCatalog) ? raw.categoryCatalog as ContentSourceCategory[] : [], initialPageCount: 1 };
}

/** 分类名称只由源站分类目录补全，不根据作品标题、类型文字或搜索范围猜测归属。 */
function withCategoryNames<T extends AudiobookSourceCard>(content: T, catalog: ContentSourceCategory[]): T {
  const categories = content.categories.map((category) => ({ ...category, name: category.name || catalog.find((known) => known.id === category.id)?.name || "" }));
  return { ...content, categories, categoryName: content.categoryName || categories.find((category) => category.id === content.categoryId)?.name || "" };
}

/** 在线有声书仅复用内容源和媒体目录，不构造网盘服务、源文件或文件关联。 */
export class ContentAudiobookManager {
  private readonly adapters = new Map<string, { key: string; adapter: PythonAudiobookSourceAdapter }>();
  // 关键变量：同一库所有网络及写入有序，清库前能够取消并等待全部旧操作收尾。
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, AudiobookQueuedOperation[]>();
  private readonly runningLibraries = new Set<string>();
  private readonly foregroundBursts = new Map<string, number>();
  private readonly playbackRequests = new Map<string, PythonInvocationOptions>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private readonly pausedLibraries = new Set<string>();
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly details = new Map<string, Promise<void>>();
  private closing = false;

  /** 共用现有 Python 宿主，听书会话使用独立前缀，不修改已有影视或音乐适配器。 */
  public constructor(private readonly database: FlyCloudHelperDatabase, private readonly config: ApiConfig, private readonly repository: ServiceRepository, private readonly contentSources: ContentSourceManager) {}

  /** 每次执行前重新核对固定实例、插件版本和媒体类型。 */
  private async runtime(instanceId: string, userId: string): Promise<{ source: ContentSourceInstance; manifest: AudiobookSourceManifest; adapter: PythonAudiobookSourceAdapter }> {
    if (this.closing) throw new ApiError(503, "audiobook_source_stopping", "听书源服务正在停止");
    const source = await this.contentSources.sourceForInstance(instanceId, userId);
    const manifest = audiobookManifest(await this.contentSources.manifestForInstance(instanceId, userId));
    const key = `${manifest.pluginId}:${manifest.version}:${manifest.scriptHash}`;
    let cached = this.adapters.get(instanceId);
    if (cached && cached.key !== key) {
      cached.adapter.invalidate();
      await this.contentSources.pythonRuntime.stopInstance(cached.adapter.sessionId);
      this.adapters.delete(instanceId);
      cached = undefined;
    }
    if (!cached) {
      cached = { key, adapter: new PythonAudiobookSourceAdapter(manifest, this.contentSources.pythonRuntime, instanceId, this.config.pluginDirectory) };
      this.adapters.set(instanceId, cached);
    }
    return { source, manifest, adapter: cached.adapter };
  }

  /** 创建前只预览分类，临时 Spider 会话不会与已有库混用 Cookie。 */
  public async previewPluginCategories(pluginId: string, version: string, userId: string): Promise<ContentSourceCategory[]> {
    if (this.closing) throw new ApiError(503, "audiobook_source_stopping", "听书源服务正在停止");
    const manifest = audiobookManifest(await this.contentSources.manifestForPlugin(pluginId, version));
    const adapter = new PythonAudiobookSourceAdapter(manifest, this.contentSources.pythonRuntime, `preview:${userId}:${randomUUID()}`, this.config.pluginDirectory);
    try { return selectableCategories(await adapter.categories()); }
    finally { adapter.invalidate(); await this.contentSources.pythonRuntime.stopInstance(adapter.sessionId); }
  }

  /** 当前实例的分类由真实源返回，不创建或补写媒体目录。 */
  public async categories(instanceId: string, userId: string): Promise<ContentSourceCategory[]> {
    return selectableCategories(await (await this.runtime(instanceId, userId)).adapter.categories());
  }

  /** 管理页读取历史配置允许源已停用；执行入口另行要求所有状态有效。 */
  private async binding(libraryId: string, userId: string): Promise<Record<string, unknown>> {
    const row = await this.database.query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinAudiobookPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .select("b.*", "l.status as library_status", "i.display_name as source_name", "i.plugin_id", "i.plugin_version", "i.status as source_status", "i.created_at as source_created_at", "i.updated_at as source_updated_at", "p.status as plugin_status", "p.manifest_json")
      .where({ "b.library_id": libraryId, "b.user_id": userId, "l.user_id": userId, "i.user_id": userId, "l.library_kind": "content_source_audiobook", "l.data_type": "audiobook" }).first();
    if (!row) throw new ApiError(404, "audiobook_library_not_found", "在线听书媒体库不存在");
    audiobookManifest(parseJsonObject(row.manifest_json) as unknown as ContentSourceManifest);
    return row;
  }

  /** 对外返回原实例、分类配置和真实同步状态。 */
  public async getLibrary(libraryId: string, userId: string): Promise<{ source: ContentSourceInstance; configuration: ContentAudiobookConfiguration; sync: ContentSourceSyncState }> {
    const row = await this.binding(libraryId, userId);
    return { source: { id: String(row.instance_id), userId, pluginId: String(row.plugin_id), pluginVersion: String(row.plugin_version), displayName: String(row.source_name), status: row.source_status as ContentSourceInstance["status"], pluginStatus: row.plugin_status as ContentSourceInstance["pluginStatus"], libraryId, createdAt: String(row.source_created_at), updatedAt: String(row.source_updated_at) }, configuration: configuration(row.configuration_json), sync: { ...emptySync(), ...parseJsonObject(row.sync_json) } as ContentSourceSyncState };
  }

  /** 协议鉴权后仍校验在线库、真实来源、实例和插件启停。 */
  public async assertLibraryAvailable(libraryId: string, userId: string): Promise<void> {
    this.accept(libraryId);
    const row = await this.binding(libraryId, userId);
    if (row.library_status !== "active" || row.source_status !== "active" || row.plugin_status !== "enabled") throw new ApiError(409, "audiobook_library_unavailable", "在线听书库、源实例或插件已停用");
    const source = await this.database.query("library_sources").where({ id: row.library_source_id, library_id: libraryId, user_id: userId, source_mode: "content_source", status: "active" }).first();
    if (!source) throw new ApiError(409, "audiobook_source_unavailable", "在线听书库的内容来源已停用");
  }

  /** 拒绝停机、清库及删库期间的新操作，并记录请求开始时的目录代际。 */
  private accept(libraryId: string): number {
    if (this.closing) throw new ApiError(503, "audiobook_source_stopping", "听书源服务正在停止");
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "audiobook_catalog_changing", "听书媒体库正在修改目录");
    return this.generations.get(libraryId) ?? 0;
  }

  /** 旧操作即使网络稍后才结束，也不能在清库后回填。 */
  private checkpoint(libraryId: string, generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.accept(libraryId) !== generation) throw new ApiError(409, "audiobook_catalog_changed", "听书目录已改变，请重新加载");
  }

  /** 同库操作串行；前台可提升待执行预取，后台每个小批次释放执行权。 */
  private enqueue<T>(libraryId: string, operation: (signal: AbortSignal, generation: number) => Promise<T>, parentSignal?: AbortSignal, controller = new AbortController(), priority = 1, queueKey?: string): Promise<T> {
    const generation = this.accept(libraryId);
    if ((this.queues.get(libraryId)?.length ?? 0) >= 64) throw new ApiError(503, "audiobook_queue_busy", "听书任务排队较多，请稍后重试");
    const abort = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const controllers = this.controllers.get(libraryId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(libraryId, controllers);
    const queue = this.queues.get(libraryId) ?? [];
    this.queues.set(libraryId, queue);
    let entry!: AudiobookQueuedOperation;
    const result = new Promise<T>((resolve, reject) => {
      entry = { priority, queueKey, controller, resolve: (value) => resolve(value as T), reject, run: async () => { this.checkpoint(libraryId, generation, controller.signal); return operation(controller.signal, generation); } };
      queue.push(entry);
    });
    // 关键变量：tails仍表示全部旧操作排空，不再用Promise链决定调度顺序。
    const previous = this.tails.get(libraryId) ?? Promise.resolve();
    const tail = Promise.allSettled([previous, result]).then(() => undefined);
    this.tails.set(libraryId, tail);
    const removeQueued = (): void => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      entry.reject(new ApiError(499, "audiobook_request_cancelled", "听书请求已取消"));
    };
    controller.signal.addEventListener("abort", removeQueued, { once: true });
    const finish = (): void => {
      parentSignal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", removeQueued);
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(libraryId);
      if (this.tails.get(libraryId) === tail) this.tails.delete(libraryId);
    };
    void result.then(finish, finish);
    if (controller.signal.aborted) removeQueued();
    queueMicrotask(() => this.pumpLibrary(libraryId));
    return result;
  }

  /** 优先级仅在调用边界生效；每八次前台操作给已排队后台一次轮转机会。 */
  private pumpLibrary(libraryId: string): void {
    if (this.runningLibraries.has(libraryId)) return;
    const queue = this.queues.get(libraryId);
    if (!queue?.length) { this.queues.delete(libraryId); this.foregroundBursts.delete(libraryId); return; }
    const bursts = this.foregroundBursts.get(libraryId) ?? 0;
    let index = bursts >= 8 ? queue.findIndex((entry) => entry.priority >= 3) : -1;
    if (index < 0) index = queue.reduce((best, entry, current) => entry.priority < queue[best]!.priority ? current : best, 0);
    const entry = queue.splice(index, 1)[0]!;
    this.foregroundBursts.set(libraryId, entry.priority >= 3 ? 0 : bursts + 1);
    this.runningLibraries.add(libraryId);
    void entry.run().then(entry.resolve, entry.reject).finally(() => { this.runningLibraries.delete(libraryId); this.pumpLibrary(libraryId); });
  }

  /** 新建独立在线听书库，ABS 默认关闭，首导各分类一整页摘要。 */
  public async createLibrary(instanceId: string, userId: string, input: { displayName: string; categoryIds: string[]; initialPageCount?: number }) {
    if (this.closing) throw new ApiError(503, "audiobook_source_stopping", "听书源服务正在停止");
    const runtime = await this.runtime(instanceId, userId);
    const available = await runtime.adapter.categories();
    const selected = selectedCategories(input.categoryIds, selectableCategories(available));
    const settings: ContentAudiobookConfiguration = { ...selected, categoryCatalog: available, initialPageCount: 1 };
    const libraryId = randomUUID();
    const created = await this.repository.createContentSourceAudiobookLibrary({ libraryId, sourceId: randomUUID(), instanceId, userId, displayName: input.displayName, sourceName: runtime.source.displayName, providerType: "python_spider", configuration: settings as unknown as Record<string, unknown>, syncState: emptySync() as unknown as Record<string, unknown> });
    const sync = await this.startLibrarySync(libraryId, userId, { pageCount: 1 });
    return { libraryId, library: created.library, sync };
  }

  /** 编辑分类保留已导入作品；已存在分类的连续导入游标继续沿用。 */
  public async updateLibraryCategories(libraryId: string, userId: string, categoryIds: string[]): Promise<Awaited<ReturnType<ContentAudiobookManager["getLibrary"]>>> {
    const detail = await this.getLibrary(libraryId, userId);
    const selected = selectedCategories(categoryIds, await this.categories(detail.source.id, userId));
    await this.enqueue(libraryId, async () => {
      await this.assertLibraryAvailable(libraryId, userId);
      const current = await this.getLibrary(libraryId, userId);
      if (this.jobs.has(libraryId) || ["queued", "running"].includes(current.sync.status)) throw new ApiError(409, "content_sync_running", "同步期间不能修改听书分类");
      const sync: ContentSourceSyncState = { ...emptySync(), nextPageByCategory: { ...current.sync.nextPageByCategory } };
      for (const id of selected.categoryIds) sync.nextPageByCategory[id] ??= 1;
      await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ configuration_json: JSON.stringify({ ...current.configuration, ...selected }), sync_status: sync.status, sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
    });
    return this.getLibrary(libraryId, userId);
  }

  /** 每一源页完整写入之后保存游标，错误不会提前跳过尚未完成的页面。 */
  private async saveSync(libraryId: string, userId: string, sync: ContentSourceSyncState): Promise<void> {
    await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ sync_status: sync.status, sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
  }

  /** 后台同步只保存摘要，失败批次保留原目标范围，最新同步不推进连续导入游标。 */
  public async startLibrarySync(libraryId: string, userId: string, options: { pageCount?: number; mode?: "next" | "refresh" | "latest" } = {}): Promise<ContentSourceSyncState> {
    this.accept(libraryId);
    if (this.jobs.has(libraryId)) throw new ApiError(409, "content_sync_running", "此在线听书库已经在同步");
    const mode = options.mode ?? "next";
    const requested = mode === "latest" ? 1 : pageCount(options.pageCount);
    const controller = new AbortController();
    let resolveQueued!: (sync: ContentSourceSyncState) => void;
    let rejectQueued!: (error: unknown) => void;
    const ready = new Promise<ContentSourceSyncState>((resolve, reject) => { resolveQueued = resolve; rejectQueued = reject; });
    let claimed: ContentSourceSyncState | undefined;
    // 关键变量：先登记同一个 job，再在它的队列内领取 queued 并执行同步，不留取消入口看不到 job 的窗口。
    const generation = this.accept(libraryId);
    const promise = (async () => {
      const queued = await this.enqueue(libraryId, async (signal) => {
        await this.assertLibraryAvailable(libraryId, userId);
        const detail = await this.getLibrary(libraryId, userId);
        this.checkpoint(libraryId, generation, signal);
        if (["queued", "running"].includes(detail.sync.status)) throw new ApiError(409, "content_sync_running", "此在线听书库已经在同步");
        const pendingBatch = mode === "next" ? detail.sync.pendingBatch ?? { pageCount: requested, sample: false, endPageExclusiveByCategory: Object.fromEntries(detail.configuration.categoryIds.map((id) => [id, (detail.sync.nextPageByCategory[id] ?? 1) + requested])), completedCategoryIds: [], remainingSampleCountByCategory: {} } : detail.sync.pendingBatch;
        const queued: ContentSourceSyncState = { ...detail.sync, status: "queued", processedCount: 0, pageCount: mode === "next" ? pendingBatch!.pageCount : requested, startedAt: new Date().toISOString(), finishedAt: null, lastError: null, nextPageByCategory: { ...detail.sync.nextPageByCategory }, ...(pendingBatch ? { pendingBatch } : {}) };
        const changed = await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).whereNotIn("sync_status", ["queued", "running"]).update({ sync_status: "queued", sync_json: JSON.stringify(queued), updated_at: new Date().toISOString() });
        if (changed !== 1) throw new ApiError(409, "content_sync_running", "此在线听书库已经在同步");
        claimed = queued;
        this.checkpoint(libraryId, generation, signal);
        return queued;
      }, controller.signal, new AbortController(), 3);
      resolveQueued(JSON.parse(JSON.stringify(queued)) as ContentSourceSyncState);
      await this.runSync(libraryId, userId, queued, mode, controller.signal, generation);
    })().catch(async (error) => {
      rejectQueued(error);
      if (claimed && this.jobs.get(libraryId)?.controller === controller) {
        claimed.status = "failed"; claimed.finishedAt = new Date().toISOString(); claimed.lastError ??= "听书同步已停止，请重新同步";
        await this.saveSync(libraryId, userId, claimed);
      }
    }).finally(() => {
      // 旧任务只能释放自己的登记，不能删掉后续已替换的新 job。
      if (this.jobs.get(libraryId)?.controller === controller) this.jobs.delete(libraryId);
    });
    this.jobs.set(libraryId, { controller, promise });
    void promise.catch(() => undefined);
    return ready;
  }

  /** 源站窗口与过滤候选分开判断，只在真实页完成后推进游标。 */
  private async runSync(libraryId: string, userId: string, sync: ContentSourceSyncState, mode: "next" | "refresh" | "latest", signal: AbortSignal, generation: number): Promise<void> {
    sync.status = "running";
    await this.saveSync(libraryId, userId, sync);
    try {
      const detail = await this.getLibrary(libraryId, userId);
      const runtime = await this.runtime(detail.source.id, userId);
      const available = await this.enqueue(libraryId, () => runtime.adapter.categories(signal), signal, new AbortController(), 3);
      this.checkpoint(libraryId, generation, signal);
      const current = { ...detail.configuration, categoryCatalog: available, categories: available.filter((category) => detail.configuration.categoryIds.includes(category.id)) };
      await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ configuration_json: JSON.stringify(current) });
      for (const categoryId of detail.configuration.categoryIds) {
        if (!available.some((category) => category.id === categoryId)) continue;
        if (mode === "next" && sync.pendingBatch?.completedCategoryIds.includes(categoryId)) continue;
        let page = mode === "next" ? sync.nextPageByCategory[categoryId] ?? 1 : 1;
        const end = mode === "next" ? sync.pendingBatch?.endPageExclusiveByCategory[categoryId] ?? page : sync.pageCount + 1;
        while (page < end) {
          this.checkpoint(libraryId, generation, signal);
          const result = await this.enqueue(libraryId, async () => {
            await this.assertLibraryAvailable(libraryId, userId);
            const pageResult = await runtime.adapter.page(categoryId, page, signal);
            for (const card of pageResult.items) {
              if (card.categoryId !== categoryId) continue;
              this.checkpoint(libraryId, generation, signal);
              await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content: withCategoryNames(card, available) });
              sync.processedCount += 1;
            }
            return pageResult;
          }, signal, new AbortController(), 3);
          this.checkpoint(libraryId, generation, signal);
          page += 1;
          if (mode === "next") sync.nextPageByCategory[categoryId] = page;
          await this.saveSync(libraryId, userId, sync);
          if (result.sourcePageCount !== null ? page > result.sourcePageCount : result.rawItemCount === 0) break;
        }
        if (mode === "next") sync.pendingBatch?.completedCategoryIds.push(categoryId);
      }
      this.checkpoint(libraryId, generation, signal);
      sync.status = "completed";
      if (mode === "next") delete sync.pendingBatch;
    } catch (error) {
      sync.status = "failed";
      sync.lastError = error instanceof ApiError ? error.message : signal.aborted ? "听书同步已取消，请重新同步" : "听书源同步失败，请检查源站或稍后重试";
    }
    sync.finishedAt = new Date().toISOString();
    await this.saveSync(libraryId, userId, sync);
  }

  /** 旧ABS搜索保留数量约定，实际每个源窗口独立排队，避免多页占用播放队列。 */
  public async search(libraryId: string, userId: string, term: string, limit = 40, parentSignal?: AbortSignal, categoryId?: string): Promise<string[]> {
    const count = Math.max(1, Math.min(200, Math.floor(limit) || 40));
    const ids: string[] = [];
    const windows = new Set<string>();
    for (let page = 1; page <= 5 && ids.length < count; page += 1) {
      const result = await this.searchPage(libraryId, userId, term, page, parentSignal, categoryId);
      const window = result.ids.join("\0");
      if (window && windows.has(window)) break;
      if (window) windows.add(window);
      for (const id of result.ids) if (!ids.includes(id) && ids.length < count) ids.push(id);
      if (!result.hasMore) break;
    }
    return ids;
  }

  /** 原生实时搜索每次只读取一个真实源窗口，过滤后空页仍根据原始范围续页。 */
  public async searchPage(libraryId: string, userId: string, term: string, page: number, parentSignal?: AbortSignal, categoryId?: string): Promise<{ ids: string[]; hasMore: boolean }> {
    const query = term.trim();
    if (!query || query.length > 200) throw validationError("term", "请输入 1 至 200 个字符的听书关键词");
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw validationError("page", "听书搜索页号无效");
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.assertLibraryAvailable(libraryId, userId);
      const detail = await this.getLibrary(libraryId, userId);
      if (categoryId && categoryId !== AUDIOBOOK_SEARCH_CATEGORY && !detail.configuration.categoryIds.includes(categoryId)) throw new ApiError(404, "audiobook_category_not_found", "听书分类不存在或尚未选择");
      const runtime = await this.runtime(detail.source.id, userId);
      const result = await runtime.adapter.search(query, page, signal);
      const pageIds = result.items.map((card) => contentAudiobookItemId(libraryId, detail.source.id, card.id));
      const previousRows = pageIds.length ? await this.database.query("media_items").where({ user_id: userId, library_id: libraryId, item_type: "audiobook.book" }).whereIn("id", pageIds).select("id", "metadata_json") : [];
      const previousSources = new Map(previousRows.map((row) => [String(row.id), audiobookContentSource(parseJsonObject(row.metadata_json))]));
      const ids: string[] = [];
      for (const card of result.items) {
        const itemId = contentAudiobookItemId(libraryId, detail.source.id, card.id);
        const primaryCategory = audiobookSourceCategories(previousSources.get(itemId) ?? {})[0]?.id ?? card.categories[0]?.id;
        if (primaryCategory && !detail.configuration.categoryIds.includes(primaryCategory)) continue;
        if (categoryId && primaryCategory && categoryId !== primaryCategory) continue;
        this.checkpoint(libraryId, generation, signal);
        const content = withCategoryNames(card, detail.configuration.categoryCatalog);
        const id = await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content });
        if (!ids.includes(id)) ids.push(id);
      }
      return { ids, hasMore: result.sourcePageCount !== null ? page < result.sourcePageCount : result.rawItemCount > 0 };
    }, parentSignal);
  }

  /** 一个调用者取消等待不会取消其他调用者共享的详情请求。 */
  private async waitForDetails(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { cleanup(); reject(new ApiError(499, "audiobook_request_cancelled", "听书请求已取消")); };
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
    });
  }

  /** 读取单本书的小型准备状态；历史完整目录在首次原生准备前仍可供ABS使用。 */
  public async getBookDirectoryState(libraryId: string, userId: string, bookItemId: string): Promise<AudiobookDirectoryState> {
    await this.assertLibraryAvailable(libraryId, userId);
    const book = await this.database.query("media_items").select("id", "metadata_json", "updated_at").where({ id: bookItemId, library_id: libraryId, user_id: userId, item_type: "audiobook.book" }).whereNull("deleted_at").first();
    if (!book) throw new ApiError(404, "audiobook_book_not_found", "听书作品不存在");
    const state = await readAudiobookDirectory(this.database, libraryId, userId, bookItemId);
    const metadata = parseJsonObject(book.metadata_json);
    // 关键变量：清库后同一稳定书籍ID可以重新出现，旧KV完成标志不能冒充新目录已存在。
    if (state.catalogComplete && metadata.audioDetailsLoaded !== true) return { ...state, status: "NotLoaded", catalogComplete: false, chapterCount: null };
    if (state.catalogComplete && state.chapterCount === null) return { ...state, chapterCount: Number(metadata.chapterCount ?? metadata.audioFileCount ?? 0) };
    if (state.status === "NotLoaded" && metadata.audioDetailsLoaded === true) {
      const source = audiobookContentSource(metadata);
      return { ...state, status: "Ready", catalogComplete: true, chapterCount: Number(metadata.chapterCount ?? metadata.audioFileCount ?? 0), checkedAt: typeof source.detailUpdatedAt === "string" ? source.detailUpdatedAt : String(book.updated_at) };
    }
    return state;
  }

  /** 启动或复用逐页准备任务，立即返回状态；请求取消不撤销其他调用者共享的后台任务。 */
  public async prepareBookDirectory(libraryId: string, userId: string, bookItemId: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<AudiobookDirectoryState> {
    options.signal?.throwIfAborted();
    const key = `${libraryId}:${bookItemId}`;
    const current = await this.getBookDirectoryState(libraryId, userId, bookItemId);
    if (this.details.has(key)) return current;
    if (!options.force && current.catalogComplete && Date.parse(current.checkedAt ?? "") + 60000 > Date.now()) return current;
    if (this.details.size >= 8) {
      if (current.catalogComplete) return current;
      throw new ApiError(503, "audiobook_directory_busy", "听书目录准备任务较多，请稍后重试");
    }
    const generation = this.accept(libraryId);
    // 关键变量：领取只含小型DB事务，不排在正在执行的网络调用之后。
    const claim = claimAudiobookDirectory(this.database, libraryId, userId, bookItemId, current);
    let ownedRunId: string | undefined;
    const promise = claim.then(async (claimed) => {
      if (!claimed.owned) return;
      ownedRunId = claimed.state.runId!;
      this.checkpoint(libraryId, generation, new AbortController().signal);
      await this.prepareDirectoryPages(libraryId, userId, bookItemId, ownedRunId, generation, current.catalogComplete);
    }).catch(async (error) => {
      if (ownedRunId) await failAudiobookDirectory(this.database, libraryId, userId, bookItemId, ownedRunId, error instanceof ApiError ? error.message : "听书目录准备失败，请稍后重试", current.catalogComplete ? current.catalogRevision : undefined);
      throw error;
    });
    // 领取和网络准备共享登记，清库必须等待它完整收尾，不能晚回填状态或章节。
    this.details.set(key, promise);
    const complete = (): void => { if (this.details.get(key) === promise) this.details.delete(key); };
    void promise.then(complete, complete);
    const claimed = await claim;
    options.signal?.throwIfAborted();
    return claimed.state;
  }

  /** 每次源调用及有界持久化独立排队，后台目录不会持续占用整本书的执行队列。 */
  private async prepareDirectoryPages(libraryId: string, userId: string, bookItemId: string, runId: string, generation: number, hadCompleteIndex: boolean): Promise<void> {
    const book = await this.database.query("media_items").where({ id: bookItemId, library_id: libraryId, user_id: userId, item_type: "audiobook.book" }).whereNull("deleted_at").first();
    if (!book) throw new ApiError(404, "audiobook_book_not_found", "听书作品不存在");
    const source = audiobookContentSource(parseJsonObject(book.metadata_json));
    const detail = await this.getLibrary(libraryId, userId);
    if (source.instanceId !== detail.source.id || typeof source.remoteItemId !== "string") throw new ApiError(409, "audiobook_book_identity_invalid", "听书作品缺少正确的源身份");
    const runtime = await this.runtime(detail.source.id, userId);
    const remoteBookId = source.remoteItemId;
    try {
      const seen = new Set<string>(); // 关键变量：只保存本轮稳定身份，不持久化播放器输入。
      const orders = new Set<number>();
      const staged: AudiobookSourceDetail["tracks"][] = [];
      let stagedBytes = 0;
      let pages = 1;
      let snapshotId: string | null = null;
      let authoritative = true;
      let lastContent: AudiobookSourceDetail | null = null;
      for (let page = 1; page <= pages; page += 1) {
        await this.enqueue(libraryId, async (signal) => {
          this.checkpoint(libraryId, generation, signal);
          await this.assertLibraryAvailable(libraryId, userId);
          const result = await runtime.adapter.chapterPage(remoteBookId, page, signal);
          this.checkpoint(libraryId, generation, signal);
          if (page === 1) { pages = result.pageCount; snapshotId = result.snapshotId; }
          else if (pages !== result.pageCount || snapshotId !== result.snapshotId) throw new ApiError(409, "audiobook_source_catalog_changed", "源站章节目录正在变化，请重新准备");
          if (result.rawItemCount === 0 && pages > 1) throw new ApiError(502, "audiobook_source_page_incomplete", "源站章节页尚未读取完整");
          authoritative = authoritative && result.authoritative;
          for (const track of result.detail.tracks) {
            const order = track.order!;
            if (seen.has(track.id) || orders.has(order)) throw new ApiError(409, "audiobook_source_catalog_changed", "源站章节分页身份或顺序重复，请重新准备");
            seen.add(track.id);
            orders.add(order);
            if (seen.size > 20000) throw new ApiError(422, "audiobook_source_tracks_too_many", "此来源章节数超过当前整理上限");
          }
          const content = withCategoryNames(result.detail, detail.configuration.categoryCatalog);
          lastContent = { ...content, tracks: [] };
          if (hadCompleteIndex) {
            // 关键变量：旧完整目录先保持不动。刷新暂存只有必要摘要，拒绝保存临时播放器输入。
            const tracks = content.tracks.map((track) => ({ ...track, playbackId: "" }));
            stagedBytes += Buffer.byteLength(JSON.stringify(tracks));
            if (stagedBytes > 16 * 1024 * 1024) throw new ApiError(413, "audiobook_directory_too_large", "本次目录摘要超过整理大小限制");
            staged.push(tracks);
          } else await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content, directory: { runId } });
        }, undefined, new AbortController(), 3);
      }
      if (!lastContent) throw new ApiError(502, "audiobook_source_page_incomplete", "源站尚未返回章节目录");
      const content: AudiobookSourceDetail = lastContent;
      const completeChapterIds = [...seen].map((id) => contentAudiobookItemId(libraryId, detail.source.id, remoteBookId, id));
      if (!authoritative) {
        // 公开源没有快照令牌时保留未确认缺失的旧章；合并顺序冲突不能冒充完整索引。
        const included = new Set(completeChapterIds);
        const old = await this.database.query("media_relations as r").join("media_items as m", "m.id", "r.child_item_id").select("r.child_item_id", "r.sort_order").where({ "r.user_id": userId, "r.library_id": libraryId, "r.parent_item_id": bookItemId, "r.relation_type": "book_chapter", "m.user_id": userId, "m.library_id": libraryId }).whereNull("m.deleted_at");
        for (const row of old) {
          if (included.has(String(row.child_item_id))) continue;
          const order = Number(row.sort_order) + 1;
          if (orders.has(order)) throw new ApiError(409, "audiobook_source_catalog_unconfirmed", "源站缺失章节的顺序尚未确认，已保留原有目录");
          orders.add(order);
        }
      }
      for (const tracks of staged) await this.enqueue(libraryId, async (signal) => {
        this.checkpoint(libraryId, generation, signal);
        await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content: { ...content, tracks }, directory: { runId } });
      }, undefined, new AbortController(), 3);
      await this.enqueue(libraryId, async (signal) => {
        this.checkpoint(libraryId, generation, signal);
        await this.assertLibraryAvailable(libraryId, userId);
        await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content, directory: { runId, final: true, authoritative, completeChapterIds } });
      }, undefined, new AbortController(), 3);
    } finally { runtime.adapter.releaseChapterDirectory(remoteBookId); }
  }

  /** ABS继续等待完整目录，不把逐页准备中的章节集合当成可靠整书时间轴。 */
  public async ensureBookDetails(libraryId: string, userId: string, bookItemId: string, signal?: AbortSignal): Promise<void> {
    const key = `${libraryId}:${bookItemId}`;
    let state = await this.prepareBookDirectory(libraryId, userId, bookItemId, { signal });
    const shared = this.details.get(key);
    if (shared) {
      try { await this.waitForDetails(shared, signal); }
      catch (error) {
        const retained = await this.getBookDirectoryState(libraryId, userId, bookItemId);
        if (!retained.catalogComplete || retained.status !== "Ready") throw error;
        signal?.throwIfAborted();
      }
    }
    state = await this.getBookDirectoryState(libraryId, userId, bookItemId);
    if (!state.catalogComplete) throw new ApiError(503, "audiobook_directory_preparing", state.lastError ?? "听书目录正在准备，请稍后重试");
  }

  /** 章节目录投影为 ABS 既有文件形状；全部定位来自真实在线源绑定，不创建网盘文件。 */
  public async filesForBook(libraryId: string, userId: string, bookItemId: string): Promise<Array<Record<string, unknown>>> {
    await this.assertLibraryAvailable(libraryId, userId);
    const binding = await this.binding(libraryId, userId);
    const book = await this.repository.getCatalogItem(bookItemId, userId);
    if (book.libraryId !== libraryId || book.itemType !== "audiobook.book") throw new ApiError(404, "audiobook_book_not_found", "听书作品不存在");
    const rows = await this.database.query("media_relations as r").join("media_items as m", "m.id", "r.child_item_id").select("m.*").where({ "r.user_id": userId, "r.library_id": libraryId, "r.parent_item_id": bookItemId, "r.relation_type": "book_chapter", "m.user_id": userId, "m.library_id": libraryId, "m.item_type": "audiobook.chapter" }).whereNull("m.deleted_at").orderBy("r.sort_order", "asc");
    return rows.map((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      const source = audiobookContentSource(metadata);
      if (source.instanceId !== binding.instance_id || typeof source.remoteItemId !== "string" || typeof source.remoteChapterId !== "string") throw new ApiError(409, "audiobook_chapter_identity_invalid", "听书章节缺少正确的源身份");
      const locator: ContentAudiobookLocator = { kind: "content_source_audiobook", instanceId: String(binding.instance_id), bookItemId, chapterItemId: String(row.id), remoteBookId: source.remoteItemId, remoteChapterId: source.remoteChapterId };
      const mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType : "application/octet-stream";
      const extension = audiobookAudioExtension(mimeType);
      return { contentSourceAudiobook: true, itemId: row.id, fileId: row.id, librarySourceId: binding.library_source_id, resourceId: source.remoteChapterId, name: `${String(row.title)}${extension ? `.${extension}` : ""}`, size: 0, mimeType, modifiedAt: row.updated_at, mediaProbeResult: { durationSeconds: Number(metadata.durationMs ?? 0) / 1000 }, sourceLocator: locator, playbackLocator: locator };
    });
  }

  /** 既有ABS取址保留签名，默认作为前台操作；已索引章节不展开整书。 */
  public async playback(libraryId: string, userId: string, chapterItemId: string, parentSignal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    return this.resolveChapterPlayback(libraryId, userId, chapterItemId, { signal: parentSignal });
  }

  /** 前台加入共享预解析时，提升两层待执行队列，不重复创建取址请求。 */
  public promoteChapterPlayback(libraryId: string, userId: string, chapterItemId: string): void {
    this.setChapterPlaybackPriority(libraryId, userId, chapterItemId, "foreground");
  }

  /** 按共享请求剩余消费者动态升降级，两层排队项与后续Python调用使用同一可变调度状态。 */
  public setChapterPlaybackPriority(libraryId: string, userId: string, chapterItemId: string, priority: "foreground" | "prefetch"): void {
    const key = `play:${libraryId}:${userId}:${chapterItemId}`;
    const rank = priority === "foreground" ? 0 : 2;
    const options = this.playbackRequests.get(key);
    if (options) options.priority = rank;
    for (const entry of this.queues.get(libraryId) ?? []) if (entry.queueKey === key) entry.priority = rank;
    for (const cached of this.adapters.values()) cached.adapter.setPlaybackPriority(key, rank);
  }

  /** 轻量校验稳定书章身份后直接调用源取址；预解析明确使用低于前台的优先级。 */
  public async resolveChapterPlayback(libraryId: string, userId: string, chapterItemId: string, options: { signal?: AbortSignal; priority?: "foreground" | "prefetch" } = {}): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    const key = `play:${libraryId}:${userId}:${chapterItemId}`;
    const scheduling: PythonInvocationOptions = { priority: options.priority === "prefetch" ? 2 : 0, queueKey: key };
    this.playbackRequests.set(key, scheduling);
    try {
      return await this.enqueue(libraryId, async (signal, generation) => {
        await this.assertLibraryAvailable(libraryId, userId);
        const chapter = await this.database.query("media_items as c")
          .join("media_relations as r", "r.child_item_id", "c.id")
          .join("media_items as b", "b.id", "r.parent_item_id")
          .select("c.*", "b.id as book_item_id")
          .where({ "c.id": chapterItemId, "c.user_id": userId, "c.library_id": libraryId, "c.item_type": "audiobook.chapter", "r.user_id": userId, "r.library_id": libraryId, "r.relation_type": "book_chapter", "b.user_id": userId, "b.library_id": libraryId, "b.item_type": "audiobook.book" })
          .whereNull("c.deleted_at").whereNull("b.deleted_at").first();
        if (!chapter) throw new ApiError(404, "audiobook_chapter_not_found", "听书章节不存在或已从作品移除");
        const source = audiobookContentSource(parseJsonObject(chapter.metadata_json));
        const detail = await this.getLibrary(libraryId, userId);
        if (source.instanceId !== detail.source.id || typeof source.remoteItemId !== "string" || typeof source.remoteChapterId !== "string" || source.bookItemId !== chapter.book_item_id || contentAudiobookItemId(libraryId, detail.source.id, source.remoteItemId, source.remoteChapterId) !== chapterItemId) throw new ApiError(409, "audiobook_chapter_identity_invalid", "听书章节缺少正确的源身份");
        const runtime = await this.runtime(detail.source.id, userId);
        const result = await runtime.adapter.resolveChapterPlayback(source.remoteItemId, source.remoteChapterId, signal, scheduling);
        this.checkpoint(libraryId, generation, signal);
        await this.assertLibraryAvailable(libraryId, userId);
        return result;
      }, options.signal, new AbortController(), scheduling.priority, key);
    } finally {
      if (this.playbackRequests.get(key) === scheduling) this.playbackRequests.delete(key);
    }
  }

  /** 清空或删除先关入口、取消网络并排空旧请求，操作完成后只允许新代际重新读取。 */
  public async withLibraryCatalogChange<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "audiobook_catalog_changing", "此听书媒体库正在修改目录");
    this.pausedLibraries.add(libraryId);
    this.generations.set(libraryId, (this.generations.get(libraryId) ?? 0) + 1);
    try {
      for (const controller of this.controllers.get(libraryId) ?? []) controller.abort();
      await this.tails.get(libraryId);
      await this.jobs.get(libraryId)?.promise;
      await Promise.allSettled([...this.details.entries()].filter(([key]) => key.startsWith(`${libraryId}:`)).map(([, promise]) => promise));
      const binding = await this.database.query("content_source_libraries").where({ library_id: libraryId }).select("instance_id", "user_id", "sync_status", "sync_json").first();
      if (binding) {
        // 清库是显式实例生命周期操作，需停止仍在排空的已取消调用；普通页面取消不结束源进程。
        await this.contentSources.pythonRuntime.stopInstance(`audiobook:${String(binding.instance_id)}`);
        this.adapters.get(String(binding.instance_id))?.adapter.clearDetails();
        if (["queued", "running"].includes(String(binding.sync_status))) {
          const sync = { ...emptySync(), ...parseJsonObject(binding.sync_json), status: "failed", finishedAt: new Date().toISOString(), lastError: "目录修改取消了此前听书同步" } as ContentSourceSyncState;
          await this.saveSync(libraryId, String(binding.user_id), sync);
        }
      }
      for (const key of this.details.keys()) if (key.startsWith(`${libraryId}:`)) this.details.delete(key);
      return await operation();
    } finally { this.pausedLibraries.delete(libraryId); }
  }

  /** 插件停用、卸载或实例停用后立即停止旧会话，保留已有目录和协议状态。 */
  public async stopInstance(instanceId: string): Promise<void> {
    const cached = this.adapters.get(instanceId);
    cached?.adapter.invalidate();
    this.adapters.delete(instanceId);
    const bindings = await this.database.query("content_source_libraries").where({ instance_id: instanceId }).select("library_id");
    const waits: Promise<unknown>[] = [];
    const stoppedGenerations = new Map<string, number>();
    for (const binding of bindings) {
      const libraryId = String(binding.library_id);
      const generation = (this.generations.get(libraryId) ?? 0) + 1;
      this.generations.set(libraryId, generation);
      stoppedGenerations.set(libraryId, generation);
      for (const controller of this.controllers.get(libraryId) ?? []) controller.abort();
      const tail = this.tails.get(libraryId);
      if (tail) waits.push(tail);
      const job = this.jobs.get(libraryId);
      if (job) waits.push(job.promise);
      for (const [key, promise] of this.details) if (key.startsWith(`${libraryId}:`)) waits.push(promise);
    }
    await this.contentSources.pythonRuntime.stopInstance(`audiobook:${instanceId}`);
    await Promise.allSettled(waits);
    for (const [libraryId, generation] of stoppedGenerations) {
      if (this.generations.get(libraryId) !== generation || this.jobs.has(libraryId) || this.tails.has(libraryId)) continue;
      const binding = await this.database.query("content_source_libraries").where({ library_id: libraryId, instance_id: instanceId }).whereIn("sync_status", ["queued", "running"]).first();
      if (!binding) continue;
      const sync = { ...emptySync(), ...parseJsonObject(binding.sync_json), status: "failed", finishedAt: new Date().toISOString(), lastError: "听书源已停用，重新启用后可继续同步" } as ContentSourceSyncState;
      // 只修复刚读到的遗留状态；新任务已更新检查点时，旧停止回调不能覆盖它。
      await this.database.query("content_source_libraries").where({ library_id: libraryId, instance_id: instanceId, sync_status: binding.sync_status, sync_json: binding.sync_json }).update({ sync_status: "failed", sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
    }
  }

  /** 停机只关闭本管理器的 Python 会话，不关闭其他内容源共用的宿主。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const cached of this.adapters.values()) cached.adapter.invalidate();
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.tails.values(), ...this.details.values(), ...[...this.jobs.values()].map((job) => job.promise)]);
    await Promise.allSettled([...this.adapters.values()].map((cached) => this.contentSources.pythonRuntime.stopInstance(cached.adapter.sessionId)));
    this.adapters.clear(); this.details.clear(); this.generations.clear(); this.queues.clear(); this.playbackRequests.clear();
  }
}
