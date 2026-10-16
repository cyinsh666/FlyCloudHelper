import { randomUUID } from "node:crypto";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { absEntityId, absNames, loadAbsBook, mapAbsBook, mapAbsTrack } from "./catalog.js";
import { readAbsObject, readAbsSeconds, type AbsBook, type AbsContext, type AbsTrack } from "./types.js";
import type { AbsProgressService, AbsProgressWriteResult } from "./progress.js";
import type { AbsSocketHub } from "./socket.js";
import { absBookLibraryId, withAbsLibraryViews } from "./library-views.js";
import {
  createAbsSessionSnapshot,
  readAbsSessionSnapshot,
  resolveAbsSessionTrack,
} from "./session-snapshot.js";

/** 会话和离线听书记录持久化；公开音轨能力地址随会话关闭失效。 */
export class AbsSessionService {
  public constructor(
    private readonly runtime: ApiRuntime,
    private readonly progress: AbsProgressService,
    private readonly hub: AbsSocketHub,
  ) {}

  /** 原始音频直放协商，不将网盘中转错误宣称成音频转码。 */
  public async start(
    context: AbsContext,
    book: AbsBook,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!book.tracks.length) throw new ApiError(404, "abs_audio_missing", "有声书没有可播放音轨");
    if (absBoolean(body.forceTranscode))
      throw new ApiError(415, "abs_transcode_unavailable", "当前 ABS 服务不提供实时转码，请使用原始音频播放");
    const supported = Array.isArray(body.supportedMimeTypes) ? body.supportedMimeTypes.map(String) : [];
    if (
      !absBoolean(body.forceDirectPlay) &&
      !book.tracks.every((track) => supported.includes(track.mimeType))
    )
      throw new ApiError(
        415,
        "abs_format_unsupported",
        "播放器未声明支持全部原始音频格式，当前服务不提供转码",
      );
    if (book.tracks.some((track) => track.duration <= 0))
      throw new ApiError(409, "abs_timeline_incomplete", "部分音轨时长尚未读取完成，请先完成有声书扫描");
    const now = Date.now();
    const device = readAbsObject(body.deviceInfo);
    const id = randomUUID();
    const deviceId =
      typeof device.deviceId === "string" && device.deviceId ? device.deviceId.slice(0, 255) : id;
    await this.progress.serializeWrite(context, () =>
      this.runtime.database.query.transaction(async (transaction) => {
        await this.progress.lockAccount(context, transaction);
        const current = await transaction("library_abs_progress")
          .where({ library_id: context.libraryId, account_id: context.accountId, item_id: book.item.id })
          .first();
        const position = Number(current?.is_finished) === 1 ? 0 : readAbsSeconds(current?.current_time);
        // 同账号先锁再替换；旧 close 的会话状态判断和进度保存也持有这把锁，避免跨会话抢写。
        await transaction("library_abs_playback_sessions")
          .where({
            library_id: context.libraryId,
            account_id: context.accountId,
            device_id: deviceId,
            status: "active",
          })
          .update({ status: "superseded", closed_at: now, updated_at: now });
        await transaction("library_abs_playback_sessions").insert({
          id,
          library_id: context.libraryId,
          account_id: context.accountId,
          item_id: book.item.id,
          client_session_id: null,
          device_id: deviceId,
          device_json: JSON.stringify(device),
          media_player: String(body.mediaPlayer ?? "unknown").slice(0, 255),
          status: "active",
          current_time: position,
          start_time: position,
          duration: book.duration,
          time_listening: 0,
          created_at: now,
          updated_at: now,
          closed_at: null,
          snapshot_json: createAbsSessionSnapshot(book),
        });
      }),
    );
    return this.get(context, id);
  }

  /** 会话读取必须验证库、账号、有效状态与最近活动。 */
  public async row(
    context: AbsContext,
    sessionId: string,
    allowClosed = false,
  ): Promise<Record<string, unknown>> {
    const row = await this.runtime.database
      .query("library_abs_playback_sessions")
      .where({ id: sessionId, library_id: context.libraryId, account_id: context.accountId })
      .first();
    if (
      !row ||
      (!allowClosed && (row.status !== "active" || Number(row.updated_at) < Date.now() - 36 * 3600000))
    )
      throw new ApiError(404, "abs_session_not_found", "播放会话不存在或已结束");
    return row;
  }

  /** 标准会话固定建立时的音轨与全书时间轴，之后的目录重排不会改变当前会话。 */
  public async get(context: AbsContext, sessionId: string): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const row = await this.row(context, sessionId);
    const book = this.requireSnapshot(row);
    // 关键变量：只读当前书籍摘要的分类，不补详情，也不替换已固定的章节和音轨时间轴。
    const currentItem = await this.runtime.database.query("media_items")
      .select("metadata_json")
      .where({ id: String(row.item_id), library_id: context.libraryId, user_id: context.ownerUserId, item_type: "audiobook.book" })
      .whereNull("deleted_at")
      .first();
    return mapSession(context, currentItem ? { ...row, legacy_metadata_json: currentItem.metadata_json } : row, book);
  }

  /** 公开音轨也使用固定快照；源文件移除返回410，不尝试当前目录的同序号文件。 */
  public async track(context: AbsContext, sessionId: string, index: number): Promise<AbsTrack> {
    const row = await this.row(context, sessionId);
    return resolveAbsSessionTrack(this.runtime, context, this.requireSnapshot(row), index);
  }

  /** 没有快照的旧会话不可续流，历史统计仍保留，客户端需要重新发起播放。 */
  private requireSnapshot(row: Record<string, unknown>): AbsBook {
    const book = readAbsSessionSnapshot(row);
    if (!book)
      throw new ApiError(410, "abs_session_snapshot_missing", "旧播放会话缺少固定时间轴，请重新打开作品播放");
    return book;
  }

  /** 标准 sync 使用增量 timeListened 和全书 currentTime；close 重试不会重复累计。 */
  public async sync(
    context: AbsContext,
    sessionId: string,
    body: Record<string, unknown>,
    close = false,
  ): Promise<void> {
    const timeListened = Number(body.timeListened ?? 0);
    if (!Number.isFinite(timeListened) || timeListened < 0 || timeListened > 7 * 86400)
      throw new ApiError(400, "abs_listening_time_invalid", "收听时长超出范围");
    if (
      body.currentTime !== undefined &&
      (!Number.isFinite(Number(body.currentTime)) || Number(body.currentTime) < 0)
    )
      throw new ApiError(400, "abs_position_invalid", "全书位置必须是非负秒数");
    const result = await this.progress.serializeWrite(context, () =>
      this.runtime.database.query.transaction(
        async (transaction): Promise<{ changed: boolean; progress?: AbsProgressWriteResult }> => {
          await this.progress.lockAccount(context, transaction);
          let query = transaction("library_abs_playback_sessions").where({
            id: sessionId,
            library_id: context.libraryId,
            account_id: context.accountId,
          });
          if (this.runtime.database.databaseType !== "sqlite") query = query.forUpdate();
          const row = await query.first();
          if (!row) throw new ApiError(404, "abs_session_not_found", "播放会话不存在或已结束");
          if (close && row.status === "closed") return { changed: false };
          if (row.status !== "active" && !(close && row.status === "superseded"))
            throw new ApiError(404, "abs_session_not_found", "播放会话不存在或已结束");
          if (!close && Number(row.updated_at) < Date.now() - 36 * 3600000)
            throw new ApiError(404, "abs_session_not_found", "播放会话不存在或已结束");
          const book = readAbsSessionSnapshot(row);
          if (!book && !close) this.requireSnapshot(row);
          const now = Date.now();
          const duration = book?.duration || Number(row.duration);
          const position =
            body.currentTime === undefined
              ? Number(row.current_time)
              : Math.min(duration || Infinity, Number(body.currentTime));
          await transaction("library_abs_playback_sessions")
            .where({ id: sessionId, library_id: context.libraryId, account_id: context.accountId })
            .update({
              current_time: position,
              duration,
              time_listening: Number(row.time_listening) + timeListened,
              status: close ? "closed" : "active",
              closed_at: close ? now : null,
              updated_at: now,
            });
          // 被替换的旧会话仍计入最后一段收听时长，但永远不能覆盖新会话的位置。
          const progress =
            row.status === "active" && book && body.currentTime !== undefined
              ? await this.progress.updateInTransaction(
                  context,
                  book,
                  { ...body, lastUpdate: now },
                  transaction,
                )
              : undefined;
          return { changed: true, ...(progress ? { progress } : {}) };
        },
      ),
    );
    if (result.progress) await this.progress.publish(context, result.progress, sessionId);
    if (result.changed && close) await this.hub.emit(context, "user_session_closed", sessionId);
  }

  /** 账号历史分页，空历史真实返回空数组和零总数。 */
  public async history(
    context: AbsContext,
    query: Record<string, unknown>,
    itemId?: string,
  ): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const page = Math.max(0, Number(query.page) || 0);
    const limit = Math.max(1, Math.min(1000, Number(query.itemsPerPage ?? query.limit) || 10));
    let base = this.runtime.database
      .query("library_abs_playback_sessions as p")
      .join("media_items as m", "m.id", "p.item_id")
      .where({
        "p.library_id": context.libraryId,
        "p.account_id": context.accountId,
        "m.library_id": context.libraryId,
      })
      .whereNull("m.deleted_at")
      .where("p.time_listening", ">", 0);
    if (itemId) base = base.where("p.item_id", itemId);
    const count = await base.clone().count<{ total: string | number }[]>({ total: "p.id" }).first();
    const rows = await base
      .select(
        "p.*",
        "m.title as legacy_title",
        "m.metadata_json as legacy_metadata_json",
        "m.poster_url as legacy_poster_url",
      )
      .orderBy("p.updated_at", "desc")
      .limit(limit)
      .offset(page * limit);
    const sessions: Record<string, unknown>[] = [];
    for (const row of rows) sessions.push(mapSession(context, row, readAbsSessionSnapshot(row)));
    return {
      total: Number(count?.total ?? 0),
      numPages: Math.ceil(Number(count?.total ?? 0) / limit),
      page,
      itemsPerPage: limit,
      sessions,
    };
  }

  /** 离线会话按客户端原始会话 ID 幂等更新累计时长，不重复插入历史。 */
  public async syncLocal(
    context: AbsContext,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const clientId = typeof body.id === "string" ? body.id : "";
    if (!clientId || clientId.length > 255 || typeof body.libraryItemId !== "string")
      throw new ApiError(400, "abs_local_session_invalid", "离线会话缺少稳定 ID 或作品 ID");
    const book = await loadAbsBook(this.runtime, context, body.libraryItemId);
    const now = Date.now();
    const updatedAt = body.updatedAt === undefined ? now : Number(body.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now + 5 * 60000)
      throw new ApiError(400, "abs_progress_timestamp_invalid", "离线会话事件时间无效或客户端时钟超前过多");
    const device = readAbsObject(body.deviceInfo);
    const payload = {
      currentTime: readAbsSeconds(body.currentTime),
      duration: readAbsSeconds(body.duration) || book.duration,
      lastUpdate: updatedAt,
    };
    return this.progress.serializeWrite(context, async () => {
      const result = await this.runtime.database.query.transaction(async (transaction) => {
        await this.progress.lockAccount(context, transaction);
        let query = transaction("library_abs_playback_sessions").where({
          library_id: context.libraryId,
          account_id: context.accountId,
          client_session_id: clientId,
        });
        if (this.runtime.database.databaseType !== "sqlite") query = query.forUpdate();
        const existing = await query.first();
        if (existing && String(existing.item_id) !== book.item.id)
          throw new ApiError(409, "abs_local_session_conflict", "离线会话 ID 已属于另一作品");
        // 关键变量：离线请求的累计时长按客户端会话版本覆盖，重试不再次相加。
        const patch = {
          current_time: payload.currentTime,
          duration: payload.duration,
          time_listening: readAbsSeconds(body.timeListening),
          status: "closed",
          updated_at: updatedAt,
          closed_at: updatedAt,
        };
        if (!existing) {
          await transaction("library_abs_playback_sessions").insert({
            id: randomUUID(),
            library_id: context.libraryId,
            account_id: context.accountId,
            item_id: book.item.id,
            client_session_id: clientId,
            device_id: String(device.deviceId ?? "offline").slice(0, 255),
            device_json: JSON.stringify(device),
            media_player: String(body.mediaPlayer ?? "local").slice(0, 255),
            start_time: readAbsSeconds(body.startTime),
            created_at: Number(body.startedAt) || updatedAt,
            snapshot_json: createAbsSessionSnapshot(book),
            ...patch,
          });
        } else if (Number(existing.updated_at) < updatedAt) {
          await transaction("library_abs_playback_sessions").where({ id: existing.id }).update(patch);
        } else if (Number(existing.updated_at) > updatedAt) {
          return { progress: null };
        } else if (
          Number(existing.current_time) !== patch.current_time ||
          Number(existing.duration) !== patch.duration ||
          Number(existing.time_listening) !== patch.time_listening
        ) {
          // 同一个客户端会话的同版本携带不同内容，不允许覆盖先写入的版本。
          return { progress: null };
        }
        // 即使历史行已存在也核对作品进度，避免上次提交后响应丢失让幂等重试误报未同步。
        const progress = await this.progress.updateInTransaction(
          context,
          { ...book, duration: payload.duration },
          payload,
          transaction,
        );
        return { progress };
      });
      if (result.progress) await this.progress.publish(context, result.progress);
      return { id: clientId, success: true, progressSynced: result.progress?.accepted === true };
    });
  }

  /** 收听统计仅汇总真实会话，按 UTC 日和星期生成官方字段。 */
  public async stats(context: AbsContext): Promise<Record<string, unknown>> {
    context = await withAbsLibraryViews(this.runtime, context);
    const rows = await this.runtime.database
      .query("library_abs_playback_sessions as p")
      .join("media_items as m", "m.id", "p.item_id")
      .select(
        "p.*",
        "m.title as legacy_title",
        "m.metadata_json as legacy_metadata_json",
        "m.poster_url as legacy_poster_url",
      )
      .where({
        "p.library_id": context.libraryId,
        "p.account_id": context.accountId,
        "m.library_id": context.libraryId,
      })
      .whereNull("m.deleted_at")
      .where("p.time_listening", ">", 0);
    const days: Record<string, number> = {};
    const weekdays: Record<string, number> = {};
    const items: Record<string, unknown> = {};
    let totalTime = 0;
    for (const row of rows) {
      const book = readAbsSessionSnapshot(row);
      const seconds = Number(row.time_listening);
      const date = new Date(Number(row.created_at));
      const day = date.toISOString().slice(0, 10);
      const weekday = String(date.getUTCDay());
      days[day] = (days[day] ?? 0) + seconds;
      weekdays[weekday] = (weekdays[weekday] ?? 0) + seconds;
      totalTime += seconds;
      const itemId = String(row.item_id);
      const old = readAbsObject(items[itemId]);
      const mapped = mapSession(context, row, book);
      items[itemId] = {
        id: itemId,
        timeListening: Number(old.timeListening ?? 0) + seconds,
        mediaMetadata: mapped.mediaMetadata,
        mediaType: "book",
        duration: mapped.duration,
        coverPath: mapped.coverPath,
      };
    }
    const recentSessions = readAbsObject(await this.history(context, { itemsPerPage: 10 })).sessions;
    return {
      totalTime,
      days,
      dayOfWeek: weekdays,
      today: days[new Date().toISOString().slice(0, 10)] ?? 0,
      items,
      recentSessions,
    };
  }
}

