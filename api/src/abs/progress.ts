import { randomUUID } from "node:crypto";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { absEntityId, loadAbsBook } from "./catalog.js";
import { readAbsSeconds, type AbsBook, type AbsContext, type AbsQuery } from "./types.js";
import type { AbsSocketHub } from "./socket.js";
import type { AbsAccessService } from "./access.js";
import { buildAbsUser } from "./presentation.js";

/** 进度保存结果区分事件已采纳、幂等重试和跨设备旧事件。 */
export interface AbsProgressWriteResult {
  progress: Record<string, unknown>;
  changed: boolean;
  accepted: boolean;
  reason: "updated" | "unchanged" | "stale" | "conflict";
}

/** ABS 原生全书进度，秒数和百分比不复用其他协议的完成阈值。 */
export class AbsProgressService {
  /** 同账号的会话与主动进度共用写入队列，事务行锁同时覆盖其他服务进程。 */
  private readonly writes = new Map<string, Promise<unknown>>();
  public constructor(
    private readonly runtime: ApiRuntime,
    private readonly hub: AbsSocketHub,
    private readonly access: AbsAccessService,
  ) {}

  /** 当前账号持久进度，删库或清空目录后不会引用失效作品。 */
  public async list(context: AbsContext): Promise<Record<string, unknown>[]> {
    const rows = await this.runtime.database
      .query("library_abs_progress as p")
      .join("media_items as m", "m.id", "p.item_id")
      .select("p.*")
      .where({ "p.library_id": context.libraryId, "p.account_id": context.accountId })
      .whereNull("m.deleted_at");
    return rows.map((row) => mapProgress(context, row));
  }

