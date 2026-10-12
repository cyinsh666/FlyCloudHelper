import { ApiError, validationError } from "../errors.js";
import { providerFetch } from "../providers/network.js";
import { createNeteaseWebBody } from "./netease-web-request.js";
import type { ContentSourceManifest } from "./types.js";

/** 网易目录里的艺术家身份，不使用姓名合并不同的艺术家。 */
export interface NeteaseArtist {
  id: string;
  name: string;
  artwork: string | null;
  description: string;
  albumCount: number;
}

/** 网易专辑快照；详情加载标记与搜索的简略快照分开保存。 */
export interface NeteaseAlbum {
  id: string;
  name: string;
  artwork: string | null;
  description: string;
  artists: NeteaseArtist[];
  publishedAt: string | null;
  songCount: number;
  detailsLoaded: boolean;
}

/** 推荐歌单、排行榜和普通歌单共用真实网易歌单身份，不创建虚构专辑。 */
export interface NeteasePlaylist {
  id: string;
  name: string;
  artwork: string | null;
  description: string;
  songCount: number;
  category: "recommended" | "chart" | "playlist";
  updateFrequency?: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** 摘要没有确定时长时为 0；歌单详情按实际返回的歌曲时长汇总。 */
  durationMs: number;
}

/** 歌曲只保存稳定目录身份和音频资料，播放 URL 不属于目录数据。 */
export interface NeteaseSong {
  id: string;
  name: string;
  artists: NeteaseArtist[];
  album: NeteaseAlbum | null;
  durationMs: number;
  trackNumber: number;
  discNumber: number;
  bitRate: number;
  size: number;
  suffix: string;
  detailsLoaded: boolean;
}

/** 即时播放结果只在本次请求中存在，bitRate 使用 Subsonic 的 kbps 单位。 */
export interface NeteasePlayback {
  url: string;
  contentType: string;
  suffix: string;
  bitRate: number;
  size: number;
}

/** 校验网易数字 ID，避免把链接或查询片段当作目录身份。 */
export function neteaseRemoteId(value: unknown): string {
  const id = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^[1-9]\d{0,15}$/u.test(id) || !Number.isSafeInteger(Number(id))) throw validationError("remoteId", "网易歌曲、专辑或歌单 ID 必须是有效的正整数");
  return id;
}

/** 只接收源站 JSON 对象，缺失的可选对象按空对象读取。 */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取非负数值字段，不把无效数字写进协议响应。 */
function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 将源站有效毫秒时间戳转换为目录日期，缺失时间不使用本地当前时间冒充。 */
function sourceDate(value: unknown): string | null {
  const timestamp = positiveNumber(value);
  const date = timestamp ? new Date(timestamp) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 校验源目录窗口，0 条表示无需请求，offset 始终是源站窗口起点。 */
function validateDiscoveryWindow(count: number, offset = 0): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 500) throw validationError("count", "音乐发现数量必须为 0 至 500 的整数");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + count)) throw validationError("offset", "音乐发现起点必须为有效的非负整数");
}

/** 读取公开封面地址，不保存无效 URL 或内嵌凭据。 */
function artwork(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.protocol === "http:" && /(^|\.)music\.126\.net$/iu.test(url.hostname)) url.protocol = "https:";
    return url.href;
  } catch { return null; }
}

/** 解析源站明确给出的艺术家，缺少真实 ID 的名字不生成伪身份。 */
function readArtist(value: unknown): NeteaseArtist | null {
  const raw = object(value);
  if (!raw.id || typeof raw.name !== "string" || !raw.name.trim()) return null;
  try {
    return { id: neteaseRemoteId(raw.id), name: raw.name.trim(), artwork: artwork(raw.picUrl) ?? artwork(raw.img1v1Url), description: String(raw.briefDesc ?? ""), albumCount: positiveNumber(raw.albumSize) };
  } catch { return null; }
}

