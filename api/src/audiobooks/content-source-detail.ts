import type { MediaItemRecord } from "../domain.js";
import type { ApiRuntime } from "../runtime.js";

/** 管理端和普通端只在打开在线书籍时补章节，目录列表不触发源详情。 */
export async function ensureContentAudiobookDetail(runtime: ApiRuntime, item: MediaItemRecord): Promise<MediaItemRecord> {
  if (item.libraryKind !== "content_source_audiobook" || item.itemType !== "audiobook.book") return item;
  await runtime.contentAudiobooks.ensureBookDetails(item.libraryId, item.userId, item.id);
  return runtime.repository.getCatalogItem(item.id, item.userId);
}
