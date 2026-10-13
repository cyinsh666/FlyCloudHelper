import { ApiError, validationError } from "../errors.js";
import { categoryMatches } from "./catalog.js";
import type { CmsJsonAdapter } from "./cms-adapter.js";
import type { CmsCatalogContentItem, ContentSourceBrowseOptions, ContentSourceBrowseResult, ContentSourceCategory, ContentSourceManifest, ContentSourceSearchOptions, VideoSourceAdapter } from "./types.js";

/** 分类浏览与实时搜索使用独立窗口，源页请求始终保持原始顺序。 */
export type DynamicCatalogQuery = { kind: "category"; categoryId: string }
  | { kind: "search"; searchTerm: string; categoryId?: string };

/** 每次浏览重新校验的库归属、固定源版本及已选分类。 */
export interface DynamicCatalogContext {
  libraryId: string;
  userId: string;
  instanceId: string;
  query: DynamicCatalogQuery;
  /** 当前查询实际允许的叶分类；全库搜索也不能越过用户当前选择范围。 */
  categoryIds: string[];
  /** 固定源版本和分类配置签名；请求中途变更时不返回旧范围。 */
  identity: string;
  manifest: ContentSourceManifest;
  categories: ContentSourceCategory[];
  adapter: VideoSourceAdapter;
}

interface CachedSourcePage {
  candidates: CmsCatalogContentItem[];
  rawItemCount: number;
  sourcePageCount: number | null;
}

interface CategoryIndex {
  itemIds: string[];
  itemIdSet: Set<string>;
  remoteIdSet: Set<string>;
  sourcePage: number;
  candidateOffset: number;
  completed: boolean;
  tail: Promise<void>;
  /** 同一类型只安排一个预取，排队期间可合并更远一页的目标。 */
  prefetchTarget: number;
  prefetchPromise: Promise<ContentSourceBrowseResult> | null;
}

interface CategoryWindow {
  libraryId: string;
  identity: string;
  generation: number;
  expiresAt: number;
  activeRequests: number;
  pages: Map<number, CachedSourcePage>;
  pendingPages: Map<number, Promise<CachedSourcePage>>;
  indexes: Map<string, CategoryIndex>;
}

/** 查询窗口缓存五分钟；源页候选不含播放 URL，只有成功持久化的父条目计入查询总数。 */
export class DynamicContentCatalog {
  private readonly windows = new Map<string, CategoryWindow>();
  private readonly requests = new Set<Promise<ContentSourceBrowseResult>>();
  private readonly libraryRequests = new Map<string, Set<Promise<ContentSourceBrowseResult>>>();
  private readonly controllers = new Set<AbortController>();
  private readonly libraryControllers = new Map<string, Set<AbortController>>();
  private readonly pausedLibraries = new Set<string>();
  /** 清空、删除开始时提升代际，预检中的旧请求也不能在操作结束后重新回填。 */
  private readonly libraryGenerations = new Map<string, number>();
  private closing = false;
  private static readonly WINDOW_TTL_MS = 5 * 60_000;
  private static readonly MAX_WINDOWS = 32;
  private static readonly MAX_CACHED_PAGES = 8;
  private static readonly MAX_NEW_PAGES = 20;
  private static readonly MAX_PERSIST_CONCURRENCY = 4;
  private static readonly REQUEST_BUDGET_MS = 60_000;

  /** 宿主负责权限复核与共享持久化，动态浏览不写同步状态或分页游标。 */
  public constructor(
    private readonly loadContext: (libraryId: string, userId: string, query: DynamicCatalogQuery) => Promise<DynamicCatalogContext>,
    private readonly persist: (context: DynamicCatalogContext, content: CmsCatalogContentItem, itemTypes: string[], signal: AbortSignal) => Promise<string | null>,
    private readonly validateIndex: (context: DynamicCatalogContext, itemIds: string[], itemTypes: string[]) => Promise<boolean>,
  ) {}

