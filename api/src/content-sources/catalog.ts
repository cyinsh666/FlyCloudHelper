import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "../database.js";
import type { ServiceRepository } from "../service-repository.js";
import { createStableId } from "../media/filename.js";
import { contentKey } from "./cms-adapter.js";
import { persistCmsEpisodeRelations, persistCmsEpisodes } from "./catalog-batch.js";
import { completeContentMetadata, persistContentCard, refreshManuallyMatchedSourceMetadata } from "./catalog-card.js";
import type { CmsCatalogContentItem, ContentSourceCategory, ContentSourceManifest } from "./types.js";

/** 检查分类及其祖先是否匹配清单中指定的父分类。 */
export function categoryMatches(categoryId: string, targetIds: string[], categories: ContentSourceCategory[]): boolean {
  const visited = new Set<string>();
  let current: string | null = categoryId;
  while (current && !visited.has(current)) {
    if (targetIds.includes(current)) return true;
    visited.add(current);
    current = categories.find((category) => category.id === current)?.parentId ?? null;
  }
  return false;
}

/** 只使用源站明确提供的地区文字生成已有视频地区字段。 */
function originCountries(area: string): string[] {
  const mappings: Record<string, string> = { 中国大陆: "CN", 大陆: "CN", 香港: "HK", 中国香港: "HK", 台湾: "TW", 中国台湾: "TW", 日本: "JP", 韩国: "KR", 美国: "US", 英国: "GB", 法国: "FR", 德国: "DE", 泰国: "TH" };
  return area.split(/[,，/]/u).flatMap((name) => mappings[name.trim()] ? [mappings[name.trim()]!] : []);
}