  /** 读取单书进度；没有记录时返回 null，不伪造收听历史。 */
  public async get(
    context: AbsContext,
    book: Pick<AbsBook, "item" | "bookId" | "duration">,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.runtime.database
      .query("library_abs_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: book.item.id })
      .first();
    return row ? mapProgress(context, row, book) : null;
  }

  /** 按账号串行调度，在会话状态与进度写入之间不留下另一个会话抢写的窗口。 */
  public async serializeWrite<T>(context: AbsContext, write: () => Promise<T>): Promise<T> {
    const key = `${context.libraryId}:${context.accountId}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    this.writes.set(key, current);
    try {
      return await current;
    } finally {
      if (this.writes.get(key) === current) this.writes.delete(key);
    }
  }

  /** 首次创建进度没有行可锁，统一先锁真实账号，随后才能锁播放会话及作品进度。 */
  public async lockAccount(context: AbsContext, transaction: AbsQuery): Promise<void> {
    let query = transaction("library_abs_accounts")
      .select("id")
      .where({ id: context.accountId, library_id: context.libraryId, status: "active" });
    if (this.runtime.database.databaseType !== "sqlite") query = query.forUpdate();
    if (!(await query.first())) throw new ApiError(401, "abs_account_disabled", "ABS 账号已停用或删除");
  }

  /** 更新主动进度；会话同步使用同事务入口，保证状态判断与位置保存不可分割。 */
  public async update(
    context: AbsContext,
    book: AbsBook,
    body: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.serializeWrite(context, () =>
      this.runtime.database.query.transaction((transaction) =>
        this.updateInTransaction(context, book, body, transaction),
      ),
    );
    await this.publish(context, result, sessionId);
    return result.progress;
  }

  /** 保存原事件时间；较旧事件或同毫秒的不同位置不会覆盖已保存的另一个设备进度。 */
  public async updateInTransaction(
    context: AbsContext,
    book: AbsBook,
    body: Record<string, unknown>,
    transaction: AbsQuery,
  ): Promise<AbsProgressWriteResult> {
    if (
      body.currentTime !== undefined &&
      (!Number.isFinite(Number(body.currentTime)) || Number(body.currentTime) < 0)
    )
      throw new ApiError(400, "abs_position_invalid", "全书播放位置必须为非负秒数");
    const now = Date.now();
    // 关键变量：客户端事件时间同时用于冲突比较和持久化，不能替换成接收请求的服务器时间。
    const eventTime = body.lastUpdate === undefined ? now : Number(body.lastUpdate);
    if (!Number.isFinite(eventTime) || eventTime <= 0 || eventTime > now + 5 * 60000)
      throw new ApiError(400, "abs_progress_timestamp_invalid", "进度事件时间无效或客户端时钟超前过多");
    await this.lockAccount(context, transaction);
    let query = transaction("library_abs_progress").where({
      library_id: context.libraryId,
      account_id: context.accountId,
      item_id: book.item.id,
    });
    if (this.runtime.database.databaseType !== "sqlite") query = query.forUpdate();
    const existing = await query.first();
    if (existing && eventTime < Number(existing.updated_at))
      return {
        progress: mapProgress(context, existing, book),
        changed: false,
        accepted: false,
        reason: "stale",
      };
    const duration = book.duration || readAbsSeconds(body.duration) || readAbsSeconds(existing?.duration);
    const position =
      body.currentTime === undefined
        ? readAbsSeconds(existing?.current_time)
        : Math.min(duration || Infinity, Number(body.currentTime));
    // 官方默认剩余小于10秒标记全书完成；显式 isFinished=false 重置已完成状态。
    let finished = Number(existing?.is_finished ?? 0) === 1;
    let nextPosition = position;
    if (body.isFinished !== undefined) {
      finished = body.isFinished === true;
      if (!finished && Number(existing?.is_finished ?? 0) === 1) nextPosition = 0;
    } else if (body.currentTime !== undefined && duration > 0) finished = duration - position < 10;
    const patch = {
      current_time: nextPosition,
      duration,
      is_finished: finished ? 1 : 0,
      hide_from_continue:
        body.hideFromContinueListening === undefined
          ? body.currentTime !== undefined
            ? 0
            : Number(existing?.hide_from_continue ?? 0)
          : body.hideFromContinueListening
            ? 1
            : 0,
      finished_at: finished ? (existing?.finished_at ?? eventTime) : null,
      updated_at: eventTime,
    };
    if (existing && eventTime === Number(existing.updated_at)) {
      // 相同事件的重试无需发重复通知；同时间的不同事件保留先写者，向离线调用方明确报告冲突。
      const matches =
        Number(existing.current_time) === patch.current_time &&
        Number(existing.duration) === patch.duration &&
        Number(existing.is_finished) === patch.is_finished &&
        Number(existing.hide_from_continue) === patch.hide_from_continue;
      return {
        progress: mapProgress(context, existing, book),
        changed: false,
        accepted: matches,
        reason: matches ? "unchanged" : "conflict",
      };
    }
    let row: Record<string, unknown>;
    if (existing) {
      await transaction("library_abs_progress").where({ id: existing.id }).update(patch);
      row = { ...existing, ...patch };
    } else {
      row = {
        id: randomUUID(),
        library_id: context.libraryId,
        account_id: context.accountId,
        item_id: book.item.id,
        started_at: eventTime,
        ...patch,
      };
      await transaction("library_abs_progress").insert(row);
    }
    return { progress: mapProgress(context, row, book), changed: true, accepted: true, reason: "updated" };
  }

  /** 事务提交后再发送变化，旧事件或幂等重试不伪造更新通知。 */
  public async publish(
    context: AbsContext,
    result: AbsProgressWriteResult,
    sessionId?: string,
  ): Promise<void> {
    if (!result.changed) return;
    await this.hub.emit(context, "user_item_progress_updated", {
      id: result.progress.id,
      sessionId: sessionId ?? null,
      data: result.progress,
    });
  }

  /** 只删除这本书的进度，不把命名书签顺带删除。 */
  public async remove(context: AbsContext, itemId: string): Promise<void> {
    await loadAbsBook(this.runtime, context, itemId);
    await this.runtime.database
      .query("library_abs_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId, item_id: itemId })
      .delete();
    await this.hub.emit(context, "user_item_progress_removed", { libraryItemId: itemId });
  }

  /** 多命名书签按全书秒数保存，当前进度与命名书签相互独立。 */
  public async bookmarks(context: AbsContext, itemId?: string): Promise<Record<string, unknown>[]> {
    let query = this.runtime.database
      .query("library_abs_bookmarks as b")
      .join("media_items as m", "m.id", "b.item_id")
      .select("b.*")
      .where({ "b.library_id": context.libraryId, "b.account_id": context.accountId })
      .whereNull("m.deleted_at");
    if (itemId) query = query.where("b.item_id", itemId);
    const rows = await query.orderBy("b.time_seconds", "asc");
    return rows.map((row) => ({
      libraryItemId: String(row.item_id),
      title: String(row.title),
      time: Number(row.time_seconds),
      createdAt: Number(row.created_at),
    }));
  }

  /** 新建或修改同一秒位置的书签；不制造 Subsonic 单书签语义。 */
  public async writeBookmark(
    context: AbsContext,
    itemId: string,
    body: Record<string, unknown>,
    updateOnly = false,
  ): Promise<Record<string, unknown>> {
    const book = await loadAbsBook(this.runtime, context, itemId);
    const time = Number(body.time);
    const title = body.title;
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      (book.duration > 0 && time > book.duration) ||
      typeof title !== "string" ||
      title.length > 2000
    )
      throw new ApiError(400, "abs_bookmark_invalid", "书签标题或全书秒数无效");
    const now = Date.now();
    const existing = await this.runtime.database
      .query("library_abs_bookmarks")
      .where({
        library_id: context.libraryId,
        account_id: context.accountId,
        item_id: itemId,
        time_seconds: time,
      })
      .first();
    if (updateOnly && !existing) throw new ApiError(404, "abs_bookmark_not_found", "书签不存在");
    if (existing)
      await this.runtime.database
        .query("library_abs_bookmarks")
        .where({ id: existing.id })
        .update({ title, updated_at: now });
    else
      await this.runtime.database.query("library_abs_bookmarks").insert({
        id: randomUUID(),
        library_id: context.libraryId,
        account_id: context.accountId,
        item_id: itemId,
        time_seconds: time,
        title,
        created_at: now,
        updated_at: now,
      });
    const bookmark = {
      libraryItemId: itemId,
      title,
      time,
      createdAt: existing ? Number(existing.created_at) : now,
    };
    await this.hub.emit(
      context,
      "user_updated",
      await buildAbsUser(this.runtime, context, this.access, this),
    );
    return bookmark;
  }

  /** 删除标准 time 定位的单个命名书签。 */
  public async deleteBookmark(context: AbsContext, itemId: string, value: string): Promise<void> {
    await loadAbsBook(this.runtime, context, itemId);
    const time = Number(value);
    if (!Number.isFinite(time) || time < 0) throw new ApiError(400, "abs_bookmark_invalid", "书签位置无效");
    await this.runtime.database
      .query("library_abs_bookmarks")
      .where({
        library_id: context.libraryId,
        account_id: context.accountId,
        item_id: itemId,
        time_seconds: time,
      })
      .delete();
    await this.hub.emit(
      context,
      "user_updated",
      await buildAbsUser(this.runtime, context, this.access, this),
    );
  }
}

/** 持久化字段按官方旧 JSON 结构映射，保持书籍和 libraryItem 两层身份。 */
function mapProgress(
  context: AbsContext,
  row: Record<string, unknown>,
  book?: Pick<AbsBook, "item" | "bookId" | "duration">,
): Record<string, unknown> {
  const duration = book?.duration || Number(row.duration ?? 0);
  const finished = Number(row.is_finished) === 1;
  return {
    id: String(row.id),
    userId: context.accountId,
    libraryItemId: String(row.item_id),
    episodeId: null,
    mediaItemId: book?.bookId ?? absEntityId(context.libraryId, "book", String(row.item_id)),
    mediaItemType: "book",
    duration,
    progress: finished ? 1 : duration > 0 ? Math.min(1, Number(row.current_time) / duration) : 0,
    currentTime: Number(row.current_time),
    isFinished: finished,
    hideFromContinueListening: Number(row.hide_from_continue) === 1,
    ebookLocation: null,
    ebookProgress: null,
    lastUpdate: Number(row.updated_at),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
  };
}
