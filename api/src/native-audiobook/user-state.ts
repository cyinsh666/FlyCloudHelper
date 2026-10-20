import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { parseJsonObject, type MediaItemRecord } from "../domain.js";
import { audiobookDirectoryKey, decodeAudiobookDirectory } from "../content-sources/audiobook-directory-state.js";
import type { ApiRuntime } from "../runtime.js";
import type { NativeAccess } from "./access.js";
import type { NativeCatalog } from "./catalog.js";
import { nativeLocalChapters } from "./local-chapters.js";
import { NativeStore, nativeHash, nativeScope } from "./store.js";
import type { NativeAccount, NativeContext, NativeQuery, NativeService, NativeStored } from "./types.js";
import { decodeNativeCursor, encodeNativeCursor, nativeCursorScope, nativeLimit, nativeObject, nativeRevision, nativeSeconds, nativeText, nextRevision } from "./state-helpers.js";

/** 单本书的原生续听点，不与 ABS 的全书秒数互写。 */
export interface NativeProgress {
  BookId: string; LibraryId: string; ChapterId: string | null; PositionSeconds: number | null;
  ChapterCompleted: boolean; BookCompleted: boolean; HiddenFromContinueListening: boolean;
  UpdatedAt: string | null; Revision: string; WriterPlaySessionId: string | null;
  ContinueIndexKey?: string;
}

/** 每章完成状态独立保存，目录只读取当前页需要的身份。 */
export interface NativeChapterState { ChapterId: string; PositionSeconds: number | null; Completed: boolean; Revision: string; }
/** 收藏保持小状态，取消时移除时间排序索引并写删除墓碑。 */
interface FavoriteState { BookId: string; LibraryId: string; Favorite: boolean; Revision: string; UpdatedAt: string; IndexKey?: string; }
/** 书签只引用稳定章节及章内位置，不存播放器输入。 */
interface BookmarkState { BookmarkId: string; BookId: string; LibraryId: string; ChapterId: string; PositionSeconds: number; Title: string; Revision: string; CreatedAt: string; UpdatedAt: string; }
/** 账号序列及清理低水位与日志共用事务。 */
interface SequenceState { latestRevision: string; prunedThroughRevision: string; permissions: string; }
/** 增量项只投影实体小状态和删除墓碑。 */
interface ChangeState { ChangeRevision: string; EntityType: string; EntityId: string; Operation: "Upsert" | "Delete"; EntityRevision: string; State?: unknown; LibraryId?: string; CreatedAt: string; }
/** 收听历史只保存一个播放会话的摘要与实际听时。 */
export interface NativeHistory { PlaySessionId: string; BookId: string; LibraryId: string; ChapterId: string; StartedAt: string; UpdatedAt: string; EndedAt: string | null; ListenedSeconds: number; Revision?: string; }

/** 配置交集还需核对实际库当前归属和生命周期，不能保留已撤销库的用户标题。 */
async function currentLibraryIds(service: NativeService, account: NativeAccount, query: NativeQuery): Promise<string[]> {
  const allowed = new Set(account.AllowedLibraryIds);
  const ids = service.LibraryIds.filter((id) => allowed.has(id));
  if (!ids.length) return [];
  const rows = await query("media_libraries").where({ user_id: service.OwnerUserId, data_type: "audiobook", status: "active" }).whereIn("id", ids).select("id");
  const current = new Set(rows.map((row) => String(row.id)));
  return ids.filter((id) => current.has(id));
}

/** 权限摘要覆盖当前实际库状态，库删除但配置尚保留时也会产生清理通知。 */
function permissionFingerprint(service: NativeService, account: NativeAccount, libraryIds: string[]): string { return nativeHash(JSON.stringify([service.PermissionsRevision, account.PermissionsRevision, libraryIds])); }

