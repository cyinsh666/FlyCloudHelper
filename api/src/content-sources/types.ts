/** 内容源清单声明 CMS、Python Spider 或网易音乐能力，各源独立固定版本。 */
export interface ContentSourceManifest {
  protocolVersion: 1;
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  adapter: "cms_json" | "python_spider" | "catvod_js" | "netease_http";
  /** Python 听书源显式声明有声书；未声明的既有 Python 源仍按视频处理。 */
  mediaType?: "video" | "music" | "audiobook";
  endpoint: string;
  headers?: Record<string, string>;
  /** 指定电影父分类；其他已选分类按节目分集。 */
  movieCategoryIds: string[];
  /** 可选的专用音乐、小说等非视频父分类，不允许同步到首期视频库。 */
  excludedCategoryIds?: string[];
  /** Python 源由导入入口保存的相对脚本路径，不接受远程执行地址。 */
  scriptFile?: string;
  /** 固定源版本的脚本摘要，防止文件内容与安装版本不一致。 */
  scriptHash?: string;
  /** Spider 初始化参数及缺少 limit 时使用的明确分页尺寸。 */
  pythonConfig?: { extend?: string; pageSize?: number };
  /** CatVod 初始化扩展参数；脚本、Cookie 与存储仍按源实例隔离。 */
  jsConfig?: { extend?: string; pageSize?: number };
}

/** 尚未即时取址的 Spider 分集不猜测媒体格式。 */
export type ContentVideoContainer = "hls" | "mp4" | "unknown";

/** 安装及启停后的插件公开摘要。 */
export interface ContentSourcePluginRecord {
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  adapter: ContentSourceManifest["adapter"];
  /** 建库入口依据插件声明选择领域，不根据名称猜测影视或听书。 */
  mediaType?: "video" | "music" | "audiobook";
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
  /** 源明确提供的无分类筛选总目录，不能依据名称或 ID 猜测。 */
  isAll?: boolean;
}

/** 协议层使用源分类作为虚拟媒体库；空 ID 仅承接尚未补齐分类的历史条目。 */
export interface ContentSourceCategoryDefinition {
  categoryId: string | null;
  name: string;
  parentId: string | null;
  collectionType?: "movies" | "tvshows";
  /** 总目录保留源分页定位，本地读取覆盖该源的全部实际分类。 */
  isAll?: boolean;
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
  url?: string;
  /** Spider 原始分集标识只在取址期间传给 playerContent，不保存到目录缓存。 */
  playbackId?: string;
  container: ContentVideoContainer;
}

/** 从内容源读取的电影或节目；CMS JSON 和 Python 摘要允许在访问详情时再补齐分集。 */
export interface CmsContentItem {
  id: string;
  title: string;
  categoryId: string;
  parentCategoryId: string | null;
  categoryName: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  /** 源明确给出的横图；缺失时不把竖海报冒充背景图。 */
  backdropUrl?: string | null;
  area: string;
  genres: string[];
  /** 源站明确给出的有效评分和标签；旧浏览缓存没有这些字段时保留缺失。 */
  rating?: number | null;
  tags?: string[];
  actors: string[];
  directors: string[];
  /** 内容源显式标记未查详情的摘要；旧源和缓存不凭空推断可播放状态。 */
  detailState?: "card" | "complete";
  episodes: CmsPlaybackEpisode[];
}

/** 目录持久化与浏览缓存只需要播放身份和格式，实际 URL 仍由即时详情解析。 */
export type CmsCatalogContentItem = Omit<CmsContentItem, "episodes"> & {
  episodes: Array<Omit<CmsPlaybackEpisode, "url" | "playbackId">>;
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
  container: ContentVideoContainer;
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
  /** 听书分类最近一次明确返回的总页数，保存在既有同步 JSON 中，不增加数据库字段。 */
  sourcePageCountByCategory?: Record<string, number>;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** 仅成功完成 next 才清除；刷新目录、失败、停用和重启均保留。 */
  pendingBatch?: ContentSourcePendingBatch;
}

/** 视频源统一业务接口，协议和目录不直接调用 Python 或 CMS 特有字段。 */
export interface VideoSourceAdapter {
  categories(signal?: AbortSignal): Promise<ContentSourceCategory[]>;
  page(categoryId: string, page: number, signal?: AbortSignal): Promise<CmsContentPage>;
  search(searchTerm: string, page: number, categoryId?: string, signal?: AbortSignal): Promise<CmsContentPage>;
  detail(remoteItemId: string, signal?: AbortSignal): Promise<CmsContentItem>;
  resolveEpisode(episode: CmsPlaybackEpisode, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; container: ContentVideoContainer }>;
}
