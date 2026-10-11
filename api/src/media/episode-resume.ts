import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { parseJsonObject } from "../domain.js";

/** Jellyfin 和 Emby 各自保存续播记录，账号状态互不混用。 */
type EpisodeProgressTable = "library_playback_progress" | "library_emby_playback_progress";

interface EpisodeResumeContext {
  libraryId: string;
  accountId: string;
}

/** 单集完播时，在同一事务中为后续未观看单集准备续播入口。 */
export async function prepareNextEpisodeResume(
  transaction: Knex.Transaction,
  progressTable: EpisodeProgressTable,
  context: EpisodeResumeContext,
  completedItemId: string,
  now: string,
): Promise<void> {
  const relation = await transaction("media_relations")
    .where({ library_id: context.libraryId, child_item_id: completedItemId, relation_type: "series_episode" })
    .first();
  if (!relation) return;

  // 关键变量：只选择同一节目中未删除且有有效源文件的单集，避免出现无法播放的续播入口。
  const rows = await transaction("media_relations as relation")
    .join("media_items as episode", "episode.id", "relation.child_item_id")
    .join("file_links as link", "link.item_id", "episode.id")
    .join("source_files as file", "file.id", "link.source_file_id")
    .distinct("episode.id", "episode.metadata_json")
    .where({
      "relation.library_id": context.libraryId,
      "relation.parent_item_id": relation.parent_item_id,
      "relation.relation_type": "series_episode",
      "episode.library_id": context.libraryId,
      "episode.item_type": "video.episode",
      "file.status": "active",
    })
    .whereNull("episode.deleted_at");
  const episodes = rows.map((row) => ({
    id: String(row.id),
    metadata: parseJsonObject(row.metadata_json),
  })).sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
    || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0)
    || left.id.localeCompare(right.id));
  const completedIndex = episodes.findIndex((episode) => episode.id === completedItemId);
  if (completedIndex < 0 || completedIndex === episodes.length - 1) return;

  const followingEpisodes = episodes.slice(completedIndex + 1);
  const progressRows = await transaction(progressTable)
    .where({ library_id: context.libraryId, account_id: context.accountId })
    .whereIn("item_id", followingEpisodes.map((episode) => episode.id));
  const progressByItemId = new Map(progressRows.map((row) => [String(row.item_id), row]));
  // 关键变量：按季、集顺序向后寻找，跨季续播并跳过已经看完的单集，不回到前面漏看的集数。
  const nextEpisode = followingEpisodes.find((episode) => Number(progressByItemId.get(episode.id)?.played ?? 0) !== 1);
  if (!nextEpisode) return;
  const existingProgress = progressByItemId.get(nextEpisode.id);
  if (Number(existingProgress?.hidden_from_resume ?? 0) === 1) return;

  await transaction(progressTable).insert({
    id: randomUUID(),
    library_id: context.libraryId,
    account_id: context.accountId,
    item_id: nextEpisode.id,
    media_source_id: null,
    position_ticks: 0,
    played: 0,
    hidden_from_resume: 0,
    resume_pending: 1,
    play_count: 0,
    // 尚未实际播放下一集，不伪造其观看时间或播放历史。
    last_played_at: null,
    updated_at: now,
  }).onConflict(["library_id", "account_id", "item_id"]).ignore();
  // 下一集已有进度时只开启续播入口，保留其位置、播放次数、观看时间和所选媒体源。
  await transaction(progressTable)
    .where({ library_id: context.libraryId, account_id: context.accountId, item_id: nextEpisode.id, played: 0, hidden_from_resume: 0 })
    .update({ resume_pending: 1, updated_at: now });
}
