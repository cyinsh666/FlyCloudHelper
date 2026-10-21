import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { createStableId } from "../media/filename.js";
import { readVideoRegionGroup, type ServiceRepository } from "../service-repository.js";
import type { CmsCatalogContentItem } from "./types.js";

/** 人工匹配保留展示元数据，但源定位及详情状态仍需独立补齐。 */
export async function refreshManuallyMatchedSourceMetadata(database: FlyCloudHelperDatabase, userId: string, libraryId: string, itemId: string, contentSource: Record<string, unknown>): Promise<boolean> {
  return database.query.transaction(async (transaction) => {
    const query = transaction("media_items").where({ id: itemId, user_id: userId, library_id: libraryId });
    if (database.databaseType !== "sqlite") query.forUpdate();
    const item = await query.first();
    if (!item) return false;
    const previousMetadata = parseJsonObject(item.metadata_json);
    const previousSource = readContentSource(previousMetadata);
    const metadataJson = JSON.stringify({ ...previousMetadata, contentSource: { ...previousSource, ...contentSource } });
    if (metadataJson === item.metadata_json) return false;
    await transaction("media_items").where({ id: itemId, user_id: userId, library_id: libraryId }).update({ metadata_json: metadataJson, updated_at: new Date().toISOString() });
    return true;
  });
}

/** 只读取已有源元数据对象，不使用卡片的空字段代替完整详情。 */
function readContentSource(metadata: Record<string, unknown>): Record<string, unknown> {
  const source = metadata.contentSource;
  return source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
}

/** 完整分集、关系及播放定位全部成功后，统一提交完成标记，失败不能留下新鲜的半成品详情。 */
export async function completeContentMetadata(input: {
  database: FlyCloudHelperDatabase;
  userId: string;
  libraryId: string;
  itemIds: string[];
  contentSource: Record<string, unknown>;
}): Promise<string[]> {
  const { database, userId, libraryId, contentSource } = input;
  const itemIds = [...new Set(input.itemIds)];
  const completedAt = new Date().toISOString(); // 同一部影片及其当前分集共用本次完整写入的时间。
  return database.query.transaction(async (transaction) => {
    const changedIds: string[] = [];
    for (let offset = 0; offset < itemIds.length; offset += 25) {
      const query = transaction("media_items").select("id", "metadata_json")
        .where({ user_id: userId, library_id: libraryId }).whereIn("id", itemIds.slice(offset, offset + 25)).whereNull("deleted_at");
      if (database.databaseType !== "sqlite") query.forUpdate();
      const rows = await query;
      const bindings: string[] = ["id"];
      const branches: string[] = [];
      const batchIds: string[] = [];
      for (const row of rows) {
        const metadata = parseJsonObject(row.metadata_json);
        const source = readContentSource(metadata);
        const metadataJson = JSON.stringify({ ...metadata, contentSource: { ...source, ...contentSource, detailState: "complete", detailUpdatedAt: completedAt } });
        if (metadataJson === row.metadata_json) continue;
        const itemId = String(row.id);
        branches.push("WHEN ? THEN ?");
        bindings.push(itemId, metadataJson);
        batchIds.push(itemId);
      }
      if (!batchIds.length) continue;
      bindings.push("metadata_json");
      // 一次更新一批完成标记；仅修改元数据及时间，不重写人工展示或复活已删除分集。
      await transaction("media_items").where({ user_id: userId, library_id: libraryId }).whereIn("id", batchIds)
        .update({ metadata_json: transaction.raw(`CASE ?? ${branches.join(" ")} ELSE ?? END`, bindings), updated_at: completedAt });
      changedIds.push(...batchIds);
    }
    return changedIds;
  });
}

/** 摘要只保存源明确提供的风格、评分、标签和人物，空值不能清掉已知资料。 */
function cardDisplayMetadata(content: CmsCatalogContentItem): Record<string, unknown> {
  const genres = [...new Set([...content.genres, ...(content.categoryName.includes("动漫") ? ["动画"] : [])])];
  const people = [...content.actors.map((name) => ({ name, type: "cast" })), ...content.directors.map((name) => ({ name, type: "director" }))];
  const metadata: Record<string, unknown> = {};
  if (genres.length) metadata.genres = genres;
  if (typeof content.rating === "number" && content.rating > 0 && content.rating <= 10) metadata.rating = content.rating;
  if (content.tags?.length) metadata.tags = content.tags;
  if (people.length) metadata.people = people;
  return metadata;
}

/** 完整详情的已有字段优先；仍为摘要时仅合并本次实际提供的非空资料。 */
function mergeCardDisplayMetadata(previous: Record<string, unknown>, card: Record<string, unknown>, preserveCompleteFields: boolean): Record<string, unknown> {
  const metadata = { ...previous };
  for (const [field, value] of Object.entries(card)) {
    const previousValue = previous[field];
    const missing = previousValue === undefined || previousValue === null || previousValue === "" || previousValue === 0
      || Array.isArray(previousValue) && previousValue.length === 0;
    if (!preserveCompleteFields || missing) metadata[field] = value;
  }
  return metadata;
}

