import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { MediaItemRecord } from "../domain.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { NativeCatalogState } from "./catalog.js";
import { boundedText, catalogLimit, catalogPage, makeCatalogCursor, nativeCatalogItem, readCatalogCursor } from "./catalog-query.js";
import { NativeStore, nativeHash } from "./store.js";
import type { NativeContext, NativeQuery } from "./types.js";

/** 本地逻辑章索引只属于原生协议，既有媒体行、物理父子关系及ABS目录保持原样。 */
interface LocalChapter {
  ChapterId: string; BookId: string; LibraryId: string; OwnerUserId: string;
  PhysicalChapterId: string; PhysicalUpdatedAt: string; PhysicalGenerationId: string;
  FileId: string | null; FileModifiedAt: string | null; FileSize: number | null;
  Title: string; Order: number; Start: number; End: number | null; DurationMs: number | null; Embedded: boolean;
  CompletionSuffix: string;
}

/** 小型书籍索引头仅保存活动版本和后台任务；所有章节各自独立一行。 */
interface LocalHead {
  BookId: string; LibraryId: string; OwnerUserId: string;
  Status: "Preparing" | "Ready" | "Failed"; TargetRunId: string | null; LeaseUntil: string | null;
  PublishedRunId: string | null; SourceRevision: string | null; CatalogRevision: string;
  Count: number; LastError: string | null; CheckedAt: string | null;
  KnownDurationMs: number; UnknownDurationCount: number;
}

/** 与在线源保持相同的小目录状态，首次建立逻辑章索引允许返回202。 */
export interface NativeLocalDirectoryState {
  status: "NotLoaded" | "Preparing" | "Ready" | "Failed";
  catalogComplete: boolean; catalogRevision: string; chapterCount: number | null;
  checkedAt: string | null; lastError: string | null;
  durationSeconds: number | null; knownDurationSeconds: number; durationComplete: boolean;
}

/** 状态和播放事务核对真实物理资源，同时使用逻辑章边界保存章内位置。 */
export interface NativeLocalChapterRelation {
  physicalChapterId: string; audioStartOffsetSeconds: number; audioEndOffsetSeconds: number | null;
  catalogRevision: string; physicalUpdatedAt: string; physicalGenerationId: string; fileId: string | null;
}

/** 每个runtime共享后台任务，目录、播放与状态模块不会建立三套索引。 */
const instances = new WeakMap<ApiRuntime, NativeLocalChapters>();

/** 固定工厂避免在调用者之间重复建立后台任务队列。 */
export function nativeLocalChapters(runtime: ApiRuntime): NativeLocalChapters {
  let instance = instances.get(runtime);
  if (!instance) { instance = new NativeLocalChapters(runtime); instances.set(runtime, instance); }
  return instance;
}

/** 前缀末字符递增形成排他上界，范围查询不依赖特殊控制字符排序。 */
function upper(prefix: string): string { return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1); }

/** 每书及每次准备都固定短散列，最长索引键91字符，低于既有100字符限制。 */
function headKey(bookId: string): string { return `ab1:lchead:${nativeHash(bookId)}`; }
/** 目录按固定20位正整数排序，不使用OFFSET或全书数组。 */
function indexPrefix(bookId: string, runId: string): string { return `ab1:lcix:${nativeHash(bookId)}:${nativeHash(runId).slice(0, 16)}:`; }
/** 章节身份查找也按同一活动版本隔离，旧索引不可伪装为当前边界。 */
function lookupPrefix(bookId: string, runId: string): string { return `ab1:lcid:${nativeHash(bookId)}:${nativeHash(runId).slice(0, 16)}:`; }
/** 顺序键只作目录位置，章节永久身份不包含这个数字。 */
function orderKey(bookId: string, runId: string, order: number): string { return `${indexPrefix(bookId, runId)}${String(order).padStart(20, "0")}`; }

