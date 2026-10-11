import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { createStableId } from "../media/filename.js";
import { contentKey } from "./cms-adapter.js";
import type { CmsCatalogContentItem } from "./types.js";

type CatalogEpisode = CmsCatalogContentItem["episodes"][number];

interface EpisodeBatchInput {
  database: FlyCloudHelperDatabase;
  userId: string;
  libraryId: string;
  identityKey: string;
  generationId: string;
  content: CmsCatalogContentItem;
  metadata: Record<string, unknown>;
  /** 人工匹配继续使用既有仓储保护展示字段，并独立补齐源分类。 */
  upsertManualEpisode: (episode: CatalogEpisode, identityKey: string) => Promise<{ itemId: string; changed: boolean }>;
}

/** 多线路共用单集身份，沿用第一次出现的名称与集序，不由后续线路覆盖。 */
function uniqueEpisodes(content: CmsCatalogContentItem): CatalogEpisode[] {
  const episodes = new Map<string, CatalogEpisode>();
  for (const episode of content.episodes) if (!episodes.has(episode.episodeKey)) episodes.set(episode.episodeKey, episode);
  return [...episodes.values()];
}

/** 对比源分集展示字段，generation 和扫描时间不单独触发目录增量。 */
function episodeChanged(previous: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  if (!previous || previous.deleted_at !== null) return true;
  const fields = ["media_type", "item_type", "region_group", "title", "sort_title", "subtitle", "overview", "match_state", "external_ids_json", "metadata_json"];
  if (fields.some((field) => String(previous[field] ?? "") !== String(payload[field] ?? ""))) return true;
  if ((previous.year == null ? null : Number(previous.year)) !== payload.year) return true;
  return ["premiere_date", "poster_url", "backdrop_url"].some((field) => String(previous[field] ?? "") !== String(payload[field] ?? ""));
}

/** 源节目完整保存分集；每批只读取一次旧数据并写入一次，人工条目不进入批量覆盖。 */
export async function persistCmsEpisodes(input: EpisodeBatchInput): Promise<{ itemIdsByEpisodeKey: Map<string, string>; changedIds: string[] }> {
  const { database, userId, libraryId, identityKey, generationId, content, metadata } = input;
  const selectedEpisodes = uniqueEpisodes(content);
  const itemIdsByEpisodeKey = new Map<string, string>();
  const changedIds = new Set<string>();
  // 关键变量：每行约二十余个绑定参数，25 行兼容 SQLite 默认参数限制。
  for (let offset = 0; offset < selectedEpisodes.length; offset += 25) {
    const episodes = selectedEpisodes.slice(offset, offset + 25);
    const identities = episodes.map((episode) => `${identityKey}:${contentKey(episode.episodeKey)}`);
    const manualEpisodes = await database.query.transaction(async (transaction) => {
      const query = transaction("media_items").where({ user_id: userId, library_id: libraryId }).whereIn("identity_key", identities);
      if (database.databaseType !== "sqlite") query.forUpdate();
      const previousRows = await query;
      const previousByIdentity = new Map(previousRows.map((row) => [String(row.identity_key), row as Record<string, unknown>]));
      const rows: Array<Record<string, unknown>> = [];
      const manual: Array<{ episode: CatalogEpisode; identity: string }> = [];
      const now = new Date().toISOString();
      for (const [index, episode] of episodes.entries()) {
        const identity = identities[index]!;
        const previous = previousByIdentity.get(identity);
        const manualMatch = previous ? parseJsonObject(previous.metadata_json).manualMatch : undefined;
        if (manualMatch && typeof manualMatch === "object" && !Array.isArray(manualMatch) && Object.keys(manualMatch).length > 0) {
          manual.push({ episode, identity });
          continue;
        }
        const itemId = previous ? String(previous.id) : createStableId("itm", libraryId, identity);
        const payload = {
          id: itemId, user_id: userId, service_id: null, library_id: libraryId, identity_key: identity,
          media_type: "video", item_type: "video.episode", region_group: "other",
          title: episode.name, sort_title: episode.name, subtitle: content.title, year: content.year,
          premiere_date: null, overview: content.overview, poster_url: content.posterUrl, backdrop_url: null,
          match_state: "matched", external_ids_json: "{}",
          metadata_json: JSON.stringify({ ...metadata, seriesTitle: content.title, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber }),
          generation_id: generationId, created_at: previous?.created_at ?? now, updated_at: now, deleted_at: null,
        };
        rows.push(payload);
        itemIdsByEpisodeKey.set(episode.episodeKey, itemId);
        if (episodeChanged(previous, payload)) changedIds.add(itemId);
      }
      if (rows.length) await transaction("media_items").insert(rows).onConflict(["user_id", "library_id", "identity_key"]).merge([
        "media_type", "item_type", "region_group", "title", "sort_title", "subtitle", "year", "premiere_date", "overview", "poster_url", "backdrop_url",
        "match_state", "external_ids_json", "metadata_json", "generation_id", "updated_at", "deleted_at",
      ]);
      return manual;
    });
    for (const { episode, identity } of manualEpisodes) {
      const child = await input.upsertManualEpisode(episode, identity);
      itemIdsByEpisodeKey.set(episode.episodeKey, child.itemId);
      if (child.changed) changedIds.add(child.itemId);
    }
  }
  return { itemIdsByEpisodeKey, changedIds: [...changedIds] };
}