/** CMS JSON 和 Python 列表卡片仅建立影片身份与摘要，已有分集、线路及用户数据完全沿用。 */
export async function persistContentCard(input: {
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  userId: string;
  libraryId: string;
  identityKey: string;
  generationId: string;
  movie: boolean;
  content: CmsCatalogContentItem;
  contentSource: Record<string, unknown>;
  /** 沿用完整目录的源地区字段，不从分类或标题猜测国家。 */
  metadata?: Record<string, unknown>;
}): Promise<string[]> {
  const { database, repository, userId, libraryId, identityKey, generationId, movie, content } = input;
  const cardMetadata = cardDisplayMetadata(content);
  for (const field of ["originCountries", "productionCountries"]) {
    const value = input.metadata?.[field];
    if (Array.isArray(value) && value.length) cardMetadata[field] = value;
  }
  const existing = await database.query.transaction(async (transaction) => {
    const query = transaction("media_items").where({ user_id: userId, library_id: libraryId, identity_key: identityKey });
    if (database.databaseType !== "sqlite") query.forUpdate();
    const previous = await query.first();
    if (!previous) return null;
    const previousMetadata = parseJsonObject(previous.metadata_json);
    const previousSource = readContentSource(previousMetadata);
    const manualMatch = previousMetadata.manualMatch;
    const hasManualMatch = Boolean(manualMatch && typeof manualMatch === "object" && !Array.isArray(manualMatch) && Object.keys(manualMatch).length > 0);
    // 关键变量：旧完整条目和待重新补齐的完整条目均保留展示；未知旧标记也不能降级资料。
    const preserveCompleteFields = previousSource.detailState !== "card" || typeof previousSource.detailUpdatedAt === "string";
    const contentSource = { ...previousSource, ...input.contentSource };
    if (previousSource.detailState === "card") contentSource.detailState = "card";
    if (previous.deleted_at != null && previousSource.detailState === "complete") {
      const activeSource = await transaction("content_playback_sources").select("id")
        .where({ user_id: userId, library_id: libraryId, instance_id: String(contentSource.instanceId), remote_item_id: content.id, status: "active" }).first();
      // 恢复父卡片不能顺带复活旧分集；没有有效线路时交给详情入口重新验证，原展示仍保留。
      if (!activeSource) contentSource.detailState = "card";
    }
    const previousYear = previous.year == null ? null : Number(previous.year);
    const previousPoster = previous.poster_url ? String(previous.poster_url) : null;
    const title = preserveCompleteFields && previous.title ? String(previous.title) : content.title;
    const displayMetadata = hasManualMatch ? previousMetadata : mergeCardDisplayMetadata(previousMetadata, cardMetadata, preserveCompleteFields);
    const payload: Record<string, unknown> = { metadata_json: JSON.stringify({ ...displayMetadata, contentSource }) };
    if (!hasManualMatch) {
      payload.title = title;
      payload.sort_title = preserveCompleteFields && previous.sort_title ? String(previous.sort_title) : title;
      payload.year = preserveCompleteFields && previousYear !== null ? previousYear : content.year ?? previousYear;
      payload.poster_url = preserveCompleteFields && previousPoster ? previousPoster : content.posterUrl || previousPoster;
      // 关键变量：列表可补充源实际提供的横图，缺少横图的摘要不能清空已有背景。
      if (content.backdropUrl) payload.backdrop_url = preserveCompleteFields && previous.backdrop_url ? previous.backdrop_url : content.backdropUrl;
      if (content.overview) payload.overview = preserveCompleteFields && previous.overview ? String(previous.overview) : content.overview;
      if (JSON.stringify(displayMetadata.originCountries ?? []) !== JSON.stringify(previousMetadata.originCountries ?? [])) {
        // 摘要更新或补齐地区时复用原仓储派生；完整已知地区和人工分组继续保留。
        payload.region_group = readVideoRegionGroup(String(previous.item_type), displayMetadata);
      }
    }
    // 关键变量：只列出真正变化的父卡片字段，相同列表不写 metadata、时间戳或目录增量。
    const changes: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(payload)) {
      const previousValue = field === "year" ? previousYear : previous[field];
      if (previousValue !== value) changes[field] = value;
    }
    if (previous.deleted_at != null) changes.deleted_at = null;
    const itemId = String(previous.id);
    if (!Object.keys(changes).length) return { itemId, changed: false };
    await transaction("media_items").where({ id: itemId, user_id: userId, library_id: libraryId })
      .update({ ...changes, generation_id: generationId, updated_at: new Date().toISOString() });
    return { itemId, changed: true };
  });
  if (existing) {
    if (!existing.changed) return [];
    await repository.publishContentSourceCatalogChanges(userId, libraryId, [existing.itemId]);
    return [existing.itemId];
  }
  // 新卡片继续走既有仓储创建身份；已有父条目不走人工剧集的分集恢复逻辑。
  const result = await repository.upsertMediaItem({
    id: createStableId("itm", libraryId, identityKey), userId, serviceId: null, libraryId, identityKey,
    mediaType: "video", itemType: movie ? "video.movie" : "video.series",
    title: content.title, sortTitle: content.title, subtitle: "", year: content.year, overview: content.overview,
    posterUrl: content.posterUrl, backdropUrl: content.backdropUrl ?? null, matchState: "matched", externalIds: {},
    metadata: { ...cardMetadata, contentSource: { ...input.contentSource, detailState: "card" } }, generationId,
  });
  if (!result.changed) return [];
  await repository.publishContentSourceCatalogChanges(userId, libraryId, [result.itemId]);
  return [result.itemId];
}