/** 将嵌入式章节从大物理元数据转换为一次性、严格有界的纯目录摘要。 */
function embeddedChapters(metadata: Record<string, unknown>): Array<{ title: string; start: number; end: number }> {
  if (!Array.isArray(metadata.chapters) || !metadata.chapters.length) return [];
  if (metadata.chapters.length > 20000) throw new ApiError(413, "local_chapter_limit", "本地文件内章节超过当前索引上限");
  const duration = Number(metadata.durationMs) / 1000;
  const chapters: Array<{ title: string; start: number; end: number }> = [];
  for (const value of metadata.chapters) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const chapter = value as Record<string, unknown>;
    const start = Number(chapter.start), end = Number(chapter.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || duration > 0 && end > duration + 0.01) return [];
    chapters.push({ title: boundedText(chapter.title, 1000, 4096), start, end });
  }
  chapters.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < chapters.length; index += 1) if (chapters[index]!.start < chapters[index - 1]!.end) return [];
  return chapters;
}

/** 本地M4B逻辑目录只使用system_settings小索引，不修改原扫描数据和ABS全书语义。 */
export class NativeLocalChapters {
  private readonly store: NativeStore;
  private readonly jobs = new Map<string, Promise<void>>();
  private closing = false;

  /** 保存原runtime引用，目录后台只读取已有资料，不触发网盘扫描和媒体探测。 */
  public constructor(private readonly runtime: ApiRuntime) { this.store = new NativeStore(runtime.database); }

  /** 所有轻量读取都复核入口账号交集、实际库和所有者，不能仅相信虚拟章ID。 */
  private async book(context: NativeContext, bookId: string, query: NativeQuery = this.runtime.database.query): Promise<MediaItemRecord> {
    const visible = context.service.LibraryIds.filter((id) => context.account.AllowedLibraryIds.includes(id));
    const row = await query("media_items as b").join("media_libraries as l", "l.id", "b.library_id")
      .where({ "b.id": bookId, "b.user_id": context.service.OwnerUserId, "b.item_type": "audiobook.book", "l.user_id": context.service.OwnerUserId, "l.status": "active", "l.data_type": "audiobook" })
      .whereIn("b.library_id", visible).whereNull("b.deleted_at").whereNot("l.library_kind", "content_source_audiobook")
      .select("b.*", "l.library_kind").first();
    if (!row) throw new ApiError(404, "book_unavailable", "本地有声书不存在或不可访问");
    return nativeCatalogItem(row);
  }

  /** 仅查询目录变更版本和小型书行，不把物理M4B的chapters数组带到普通请求。 */
  private async sourceRevision(context: NativeContext, book: MediaItemRecord, query: NativeQuery = this.runtime.database.query): Promise<string> {
    const row = await query("catalog_changes as c").where({ "c.user_id": context.service.OwnerUserId, "c.library_id": book.libraryId })
      .where((filter) => filter.where("c.entity_id", book.id).orWhereExists(function relatedChange() {
        this.select("r.id").from("media_relations as r").where({ "r.user_id": context.service.OwnerUserId, "r.library_id": book.libraryId, "r.parent_item_id": book.id, "r.relation_type": "book_chapter" }).whereRaw("?? = ??", ["r.child_item_id", "c.entity_id"]);
      })).max({ version: "c.catalog_version" }).first();
    const files = await this.physical(context, book, query).join("file_links as fl", function relatedFile() { this.on("fl.item_id", "=", "c.id").andOn("fl.user_id", "=", "c.user_id"); })
      .join("source_files as f", "f.id", "fl.source_file_id").where("f.status", "active")
      .count({ count: "f.id" }).max({ modified: "f.modified_at", updated: "f.updated_at" }).sum({ bytes: "f.size" }).first();
    return nativeHash(JSON.stringify([book.id, row?.version ?? "0", book.updatedAt, files?.count ?? 0, files?.modified ?? null, files?.updated ?? null, files?.bytes ?? 0]));
  }

  /** 目录版本同时检测扫描资料变化，防止旧逻辑边界获得错误304确认。 */
  public async bookRevision(context: NativeContext, book: MediaItemRecord, query: NativeQuery = this.runtime.database.query): Promise<string> {
    const source = await this.sourceRevision(context, book, query);
    const head = await this.store.get<LocalHead>(headKey(book.id), query);
    return head?.value.PublishedRunId && head.value.SourceRevision === source ? head.value.CatalogRevision : `pending-${source}`;
  }

