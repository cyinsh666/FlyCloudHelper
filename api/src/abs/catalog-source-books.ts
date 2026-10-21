import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { AUDIOBOOK_SEARCH_CATEGORY } from "../content-sources/audiobook-types.js";
import { listAbsBookSummaries, type AbsBookSummaryPage } from "./catalog.js";
import { loadAbsBookSummaries } from "./catalog-summary.js";
import { absLibraryView, withAbsLibraryViews } from "./library-views.js";
import type { AbsContext } from "./types.js";

/** 一次浏览只缓存稳定书籍 ID；源页追加后不重新排列已展示的书籍。 */
interface AbsSourceBrowseWindow {
  ids: string[];
  seen: Set<string>;
  nextSourcePage: number;
  hasMore: boolean;
  refreshedAt: number;
  expiresAt: number;
  pending?: Promise<void>;
}

/** 将源站页转换为标准 ABS page/limit 分页，不要求客户端识别自定义游标。 */
export class AbsSourceBookCatalog {
  private readonly windows = new Map<string, AbsSourceBrowseWindow>();

  /** 仅在线库的全部书籍和源分类目录读取源站，其他筛选保留原有索引语义。 */
  public async read(runtime: ApiRuntime, originalContext: AbsContext, query: Record<string, unknown>): Promise<AbsBookSummaryPage | null> {
    const page = Number(query.page ?? 0);
    const limit = Number(query.limit ?? 0);
    // limit=0 是标准不分页接口；不能为了统计、筛选器或第三方请求抓取整个源站。
    if (limit === 0 || String(query.q ?? "").trim()
      || [true, "1", "true"].includes(query.collapseseries as string | boolean)) return null;
    const context = await withAbsLibraryViews(runtime, originalContext);
    const library = await runtime.repository.getLibrary(context.libraryId, context.ownerUserId);
    if (String(library.libraryKind) !== "content_source_audiobook") return null;
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(limit) || limit < 0)
      throw new ApiError(400, "abs_page_invalid", "ABS 分页参数无效");
    const binding = await runtime.contentAudiobooks.getLibrary(context.libraryId, context.ownerUserId);
    const view = absLibraryView(context);
    let categoryId = view.categoryId ?? undefined;
    if (categoryId === AUDIOBOOK_SEARCH_CATEGORY) return null;
    if (query.filter) {
      const filter = String(query.filter);
      if (!filter.startsWith("genres.")) return null;
      let name: string;
      try {
        name = Buffer.from(decodeURIComponent(filter.slice("genres.".length)), "base64").toString("utf8");
      } catch {
        throw new ApiError(400, "abs_filter_invalid", "ABS 筛选参数无效");
      }
      const category = [...binding.configuration.categories, ...binding.configuration.categoryCatalog]
        .find((entry) => entry.name === name && binding.configuration.categoryIds.includes(entry.id));
      // 真实题材等非来源分类继续使用本地筛选；不能把它们当成源站分类 ID。
      if (!category || categoryId && categoryId !== category.id) return null;
      categoryId = category.id;
    }
    await runtime.contentAudiobooks.assertLibraryAvailable(context.libraryId, context.ownerUserId);
    const end = (page + 1) * limit;
    if (!Number.isSafeInteger(end) || end >= Number.MAX_SAFE_INTEGER)
      throw new ApiError(400, "abs_page_invalid", "ABS 分页范围无效");
    // 关键变量：隔离真实库、分类视图、账号、来源版本和排序，后台摘要新增不改变浏览偏移。
    const key = JSON.stringify([context.ownerUserId, context.libraryId, context.viewLibraryId, context.accountId,
      context.credentialRevision, binding.source.id, binding.source.pluginVersion, binding.source.updatedAt,
      binding.configuration.categoryIds, categoryId, query.filter ?? "", query.sort ?? "", query.desc ?? "0"]);
    const window = this.window(key, page === 0);
    // 同一浏览窗口串行扩充；前一次失败保留已成功的源页，下次从失败页继续。
    const pending = (window.pending ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await this.extend(runtime, context, query, categoryId, window, end + 1);
    });
    window.pending = pending;
    try {
      await pending;
      const ids = window.ids.slice(page * limit, end);
      const summaries = await loadAbsBookSummaries(runtime, context, ids);
      const byId = new Map(summaries.map((book) => [book.item.id, book]));
      return {
        books: ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
        // total 只统计本次浏览已确认的真实摘要；多确认至少一条，旧客户端即可继续翻页。
        total: window.ids.length, limit, page, collapseseries: false, collapsed: new Map(),
      };
    } finally {
      window.expiresAt = Date.now() + 10 * 60000;
      if (window.pending === pending) window.pending = undefined;
    }
  }

  /** 浏览缓存只存在内存，最多保留 64 个空闲窗口，不增加数据库结构或持久任务。 */
  private window(key: string, firstPage: boolean): AbsSourceBrowseWindow {
    for (const [entry, window] of this.windows)
      if (!window.pending && window.expiresAt <= Date.now()) this.windows.delete(entry);
    const existing = this.windows.get(key);
    // 返回首页一分钟后允许重新读取最新摘要；连续加载下一页始终沿用原偏移。
    if (existing && (!firstPage || existing.pending || Date.now() - existing.refreshedAt < 60000)) return existing;
    if (existing) this.windows.delete(key);
    while (this.windows.size >= 64) {
      const idle = [...this.windows].find(([, window]) => !window.pending);
      if (!idle) throw new ApiError(503, "abs_catalog_busy", "听书目录正在加载，请稍后重试");
      this.windows.delete(idle[0]);
    }
    const created: AbsSourceBrowseWindow = {
      ids: [], seen: new Set(), nextSourcePage: 1, hasMore: true,
      refreshedAt: Date.now(), expiresAt: Date.now() + 10 * 60000,
    };
    this.windows.set(key, created);
    return created;
  }

  /** 填满当前小页并确认一条续页记录；末页、空页和跨分类重复均按真实源结果处理。 */
  private async extend(runtime: ApiRuntime, context: AbsContext, query: Record<string, unknown>, categoryId: string | undefined,
    window: AbsSourceBrowseWindow, target: number): Promise<void> {
    const signal = AbortSignal.timeout(30000);
    let sourcePages = 0;
    while (window.ids.length < target && window.hasMore) {
      // 长串被过滤的源页分多次重试完成，不能阻塞一个请求遍历整个来源，也不能伪装成末页。
      if (sourcePages >= 20 || signal.aborted)
        throw new ApiError(503, "abs_catalog_preparing", "听书目录正在读取，请稍后重试");
      const result = await runtime.contentAudiobooks.browsePage(context.libraryId, context.ownerUserId,
        window.nextSourcePage, categoryId, signal);
      const ordered = await listAbsBookSummaries(runtime, context, { ...query, page: 0, limit: 0 }, result.ids);
      // 排序只作用于新源窗口；旧页保持稳定，不为全库排序而预先读取全部摘要。
      for (const book of ordered.books) {
        if (window.seen.has(book.item.id)) continue;
        window.seen.add(book.item.id);
        window.ids.push(book.item.id);
      }
      window.nextSourcePage += 1;
      window.hasMore = result.hasMore;
      sourcePages += 1;
    }
  }
}
