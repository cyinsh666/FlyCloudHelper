import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { NativeAccess } from "./access.js";
import type { NativeCatalog } from "./catalog.js";
import { nativeLocalChapters } from "./local-chapters.js";
import { NativeStore, nativeHash } from "./store.js";
import type { NativeContext, NativeQuery, NativeStored } from "./types.js";
import { nativeObject, nativeRevision, nativeSeconds, nativeText } from "./state-helpers.js";
import { NativeAudioStream, type NativePlayable } from "./stream.js";
import { NativeUserState, type NativeHistory, type NativeProgress } from "./user-state.js";

type PlayMode = "Auto" | "Direct" | "Relay";
type EventType = "Started" | "Progress" | "Paused" | "Stopped" | "Ended";
/** 播放会话只存章级状态和账本，不保存临时音频地址、Cookie 或整书资料。 */
interface PlaySession {
  PlaySessionId: string; ServiceId: string; AccountId: string; AuthSessionId: string;
  LibraryId: string; BookId: string; ChapterId: string; RequestedMode: PlayMode; PlayMethod: "Direct" | "Relay";
  MimeType: string; DurationSeconds: number | null; AudioStartOffsetSeconds: number; AudioEndOffsetSeconds: number | null;
  RequestedPositionSeconds: number; PositionSeconds: number; ResourceIdentity: string;
  CreatedAt: string; UpdatedAt: string; ExpiresAt: string; LastSequence: number; TotalListenedSeconds: number;
  LastEventType: EventType | null; EndedAt: string | null; NextChapterId: string | null;
  ProgressRevision: string; AdvancedToSessionId: string | null;
  ObservedDurationSeconds: number | null;
  CleanupKey?: string;
}
/** 事件确认持久化后重复返回首次业务结果，不能重复结算或接管。 */
interface EventResult { EventId: string; Accepted: boolean; ProgressApplied: boolean; LastSequence: number; ProgressRevision: string; ExpiresAt: string; Reason?: string; }
/** 事件载荷采用明确白名单形成摘要，便于判断相同 ID 的正文是否一致。 */
interface PlaybackEvent { EventId: string; Sequence: number; Type: EventType; PositionSeconds: number; TotalListenedSeconds: number; ObservedDurationSeconds: number | null; }
interface AcceptedEvent { Fingerprint: string; Event: PlaybackEvent; Result: EventResult; }
/** 创建和自动切章的幂等记录只引用会话和小确认。 */
interface IdempotentOperation { Kind: "Create" | "Advance"; Fingerprint: string; PlaySessionId: string; EndEventResult?: EventResult; ExpiresAt: string; }
/** 每个正在预取的消费者独立取消，不影响其他实际播放消费者。 */
interface Prefetch { ChapterId: string; cancel: () => void; }
/** 原生临时持久状态到期索引，按账号前缀分批回收而非整表扫描。 */
interface ExpiringState { TargetKey: string; ExpiresAt: string; Kind: "Session" | "Event" | "Operation"; }

/** 校验请求模式，显式模式不可用时不得悄悄变更。 */
function playMode(value: unknown): PlayMode {
  if (value === undefined) return "Auto";
  if (value !== "Auto" && value !== "Direct" && value !== "Relay") throw new ApiError(400, "invalid_play_mode", "播放方式须为Auto、Direct或Relay");
  return value;
}

/** 一次只处理一个小事件，序号仅限当前会话的安全整数。 */
function playbackEvent(body: unknown, endedOnly = false): PlaybackEvent {
  const value = nativeObject(body);
  const eventId = nativeText(value.EventId, "EventId");
  if (!Number.isSafeInteger(value.Sequence) || Number(value.Sequence) < 1) throw new ApiError(400, "invalid_sequence", "播放事件序号必须为正的安全整数");
  if (!["Started", "Progress", "Paused", "Stopped", "Ended"].includes(String(value.Type)) || endedOnly && value.Type !== "Ended") throw new ApiError(400, "invalid_event", endedOnly ? "切章只接受自然结束事件" : "播放事件类型无效");
  const observed = value.ObservedDurationSeconds === undefined || value.ObservedDurationSeconds === null ? null : nativeSeconds(value.ObservedDurationSeconds, "ObservedDurationSeconds");
  if (observed === 0) throw new ApiError(400, "invalid_duration", "未知时长请使用null，已知时长必须大于0");
  return { EventId: eventId, Sequence: Number(value.Sequence), Type: value.Type as EventType, PositionSeconds: nativeSeconds(value.PositionSeconds, "PositionSeconds"), TotalListenedSeconds: nativeSeconds(value.TotalListenedSeconds, "TotalListenedSeconds"), ObservedDurationSeconds: observed };
}

