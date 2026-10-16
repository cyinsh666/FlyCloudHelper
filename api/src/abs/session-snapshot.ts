import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { readAbsObject, type AbsBook, type AbsContext, type AbsTrack } from "./types.js";

/** 保存会话建立时的作品、物理文件身份和整书时间轴，不持久化临时取流地址。 */
export function createAbsSessionSnapshot(book: AbsBook): string {
  const tracks = book.tracks.map((track) => ({
    ...track,
    file: {
      fileId: track.file.fileId,
      librarySourceId: track.file.librarySourceId,
      resourceId: track.file.resourceId,
      path: track.file.path,
      name: track.file.name,
      size: track.file.size,
      modifiedAt: track.file.modifiedAt,
    },
  }));
  return JSON.stringify({ version: 1, book: { ...book, tracks } });
}

/** 历史行缺少快照时保留历史统计，但禁止按后来扫描的目录重建旧播放会话。 */
export function readAbsSessionSnapshot(row: Record<string, unknown>): AbsBook | null {
  const snapshot = readAbsObject(row.snapshot_json);
  const book = readAbsObject(snapshot.book);
  const item = readAbsObject(book.item);
  if (
    snapshot.version !== 1 ||
    item.id !== row.item_id ||
    typeof book.bookId !== "string" ||
    !Array.isArray(book.tracks) ||
    !Array.isArray(book.chapters) ||
    !Array.isArray(book.authors) ||
    !Array.isArray(book.narrators) ||
    !Array.isArray(book.series) ||
    !Number.isFinite(Number(book.duration)) ||
    Number(book.duration) < 0
  )
    return null;
  const indexes = new Set<number>();
  for (const value of book.tracks) {
    const track = readAbsObject(value);
    const file = readAbsObject(track.file);
    const index = Number(track.index);
    if (
      !Number.isInteger(index) ||
      index < 1 ||
      indexes.has(index) ||
      typeof track.ino !== "string" ||
      track.ino !== file.fileId ||
      typeof file.librarySourceId !== "string" ||
      typeof file.resourceId !== "string" ||
      !Number.isFinite(Number(track.startOffset)) ||
      !Number.isFinite(Number(track.duration))
    )
      return null;
    indexes.add(index);
  }
  return book as unknown as AbsBook;
}

/** 只按已固定的真实文件身份更新当前位置，绝不拿当前第 N 轨替代旧会话的第 N 轨。 */
export async function resolveAbsSessionTrack(
  runtime: ApiRuntime,
  context: AbsContext,
  book: AbsBook,
  index: number,
): Promise<AbsTrack> {
  if (!Number.isInteger(index) || index < 1)
    throw new ApiError(400, "abs_track_index_invalid", "音轨序号必须为正整数");
  const track = book.tracks.find((entry) => entry.index === index);
  if (!track) throw new ApiError(404, "abs_track_not_found", "会话没有这个音轨");
  if (String(book.item.libraryKind) === "content_source_audiobook") {
    const files = await runtime.contentAudiobooks.filesForBook(context.libraryId, context.ownerUserId, book.item.id);
    // 关键变量：只恢复快照原章节身份，调序之后也不能把当前第 N 章代替原来的第 N 章。
    const file = files.find((entry) => String(entry.fileId) === track.ino &&
      String(entry.itemId) === track.chapterId &&
      String(entry.librarySourceId) === String(track.file.librarySourceId) &&
      String(entry.resourceId) === String(track.file.resourceId));
    if (!file) throw new ApiError(410, "abs_session_track_gone", "会话原章节已移除，请重新打开作品播放");
    return { ...track, file: { ...file, contentSourceAudiobook: true, bookItemId: book.item.id } };
  }
  // 关键变量：快照只固定身份，最新 locator 必须从同用户、同库、同来源的活动源文件读取。
  const file = await runtime.database
    .query("source_files as f")
    .join("library_sources as ls", "ls.id", "f.library_source_id")
    .leftJoin("cloud_services as s", "s.id", "ls.service_id")
    .select(
      "f.*",
      "ls.status as source_status",
      "ls.source_mode",
      "ls.connection_status as source_connection_status",
      "s.status as service_status",
      "s.connection_status as service_connection_status",
      "s.deleted_at as service_deleted_at",
    )
    .where({
      "f.id": track.ino,
      "f.library_source_id": String(track.file.librarySourceId),
      "f.user_id": context.ownerUserId,
      "f.library_id": context.libraryId,
      "f.status": "active",
      "ls.user_id": context.ownerUserId,
      "ls.library_id": context.libraryId,
    })
    .first();
  if (
    !file ||
    String(file.provider_resource_id) !== String(track.file.resourceId) ||
    file.source_status !== "active"
  )
    throw new ApiError(410, "abs_session_track_gone", "会话原音轨已移除，请重新打开作品播放");
  if (
    file.source_mode === "linked_service"
      ? file.service_deleted_at ||
        !["active", "scanning"].includes(String(file.service_status)) ||
        file.service_connection_status !== "valid"
      : file.source_connection_status !== "valid"
  )
    throw new ApiError(503, "abs_source_unavailable", "会话音轨所属网盘暂不可用，请检查登录状态");
  const locator = readAbsObject(file.locator_json);
  return {
    ...track,
    file: {
      ...track.file,
      fileId: String(file.id),
      librarySourceId: String(file.library_source_id),
      resourceId: String(file.provider_resource_id),
      path: String(file.path),
      name: String(file.name),
      size: Number(file.size),
      modifiedAt: file.modified_at,
      sourceLocator: locator,
      playbackLocator: locator,
    },
  };
}
