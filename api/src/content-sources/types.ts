/** 内容源插件只描述固定 CMS JSON 协议，不包含可执行脚本。 */
export interface ContentSourceManifest {
  protocolVersion: 1;
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  adapter: "cms_json";
  endpoint: string;
  headers?: Record<string, string>;
  /** 指定电影父分类；其他已选分类按节目分集。 */
  movieCategoryIds: string[];
  /** 可选的专用音乐、小说等非视频父分类，不允许同步到首期视频库。 */
  excludedCategoryIds?: string[];
}

/** 安装及启停后的插件公开摘要。 */
export interface ContentSourcePluginRecord {
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  adapter: "cms_json";
  status: "enabled" | "disabled" | "imported" | "uninstalled";
}

/** 每个用户独立创建的内容源配置实例。 */
export interface ContentSourceInstance {
  id: string;
  userId: string;
  pluginId: string;
  pluginVersion: string;
  displayName: string;
  status: "active" | "disabled";
  pluginStatus: ContentSourcePluginRecord["status"];
  libraryId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** CMS 分类及父分类，使用源站原始字符串 ID。 */
export interface ContentSourceCategory {
  id: string;
  name: string;
  parentId: string | null;
}

/** 协议层使用源分类作为虚拟媒体库；空 ID 仅承接尚未补齐分类的历史条目。 */
export interface ContentSourceCategoryDefinition {
  categoryId: string | null;
  name: string;
  parentId: string | null;
  collectionType?: "movies" | "tvshows";
}

/** 在线内容源按协议选择自动、客户端直连或云助手中转。 */
export type ContentSourcePlaybackMode = "auto" | "direct" | "relay";

/** 两套影视协议独立保存播放模式，不复用网盘中转开关。 */
export type ContentSourcePlaybackProtocol = "jellyfin" | "emby";

/** 已应用默认值的在线库播放配置。 */
export interface ContentSourcePlaybackModes {
  jellyfin: ContentSourcePlaybackMode;
  emby: ContentSourcePlaybackMode;
}

/** 稳定的线路与单集定位；地址仅在同步或即时播放时存在于内存。 */
export interface CmsPlaybackEpisode {
  lineName: string;
  episodeKey: string;
  name: string;
  episodeNumber: number;
  seasonNumber: number;
  url: string;
  container: "hls" | "mp4";
}

/** 从 CMS JSON 读取的电影或节目详情。 */
export interface CmsContentItem {
  id: string;
  title: string;
  categoryId: string;
  parentCategoryId: string | null;
  categoryName: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  area: string;
  genres: string[];
  /** 源站明确给出的有效评分和标签；旧浏览缓存没有这些字段时保留缺失。 */
  rating?: number | null;
  tags?: string[];
  actors: string[];
  directors: string[];
  episodes: CmsPlaybackEpisode[];
}

/** 目录持久化与浏览缓存只需要播放身份和格式，实际 URL 仍由即时详情解析。 */
export type CmsCatalogContentItem = Omit<CmsContentItem, "episodes"> & {
  episodes: Array<Omit<CmsPlaybackEpisode, "url">>;
};

/** 源页原始窗口与过滤后的候选分开，空候选不能被误认为源站末页。 */
export interface CmsContentPage {
  items: CmsContentItem[];
  pageCount: number;
  sourcePageCount: number | null;
  rawItemCount: number;
}

/** 动态分类浏览仅支持顶层电影和节目，保持源站原始顺序。 */
export interface ContentSourceBrowseOptions {
  categoryId: string;
  startIndex?: number;
  limit?: number;
  itemTypes?: Array<"video.movie" | "video.series">;
}

/** 实时搜索限定当前所选视频分类，可进一步限制到一个选中分类。 */
export interface ContentSourceSearchOptions {
  searchTerm: string;
  categoryId?: string;
  startIndex?: number;
  limit?: number;
  itemTypes?: Array<"video.movie" | "video.series">;
}

/** 数量只对应已成功建立的可查询索引，完整扫到源尾后才代表全分类。 */
export interface ContentSourceBrowseResult {
  itemIds: string[];
  startIndex: number;
  totalRecordCount: number;
  totalIsExact: boolean;
  hasMore: boolean;
  sort: "source_default";
}

/** 供协议层构造标准 MediaSources 的公开播放来源。 */
export interface ContentPlaybackSource {
  id: string;
  itemId: string;
  instanceId: string;
  name: string;
  lineName: string;
  episodeKey: string;
  container: "hls" | "mp4";
  runTimeTicks: number;
  sourceName: string;
}

/** 未完成目录批次固定各分类目标页，重试只继续原范围。 */
export interface ContentSourcePendingBatch {
  pageCount: number;
  sample: boolean;
  /** 不含该页；当前游标达到此值后该分类不再继续请求。 */
  endPageExclusiveByCategory: Record<string, number>;
  completedCategoryIds: string[];
  remainingSampleCountByCategory: Record<string, number>;
  /** 样本部分页不推进游标，重试时跳过本批已成功条目，避免重复扣额度。 */
  sampledItemIdsByCategory?: Record<string, string[]>;
}

/** 同步状态持久化，API 重启后仍可查看已完成范围和错误。 */
export interface ContentSourceSyncState {
  status: "idle" | "queued" | "running" | "completed" | "failed";
  processedCount: number;
  pageCount: number;
  nextPageByCategory: Record<string, number>;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** 仅成功完成 next 才清除；刷新目录、失败、停用和重启均保留。 */
  pendingBatch?: ContentSourcePendingBatch;
}
