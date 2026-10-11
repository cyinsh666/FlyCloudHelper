import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";

/** 两套标准协议的本地内容源筛选；不访问源站，也不创建新的目录条目。 */
export interface ProtocolContentFilters {
  active: boolean;
  impossible: boolean;
  years?: number[];
  minCommunityRating?: number;
  tags?: string[];
  studios?: string[];
  hasOverview?: boolean;
  hasImdbId?: boolean;
  hasTmdbId?: boolean;
  hasTvdbId?: boolean;
  favorite?: boolean;
  played?: boolean;
  resumable?: boolean;
  folder?: boolean;
}

/** 筛选只读取当前库、当前协议账号的用户状态。 */
interface ContentFilterContext {
  libraryId: string;
  ownerUserId: string;
  accountId: string;
}

/** 元数据候选保持真实缺失值，不能用默认年份或零分补成匹配。 */
export interface ContentFilterMetadata {
  year?: unknown;
  rating?: unknown;
  overview?: unknown;
  tags?: unknown;
  studios?: unknown;
  providerIds?: Record<string, unknown>;
  folder?: boolean;
}

/** 账号状态同时服务筛选和收藏默认排序。 */
export interface ContentFilterUserState {
  played: boolean;
  positionTicks: number;
  favorite: boolean;
  starredAt?: unknown;
  updatedAt?: unknown;
}

/** 标准参数兼容 PascalCase、camelCase，保留显式 false。 */
function readQuery(query: Record<string, unknown>, key: string): unknown {
  return query[key] ?? query[`${key.charAt(0).toLowerCase()}${key.slice(1)}`];
}

/** 布尔参数缺失时不筛选，非法值按标准请求错误返回。 */
function readBoolean(query: Record<string, unknown>, key: string): boolean | undefined {
  const value = readQuery(query, key);
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new ApiError(400, "invalid_content_filter", `${key} 必须为 true 或 false`);
}

/** 名称筛选遵循协议的管道分隔，也兼容已有客户端逗号形式。 */
function readNames(query: Record<string, unknown>, key: string): string[] | undefined {
  const names = String(readQuery(query, key) ?? "").split(/[|,]/u).map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names : undefined;
}

/** 组合参数与 Filters 枚举；相互矛盾的条件返回空集，不悄悄覆盖其中一个。 */
export function readProtocolContentFilters(
  query: Record<string, unknown>, required: { favorite?: boolean; played?: boolean } = {},
): ProtocolContentFilters {
  // 关键变量：缺少稳定工作室 ID、分级或人物角色筛选数据时明确报错，不能忽略请求条件。
  const unsupported = ["StudioIds", "MinOfficialRating", "MaxOfficialRating", "IsMissing", "IsUnaired", "Person", "PersonTypes"]
    .filter((key) => {
      const value = readQuery(query, key);
      return value !== undefined && value !== null && String(value).trim() !== "";
    });
  const enums = new Set(String(readQuery(query, "Filters") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const supportedEnums = new Set(["isfavorite", "isplayed", "isunplayed", "isresumable", "isfolder", "isnotfolder"]);
  if ([...enums].some((value) => !supportedEnums.has(value))) unsupported.push("Filters");
  if (unsupported.length > 0) {
    throw new ApiError(400, "unsupported_content_filter", `当前内容源暂不支持这些筛选字段：${unsupported.join("、")}`);
  }
  const result: ProtocolContentFilters = { active: false, impossible: false };
  const years = String(readQuery(query, "Years") ?? "").split(",").map((year) => year.trim()).filter(Boolean);
  if (years.length > 0) {
    if (years.some((year) => !/^\d{1,4}$/u.test(year) || Number(year) < 1)) {
      throw new ApiError(400, "invalid_content_filter", "Years 必须为逗号分隔的年份");
    }
    result.years = [...new Set(years.map(Number))];
  }
  const minimum = readQuery(query, "MinCommunityRating");
  if (minimum !== undefined && minimum !== null && String(minimum).trim() !== "") {
    result.minCommunityRating = Number(minimum);
    if (!Number.isFinite(result.minCommunityRating) || result.minCommunityRating < 0) {
      throw new ApiError(400, "invalid_content_filter", "MinCommunityRating 必须为非负数值");
    }
  }
  result.tags = readNames(query, "Tags");
  result.studios = readNames(query, "Studios");
  for (const key of ["HasOverview", "HasImdbId", "HasTmdbId", "HasTvdbId"] as const) {
    const field = `${key.charAt(0).toLowerCase()}${key.slice(1)}` as "hasOverview" | "hasImdbId" | "hasTmdbId" | "hasTvdbId";
    result[field] = readBoolean(query, key);
  }
  result.favorite = readBoolean(query, "IsFavorite");
  result.played = readBoolean(query, "IsPlayed");
  result.resumable = readBoolean(query, "IsResumable");
  result.folder = readBoolean(query, "IsFolder");
  // 关键变量：没有播放记录也是未观看；IsUnplayed=false 则要求已观看。
  const unplayed = readBoolean(query, "IsUnplayed");
  // 组合显式参数与标准枚举，保留每个已指定条件。
  const add = (field: "favorite" | "played" | "resumable" | "folder", expected: boolean): void => {
    if (result[field] !== undefined && result[field] !== expected) result.impossible = true;
    else result[field] = expected;
  };
  if (unplayed !== undefined) add("played", !unplayed);
  if (enums.has("isfavorite")) add("favorite", true);
  if (enums.has("isplayed")) add("played", true);
  if (enums.has("isunplayed")) add("played", false);
  if (enums.has("isresumable")) add("resumable", true);
  if (enums.has("isfolder")) add("folder", true);
  if (enums.has("isnotfolder")) add("folder", false);
  if (required.favorite !== undefined) add("favorite", required.favorite);
  if (required.played !== undefined) add("played", required.played);
  result.active = Object.entries(result).some(([key, value]) => key !== "active" && key !== "impossible" && value !== undefined)
    || result.impossible;
  return result;
}

/** 读取真实名称数组，兼容标准 Name 对象，不把任意对象转成字符串。 */
export function readContentFilterNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === "string" ? item.trim()
    : item && typeof item === "object" ? String((item as Record<string, unknown>).Name ?? (item as Record<string, unknown>).name ?? "").trim() : "")
    .filter(Boolean))];
}