  /** 公开状态不携带活动任务身份、路径和文件定位。 */
  private state(head: LocalHead | null, source: string): NativeLocalDirectoryState {
    const ready = Boolean(head?.PublishedRunId && head.SourceRevision === source && head.Status === "Ready");
    const durationComplete = ready && head!.Count > 0 && head!.UnknownDurationCount === 0;
    return { status: ready ? "Ready" : head?.Status === "Ready" ? "Preparing" : head?.Status ?? "NotLoaded", catalogComplete: ready,
      catalogRevision: ready ? head!.CatalogRevision : `pending-${source}`, chapterCount: ready ? head!.Count : null,
      checkedAt: head?.CheckedAt ?? null, lastError: head?.LastError ?? null,
      durationSeconds: durationComplete ? head!.KnownDurationMs / 1000 : null,
      knownDurationSeconds: ready ? Number(head!.KnownDurationMs ?? 0) / 1000 : 0, durationComplete };
  }

  /** 首次只领取小型任务后立即返回，完整解析由后台执行，重复请求共享同一任务。 */
  public async prepare(context: NativeContext, book: MediaItemRecord, sourceRevision?: string): Promise<NativeLocalDirectoryState> {
    if (this.closing) throw new ApiError(503, "service_unavailable", "原生听书服务正在停止");
    const source = sourceRevision ?? await this.sourceRevision(context, book);
    const key = headKey(book.id);
    const previous = await this.store.get<LocalHead>(key);
    if (previous?.value.Status === "Ready" && previous.value.SourceRevision === source) return this.state(previous.value, source);
    if (this.jobs.has(key)) return this.state(previous?.value ?? null, source);
    if (this.jobs.size >= 4) return { ...this.state(previous?.value ?? null, source), status: "Preparing" };
    if (this.closing) throw new ApiError(503, "service_unavailable", "原生听书服务正在停止");
    const runId = randomUUID();
    const claim = this.store.transaction(async (query) => {
      const currentBook = await this.book(context, book.id, query);
      if (await this.sourceRevision(context, currentBook, query) !== source) throw new ApiError(409, "catalog_changed", "本地作品资料正在更新，请重新读取");
      let lock = query("media_items").where({ id: book.id, user_id: context.service.OwnerUserId }).select("id");
      if (this.runtime.database.databaseType !== "sqlite") lock = lock.forUpdate();
      await lock.first();
      await this.store.lock(key, query);
      const current = await this.store.get<LocalHead>(key, query);
      if (current?.value.Status === "Ready" && current.value.SourceRevision === source) return null;
      if (current?.value.Status === "Preparing" && Date.parse(current.value.LeaseUntil ?? "") > Date.now()) return null;
      const head: LocalHead = { BookId: book.id, LibraryId: book.libraryId, OwnerUserId: context.service.OwnerUserId,
        Status: "Preparing", TargetRunId: runId, LeaseUntil: new Date(Date.now() + 120000).toISOString(),
        PublishedRunId: current?.value.PublishedRunId ?? null, SourceRevision: current?.value.SourceRevision ?? null,
        CatalogRevision: current?.value.CatalogRevision ?? "0", Count: current?.value.Count ?? 0, LastError: null, CheckedAt: current?.value.CheckedAt ?? null,
        KnownDurationMs: current?.value.KnownDurationMs ?? 0, UnknownDurationCount: current?.value.UnknownDurationCount ?? 0 };
      await this.store.put(key, head, current?.revision ?? null, query);
      return head;
    });
    const task = claim.then(async (claimed) => { if (claimed) await this.build(context, book, source, runId); }).catch(async (error) => {
      let removeStaged = true;
      await this.store.transaction(async (query) => {
        await this.store.lock(key, query);
        const current = await this.store.get<LocalHead>(key, query);
        // 发布成功后的旧版本清理失败不能回头删除当前活动索引。
        if (current?.value.PublishedRunId === runId) removeStaged = false;
        if (current?.value.TargetRunId === runId) await this.store.put(key, { ...current.value, Status: "Failed", TargetRunId: null, LeaseUntil: null, LastError: error instanceof ApiError ? error.message : "本地逻辑章节索引准备失败" }, current.revision, query);
      });
      if (removeStaged) await this.removeRun(book.id, runId);
    }).finally(() => { if (this.jobs.get(key) === task) this.jobs.delete(key); });
    // 关键变量：第一次异步等待前登记领取及构建任务，避免同进程并发领取和关闭时漏等。
    this.jobs.set(key, task);
    void task.catch(() => undefined);
    const claimed = await claim;
    if (!claimed) return this.state((await this.store.get<LocalHead>(key))?.value ?? null, source);
    return this.state(claimed, source);
  }

