import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { createStableId } from "../media/filename.js";
import type { ServiceRepository } from "../service-repository.js";
import type { NeteaseAlbum, NeteaseArtist, NeteaseSong } from "./netease-adapter.js";

/** 音乐实体的远端种类参与身份，防止同号歌曲、专辑和艺术家互相覆盖。 */
export type ContentMusicRemoteKind = "artist" | "album" | "song";

/** 目录 ID 只依赖库、实例、实体种类和网易 ID，搜索词、标题和临时地址不参与。 */
export function contentMusicItemId(libraryId: string, instanceId: string, kind: ContentMusicRemoteKind, remoteId: string): string {
  return createStableId("itm", libraryId, `content-music:${instanceId}:netease:${kind}:${remoteId}`);
}

/** 一次源目录结果共用归属和生命周期检查，不涉及网盘文件表。 */
interface MusicCatalogInput {
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  userId: string;
  libraryId: string;
  instanceId: string;
  artists?: NeteaseArtist[];
  albums?: NeteaseAlbum[];
  songs?: NeteaseSong[];
  /** 艺术家的专辑目录成功取全后才标记已加载。 */
  loadedArtistIds?: string[];
  /** 每个实体写入前复查库、实例和插件状态，停用或清空不能继续回填。 */
  beforeWrite: () => Promise<void>;
}

/** 取出已存源定位，人工元数据仍通过既有仓储保护。 */
function previousSource(metadata: Record<string, unknown>): Record<string, unknown> {
  const source = metadata.contentSource;
  return source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
}

/** 去掉简略搜索结果中的空值，避免覆盖已取得的专辑说明、日期和音频资料。 */
function meaningfulFields(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== 0 && (!Array.isArray(value) || value.length > 0)));
}