/** 管理修改与客户端状态共用账号序列，权限通知不包含已撤销库的标题。 */
export async function appendNativePermissionChange(store: NativeStore, service: NativeService, account: NativeAccount, query: NativeQuery): Promise<void> {
  const scope = nativeScope(service.ServiceId, account.AccountId);
  const key = `ab1:seq:${scope}`;
  const row = await store.get<SequenceState>(key, query);
  const libraryIds = await currentLibraryIds(service, account, query);
  const permissions = permissionFingerprint(service, account, libraryIds);
  if (row?.value.permissions === permissions) return;
  const revision = nextRevision(row?.value.latestRevision ?? "0");
  const change: ChangeState = { ChangeRevision: revision, EntityType: "Permissions", EntityId: account.AccountId, EntityRevision: revision, Operation: "Upsert", State: { PermissionsRevision: permissions, LibraryIds: libraryIds }, CreatedAt: new Date().toISOString() };
  await store.put(`ab1:chg:${scope}:${revision.padStart(20, "0")}`, change, null, query);
  let pruned = row?.value.prunedThroughRevision ?? "0";
  const candidates = await store.scan<ChangeState>(`ab1:chg:${scope}:`, { limit: 100 }, query);
  for (const candidate of candidates) {
    if (BigInt(candidate.value.ChangeRevision) > BigInt(revision) - 20000n && Date.parse(candidate.value.CreatedAt) >= Date.now() - 7 * 86400000) break;
    await store.remove(candidate.key, candidate.revision, query);
    pruned = candidate.value.ChangeRevision;
  }
  await store.put(key, { latestRevision: revision, prunedThroughRevision: pruned, permissions }, row?.revision ?? null, query);
}

/** 仅从已授权实体投影摘要，避免以标题缓存绕过撤销库的权限。 */
export class NativeUserState {
  public constructor(private readonly runtime: ApiRuntime, private readonly store: NativeStore, private readonly access: NativeAccess, private readonly catalog: NativeCatalog) {}

