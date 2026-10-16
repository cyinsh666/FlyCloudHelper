import { requestJson } from "@/lib/api";
import type { ContentSourceCategory, ContentSourceInstance, ContentSourceSync } from "@/lib/content-source-api";

/** 在线听书库独立的分类摘要与同步状态，不复用网盘扫描配置。 */
export interface ContentAudiobookLibraryState {
  source: ContentSourceInstance;
  configuration: {
    categoryIds: string[];
    categories: ContentSourceCategory[];
    initialPageCount?: number;
  };
  sync: ContentSourceSync;
}

/** 个人端与管理端始终访问当前媒体库对应的权限入口。 */
function contentAudiobookPath(libraryId: string, admin: boolean): string {
  return `${admin ? "/api/v1/admin" : "/api/v1"}/libraries/${encodeURIComponent(libraryId)}/content-audiobook`;
}

/** 读取来源、已选分类及最近同步状态，不主动加载每本书的章节。 */
export function getContentAudiobookLibrary(libraryId: string, admin = false): Promise<ContentAudiobookLibraryState> {
  return requestJson(contentAudiobookPath(libraryId, admin));
}

/** 用户主动重新读取源站分类，供编辑分类时选择。 */
export function listContentAudiobookCategories(libraryId: string, admin = false): Promise<{ items: ContentSourceCategory[] }> {
  return requestJson(`${contentAudiobookPath(libraryId, admin)}/categories`);
}

/** 保存分类选择，同步由用户另行触发，已有书籍和收听记录继续保留。 */
export function updateContentAudiobookLibrary(libraryId: string, categoryIds: string[], admin = false): Promise<ContentAudiobookLibraryState> {
  return requestJson(contentAudiobookPath(libraryId, admin), {
    method: "PATCH", body: JSON.stringify({ categoryIds }),
  });
}

/** 仅同步摘要分页，详情、章节和音频取址继续按需读取。 */
export function syncContentAudiobookLibrary(libraryId: string, input: {
  mode: "next" | "latest" | "refresh";
  pageCount?: number;
}, admin = false): Promise<{ sync: ContentSourceSync }> {
  return requestJson(`${contentAudiobookPath(libraryId, admin)}/sync`, {
    method: "POST", body: JSON.stringify(input),
  });
}
