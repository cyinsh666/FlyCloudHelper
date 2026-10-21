import type { Knex } from "knex";
import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { audiobookContentSource, audiobookSourceCategories } from "../content-sources/audiobook-catalog.js";
import type { NativeAccess } from "./access.js";
import type { NativeContext, NativeQuery } from "./types.js";
import { NativeStore, nativeHash, nativeKey } from "./store.js";
import { nativeLocalChapters } from "./local-chapters.js";
import { NativeCatalogSearch } from "./catalog-search.js";
import { NativeSourceBooks } from "./catalog-source-books.js";
import { boundedText, catalogJson, catalogLimit, catalogNames, catalogPage, catalogText, makeCatalogCursor, nativeCatalogItem, readCatalogCursor, whereCatalogArray } from "./catalog-query.js";

/** 目录装配只批量请求当前页用户状态，不引用完整账号对象。 */
export interface NativeCatalogState {
  chapterStates(context: NativeContext, chapterIds: string[]): Promise<Record<string, unknown>>;
  syncRevision(context: NativeContext): Promise<string>;
  progress(context: NativeContext, bookId: string): Promise<Record<string, unknown>>;
}

/** 原生目录直接读取已授权条目；不复用 ABS 全书投影或通用媒体统计。 */
export class NativeCatalog {
  private readonly searches = new NativeCatalogSearch();
  private readonly sourceBooks = new NativeSourceBooks();

  public constructor(private readonly runtime: ApiRuntime, private readonly store: NativeStore, private readonly access: NativeAccess) {}

  /** 所有目录读取固定实际库和所有者，条目中的路径不参与授权。 */
  private items(context: NativeContext, query: NativeQuery = this.runtime.database.query): Knex.QueryBuilder {
    return query("media_items as m").join("media_libraries as l", "l.id", "m.library_id")
      .where({ "m.user_id": context.service.OwnerUserId, "l.user_id": context.service.OwnerUserId, "l.status": "active", "l.data_type": "audiobook" })
      .whereIn("m.library_id", this.access.visibleLibraryIds(context)).whereNull("m.deleted_at");
  }

  /** 仅读一条媒体行，供状态与单章播放的轻量身份校验。 */
  public async assertBook(context: NativeContext, bookId: string): Promise<MediaItemRecord> {
    const row = await this.items(context).where({ "m.id": bookId, "m.item_type": "audiobook.book" })
      .select("m.*", "l.library_kind", "l.display_name as service_name").first();
    if (!row) throw new ApiError(404, "book_unavailable", "有声书不存在或当前账号无权访问");
    await this.access.assertLibrary(context, String(row.library_id));
    if (row.library_kind === "content_source_audiobook")
      await this.runtime.contentAudiobooks.assertLibraryAvailable(String(row.library_id), context.service.OwnerUserId);
    return nativeCatalogItem(row);
  }

  /** 章、书、库和真实父子关系必须同时匹配，不能替换 ID 越权播放。 */
  public async assertChapter(context: NativeContext, bookId: string, chapterId: string): Promise<MediaItemRecord> {
    const book = await this.assertBook(context, bookId);
    if (book.libraryKind !== "content_source_audiobook") return nativeLocalChapters(this.runtime).assertChapter(context, bookId, chapterId);
    const row = await this.chapterQuery(context, book).where("m.id", chapterId)
      .select("m.*", "l.library_kind", "l.display_name as service_name", "r.sort_order as native_order").first();
    if (!row) throw new ApiError(404, "chapter_unavailable", "章节不存在或已从作品中移除");
    const chapter = nativeCatalogItem(row);
    chapter.metadata.nativeOrder = Number(row.native_order);
    return chapter;
  }

  /** 邻章读取限制为下一条关系，不展开整书来寻找当前章。 */
  public async nextChapter(context: NativeContext, bookId: string, chapterId: string): Promise<MediaItemRecord | null> {
    const book = await this.assertBook(context, bookId);
    if (book.libraryKind !== "content_source_audiobook") return nativeLocalChapters(this.runtime).nextChapter(context, bookId, chapterId);
    const chapter = await this.assertChapter(context, bookId, chapterId);
    const order = Number(chapter.metadata.nativeOrder);
    const row = await this.chapterQuery(context, book).where((builder) => builder.where("r.sort_order", ">", order)
      .orWhere((same) => same.where("r.sort_order", order).where("m.id", ">", chapterId)))
      .orderBy("r.sort_order", "asc").orderBy("m.id", "asc")
      .select("m.*", "l.library_kind", "r.sort_order as native_order").first();
    if (!row) return null;
    const item = nativeCatalogItem(row);
    item.metadata.nativeOrder = Number(row.native_order);
    return item;
  }