/** 批量建立节目关系；只有真实新增单集时才按既有规则取消整剧已观看，已有关系不会清进度。 */
export async function persistCmsEpisodeRelations(input: {
  database: FlyCloudHelperDatabase;
  userId: string;
  libraryId: string;
  parentItemId: string;
  content: CmsCatalogContentItem;
  itemIdsByEpisodeKey: Map<string, string>;
}): Promise<void> {
  const { database, userId, libraryId, parentItemId, content, itemIdsByEpisodeKey } = input;
  const episodes = uniqueEpisodes(content);
  // 关系和整剧状态放在同一事务，失败时不会留下“关系已新增但已观看未取消”的半完成状态。
  await database.query.transaction(async (transaction) => {
    let addedEpisode = false;
    for (let offset = 0; offset < episodes.length; offset += 100) {
      const batch = episodes.slice(offset, offset + 100);
      const childIds = batch.map((episode) => itemIdsByEpisodeKey.get(episode.episodeKey)!);
      const existing = await transaction("media_relations").select("child_item_id", "sort_order")
        .where({ user_id: userId, library_id: libraryId, parent_item_id: parentItemId, relation_type: "series_episode" }).whereIn("child_item_id", childIds);
      const previousByChild = new Map(existing.map((row) => [String(row.child_item_id), Number(row.sort_order)]));
      const rows = batch.flatMap((episode) => {
        const childItemId = itemIdsByEpisodeKey.get(episode.episodeKey)!;
        const sortOrder = episode.seasonNumber * 100000 + episode.episodeNumber;
        if (!previousByChild.has(childItemId)) addedEpisode = true;
        if (previousByChild.get(childItemId) === sortOrder) return [];
        return [{ id: randomUUID(), user_id: userId, library_id: libraryId, parent_item_id: parentItemId, child_item_id: childItemId, relation_type: "series_episode", sort_order: sortOrder }];
      });
      await transaction("media_relations").where({ user_id: userId, library_id: libraryId, relation_type: "series_episode" })
        .whereIn("child_item_id", childIds).whereNot({ parent_item_id: parentItemId }).delete();
      if (rows.length) await transaction("media_relations").insert(rows).onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge(["sort_order"]);
    }
    if (!addedEpisode) return;
    const now = new Date().toISOString();
    for (const table of ["library_playback_progress", "library_emby_playback_progress"]) {
      await transaction(table).where({ library_id: libraryId, item_id: parentItemId, played: 1 })
        .update({ played: 0, position_ticks: 0, hidden_from_resume: 0, play_count: 0, last_played_at: null, updated_at: now });
    }
  });
}
