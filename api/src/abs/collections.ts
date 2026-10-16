import { randomUUID } from "node:crypto";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { loadAbsBook, mapAbsBook } from "./catalog.js";
import { absBookLibraryId, absBookMatchesLibrary, absDefaultLibraryId, absLibraryContext, withAbsLibraryViews } from "./library-views.js";
import { readAbsObject, type AbsContext, type AbsQuery } from "./types.js";
import type { AbsSocketHub } from "./socket.js";

export type AbsListKind = "collections" | "playlists";

/** 列表身份继续使用真实库外键，分类归属单独保存在现有系统设置中。 */
interface AbsListScope {
  context: AbsContext;
  settingExists: boolean;
}

/** 独立账号的书单与播放列表，条目只引用当前有声书媒体库。 */
export class AbsCollectionService {
  public constructor(
    private readonly runtime: ApiRuntime,
    private readonly hub: AbsSocketHub,
  ) {}

  /** 读取当前用户的完整书单；条目顺序来自持久化关系而非即时标题排序。 */
  public async list(context: AbsContext, kind: AbsListKind): Promise<Record<string, unknown>[]> {
    context = await withAbsLibraryViews(this.runtime, context);
    const rows = await this.runtime.database
      .query(tableName(kind))
      .where({ library_id: context.libraryId, account_id: context.accountId })
      .orderBy("created_at", "asc");
    const result: Record<string, unknown>[] = [];
    for (const row of rows) {
      const scope = await this.listScope(context, kind, row);
      if (this.visibleInLibrary(context, scope.context))
        result.push(await this.map(scope.context, kind, row));
    }
    return result;
  }

  /** 过滤数据只统计列表归属，不补详情、章节或音轨。 */
  public async count(context: AbsContext, kind: AbsListKind): Promise<number> {
    context = await withAbsLibraryViews(this.runtime, context);
    const rows = await this.runtime.database.query(tableName(kind))
      .where({ library_id: context.libraryId, account_id: context.accountId });
    let count = 0;
    for (const row of rows) {
      const scope = await this.listScope(context, kind, row);
      if (this.visibleInLibrary(context, scope.context)) count += 1;
    }
    return count;
  }