  /** 物理章分页只用于后台索引，普通章节请求不再重复读取内嵌全目录。 */
  private physical(context: NativeContext, book: MediaItemRecord, query: NativeQuery = this.runtime.database.query): Knex.QueryBuilder {
    return query("media_relations as r").join("media_items as c", "c.id", "r.child_item_id")
      .where({ "r.user_id": context.service.OwnerUserId, "r.library_id": book.libraryId, "r.parent_item_id": book.id, "r.relation_type": "book_chapter", "c.user_id": context.service.OwnerUserId, "c.library_id": book.libraryId, "c.item_type": "audiobook.chapter" }).whereNull("c.deleted_at");
  }

  /** 后台每个物理页批量读取文件身份，优先匹配生成该物理章元数据的sourcePath。 */
  private async files(context: NativeContext, ids: string[]): Promise<Map<string, Record<string, unknown>[]>> {
    const rows = await this.runtime.database.query("file_links as fl").join("source_files as f", "f.id", "fl.source_file_id")
      .join("library_sources as ls", "ls.id", "f.library_source_id").where("fl.user_id", context.service.OwnerUserId).where("f.user_id", context.service.OwnerUserId)
      .whereIn("fl.item_id", ids).where({ "f.status": "active", "ls.status": "active" })
      .select("fl.item_id", "f.id", "f.path", "f.modified_at", "f.size").orderBy("ls.sort_order", "asc").orderBy("f.path", "asc").orderBy("f.id", "asc");
    const result = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) { const key = String(row.item_id); const values = result.get(key) ?? []; values.push(row); result.set(key, values); }
    return result;
  }

  /** 小索引双写顺序键及身份键，每批最多50章；活动指针只在全部成功后切换。 */
  private async saveBatch(context: NativeContext, book: MediaItemRecord, runId: string, values: LocalChapter[]): Promise<void> {
    if (this.closing) throw new ApiError(503, "service_unavailable", "原生听书服务正在停止");
    if (!values.length) return;
    await this.store.transaction(async (query) => {
      const present = await query("media_items").where({ id: book.id, user_id: context.service.OwnerUserId, library_id: book.libraryId }).whereNull("deleted_at").first("id");
      if (!present) throw new ApiError(404, "book_unavailable", "本地作品已移除");
      await this.store.lock(headKey(book.id), query);
      const head = await this.store.get<LocalHead>(headKey(book.id), query);
      if (head?.value.TargetRunId !== runId) throw new ApiError(409, "catalog_changed", "本地目录准备任务已被替换");
      const now = new Date().toISOString();
      const rows = values.flatMap((value) => {
        const payload = JSON.stringify(value);
        if (Buffer.byteLength(payload) > 8192) throw new ApiError(413, "source_item_too_large", "单条本地章节摘要过大");
        return [orderKey(book.id, runId, value.Order), `${lookupPrefix(book.id, runId)}${nativeHash(value.ChapterId)}`].map((key) => ({ setting_key: key, setting_value: payload, revision: 1, updated_by_user_id: context.service.OwnerUserId, created_at: now, updated_at: now }));
      });
      await query("system_settings").insert(rows);
      await this.store.put(headKey(book.id), { ...head.value, LeaseUntil: new Date(Date.now() + 120000).toISOString() }, head.revision, query);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** 首次可读取一个M4B的完整内嵌元数据一次，之后落为逐章小索引，不每次请求重复解析。 */
  private async build(context: NativeContext, book: MediaItemRecord, source: string, runId: string): Promise<void> {
    let lastOrder: number | null = null, lastId = "", count = 0, knownDurationMs = 0, unknownDurationCount = 0;
    let batch: LocalChapter[] = [];
    const digest = createHash("sha256");
    while (true) {
      if (this.closing) throw new ApiError(503, "service_unavailable", "原生听书服务正在停止");
      const builder = this.physical(context, book);
      if (lastOrder !== null) builder.where((filter) => filter.where("r.sort_order", ">", lastOrder!).orWhere((same) => same.where("r.sort_order", lastOrder!).where("c.id", ">", lastId)));
      const rows: Record<string, unknown>[] = await builder.select("c.*", "r.sort_order as source_order").orderBy("r.sort_order", "asc").orderBy("c.id", "asc").limit(10);
      if (!rows.length) break;
      const files = await this.files(context, rows.map((row) => String(row.id)));
      for (const row of rows) {
        const metadata = parseJsonObject(row.metadata_json);
        const candidates = files.get(String(row.id)) ?? [];
        const file = candidates.find((entry) => entry.path === metadata.sourcePath) ?? candidates[0];
        const embedded = embeddedChapters(metadata);
        const fragments = embedded.length ? embedded : [{ title: String(row.title), start: 0, end: null }];
        for (const fragment of fragments) {
          count += 1;
          if (count > 20000) throw new ApiError(413, "local_chapter_limit", "本地作品逻辑章节超过当前索引上限");
          const duration = Number(metadata.durationMs);
          const chapterId = embedded.length ? `nlc_${nativeHash(JSON.stringify([row.id, fragment.start, fragment.end]))}` : String(row.id);
          const value: LocalChapter = { ChapterId: chapterId,
            BookId: book.id, LibraryId: book.libraryId, OwnerUserId: context.service.OwnerUserId,
            PhysicalChapterId: String(row.id), PhysicalUpdatedAt: String(row.updated_at), PhysicalGenerationId: String(row.generation_id),
            FileId: file ? String(file.id) : null, FileModifiedAt: file?.modified_at ? String(file.modified_at) : null, FileSize: file ? Number(file.size) : null,
            Title: fragment.title || String(row.title), Order: count, Start: fragment.start, End: fragment.end,
            DurationMs: fragment.end !== null ? (fragment.end - fragment.start) * 1000 : Number.isFinite(duration) && duration > 0 ? duration : null, Embedded: embedded.length > 0,
            CompletionSuffix: nativeHash(chapterId).slice(0, 16) };
          if (value.DurationMs === null) unknownDurationCount += 1; else knownDurationMs += value.DurationMs;
          // 关键变量：检查时间及扫描代际不是章节内容，不能让无变化扫描重置原生目录版本。
          digest.update(JSON.stringify([value.ChapterId, value.Title, value.Order, value.Start, value.End, value.DurationMs, value.FileId, value.FileModifiedAt, value.FileSize]));
          batch.push(value);
          if (batch.length >= 50) { await this.saveBatch(context, book, runId, batch); batch = []; }
        }
      }
      lastOrder = Number(rows.at(-1)!.source_order); lastId = String(rows.at(-1)!.id);
    }
    await this.saveBatch(context, book, runId, batch);
    const revision = digest.digest("hex").slice(0, 32);
    let previousRun: string | null = null;
    await this.store.transaction(async (query) => {
      const currentBook = await this.book(context, book.id, query);
      if (await this.sourceRevision(context, currentBook, query) !== source) throw new ApiError(409, "catalog_changed", "本地资料在索引期间变化，请重新准备");
      await this.store.lock(headKey(book.id), query);
      const head = await this.store.get<LocalHead>(headKey(book.id), query);
      if (head?.value.TargetRunId !== runId) throw new ApiError(409, "catalog_changed", "本地目录任务已被替换");
      previousRun = head.value.PublishedRunId;
      await this.store.put(headKey(book.id), { ...head.value, Status: "Ready", TargetRunId: null, LeaseUntil: null, PublishedRunId: runId, SourceRevision: source, CatalogRevision: revision, Count: count, LastError: null, CheckedAt: new Date().toISOString(), KnownDurationMs: knownDurationMs, UnknownDurationCount: unknownDurationCount }, head.revision, query);
    });
    if (previousRun && previousRun !== runId) await this.removeRun(book.id, previousRun);
  }

  /** 旧版本及失败暂存各自按前缀小批清理，不扫描全部原生账号或媒体数据。 */
  private async removeRun(bookId: string, runId: string): Promise<void> {
    for (const prefix of [indexPrefix(bookId, runId), lookupPrefix(bookId, runId)]) {
      while (true) {
        const rows = await this.store.scan<LocalChapter>(prefix, { limit: 100 });
        if (!rows.length) break;
        await this.runtime.database.query("system_settings").whereIn("setting_key", rows.map((row) => row.key)).delete();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  /** 读取活动指针时检查当前实际书，写事务同时锁定指针，防止切章验证期间换代。 */
  private async ready(context: NativeContext, bookId: string, query: NativeQuery = this.runtime.database.query): Promise<{ book: MediaItemRecord; head: LocalHead }> {
    const book = await this.book(context, bookId, query);
    if (query !== this.runtime.database.query) await this.store.lock(headKey(bookId), query);
    const row = await this.store.get<LocalHead>(headKey(bookId), query);
    if (!row?.value.PublishedRunId || row.value.Status !== "Ready" || row.value.SourceRevision !== await this.sourceRevision(context, book, query)) {
      // 首次从续听直接进入也启动准备；写事务内只返回重试错误，不能另开默认连接自等待。
      if (query === this.runtime.database.query && !this.closing) void this.prepare(context, book).catch(() => undefined);
      throw new ApiError(409, "local_directory_preparing", "本地逻辑章节目录正在准备，请稍后重试");
    }
    if (row.value.BookId !== bookId || row.value.OwnerUserId !== context.service.OwnerUserId || row.value.LibraryId !== book.libraryId) throw new ApiError(409, "catalog_changed", "本地目录身份不匹配");
    return { book, head: row.value };
  }

  /** 只读取当前逻辑章的小KV，再核对物理关系、文件身份，不读取chapters大数组。 */
  private async entry(context: NativeContext, bookId: string, chapterId: string, query: NativeQuery = this.runtime.database.query): Promise<{ book: MediaItemRecord; head: LocalHead; entry: LocalChapter }> {
    const current = await this.ready(context, bookId, query);
    const row = await this.store.get<LocalChapter>(`${lookupPrefix(bookId, current.head.PublishedRunId!)}${nativeHash(chapterId)}`, query);
    const entry = row?.value;
    if (!entry) {
      const head = await this.store.get<LocalHead>(headKey(bookId), query);
      if (head?.value.PublishedRunId !== current.head.PublishedRunId) throw new ApiError(409, "catalog_changed", "本地目录版本正在切换，请重新读取");
    }
    if (!entry || entry.ChapterId !== chapterId || entry.BookId !== bookId || entry.LibraryId !== current.book.libraryId || entry.OwnerUserId !== context.service.OwnerUserId) throw new ApiError(404, "chapter_unavailable", "本地章节不存在或已经变化");
    const physical = await this.physical(context, current.book, query).where("c.id", entry.PhysicalChapterId).select("c.updated_at", "c.generation_id").first();
    if (!physical || String(physical.updated_at) !== entry.PhysicalUpdatedAt) throw new ApiError(409, "catalog_changed", "物理音频资料已变化，请重新读取目录");
    if (entry.FileId) {
      const file = await query("file_links as fl").join("source_files as f", "f.id", "fl.source_file_id").where({ "fl.user_id": context.service.OwnerUserId, "fl.item_id": entry.PhysicalChapterId, "f.id": entry.FileId, "f.user_id": context.service.OwnerUserId, "f.status": "active" }).select("f.modified_at", "f.size").first();
      if (!file || String(file.modified_at ?? "") !== (entry.FileModifiedAt ?? "") || Number(file.size) !== entry.FileSize) throw new ApiError(409, "catalog_changed", "物理音频文件已变化，请重新读取目录");
    }
    return { ...current, entry };
  }

  /** 虚拟MediaItemRecord只附小映射字段，物理M4B元数据不会再沿API传播。 */
  private item(book: MediaItemRecord, head: LocalHead, entry: LocalChapter): MediaItemRecord {
    return { ...book, id: entry.ChapterId, itemType: "audiobook.chapter", title: entry.Title, sortTitle: entry.Title, subtitle: book.title, overview: "", updatedAt: entry.PhysicalUpdatedAt,
      metadata: { nativePhysicalChapterId: entry.PhysicalChapterId, nativeFileId: entry.FileId, nativeLocalCatalogRevision: head.CatalogRevision,
        audioStartOffsetSeconds: entry.Start, audioEndOffsetSeconds: entry.End, nativeOrder: entry.Order - 1,
        durationMs: entry.DurationMs ?? 0, durationPending: entry.DurationMs === null, nativeEmbeddedChapter: entry.Embedded } };
  }

  /** 单章和邻章都从小型身份索引读取，原物理章在没有内嵌章时保持原ID。 */
  public async assertChapter(context: NativeContext, bookId: string, chapterId: string, query: NativeQuery = this.runtime.database.query): Promise<MediaItemRecord> {
    const value = await this.entry(context, bookId, chapterId, query);
    return this.item(value.book, value.head, value.entry);
  }

  /** 下一章只查询有序索引中的一个相邻位置，不展开全书。 */
  public async nextChapter(context: NativeContext, bookId: string, chapterId: string, query: NativeQuery = this.runtime.database.query): Promise<MediaItemRecord | null> {
    const current = await this.entry(context, bookId, chapterId, query);
    const next = await this.store.get<LocalChapter>(orderKey(bookId, current.head.PublishedRunId!, current.entry.Order + 1), query);
    return next ? this.assertChapter(context, bookId, next.value.ChapterId, query) : null;
  }

  /** 播放和状态事务使用同一目录指针，章内偏移不能伪装成物理文件新身份。 */
  public async assertRelation(context: NativeContext, bookId: string, chapterId: string, query: NativeQuery): Promise<NativeLocalChapterRelation> {
    const { head, entry } = await this.entry(context, bookId, chapterId, query);
    return { physicalChapterId: entry.PhysicalChapterId, audioStartOffsetSeconds: entry.Start, audioEndOffsetSeconds: entry.End,
      catalogRevision: head.CatalogRevision, physicalUpdatedAt: entry.PhysicalUpdatedAt, physicalGenerationId: entry.PhysicalGenerationId, fileId: entry.FileId };
  }

  /** 自动切章只能接当前活动索引的下一条，不能跳到另一本书或旧版本邻章。 */
  public async assertNext(context: NativeContext, bookId: string, chapterId: string, nextId: string, query: NativeQuery): Promise<void> {
    const next = await this.nextChapter(context, bookId, chapterId, query);
    if (!next || next.id !== nextId) throw new ApiError(409, "next_chapter_changed", "下一章已变化，请重新读取目录");
  }

  /** 逻辑章完成索引在数据库按当前版本关联计数，不能用物理文件数作为全章数。 */
  public async countCompletion(context: NativeContext, bookId: string, completedPrefix: string, query: NativeQuery): Promise<{ total: number; completed: number; complete: boolean }> {
    const { head } = await this.ready(context, bookId, query);
    const prefix = indexPrefix(bookId, head.PublishedRunId!);
    const extraction = (column: string, field: "ChapterId" | "BookId" | "CompletionSuffix" = "ChapterId"): string => this.runtime.database.databaseType === "postgres" ? `CAST(${column} AS jsonb) ->> '${field}'` : this.runtime.database.databaseType === "mysql" ? `JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.${field}'))` : `json_extract(${column}, '$.${field}')`;
    const completionKey = this.runtime.database.databaseType === "mysql" ? `CONCAT(?, ${extraction("idx.setting_value", "CompletionSuffix")})` : `? || (${extraction("idx.setting_value", "CompletionSuffix")})`;
    const result = await query("system_settings as idx").where("idx.setting_key", ">=", prefix).where("idx.setting_key", "<", upper(prefix))
      .whereExists(function completedLocalChapter() {
        // 关键变量：完整主键精确定位完成记录，再校验真实身份，避免每章扫描全部已完成索引。
        this.select("done.setting_key").from("system_settings as done").whereRaw(`done.setting_key = ${completionKey}`, [completedPrefix])
          .whereRaw(`${extraction("done.setting_value")} = ${extraction("idx.setting_value")}`).whereRaw(`${extraction("done.setting_value", "BookId")} = ?`, [bookId]);
      }).count({ count: "idx.setting_key" }).first();
    const completed = Number(result?.count ?? 0);
    return { total: head.Count, completed, complete: head.Count > 0 && completed === head.Count };
  }

  /** 当前页用户状态批量合并，around定位直接换算索引键，不依次读取前页。 */
  public async chapters(context: NativeContext, book: MediaItemRecord, query: Record<string, unknown>, state: NativeCatalogState): Promise<Record<string, unknown>> {
    const prepared = await this.prepare(context, book);
    if (!prepared.catalogComplete) return { Status: prepared.status === "Failed" ? "Failed" : "Preparing", RetryAfterSeconds: 2, CatalogRevision: prepared.catalogRevision };
    const limit = catalogLimit(query, 50);
    const scope = [context.service.ServiceId, context.account.AccountId, book.libraryId, book.id, "local-chapters"];
    const revision = await this.bookRevision(context, book);
    const cursor = readCatalogCursor(query.cursor, scope, revision);
    if ([query.cursor, query.aroundChapterId, query.aroundOrder].filter((value) => value !== undefined).length > 1) throw new ApiError(400, "invalid_query", "章节游标和定位参数不能同时使用");
    const { head } = await this.ready(context, book.id);
    let order = 0, backwards = cursor?.direction === "previous";
    if (cursor) {
      if (!Number.isSafeInteger(cursor.value) || Number(cursor.value) < 1) throw new ApiError(400, "invalid_cursor", "本地章节游标无效");
      order = Number(cursor.value);
    } else if (query.aroundChapterId !== undefined || query.aroundOrder !== undefined) {
      let target: number;
      if (query.aroundChapterId !== undefined) {
        if (typeof query.aroundChapterId !== "string") throw new ApiError(400, "invalid_query", "章节定位身份无效");
        target = (await this.entry(context, book.id, query.aroundChapterId)).entry.Order;
      } else {
        target = Number(query.aroundOrder);
        if (!Number.isSafeInteger(target) || target < 1 || target > head.Count) throw new ApiError(404, "chapter_unavailable", "章节顺序不在当前目录范围");
      }
      order = Math.max(0, Math.min(target - Math.floor(limit / 2) - 1, Math.max(0, head.Count - limit)));
      backwards = false;
    }
    const prefix = indexPrefix(book.id, head.PublishedRunId!);
    let rows = await this.store.scan<LocalChapter>(prefix, { limit: limit + 1, ...(backwards ? { before: orderKey(book.id, head.PublishedRunId!, order), desc: true } : order ? { after: orderKey(book.id, head.PublishedRunId!, order) } : {}) });
    rows = rows.slice(0, limit);
    if (backwards) rows.reverse();
    const userRevision = await state.syncRevision(context);
    const states = await state.chapterStates(context, rows.map((row) => row.value.ChapterId));
    const hadRows = rows.length > 0;
    const items = rows.map(({ value }) => ({ ChapterId: value.ChapterId, Order: value.Order, Title: boundedText(value.Title), TitleTruncated: boundedText(value.Title) !== value.Title,
      DurationSeconds: value.DurationMs === null ? null : value.DurationMs / 1000, UserState: states[value.ChapterId] }));
    while (items.length && Buffer.byteLength(JSON.stringify({ Items: items })) > 47000) {
      if (backwards) { items.shift(); rows.shift(); } else { items.pop(); rows.pop(); }
    }
    if (!items.length && hadRows) throw new ApiError(502, "source_item_too_large", "单章摘要超过响应预算");
    if (revision !== await this.bookRevision(context, book) || userRevision !== await state.syncRevision(context)) throw new ApiError(503, "consistent_read_retry_required", "目录或用户状态正在变化，请重试");
    const afterHead = await this.store.get<LocalHead>(headKey(book.id));
    if (afterHead?.value.PublishedRunId !== head.PublishedRunId) throw new ApiError(503, "consistent_read_retry_required", "本地目录索引正在切换，请重试");
    const first = rows[0]?.value, last = rows.at(-1)?.value;
    return { ...catalogPage(items, revision, last && last.Order < head.Count ? makeCatalogCursor(scope, revision, { id: last.ChapterId, value: last.Order, direction: "next" }) : null,
      first && first.Order > 1 ? makeCatalogCursor(scope, revision, { id: first.ChapterId, value: first.Order, direction: "previous" }) : null, head.Count), CatalogComplete: true, ChapterCatalogStatus: "Ready" };
  }

  /** 数据库关闭前停止新任务并等待当前小批次和失败清理收尾。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.jobs.values()]);
  }
}
