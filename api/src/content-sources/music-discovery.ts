import { createStableId } from "../media/filename.js";
import { neteaseRemoteId, type NeteasePlaylist } from "./netease-adapter.js";

/** 网易源歌单使用标准 Subsonic 摘要，与协议账号本地自建歌单分开管理。 */
export interface ContentMusicPlaylist {
  id: string;
  name: string;
  comment: string;
  owner: string;
  public: boolean;
  readonly: true;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  coverArt?: string;
}

/** 协议只检查源歌单前缀，实际归属和远端 ID 由宿主再次验证。 */
export function isContentMusicPlaylistId(id: string): boolean {
  return id.startsWith("npl_");
}

/** 歌单身份包含库和源实例，标题、推荐位置和排行顺序变化不会改变 ID。 */
export function contentMusicPlaylistId(libraryId: string, instanceId: string, remoteId: string): string {
  return `${createStableId("npl", libraryId, instanceId)}_${neteaseRemoteId(remoteId)}`;
}

/** 只接受当前库和实例的源歌单，不借用另一媒体库的 ID 请求网易目录。 */
export function contentMusicPlaylistRemoteId(libraryId: string, instanceId: string, id: string): string | null {
  const prefix = `${createStableId("npl", libraryId, instanceId)}_`;
  if (!id.startsWith(prefix)) return null;
  try { return neteaseRemoteId(id.slice(prefix.length)); } catch { return null; }
}

/** 源站及网易账号歌单按标准只读列表返回，未知时长保留零值，详情再给出实际时长。 */
export function mapContentMusicPlaylist(playlist: NeteasePlaylist, libraryId: string, instanceId: string, createdAt: string, fetchedAt: string): ContentMusicPlaylist {
  const id = contentMusicPlaylistId(libraryId, instanceId, playlist.id);
  const prefixes: Record<NeteasePlaylist["category"], string> = {
    recommended: "推荐歌单 · ", chart: "排行榜 · ", playlist: "网易歌单 · ", liked: "我喜欢的音乐 · ", created: "我的歌单 · ", collected: "收藏歌单 · ",
  };
  const accountPlaylist = ["liked", "created", "collected"].includes(playlist.category);
  return {
    id, name: `${prefixes[playlist.category]}${playlist.name}`, comment: playlist.description, owner: playlist.ownerName ?? "网易云音乐", public: playlist.public ?? !accountPlaylist, readonly: true,
    songCount: playlist.songCount, duration: Math.max(0, Math.round(playlist.durationMs / 1000)),
    created: playlist.createdAt ?? createdAt, changed: playlist.updatedAt ?? fetchedAt,
    ...(playlist.artwork ? { coverArt: id } : {}),
  };
}
