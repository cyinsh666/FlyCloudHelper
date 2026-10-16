import type { ContentSourceCategory, ContentSourceManifest } from "./types.js";

/** 搜索没有真实分类时使用显式虚拟归属，不冒充任一已选分类。 */
export const AUDIOBOOK_SEARCH_CATEGORY = "__search__";

/** 分类只使用源明确给出的身份；同一本书可以被多个真实分类页收录。 */
export interface AudiobookSourceCategory {
  id: string;
  name: string;
}

/** 听书卡片只携带摘要，不包含章节、播放器输入和临时音频地址。 */
export interface AudiobookSourceCard {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
  categories: AudiobookSourceCategory[];
  overview: string;
  posterUrl: string | null;
  authors: string[];
  narrators: string[];
  genres: string[];
}

/** 稳定章节身份与即时播放器输入分开；未知真实时长明确保留 null。 */
export interface AudiobookSourceTrack {
  id: string;
  title: string;
  duration: number | null;
  mimeType: string;
  playbackId: string;
  flag: string;
}

/** 完整详情只在内存携带播放器输入，持久目录必须去掉该字段。 */
export interface AudiobookSourceDetail extends AudiobookSourceCard {
  tracks: AudiobookSourceTrack[];
}

/** 过滤后的列表和源原始窗口分开，付费过滤为空不等于上游末页。 */
export interface AudiobookSourcePage {
  items: AudiobookSourceCard[];
  rawItemCount: number;
  sourcePageCount: number | null;
}

/** 当前在线听书库沿用已有内容源配置 JSON，不新增数据库列。 */
export interface ContentAudiobookConfiguration {
  categoryIds: string[];
  categories: ContentSourceCategory[];
  categoryCatalog: ContentSourceCategory[];
  initialPageCount: number;
}

/** 内容源清单按显式媒体类型区分听书与视频。 */
export type AudiobookSourceManifest = ContentSourceManifest & { mediaType: "audiobook" };

/** 虚拟音频定位只保存稳定身份，禁止写入播放地址和 Spider 临时播放输入。 */
export interface ContentAudiobookLocator {
  kind: "content_source_audiobook";
  instanceId: string;
  bookItemId: string;
  chapterItemId: string;
  remoteBookId: string;
  remoteChapterId: string;
}
