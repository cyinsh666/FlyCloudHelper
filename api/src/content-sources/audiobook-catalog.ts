import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import { createStableId } from "../media/filename.js";
import type { ServiceRepository } from "../service-repository.js";
import { contentKey } from "./cms-adapter.js";
import { AUDIOBOOK_SEARCH_CATEGORY, type AudiobookSourceCard, type AudiobookSourceCategory, type AudiobookSourceDetail } from "./audiobook-types.js";
import { audiobookDirectoryKey, decodeAudiobookDirectory, writeAudiobookDirectory } from "./audiobook-directory-state.js";

/** 书和章节仅按库、实例和源稳定 ID 建立身份，标题和目录顺序都不参与。 */
export function contentAudiobookItemId(libraryId: string, instanceId: string, remoteBookId: string, remoteChapterId?: string): string {
  return createStableId("itm", libraryId, instanceId, "audiobook", remoteBookId, ...(remoteChapterId === undefined ? [] : [remoteChapterId]));
}

/** 元数据里只读取明确的内容源定位，不接受播放器的临时输入。 */
export function audiobookContentSource(metadata: Record<string, unknown>): Record<string, unknown> {
  const source = metadata.contentSource;
  return source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
}

/** 兼容旧单分类并保持固定主分类在首位，搜索占位不冒充真实源分类。 */
export function audiobookSourceCategories(source: Record<string, unknown>): AudiobookSourceCategory[] {
  const categories: AudiobookSourceCategory[] = [];
  // 关键变量：旧 categoryId 是已发布书籍的固定主分类，不能被后来的分类页或详情替换。
  /** 同一分类只补缺失名称，保留首次观察顺序和真实源 ID。 */
  const append = (id: unknown, name: unknown): void => {
    if (typeof id !== "string" || !id.trim() || id === AUDIOBOOK_SEARCH_CATEGORY) return;
    const categoryName = typeof name === "string" ? name.trim() : "";
    const previous = categories.find((category) => category.id === id);
    if (previous) { if (!previous.name && categoryName) previous.name = categoryName; }
    else categories.push({ id, name: categoryName });
  };
  append(source.categoryId, source.categoryName);
  for (const value of Array.isArray(source.categories) ? source.categories : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const category = value as Record<string, unknown>;
    append(category.id, category.name);
  }
  return categories;
}

/** 一次书籍原子写入的真实作用域；不会触及网盘源文件和网盘凭据。 */
interface CatalogInput {
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  libraryId: string;
  userId: string;
  instanceId: string;
  content: AudiobookSourceCard | AudiobookSourceDetail;
  /** 分页准备每批必须验证同一书籍任务；最终完整确认才可做删除对账。 */
  directory?: { runId: string; final?: boolean; authoritative?: boolean; completeChapterIds?: string[] };
}

/** 单次SQL参数和文本均保持有界，不能把全部长书章节拼为一个语句。 */
const CATALOG_WRITE_BATCH = 25;

/** 批量保存已比较过的实际变化；旧行的创建时间保留，未变条目完全不写。 */
async function saveChangedItems(transaction: Knex.Transaction, rows: Record<string, unknown>[], existing: Map<string, Record<string, unknown>>, now: string, changedIds: Set<string>): Promise<void> {
  const changed: Record<string, unknown>[] = rows.filter((row) => {
    const previous = existing.get(String(row.id));
    return !previous || Object.entries(row).some(([key, value]) => !["generation_id", "created_at", "updated_at"].includes(key) && previous[key] !== value);
  }).map((row) => ({ ...row, created_at: existing.get(String(row.id))?.created_at ?? now, updated_at: now }));
  for (let offset = 0; offset < changed.length; offset += CATALOG_WRITE_BATCH) {
    const batch = changed.slice(offset, offset + CATALOG_WRITE_BATCH);
    const columns = Object.keys(batch[0]!).filter((column) => !["id", "created_at"].includes(column));
    await transaction("media_items").insert(batch).onConflict("id").merge(columns);
    for (const row of batch) changedIds.add(String(row.id));
  }
}