  /** 父子查询先限定实际库和双方所有者，关系无法跨库串联。 */
  private chapterQuery(context: NativeContext, book: MediaItemRecord): Knex.QueryBuilder {
    return this.items(context).join("media_relations as r", "r.child_item_id", "m.id")
      .where({ "m.library_id": book.libraryId, "m.item_type": "audiobook.chapter", "r.user_id": context.service.OwnerUserId,
        "r.library_id": book.libraryId, "r.parent_item_id": book.id, "r.relation_type": "book_chapter" });
  }

  /** 可见库只在入口最多一百个已关联库内分页，不扫描其他用户媒体库。 */
  public async libraries(context: NativeContext, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const limit = catalogLimit(query);
    const ids = [...this.access.visibleLibraryIds(context)].sort();
    const revision = nativeHash(JSON.stringify([context.service.PermissionsRevision, context.account.PermissionsRevision, ids]));
    const scope = [context.service.ServiceId, context.account.AccountId, "libraries"];
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    const candidates = ids.filter((id) => !cursor?.id || id > cursor.id);
    const values: Record<string, unknown>[] = [];
    let last: string | null = null;
    for (const id of candidates) {
      last = id;
      try {
        const library = await this.access.assertLibrary(context, id);
        if (library.libraryKind === "content_source_audiobook")
          await this.runtime.contentAudiobooks.assertLibraryAvailable(id, context.service.OwnerUserId);
        values.push({ LibraryId: id, Name: boundedText(library.displayName), Capabilities: {
          Categories: true, RealtimeSearch: library.libraryKind === "content_source_audiobook",
          ChapterPlayback: true, ChapterPagination: true, UnknownDuration: true,
          Downloads: context.account.CanDownload, SourceCatalogMode: "RandomPage",
        } });
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 409].includes(error.statusCode)) throw error;
      }
      if (values.length >= limit) break;
    }
    const hasMore = last !== null && candidates.some((id) => id > last!);
    return catalogPage(values, revision, hasMore ? makeCatalogCursor(scope, revision, { id: last! }) : null);
  }

  /** 摘要只投影白名单字段；封面使用协议入口，不暴露源站长签名地址。 */
  public async summary(context: NativeContext, item: MediaItemRecord): Promise<Record<string, unknown>> {
    const source = audiobookContentSource(item.metadata);
    const count = Number(item.metadata.chapterCount ?? item.metadata.audioFileCount);
    const categoryValues = item.libraryKind === "content_source_audiobook" ? audiobookSourceCategories(source).slice(0, 30)
      : (Array.isArray(item.metadata.genres) ? item.metadata.genres : []).filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 30).map((name) => ({ id: name, name }));
    const categories = await Promise.all(categoryValues.map(async (entry) => ({
      CategoryId: await this.rememberDimension(item.libraryId, item.libraryKind === "content_source_audiobook" ? "source-category" : "genres", entry.id),
      Name: boundedText(entry.name),
    })));
    return {
      BookId: item.id, LibraryId: item.libraryId, Title: boundedText(item.title), TitleTruncated: boundedText(item.title) !== item.title,
      CoverUrl: item.posterUrl ? `${context.basePath}/api/v1/Books/${encodeURIComponent(item.id)}/Cover` : null,
      Authors: catalogNames(item.metadata.authors), Narrators: catalogNames(item.metadata.narrators),
      Categories: categories,
      ChapterCount: Number.isSafeInteger(count) && count >= 0 ? count : null, UpdatedAt: item.updatedAt,
    };
  }

  /** 库列表版本只跟随可见内容更新，进度和检查时间不影响列表游标。 */
  private async libraryRevision(context: NativeContext, libraryId: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries").where({ id: libraryId, user_id: context.service.OwnerUserId }).select("catalog_version").first();
    if (!row) throw new ApiError(404, "library_unavailable", "听书媒体库不存在");
    return String(row.catalog_version);
  }

  /** 使用书和当前章节的已提交变更版本，其他作品更新不会使本书目录失效。 */
  public async bookRevision(context: NativeContext, book: MediaItemRecord): Promise<string> {
    if (book.libraryKind === "content_source_audiobook") {
      const directory = await this.runtime.contentAudiobooks.getBookDirectoryState(book.libraryId, context.service.OwnerUserId, book.id);
      return directory.catalogRevision;
    }
    return nativeLocalChapters(this.runtime).bookRevision(context, book);
  }

  /** 精确分类筛选兼容历史主分类，搜索未分类条目不被强行加入分类。 */
  private filterCategory(builder: Knex.QueryBuilder, categoryId: string): void {
    const runtime = this.runtime;
    builder.where((filter) => {
      filter.whereRaw("? = ?", [catalogJson(runtime, "m.metadata_json", "contentSource.categoryId"), categoryId])
        .orWhere((member) => whereCatalogArray(runtime, member, "contentSource.categories", categoryId, "id"))
        .orWhere((genre) => whereCatalogArray(runtime, genre, "genres", categoryId));
    });
  }

  /** 书籍先在数据库排序续页，再组装当前页摘要，不附加章节和文件统计。 */
  public async books(context: NativeContext, libraryId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const library = await this.access.assertLibrary(context, libraryId);
    const limit = catalogLimit(query);
    const categoryId = catalogText(query.categoryId, "分类", 128);
    const seriesId = catalogText(query.seriesId, "系列", 128);
    const sort = String(query.sort ?? "UpdatedAt");
    const order = String(query.order ?? "Desc");
    if (!["Title", "AddedAt", "UpdatedAt"].includes(String(sort)) || !["Asc", "Desc"].includes(String(order)))
      throw new ApiError(400, "invalid_sort", "排序字段或方向无效");
    if (library.libraryKind === "content_source_audiobook" && !seriesId) {
      let sourceCategoryId: string | undefined;
      if (categoryId) {
        const category = await this.store.get<{ LibraryId: string; Dimension: string; Name: string; Id: string }>(nativeKey("dimension", libraryId, "source-category", categoryId));
        if (!category || category.value.LibraryId !== libraryId || category.value.Dimension !== "source-category" || category.value.Id !== categoryId)
          throw new ApiError(404, "category_unavailable", "分类不存在，请重新读取分类列表");
        sourceCategoryId = category.value.Name;
      }
      const page = await this.sourceBooks.read(context, this.runtime, libraryId, query, sourceCategoryId, sort, order, limit);
      const rows: Record<string, unknown>[] = page.ids.length ? await this.items(context)
        .where({ "m.library_id": libraryId, "m.item_type": "audiobook.book" }).whereIn("m.id", page.ids).select("m.*", "l.library_kind") : [];
      const byId = new Map(rows.map((row) => [String(row.id), nativeCatalogItem(row)]));
      if (byId.size !== page.ids.length) throw new ApiError(409, "catalog_changed", "书籍目录已变化，请重新读取");
      return catalogPage(await Promise.all(page.ids.map((id) => this.summary(context, byId.get(id)!))), page.revision, page.next, page.previous);
    }
    const column = sort === "Title" ? "m.sort_title" : sort === "AddedAt" ? "m.created_at" : "m.updated_at";
    const scope = [context.service.ServiceId, context.account.AccountId, libraryId, "books", categoryId, seriesId, sort, order];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await this.libraryRevision(context, libraryId);
      const cursor = readCatalogCursor(query.cursor, scope, revision);
      const builder = this.items(context).where({ "m.library_id": libraryId, "m.item_type": "audiobook.book" });
      if (categoryId) {
        // 关键变量：分类使用短身份，原始名称/来源ID只保留在小映射中，不截断SQL筛选值。
        const dimension = library.libraryKind === "content_source_audiobook" ? "source-category" : "genres";
        const category = await this.store.get<{ LibraryId: string; Dimension: string; Name: string; Id: string }>(nativeKey("dimension", libraryId, dimension, categoryId));
        if (!category || category.value.LibraryId !== libraryId || category.value.Dimension !== dimension || category.value.Id !== categoryId)
          throw new ApiError(404, "category_unavailable", "分类不存在，请重新读取分类列表");
        if (dimension === "genres") whereCatalogArray(this.runtime, builder, "genres", category.value.Name);
        else this.filterCategory(builder, category.value.Name);
      }
      if (seriesId) {
        const series = await this.store.get<{ LibraryId: string; SeriesId: string; Name: string }>(nativeKey("series", libraryId, seriesId));
        if (!series || series.value.LibraryId !== libraryId || series.value.SeriesId !== seriesId) throw new ApiError(404, "series_unavailable", "系列不存在");
        const name = series.value.Name;
        builder.where((filter) => filter.whereRaw("? = ?", [catalogJson(this.runtime, "m.metadata_json", "seriesName"), name])
          .orWhere((member) => whereCatalogArray(this.runtime, member, "series", name, "name"))
          .orWhere((member) => whereCatalogArray(this.runtime, member, "series", name)));
      }
      if (cursor?.id) {
        // 关键变量：锚点只传稳定书ID，完整标题可能很长，不能截断后用于下一页比较。
        const anchor = await this.items(context).where({ "m.id": cursor.id, "m.library_id": libraryId, "m.item_type": "audiobook.book" }).select(column).first();
        if (!anchor) throw new ApiError(409, "catalog_changed", "分页锚点已变化，请重新读取");
        const value = String(anchor[column.slice(2)]);
        builder.where((filter) => filter.where(column, order === "Asc" ? ">" : "<", value)
          .orWhere((same) => same.where(column, value).where("m.id", ">", cursor.id!)));
      }
      const rows: Record<string, unknown>[] = await builder.select("m.*", "l.library_kind").orderBy(column, order === "Asc" ? "asc" : "desc").orderBy("m.id", "asc").limit(limit + 1);
      if (revision !== await this.libraryRevision(context, libraryId)) continue;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      const next = rows.length > limit && last ? makeCatalogCursor(scope, revision, { id: String(last.id) }) : null;
      return catalogPage(await Promise.all(pageRows.map((row) => this.summary(context, nativeCatalogItem(row)))), revision, next);
    }
    throw new ApiError(503, "consistent_read_retry_required", "目录正在更新，请稍后重试");
  }

  /** 在线分类来自已保存的真实分类目录，读取首页不发起源站网络请求。 */
  public async categories(context: NativeContext, libraryId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const library = await this.access.assertLibrary(context, libraryId);
    if (library.libraryKind === "content_source_audiobook") {
      await this.runtime.contentAudiobooks.assertLibraryAvailable(libraryId, context.service.OwnerUserId);
      const { configuration } = await this.runtime.contentAudiobooks.getLibrary(libraryId, context.service.OwnerUserId);
      const entries = await Promise.all(configuration.categories.map(async (item) => ({ CategoryId: await this.rememberDimension(libraryId, "source-category", item.id), Name: boundedText(item.name), BookCount: null })));
      return this.smallPage(context, "categories", libraryId, query, entries, "CategoryId");
    }
    const entries = await this.dimensionNames(context, libraryId, "genres", query);
    const items = await Promise.all(entries.names.map(async (name) => ({ CategoryId: await this.rememberDimension(libraryId, "genres", name), Name: boundedText(name), BookCount: null })));
    return catalogPage(items, entries.revision, entries.next);
  }

  /** 只有真实作品系列生成稳定 ID，名称映射用于精确 SQL 筛选。 */
  public async series(context: NativeContext, libraryId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.access.assertLibrary(context, libraryId);
    const page = await this.dimensionNames(context, libraryId, "series", query);
    const entries = await Promise.all(page.names.map((name) => this.seriesEntry(libraryId, name)));
    return catalogPage(entries, page.revision, page.next);
  }

  /** 小型配置目录已限制最多一百个关联项，只在这类有限数据中切页。 */
  private smallPage(context: NativeContext, kind: string, libraryId: string, query: Record<string, unknown>, entries: Record<string, unknown>[], idField: string): Record<string, unknown> {
    const limit = catalogLimit(query);
    const revision = nativeHash(JSON.stringify(entries));
    const scope = [context.service.ServiceId, context.account.AccountId, libraryId, kind];
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    const sorted = entries.sort((a, b) => String(a[idField]).localeCompare(String(b[idField])));
    const remaining = sorted.filter((entry) => !cursor?.id || String(entry[idField]).localeCompare(cursor.id) > 0);
    const page = remaining.slice(0, limit);
    return catalogPage(page, revision, remaining.length > limit ? makeCatalogCursor(scope, revision, { id: String(page.at(-1)![idField]) }) : null, null, entries.length);
  }

  /** 数组名称在数据库展开去重后分页，不把全库书籍元数据拉到应用层。 */
  private async dimensionNames(context: NativeContext, libraryId: string, dimension: "genres" | "series", query: Record<string, unknown>): Promise<{ names: string[]; revision: string; next: string | null }> {
    const revision = await this.libraryRevision(context, libraryId);
    const scope = [context.service.ServiceId, context.account.AccountId, libraryId, dimension];
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    const limit = catalogLimit(query);
    const base = this.items(context).where({ "m.library_id": libraryId, "m.item_type": "audiobook.book" });
    const database = this.runtime.database;
    let name: Knex.Raw;
    if (database.databaseType === "postgres") {
      const array = "NULLIF(m.metadata_json, '')::jsonb -> ?";
      base.joinRaw(`CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${array}) = 'array' THEN ${array} ELSE '[]'::jsonb END) AS native_dimension(value)`, [dimension, dimension]);
      name = database.query.raw("CASE WHEN jsonb_typeof(native_dimension.value) = 'string' THEN native_dimension.value #>> '{}' ELSE native_dimension.value ->> 'name' END");
    } else if (database.databaseType === "mysql") {
      base.joinRaw("JOIN JSON_TABLE(CASE WHEN JSON_VALID(m.metadata_json) THEN COALESCE(JSON_EXTRACT(m.metadata_json, ?), JSON_ARRAY()) ELSE JSON_ARRAY() END, '$[*]' COLUMNS (text_name LONGTEXT PATH '$' NULL ON ERROR, object_name LONGTEXT PATH '$.name' NULL ON ERROR)) AS native_dimension ON TRUE", [`$.${dimension}`]);
      name = database.query.raw("COALESCE(native_dimension.object_name, native_dimension.text_name)");
    } else {
      base.joinRaw("JOIN json_each(CASE WHEN json_valid(m.metadata_json) THEN m.metadata_json ELSE '{}' END, ?) AS native_dimension ON TRUE", [`$.${dimension}`]);
      name = database.query.raw("CASE WHEN native_dimension.type = 'text' THEN native_dimension.value ELSE json_extract(CASE WHEN native_dimension.type = 'object' THEN native_dimension.value ELSE '{}' END, '$.name') END");
    }
    const dimensions = base.select({ dimension_name: name });
    if (dimension === "series") {
      const legacy = this.items(context).where({ "m.library_id": libraryId, "m.item_type": "audiobook.book" })
        .select({ dimension_name: catalogJson(this.runtime, "m.metadata_json", "seriesName") });
      dimensions.union(legacy);
    }
    const namesQuery = database.query.from(dimensions.as("native_names")).whereNotNull("dimension_name").whereNot("dimension_name", "").distinct("dimension_name");
    if (cursor?.id) {
      const anchor = await this.store.get<{ LibraryId: string; Dimension: string; Name: string; Id: string }>(nativeKey("dimension", libraryId, dimension, cursor.id));
      if (!anchor || anchor.value.LibraryId !== libraryId || anchor.value.Dimension !== dimension || anchor.value.Id !== cursor.id)
        throw new ApiError(409, "catalog_changed", "分类或系列分页锚点已变化，请重新读取");
      namesQuery.where("dimension_name", ">", anchor.value.Name);
    }
    const rows = await namesQuery.orderBy("dimension_name", "asc").limit(limit + 1);
    if (revision !== await this.libraryRevision(context, libraryId)) throw new ApiError(409, "catalog_changed", "目录已更新，请重试");
    const names = rows.slice(0, limit).map((row) => String(row.dimension_name));
    const nextId = rows.length > limit ? await this.rememberDimension(libraryId, dimension, names.at(-1)!) : null;
    return { names, revision, next: nextId ? makeCatalogCursor(scope, revision, { id: nextId }) : null };
  }

  /** 原始维度值使用短身份映射，保持游标有界并保留完整精确筛选值。 */
  private async rememberDimension(libraryId: string, dimension: "genres" | "series" | "source-category", name: string): Promise<string> {
    const id = nativeHash(JSON.stringify([libraryId, dimension, name]));
    const key = nativeKey("dimension", libraryId, dimension, id);
    let current = await this.store.get<{ LibraryId: string; Dimension: string; Name: string; Id: string }>(key);
    if (!current) {
      try { await this.store.put(key, { LibraryId: libraryId, Dimension: dimension, Name: name, Id: id }, null); }
      catch (error) { if (!(error instanceof ApiError) || error.code !== "native_state_conflict") throw error; }
      current = await this.store.get(key);
    }
    if (!current || current.value.LibraryId !== libraryId || current.value.Dimension !== dimension || current.value.Name !== name || current.value.Id !== id)
      throw new ApiError(409, "catalog_changed", "分类或系列身份发生冲突，请重新读取");
    return id;
  }

  /** 系列映射是原生小索引，不复制作品和原始媒体库。 */
  private async seriesEntry(libraryId: string, name: string, order: unknown = null): Promise<Record<string, unknown>> {
    const id = nativeHash(JSON.stringify([libraryId, name]));
    const key = nativeKey("series", libraryId, id);
    const existing = await this.store.get(key);
    if (!existing) {
      try { await this.store.put(key, { LibraryId: libraryId, SeriesId: id, Name: name }, null); }
      catch (error) { if (!(error instanceof ApiError) || error.code !== "native_state_conflict") throw error; }
    }
    return { SeriesId: id, Name: boundedText(name), OrderInSeries: order === null || order === undefined ? null : boundedText(String(order)), BookCount: null };
  }

  /** 详情保留一个续听点，不返回全章、音轨、文件或书签数组。 */
  public async detail(context: NativeContext, bookId: string, state: NativeCatalogState): Promise<Record<string, unknown>> {
    const original = await this.assertBook(context, bookId);
    if (original.libraryKind === "content_source_audiobook")
      await this.runtime.contentAudiobooks.prepareBookDirectory(original.libraryId, context.service.OwnerUserId, original.id);
    else await nativeLocalChapters(this.runtime).prepare(context, original);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await this.bookRevision(context, original);
      const item = await this.assertBook(context, bookId);
      const directory = item.libraryKind === "content_source_audiobook"
        ? await this.runtime.contentAudiobooks.getBookDirectoryState(item.libraryId, context.service.OwnerUserId, item.id)
        : await nativeLocalChapters(this.runtime).prepare(context, item);
      const entities = Array.isArray(item.metadata.series) ? item.metadata.series : typeof item.metadata.seriesName === "string" ? [item.metadata.seriesName] : [];
      const series = await Promise.all(entities.slice(0, 30).flatMap((entry) => {
        const value = typeof entry === "string" ? { name: entry } : entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return typeof value.name === "string" && value.name ? [this.seriesEntry(item.libraryId, value.name, value.sequence)] : [];
      }));
      const duration = Number(item.metadata.durationMs);
      // 关键变量：本地逻辑目录自行汇总真实章时长，旧书行可能仅保存部分已知时长。
      const localDuration = "durationComplete" in directory ? directory : null;
      const complete = localDuration ? localDuration.durationComplete
        : directory.catalogComplete && item.metadata.durationPending !== true && Number.isFinite(duration) && duration > 0;
      const durationSeconds = localDuration ? localDuration.durationSeconds : complete ? duration / 1000 : null;
      const knownDurationSeconds = localDuration ? localDuration.knownDurationSeconds
        : Number.isFinite(duration) && duration > 0 ? duration / 1000 : null;
      const result = { ...await this.summary(context, item), Overview: boundedText(item.overview, 16000, 16384), Series: series,
        DurationSeconds: durationSeconds, DurationComplete: complete, KnownDurationSeconds: knownDurationSeconds,
        ChapterCatalogStatus: this.publicStatus(directory.status), CatalogComplete: directory.catalogComplete,
        ChapterCount: directory.catalogComplete ? directory.chapterCount : null,
        PublicationStatus: item.metadata.publicationStatus === "Finished" || item.metadata.publicationStatus === "Ongoing" ? item.metadata.publicationStatus : "Unknown",
        Progress: await state.progress(context, bookId),
      };
      if (revision === await this.bookRevision(context, original)) return result;
    }
    throw new ApiError(503, "consistent_read_retry_required", "作品资料正在更新，请稍后重试");
  }

  /** 宿主状态使用小写时只做显式协议枚举投影。 */
  private publicStatus(status: string): string {
    const values: Record<string, string> = { idle: "NotLoaded", not_loaded: "NotLoaded", preparing: "Preparing", running: "Preparing", ready: "Ready", complete: "Ready", failed: "Failed" };
    return values[status] ?? status;
  }

  /** 章节摘要限制为当前页必要字段，未知时长保持 null。 */
  private chapterSummary(item: MediaItemRecord, order: number, userState: unknown): Record<string, unknown> {
    const duration = Number(item.metadata.durationMs);
    const title = boundedText(item.title);
    return { ChapterId: item.id, Order: order + 1, Title: title, TitleTruncated: title !== item.title,
      DurationSeconds: Number.isFinite(duration) && duration > 0 ? duration / 1000 : null,
      UserState: userState ?? { PositionSeconds: null, Completed: false, Revision: "0" },
    };
  }

  /** 章节请求先按稳定锚点查询有限行，再批量附加该页个人状态。 */
  public async chapters(context: NativeContext, bookId: string, query: Record<string, unknown>, state: NativeCatalogState): Promise<Record<string, unknown>> {
    const limit = catalogLimit(query, 50);
    const supplied = [query.cursor, query.aroundChapterId, query.aroundOrder].filter((value) => value !== undefined);
    if (supplied.length > 1) throw new ApiError(400, "invalid_query", "目录游标和章节定位参数不能同时使用");
    const book = await this.assertBook(context, bookId);
    if (book.libraryKind !== "content_source_audiobook") return nativeLocalChapters(this.runtime).chapters(context, book, query, state);
    let directory = book.libraryKind === "content_source_audiobook"
      ? await this.runtime.contentAudiobooks.prepareBookDirectory(book.libraryId, context.service.OwnerUserId, bookId) : null;
    const scope = [context.service.ServiceId, context.account.AccountId, bookId, "chapters"];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await this.bookRevision(context, book);
      const userRevision = await state.syncRevision(context);
      const cursor = readCatalogCursor(query.cursor, scope, revision);
      let anchorId = cursor?.id;
      let anchorOrder = cursor ? Number(cursor.value) : null;
      let previous = cursor?.direction === "previous";
      let includeAnchor = false;
      let centered = false;
      if (query.aroundChapterId !== undefined) {
        const target = catalogText(query.aroundChapterId, "章节", 128)!;
        const anchor = await this.chapterQuery(context, book).where("m.id", target).select("m.id", "r.sort_order").first();
        if (!anchor) {
          if (directory && !directory.catalogComplete) return { Status: "Preparing", RetryAfterSeconds: 2, CatalogRevision: revision };
          throw new ApiError(404, "chapter_unavailable", "原章节已不可用，请重新选择");
        }
        anchorId = String(anchor.id); anchorOrder = Number(anchor.sort_order); centered = true;
      } else if (query.aroundOrder !== undefined) {
        const order = Number(query.aroundOrder);
        if (!Number.isSafeInteger(order) || order < 1) throw new ApiError(400, "invalid_query", "章节顺序必须为正整数");
        const target = await this.chapterQuery(context, book).where("r.sort_order", order - 1).select("m.id").first();
        if (!target) {
          if (directory && !directory.catalogComplete) return { Status: "Preparing", RetryAfterSeconds: 2, CatalogRevision: revision };
          throw new ApiError(404, "chapter_unavailable", "目标章节顺序不存在");
        }
        anchorOrder = order - 1; anchorId = ""; centered = true;
      }
      let builder = this.chapterQuery(context, book);
      if (centered && anchorOrder !== null) {
        // 关键变量：先取目标之前有限行的最早锚点，不遍历前面的所有页。
        const before = await this.chapterQuery(context, book).where("r.sort_order", "<", anchorOrder)
          .select("m.id", "r.sort_order").orderBy("r.sort_order", "desc").orderBy("m.id", "desc").limit(Math.floor(limit / 2));
        const start = before.at(-1);
        if (start) { anchorOrder = Number(start.sort_order); anchorId = String(start.id); }
        includeAnchor = true; previous = false;
      }
      if (anchorOrder !== null) {
        builder = builder.where((filter) => filter.where("r.sort_order", previous ? "<" : ">", anchorOrder!)
          .orWhere((same) => same.where("r.sort_order", anchorOrder!).where("m.id", previous ? "<" : includeAnchor ? ">=" : ">", anchorId ?? "")));
      }
      const rows: Record<string, unknown>[] = await builder.select("m.*", "l.library_kind", "r.sort_order as native_order")
        .orderBy("r.sort_order", previous ? "desc" : "asc").orderBy("m.id", previous ? "desc" : "asc").limit(limit + 1);
      let pageRows = rows.slice(0, limit);
      if (previous) pageRows = pageRows.reverse();
      const states = await state.chapterStates(context, pageRows.map((row) => String(row.id)));
      if (revision !== await this.bookRevision(context, book) || userRevision !== await state.syncRevision(context)) continue;
      if (!pageRows.length && directory && !directory.catalogComplete)
        return { Status: this.publicStatus(directory.status) === "Failed" ? "Failed" : "Preparing", RetryAfterSeconds: 2, CatalogRevision: revision };
      const items = pageRows.map((row) => this.chapterSummary(nativeCatalogItem(row), Number(row.native_order), states[String(row.id)]));
      // 关键变量：按实际 JSON 字节预算减少交付条数；未交付条目由正确游标续读。
      while (items.length && Buffer.byteLength(JSON.stringify({ Items: items }), "utf8") > 47000) {
        if (previous) { items.shift(); pageRows.shift(); }
        else { items.pop(); pageRows.pop(); }
      }
      if (!items.length && rows.length) throw new ApiError(502, "source_item_too_large", "单条章节资料超过响应预算");
      const first = pageRows[0];
      const last = pageRows.at(-1);
      const [hasBefore, hasAfter] = first && last ? await Promise.all([
        this.chapterQuery(context, book).where((filter) => filter.where("r.sort_order", "<", Number(first.native_order))
          .orWhere((same) => same.where("r.sort_order", Number(first.native_order)).where("m.id", "<", String(first.id)))).select("m.id").first(),
        this.chapterQuery(context, book).where((filter) => filter.where("r.sort_order", ">", Number(last.native_order))
          .orWhere((same) => same.where("r.sort_order", Number(last.native_order)).where("m.id", ">", String(last.id)))).select("m.id").first(),
      ]) : [null, null];
      if (revision !== await this.bookRevision(context, book) || userRevision !== await state.syncRevision(context)) continue;
      if (book.libraryKind === "content_source_audiobook") {
        directory = await this.runtime.contentAudiobooks.getBookDirectoryState(book.libraryId, context.service.OwnerUserId, bookId);
        if (directory.catalogRevision !== revision) continue;
      }
      const next = hasAfter && last ? makeCatalogCursor(scope, revision, { id: String(last.id), value: Number(last.native_order), direction: "next" }) : null;
      const before = hasBefore && first ? makeCatalogCursor(scope, revision, { id: String(first.id), value: Number(first.native_order), direction: "previous" }) : null;
      return { ...catalogPage(items, revision, next, before, directory?.catalogComplete ? directory.chapterCount : null),
        CatalogComplete: directory?.catalogComplete ?? true, ChapterCatalogStatus: directory ? this.publicStatus(directory.status) : "Ready" };
    }
    throw new ApiError(503, "consistent_read_retry_required", "章节或收听状态正在更新，请稍后重试");
  }

  /** 单章完整标题仍有长度边界，不返回任何播放器输入。 */
  public async chapter(context: NativeContext, bookId: string, chapterId: string, state: NativeCatalogState): Promise<Record<string, unknown>> {
    const book = await this.assertBook(context, bookId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await this.bookRevision(context, book);
      const chapter = await this.assertChapter(context, bookId, chapterId);
      const states = await state.chapterStates(context, [chapterId]);
      if (revision !== await this.bookRevision(context, book)) continue;
      return { ...this.chapterSummary(chapter, Number(chapter.metadata.nativeOrder), states[chapterId]), Title: boundedText(chapter.title, 1000, 4096) };
    }
    throw new ApiError(503, "consistent_read_retry_required", "章节资料正在更新，请稍后重试");
  }

  /** 实时搜索逐源窗口读取和缓存，窗口内拆页时校验来源结果未变化。 */
  public async search(context: NativeContext, libraryId: string, query: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    /** 请求断开后不再继续装配当前页，已完成的共享窗口仍可由其他消费者使用。 */
    const assertWaiting = (): void => {
      if (signal?.aborted) throw new ApiError(499, "request_cancelled", "本次搜索等待已取消");
    };
    assertWaiting();
    const library = await this.access.assertLibrary(context, libraryId);
    if (library.libraryKind !== "content_source_audiobook") throw new ApiError(501, "capability_not_supported", "当前媒体库没有来源实时搜索能力");
    const term = catalogText(query.q, "搜索关键词")!;
    if (!term) throw new ApiError(400, "invalid_query", "请输入搜索关键词");
    const limit = catalogLimit(query);
    const binding = await this.runtime.contentAudiobooks.getLibrary(libraryId, context.service.OwnerUserId);
    const revision = nativeHash(JSON.stringify([binding.source.id, binding.source.pluginVersion, binding.source.updatedAt, term]));
    const scope = [context.service.ServiceId, context.account.AccountId, libraryId, "search", term];
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    const page = cursor?.page ?? 1;
    const offset = cursor ? Number(cursor.id ?? 0) : 0;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
      throw new ApiError(400, "invalid_cursor", "搜索游标无效");
    const key = nativeHash(JSON.stringify([...scope, revision, page]));
    const window = await this.searches.read(key,
      (sharedSignal) => this.runtime.contentAudiobooks.searchPage(libraryId, context.service.OwnerUserId, term, page, sharedSignal), signal);
    assertWaiting();
    if (offset > 0 && cursor?.value !== window.revision) throw new ApiError(409, "catalog_changed", "搜索结果已变化，请重新搜索");
    const ids = window.ids.slice(offset, offset + limit);
    const rows: Record<string, unknown>[] = ids.length ? await this.items(context).where({ "m.library_id": libraryId, "m.item_type": "audiobook.book" }).whereIn("m.id", ids).select("m.*", "l.library_kind") : [];
    assertWaiting();
    const byId = new Map(rows.map((row) => [String(row.id), nativeCatalogItem(row)]));
    const items = await Promise.all(ids.flatMap((id) => byId.has(id) ? [this.summary(context, byId.get(id)!)] : []));
    assertWaiting();
    const within = offset + ids.length < window.ids.length;
    const next = within ? makeCatalogCursor(scope, revision, { page, id: String(offset + ids.length), value: window.revision })
      : window.hasMore ? makeCatalogCursor(scope, revision, { page: page + 1, id: "0" }) : null;
    return catalogPage(items, revision, next);
  }
}