  /** 有界重试整笔事务，CAS 失败不会留下半条索引或日志。 */
  public async transaction<T>(operation: (query: NativeQuery) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.store.transaction(operation); }
      catch (error) {
        const code = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : "";
        if (attempt >= 3 || !["native_state_conflict", "40001", "40P01", "SQLITE_BUSY", "ER_LOCK_DEADLOCK"].includes(code)) throw error;
      }
    }
  }

  /** 所有用户状态键都保留入口账号前缀，便于范围分页及按域清理。 */
  public key(context: NativeContext, kind: string, id = ""): string {
    const prefix = `ab1:${kind}:${nativeScope(context.service.ServiceId, context.account.AccountId)}`;
    return id ? `${prefix}:${nativeHash(id)}` : prefix;
  }

  /** 时间和身份一起组成稳定排序索引；同毫秒更新不会丢记录。 */
  private indexKey(context: NativeContext, kind: string, id: string, time: string): string {
    return `${this.key(context, kind)}:${String(Date.parse(time)).padStart(13, "0")}:${nativeHash(id)}`;
  }

  /** 获取账号同步序列，不附带全账号进度。 */
  private async sequence(context: NativeContext, query?: NativeQuery): Promise<NativeStored<SequenceState> | null> {
    return this.store.get<SequenceState>(`ab1:seq:${nativeScope(context.service.ServiceId, context.account.AccountId)}`, query);
  }

  /** 递增账号序列并写一条变更，同时有限清理七天或两万条以外的日志。 */
  public async recordChange(context: NativeContext, change: Omit<ChangeState, "ChangeRevision" | "CreatedAt">, query: NativeQuery): Promise<string> {
    const scope = nativeScope(context.service.ServiceId, context.account.AccountId);
    const row = await this.sequence(context, query);
    const revision = nextRevision(row?.value.latestRevision ?? "0");
    const sequence: SequenceState = { latestRevision: revision, prunedThroughRevision: row?.value.prunedThroughRevision ?? "0", permissions: permissionFingerprint(context.service, context.account, await currentLibraryIds(context.service, context.account, query)) };
    const prefix = `ab1:chg:${scope}:`;
    const now = new Date().toISOString();
    await this.store.put(`${prefix}${revision.padStart(20, "0")}`, { ...change, EntityRevision: change.EntityType === "Permissions" ? revision : change.EntityRevision, ChangeRevision: revision, CreatedAt: now }, null, query);
    const candidates = await this.store.scan<ChangeState>(prefix, { limit: 100 }, query);
    const oldestRetained = BigInt(revision) - 20000n;
    const cutoff = Date.now() - 7 * 86400000;
    for (const candidate of candidates) {
      if (BigInt(candidate.value.ChangeRevision) > oldestRetained && Date.parse(candidate.value.CreatedAt) >= cutoff) break;
      await this.store.remove(candidate.key, candidate.revision, query);
      sequence.prunedThroughRevision = candidate.value.ChangeRevision;
    }
    await this.store.put(`ab1:seq:${scope}`, sequence, row?.revision ?? null, query);
    return revision;
  }

  /** 首次访问或权限改变时只追加一条权限通知，不拉全账号数据。 */
  public async syncRevision(context: NativeContext): Promise<string> {
    return this.transaction(async (query) => {
      context = await this.access.refreshContext(context, query);
      const row = await this.sequence(context, query);
      const libraryIds = await currentLibraryIds(context.service, context.account, query);
      const permissions = permissionFingerprint(context.service, context.account, libraryIds);
      if (row?.value.permissions === permissions) return row.value.latestRevision;
      return this.recordChange(context, { EntityType: "Permissions", EntityId: context.account.AccountId, Operation: "Upsert", EntityRevision: "0", State: { PermissionsRevision: permissions, LibraryIds: libraryIds } }, query);
    });
  }

  /** 无收听记录仍返回明确的空续听点及修订号零。 */
  public async progressRow(context: NativeContext, bookId: string, query?: NativeQuery): Promise<NativeStored<NativeProgress> | null> {
    return this.store.get(this.key(context, "p", bookId), query);
  }

  /** 将内部写入权与索引位置从协议输出中移除。 */
  public presentProgress(progress: NativeProgress): Record<string, unknown> {
    const { WriterPlaySessionId: _writer, ContinueIndexKey: _index, LibraryId: _library, ...publicState } = progress;
    return publicState;
  }

  /** 冲突只附当前这本书的小进度，路由按公开字段白名单输出。 */
  public progressConflict(progress: NativeProgress): ApiError {
    return Object.assign(new ApiError(409, "progress_conflict", "续听进度已变化，请确认最新位置后重试"), { nativeDetails: { Progress: this.presentProgress(progress) } });
  }

  /** 构造未播放书籍的空进度，未知位置不能使用零伪装为已开始。 */
  public emptyProgress(book: MediaItemRecord): NativeProgress {
    return { BookId: book.id, LibraryId: book.libraryId, ChapterId: null, PositionSeconds: null, ChapterCompleted: false, BookCompleted: false, HiddenFromContinueListening: false, UpdatedAt: null, Revision: "0", WriterPlaySessionId: null };
  }

  /** 校验当前书籍权限后读取单本续听点。 */
  public async progress(context: NativeContext, bookId: string): Promise<Record<string, unknown>> {
    const book = await this.catalog.assertBook(context, bookId);
    return this.presentProgress((await this.progressRow(context, bookId))?.value ?? this.emptyProgress(book));
  }

  /** 在短事务中更新进度、继续收听索引、当前章状态及变更序列。 */
  public async saveProgress(context: NativeContext, progress: NativeProgress, previous: NativeStored<NativeProgress> | null, query: NativeQuery, updateChapter = true, automaticCompletion = false): Promise<NativeProgress> {
    const now = new Date().toISOString();
    const next: NativeProgress = { ...progress, Revision: nextRevision(previous?.value.Revision ?? "0"), UpdatedAt: now };
    if (previous?.value.ContinueIndexKey) {
      const oldIndex = await this.store.get(previous.value.ContinueIndexKey, query);
      if (oldIndex) await this.store.remove(previous.value.ContinueIndexKey, oldIndex.revision, query);
    }
    delete next.ContinueIndexKey;
    if (next.ChapterId && !next.HiddenFromContinueListening && !next.BookCompleted) {
      next.ContinueIndexKey = this.indexKey(context, "ci", next.BookId, now);
      await this.store.put(next.ContinueIndexKey, { BookId: next.BookId, LibraryId: next.LibraryId }, null, query);
    }
    if (updateChapter && next.ChapterId && next.PositionSeconds !== null) {
      const key = this.key(context, "cs", next.ChapterId);
      const prior = await this.store.get<NativeChapterState>(key, query);
      const state: NativeChapterState = { ChapterId: next.ChapterId, PositionSeconds: next.PositionSeconds, Completed: next.ChapterCompleted, Revision: nextRevision(prior?.value.Revision ?? "0") };
      await this.store.put(key, state, prior?.revision ?? null, query);
      const completeKey = `${this.completedPrefix(context, next.BookId)}${nativeHash(next.ChapterId).slice(0, 16)}`;
      const complete = await this.store.get(completeKey, query);
      if (state.Completed && !complete) await this.store.put(completeKey, { ChapterId: next.ChapterId, BookId: next.BookId }, null, query);
      if (!state.Completed && complete) await this.store.remove(completeKey, complete.revision, query);
      if (automaticCompletion && state.Completed && await this.isBookComplete(context, next, query)) {
        next.BookCompleted = true;
        if (next.ContinueIndexKey) { const index = await this.store.get(next.ContinueIndexKey, query); if (index) await this.store.remove(next.ContinueIndexKey, index.revision, query); delete next.ContinueIndexKey; }
      }
    }
    await this.store.put(this.key(context, "p", next.BookId), next, previous?.revision ?? null, query);
    await this.recordChange(context, { EntityType: "Progress", EntityId: next.BookId, EntityRevision: next.Revision, Operation: "Upsert", LibraryId: next.LibraryId, State: this.presentProgress(next) }, query);
    return next;
  }

  /** 每书完成章节索引用短身份键，不保存一个无限增长的章节数组。 */
  private completedPrefix(context: NativeContext, bookId: string): string { return `${this.key(context, "bc")}:${nativeHash(bookId).slice(0, 16)}:`; }

  /** 只在自然结束时用数据库计数核实当前全章完成，不把下架旧章计入当前作品。 */
  private async isBookComplete(context: NativeContext, progress: NativeProgress, query: NativeQuery): Promise<boolean> {
    const book = await query("media_items as b").join("media_libraries as l", "l.id", "b.library_id").where({ "b.id": progress.BookId, "b.user_id": context.service.OwnerUserId, "b.library_id": progress.LibraryId, "b.item_type": "audiobook.book" }).whereNull("b.deleted_at").first("b.metadata_json", "l.library_kind");
    if (!book) return false;
    const metadata = parseJsonObject(book.metadata_json);
    if (metadata.publicationStatus !== "Finished") return false;
    if (book.library_kind !== "content_source_audiobook") {
      const counted = await nativeLocalChapters(this.runtime).countCompletion(context, progress.BookId, this.completedPrefix(context, progress.BookId), query);
      return counted.complete && counted.total > 0 && counted.completed === counted.total;
    }
    if (book.library_kind === "content_source_audiobook") {
      const row = await query("system_settings").where({ setting_key: audiobookDirectoryKey(progress.LibraryId, progress.BookId) }).first();
      const directory = decodeAudiobookDirectory(row, progress.LibraryId, context.service.OwnerUserId, progress.BookId);
      if (metadata.audioDetailsLoaded !== true || !directory.catalogComplete && directory.status !== "NotLoaded") return false;
    }
    const chapters = query("media_relations as r").join("media_items as c", "c.id", "r.child_item_id").where({ "r.user_id": context.service.OwnerUserId, "r.library_id": progress.LibraryId, "r.parent_item_id": progress.BookId, "r.relation_type": "book_chapter", "c.item_type": "audiobook.chapter" }).whereNull("c.deleted_at");
    const total = await chapters.clone().countDistinct({ count: "c.id" }).first();
    const prefix = this.completedPrefix(context, progress.BookId);
    const extraction = this.runtime.database.databaseType === "postgres" ? "CAST(s.setting_value AS jsonb) ->> 'ChapterId'" : this.runtime.database.databaseType === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(s.setting_value, '$.ChapterId'))" : "json_extract(s.setting_value, '$.ChapterId')";
    const completed = await chapters.clone().join("system_settings as s", function joinCompletedChapter() { this.on("c.id", "=", query.raw(extraction)); }).where("s.setting_key", ">=", prefix).where("s.setting_key", "<", `${prefix}\u007f`).countDistinct({ count: "c.id" }).first();
    return Number(total?.count ?? 0) > 0 && Number(completed?.count ?? 0) === Number(total?.count ?? 0);
  }

  /** 状态提交前使用同一事务核对实体生命周期，不能写进已移除的书章。 */
  private async assertMutableBook(context: NativeContext, bookId: string, libraryId: string, query: NativeQuery, chapterId?: string): Promise<NativeContext> {
    const fresh = await this.access.assertTransactionContext(context, libraryId, query);
    const book = await query("media_items as b").join("media_libraries as l", "l.id", "b.library_id").where({ "b.id": bookId, "b.library_id": libraryId, "b.user_id": fresh.service.OwnerUserId, "b.item_type": "audiobook.book" }).whereNull("b.deleted_at").first("b.id", "l.library_kind");
    if (!book) throw new ApiError(404, "book_unavailable", "作品已移除或不可访问");
    if (chapterId) {
      if (book.library_kind !== "content_source_audiobook") { await nativeLocalChapters(this.runtime).assertRelation(fresh, bookId, chapterId, query); return fresh; }
      const relation = await query("media_relations as r").join("media_items as c", "c.id", "r.child_item_id").where({ "r.user_id": fresh.service.OwnerUserId, "r.library_id": libraryId, "r.parent_item_id": bookId, "r.child_item_id": chapterId, "r.relation_type": "book_chapter", "c.item_type": "audiobook.chapter" }).whereNull("c.deleted_at").first("c.id");
      if (!relation) throw new ApiError(404, "chapter_unavailable", "章节已移除或不属于当前作品");
    }
    return fresh;
  }

  /** 主动修改进度必须进行版本比较，并撤销此前播放会话的写入权。 */
  public async patchProgress(context: NativeContext, bookId: string, body: unknown): Promise<Record<string, unknown>> {
    const input = nativeObject(body);
    const expected = nativeRevision(input.ExpectedRevision);
    const book = await this.catalog.assertBook(context, bookId);
    const hasChapter = Object.hasOwn(input, "ChapterId");
    const hasPosition = Object.hasOwn(input, "PositionSeconds");
    if (hasChapter !== hasPosition) throw new ApiError(400, "invalid_position", "修改续听位置时必须同时提供章节和章内秒数");
    const chapterId = hasChapter ? nativeText(input.ChapterId, "ChapterId") : null;
    const position = hasPosition ? nativeSeconds(input.PositionSeconds, "PositionSeconds") : null;
    if (chapterId) await this.catalog.assertChapter(context, bookId, chapterId);
    for (const field of ["ChapterCompleted", "BookCompleted", "HiddenFromContinueListening"]) if (Object.hasOwn(input, field) && typeof input[field] !== "boolean") throw new ApiError(400, "invalid_request", `${field}必须为布尔值`);
    return this.transaction(async (query) => {
      context = await this.assertMutableBook(context, bookId, book.libraryId, query, chapterId ?? undefined);
      const previous = await this.progressRow(context, bookId, query);
      const current = previous?.value ?? this.emptyProgress(book);
      if (current.Revision !== expected) throw this.progressConflict(current);
      const updated = { ...current, WriterPlaySessionId: null };
      if (chapterId && position !== null) { updated.ChapterId = chapterId; updated.PositionSeconds = position; updated.ChapterCompleted = false; }
      if (input.ChapterCompleted !== undefined) updated.ChapterCompleted = input.ChapterCompleted as boolean;
      if (input.BookCompleted !== undefined) updated.BookCompleted = input.BookCompleted as boolean;
      if (input.HiddenFromContinueListening !== undefined) updated.HiddenFromContinueListening = input.HiddenFromContinueListening as boolean;
      if (updated.ChapterCompleted && !updated.ChapterId) throw new ApiError(400, "invalid_position", "尚无当前章节，不能标记章节完成");
      return this.presentProgress(await this.saveProgress(context, updated, previous, query));
    });
  }

  /** 当前目录页最多读取一百条章节状态，不下载整书记录。 */
  public async chapterStates(context: NativeContext, chapterIds: string[]): Promise<Record<string, NativeChapterState>> {
    if (chapterIds.length > 100) throw new ApiError(400, "invalid_limit", "章节状态一次最多读取100项");
    if (!chapterIds.length) return {};
    const keys = new Map(chapterIds.map((id) => [this.key(context, "cs", id), id]));
    const rows = await this.runtime.database.query("system_settings").whereIn("setting_key", [...keys.keys()]).select("setting_key", "setting_value");
    const states: Record<string, NativeChapterState> = Object.fromEntries(chapterIds.map((id) => [id, { ChapterId: id, PositionSeconds: null, Completed: false, Revision: "0" }]));
    for (const row of rows) {
      const id = keys.get(String(row.setting_key));
      if (!id) continue;
      try { const value = JSON.parse(String(row.setting_value)) as NativeChapterState; if (value.ChapterId !== id) throw new Error("scope"); states[id] = value; }
      catch { throw new ApiError(500, "native_storage_corrupt", "章节收听状态无法读取"); }
    }
    return states;
  }

  /** 状态列表游标保持初始同步基线，排序变化由后续增量修复。 */
  private async listIndex(context: NativeContext, kind: string, input: Record<string, unknown>, project: (value: Record<string, unknown>) => Promise<unknown | null>): Promise<Record<string, unknown>> {
    const limit = nativeLimit(input.limit);
    const scope = nativeCursorScope(context, kind);
    const cursor = input.cursor ? decodeNativeCursor(input.cursor, scope) : null;
    const baseline = cursor ? nativeRevision(cursor.Baseline) : await this.syncRevision(context);
    const prefix = `${this.key(context, kind)}:`;
    const before = cursor ? nativeText(cursor.Before, "cursor.Before", 100) : undefined;
    if (before && !before.startsWith(prefix)) throw new ApiError(400, "invalid_cursor", "分页游标不属于当前账号");
    const rows = await this.store.scan<Record<string, unknown>>(prefix, { before, limit: limit + 1, desc: true });
    const selected = rows.slice(0, limit);
    const items: unknown[] = [];
    for (const row of selected) {
      try { const value = await project(row.value); if (value !== null) items.push(value); }
      catch (error) {
        const unavailable = error instanceof ApiError && (error.statusCode === 409 && ["content_plugin_disabled", "audiobook_library_unavailable", "audiobook_library_not_found", "audiobook_source_unavailable", "source_changed"].includes(error.code) || [403, 404, 410, 503].includes(error.statusCode));
        if (!unavailable) throw error;
      }
    }
    const hasMore = rows.length > limit;
    return { Items: items, NextCursor: hasMore ? encodeNativeCursor({ Scope: scope, Before: selected.at(-1)!.key, Baseline: baseline }) : null, HasMore: hasMore, TotalCount: null, SyncBaselineRevision: baseline };
  }

  /** 继续收听从更新时间索引分页，只加载当前页摘要。 */
  public async continueListening(context: NativeContext, query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.listIndex(context, "ci", query, async (value) => {
      const book = await this.catalog.assertBook(context, String(value.BookId));
      const progress = (await this.progressRow(context, book.id))?.value;
      if (!progress || progress.HiddenFromContinueListening || progress.BookCompleted) return null;
      return { ...await this.catalog.summary(context, book), Progress: this.presentProgress(progress) };
    });
  }

  /** 收藏列表不使用全账号数组，只分页读取时间索引。 */
  public async favorites(context: NativeContext, query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.listIndex(context, "fi", query, async (value) => this.catalog.summary(context, await this.catalog.assertBook(context, String(value.BookId))));
  }

  /** 幂等收藏切换在同一事务维护主状态、索引和删除墓碑。 */
  public async favorite(context: NativeContext, bookId: string, favorite: boolean): Promise<Record<string, unknown>> {
    const book = await this.catalog.assertBook(context, bookId);
    return this.transaction(async (query) => {
      context = await this.assertMutableBook(context, bookId, book.libraryId, query);
      const key = this.key(context, "f", bookId);
      const previous = await this.store.get<FavoriteState>(key, query);
      if (previous?.value.Favorite === favorite) return { BookId: bookId, Favorite: favorite, Revision: previous.value.Revision };
      if (previous?.value.IndexKey) { const row = await this.store.get(previous.value.IndexKey, query); if (row) await this.store.remove(previous.value.IndexKey, row.revision, query); }
      const now = new Date().toISOString();
      const state: FavoriteState = { BookId: bookId, LibraryId: book.libraryId, Favorite: favorite, Revision: nextRevision(previous?.value.Revision ?? "0"), UpdatedAt: now };
      if (favorite) { state.IndexKey = this.indexKey(context, "fi", bookId, now); await this.store.put(state.IndexKey, { BookId: bookId, LibraryId: book.libraryId }, null, query); }
      await this.store.put(key, state, previous?.revision ?? null, query);
      const result = { BookId: bookId, Favorite: favorite, Revision: state.Revision };
      await this.recordChange(context, { EntityType: "Favorite", EntityId: bookId, EntityRevision: state.Revision, Operation: favorite ? "Upsert" : "Delete", LibraryId: book.libraryId, State: result }, query);
      return result;
    });
  }

  /** 书签主键按作品范围独立分页，避免整账号扫描后过滤。 */
  private bookmarkPrefix(context: NativeContext, bookId: string): string { return `${this.key(context, "bm", bookId)}:`; }

  /** 书签页只包含当前作品的少量用户数据。 */
  public async bookmarks(context: NativeContext, bookId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.catalog.assertBook(context, bookId);
    const limit = nativeLimit(input.limit);
    const scope = nativeCursorScope(context, `bookmarks:${bookId}`);
    const cursor = input.cursor ? decodeNativeCursor(input.cursor, scope) : null;
    const baseline = cursor ? nativeRevision(cursor.Baseline) : await this.syncRevision(context);
    const prefix = this.bookmarkPrefix(context, bookId);
    const after = cursor ? nativeText(cursor.After, "cursor.After", 100) : undefined;
    if (after && !after.startsWith(prefix)) throw new ApiError(400, "invalid_cursor", "书签游标不属于当前作品");
    const rows = await this.store.scan<BookmarkState>(prefix, { after, limit: limit + 1 });
    const selected = rows.slice(0, limit);
    return { Items: selected.map((entry) => { const { LibraryId: _library, ...state } = entry.value; return state; }), NextCursor: rows.length > limit ? encodeNativeCursor({ Scope: scope, After: selected.at(-1)!.key, Baseline: baseline }) : null, HasMore: rows.length > limit, TotalCount: null, SyncBaselineRevision: baseline };
  }

  /** 书签键保留作品和账号作用域，实体 ID 使用 UUID 防重建版本回绕。 */
  private bookmarkKey(context: NativeContext, bookId: string, bookmarkId: string): string { return `${this.bookmarkPrefix(context, bookId)}${nativeHash(bookmarkId).slice(0, 16)}`; }

  /** 新建单个书签，位置和章节必须属于当前作品。 */
  public async createBookmark(context: NativeContext, bookId: string, body: unknown): Promise<Record<string, unknown>> {
    const input = nativeObject(body);
    const chapterId = nativeText(input.ChapterId, "ChapterId");
    const position = nativeSeconds(input.PositionSeconds, "PositionSeconds");
    const book = await this.catalog.assertBook(context, bookId);
    await this.catalog.assertChapter(context, bookId, chapterId);
    const title = input.Title === undefined ? "" : typeof input.Title === "string" && [...input.Title].length <= 256 ? input.Title : null;
    if (title === null) throw new ApiError(400, "invalid_request", "书签标题最多256个字符");
    const now = new Date().toISOString();
    const bookmark: BookmarkState = { BookmarkId: randomUUID(), BookId: bookId, LibraryId: book.libraryId, ChapterId: chapterId, PositionSeconds: position, Title: title, Revision: "1", CreatedAt: now, UpdatedAt: now };
    await this.transaction(async (query) => { context = await this.assertMutableBook(context, bookId, book.libraryId, query, chapterId); await this.store.put(this.bookmarkKey(context, bookId, bookmark.BookmarkId), bookmark, null, query); await this.recordChange(context, { EntityType: "Bookmark", EntityId: bookmark.BookmarkId, EntityRevision: "1", Operation: "Upsert", LibraryId: book.libraryId, State: bookmark }, query); });
    const { LibraryId: _library, ...result } = bookmark;
    return result;
  }

  /** 书签修改必须带实体修订号，不覆盖另一设备的编辑。 */
  public async updateBookmark(context: NativeContext, bookId: string, bookmarkId: string, body: unknown): Promise<Record<string, unknown>> {
    const input = nativeObject(body);
    const expected = nativeRevision(input.ExpectedRevision);
    const book = await this.catalog.assertBook(context, bookId);
    if (Object.hasOwn(input, "ChapterId") !== Object.hasOwn(input, "PositionSeconds")) throw new ApiError(400, "invalid_position", "修改位置需同时提供章节和秒数");
    const chapterId = input.ChapterId === undefined ? undefined : nativeText(input.ChapterId, "ChapterId");
    const position = input.PositionSeconds === undefined ? undefined : nativeSeconds(input.PositionSeconds, "PositionSeconds");
    if (chapterId) await this.catalog.assertChapter(context, bookId, chapterId);
    if (input.Title !== undefined && (typeof input.Title !== "string" || [...input.Title].length > 256)) throw new ApiError(400, "invalid_request", "书签标题最多256个字符");
    return this.transaction(async (query) => {
      context = await this.assertMutableBook(context, bookId, book.libraryId, query, chapterId);
      const key = this.bookmarkKey(context, bookId, bookmarkId);
      const row = await this.store.get<BookmarkState>(key, query);
      if (!row || row.value.BookmarkId !== bookmarkId) throw new ApiError(404, "bookmark_not_found", "书签不存在");
      if (row.value.Revision !== expected) throw new ApiError(409, "bookmark_conflict", "书签已被其他设备修改");
      const state = { ...row.value, ChapterId: chapterId ?? row.value.ChapterId, PositionSeconds: position ?? row.value.PositionSeconds, Title: typeof input.Title === "string" ? input.Title : row.value.Title, Revision: nextRevision(row.value.Revision), UpdatedAt: new Date().toISOString() };
      await this.store.put(key, state, row.revision, query);
      await this.recordChange(context, { EntityType: "Bookmark", EntityId: bookmarkId, EntityRevision: state.Revision, Operation: "Upsert", LibraryId: state.LibraryId, State: state }, query);
      const { LibraryId: _library, ...result } = state;
      return result;
    });
  }

  /** 删除自己的书签并保留增量墓碑，不返回整本书书签列表。 */
  public async deleteBookmark(context: NativeContext, bookId: string, bookmarkId: string): Promise<Record<string, unknown>> {
    const book = await this.catalog.assertBook(context, bookId);
    return this.transaction(async (query) => {
      context = await this.assertMutableBook(context, bookId, book.libraryId, query);
      const key = this.bookmarkKey(context, bookId, bookmarkId);
      const row = await this.store.get<BookmarkState>(key, query);
      if (!row || row.value.BookmarkId !== bookmarkId) return { BookmarkId: bookmarkId, Deleted: true };
      await this.store.remove(key, row.revision, query);
      const revision = nextRevision(row.value.Revision);
      await this.recordChange(context, { EntityType: "Bookmark", EntityId: bookmarkId, EntityRevision: revision, Operation: "Delete", LibraryId: row.value.LibraryId, State: { BookId: bookId, BookmarkId: bookmarkId } }, query);
      return { BookmarkId: bookmarkId, Deleted: true, Revision: revision };
    });
  }

  /** 播放事务直接更新会话历史，索引始终按最初创建时间定位。 */
  public async saveHistory(context: NativeContext, history: NativeHistory, query: NativeQuery): Promise<void> {
    const key = this.indexKey(context, "hi", history.PlaySessionId, history.StartedAt);
    const row = await this.store.get<NativeHistory>(key, query);
    const state = { ...history, Revision: nextRevision(row?.value.Revision ?? "0") };
    await this.store.put(key, state, row?.revision ?? null, query);
    await this.recordChange(context, { EntityType: "ListeningHistory", EntityId: state.PlaySessionId, EntityRevision: state.Revision, Operation: "Upsert", LibraryId: state.LibraryId, State: state }, query);
  }

  /** 历史按会话摘要分页，源站 URL 和整书快照不进入历史。 */
  public async history(context: NativeContext, query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.listIndex(context, "hi", query, async (value) => ({ ...value, Book: await this.catalog.summary(context, await this.catalog.assertBook(context, String(value.BookId))) }));
  }

  /** 固定增量上界并逐页检查清理低水位，不能把日志缺失当已完成同步。 */
  public async changes(context: NativeContext, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (input.cursor !== undefined && input.sinceRevision !== undefined) throw new ApiError(400, "invalid_cursor", "cursor和sinceRevision不能同时传入");
    await this.syncRevision(context);
    const limit = nativeLimit(input.limit, 50);
    const scope = nativeCursorScope(context, "changes");
    const cursor = input.cursor ? decodeNativeCursor(input.cursor, scope) : null;
    const delivered = nativeRevision(cursor?.Delivered ?? input.sinceRevision ?? "0", "sinceRevision");
    const prefix = `ab1:chg:${nativeScope(context.service.ServiceId, context.account.AccountId)}:`;
    return this.transaction(async (query) => {
      context = await this.access.refreshContext(context, query);
      const head = (await this.sequence(context, query))?.value ?? { latestRevision: "0", prunedThroughRevision: "0", permissions: "" };
      if (BigInt(delivered) < BigInt(head.prunedThroughRevision)) throw new ApiError(410, "sync_reset_required", "用户状态增量已清理，请逐页重新建立缓存");
      const snapshot = cursor ? nativeRevision(cursor.Snapshot) : head.latestRevision;
      if (BigInt(snapshot) > BigInt(head.latestRevision) || BigInt(delivered) > BigInt(snapshot)) throw new ApiError(400, "invalid_revision", "同步版本超出当前账号范围");
      const rows = await this.store.scan<ChangeState>(prefix, { after: `${prefix}${delivered.padStart(20, "0")}`, before: `${prefix}${snapshot.padStart(20, "0")}~`, limit: limit + 1 }, query);
      // 关键变量：READ COMMITTED 下逐语句可能读到清理后的日志，交付前再核对清理低水位。
      const checkedHead = (await this.sequence(context, query))?.value;
      if (checkedHead && BigInt(delivered) < BigInt(checkedHead.prunedThroughRevision)) throw new ApiError(410, "sync_reset_required", "尚未交付的增量已清理，请重新建立缓存");
      const selected = rows.slice(0, limit);
      const allowed = new Set(await currentLibraryIds(context.service, context.account, query));
      const items = selected.filter((entry) => !entry.value.LibraryId || allowed.has(entry.value.LibraryId)).map((entry) => { const { CreatedAt: _created, LibraryId: _library, ...change } = entry.value; return change; });
      const hasMore = rows.length > limit;
      const sync = hasMore ? selected.at(-1)!.value.ChangeRevision : snapshot;
      return { Items: items, SnapshotRevision: snapshot, SyncRevision: sync, NextCursor: hasMore ? encodeNativeCursor({ Scope: scope, Delivered: sync, Snapshot: snapshot }) : null, HasMore: hasMore };
    });
  }
}