/** 内容、目录版本及标准变更日志与本批写入共用事务，不在提交后另开事务补版本。 */
async function recordCatalogChanges(transaction: Knex.Transaction, userId: string, libraryId: string, changedIds: Set<string>, now: string): Promise<void> {
  if (!changedIds.size) return;
  const library = await transaction("media_libraries").where({ id: libraryId, user_id: userId }).first();
  const previous = Number(library.catalog_version);
  const ids = [...changedIds];
  const deleted = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = await transaction("media_items").select("id", "deleted_at").where({ library_id: libraryId, user_id: userId }).whereIn("id", ids.slice(offset, offset + 100));
    for (const row of rows) if (row.deleted_at !== null) deleted.add(String(row.id));
  }
  await transaction("media_libraries").where({ id: libraryId, user_id: userId }).update({ catalog_version: previous + ids.length, updated_at: now });
  for (let offset = 0; offset < ids.length; offset += CATALOG_WRITE_BATCH) await transaction("catalog_changes").insert(ids.slice(offset, offset + CATALOG_WRITE_BATCH).map((id, index) => ({ user_id: userId, library_id: libraryId, catalog_version: previous + offset + index + 1, entity_type: "media_item", entity_id: id, change_type: deleted.has(id) ? "delete" : "upsert", created_at: now })));
}

/** 写入按媒体库、绑定、实例、插件、来源的固定顺序加锁，状态停用与当前提交明确排序。 */
async function lockCatalog(input: CatalogInput, transaction: Knex.Transaction): Promise<void> {
  const supportsRowLocks = input.database.databaseType !== "sqlite";
  let libraryQuery = transaction("media_libraries").where({ id: input.libraryId, user_id: input.userId, library_kind: "content_source_audiobook", status: "active" });
  if (supportsRowLocks) libraryQuery = libraryQuery.forUpdate();
  if (!(await libraryQuery.first())) throw new ApiError(409, "audiobook_library_unavailable", "在线听书媒体库不存在或已停用");
  let bindingQuery = transaction("content_source_libraries").where({ library_id: input.libraryId, user_id: input.userId, instance_id: input.instanceId });
  if (supportsRowLocks) bindingQuery = bindingQuery.forUpdate();
  const binding = await bindingQuery.first();
  if (!binding) throw new ApiError(409, "audiobook_source_unavailable", "听书媒体库绑定已改变");
  // 关键变量：状态修改入口单行更新后即提交，再停止宿主；不能在它已提交停用后继续提交新章节。
  let instanceQuery = transaction("content_source_instances").where({ id: input.instanceId, user_id: input.userId, status: "active" });
  if (supportsRowLocks) instanceQuery = instanceQuery.forUpdate();
  const instance = await instanceQuery.first();
  if (!instance) throw new ApiError(409, "audiobook_source_unavailable", "听书源实例已停止");
  let pluginQuery = transaction("content_source_plugins").where({ plugin_id: instance.plugin_id, version: instance.plugin_version, status: "enabled" });
  if (supportsRowLocks) pluginQuery = pluginQuery.forUpdate();
  if (!(await pluginQuery.first())) throw new ApiError(409, "content_plugin_disabled", "听书源插件已停用");
  let sourceQuery = transaction("library_sources").where({ id: binding.library_source_id, user_id: input.userId, library_id: input.libraryId, source_mode: "content_source", status: "active" });
  if (supportsRowLocks) sourceQuery = sourceQuery.forUpdate();
  const source = await sourceQuery.first();
  if (!source || parseJsonObject(source.configuration_json).instanceId !== input.instanceId) throw new ApiError(409, "audiobook_source_unavailable", "听书库内容来源已停用或实例绑定已改变");
}

/** 只有实际字段变化时更新条目；详情和章节使用同一事务完整提交。 */
async function saveItem(transaction: Knex.Transaction, input: CatalogInput, row: Record<string, unknown>, now: string, changedIds: Set<string>): Promise<void> {
  const existing = await transaction("media_items").where({ id: row.id, user_id: input.userId, library_id: input.libraryId }).first();
  const changes = Object.fromEntries(Object.entries(row).filter(([key, value]) => !["id", "created_at", "generation_id"].includes(key) && existing?.[key] !== value));
  if (existing && !Object.keys(changes).length) return;
  if (existing) await transaction("media_items").where({ id: row.id, user_id: input.userId, library_id: input.libraryId }).update({ ...changes, generation_id: row.generation_id, updated_at: now });
  else await transaction("media_items").insert({ ...row, created_at: now, updated_at: now });
  changedIds.add(String(row.id));
}