/** 建立音乐实体和真实关系；所有 ID 和查询都限定在当前用户、媒体库及源实例。 */
export async function persistContentMusic(input: MusicCatalogInput): Promise<{ artistIds: string[]; albumIds: string[]; songIds: string[] }> {
  const { database, repository, userId, libraryId, instanceId } = input;
  const generationId = randomUUID(); // 关键变量：沿用目录写入标记，不执行网盘扫描的缺失对账或孤儿清理。
  const artists = new Map<string, NeteaseArtist>();
  const albums = new Map<string, NeteaseAlbum>();
  const songs = new Map<string, NeteaseSong>();
  for (const song of input.songs ?? []) {
    songs.set(song.id, song);
    for (const artist of song.artists) artists.set(artist.id, artist);
    if (song.album) albums.set(song.album.id, song.album);
  }
  // 明确请求的专辑、艺术家详情优先于歌曲里附带的简略快照。
  for (const album of input.albums ?? []) albums.set(album.id, album);
  for (const album of albums.values()) for (const artist of album.artists) artists.set(artist.id, artist);
  for (const artist of input.artists ?? []) artists.set(artist.id, artist);
  const changedIds = new Set<string>();

  /** 使用既有 upsert 和目录增量机制，保留源详情及人工匹配字段。 */
  const upsert = async (kind: ContentMusicRemoteKind, remoteId: string, title: string, subtitle: string, artwork: string | null, overview: string, year: number | null, metadata: Record<string, unknown>, detailsLoaded: boolean): Promise<string> => {
    await input.beforeWrite();
    const identityKey = `content-music:${instanceId}:netease:${kind}:${remoteId}`;
    const previous = await database.query("media_items").select("metadata_json", "title", "sort_title", "subtitle", "year", "overview", "poster_url").where({ user_id: userId, library_id: libraryId, identity_key: identityKey }).first();
    const previousMetadata = parseJsonObject(previous?.metadata_json);
    const source = previousSource(previousMetadata);
    const contentSource = { ...source, instanceId, remoteItemId: remoteId, remoteKind: kind, detailsLoaded: detailsLoaded || source.detailsLoaded === true };
    // 关键变量：已取得完整详情后，搜索或歌曲附带的简略快照只补缺失字段，不降级目录资料。
    const partialSnapshot = source.detailsLoaded === true && !detailsLoaded;
    const mergedMetadata = partialSnapshot ? { ...meaningfulFields(metadata), ...previousMetadata, contentSource } : { ...previousMetadata, ...meaningfulFields(metadata), contentSource };
    const result = await repository.upsertMediaItem({
      id: contentMusicItemId(libraryId, instanceId, kind, remoteId), userId, serviceId: null, libraryId, identityKey,
      mediaType: "music", itemType: kind === "song" ? "music.track" : `music.${kind}`,
      title: partialSnapshot && previous?.title ? String(previous.title) : title,
      sortTitle: partialSnapshot && previous?.sort_title ? String(previous.sort_title) : title,
      subtitle: partialSnapshot && previous?.subtitle ? String(previous.subtitle) : subtitle || String(previous?.subtitle ?? ""),
      year: partialSnapshot && previous?.year != null ? Number(previous.year) : year ?? (previous?.year == null ? null : Number(previous.year)),
      overview: partialSnapshot && previous?.overview ? String(previous.overview) : overview || String(previous?.overview ?? ""),
      posterUrl: partialSnapshot && previous?.poster_url ? String(previous.poster_url) : artwork || (previous?.poster_url ? String(previous.poster_url) : null), backdropUrl: null,
      matchState: "matched", externalIds: { netease: remoteId }, generationId,
      metadata: mergedMetadata,
    });
    if (result.changed) changedIds.add(result.itemId);
    return result.itemId;
  };

  for (const artist of artists.values()) {
    await upsert("artist", artist.id, artist.name, "", artist.artwork, artist.description, null, { albumCount: artist.albumCount }, input.loadedArtistIds?.includes(artist.id) === true);
  }
  for (const album of albums.values()) {
    const artistNames = album.artists.map((artist) => artist.name);
    const albumDurationMs = album.detailsLoaded ? [...songs.values()].filter((song) => song.album?.id === album.id).reduce((duration, song) => duration + song.durationMs, 0) : 0;
    await upsert("album", album.id, album.name, artistNames.join(" / "), album.artwork, album.description,
      album.publishedAt ? new Date(album.publishedAt).getUTCFullYear() : null,
      { album: album.name, albumArtist: artistNames.join(" / "), albumArtists: artistNames, songCount: album.songCount, albumDurationMs, premiereDate: album.publishedAt }, album.detailsLoaded);
  }
  for (const song of songs.values()) {
    const artistNames = song.artists.map((artist) => artist.name);
    const albumArtistNames = song.album?.artists.map((artist) => artist.name) ?? [];
    await upsert("song", song.id, song.name, artistNames.join(" / "), song.album?.artwork ?? null, "",
      song.album?.publishedAt ? new Date(song.album.publishedAt).getUTCFullYear() : null,
      { artist: artistNames.join(" / "), artists: artistNames, album: song.album?.name ?? "", albumArtist: albumArtistNames.join(" / "), albumArtists: albumArtistNames,
        durationMs: song.durationMs, trackNumber: song.trackNumber, discNumber: song.discNumber,
        audioContainer: song.suffix, audioBitRate: song.bitRate, audioSize: song.size, premiereDate: song.album?.publishedAt }, song.detailsLoaded);
  }

  /** 多艺术家关系直接写已有关系表，不能使用单父关系方法删掉合作艺术家。 */
  const linkArtists = async (kind: "album" | "song", remoteId: string, entities: NeteaseArtist[], replace: boolean): Promise<void> => {
    const childItemId = contentMusicItemId(libraryId, instanceId, kind, remoteId);
    const parentIds = entities.map((artist) => contentMusicItemId(libraryId, instanceId, "artist", artist.id));
    const relationType = kind === "album" ? "artist_album" : "artist_track";
    await input.beforeWrite();
    const previous = await database.query("media_relations").select("parent_item_id", "sort_order").where({ user_id: userId, library_id: libraryId, child_item_id: childItemId, relation_type: relationType }).orderBy("sort_order", "asc");
    // 简略结果不能把合作艺术家变成主艺术家，新增关系排在既有关系后面。
    let nextSortOrder = previous.reduce((next, row) => Math.max(next, Number(row.sort_order) + 1), 0);
    if (replace && parentIds.length) {
      await database.query("media_relations").where({ user_id: userId, library_id: libraryId, child_item_id: childItemId, relation_type: relationType }).whereNotIn("parent_item_id", parentIds).delete();
    }
    for (const [index, parentItemId] of parentIds.entries()) {
      const previousRelation = previous.find((row) => String(row.parent_item_id) === parentItemId);
      const sortOrder = replace ? index : previousRelation ? Number(previousRelation.sort_order) : nextSortOrder++;
      await database.query("media_relations").insert({ id: randomUUID(), user_id: userId, library_id: libraryId, parent_item_id: parentItemId, child_item_id: childItemId, relation_type: relationType, sort_order: sortOrder })
        .onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge({ sort_order: sortOrder });
      if (!previousRelation || Number(previousRelation.sort_order) !== sortOrder) {
        changedIds.add(parentItemId);
        changedIds.add(childItemId);
      }
    }
    if (replace) for (const row of previous) if (parentIds.length && !parentIds.includes(String(row.parent_item_id))) { changedIds.add(String(row.parent_item_id)); changedIds.add(childItemId); }
  };

  for (const album of albums.values()) await linkArtists("album", album.id, album.artists, album.detailsLoaded);
  for (const song of songs.values()) {
    await linkArtists("song", song.id, song.artists, song.detailsLoaded);
    if (!song.album) continue;
    await input.beforeWrite();
    const albumItemId = contentMusicItemId(libraryId, instanceId, "album", song.album.id);
    const songItemId = contentMusicItemId(libraryId, instanceId, "song", song.id);
    const previous = await database.query("media_relations").select("parent_item_id", "sort_order").where({ user_id: userId, library_id: libraryId, child_item_id: songItemId, relation_type: "album_track" }).first();
    // 搜索及未提供曲序的歌单结果保留已知专辑曲序，完整专辑详情才能重排。
    const preserveOrder = previous && String(previous.parent_item_id) === albumItemId && (!song.detailsLoaded || song.trackNumber === 0);
    const sortOrder = preserveOrder ? Number(previous.sort_order) : song.discNumber * 100000 + song.trackNumber;
    await repository.linkMediaRelation({ userId, libraryId, parentItemId: albumItemId, childItemId: songItemId, relationType: "album_track", sortOrder, parentItemType: "music.album", parentHasManualMatch: false });
    if (!previous || String(previous.parent_item_id) !== albumItemId || Number(previous.sort_order) !== sortOrder) {
      changedIds.add(albumItemId);
      changedIds.add(songItemId);
      if (previous) changedIds.add(String(previous.parent_item_id));
    }
  }
  if (changedIds.size) {
    await input.beforeWrite();
    await repository.publishContentSourceCatalogChanges(userId, libraryId, [...changedIds]);
  }
  return {
    artistIds: (input.artists ?? []).map((artist) => contentMusicItemId(libraryId, instanceId, "artist", artist.id)),
    albumIds: (input.albums ?? []).map((album) => contentMusicItemId(libraryId, instanceId, "album", album.id)),
    songIds: (input.songs ?? []).map((song) => contentMusicItemId(libraryId, instanceId, "song", song.id)),
  };
}