/** 原生按章会话独立于 ABS，全书时间轴不是开播和续听的前置条件。 */
export class NativePlayback {
  private readonly audio: NativeAudioStream;
  private readonly prefetch = new Map<string, Prefetch>();
  private readonly sweeping = new Set<string>();
  public constructor(private readonly runtime: ApiRuntime, private readonly store: NativeStore, private readonly access: NativeAccess, private readonly catalog: NativeCatalog, private readonly state: NativeUserState) { this.audio = new NativeAudioStream(runtime, access); }

  /** 播放实体使用账号域主键，其他入口不能猜 ID 访问。 */
  private sessionKey(context: NativeContext, sessionId: string): string { return this.state.key(context, "ps", sessionId); }
  /** 事件独立行保存，避免一个长会话无限扩大其 JSON。 */
  private eventKey(context: NativeContext, sessionId: string, eventId: string): string { return `${this.state.key(context, "ev")}:${nativeHash(sessionId).slice(0, 16)}:${nativeHash(eventId).slice(0, 16)}`; }
  /** 幂等键包含认证设备和操作路径，不将一个设备的重试跨章复用。 */
  private operationKey(context: NativeContext, kind: string, pathSessionId: string, idempotencyKey: string): string { return this.state.key(context, "id", JSON.stringify([context.authSession.AuthSessionId, kind, pathSessionId, idempotencyKey])); }

  /** 会话读取始终核对入口、账号及创建设备；不存在时不泄漏其他账号信息。 */
  private async session(context: NativeContext, id: string, query?: NativeQuery): Promise<NativeStored<PlaySession>> {
    nativeText(id, "PlaySessionId");
    const row = await this.store.get<PlaySession>(this.sessionKey(context, id), query);
    if (!row || row.value.PlaySessionId !== id || row.value.ServiceId !== context.service.ServiceId || row.value.AccountId !== context.account.AccountId || row.value.AuthSessionId !== context.authSession.AuthSessionId) throw new ApiError(404, "playback_session_not_found", "播放会话不存在或不属于当前设备");
    return row;
  }

  /** 有效活动延期三十分钟，来源地址另有自己的短缓存期限。 */
  private expiry(): string { return new Date(Date.now() + 30 * 60000).toISOString(); }
  /** 幂等保留一整天，覆盖会话到期后的网络重试窗口。 */
  private operationExpiry(): string { return new Date(Date.now() + 86400000).toISOString(); }

  /** 到期主键包含时间和目标身份，索引长度小于既有100字符上限。 */
  private expiryKey(context: NativeContext, targetKey: string, expiresAt: string): string { return `${this.state.key(context, "gc")}:${String(Date.parse(expiresAt)).padStart(13, "0")}:${nativeHash(targetKey)}`; }

  /** 临时小状态和到期引用同事务写入，删除账号时可一并清理。 */
  private async scheduleExpiry(context: NativeContext, targetKey: string, kind: ExpiringState["Kind"], expiresAt: string, query: NativeQuery): Promise<string> {
    const key = this.expiryKey(context, targetKey, expiresAt);
    const old = await this.store.get<ExpiringState>(key, query);
    await this.store.put(key, { TargetKey: targetKey, Kind: kind, ExpiresAt: expiresAt }, old?.revision ?? null, query);
    return key;
  }

  /** 会话保留期比活动期限多一天，已提交切章在重试窗口内仍可确认原结果。 */
  private async saveSession(context: NativeContext, session: PlaySession, previous: NativeStored<PlaySession> | null, query: NativeQuery): Promise<PlaySession> {
    if (previous?.value.CleanupKey) { const old = await this.store.get(previous.value.CleanupKey, query); if (old) await this.store.remove(previous.value.CleanupKey, old.revision, query); }
    const retainUntil = new Date(Date.parse(session.ExpiresAt) + 86400000).toISOString();
    const key = this.sessionKey(context, session.PlaySessionId);
    const value = { ...session, CleanupKey: await this.scheduleExpiry(context, key, "Session", retainUntil, query) };
    await this.store.put(key, value, previous?.revision ?? null, query);
    return value;
  }