/** 列表保存摘要，详情才保存章节；两者都不持久化 playbackId、URL 或播放请求头。 */
export async function persistContentAudiobook(input: CatalogInput): Promise<string> {
  const { database, libraryId, userId, instanceId, content } = input;
  const bookId = contentAudiobookItemId(libraryId, instanceId, content.id);
  const details = "tracks" in content ? content : null;
  const changedIds = new Set<string>();
  const now = new Date().toISOString();
  const generation = randomUUID(); // 关键变量：本次详情的章节对账标记，与网盘扫描代际无关。
  await database.query.transaction(async (transaction) => {
    await lockCatalog(input, transaction);
    const previous = await transaction("media_items").where({ id: bookId, user_id: userId, library_id: libraryId }).first();
    const previousMetadata = parseJsonObject(previous?.metadata_json);
    const previousSource = audiobookContentSource(previousMetadata);
    const preserveComplete = !details && previousSource.detailState === "complete";
    const previousCategories = audiobookSourceCategories(previousSource);
    const incomingCategories = audiobookSourceCategories({ categoryId: content.categoryId, categoryName: content.categoryName, categories: content.categories });
    const categories = audiobookSourceCategories({ categories: [...previousCategories, ...incomingCategories] });
    const categoryId = categories[0]?.id ?? AUDIOBOOK_SEARCH_CATEGORY;
    const categoryName = categories[0]?.name ?? "实时搜索";
    const source = { ...previousSource, kind: "audiobook", instanceId, remoteItemId: content.id, categoryId, categoryName, categories, detailState: details ? input.directory && !input.directory.final ? previousSource.detailState ?? "partial" : "complete" : previousSource.detailState ?? "card" };
    const metadata: Record<string, unknown> = { ...previousMetadata, contentSource: source };
    for (const [key, value] of Object.entries({ authors: content.authors, narrators: content.narrators })) {
      if (value.length && (!preserveComplete || !Array.isArray(metadata[key]) || !(metadata[key] as unknown[]).length)) metadata[key] = value;
    }
    // 真实分类同步投影到标准 genres；补详情和实时搜索都只能补充，不能清空已有分类。
    const previousGenres = Array.isArray(previousMetadata.genres) ? previousMetadata.genres.filter((genre): genre is string => typeof genre === "string" && Boolean(genre.trim())) : [];
    metadata.genres = [...new Set([...previousGenres, ...content.genres, ...categories.map((category) => category.name)].filter(Boolean))];
    const base = { user_id: userId, service_id: null, library_id: libraryId, media_type: "audiobook", region_group: "other", year: null, premiere_date: null, backdrop_url: null, match_state: "matched", external_ids_json: "{}", generation_id: generation, deleted_at: null };
    let totalDurationMs = 0;
    let unknownDurationCount = 0;
    const chapterIds: string[] = [];
    let directoryChanged = false;
    const directoryRow = input.directory ? await transaction("system_settings").where({ setting_key: audiobookDirectoryKey(libraryId, bookId) }).first() : undefined;
    const directoryState = decodeAudiobookDirectory(directoryRow, libraryId, userId, bookId);
    if (input.directory && (directoryState.status !== "Preparing" || directoryState.runId !== input.directory.runId)) throw new ApiError(409, "audiobook_directory_superseded", "此轮目录准备已被新的任务替换");
    if (details) {
      // 关键变量：先写父书籍供关系外键引用，所有章节及最终汇总仍随本事务一起提交。
      if (!previous) await saveItem(transaction, input, { ...base, id: bookId, identity_key: `audiobook:${instanceId}:${contentKey(content.id)}`, item_type: "audiobook.book", title: content.title, sort_title: content.title, subtitle: "", overview: content.overview || "", poster_url: content.posterUrl || null, metadata_json: JSON.stringify(metadata) }, now, changedIds);
      const pageIds = details.tracks.map((track) => contentAudiobookItemId(libraryId, instanceId, content.id, track.id));
      const oldRows = pageIds.length ? await transaction("media_items").where({ user_id: userId, library_id: libraryId }).whereIn("id", pageIds) : [];
      const oldChapters = new Map<string, Record<string, unknown>>(oldRows.map((row) => [String(row.id), row]));
      const oldRelations = pageIds.length ? await transaction("media_relations").where({ user_id: userId, library_id: libraryId, parent_item_id: bookId, relation_type: "book_chapter" }).whereIn("child_item_id", pageIds) : [];
      const oldOrders = new Map<string, number>(oldRelations.map((row) => [String(row.child_item_id), Number(row.sort_order)]));
      const chapterRows: Record<string, unknown>[] = [];
      const relations: Record<string, unknown>[] = [];
      for (const [index, track] of details.tracks.entries()) {
        const chapterId = contentAudiobookItemId(libraryId, instanceId, content.id, track.id);
        chapterIds.push(chapterId);
        const previousChapter = oldChapters.get(chapterId);
        const oldMetadata = parseJsonObject(previousChapter?.metadata_json);
        // 源暂缺时长时保留同一真实章节此前取得的时长，不估算、不对全书逐章探测。
        const knownDuration = Number(oldMetadata.durationMs);
        const durationMs = track.duration === null ? Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration : 0 : Math.round(track.duration * 1000);
        if (durationMs > 0) totalDurationMs += durationMs; else unknownDurationCount += 1;
        const mimeType = track.mimeType === "application/octet-stream" && typeof oldMetadata.mimeType === "string" ? oldMetadata.mimeType : track.mimeType;
        const chapterSource = { kind: "audiobook", instanceId, remoteItemId: content.id, remoteChapterId: track.id, bookItemId: bookId, categoryId, categoryName, categories, detailState: "complete" };
        const order = track.order ?? index + 1;
        chapterRows.push({ ...base, id: chapterId, identity_key: `audiobook-chapter:${instanceId}:${contentKey(JSON.stringify([content.id, track.id]))}`, item_type: "audiobook.chapter", title: track.title, sort_title: track.title, subtitle: content.title, overview: "", poster_url: content.posterUrl || previous?.poster_url || null, metadata_json: JSON.stringify({ ...oldMetadata, authors: content.authors, narrators: content.narrators, durationMs, mimeType, chapterNumber: order, discNumber: 1, durationPending: durationMs <= 0, contentSource: chapterSource }) });
        if (!previousChapter || previousChapter.deleted_at !== null || previousChapter.title !== track.title || Number(oldMetadata.durationMs ?? 0) !== durationMs || oldOrders.get(chapterId) !== order - 1) directoryChanged = true;
        if (oldOrders.get(chapterId) !== order - 1) {
          relations.push({ id: createStableId("rel", libraryId, bookId, chapterId, "book_chapter"), user_id: userId, library_id: libraryId, parent_item_id: bookId, child_item_id: chapterId, relation_type: "book_chapter", sort_order: order - 1 });
          changedIds.add(chapterId);
        }
      }
      await saveChangedItems(transaction, chapterRows, oldChapters, now, changedIds);
      for (let offset = 0; offset < relations.length; offset += CATALOG_WRITE_BATCH) await transaction("media_relations").insert(relations.slice(offset, offset + CATALOG_WRITE_BATCH)).onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge(["sort_order"]);
      const mayDelete = !input.directory || Boolean(input.directory.final && input.directory.authoritative);
      const allRelations = mayDelete ? await transaction("media_relations").where({ user_id: userId, library_id: libraryId, parent_item_id: bookId, relation_type: "book_chapter" }).select("child_item_id") : [];
      const currentIds = new Set(input.directory?.completeChapterIds ?? chapterIds);
      const removed = allRelations.map((row) => String(row.child_item_id)).filter((id) => !currentIds.has(id));
      if (removed.length) directoryChanged = true;
      for (let offset = 0; offset < removed.length; offset += 100) {
        const batch = removed.slice(offset, offset + 100);
        await transaction("media_relations").where({ user_id: userId, library_id: libraryId, parent_item_id: bookId, relation_type: "book_chapter" }).whereIn("child_item_id", batch).delete();
        await transaction("media_items").where({ user_id: userId, library_id: libraryId, item_type: "audiobook.chapter" }).whereIn("id", batch).update({ deleted_at: now, updated_at: now });
        for (const id of batch) changedIds.add(id);
      }
      if (input.directory?.final) {
        // 关键变量：最终汇总在数据库中完成，不将整本章节JSON搬回应用层。
        const durationExpression = database.databaseType === "postgres" ? "coalesce((m.metadata_json::jsonb ->> 'durationMs')::numeric, 0)" : database.databaseType === "mysql" ? "coalesce(JSON_UNQUOTE(JSON_EXTRACT(m.metadata_json, '$.durationMs')) + 0, 0)" : "coalesce(json_extract(m.metadata_json, '$.durationMs'), 0)";
        const summary = await transaction("media_relations as r").join("media_items as m", "m.id", "r.child_item_id").where({ "r.user_id": userId, "r.library_id": libraryId, "r.parent_item_id": bookId, "r.relation_type": "book_chapter", "m.user_id": userId, "m.library_id": libraryId }).whereNull("m.deleted_at").select(transaction.raw(`COUNT(*) as chapter_count, SUM(${durationExpression}) as duration_total, SUM(CASE WHEN ${durationExpression} > 0 THEN 0 ELSE 1 END) as unknown_count`)).first();
        unknownDurationCount = Number(summary?.unknown_count ?? 0);
        totalDurationMs = Number(summary?.duration_total ?? 0);
        Object.assign(metadata, { audioDetailsLoaded: true, size: 0, audioFileCount: Number(summary?.chapter_count ?? 0), chapterCount: Number(summary?.chapter_count ?? 0), durationMs: unknownDurationCount ? 0 : totalDurationMs, durationPending: unknownDurationCount > 0, unknownDurationCount });
      } else if (!input.directory) Object.assign(metadata, { audioDetailsLoaded: true, size: 0, audioFileCount: details.tracks.length, chapterCount: details.tracks.length, durationMs: unknownDurationCount ? 0 : totalDurationMs, durationPending: unknownDurationCount > 0, unknownDurationCount });
      else if (!previousMetadata.audioDetailsLoaded) Object.assign(metadata, { audioDetailsLoaded: false, durationPending: true });
    }
    const keepTitle = preserveComplete && previous?.title;
    await saveItem(transaction, input, { ...base, id: bookId, identity_key: `audiobook:${instanceId}:${contentKey(content.id)}`, item_type: "audiobook.book", title: keepTitle ? String(previous.title) : content.title, sort_title: keepTitle ? String(previous.sort_title) : content.title, subtitle: String(previous?.subtitle ?? ""), overview: preserveComplete && previous?.overview ? String(previous.overview) : content.overview || String(previous?.overview ?? ""), poster_url: preserveComplete && previous?.poster_url ? previous.poster_url : content.posterUrl || previous?.poster_url || null, metadata_json: JSON.stringify(metadata) }, now, changedIds);
    if (directoryChanged) {
      // 关键变量：真实增删章或重排也改变整书内容，旧ABS/Jellyfin目录缓存应当得到更新。
      await transaction("media_items").where({ id: bookId, user_id: userId, library_id: libraryId }).update({ updated_at: now });
      changedIds.add(bookId);
    }
    if (input.directory) await writeAudiobookDirectory(transaction, libraryId, userId, bookId, { ...directoryState, status: input.directory.final ? "Ready" : "Preparing", catalogComplete: Boolean(input.directory.final), catalogRevision: directoryChanged ? String(BigInt(directoryState.catalogRevision) + 1n) : directoryState.catalogRevision, chapterCount: input.directory.final ? Number(metadata.chapterCount ?? 0) : null, checkedAt: input.directory.final ? now : directoryState.checkedAt, lastError: null, leaseExpiresAt: input.directory.final ? undefined : new Date(Date.now() + 240000).toISOString() });
    await recordCatalogChanges(transaction, userId, libraryId, changedIds, now);
  });
  return bookId;
}
