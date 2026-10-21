import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { NativeContext } from "./types.js";
import { nativeHash } from "./store.js";
import { makeCatalogCursor, readCatalogCursor } from "./catalog-query.js";
import { NativeCatalogSearch } from "./catalog-search.js";

/** 一个真实源页可拆成多个客户端小页，不保存整库或提前读取下一源页。 */
export class NativeSourceBooks {
  private readonly windows = new NativeCatalogSearch();

  /** 全部书籍和分类书籍共用源窗口，账号、筛选及排序各自绑定游标。 */
  public async read(context: NativeContext, runtime: ApiRuntime, libraryId: string, query: Record<string, unknown>,
    categoryId: string | undefined, sort: string, order: string, limit: number): Promise<{ ids: string[]; revision: string; next: string | null; previous: string | null }> {
    const binding = await runtime.contentAudiobooks.getLibrary(libraryId, context.service.OwnerUserId);
    await runtime.contentAudiobooks.assertLibraryAvailable(libraryId, context.service.OwnerUserId);
    const revision = nativeHash(JSON.stringify([binding.source.id, binding.source.pluginVersion, binding.source.updatedAt, binding.configuration.categoryIds]));
    const scope = [context.service.ServiceId, context.account.AccountId, libraryId, "source-books", categoryId, sort, order];
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    const page = cursor?.page ?? 1;
    const offset = cursor ? Number(cursor.id ?? 0) : 0;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 20000)
      throw new ApiError(400, "invalid_cursor", "书籍目录游标无效");
    const key = nativeHash(JSON.stringify([...scope, revision, page]));
    const window = await this.windows.read(key, async (signal) => {
      const result = await runtime.contentAudiobooks.browsePage(libraryId, context.service.OwnerUserId, page, categoryId, signal);
      // 源页决定浏览范围，排序只作用于当前源窗口；不能先抓全库再排序。
      const column = sort === "Title" ? "sort_title" : sort === "AddedAt" ? "created_at" : "updated_at";
      const rows = result.ids.length ? await runtime.database.query("media_items")
        .where({ user_id: context.service.OwnerUserId, library_id: libraryId, item_type: "audiobook.book" }).whereNull("deleted_at")
        .whereIn("id", result.ids).select("id").orderBy(column, order === "Asc" ? "asc" : "desc").orderBy("id", "asc") : [];
      return { ids: rows.map((row) => String(row.id)), hasMore: result.hasMore };
    });
    if (offset > 0 && cursor?.value !== window.revision) throw new ApiError(409, "catalog_changed", "源目录已变化，请重新打开列表");
    const start = cursor?.direction === "previous" && offset === 0
      ? Math.floor(Math.max(0, window.ids.length - 1) / limit) * limit : offset;
    const ids = window.ids.slice(start, start + limit);
    const within = start + ids.length < window.ids.length;
    const next = within ? makeCatalogCursor(scope, revision, { page, id: String(start + ids.length), value: window.revision })
      : window.hasMore ? makeCatalogCursor(scope, revision, { page: page + 1, id: "0" }) : null;
    const previous = start > 0 ? makeCatalogCursor(scope, revision, { page, id: String(Math.max(0, start - limit)), value: window.revision })
      : page > 1 ? makeCatalogCursor(scope, revision, { page: page - 1, id: "0", direction: "previous" }) : null;
    return { ids, revision, next, previous };
  }
}
