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
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly generations = new Map<string, number>();
  private readonly pausedLibraries = new Set<string>();
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly details = new Map<string, Promise<void>>();
  private readonly detailExpires = new Map<string, number>();
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

  /** 同库操作串行；客户端取消和库生命周期取消都传到 Python 宿主。 */
  private enqueue<T>(libraryId: string, operation: (signal: AbortSignal, generation: number) => Promise<T>, parentSignal?: AbortSignal, controller = new AbortController()): Promise<T> {
    const generation = this.accept(libraryId);
    const abort = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const controllers = this.controllers.get(libraryId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(libraryId, controllers);
    const previous = this.tails.get(libraryId) ?? Promise.resolve();
    const result = previous.then(async () => {
      this.checkpoint(libraryId, generation, controller.signal);
      return operation(controller.signal, generation);
    });
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(libraryId, tail);
    const finish = (): void => {
      parentSignal?.removeEventListener("abort", abort);
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(libraryId);
      if (this.tails.get(libraryId) === tail) this.tails.delete(libraryId);
    };
    void result.then(finish, finish);
    return result;
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
    const promise = this.enqueue(libraryId, async (signal, generation) => {
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
      resolveQueued(JSON.parse(JSON.stringify(queued)) as ContentSourceSyncState);
      await this.runSync(libraryId, userId, queued, mode, signal, generation);
    }, undefined, controller).catch(async (error) => {
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
      const available = await runtime.adapter.categories(signal);
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
          await this.assertLibraryAvailable(libraryId, userId);
          const result = await runtime.adapter.page(categoryId, page, signal);
          for (const card of result.items) {
            if (card.categoryId !== categoryId) continue;
            this.checkpoint(libraryId, generation, signal);
            await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content: withCategoryNames(card, available) });
            sync.processedCount += 1;
          }
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

  /** 实时搜索保存命中作品摘要，已加载详情不会被卡片降级或清空章节。 */
  public async search(libraryId: string, userId: string, term: string, limit = 40, parentSignal?: AbortSignal, categoryId?: string): Promise<string[]> {
    const query = term.trim();
    if (!query || query.length > 200) throw validationError("term", "请输入 1 至 200 个字符的听书关键词");
    const count = Math.max(1, Math.min(200, Math.floor(limit) || 40));
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.assertLibraryAvailable(libraryId, userId);
      const detail = await this.getLibrary(libraryId, userId);
      if (categoryId && categoryId !== AUDIOBOOK_SEARCH_CATEGORY && !detail.configuration.categoryIds.includes(categoryId)) throw new ApiError(404, "audiobook_category_not_found", "听书分类不存在或尚未选择");
      const runtime = await this.runtime(detail.source.id, userId);
      const ids: string[] = [];
      const pageWindows = new Set<string>(); // 源忽略分页且重复返回同一窗口时停止，不无限搜索。
      for (let page = 1; page <= 5 && ids.length < count; page += 1) {
        this.checkpoint(libraryId, generation, signal);
        const result = await runtime.adapter.search(query, page, signal);
        const window = result.items.map((card) => card.id).join("\0");
        if (window && pageWindows.has(window)) break;
        if (window) pageWindows.add(window);
        // 关键变量：按原有书籍身份批量读取固定主分类，搜索不会把已存在作品迁移到别的库。
        const pageItemIds = result.items.map((card) => contentAudiobookItemId(libraryId, detail.source.id, card.id));
        const previousRows = pageItemIds.length ? await this.database.query("media_items").where({ user_id: userId, library_id: libraryId, item_type: "audiobook.book" }).whereIn("id", pageItemIds).select("id", "metadata_json") : [];
        const previousSources = new Map(previousRows.map((row) => [String(row.id), audiobookContentSource(parseJsonObject(row.metadata_json))]));
        for (const card of result.items) {
          const itemId = contentAudiobookItemId(libraryId, detail.source.id, card.id);
          const previousPrimary = audiobookSourceCategories(previousSources.get(itemId) ?? {})[0]?.id;
          const primaryCategory = previousPrimary ?? card.categories[0]?.id;
          if (primaryCategory && !detail.configuration.categoryIds.includes(primaryCategory)) continue;
          if (categoryId && primaryCategory && primaryCategory !== categoryId) continue;
          this.checkpoint(libraryId, generation, signal);
          const content = withCategoryNames(card, detail.configuration.categoryCatalog);
          const id = await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content });
          const categories = audiobookSourceCategories({ categories: [...audiobookSourceCategories(previousSources.get(itemId) ?? {}), ...content.categories] });
          previousSources.set(itemId, { categoryId: categories[0]?.id ?? AUDIOBOOK_SEARCH_CATEGORY, categories });
          if (!ids.includes(id)) ids.push(id);
          if (ids.length >= count) break;
        }
        // 原始条数为零或明确源末页才停止；付费过滤后的空候选继续下一窗口。
        if (result.rawItemCount === 0 || result.sourcePageCount !== null && page >= result.sourcePageCount) break;
      }
      return ids;
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

  /** 按需详情并发去重；TTL 只缓存完整目录状态，播放器输入始终只在当前调用内存存在。 */
  public async ensureBookDetails(libraryId: string, userId: string, bookItemId: string, signal?: AbortSignal): Promise<void> {
    const requestedGeneration = this.accept(libraryId);
    await this.assertLibraryAvailable(libraryId, userId);
    const key = `${libraryId}:${bookItemId}`;
    const item = await this.repository.getCatalogItem(bookItemId, userId);
    if (item.libraryId !== libraryId || item.itemType !== "audiobook.book") throw new ApiError(404, "audiobook_book_not_found", "听书作品不存在");
    this.checkpoint(libraryId, requestedGeneration, signal ?? new AbortController().signal);
    if ((this.detailExpires.get(key) ?? 0) > Date.now()) { signal?.throwIfAborted(); return; }
    let promise = this.details.get(key);
    if (!promise) {
      promise = this.enqueue(libraryId, async (requestSignal, generation) => {
        await this.assertLibraryAvailable(libraryId, userId);
        const source = audiobookContentSource(item.metadata);
        const detail = await this.getLibrary(libraryId, userId);
        if (source.instanceId !== detail.source.id || typeof source.remoteItemId !== "string") throw new ApiError(409, "audiobook_book_identity_invalid", "听书作品缺少正确的源身份");
        const runtime = await this.runtime(detail.source.id, userId);
        const content = withCategoryNames(await runtime.adapter.detail(source.remoteItemId, requestSignal), detail.configuration.categoryCatalog);
        this.checkpoint(libraryId, generation, requestSignal);
        await persistContentAudiobook({ database: this.database, repository: this.repository, libraryId, userId, instanceId: detail.source.id, content });
        this.checkpoint(libraryId, generation, requestSignal);
        for (const [cachedKey, expiresAt] of this.detailExpires) if (expiresAt <= Date.now()) this.detailExpires.delete(cachedKey);
        while (this.detailExpires.size >= 512) this.detailExpires.delete(this.detailExpires.keys().next().value!);
        this.detailExpires.set(key, Date.now() + 60000);
      });
      this.details.set(key, promise);
      const complete = (): void => { if (this.details.get(key) === promise) this.details.delete(key); };
      void promise.then(complete, complete);
    }
    return this.waitForDetails(promise, signal);
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

  /** 按稳定书章身份每次刷新播放器，不把签名 URL、headers 或 playbackId 落库。 */
  public async playback(libraryId: string, userId: string, chapterItemId: string, parentSignal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.assertLibraryAvailable(libraryId, userId);
      const chapter = await this.repository.getCatalogItem(chapterItemId, userId);
      if (chapter.libraryId !== libraryId || chapter.itemType !== "audiobook.chapter") throw new ApiError(404, "audiobook_chapter_not_found", "听书章节不存在");
      const source = audiobookContentSource(chapter.metadata);
      const detail = await this.getLibrary(libraryId, userId);
      if (source.instanceId !== detail.source.id || typeof source.remoteItemId !== "string" || typeof source.remoteChapterId !== "string" || typeof source.bookItemId !== "string" || contentAudiobookItemId(libraryId, detail.source.id, source.remoteItemId, source.remoteChapterId) !== chapterItemId) throw new ApiError(409, "audiobook_chapter_identity_invalid", "听书章节缺少正确的源身份");
      const relation = await this.database.query("media_relations").where({ user_id: userId, library_id: libraryId, parent_item_id: source.bookItemId, child_item_id: chapterItemId, relation_type: "book_chapter" }).first();
      if (!relation) throw new ApiError(410, "audiobook_chapter_gone", "听书章节已从作品中移除，请重新打开作品");
      const runtime = await this.runtime(detail.source.id, userId);
      const fresh = await runtime.adapter.detail(source.remoteItemId, signal);
      const track = fresh.tracks.find((entry) => entry.id === source.remoteChapterId);
      if (!track) throw new ApiError(410, "audiobook_chapter_gone", "源站已移除此音频章节");
      const result = await runtime.adapter.playback(track, signal);
      this.checkpoint(libraryId, generation, signal);
      await this.assertLibraryAvailable(libraryId, userId);
      return result;
    }, parentSignal);
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
      const binding = await this.database.query("content_source_libraries").where({ library_id: libraryId }).select("instance_id", "user_id", "sync_status", "sync_json").first();
      if (binding) {
        this.adapters.get(String(binding.instance_id))?.adapter.clearDetails();
        if (["queued", "running"].includes(String(binding.sync_status))) {
          const sync = { ...emptySync(), ...parseJsonObject(binding.sync_json), status: "failed", finishedAt: new Date().toISOString(), lastError: "目录修改取消了此前听书同步" } as ContentSourceSyncState;
          await this.saveSync(libraryId, String(binding.user_id), sync);
        }
      }
      for (const key of this.details.keys()) if (key.startsWith(`${libraryId}:`)) this.details.delete(key);
      for (const key of this.detailExpires.keys()) if (key.startsWith(`${libraryId}:`)) this.detailExpires.delete(key);
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
      for (const key of this.detailExpires.keys()) if (key.startsWith(`${libraryId}:`)) this.detailExpires.delete(key);
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
    await Promise.allSettled([...this.tails.values(), ...[...this.jobs.values()].map((job) => job.promise)]);
    await Promise.allSettled([...this.adapters.values()].map((cached) => this.contentSources.pythonRuntime.stopInstance(cached.adapter.sessionId)));
    this.adapters.clear(); this.details.clear(); this.detailExpires.clear(); this.generations.clear();
  }
}