/** 官方 iOS 使用字符串1发起直放，兼容同一协议的布尔/数字表达。 */
function absBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
/** 官方会话响应的所有时间位置使用整书秒数，日期使用毫秒时间戳。 */
function mapSession(
  context: AbsContext,
  row: Record<string, unknown>,
  book: AbsBook | null,
): Record<string, unknown> {
  const device = readAbsObject(row.device_json);
  const createdAt = Number(row.created_at);
  // 关键变量：旧行只能保留当前作品描述以展示历史，不能用当前目录补造会话音轨与章节。
  const legacyMetadata = readAbsObject(row.legacy_metadata_json);
  const legacyTitle = String(row.legacy_title ?? "历史有声书");
  // 关键变量：搜索书首次取得真实分类后，仅更新展示归属；音轨、时长和章节仍使用原会话快照。
  const displayBook = book && row.legacy_metadata_json !== undefined && row.legacy_metadata_json !== null
    ? { ...book, item: { ...book.item, metadata: { ...book.item.metadata, contentSource: legacyMetadata.contentSource } } }
    : book;
  // 会话仍按真实库入库；对外作品归属与目录、详情使用同一个固定分类库。
  const libraryId = absBookLibraryId(context, displayBook?.item ?? { metadata: legacyMetadata });
  return {
    id: String(row.id),
    userId: context.accountId,
    libraryId,
    libraryItemId: String(row.item_id),
    bookId: book?.bookId ?? absEntityId(context.libraryId, "book", String(row.item_id)),
    episodeId: null,
    mediaType: "book",
    mediaMetadata: displayBook
      ? readAbsObject(mapAbsBook(context, displayBook, false).media).metadata
      : { ...legacyMetadata, title: legacyTitle },
    chapters: book?.chapters ?? [],
    displayTitle: book?.item.title ?? legacyTitle,
    displayAuthor:
      book?.authors.map((author) => author.name).join(", ") ?? absNames(legacyMetadata.authors).join(", "),
    coverPath:
      (book?.item.posterUrl ?? row.legacy_poster_url)
        ? `${context.basePath}/api/items/${String(row.item_id)}/cover`
        : null,
    duration: book?.duration || Number(row.duration),
    playMethod: 0,
    mediaPlayer: String(row.media_player),
    deviceInfo: { ...device, id: row.device_id, deviceId: row.device_id },
    serverVersion: "2.37.1",
    date: new Date(createdAt).toISOString().slice(0, 10),
    dayOfWeek: String(new Date(createdAt).getUTCDay()),
    timeListening: Number(row.time_listening),
    startTime: Number(row.start_time),
    currentTime: Number(row.current_time),
    startedAt: createdAt,
    updatedAt: Number(row.updated_at),
    audioTracks: book?.tracks.map(mapAbsTrack) ?? [],
    libraryItem: displayBook ? mapAbsBook(context, displayBook) : null,
  };
}