/** 已知名称精确比较；源分类名称不参与 Tags 或 Studios 的匹配。 */
function matchesNames(requested: string[] | undefined, actual: unknown): boolean {
  if (!requested) return true;
  const available = new Set(readContentFilterNames(actual).map((name) => name.toLocaleLowerCase("und")));
  return requested.some((name) => available.has(name.toLocaleLowerCase("und")));
}

/** 外部编号存在性只检查对应 provider 的非空真实值。 */
function hasProvider(ids: Record<string, unknown> | undefined, provider: string): boolean {
  return Object.entries(ids ?? {}).some(([key, value]) => key.toLowerCase() === provider
    && typeof value === "string" && value.trim() !== "");
}

/** 元数据筛选先于账号状态、排序和分页，缺失的正向条件不会命中。 */
export function matchesContentFilterMetadata(filters: ProtocolContentFilters, item: ContentFilterMetadata): boolean {
  if (filters.impossible) return false;
  if (filters.years && (!item.year || !filters.years.includes(Number(item.year)))) return false;
  // 项目用零分表示尚无评分，与两协议 DTO 省略 CommunityRating 的规则一致。
  const rating = Number(item.rating);
  if (filters.minCommunityRating !== undefined && (!Number.isFinite(rating) || rating <= 0 || rating < filters.minCommunityRating)) return false;
  if (!matchesNames(filters.tags, item.tags) || !matchesNames(filters.studios, item.studios)) return false;
  if (filters.hasOverview !== undefined && filters.hasOverview !== (typeof item.overview === "string" && item.overview.trim() !== "")) return false;
  if (filters.hasImdbId !== undefined && filters.hasImdbId !== hasProvider(item.providerIds, "imdb")) return false;
  if (filters.hasTmdbId !== undefined && filters.hasTmdbId !== hasProvider(item.providerIds, "tmdb")) return false;
  if (filters.hasTvdbId !== undefined && filters.hasTvdbId !== hasProvider(item.providerIds, "tvdb")) return false;
  return filters.folder === undefined || filters.folder === Boolean(item.folder);
}

/** 正进度才是 IsResumable；完播生成的零进度 pending 不冒充已经开始播放。 */
export function matchesContentFilterUserState(filters: ProtocolContentFilters, state?: ContentFilterUserState): boolean {
  const played = state?.played ?? false;
  const position = played ? 0 : state?.positionTicks ?? 0;
  return !filters.impossible
    && (filters.played === undefined || filters.played === played)
    && (filters.favorite === undefined || filters.favorite === Boolean(state?.favorite))
    && (filters.resumable === undefined || filters.resumable === (position > 0));
}

