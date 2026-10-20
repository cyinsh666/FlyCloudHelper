import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import type { AudiobookDirectoryState } from "./audiobook-types.js";

/** 每本书独立小状态，不把全部章节或账号状态放进单条配置。 */
export function audiobookDirectoryKey(libraryId: string, bookId: string): string {
  return `audiobook:dir:${createHash("sha256").update(JSON.stringify([libraryId, bookId])).digest("hex").slice(0, 32)}`;
}

/** 目录状态始终返回明确的准备/完成边界，供原生202及ABS完整性门控使用。 */
export function emptyAudiobookDirectory(): AudiobookDirectoryState {
  return { status: "NotLoaded", catalogComplete: false, catalogRevision: "0", chapterCount: null, checkedAt: null, lastError: null };
}

/** 固定作用域检查阻止散列碰撞或错误库ID读取另一条目录状态。 */
export function decodeAudiobookDirectory(row: Record<string, unknown> | undefined, libraryId: string, userId: string, bookId: string): AudiobookDirectoryState {
  if (!row) return emptyAudiobookDirectory();
  const value = parseJsonObject(row.setting_value);
  if (value.libraryId !== libraryId || value.userId !== userId || value.bookId !== bookId) throw new ApiError(409, "audiobook_directory_scope_invalid", "听书目录状态身份不匹配");
  return { ...emptyAudiobookDirectory(), ...value } as unknown as AudiobookDirectoryState;
}

/** 读取小状态时只使用精确主键，不扫描通用配置表。 */
export async function readAudiobookDirectory(database: FlyCloudHelperDatabase, libraryId: string, userId: string, bookId: string): Promise<AudiobookDirectoryState> {
  const row = await database.query("system_settings").where({ setting_key: audiobookDirectoryKey(libraryId, bookId) }).first();
  return decodeAudiobookDirectory(row, libraryId, userId, bookId);
}

/** 调用方持有库/目录状态锁后原子写入内容版本和任务租约，不依赖进程内锁。 */
export async function writeAudiobookDirectory(transaction: Knex.Transaction, libraryId: string, userId: string, bookId: string, state: AudiobookDirectoryState): Promise<void> {
  const key = audiobookDirectoryKey(libraryId, bookId);
  const existing = await transaction("system_settings").where({ setting_key: key }).first();
  const now = new Date().toISOString();
  const value = JSON.stringify({ ...state, libraryId, userId, bookId });
  if (existing) {
    decodeAudiobookDirectory(existing, libraryId, userId, bookId);
    const revision = Number(existing.revision);
    if (!Number.isSafeInteger(revision) || revision >= 2147483647) throw new ApiError(409, "audiobook_directory_revision_exhausted", "听书目录状态版本已达到上限");
    const changed = await transaction("system_settings").where({ setting_key: key, revision }).update({ setting_value: value, revision: revision + 1, updated_at: now });
    if (changed !== 1) throw new ApiError(409, "audiobook_directory_conflict", "听书目录正在更新，请重试");
  } else {
    await transaction("system_settings").insert({ setting_key: key, setting_value: value, revision: 1, updated_by_user_id: userId, created_at: now, updated_at: now });
  }
}

/** 领取每书准备任务；同库行锁使多进程的首次创建和后续批次具有固定顺序。 */
export async function claimAudiobookDirectory(database: FlyCloudHelperDatabase, libraryId: string, userId: string, bookId: string, previous?: AudiobookDirectoryState): Promise<{ owned: boolean; state: AudiobookDirectoryState }> {
  return database.query.transaction(async (transaction) => {
    let library = transaction("media_libraries").where({ id: libraryId, user_id: userId, status: "active" });
    if (database.databaseType !== "sqlite") library = library.forUpdate();
    if (!(await library.first())) throw new ApiError(404, "audiobook_library_not_found", "在线听书媒体库不存在");
    const book = await transaction("media_items").where({ id: bookId, library_id: libraryId, user_id: userId, item_type: "audiobook.book" }).whereNull("deleted_at").first();
    if (!book) throw new ApiError(404, "audiobook_book_not_found", "听书作品不存在");
    const row = await transaction("system_settings").where({ setting_key: audiobookDirectoryKey(libraryId, bookId) }).first();
    const stored = decodeAudiobookDirectory(row, libraryId, userId, bookId);
    const current = stored.status === "NotLoaded" && previous?.catalogComplete ? { ...stored, chapterCount: previous.chapterCount, checkedAt: previous.checkedAt } : stored;
    if (current.status === "Preparing" && Date.parse(current.leaseExpiresAt ?? "") > Date.now()) return { owned: false, state: current };
    const state: AudiobookDirectoryState = { ...current, status: "Preparing", catalogComplete: false, lastError: null, runId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 240000).toISOString() };
    await writeAudiobookDirectory(transaction, libraryId, userId, bookId, state);
    return { owned: true, state };
  });
}

/** 失败只标记自己仍拥有的任务；旧进程的晚到错误不能覆盖新一轮准备。 */
export async function failAudiobookDirectory(database: FlyCloudHelperDatabase, libraryId: string, userId: string, bookId: string, runId: string, message: string, restoreCompleteIfRevision?: string): Promise<void> {
  await database.query.transaction(async (transaction) => {
    let library = transaction("media_libraries").where({ id: libraryId, user_id: userId });
    if (database.databaseType !== "sqlite") library = library.forUpdate();
    if (!(await library.first())) return;
    const row = await transaction("system_settings").where({ setting_key: audiobookDirectoryKey(libraryId, bookId) }).first();
    const state = decodeAudiobookDirectory(row, libraryId, userId, bookId);
    if (state.runId !== runId) return;
    const keepPrevious = restoreCompleteIfRevision !== undefined && state.catalogRevision === restoreCompleteIfRevision;
    await writeAudiobookDirectory(transaction, libraryId, userId, bookId, { ...state, status: keepPrevious ? "Ready" : "Failed", catalogComplete: keepPrevious, checkedAt: keepPrevious ? new Date().toISOString() : state.checkedAt, lastError: message, leaseExpiresAt: undefined });
  });
}