  /** 分类浏览仍沿用原查询语义，只扩展该选中分类。 */
  public async browse(libraryId: string, userId: string, options: ContentSourceBrowseOptions): Promise<ContentSourceBrowseResult> {
    return this.query(libraryId, userId, { kind: "category", categoryId: options.categoryId }, options);
  }

  /** 搜索词只作为源查询和短时内存键，不记录到日志或数据库配置。 */
  public async search(libraryId: string, userId: string, options: ContentSourceSearchOptions): Promise<ContentSourceBrowseResult> {
    const searchTerm = typeof options.searchTerm === "string" ? options.searchTerm.trim() : "";
    if (!searchTerm || searchTerm.length > 200) throw validationError("searchTerm", "搜索词必须为 1 至 200 个字符");
    return this.query(libraryId, userId, { kind: "search", searchTerm, categoryId: options.categoryId }, options);
  }

  /** 同一词、分类、类型窗口串行扩展；共用清空、删除和停机生命周期。 */
  private async query(libraryId: string, userId: string, query: DynamicCatalogQuery, options: Omit<ContentSourceBrowseOptions, "categoryId">): Promise<ContentSourceBrowseResult> {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后浏览");
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "content_catalog_changing", "媒体库正在清空或删除，请稍后浏览");
    const startIndex = options.startIndex ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw validationError("startIndex", "浏览起点必须为非负整数");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw validationError("limit", "浏览条数必须为 1 至 500 的整数");
    if (!Number.isSafeInteger(startIndex + limit + 1)) throw validationError("startIndex", "浏览起点超出可支持的整数范围");
    const itemTypes = [...new Set(options.itemTypes?.length ? options.itemTypes : ["video.movie", "video.series"])].sort();
    if (itemTypes.some((type) => type !== "video.movie" && type !== "video.series")) throw validationError("itemTypes", "动态浏览只支持顶层电影和节目");
    const generation = this.libraryGenerations.get(libraryId) ?? 0;
    const context = await this.loadContext(libraryId, userId, query);
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后浏览");
    if (this.pausedLibraries.has(libraryId) || generation !== (this.libraryGenerations.get(libraryId) ?? 0)) throw new ApiError(409, "content_catalog_changing", "媒体库目录已经改变，请重新浏览");
    const window = this.queryWindow(context);
    const indexKey = itemTypes.join(",");
    let index = window.indexes.get(indexKey);
    if (!index) {
      index = { itemIds: [], itemIdSet: new Set(), remoteIdSet: new Set(), sourcePage: 1, candidateOffset: 0, completed: false, tail: Promise.resolve(), prefetchTarget: 0, prefetchPromise: null };
      window.indexes.set(indexKey, index);
    }
    const result = await this.queueExtension(context, window, index, startIndex, limit, itemTypes);
    this.schedulePrefetch(context, window, index, startIndex, limit, itemTypes);
    return result;
  }

  /** 前台和后台共用同一索引队列与收尾登记，下一页请求复用预取进度。 */
  private async queueExtension(context: DynamicCatalogContext, window: CategoryWindow, index: CategoryIndex, startIndex: number, limit: number, itemTypes: string[], prefetch = false): Promise<ContentSourceBrowseResult> {
    window.activeRequests += 1;
    const operation = index.tail.then(() => this.extendIndex(context, window, index, startIndex, limit, itemTypes,
      prefetch ? () => index.prefetchTarget : undefined));
    index.tail = operation.then(() => undefined, () => undefined);
    this.requests.add(operation);
    const libraryRequests = this.libraryRequests.get(context.libraryId) ?? new Set<Promise<ContentSourceBrowseResult>>();
    libraryRequests.add(operation);
    this.libraryRequests.set(context.libraryId, libraryRequests);
    try { return await operation; }
    finally {
      window.activeRequests -= 1;
      this.requests.delete(operation);
      libraryRequests.delete(operation);
      if (libraryRequests.size === 0) this.libraryRequests.delete(context.libraryId);
    }
  }

  /** 当前页返回后后台补下一客户端页及真实 lookahead，失败不改变前台结果或源末页判断。 */
  private schedulePrefetch(context: DynamicCatalogContext, window: CategoryWindow, index: CategoryIndex, startIndex: number, limit: number, itemTypes: string[]): void {
    // 关键变量：页大小来自客户端 Limit，不把源站每页二十条当作客户端页大小。
    const targetCount = startIndex + limit * 2 + 1;
    if (!Number.isSafeInteger(targetCount) || this.closing || this.pausedLibraries.has(context.libraryId)
      || window.generation !== (this.libraryGenerations.get(context.libraryId) ?? 0)
      || window.expiresAt <= Date.now() || index.completed || index.itemIds.length >= targetCount) return;
    index.prefetchTarget = Math.max(index.prefetchTarget, targetCount);
    if (index.prefetchPromise) return;
    const operation = this.queueExtension(context, window, index, startIndex + limit, limit, itemTypes, true);
    index.prefetchPromise = operation;
    /** 成功与失败都释放预取标记；失败保留已落库索引，下一次前台请求按原偏移重试。 */
    const finish = () => {
      if (index.prefetchPromise === operation) {
        index.prefetchPromise = null;
        index.prefetchTarget = 0;
      }
    };
    // 后台错误仅结束此次预取，不能形成未处理拒绝或让已成功的第一页失败。
    void operation.then(finish, finish);
  }

  /** 清空或删除前暂停该库浏览，取消网络并等待目录写入收尾，避免操作完成后继续回填。 */
  public async withLibraryCatalogChange<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "content_catalog_changing", "此媒体库正在修改目录，请稍后重试");
    this.pausedLibraries.add(libraryId);
    this.libraryGenerations.set(libraryId, (this.libraryGenerations.get(libraryId) ?? 0) + 1);
    try {
      for (const controller of this.libraryControllers.get(libraryId) ?? []) controller.abort();
      await Promise.allSettled([...(this.libraryRequests.get(libraryId) ?? [])]);
      for (const [key, window] of this.windows) if (window.libraryId === libraryId) this.windows.delete(key);
      return await operation();
    } finally { this.pausedLibraries.delete(libraryId); }
  }

  /** 关库前取消动态网络请求，并等待正在进行的目录写入完成。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests]);
    this.windows.clear();
    this.libraryGenerations.clear();
  }

  /** 版本和分类树改变后重建窗口；忙碌窗口不会因 TTL 在中途丢失索引。 */
  private queryWindow(context: DynamicCatalogContext): CategoryWindow {
    const key = JSON.stringify([context.userId, context.libraryId, context.query]);
    const identity = context.identity;
    const generation = this.libraryGenerations.get(context.libraryId) ?? 0;
    const previous = this.windows.get(key);
    if (previous && previous.identity === identity && previous.generation === generation && (previous.expiresAt > Date.now() || previous.activeRequests > 0)) return previous;
    for (const [cachedKey, cached] of this.windows) {
      if (cached.activeRequests === 0 && (cached.expiresAt <= Date.now() || cachedKey === key)) this.windows.delete(cachedKey);
    }
    if (this.windows.size >= DynamicContentCatalog.MAX_WINDOWS) {
      const idleKey = [...this.windows].find(([, cached]) => cached.activeRequests === 0)?.[0];
      if (idleKey) this.windows.delete(idleKey);
      else throw new ApiError(503, "content_browse_busy", "动态浏览请求较多，请稍后重试");
    }
    const window: CategoryWindow = { libraryId: context.libraryId, identity, generation, expiresAt: Date.now() + DynamicContentCatalog.WINDOW_TTL_MS, activeRequests: 0, pages: new Map(), pendingPages: new Map(), indexes: new Map() };
    this.windows.set(key, window);
    return window;
  }

  /** 处理中重新核对当前查询范围，插件版本或分类配置变化不能沿用旧候选。 */
  private async assertContext(context: DynamicCatalogContext): Promise<void> {
    const current = await this.loadContext(context.libraryId, context.userId, context.query);
    if (current.identity !== context.identity) throw new ApiError(409, "content_catalog_changed", "目录范围在加载期间发生变化，请重新加载");
  }

  /** 源页只做临时解析，将媒体 URL 剥离后才短时缓存候选目录。 */
  private async sourcePage(context: DynamicCatalogContext, window: CategoryWindow, page: number, signal: AbortSignal): Promise<CachedSourcePage> {
    const cached = window.pages.get(page);
    if (cached) return cached;
    const pending = window.pendingPages.get(page);
    if (pending) return pending;
    const operation = (async () => {
      await this.assertContext(context);
      signal.throwIfAborted();
      if (context.categoryIds.length === 0) return { candidates: [], rawItemCount: 0, sourcePageCount: 1 };
      const result = context.query.kind === "search"
        ? await context.adapter.search(context.query.searchTerm, page, context.query.categoryId, signal)
        : await context.adapter.page(context.query.categoryId, page, signal);
      // 关键变量：仅 Python 明确标记的卡片允许尚无分集；CMS 仍要求完整播放目录。
      // 搜索可能跨全站，必须继续用真实分类精确筛选，不能把卡片挂到当前查询类别。
      const candidates = result.items.filter((content) => (content.episodes.length > 0
        || context.manifest.adapter === "python_spider" && content.detailState === "card") && context.categoryIds.includes(content.categoryId)
        && !categoryMatches(content.categoryId, context.manifest.excludedCategoryIds ?? [], context.categories))
        .map((content): CmsCatalogContentItem => ({ ...content, episodes: content.episodes.map(({ url: _url, playbackId: _playbackId, ...episode }) => episode) }));
      const sourcePage = { candidates, rawItemCount: result.rawItemCount, sourcePageCount: result.sourcePageCount };
      window.pages.set(page, sourcePage);
      while (window.pages.size > DynamicContentCatalog.MAX_CACHED_PAGES) window.pages.delete(window.pages.keys().next().value!);
      return sourcePage;
    })();
    window.pendingPages.set(page, operation);
    try { return await operation; }
    finally { window.pendingPages.delete(page); }
  }

  /** 补足请求页和一个真实可查询条目作为下一页依据，未写入候选不计入 TotalRecordCount。 */
  private async extendIndex(context: DynamicCatalogContext, window: CategoryWindow, index: CategoryIndex, startIndex: number, limit: number, itemTypes: string[], prefetchTarget?: () => number): Promise<ContentSourceBrowseResult> {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后浏览");
    if (this.pausedLibraries.has(context.libraryId) || window.generation !== (this.libraryGenerations.get(context.libraryId) ?? 0)) throw new ApiError(409, "content_catalog_changing", "媒体库正在修改目录，请稍后浏览");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DynamicContentCatalog.REQUEST_BUDGET_MS);
    this.controllers.add(controller);
    const libraryControllers = this.libraryControllers.get(context.libraryId) ?? new Set<AbortController>();
    libraryControllers.add(controller);
    this.libraryControllers.set(context.libraryId, libraryControllers);
    let newPages = 0;
    // 关键变量：总数只含已成功持久化的索引，额外一个实际条目让客户端能够继续请求下一页。
    const targetCount = () => prefetchTarget?.() ?? startIndex + limit + 1;
    try {
      await this.assertContext(context);
      // 清空目录、迁类或同步停用线路后不继续返回旧索引，重新读取源页建立当前可查询集合。
      if (!await this.validateIndex(context, index.itemIds, itemTypes)) {
        index.itemIds = [];
        index.itemIdSet.clear();
        index.remoteIdSet.clear();
        index.sourcePage = 1;
        index.candidateOffset = 0;
        index.completed = false;
        window.pages.clear();
      }
      while (index.itemIds.length < targetCount() && !index.completed) {
        controller.signal.throwIfAborted();
        if (!window.pages.has(index.sourcePage) && !window.pendingPages.has(index.sourcePage)) {
          if (newPages >= DynamicContentCatalog.MAX_NEW_PAGES) throw new ApiError(503, "content_browse_scan_limit", "当前范围有效条目较少，本次查询已达扫描预算，请重试继续加载");
          newPages += 1;
        }
        const page = await this.sourcePage(context, window, index.sourcePage, controller.signal);
        while (index.candidateOffset < page.candidates.length && index.itemIds.length < targetCount()) {
          controller.signal.throwIfAborted();
          // 关键变量：仅并发本次前台或预取目标范围；同批远端身份去重。
          const batchLimit = Math.min(DynamicContentCatalog.MAX_PERSIST_CONCURRENCY, targetCount() - index.itemIds.length);
          const batch: Array<{ content: CmsCatalogContentItem; offset: number }> = [];
          const batchRemoteIds = new Set<string>();
          let nextOffset = index.candidateOffset;
          while (nextOffset < page.candidates.length && batch.length < batchLimit) {
            const content = page.candidates[nextOffset]!;
            if (!index.remoteIdSet.has(content.id) && !batchRemoteIds.has(content.id)) {
              batch.push({ content, offset: nextOffset });
              batchRemoteIds.add(content.id);
            }
            nextOffset += 1;
          }
          // 整批收尾后才返回错误，清空、删除和停机等待的请求不会遗漏后台写入。
          const results = await Promise.allSettled(batch.map(({ content }) => Promise.resolve()
            .then(() => this.persist(context, content, itemTypes, controller.signal))));
          for (const [position, candidate] of batch.entries()) {
            const result = results[position]!;
            // 只提交成功的连续前缀；失败后的成功项重试时幂等复用，不能提前排到失败项之前。
            if (result.status === "rejected") {
              index.candidateOffset = candidate.offset;
              throw result.reason;
            }
            controller.signal.throwIfAborted();
            const itemId = result.value;
            if (itemId && !index.itemIdSet.has(itemId)) {
              index.itemIds.push(itemId);
              index.itemIdSet.add(itemId);
            }
            index.remoteIdSet.add(candidate.content.id);
            index.candidateOffset = candidate.offset + 1;
          }
          index.candidateOffset = nextOffset;
        }
        if (index.candidateOffset >= page.candidates.length) {
          if (page.rawItemCount === 0 || (page.sourcePageCount !== null && index.sourcePage >= page.sourcePageCount)) index.completed = true;
          else { index.sourcePage += 1; index.candidateOffset = 0; }
        }
      }
      controller.signal.throwIfAborted();
      await this.assertContext(context);
      // 同步可能在扩展期间停用某条线路；返回前再确认计数中的每个父条目仍可查询。
      if (!await this.validateIndex(context, index.itemIds, itemTypes)) throw new ApiError(409, "content_catalog_changed", "分类目录在加载期间发生变化，请重新浏览");
      controller.signal.throwIfAborted();
      return { itemIds: index.itemIds.slice(startIndex, startIndex + limit), startIndex, totalRecordCount: index.itemIds.length, totalIsExact: index.completed, hasMore: index.itemIds.length > startIndex + limit, sort: "source_default" };
    } catch (error) {
      if (this.pausedLibraries.has(context.libraryId)) throw new ApiError(409, "content_catalog_changing", "媒体库正在修改目录，请稍后浏览");
      if (controller.signal.aborted && !this.closing) throw new ApiError(503, "content_browse_timeout", "动态目录加载达到本次时间预算，请重试继续已缓存的进度");
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      libraryControllers.delete(controller);
      if (libraryControllers.size === 0) this.libraryControllers.delete(context.libraryId);
    }
  }
}