/** 读取源站多艺术家集合，保留原顺序和所有真实身份。 */
function readArtists(value: unknown): NeteaseArtist[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const artists = values.flatMap((entry) => { const artist = readArtist(entry); return artist ? [artist] : []; });
  return artists.filter((artist, index) => artists.findIndex((candidate) => candidate.id === artist.id) === index);
}

/** 读取专辑字段，发布日期仅使用源站明确的时间戳。 */
function readAlbum(value: unknown, detailsLoaded = false): NeteaseAlbum | null {
  const raw = object(value);
  if (!raw.id || typeof raw.name !== "string" || !raw.name.trim()) return null;
  try {
    const artists = readArtists(raw.artists);
    return {
      id: neteaseRemoteId(raw.id), name: raw.name.trim(), artwork: artwork(raw.picUrl) ?? artwork(raw.blurPicUrl),
      description: String(raw.description || raw.briefDesc || ""), artists: artists.length ? artists : readArtists(raw.artist),
      publishedAt: sourceDate(raw.publishTime),
      songCount: positiveNumber(raw.size ?? raw.songCount), detailsLoaded,
    };
  } catch { return null; }
}

/** 读取公开歌单摘要；推荐接口 picUrl 与榜单、详情 coverImgUrl 分开兼容。 */
function readPlaylist(value: unknown, category: NeteasePlaylist["category"]): NeteasePlaylist | null {
  const raw = object(value);
  if (!raw.id || typeof raw.name !== "string" || !raw.name.trim()) return null;
  try {
    return {
      id: neteaseRemoteId(raw.id), name: raw.name.trim(), artwork: artwork(raw.coverImgUrl) ?? artwork(raw.picUrl),
      description: String(raw.description || raw.copywriter || ""), songCount: positiveNumber(raw.trackCount), category,
      ...(typeof raw.updateFrequency === "string" && raw.updateFrequency ? { updateFrequency: raw.updateFrequency } : {}),
      createdAt: sourceDate(raw.createTime), updatedAt: sourceDate(positiveNumber(raw.updateTime) || raw.trackUpdateTime), durationMs: 0,
    };
  } catch { return null; }
}

/** 兼容网易原站旧详情字段和搜索字段，不接收 mp3Url 等临时媒体地址。 */
function readSong(value: unknown, album?: NeteaseAlbum, detailsLoaded = false): NeteaseSong | null {
  const raw = object(value);
  if (!raw.id || typeof raw.name !== "string" || !raw.name.trim()) return null;
  try {
    const qualityCandidates = [object(raw.bMusic), object(raw.l), object(raw.lMusic)];
    const lowQuality = qualityCandidates.find((quality) => positiveNumber(quality.bitrate ?? quality.br) || positiveNumber(quality.size)) ?? {};
    const artists = readArtists(raw.artists);
    const songAlbum = readAlbum(raw.album) ?? readAlbum(raw.al);
    return {
      id: neteaseRemoteId(raw.id), name: raw.name.trim(), artists: artists.length ? artists : readArtists(raw.ar),
      album: album ?? songAlbum, durationMs: positiveNumber(raw.duration) || positiveNumber(raw.dt),
      trackNumber: positiveNumber(raw.position) || positiveNumber(raw.no), discNumber: positiveNumber(raw.disc) || positiveNumber(raw.cd),
      bitRate: positiveNumber(lowQuality.bitrate ?? lowQuality.br), size: positiveNumber(lowQuality.size), detailsLoaded,
      suffix: typeof lowQuality.extension === "string" ? lowQuality.extension.toLowerCase() : "",
    };
  } catch { return null; }
}

/** 固定网易原站 HTTP 适配器，不执行导入文件里的脚本，也不持有网易登录凭据。 */
export class NeteaseMusicAdapter {
  /** 保存声明式清单，源站端点由导入校验限制为网易 HTTPS 原站。 */
  public constructor(private readonly manifest: ContentSourceManifest, private readonly allowInsecureHttp: boolean) {
    if (manifest.adapter !== "netease_http" || manifest.endpoint !== "https://music.163.com/") throw validationError("adapter", "此音乐源需要网易原站适配器");
  }