  /** 读取单条，并重复检查账号归属。 */
  public async get(context: AbsContext, kind: AbsListKind, id: string): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const row = await this.row(context, kind, id);
    const scope = await this.listScope(context, kind, row);
    this.assertVisibleInLibrary(context, scope.context);
    return this.map(scope.context, kind, row);
  }

  /** 新建真实持久书单或播放列表，非法条目先校验再开始事务。 */
  public async create(
    context: AbsContext,
    kind: AbsListKind,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    if (typeof body.libraryId !== "string")
      throw new ApiError(403, "abs_list_library_invalid", "不能访问其他媒体库");
    context = absLibraryContext(context, body.libraryId);
    const name = readName(body.name);
    const ids = await this.readIds(context, kind, kind === "collections" ? body.books : (body.items ?? []));
    if (kind === "collections" && ids.length === 0)
      throw new ApiError(400, "abs_collection_empty", "集合至少需要一本书");
    // 关键变量：旧真实库地址仍可创建，但新列表必须选定一个主分类，空播放列表归默认库。
    if (context.viewLibraryId === context.libraryId) {
      const views = await this.itemLibraryIds(context, ids);
      if (views.length > 1)
        throw new ApiError(400, "abs_list_cross_library", "同一个集合或播放列表只能加入同一分类库的作品");
      context = absLibraryContext(context, views[0] ?? absDefaultLibraryId(context));
    }
    const id = randomUUID();
    const now = Date.now();
    await this.runtime.database.query.transaction(async (transaction) => {
      await transaction(tableName(kind)).insert({
        id,
        library_id: context.libraryId,
        account_id: context.accountId,
        name,
        description: readDescription(body.description),
        created_at: now,
        updated_at: now,
      });
      for (const [index, itemId] of ids.entries())
        await transaction(`${tableName(kind)}_items`).insert({
          id: randomUUID(),
          parent_id: id,
          item_id: itemId,
          sort_order: index,
        });
      await this.saveScope(transaction, context, kind, id);
    });
    const result = await this.get(context, kind, id);
    await this.hub.emit(context, kind === "collections" ? "collection_added" : "playlist_added", result);
    return result;
  }

  /** 更新标题、描述与章节顺序，显式空数组可以清空列表。 */
  public async update(
    context: AbsContext,
    kind: AbsListKind,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const row = await this.row(context, kind, id);
    const scope = await this.listScope(context, kind, row);
    this.assertVisibleInLibrary(context, scope.context);
    context = scope.context;
    if (body.libraryId !== undefined && body.libraryId !== context.libraryId && body.libraryId !== context.viewLibraryId)
      throw new ApiError(400, "abs_list_library_immutable", "不能将已有集合或播放列表移动到其他分类库");
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (body.name !== undefined) patch.name = readName(body.name);
    if (body.description !== undefined) patch.description = readDescription(body.description);
    const field = kind === "collections" ? "books" : "items";
    const ids = body[field] === undefined ? null : await this.readIds(context, kind, body[field]);
    await this.runtime.database.query.transaction(async (transaction) => {
      await this.lockRow(transaction, context, kind, id);
      await transaction(tableName(kind))
        .where({ id, library_id: context.libraryId, account_id: context.accountId }).update(patch);
      if (ids) {
        await transaction(`${tableName(kind)}_items`)
          .where({ parent_id: id })
          .delete();
        for (const [index, itemId] of ids.entries())
          await transaction(`${tableName(kind)}_items`).insert({
            id: randomUUID(),
            parent_id: id,
            item_id: itemId,
            sort_order: index,
          });
      }
      if (!scope.settingExists) await this.saveScope(transaction, context, kind, id);
    });
    const result = await this.get(context, kind, id);
    await this.hub.emit(context, kind === "collections" ? "collection_updated" : "playlist_updated", result);
    return result;
  }

  /** 只变更请求指定的关系；历史条目迁移分类后仍保留，删除不再依赖其详情可用。 */
  public async changeItems(
    context: AbsContext,
    kind: AbsListKind,
    id: string,
    itemIds: string[],
    remove = false,
  ): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const row = await this.row(context, kind, id);
    const scope = await this.listScope(context, kind, row);
    this.assertVisibleInLibrary(context, scope.context);
    context = scope.context;
    const requestedIds = [...new Set(itemIds)]; // 请求关系去重，不重建其他既有条目。
    if (!remove) {
      const oldEntries = await this.runtime.database.query(`${tableName(kind)}_items`)
        .select("item_id").where({ parent_id: id });
      const oldIds = new Set(oldEntries.map((entry) => String(entry.item_id)));
      const addedIds = requestedIds.filter((itemId) => !oldIds.has(itemId));
      await this.readIds(context, kind, kind === "collections" ? addedIds : addedIds.map((libraryItemId) => ({ libraryItemId })));
    }
    await this.runtime.database.query.transaction(async (transaction) => {
      await this.lockRow(transaction, context, kind, id);
      if (remove && requestedIds.length) {
        await transaction(`${tableName(kind)}_items`)
          .where({ parent_id: id }).whereIn("item_id", requestedIds).delete();
      } else if (!remove) {
        // 关键变量：拿到列表行锁后再次读取实际关系，避免并发追加覆盖或重复写入。
        const current = await transaction(`${tableName(kind)}_items`)
          .select("item_id", "sort_order").where({ parent_id: id });
        const currentIds = new Set(current.map((entry) => String(entry.item_id)));
        const addedIds = requestedIds.filter((itemId) => !currentIds.has(itemId));
        if (addedIds.length) {
          const books = await transaction("media_items").select("id", "metadata_json")
            .where({ library_id: context.libraryId, user_id: context.ownerUserId, item_type: "audiobook.book" })
            .whereIn("id", addedIds).whereNull("deleted_at");
          if (books.length !== addedIds.length || books.some((book) => !absBookMatchesLibrary(context, { metadata: readAbsObject(book.metadata_json) })))
            throw new ApiError(400, "abs_list_cross_library", "新增作品必须属于当前分类库且仍然可用");
          const nextOrder = current.reduce((maximum, entry) => Math.max(maximum, Number(entry.sort_order)), -1) + 1;
          for (const [index, itemId] of addedIds.entries())
            await transaction(`${tableName(kind)}_items`).insert({
              id: randomUUID(), parent_id: id, item_id: itemId, sort_order: nextOrder + index,
            });
        }
      }
      await transaction(tableName(kind))
        .where({ id, library_id: context.libraryId, account_id: context.accountId }).update({ updated_at: Date.now() });
      if (!scope.settingExists) await this.saveScope(transaction, context, kind, id);
    });
    const result = await this.get(context, kind, id);
    await this.hub.emit(context, kind === "collections" ? "collection_updated" : "playlist_updated", result);
    return result;
  }

  /** 删除集合或播放列表，绝不删除网盘文件和作品。 */
  public async remove(context: AbsContext, kind: AbsListKind, id: string): Promise<void> {
    context = await withAbsLibraryViews(this.runtime, context);
    const row = await this.row(context, kind, id);
    const scope = await this.listScope(context, kind, row);
    this.assertVisibleInLibrary(context, scope.context);
    await this.runtime.database.query.transaction(async (transaction) => {
      await this.lockRow(transaction, context, kind, id);
      await transaction(tableName(kind))
        .where({ id, account_id: context.accountId, library_id: context.libraryId })
        .delete();
      await transaction("system_settings").where({ setting_key: listSettingKey(kind, id) }).delete();
    });
    await this.hub.emit(context, kind === "collections" ? "collection_removed" : "playlist_removed", id);
  }

  /** 只接受当前库作品，不支持的播客 episodeId 明确拒绝。 */
  private async readIds(context: AbsContext, kind: AbsListKind, values: unknown): Promise<string[]> {
    if (!Array.isArray(values)) throw new ApiError(400, "abs_list_items_invalid", "书单条目必须是数组");
    const ids = values.map((value) => {
      if (kind === "collections") {
        if (typeof value !== "string") throw new ApiError(400, "abs_list_item_invalid", "作品 ID 无效");
        return value;
      }
      const entry = readAbsObject(value);
      if (typeof entry.libraryItemId !== "string" || entry.episodeId)
        throw new ApiError(400, "abs_list_item_invalid", "当前服务只支持有声书作品");
      return entry.libraryItemId;
    });
    for (const id of ids) {
      const book = await loadAbsBook(this.runtime, context, id);
      if (!absBookMatchesLibrary(context, book.item))
        throw new ApiError(400, "abs_list_cross_library", "同一个集合或播放列表只能加入同一分类库的作品");
    }
    return [...new Set(ids)];
  }

  /** 分类判定仅读取所需书籍摘要，不为了列表归属而请求源站详情。 */
  private async itemLibraryIds(context: AbsContext, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.runtime.database.query("media_items")
      .select("metadata_json")
      .where({ library_id: context.libraryId, user_id: context.ownerUserId, item_type: "audiobook.book" })
      .whereIn("id", ids)
      .whereNull("deleted_at");
    return [...new Set(rows.map((row) => absBookLibraryId(context, { metadata: readAbsObject(row.metadata_json) })))];
  }

  /** 优先恢复固定分类；历史混类列表保留真实库别名，避免丢弃原有条目。 */
  private async listScope(context: AbsContext, kind: AbsListKind, row: Record<string, unknown>): Promise<AbsListScope> {
    const setting = await this.runtime.database.query("system_settings")
      .where({ setting_key: listSettingKey(kind, String(row.id)) }).first();
    const saved = readAbsObject(setting?.setting_value);
    const savedViewId = saved.viewLibraryId; // 固定字符串后在分类查找回调中保留类型收窄。
    if (saved.libraryId === context.libraryId && saved.accountId === context.accountId && typeof savedViewId === "string") {
      // 分类临时取消选择后保留旧列表，通过真实库兼容入口仍可读取和删除。
      const visible = savedViewId === context.libraryId || context.libraryViews?.some((view) => view.id === savedViewId);
      return { context: absLibraryContext(context, visible ? savedViewId : context.libraryId), settingExists: true };
    }
    const entries = await this.runtime.database.query(`${tableName(kind)}_items`)
      .select("item_id").where({ parent_id: row.id });
    const views = await this.itemLibraryIds(context, entries.map((entry) => String(entry.item_id)));
    const viewLibraryId = views.length > 1 ? context.libraryId : (views[0] ?? absDefaultLibraryId(context));
    return { context: absLibraryContext(context, viewLibraryId), settingExists: Boolean(setting) };
  }

  /** 每个列表使用独立设置键，新增和首次固定归属均与业务写入共用事务。 */
  private async saveScope(query: AbsQuery, context: AbsContext, kind: AbsListKind, id: string): Promise<void> {
    const now = new Date().toISOString();
    await query("system_settings").insert({
      setting_key: listSettingKey(kind, id),
      setting_value: JSON.stringify({ libraryId: context.libraryId, accountId: context.accountId, viewLibraryId: context.viewLibraryId ?? absDefaultLibraryId(context) }),
      revision: 1,
      updated_by_user_id: context.ownerUserId,
      created_at: now,
      updated_at: now,
    }).onConflict("setting_key").ignore();
  }

  /** 全局和旧真实库入口保留全集；分类入口只呈现固定属于自己的列表。 */
  private visibleInLibrary(request: AbsContext, list: AbsContext): boolean {
    return !request.viewLibraryId || request.viewLibraryId === request.libraryId || request.viewLibraryId === list.viewLibraryId;
  }

  /** 明确分类入口不可用其他分类的列表 ID 绕过范围限制。 */
  private assertVisibleInLibrary(request: AbsContext, list: AbsContext): void {
    if (!this.visibleInLibrary(request, list))
      throw new ApiError(404, "abs_list_not_found", "集合或播放列表不存在");
  }

  /** 查询条件始终包含单库及协议账号，不允许根据裸 ID 越权访问。 */
  private async row(context: AbsContext, kind: AbsListKind, id: string): Promise<Record<string, unknown>> {
    const row = await this.runtime.database
      .query(tableName(kind))
      .where({ id, library_id: context.libraryId, account_id: context.accountId })
      .first();
    if (!row) throw new ApiError(404, "abs_list_not_found", "集合或播放列表不存在");
    return row;
  }

  /** 修改关系或归属前锁定仍存在的列表，防止并发删除后留下孤立设置。 */
  private async lockRow(query: AbsQuery, context: AbsContext, kind: AbsListKind, id: string): Promise<void> {
    const lookup = query(tableName(kind))
      .select("id").where({ id, library_id: context.libraryId, account_id: context.accountId });
    if (this.runtime.database.databaseType !== "sqlite") lookup.forUpdate();
    if (!await lookup.first())
      throw new ApiError(404, "abs_list_not_found", "集合或播放列表不存在");
  }

  /** 将真实列表映射为 ABS collection/playlist expanded 对象。 */
  private async map(
    context: AbsContext,
    kind: AbsListKind,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entries = await this.runtime.database
      .query(`${tableName(kind)}_items as e`)
      .join("media_items as m", "m.id", "e.item_id")
      .select("e.*", "m.metadata_json")
      .where({ "e.parent_id": row.id, "m.library_id": context.libraryId, "m.user_id": context.ownerUserId, "m.item_type": "audiobook.book" })
      .whereNull("m.deleted_at")
      .orderBy("e.sort_order", "asc");
    // 关键变量：书籍可能从搜索分类移到真实主类，关系保留，当前列表仅展开仍属于本库的条目。
    const visibleEntries = entries.filter((entry) => absBookMatchesLibrary(context, { metadata: readAbsObject(entry.metadata_json) }));
    const rootContext = absLibraryContext(context, context.libraryId);
    const expanded = await Promise.all(visibleEntries.map(async (entry) => {
      try {
        const book = await loadAbsBook(this.runtime, rootContext, String(entry.item_id));
        // 详情加载期间同步分类也可能变化，读取后再判定一次，避免整单因分类迁移返回 404。
        return absBookMatchesLibrary(context, book.item) ? mapAbsBook(context, book) : null;
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404 && ["media_item_not_found", "abs_book_not_found"].includes(error.code))
          return null;
        throw error;
      }
    }));
    const books = expanded.filter((book): book is Record<string, unknown> => book !== null);
    return {
      id: String(row.id),
      libraryId: context.viewLibraryId ?? absDefaultLibraryId(context),
      userId: context.accountId,
      name: String(row.name),
      description: row.description || null,
      lastUpdate: Number(row.updated_at),
      createdAt: Number(row.created_at),
      ...(kind === "collections"
        ? { books, numBooks: books.length }
        : {
            items: books.map((libraryItem) => ({
              libraryItemId: libraryItem.id,
              episodeId: null,
              libraryItem,
            })),
            numItems: books.length,
          }),
    };
  }
}

/** 表名只来自内部枚举，不拼接外部请求值。 */
function tableName(kind: AbsListKind): string {
  return kind === "collections" ? "library_abs_collections" : "library_abs_playlists";
}
/** UUID 加固定枚举后仍小于 system_settings.setting_key 的 100 字符限制。 */
function listSettingKey(kind: AbsListKind, id: string): string {
  return `abs-list-view:${kind}:${id}`;
}
/** 列表名称必须是有内容的普通文本。 */
function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 255)
    throw new ApiError(400, "abs_list_name_invalid", "名称不能为空或超过 255 字符");
  return value.replace(/<[^>]*>/gu, "").trim();
}
/** 描述是可清空的纯文本，不存任意类型对象。 */
function readDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 20000)
    throw new ApiError(400, "abs_list_description_invalid", "描述格式无效");
  return value;
}