/** 持久化单条内容及其精确播放定位，不创建不存在的网盘文件记录。 */
export async function persistCmsContent(input: {
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  userId: string;
  libraryId: string;
  instanceId: string;
  manifest: ContentSourceManifest;
  categories: ContentSourceCategory[];
  content: CmsCatalogContentItem;
}): Promise<string[]> {
  const { database, repository, userId, libraryId, instanceId, content, categories, manifest } = input;
  if (categoryMatches(content.categoryId, manifest.excludedCategoryIds ?? [], categories)) return [];
  const movie = categoryMatches(content.categoryId, manifest.movieCategoryIds, categories)
    || Boolean(content.parentCategoryId && manifest.movieCategoryIds.includes(content.parentCategoryId));
  const identityKey = `content:${instanceId}:${contentKey(content.id)}`;
  const generationId = randomUUID(); // 关键变量：刷新单条身份；仅完整详情路径用它淘汰该条目的过期播放线路。
  // 关键变量：分类身份供协议入口筛选，电影/节目/单集共用，不参与稳定媒体 ID。
  const category = categories.find((item) => item.id === content.categoryId);
  const contentSource: Record<string, unknown> = { instanceId, remoteItemId: content.id, categoryId: content.categoryId, categoryName: content.categoryName || category?.name || "", parentCategoryId: content.parentCategoryId ?? category?.parentId ?? null };
  const supportsCards = manifest.adapter === "python_spider" || manifest.adapter === "cms_json";
  if (supportsCards && content.detailState === "card") {
    const countries = originCountries(content.area); // 摘要和完整详情沿用同一份明确地区转换。
    return persistContentCard({ database, repository, userId, libraryId, identityKey, generationId, movie, content, contentSource,
      metadata: { originCountries: countries, productionCountries: countries } });
  }
  // 空详情不创建虚构分集，也不能把尚未补齐的卡片标记为完成。
  if (content.episodes.length === 0) return [];
  if (supportsCards) {
    // 完成标记在末尾统一提交；本轮中途失败时，下一次详情仍需重新补齐。
    contentSource.detailState = "card";
  }
  const genres = [...new Set([...content.genres, ...(content.categoryName.includes("动漫") ? ["动画"] : [])])];
  const metadata: Record<string, unknown> = {
    contentSource,
    genres, originCountries: originCountries(content.area), productionCountries: originCountries(content.area),
    // 源评分和标签供标准协议展示与本地筛选，缺失数据不从分类名称推断。
    rating: content.rating ?? 0, tags: content.tags ?? [],
    people: [...content.actors.map((name) => ({ name, type: "cast" })), ...content.directors.map((name) => ({ name, type: "director" }))],
  };
  const common = {
    userId, serviceId: null, libraryId, mediaType: "video" as const,
    year: content.year, overview: content.overview, posterUrl: content.posterUrl, backdropUrl: null,
    matchState: "matched" as const, externalIds: {}, generationId,
  };
  const parent = await repository.upsertMediaItem({
    ...common, id: createStableId("itm", libraryId, identityKey), identityKey,
    itemType: movie ? "video.movie" : "video.series", title: content.title, sortTitle: content.title, subtitle: "", metadata,
  });
  const parentCategoryChanged = parent.hasManualMatch && await refreshManuallyMatchedSourceMetadata(database, userId, libraryId, parent.itemId, contentSource);
  const changedIds = new Set<string>(parent.changed || parentCategoryChanged ? [parent.itemId] : []);
  let episodeItems = new Map<string, string>();
  if (!movie) {
    const children = await persistCmsEpisodes({ database, userId, libraryId, identityKey, generationId, content, metadata,
      /** 人工分集仍走仓储原处理，批量写入不会覆盖人工字段。 */
      upsertManualEpisode: async (episode, episodeIdentityKey) => {
        const child = await repository.upsertMediaItem({
          ...common, id: createStableId("itm", libraryId, episodeIdentityKey), identityKey: episodeIdentityKey,
          itemType: "video.episode", title: episode.name, sortTitle: episode.name, subtitle: content.title,
          metadata: { ...metadata, seriesTitle: content.title, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber },
        });
        const childCategoryChanged = child.hasManualMatch && await refreshManuallyMatchedSourceMetadata(database, userId, libraryId, child.itemId, contentSource);
        return { itemId: child.itemId, changed: child.changed || Boolean(childCategoryChanged) };
      },
    });
    episodeItems = children.itemIdsByEpisodeKey;
    for (const itemId of children.changedIds) changedIds.add(itemId);
    if (parent.hasManualMatch) {
      const linkedKeys = new Set<string>();
      for (const episode of content.episodes) {
        if (linkedKeys.has(episode.episodeKey)) continue;
        linkedKeys.add(episode.episodeKey);
        await repository.linkMediaRelation({
          userId, libraryId, parentItemId: parent.itemId, childItemId: episodeItems.get(episode.episodeKey)!,
          relationType: "series_episode", sortOrder: episode.seasonNumber * 100000 + episode.episodeNumber,
          parentItemType: "video.series", parentHasManualMatch: parent.hasManualMatch,
        });
      }
    } else {
      await persistCmsEpisodeRelations({ database, userId, libraryId, parentItemId: parent.itemId, content, itemIdsByEpisodeKey: episodeItems });
    }
  }
  // 关键变量：一次读齐旧定位，避免每个分集、每条线路都发生独立数据库往返。
  const previousSources = await database.query("content_playback_sources").where({ user_id: userId, library_id: libraryId, instance_id: instanceId, remote_item_id: content.id });
  const previousById = new Map(previousSources.map((source) => [String(source.id), source]));
  const sourceRows: Array<Record<string, unknown>> = [];
  for (const [index, episode] of content.episodes.entries()) {
    const itemId = movie ? parent.itemId : episodeItems.get(episode.episodeKey)!;
    const lineKey = contentKey(episode.lineName);
    const sourceId = createStableId("cps", libraryId, instanceId, content.id, lineKey, episode.episodeKey);
    const previous = previousById.get(sourceId);
    const payload = {
      user_id: userId, library_id: libraryId, item_id: itemId, instance_id: instanceId,
      remote_item_id: content.id, line_key: lineKey, line_name: episode.lineName,
      episode_key: episode.episodeKey, name: episode.name, container: episode.container,
      sort_order: index, status: "active", generation_id: generationId, updated_at: new Date().toISOString(),
    };
    sourceRows.push({ id: sourceId, runtime_ticks: 0, ...payload });
    if (!previous || previous.status !== "active" || previous.item_id !== itemId || previous.container !== episode.container || previous.name !== episode.name) changedIds.add(itemId);
  }
  // 每批 50 行控制 SQLite 参数数量，merge 不包含实际探测时长，保留已经取得的 runtime_ticks。
  for (let offset = 0; offset < sourceRows.length; offset += 50) {
    await database.query("content_playback_sources").insert(sourceRows.slice(offset, offset + 50)).onConflict("id").merge([
      "user_id", "library_id", "item_id", "instance_id", "remote_item_id", "line_key", "line_name", "episode_key", "name", "container", "sort_order", "status", "generation_id", "updated_at",
    ]);
  }
  const staleSources = await database.query("content_playback_sources")
    .distinct("item_id").where({ library_id: libraryId, instance_id: instanceId, remote_item_id: content.id, status: "active" })
    .whereNot({ generation_id: generationId });
  await database.query("content_playback_sources")
    .where({ library_id: libraryId, instance_id: instanceId, remote_item_id: content.id, status: "active" })
    .whereNot({ generation_id: generationId }).update({ status: "unavailable", updated_at: new Date().toISOString() });
  const staleItemIds = staleSources.map((source) => String(source.item_id));
  for (const itemId of staleItemIds) changedIds.add(itemId);
  // 多条旧线路只检查一次对应分集，没有任何活动定位的旧分集才删除目录关系。
  for (let offset = 0; offset < staleItemIds.length; offset += 100) {
    const batch = staleItemIds.slice(offset, offset + 100);
    const available = await database.query("content_playback_sources").distinct("item_id")
      .where({ user_id: userId, library_id: libraryId, status: "active" }).whereIn("item_id", batch);
    const availableIds = new Set(available.map((source) => String(source.item_id)));
    const deletedIds = batch.filter((itemId) => itemId !== parent.itemId && !availableIds.has(itemId));
    if (!deletedIds.length) continue;
    const now = new Date().toISOString();
    await database.query("media_items").where({ user_id: userId, library_id: libraryId }).whereIn("id", deletedIds).update({ deleted_at: now, updated_at: now });
    await database.query("media_relations").where({ user_id: userId, library_id: libraryId }).whereIn("child_item_id", deletedIds).delete();
  }
  if (supportsCards) {
    const completedIds = await completeContentMetadata({ database, userId, libraryId,
      itemIds: [parent.itemId, ...episodeItems.values()], contentSource });
    for (const itemId of completedIds) changedIds.add(itemId);
  }
  if (changedIds.size > 0) {
    changedIds.add(parent.itemId);
    await repository.publishContentSourceCatalogChanges(userId, libraryId, [...changedIds]);
  }
  return [...changedIds];
}