  /** 每次有活动时最多回收一百条到期状态，历史与长期进度不在清理范围内。 */
  private sweep(context: NativeContext): void {
    const prefix = `${this.state.key(context, "gc")}:`;
    if (this.sweeping.has(prefix)) return;
    this.sweeping.add(prefix);
    void this.state.transaction(async (query) => {
      const rows = await this.store.scan<ExpiringState>(prefix, { before: `${prefix}${String(Date.now() + 1).padStart(13, "0")}:`, limit: 100 }, query);
      for (const row of rows) {
        const target = await this.store.get<PlaySession | IdempotentOperation>(row.value.TargetKey, query);
        if (target) {
          const expiresAt = row.value.Kind === "Session" ? Date.parse(target.value.ExpiresAt) + 86400000 : row.value.Kind === "Operation" ? Date.parse(target.value.ExpiresAt) : Date.parse(row.value.ExpiresAt);
          if (expiresAt <= Date.now()) await this.store.remove(row.value.TargetKey, target.revision, query);
        }
        await this.store.remove(row.key, row.revision, query);
      }
    }).catch(() => { /* 回收失败由下次请求继续，不影响已提交的播放和用户状态。 */ }).finally(() => this.sweeping.delete(prefix));
  }

  /** 章级播放对象始终使用云助手短地址，不嵌套整书或源站签名 URL。 */
  private present(context: NativeContext, session: PlaySession): Record<string, unknown> {
    const value = { PlaySessionId: session.PlaySessionId, BookId: session.BookId, ChapterId: session.ChapterId, StreamUrl: `${context.basePath}/api/v1/Playback/Sessions/${encodeURIComponent(session.PlaySessionId)}/Stream`, PlayMethod: session.PlayMethod, MimeType: session.MimeType, DurationSeconds: session.DurationSeconds, RequestedPositionSeconds: session.RequestedPositionSeconds, StartPositionSeconds: session.RequestedPositionSeconds, PositionConfirmed: false, AudioStartOffsetSeconds: session.AudioStartOffsetSeconds, AudioEndOffsetSeconds: session.AudioEndOffsetSeconds, SeekCapability: "Unknown", NextChapterId: session.NextChapterId, ProgressRevision: session.ProgressRevision, ExpiresAt: session.ExpiresAt };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 10 * 1024) throw new ApiError(502, "source_item_too_large", "单章播放响应超过协议大小限制");
    return value;
  }

  /** 网络重试恢复既有结果，绝不重新取得该书写入权。 */
  private async operation(context: NativeContext, key: string, fingerprint: string, query?: NativeQuery): Promise<IdempotentOperation | null> {
    const row = await this.store.get<IdempotentOperation>(key, query);
    if (!row || Date.parse(row.value.ExpiresAt) <= Date.now()) return null;
    if (row.value.Fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "同一幂等键不能用于不同请求正文");
    return row.value;
  }

  /** 过期幂等键可重新使用，但仍通过其实际行版本更新。 */
  private async saveOperation(context: NativeContext, key: string, value: IdempotentOperation, query: NativeQuery): Promise<void> {
    const old = await this.store.get<IdempotentOperation>(key, query);
    if (old) { const previousExpiry = await this.store.get(this.expiryKey(context, key, old.value.ExpiresAt), query); if (previousExpiry) await this.store.remove(this.expiryKey(context, key, old.value.ExpiresAt), previousExpiry.revision, query); }
    await this.store.put(key, value, old?.revision ?? null, query);
    await this.scheduleExpiry(context, key, "Operation", value.ExpiresAt, query);
  }

  /** 构造一个尚未接管的当前章会话，真正写入在短事务内完成。 */
  private newSession(context: NativeContext, book: MediaItemRecord, chapter: MediaItemRecord, resolved: NativePlayable, mode: PlayMode, position: number, nextChapterId: string | null): PlaySession {
    if (resolved.durationSeconds !== null && position > resolved.durationSeconds + 1) throw new ApiError(400, "invalid_position", "起播位置超过当前章已知时长");
    const now = new Date().toISOString();
    return { PlaySessionId: randomUUID(), ServiceId: context.service.ServiceId, AccountId: context.account.AccountId, AuthSessionId: context.authSession.AuthSessionId, LibraryId: book.libraryId, BookId: book.id, ChapterId: chapter.id, RequestedMode: mode, PlayMethod: this.audio.method(context, resolved, mode), MimeType: resolved.mimeType, DurationSeconds: resolved.durationSeconds, AudioStartOffsetSeconds: resolved.audioStartOffsetSeconds, AudioEndOffsetSeconds: resolved.audioEndOffsetSeconds, RequestedPositionSeconds: position, PositionSeconds: position, ResourceIdentity: resolved.resourceIdentity, CreatedAt: now, UpdatedAt: now, ExpiresAt: this.expiry(), LastSequence: 0, TotalListenedSeconds: 0, LastEventType: null, EndedAt: null, NextChapterId: nextChapterId, ProgressRevision: "0", AdvancedToSessionId: null, ObservedDurationSeconds: null };
  }

  /** 建会话与进度接管一并提交，源网络调用已在事务外完成。 */
  private async createInTransaction(context: NativeContext, session: PlaySession, book: MediaItemRecord, previous: NativeStored<NativeProgress> | null, query: NativeQuery): Promise<PlaySession> {
    const current = previous?.value ?? this.state.emptyProgress(book);
    const progress = await this.state.saveProgress(context, { ...current, ChapterId: session.ChapterId, PositionSeconds: session.RequestedPositionSeconds, ChapterCompleted: false, BookCompleted: false, HiddenFromContinueListening: false, WriterPlaySessionId: session.PlaySessionId }, previous, query, false);
    session = { ...session, ProgressRevision: progress.Revision };
    session = await this.saveSession(context, session, null, query);
    await this.state.saveHistory(context, this.history(session), query);
    return session;
  }

  /** 将会话账本投影为历史，不存音频输入或书籍展开快照。 */
  private history(session: PlaySession): NativeHistory { return { PlaySessionId: session.PlaySessionId, BookId: session.BookId, LibraryId: session.LibraryId, ChapterId: session.ChapterId, StartedAt: session.CreatedAt, UpdatedAt: session.UpdatedAt, EndedAt: session.EndedAt, ListenedSeconds: session.TotalListenedSeconds }; }

  /** 用户主动开播、续听及选章必须携带所见进度修订号。 */
  public async create(context: NativeContext, body: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    context = await this.access.refreshContext(context);
    this.sweep(context);
    const input = nativeObject(body);
    if (input.PreviousPlaySessionId !== undefined) throw new ApiError(400, "invalid_request", "自动切章请使用Advance接口");
    const bookId = nativeText(input.BookId, "BookId");
    const chapterId = nativeText(input.ChapterId, "ChapterId");
    const position = nativeSeconds(input.PositionSeconds ?? 0, "PositionSeconds");
    const mode = playMode(input.PlayMode);
    const expected = nativeRevision(input.ExpectedProgressRevision, "ExpectedProgressRevision");
    const fingerprint = nativeHash(JSON.stringify([bookId, chapterId, position, mode, expected]));
    const key = idempotencyKey === undefined ? null : this.operationKey(context, "Create", "", nativeText(idempotencyKey, "Idempotency-Key", 200));
    const book = await this.catalog.assertBook(context, bookId);
    const chapter = await this.catalog.assertChapter(context, bookId, chapterId);
    if (key) { const old = await this.operation(context, key, fingerprint); if (old) return this.present(context, (await this.session(context, old.PlaySessionId)).value); }
    const prior = await this.state.progressRow(context, bookId);
    if ((prior?.value.Revision ?? "0") !== expected) throw this.state.progressConflict(prior?.value ?? this.state.emptyProgress(book));
    const [resolved, next] = await Promise.all([this.audio.resolve(context, chapter, mode, false, signal), this.catalog.nextChapter(context, bookId, chapterId)]);
    signal?.throwIfAborted();
    const proposal = this.newSession(context, book, chapter, resolved, mode, position, next?.id ?? null);
    const session = await this.state.transaction(async (query) => {
      const fresh = await this.access.assertTransactionContext(context, book.libraryId, query, resolved.sourceVersion);
      await this.assertResourceRelation(fresh, bookId, chapterId, query, resolved.localCatalogRevision);
      if (key) { const old = await this.operation(fresh, key, fingerprint, query); if (old) return (await this.session(fresh, old.PlaySessionId, query)).value; }
      const previous = await this.state.progressRow(fresh, bookId, query);
      if ((previous?.value.Revision ?? "0") !== expected) throw this.state.progressConflict(previous?.value ?? this.state.emptyProgress(book));
      // 关键变量：网络等待期间配置可能调整，最终模式按当前入口再校验。
      const result = await this.createInTransaction(fresh, { ...proposal, PlayMethod: this.audio.method(fresh, resolved, mode) }, book, previous, query);
      if (key) await this.saveOperation(fresh, key, { Kind: "Create", Fingerprint: fingerprint, PlaySessionId: result.PlaySessionId, ExpiresAt: this.operationExpiry() }, query);
      return result;
    });
    this.cancelPrefetch(context, bookId);
    return this.present(context, session);
  }

  /** 事务中重新校验已有实体和父子关系，不能在取址等待后写入已移除章节。 */
  private async assertResourceRelation(context: NativeContext, bookId: string, chapterId: string, query: NativeQuery, expectedLocalRevision?: string | null): Promise<void> {
    const book = await query("media_items as b").join("media_libraries as l", "l.id", "b.library_id").where({ "b.id": bookId, "b.user_id": context.service.OwnerUserId, "b.item_type": "audiobook.book" }).whereNull("b.deleted_at").first("b.library_id", "l.library_kind");
    if (!book) throw new ApiError(404, "book_unavailable", "当前作品已不存在");
    if (book.library_kind !== "content_source_audiobook") {
      await this.access.assertTransactionContext(context, String(book.library_id), query);
      const relation = await nativeLocalChapters(this.runtime).assertRelation(context, bookId, chapterId, query);
      if (expectedLocalRevision && relation.catalogRevision !== expectedLocalRevision) throw new ApiError(409, "catalog_changed", "本地音频目录已变化，请重新创建会话");
      return;
    }
    const relation = await query("media_relations as r").join("media_items as b", "b.id", "r.parent_item_id").join("media_items as c", "c.id", "r.child_item_id").where({ "r.user_id": context.service.OwnerUserId, "r.parent_item_id": bookId, "r.child_item_id": chapterId, "r.relation_type": "book_chapter", "b.item_type": "audiobook.book", "c.item_type": "audiobook.chapter" }).whereNull("b.deleted_at").whereNull("c.deleted_at").where("b.library_id", query.ref("c.library_id")).select("b.library_id").first();
    if (!relation) throw new ApiError(404, "chapter_unavailable", "当前章节已不存在或不属于该作品");
    await this.access.assertTransactionContext(context, String(relation.library_id), query);
  }

  /** 事件 ID 是幂等身份，终止后迟到消息不能重新开启或重复结算。 */
  private async accepted(context: NativeContext, sessionId: string, event: PlaybackEvent, query?: NativeQuery): Promise<AcceptedEvent | null> {
    const old = await this.store.get<AcceptedEvent>(this.eventKey(context, sessionId, event.EventId), query);
    if (!old) return null;
    if (old.value.Event.EventId !== event.EventId || old.value.Fingerprint !== nativeHash(JSON.stringify(event))) throw new ApiError(409, "event_conflict", "同一事件ID不能用于不同事件正文");
    return old.value;
  }

  /** 验证累计实际听时，不用位置变化推算；允许确认丢失后由新累计值补记差额。 */
  private validateListening(session: PlaySession, event: PlaybackEvent): void {
    if (event.TotalListenedSeconds < session.TotalListenedSeconds) throw new ApiError(400, "listening_time_regressed", "累计实际收听时长不能倒退");
    const delta = event.TotalListenedSeconds - session.TotalListenedSeconds;
    const totalElapsed = Math.max(0, (Date.now() - Date.parse(session.CreatedAt)) / 1000);
    // 关键变量：网络可批量延迟交付，不能用两次HTTP到达间隔限制合法累计听时的补记差额。
    if (event.TotalListenedSeconds > totalElapsed + 10) throw new ApiError(400, "listening_time_invalid", "累计收听时长超过会话实际经过时间");
    if (session.LastEventType === "Paused" && event.Type === "Paused" && delta > 0) throw new ApiError(400, "listening_time_invalid", "暂停期间不能继续累计收听时长");
    if (session.DurationSeconds !== null && event.PositionSeconds > session.DurationSeconds + 2) throw new ApiError(400, "invalid_position", "上报位置超过当前章已知时长");
    if (event.Type === "Ended" && session.DurationSeconds !== null && event.PositionSeconds < Math.max(0, session.DurationSeconds - 2)) throw new ApiError(400, "invalid_end_event", "当前章尚未到达已知的自然结束边界");
  }

  /** 同一事务执行事件记账；旧会话可以记历史，但不回写最新续听点。 */
  private async applyEvent(context: NativeContext, row: NativeStored<PlaySession>, event: PlaybackEvent, query: NativeQuery): Promise<{ session: PlaySession; result: EventResult }> {
    const session = row.value;
    const old = await this.accepted(context, session.PlaySessionId, event, query);
    if (old) return { session, result: old.Result };
    const previous = await this.state.progressRow(context, session.BookId, query);
    const writer = previous?.value.WriterPlaySessionId === session.PlaySessionId;
    if (session.EndedAt || event.Sequence <= session.LastSequence) return { session, result: { EventId: event.EventId, Accepted: false, ProgressApplied: false, LastSequence: session.LastSequence, ProgressRevision: previous?.value.Revision ?? session.ProgressRevision, ExpiresAt: session.ExpiresAt, Reason: session.EndedAt ? "playback_ended" : "event_out_of_order" } };
    if (Date.parse(session.ExpiresAt) <= Date.now()) throw new ApiError(410, "playback_session_expired", "播放会话已到期，请重新创建");
    this.validateListening(session, event);
    const now = new Date().toISOString();
    let updated: PlaySession = { ...session, PositionSeconds: event.PositionSeconds, TotalListenedSeconds: event.TotalListenedSeconds, LastSequence: event.Sequence, LastEventType: event.Type, UpdatedAt: now, ExpiresAt: this.expiry(), EndedAt: ["Ended", "Stopped"].includes(event.Type) ? now : null,
      // 关键变量：播放器实测仅作当前资源的补充证据，不覆盖来源权威时长和目录。
      ObservedDurationSeconds: event.ObservedDurationSeconds ?? session.ObservedDurationSeconds };
    if (writer && previous) {
      const progress = await this.state.saveProgress(context, { ...previous.value, ChapterId: session.ChapterId, PositionSeconds: event.PositionSeconds, ChapterCompleted: event.Type === "Ended", WriterPlaySessionId: session.PlaySessionId }, previous, query, true, event.Type === "Ended");
      updated.ProgressRevision = progress.Revision;
    }
    updated = await this.saveSession(context, updated, row, query);
    await this.state.saveHistory(context, this.history(updated), query);
    const result: EventResult = { EventId: event.EventId, Accepted: true, ProgressApplied: writer, LastSequence: event.Sequence, ProgressRevision: writer ? updated.ProgressRevision : previous?.value.Revision ?? "0", ExpiresAt: updated.ExpiresAt, ...(!writer ? { Reason: "playback_superseded" } : {}) };
    await this.store.put(this.eventKey(context, session.PlaySessionId, event.EventId), { Fingerprint: nativeHash(JSON.stringify(event)), Event: event, Result: result } satisfies AcceptedEvent, null, query);
    await this.scheduleExpiry(context, this.eventKey(context, session.PlaySessionId, event.EventId), "Event", this.operationExpiry(), query);
    return { session: updated, result };
  }

  /** 普通进度上报只返回事件确认，不附完整用户和整书。 */
  public async events(context: NativeContext, sessionId: string, body: unknown): Promise<EventResult> {
    context = await this.access.refreshContext(context);
    this.sweep(context);
    const event = playbackEvent(body);
    const prior = await this.session(context, sessionId);
    await this.catalog.assertChapter(context, prior.value.BookId, prior.value.ChapterId);
    const result = await this.state.transaction(async (query) => {
      const fresh = await this.access.assertTransactionContext(context, prior.value.LibraryId, query);
      await this.assertResourceRelation(fresh, prior.value.BookId, prior.value.ChapterId, query);
      return this.applyEvent(fresh, await this.session(fresh, sessionId, query), event, query);
    });
    if (result.result.ProgressApplied && !result.session.EndedAt) this.prefetchNext(context, result.session);
    else this.cancelPrefetch(context, prior.value.BookId);
    return result.result;
  }

  /** 只有可信时长显示临近结束时才预取一章，未知时长不触发全书探测。 */
  private prefetchNext(context: NativeContext, session: PlaySession): void {
    if (session.DurationSeconds === null || session.DurationSeconds - session.PositionSeconds > 30 || !session.NextChapterId || session.LastEventType === "Paused") return;
    const key = this.prefetchKey(context, session.BookId);
    if (this.prefetch.get(key)?.ChapterId === session.NextChapterId) return;
    this.cancelPrefetch(context, session.BookId);
    const controller = new AbortController();
    const ref: Prefetch = { ChapterId: session.NextChapterId, cancel: () => controller.abort() };
    this.prefetch.set(key, ref);
    // 异步预解析不产生播放会话、不接管写入权，也不把来源异常返回已完成的进度响应。
    void (async () => {
      const chapter = await this.catalog.assertChapter(context, session.BookId, session.NextChapterId!);
      if (controller.signal.aborted || this.prefetch.get(key) !== ref) return;
      const subscription = await this.audio.subscribe(context, chapter, session.RequestedMode, "prefetch", false, controller.signal);
      ref.cancel = (): void => { controller.abort(); subscription.cancel(); };
      try { await subscription.promise; }
      finally { if (this.prefetch.get(key) === ref) this.prefetch.delete(key); }
    })().catch(() => { /* 预取失败由实际切章正常重取，禁止记录带凭据的源异常。 */ }).finally(() => { if (this.prefetch.get(key) === ref) this.prefetch.delete(key); });
  }

  /** 同一本书同设备只保留一个下一章预取消费者。 */
  private prefetchKey(context: NativeContext, bookId: string): string { return this.state.key(context, "pf", JSON.stringify([context.authSession.AuthSessionId, bookId])); }
  /** 离开当前书章只取消本设备无用预取，不取消别的前台消费者。 */
  private cancelPrefetch(context: NativeContext, bookId: string): void { const key = this.prefetchKey(context, bookId); this.prefetch.get(key)?.cancel(); this.prefetch.delete(key); }

  /** 同一书的直接下一章关系在事务内再次读取，目录重排不能推进错误章节。 */
  private async assertNext(context: NativeContext, session: PlaySession, nextId: string, query: NativeQuery): Promise<void> {
    const library = await query("media_libraries").where({ id: session.LibraryId, user_id: context.service.OwnerUserId }).first("library_kind");
    if (library?.library_kind !== "content_source_audiobook") { await nativeLocalChapters(this.runtime).assertNext(context, session.BookId, session.ChapterId, nextId, query); return; }
    const relation = await query("media_relations").where({ user_id: context.service.OwnerUserId, library_id: session.LibraryId, parent_item_id: session.BookId, child_item_id: session.ChapterId, relation_type: "book_chapter" }).first("sort_order");
    if (!relation) throw new ApiError(409, "catalog_changed", "章节目录已改变，请重新定位");
    const next = await query("media_relations as r").join("media_items as c", "c.id", "r.child_item_id").where({ "r.user_id": context.service.OwnerUserId, "r.library_id": session.LibraryId, "r.parent_item_id": session.BookId, "r.relation_type": "book_chapter", "c.item_type": "audiobook.chapter" }).whereNull("c.deleted_at").where((builder) => builder.where("r.sort_order", ">", Number(relation.sort_order)).orWhere((same) => same.where("r.sort_order", Number(relation.sort_order)).where("r.child_item_id", ">", session.ChapterId))).orderBy("r.sort_order", "asc").orderBy("r.child_item_id", "asc").first("r.child_item_id");
    if (!next || String(next.child_item_id) !== nextId) throw new ApiError(409, "catalog_changed", "目标章节已不再是当前章节的直接下一章");
  }

  /** 原子切章的已提交结果可确认，当前继续许可单独重新鉴权和检查写入权。 */
  private async restoreAdvance(context: NativeContext, operation: IdempotentOperation): Promise<Record<string, unknown>> {
    const session = (await this.session(context, operation.PlaySessionId)).value;
    await this.catalog.assertChapter(context, session.BookId, session.ChapterId);
    const progress = await this.state.progressRow(context, session.BookId);
    return { EndEventResult: operation.EndEventResult, Playback: this.present(context, session), ContinuationAllowed: !session.EndedAt && Date.parse(session.ExpiresAt) > Date.now() && progress?.value.WriterPlaySessionId === session.PlaySessionId };
  }

  /** 一次提交自然结束、实际听时、下一会话、最终进度与幂等结果。 */
  public async advance(context: NativeContext, sessionId: string, body: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    context = await this.access.refreshContext(context);
    this.sweep(context);
    const input = nativeObject(body);
    const nextId = nativeText(input.NextChapterId, "NextChapterId");
    const mode = playMode(input.PlayMode);
    const end = playbackEvent(input.EndEvent, true);
    const key = this.operationKey(context, "Advance", sessionId, nativeText(idempotencyKey, "Idempotency-Key", 200));
    const fingerprint = nativeHash(JSON.stringify([sessionId, nextId, mode, end]));
    const old = await this.operation(context, key, fingerprint);
    if (old) return this.restoreAdvance(context, old);
    const previous = (await this.session(context, sessionId)).value;
    const book = await this.catalog.assertBook(context, previous.BookId);
    const chapter = await this.catalog.assertChapter(context, previous.BookId, nextId);
    const next = await this.catalog.nextChapter(context, previous.BookId, previous.ChapterId);
    if (!next || next.id !== nextId) throw new ApiError(409, "catalog_changed", "下一章关系已改变，请重新定位目录");
    const currentProgress = await this.state.progressRow(context, previous.BookId);
    if (currentProgress?.value.WriterPlaySessionId !== sessionId) throw new ApiError(409, "playback_superseded", "该书已由其他会话接管，不能自动继续");
    const [resolved, following] = await Promise.all([this.audio.resolve(context, chapter, mode, false, signal), this.catalog.nextChapter(context, previous.BookId, nextId)]);
    signal?.throwIfAborted();
    const proposal = this.newSession(context, book, chapter, resolved, mode, 0, following?.id ?? null);
    const committed = await this.state.transaction(async (query) => {
      const fresh = await this.access.assertTransactionContext(context, previous.LibraryId, query, resolved.sourceVersion);
      const restored = await this.operation(fresh, key, fingerprint, query);
      if (restored) return restored;
      const row = await this.session(fresh, sessionId, query);
      await this.assertResourceRelation(fresh, row.value.BookId, row.value.ChapterId, query);
      await this.assertResourceRelation(fresh, row.value.BookId, nextId, query, resolved.localCatalogRevision);
      await this.assertNext(fresh, row.value, nextId, query);
      const progress = await this.state.progressRow(fresh, row.value.BookId, query);
      if (progress?.value.WriterPlaySessionId !== sessionId || row.value.AdvancedToSessionId) throw new ApiError(409, "playback_superseded", "当前会话已失去自动继续的写入权");
      const ending = await this.applyEvent(fresh, row, end, query);
      if (!ending.result.Accepted || !ending.result.ProgressApplied) throw new ApiError(409, "playback_superseded", "结束事件未取得续听写入权，不能自动切章");
      const latest = await this.state.progressRow(fresh, book.id, query);
      const created = await this.createInTransaction(fresh, { ...proposal, PlayMethod: this.audio.method(fresh, resolved, mode) }, book, latest, query);
      const endedRow = await this.session(fresh, sessionId, query);
      await this.saveSession(fresh, { ...endedRow.value, AdvancedToSessionId: created.PlaySessionId }, endedRow, query);
      const result: IdempotentOperation = { Kind: "Advance", Fingerprint: fingerprint, PlaySessionId: created.PlaySessionId, EndEventResult: ending.result, ExpiresAt: this.operationExpiry() };
      await this.saveOperation(fresh, key, result, query);
      return result;
    });
    this.cancelPrefetch(context, book.id);
    const result = await this.restoreAdvance(context, committed);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 10 * 1024) throw new ApiError(502, "source_item_too_large", "自动切章响应超过协议大小限制");
    return result;
  }

  /** 每次媒体请求及连接复核都验证设备、资源和当前权限。 */
  public async stream(context: NativeContext, id: string, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const row = await this.session(context, id);
    const session = row.value;
    const chapter = await this.catalog.assertChapter(context, session.BookId, session.ChapterId);
    /** 长流复核不保存Bearer，基于认证会话摘要重新检查数据库状态。 */
    const validate = async (): Promise<void> => {
      context = await this.access.refreshContext(context);
      await this.access.assertLibrary(context, session.LibraryId);
      const current = (await this.session(context, id)).value;
      if (Date.parse(current.ExpiresAt) <= Date.now()) throw new ApiError(410, "playback_session_expired", "播放会话已到期");
      if (current.EndedAt) throw new ApiError(410, "playback_ended", "播放会话已经结束，请重新创建当前章会话");
      await this.catalog.assertChapter(context, session.BookId, session.ChapterId);
    };
    return this.audio.send(context, chapter, session.PlayMethod, request, reply, false, validate, session.RequestedMode, { key: this.sessionKey(context, id), identity: session.ResourceIdentity });
  }

  /** 单章下载只允许当前有权账号与独立音频资源，不将M4B整书伪装成逻辑章。 */
  public async download(context: NativeContext, bookId: string, chapterId: string, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    context = await this.access.refreshContext(context);
    if (!context.account.CanDownload) throw new ApiError(403, "download_forbidden", "当前账号没有下载权限");
    const chapter = await this.catalog.assertChapter(context, bookId, chapterId);
    /** 下载连接继续复核当前权限，撤销下载授权不会影响其他协议。 */
    const validate = async (): Promise<void> => { context = await this.access.refreshContext(context); if (!context.account.CanDownload) throw new ApiError(403, "download_forbidden", "当前账号没有下载权限"); await this.catalog.assertChapter(context, bookId, chapterId); };
    return this.audio.send(context, chapter, "Relay", request, reply, true, validate);
  }

  /** 关闭原生协议只撤销自己的预取消费者和音频连接。 */
  public close(): void { for (const value of this.prefetch.values()) value.cancel(); this.prefetch.clear(); this.audio.close(); }
}