/** 从标准 DTO 检查旁路列表与虚拟人物，保证它们也在分页前执行同样条件。 */
export function matchesContentFilterDto(filters: ProtocolContentFilters, item: Record<string, unknown>): boolean {
  const data = item.UserData as Record<string, unknown> | undefined;
  return matchesContentFilterMetadata(filters, {
    year: item.ProductionYear, rating: item.CommunityRating, overview: item.Overview,
    tags: item.Tags, studios: item.Studios, providerIds: item.ProviderIds as Record<string, unknown> | undefined,
    folder: Boolean(item.IsFolder),
  }) && matchesContentFilterUserState(filters, {
    played: Boolean(data?.Played), positionTicks: Number(data?.PlaybackPositionTicks ?? 0), favorite: Boolean(data?.IsFavorite),
  });
}

/** 批量读取协议隔离的账号状态，节目已观看按当前有效单集汇总，避免历史父状态过期。 */
export async function loadContentFilterUserStates(
  runtime: ApiRuntime, context: ContentFilterContext, protocol: "jellyfin" | "emby",
  items: Array<{ id: string; itemType: string }>, filters: ProtocolContentFilters,
): Promise<Map<string, ContentFilterUserState>> {
  const states = new Map<string, ContentFilterUserState>();
  const needsProgress = filters.played !== undefined || filters.resumable !== undefined;
  const needsFavorite = filters.favorite !== undefined;
  if (!needsProgress && !needsFavorite) return states;
  // 关键变量：表名来自固定协议枚举，不接受请求输入，更不能跨协议复用账号状态。
  const progressTable = protocol === "emby" ? "library_emby_playback_progress" : "library_playback_progress";
  const favoriteTable = protocol === "emby" ? "library_emby_item_preferences" : "library_item_preferences";
  const ids = [...new Set(items.map((item) => item.id))];
  for (let offset = 0; offset < ids.length; offset += 300) {
    const batch = ids.slice(offset, offset + 300);
    const progressRows = needsProgress ? await runtime.database.query(progressTable)
      .where({ library_id: context.libraryId, account_id: context.accountId }).whereIn("item_id", batch)
      .select("item_id", "played", "position_ticks", "updated_at") : [];
    const favoriteRows = needsFavorite ? await runtime.database.query(favoriteTable)
      .where({ library_id: context.libraryId, account_id: context.accountId }).whereIn("item_id", batch)
      .select("item_id", "starred_at", "updated_at") : [];
    for (const row of progressRows) states.set(String(row.item_id), {
      played: Number(row.played) === 1, positionTicks: Number(row.position_ticks ?? 0), favorite: false, updatedAt: row.updated_at,
    });
    for (const row of favoriteRows) {
      const id = String(row.item_id);
      states.set(id, { ...(states.get(id) ?? { played: false, positionTicks: 0, favorite: false }),
        favorite: Boolean(row.starred_at), starredAt: row.starred_at, updatedAt: row.updated_at });
    }
  }
  if (!needsProgress) return states;
  const seriesIds = items.filter((item) => item.itemType === "video.series").map((item) => item.id);
  const episodesBySeries = new Map<string, Set<string>>();
  for (let offset = 0; offset < seriesIds.length; offset += 300) {
    const relations = await runtime.database.query("media_relations as relation")
      .join("media_items as episode", "episode.id", "relation.child_item_id")
      .where({ "relation.library_id": context.libraryId, "relation.relation_type": "series_episode",
        "episode.library_id": context.libraryId, "episode.user_id": context.ownerUserId, "episode.item_type": "video.episode" })
      .whereNull("episode.deleted_at").whereIn("relation.parent_item_id", seriesIds.slice(offset, offset + 300))
      .select("relation.parent_item_id", "relation.child_item_id");
    for (const relation of relations) {
      const id = String(relation.parent_item_id);
      const episodes = episodesBySeries.get(id) ?? new Set<string>();
      episodes.add(String(relation.child_item_id));
      episodesBySeries.set(id, episodes);
    }
  }
  const episodeIds = [...new Set([...episodesBySeries.values()].flatMap((ids) => [...ids]))];
  const playedEpisodeIds = new Set<string>();
  for (let offset = 0; offset < episodeIds.length; offset += 300) {
    const rows = await runtime.database.query(progressTable)
      .where({ library_id: context.libraryId, account_id: context.accountId, played: 1 })
      .whereIn("item_id", episodeIds.slice(offset, offset + 300)).select("item_id");
    rows.forEach((row) => playedEpisodeIds.add(String(row.item_id)));
  }
  episodesBySeries.forEach((episodes, id) => states.set(id, {
    ...(states.get(id) ?? { played: false, positionTicks: 0, favorite: false }),
    played: [...episodes].every((episodeId) => playedEpisodeIds.has(episodeId)), positionTicks: 0,
  }));
  return states;
}