  /** 发起公开目录或取址请求；专辑及发现目录使用正常网页 POST 协议，其他接口沿用原请求方式。 */
  private async request(path: string, parameters: Record<string, string> = {}, signal?: AbortSignal, useWebProtocol = false): Promise<Record<string, unknown>> {
    const url = new URL(path, this.manifest.endpoint);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: this.manifest.endpoint };
    // 关键变量：网页接口将参数封装在表单中，不创建网易登录会话或保存临时请求密钥。
    let body: URLSearchParams | undefined;
    if (useWebProtocol) {
      url.searchParams.set("csrf_token", "");
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = createNeteaseWebBody(parameters);
    } else {
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await providerFetch(url, { method: useWebProtocol ? "POST" : "GET", headers, body }, { allowInsecureHttp: this.allowInsecureHttp }, signal);
    } catch (error) {
      if (error instanceof ApiError && error.code.startsWith("provider_")) throw new ApiError(error.statusCode, error.code, error.message.replace(/网盘/gu, "音乐源").replace(/Provider/gu, "音乐源"));
      throw error;
    }
    signal?.throwIfAborted();
    if (!response.ok) throw new ApiError(502, "content_music_http_failed", `网易音乐接口返回 HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new ApiError(413, "content_music_response_too_large", "网易音乐单次响应超过 4 MB");
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(text)); }
    catch { throw new ApiError(502, "content_music_json_invalid", "网易音乐源未返回有效 JSON"); }
    const sourceCode = Number(payload.code);
    if (sourceCode !== 200) {
      // 仅展示业务错误码，不把源站正文、播放地址或请求密文写入提示。
      const message = sourceCode === -462
        ? "网易音乐源要求登录或绑定手机后访问该内容（源站错误码 -462）"
        : `网易音乐源暂时无法提供请求的内容${Number.isFinite(sourceCode) ? `（源站错误码 ${sourceCode}）` : ""}`;
      throw new ApiError(502, "content_music_source_failed", message);
    }
    return payload;
  }

  /** 搜索按源站 offset 分页；超过源单页上限时继续取页，三个实体互不共用游标。 */
  private async searchPage(query: string, type: 1 | 10 | 100, count: number, offset: number, signal?: AbortSignal): Promise<unknown[]> {
    if (!count) return [];
    const key = type === 1 ? "songs" : type === 10 ? "albums" : "artists";
    const values: unknown[] = [];
    while (values.length < count) {
      const limit = Math.min(100, count - values.length);
      const payload = await this.request("/api/search/get", { s: query, type: String(type), limit: String(limit), offset: String(offset + values.length) }, signal);
      const page = object(payload.result)[key];
      if (!Array.isArray(page) || !page.length) break;
      values.push(...page.slice(0, limit));
      if (page.length < limit) break;
    }
    return values;
  }

  /** 搜索歌曲时仅持久化简略目录，详情在 getSong 或播放前按需补齐。 */
  public async searchSongs(query: string, count: number, offset: number, signal?: AbortSignal): Promise<NeteaseSong[]> {
    return (await this.searchPage(query, 1, count, offset, signal)).flatMap((value) => { const song = readSong(value); return song ? [song] : []; });
  }

  /** 专辑搜索保留源站返回顺序，详情由专辑 ID 获取。 */
  public async searchAlbums(query: string, count: number, offset: number, signal?: AbortSignal): Promise<NeteaseAlbum[]> {
    return (await this.searchPage(query, 10, count, offset, signal)).flatMap((value) => { const album = readAlbum(value); return album ? [album] : []; });
  }

  /** 艺术家搜索使用独立分页参数。 */
  public async searchArtists(query: string, count: number, offset: number, signal?: AbortSignal): Promise<NeteaseArtist[]> {
    return (await this.searchPage(query, 100, count, offset, signal)).flatMap((value) => { const artist = readArtist(value); return artist ? [artist] : []; });
  }

  /** 匿名推荐歌单是公开推荐列表，不要求用户填写歌单 ID，也不冒充登录用户的每日推荐。 */
  public async recommendedPlaylists(count = 20, signal?: AbortSignal): Promise<NeteasePlaylist[]> {
    validateDiscoveryWindow(count);
    if (!count) return [];
    const payload = await this.request("/weapi/personalized/playlist", { limit: String(count), total: "true", n: "1000" }, signal, true);
    if (!Array.isArray(payload.result)) throw new ApiError(502, "content_music_recommendations_missing", "网易音乐源未返回推荐歌单");
    return payload.result.slice(0, count).flatMap((value) => { const playlist = readPlaylist(value, "recommended"); return playlist ? [playlist] : []; });
  }

  /** 读取网易所有公开排行榜摘要，排名歌曲在打开榜单时再读取详情。 */
  public async charts(signal?: AbortSignal): Promise<NeteasePlaylist[]> {
    const payload = await this.request("/weapi/toplist", {}, signal, true);
    if (!Array.isArray(payload.list)) throw new ApiError(502, "content_music_charts_missing", "网易音乐源未返回排行榜");
    return payload.list.flatMap((value) => { const playlist = readPlaylist(value, "chart"); return playlist ? [playlist] : []; });
  }

  /** 全部新碟接口有真实 limit/offset/total；不把固定十二张最新专辑假装成可继续翻页。 */
  public async newAlbums(count = 20, offset = 0, signal?: AbortSignal): Promise<{ albums: NeteaseAlbum[]; hasMore: boolean; total: number | null }> {
    validateDiscoveryWindow(count, offset);
    if (!count) return { albums: [], hasMore: false, total: null };
    const albums: NeteaseAlbum[] = [];
    let fetchedCount = 0;
    let total: number | null = null;
    let hasMore = false;
    while (fetchedCount < count) {
      const limit = Math.min(100, count - fetchedCount);
      const payload = await this.request("/weapi/album/new", { area: "ALL", limit: String(limit), offset: String(offset + fetchedCount), total: "true" }, signal, true);
      if (!Array.isArray(payload.albums)) throw new ApiError(502, "content_music_new_albums_missing", "网易音乐源未返回新专辑目录");
      const sourceTotal = typeof payload.total === "number" || typeof payload.total === "string" && payload.total.trim() ? Number(payload.total) : Number.NaN;
      if (Number.isSafeInteger(sourceTotal) && sourceTotal >= 0) total = sourceTotal;
      const page = payload.albums.slice(0, limit);
      fetchedCount += page.length;
      albums.push(...page.flatMap((value) => { const album = readAlbum(value); return album ? [album] : []; }));
      hasMore = page.length > 0 && (total !== null ? offset + fetchedCount < total : typeof payload.hasMore === "boolean" ? payload.hasMore : page.length === limit);
      if (!page.length || !hasMore) break;
    }
    return { albums, hasMore, total };
  }

  /** 获取完整专辑和歌曲快照，缺少专辑或曲目字段时不伪造空详情。 */
  public async album(id: string, signal?: AbortSignal): Promise<{ album: NeteaseAlbum; songs: NeteaseSong[] }> {
    const remoteId = neteaseRemoteId(id);
    const payload = await this.request(`/weapi/v1/album/${remoteId}`, {}, signal, true);
    const album = readAlbum(payload.album, true);
    // 关键变量：新版网页响应的完整曲目在顶层 songs，album.songs 可能只是空数组。
    const rawSongs = Array.isArray(payload.songs) ? payload.songs : object(payload.album).songs;
    if (!album || album.id !== remoteId || !Array.isArray(rawSongs)) throw new ApiError(404, "content_music_album_missing", "网易专辑不存在或目录不完整");
    const songs = rawSongs.flatMap((value, index) => {
      const song = readSong(value, album, true);
      return song ? [{ ...song, trackNumber: song.trackNumber || index + 1 }] : [];
    });
    return { album: { ...album, songCount: songs.length }, songs };
  }

  /** 按稳定歌曲 ID 批量获取详情，源站漏掉的受限或删除歌曲不生成伪记录。 */
  public async songs(ids: string[], signal?: AbortSignal): Promise<NeteaseSong[]> {
    const songs: NeteaseSong[] = [];
    const remoteIds = [...new Set(ids.map(neteaseRemoteId))];
    for (let offset = 0; offset < remoteIds.length; offset += 100) {
      const batch = remoteIds.slice(offset, offset + 100);
      const payload = await this.request("/api/song/detail", { ids: JSON.stringify(batch.map(Number)) }, signal);
      if (!Array.isArray(payload.songs)) throw new ApiError(502, "content_music_song_details_missing", "网易音乐源未返回歌曲详情");
      for (const value of payload.songs) {
        const song = readSong(value, undefined, true);
        if (song && batch.includes(song.id)) songs.push(song);
      }
    }
    return songs;
  }

  /** 公开歌单详情保留 trackIds 原始曲序；匿名拿不到的曲目明确返回缺失 ID。 */
  public async playlistDetail(id: string, signal?: AbortSignal): Promise<{ playlist: NeteasePlaylist; songs: NeteaseSong[]; missingSongIds: string[] }> {
    const remoteId = neteaseRemoteId(id);
    const payload = await this.request("/weapi/v6/playlist/detail", { id: remoteId, n: "100000", s: "0" }, signal, true);
    const raw = object(payload.playlist ?? payload.result);
    const playlist = readPlaylist(raw, "playlist");
    if (!playlist || playlist.id !== remoteId || !Array.isArray(raw.tracks)) throw new ApiError(404, "content_music_playlist_missing", "网易歌单不存在或暂时不可访问");
    const rawTrackIds = Array.isArray(raw.trackIds) ? raw.trackIds : [];
    // 关键变量：超大列表明确失败，不静默截取前几千首并声称完整歌单。
    if (rawTrackIds.length > 10000 || raw.tracks.length > 10000 || playlist.songCount > 10000) throw new ApiError(422, "content_music_playlist_large", "此歌单超过本次可加载的 10000 首范围，请选择其他歌单");
    const trackIds = rawTrackIds.map((value) => {
      try { return neteaseRemoteId(object(value).id); }
      catch { throw new ApiError(502, "content_music_playlist_track_invalid", "网易歌单返回了无效歌曲身份"); }
    });
    const songsById = new Map<string, NeteaseSong>();
    for (const value of raw.tracks) {
      const song = readSong(value, undefined, true);
      if (song) songsById.set(song.id, song);
    }
    const orderedIds = trackIds.length ? trackIds : [...songsById.keys()];
    if (playlist.songCount > orderedIds.length) throw new ApiError(502, "content_music_playlist_incomplete", "网易歌单没有返回完整歌曲身份列表，请稍后重试");
    const missingIds = [...new Set(orderedIds.filter((songId) => !songsById.has(songId)))];
    for (const song of await this.songs(missingIds, signal)) songsById.set(song.id, song);
    const songs = orderedIds.flatMap((songId) => { const song = songsById.get(songId); return song ? [song] : []; });
    const missingSongIds = [...new Set(orderedIds.filter((songId) => !songsById.has(songId)))];
    return { playlist: { ...playlist, durationMs: songs.reduce((duration, song) => duration + song.durationMs, 0) }, songs, missingSongIds };
  }

  /** 保留初始目录同步的既有调用方式，发现歌单和排行榜使用带摘要的新详情方法。 */
  public async playlist(id: string, signal?: AbortSignal): Promise<NeteaseSong[]> {
    return (await this.playlistDetail(id, signal)).songs;
  }

  /** 获取艺术家和全部专辑分页，源站持续宣称还有数据时明确报错，不静默截断。 */
  public async artist(id: string, signal?: AbortSignal): Promise<{ artist: NeteaseArtist; albums: NeteaseAlbum[] }> {
    const remoteId = neteaseRemoteId(id);
    const payload = await this.request(`/api/artist/${remoteId}`, {}, signal);
    const artist = readArtist(payload.artist);
    if (!artist || artist.id !== remoteId) throw new ApiError(404, "content_music_artist_missing", "网易艺术家不存在");
    const albums: NeteaseAlbum[] = [];
    for (let page = 0; page < 40; page += 1) {
      const result = await this.request(`/api/artist/albums/${remoteId}`, { limit: "50", offset: String(page * 50) }, signal);
      if (!Array.isArray(result.hotAlbums)) throw new ApiError(502, "content_music_artist_albums_missing", "网易音乐源未返回艺术家专辑目录");
      albums.push(...result.hotAlbums.flatMap((value) => { const album = readAlbum(value); return album ? [{ ...album, artists: album.artists.length ? album.artists : [artist] }] : []; }));
      if (result.more !== true) return { artist, albums };
      if (!result.hotAlbums.length) throw new ApiError(502, "content_music_pagination_invalid", "网易专辑分页未返回后续内容，请稍后重试");
    }
    throw new ApiError(422, "content_music_artist_catalog_large", "此艺术家专辑目录超过本次加载范围，请通过搜索查找具体专辑");
  }

  /** 获取公开歌词文字，源站未提供歌词时返回空文本。 */
  public async lyrics(id: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.request("/api/song/lyric", { id: neteaseRemoteId(id), lv: "-1", kv: "-1", tv: "-1" }, signal);
    const lyric = object(payload.lrc).lyric;
    return typeof lyric === "string" ? lyric : "";
  }

  /** 播放前即时取址；空地址和试听明确失败，不把受限歌曲当作完整音频播放。 */
  public async resolveSong(id: string, maxBitRate = 0, signal?: AbortSignal): Promise<NeteasePlayback> {
    const remoteId = neteaseRemoteId(id);
    if (!Number.isFinite(maxBitRate) || maxBitRate < 0) throw validationError("maxBitRate", "音频码率上限必须为非负数");
    const requestedBitRate = maxBitRate > 0 ? Math.round(Math.min(320, maxBitRate) * 1000) : 128000;
    const payload = await this.request("/api/song/enhance/player/url", { ids: JSON.stringify([Number(remoteId)]), br: String(requestedBitRate) }, signal);
    const value = Array.isArray(payload.data) ? payload.data.find((entry) => String(object(entry).id) === remoteId) : null;
    const raw = object(value);
    if (Number(raw.code) !== 200 || typeof raw.url !== "string" || !raw.url) throw new ApiError(403, "content_music_song_unavailable", "网易音乐源没有提供此歌曲的可用播放地址");
    if (raw.freeTrialInfo !== null && raw.freeTrialInfo !== undefined) throw new ApiError(403, "content_music_song_trial", "此歌曲仅提供试听，当前插件不播放试听音频");
    let url: URL;
    try { url = new URL(raw.url); } catch { throw new ApiError(502, "content_music_playback_url_invalid", "网易音乐源返回的播放地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !/(^|\.)music\.126\.net$/iu.test(url.hostname)) throw new ApiError(502, "content_music_playback_url_invalid", "网易音乐源返回了不支持的音频地址");
    // 关键变量：网易媒体 CDN 的同路径 HTTPS 已实测可用，避免客户端收到明文音频地址。
    if (url.protocol === "http:") url.protocol = "https:";
    const suffix = String(raw.type ?? "").toLowerCase();
    const contentType = ({ mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac" } as Record<string, string>)[suffix];
    if (!contentType) throw new ApiError(422, "content_music_format_unsupported", "网易音乐源返回了不支持的音频格式");
    const bitRate = positiveNumber(raw.br) / 1000;
    if (maxBitRate > 0 && bitRate > maxBitRate) throw new ApiError(422, "content_music_bitrate_unsupported", "网易音乐源无法满足客户端指定的码率上限，当前插件未提供转码");
    return { url: url.href, contentType, suffix, bitRate, size: positiveNumber(raw.size) };
  }
}
