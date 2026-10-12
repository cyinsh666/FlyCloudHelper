import { createHash, randomUUID } from "node:crypto";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject, type MediaItemRecord } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ServiceRepository } from "../service-repository.js";
import { CredentialVault } from "../secrets.js";
import { validateContentManifest } from "./cms-adapter.js";
import { contentMusicItemId, persistContentMusic, type ContentMusicRemoteKind } from "./music-catalog.js";
import { contentMusicPlaylistRemoteId, mapContentMusicPlaylist, type ContentMusicPlaylist } from "./music-discovery.js";
import { NeteaseMusicAdapter, neteaseRemoteId, type NeteasePlayback, type NeteasePlaylist } from "./netease-adapter.js";
import { NeteaseLoginClient, validateNeteaseCookie, type NeteaseAccountProfile } from "./netease-login.js";
import type { ContentSourceInstance, ContentSourceManifest, ContentSourcePlaybackMode, ContentSourcePluginRecord, ContentSourceSyncState } from "./types.js";

/** 在线音乐库只保存初始目录入口与播放模式，不保存网易账号或临时 URL。 */
export interface ContentMusicConfiguration {
  albumIds: string[];
  playlistIds: string[];
  playbackMode: ContentSourcePlaybackMode;
}

/** 三种音乐实体的实时搜索分页遵循 Subsonic 各自的 count、offset。 */
export interface ContentMusicSearchOptions {
  artistCount: number;
  artistOffset: number;
  albumCount: number;
  albumOffset: number;
  songCount: number;
  songOffset: number;
}

/** 协议播放结果允许以后增加源站所需的公开请求头，当前网易匿名源无需额外请求头。 */
export interface ContentMusicPlayback extends NeteasePlayback {
  mode: ContentSourcePlaybackMode;
  headers?: Record<string, string>;
}

interface MusicRuntimeContext {
  libraryId: string;
  userId: string;
  source: ContentSourceInstance;
  manifest: ContentSourceManifest;
  configuration: ContentMusicConfiguration;
  storedConfiguration: Record<string, unknown>;
  account: StoredNeteaseAccount | null;
  adapter: NeteaseMusicAdapter;
}

/** 设置页仅展示账号摘要，网易会话不会返回给浏览器或协议客户端。 */
export interface ContentMusicAccountState {
  status: "anonymous" | "logged_in" | "expired";
  profile: NeteaseAccountProfile | null;
  checkedAt: string | null;
}

/** 网易 Cookie 与账号摘要一起使用现有凭据主密钥加密保存。 */
interface StoredNeteaseAccount {
  cookie: string;
  profile: NeteaseAccountProfile;
  status: "logged_in" | "expired";
  checkedAt: string;
}

/** 二维码只在当前服务内存保存，并限定媒体库、所有者和本次尝试。 */
interface NeteaseQrSession {
  libraryId: string;
  userId: string;
  key: string;
  cookie: string;
  expiresAt: number;
  nextPollAt: number;
  status: "waiting" | "scanned" | "verification_required" | "expired" | "authorized";
  verificationUrl?: string;
}

// 关键变量：摘要和专辑页在当前进程缓存 15 分钟，歌单曲目缓存 5 分钟；不保存临时播放地址。
const DISCOVERY_CACHE_MS = 15 * 60_000;
const PLAYLIST_DETAIL_CACHE_MS = 5 * 60_000;
const DISCOVERY_ALBUM_PAGE_SIZE = 50;

interface DiscoveryPlaylistCache {
  accountKey: string;
  expiresAt: number;
  fetchedAt: string;
  playlists: NeteasePlaylist[];
}

interface DiscoveryPlaylistDetailCache {
  accountKey: string;
  expiresAt: number;
  fetchedAt: string;
  playlist: NeteasePlaylist;
  songIds: string[];
}

interface DiscoveryAlbumPageCache {
  expiresAt: number;
  albumIds: string[];
  hasMore: boolean;
}

/** 喜欢集合仅缓存源站真实 ID，不把账号喜欢写入本地协议账号偏好表。 */
interface NeteaseLikedSongCache {
  accountKey: string;
  expiresAt: number;
  likedAt: string;
  remoteSongIds: string[];
}

/** 协议星标使用当前音乐库的稳定条目 ID，并共用同一次源站喜欢快照。 */
export interface NeteaseLikedSongState {
  songIds: ReadonlySet<string>;
  likedAt: string;
}

/** 创建与视频相同格式的同步摘要，音乐数量代表本轮处理的目录摘要或歌曲。 */
function emptyMusicSync(): ContentSourceSyncState {
  return { status: "idle", processedCount: 0, pageCount: 0, nextPageByCategory: {}, startedAt: null, finishedAt: null, lastError: null };
}

/** 校验初始目录 ID，显式空数组表示仅使用实时搜索的空音乐库。 */
function configuredIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 50) throw validationError(field, "专辑或歌单入口必须是数组，最多配置 50 个");
  return [...new Set(value.map(neteaseRemoteId))];
}

/** 已保存的库配置缺少可选字段时保留空目录并使用自动播放。 */
function readConfiguration(value: unknown): ContentMusicConfiguration {
  const raw = parseJsonObject(value);
  return {
    albumIds: Array.isArray(raw.albumIds) ? configuredIds(raw.albumIds, "albumIds") : [],
    playlistIds: Array.isArray(raw.playlistIds) ? configuredIds(raw.playlistIds, "playlistIds") : [],
    playbackMode: raw.playbackMode === "direct" || raw.playbackMode === "relay" ? raw.playbackMode : "auto",
  };
}

/** 插件公开摘要不携带 HTTP 请求头或内部源地址。 */
function publicPlugin(row: Record<string, unknown>, manifest: ContentSourceManifest): ContentSourcePluginRecord {
  return { pluginId: manifest.pluginId, version: manifest.version, displayName: manifest.displayName, description: manifest.description, adapter: manifest.adapter, status: String(row.plugin_status ?? row.status) as ContentSourcePluginRecord["status"] };
}

/** 从联表结果生成用户源实例，归属由调用方查询约束保证。 */
function sourceFromRow(row: Record<string, unknown>): ContentSourceInstance {
  return {
    id: String(row.instance_id ?? row.id), userId: String(row.user_id), pluginId: String(row.plugin_id), pluginVersion: String(row.plugin_version), displayName: String(row.source_name ?? row.display_name),
    status: String(row.instance_status ?? row.status) as ContentSourceInstance["status"], pluginStatus: String(row.plugin_status) as ContentSourcePluginRecord["status"], libraryId: row.library_id ? String(row.library_id) : null,
    createdAt: String(row.source_created_at ?? row.created_at), updatedAt: String(row.source_updated_at ?? row.updated_at),
  };
}

/** 音乐内容宿主复用既有目录和协议账号，独立于网盘来源与文件扫描。 */
export class ContentMusicManager {
  // 关键变量：同一媒体库的写入串行，查询、同步、清空和删除不会互相覆盖关系或回填已删除目录。
  private readonly tails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly pausedLibraries = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly discoveryPlaylists = new Map<string, DiscoveryPlaylistCache>();
  private readonly discoveryPlaylistDetails = new Map<string, DiscoveryPlaylistDetailCache>();
  private readonly discoveryAlbumPages = new Map<string, DiscoveryAlbumPageCache>();
  private readonly neteaseLikedSongs = new Map<string, NeteaseLikedSongCache>();
  private readonly neteaseQrSessions = new Map<string, NeteaseQrSession>();
  private readonly vault: CredentialVault;
  private readonly neteaseLogin: NeteaseLoginClient;
  private closing = false;

  /** 使用已有表和仓储，不执行初始化、建表或数据库迁移。 */
  public constructor(private readonly database: FlyCloudHelperDatabase, private readonly config: ApiConfig, private readonly repository: ServiceRepository) {
    this.vault = new CredentialVault(config.credentialMasterKey);
    this.neteaseLogin = new NeteaseLoginClient(config.allowInsecureProviderHttp);
  }

  /** 只在宿主内部解密当前音乐库会话，旧配置没有会话时继续匿名访问。 */
  private readNeteaseAccount(configuration: Record<string, unknown>): StoredNeteaseAccount | null {
    const encrypted = configuration.neteaseSessionEncrypted;
    if (typeof encrypted !== "string" || !encrypted) return null;
    const value = this.vault.decrypt(encrypted);
    const profile = value.profile as NeteaseAccountProfile | undefined;
    if (typeof value.cookie !== "string" || !value.cookie || !profile || typeof profile.userId !== "string"
      || typeof profile.nickname !== "string" || typeof value.checkedAt !== "string"
      || (value.status !== "logged_in" && value.status !== "expired")) {
      throw new ApiError(503, "content_music_account_invalid", "网易云登录记录无法读取，请退出后重新扫码登录");
    }
    return { cookie: value.cookie, profile, status: value.status, checkedAt: value.checkedAt };
  }

  /** 返回公开登录状态，不包含会话 Cookie、密文或二维码请求参数。 */
  private accountState(account: StoredNeteaseAccount | null): ContentMusicAccountState {
    return account ? { status: account.status, profile: account.profile, checkedAt: account.checkedAt }
      : { status: "anonymous", profile: null, checkedAt: null };
  }

  /** 丢弃当前库未完成的扫码，防止切换账号或删除目录后提交旧结果。 */
  private clearNeteaseQrSessions(libraryId: string): void {
    for (const [id, session] of this.neteaseQrSessions) {
      if (session.libraryId === libraryId || session.expiresAt < Date.now()) this.neteaseQrSessions.delete(id);
    }
  }

  /** 查询固定版本实例，创建音乐库前确认源属于当前用户。 */
  private async instance(instanceId: string, userId: string): Promise<{ source: ContentSourceInstance; manifest: ContentSourceManifest }> {
    const row = await this.database.query("content_source_instances as i")
      .join("content_source_plugins as p", function joinMusicInstanceVersion() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .leftJoin("content_source_libraries as b", "b.instance_id", "i.id")
      .select("i.*", "p.manifest_json", "p.status as plugin_status", "b.library_id").where({ "i.id": instanceId, "i.user_id": userId }).first();
    if (!row) throw new ApiError(404, "content_source_not_found", "内容源实例不存在");
    if (row.status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
    if (row.plugin_status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件当前未启用");
    const manifest = validateContentManifest(parseJsonObject(row.manifest_json));
    if (manifest.adapter !== "netease_http") throw validationError("adapter", "此源不是支持的在线音乐源");
    return { source: sourceFromRow(row), manifest };
  }

  /** 读取音乐库绑定，所有目录操作均限定用户、库、来源和固定插件版本。 */
  private async binding(libraryId: string, userId: string): Promise<Record<string, unknown>> {
    const row = await this.database.query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .join("library_sources as ls", "ls.id", "b.library_source_id")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinMusicLibraryVersion() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .select("b.*", "i.plugin_id", "i.plugin_version", "i.display_name as source_name", "i.status as instance_status", "i.created_at as source_created_at", "i.updated_at as source_updated_at",
        "p.manifest_json", "p.status as plugin_status", "l.status as library_status", "ls.status as source_status")
      .where({ "b.library_id": libraryId, "b.user_id": userId, "l.user_id": userId, "i.user_id": userId, "ls.user_id": userId, "l.library_kind": "content_source_music", "l.data_type": "music" }).first();
    if (!row) throw new ApiError(404, "content_music_library_not_found", "在线音乐库不存在");
    return row;
  }

  /** 每次网络读取和目录写入前重新核对启用状态，停用后的目录只供已有本地浏览。 */
  private async context(libraryId: string, userId: string): Promise<MusicRuntimeContext> {
    const row = await this.binding(libraryId, userId);
    if (row.library_status !== "active") throw new ApiError(409, "content_library_disabled", "媒体库已停用");
    if (row.instance_status !== "active" || row.source_status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
    if (row.plugin_status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件当前未启用");
    const manifest = validateContentManifest(parseJsonObject(row.manifest_json));
    if (manifest.adapter !== "netease_http") throw new ApiError(422, "content_music_adapter_invalid", "音乐库绑定的适配器不支持在线音乐");
    const storedConfiguration = parseJsonObject(row.configuration_json);
    const account = this.readNeteaseAccount(storedConfiguration);
    return { libraryId, userId, source: sourceFromRow(row), manifest, storedConfiguration, account,
      configuration: readConfiguration(row.configuration_json),
      adapter: new NeteaseMusicAdapter(manifest, this.config.allowInsecureProviderHttp, account?.status === "logged_in" ? account.cookie : "") };
  }

  /** 标准协议鉴权通过后仍核对插件和源实例可用性。 */
  public async assertAvailable(libraryId: string, userId: string): Promise<void> {
    await this.context(libraryId, userId);
  }

  /** 停机和清空期间拒绝新的写入请求。 */
  private accept(libraryId: string): number {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后重试");
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "content_catalog_changing", "媒体库正在修改目录，请稍后重试");
    return this.generations.get(libraryId) ?? 0;
  }

  /** 在队列和写入前检查同一次目录代际，取消后不允许继续写数据库。 */
  private checkOperation(libraryId: string, generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.accept(libraryId);
    if (generation !== (this.generations.get(libraryId) ?? 0)) throw new ApiError(409, "content_catalog_changed", "媒体库目录已经改变，请重新加载");
  }

  /** 每库串行执行目录操作，错误只结束当前请求，不阻断后续队列。 */
  private enqueue<T>(libraryId: string, operation: (signal: AbortSignal, generation: number) => Promise<T>, controller = new AbortController(), parentSignal?: AbortSignal): Promise<T> {
    const generation = this.accept(libraryId);
    const abortParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortParent, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const libraryControllers = this.controllers.get(libraryId) ?? new Set<AbortController>();
    libraryControllers.add(controller);
    this.controllers.set(libraryId, libraryControllers);
    const previous = this.tails.get(libraryId) ?? Promise.resolve();
    const result = previous.then(async () => {
      this.checkOperation(libraryId, generation, controller.signal);
      return operation(controller.signal, generation);
    });
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(libraryId, tail);
    const finish = () => {
      parentSignal?.removeEventListener("abort", abortParent);
      libraryControllers.delete(controller);
      if (!libraryControllers.size) this.controllers.delete(libraryId);
      if (this.tails.get(libraryId) === tail) this.tails.delete(libraryId);
    };
    void result.then(finish, finish);
    return result;
  }

  /** 清空或删除前关掉新请求入口，取消网络并等待已有写入和同步状态收尾。 */
  public async withLibraryCatalogChange<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    if (this.pausedLibraries.has(libraryId)) throw new ApiError(409, "content_catalog_changing", "此媒体库正在修改目录");
    this.pausedLibraries.add(libraryId);
    this.generations.set(libraryId, (this.generations.get(libraryId) ?? 0) + 1);
    try {
      for (const controller of this.controllers.get(libraryId) ?? []) controller.abort();
      await this.tails.get(libraryId);
      this.clearNeteaseQrSessions(libraryId);
      this.clearDiscoveryCache(libraryId);
      return await operation();
    } finally { this.pausedLibraries.delete(libraryId); }
  }

  /** 关闭数据库前中止外部网络，并等所有目录写入和后台同步结束。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort();
    await Promise.allSettled([...this.tails.values()]);
    this.generations.clear();
    this.discoveryPlaylists.clear();
    this.discoveryPlaylistDetails.clear();
    this.discoveryAlbumPages.clear();
    this.neteaseLikedSongs.clear();
    this.neteaseQrSessions.clear();
  }

  /** 清空或删除目录时同时丢弃该库发现缓存，后续主动浏览才重新取源。 */
  private clearDiscoveryCache(libraryId: string): void {
    this.discoveryPlaylists.delete(libraryId);
    this.neteaseLikedSongs.delete(libraryId);
    const prefix = `${libraryId}:`;
    for (const key of this.discoveryPlaylistDetails.keys()) if (key.startsWith(prefix)) this.discoveryPlaylistDetails.delete(key);
    for (const key of this.discoveryAlbumPages.keys()) if (key.startsWith(prefix)) this.discoveryAlbumPages.delete(key);
  }

  /** 创建音乐源库默认自动发现目录，可选 ID 只用于补充指定作品。 */
  public async createLibrary(instanceId: string, userId: string, input: { displayName: string; albumIds?: string[]; playlistIds?: string[] }) {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后重试");
    const runtime = await this.instance(instanceId, userId);
    const configuration: ContentMusicConfiguration = {
      albumIds: input.albumIds === undefined ? [] : configuredIds(input.albumIds, "albumIds"),
      playlistIds: input.playlistIds === undefined ? [] : configuredIds(input.playlistIds, "playlistIds"), playbackMode: "auto",
    };
    const libraryId = randomUUID();
    const created = await this.repository.createContentSourceMusicLibrary({ libraryId, sourceId: randomUUID(), instanceId, userId, displayName: input.displayName, sourceName: runtime.source.displayName,
      configuration: configuration as unknown as Record<string, unknown>, syncState: emptyMusicSync() as unknown as Record<string, unknown> });
    const sync = await this.syncLibrary(libraryId, userId);
    return { libraryId, ...created, navidromeAccessCredentials: created.accessCredentials, sync };
  }

  /** 设置页可以查看已停用源的配置和最后同步结果。 */
  public async getLibrary(libraryId: string, userId: string): Promise<{ libraryId: string; source: ContentSourceInstance; plugin: ContentSourcePluginRecord; configuration: ContentMusicConfiguration; sync: ContentSourceSyncState }> {
    const row = await this.binding(libraryId, userId);
    const manifest = validateContentManifest(parseJsonObject(row.manifest_json));
    return { libraryId, source: sourceFromRow(row), plugin: publicPlugin(row, manifest), configuration: readConfiguration(row.configuration_json), sync: { ...emptyMusicSync(), ...parseJsonObject(row.sync_json) } as ContentSourceSyncState };
  }

  /** 修改目录入口不清除已有歌曲与收藏，下次手动同步补充所选专辑或歌单。 */
  public async updateLibraryConfiguration(libraryId: string, userId: string, patch: Partial<ContentMusicConfiguration>) {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      if (patch.playbackMode !== undefined && !["auto", "direct", "relay"].includes(patch.playbackMode)) throw validationError("playbackMode", "播放模式只支持自动、直连或中转");
      const configuration = { ...runtime.storedConfiguration, ...runtime.configuration,
        ...(patch.albumIds === undefined ? {} : { albumIds: configuredIds(patch.albumIds, "albumIds") }),
        ...(patch.playlistIds === undefined ? {} : { playlistIds: configuredIds(patch.playlistIds, "playlistIds") }),
        ...(patch.playbackMode === undefined ? {} : { playbackMode: patch.playbackMode }),
      };
      this.checkOperation(libraryId, generation, signal);
      await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ configuration_json: JSON.stringify(configuration), updated_at: new Date().toISOString() });
      return this.getLibrary(libraryId, userId);
    });
  }

  /** 读取当前库的登录摘要，不发起网易请求，也不改变已有媒体目录。 */
  public async getNeteaseAccount(libraryId: string, userId: string): Promise<ContentMusicAccountState> {
    const row = await this.binding(libraryId, userId);
    return this.accountState(this.readNeteaseAccount(parseJsonObject(row.configuration_json)));
  }

  /** 只改绑定配置中的加密会话，保留目录、播放模式、库 ID 与协议账号。 */
  private async saveNeteaseAccount(libraryId: string, userId: string, account: StoredNeteaseAccount | null, signal: AbortSignal, generation: number): Promise<ContentMusicAccountState> {
    const row = await this.binding(libraryId, userId);
    const configuration = parseJsonObject(row.configuration_json);
    if (account) configuration.neteaseSessionEncrypted = this.vault.encrypt({ ...account });
    else delete configuration.neteaseSessionEncrypted;
    this.checkOperation(libraryId, generation, signal);
    await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId })
      .update({ configuration_json: JSON.stringify(configuration), updated_at: new Date().toISOString() });
    this.clearDiscoveryCache(libraryId);
    return this.accountState(account);
  }

  /** 创建网易 App 扫码入口；重新扫码保留原账号，确认后才替换会话。 */
  public async startNeteaseQr(libraryId: string, userId: string) {
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.context(libraryId, userId);
      if (!this.vault.isConfigured()) throw new ApiError(503, "credential_key_missing", "服务凭据主密钥尚未配置");
      this.clearNeteaseQrSessions(libraryId);
      const qr = await this.neteaseLogin.createQr(signal);
      await this.assertAvailable(libraryId, userId);
      this.checkOperation(libraryId, generation, signal);
      const sessionId = randomUUID();
      // 关键变量：短期二维码最多保留三分钟，原站提前过期时立即显示过期状态。
      const expiresAt = Date.now() + 180_000;
      this.neteaseQrSessions.set(sessionId, { libraryId, userId, key: qr.key, cookie: qr.cookie, expiresAt, nextPollAt: 0, status: "waiting" });
      return { sessionId, qrCodeContent: qr.qrCodeContent, expiresAt: new Date(expiresAt).toISOString(), pollIntervalSeconds: 3 };
    });
  }

  /** 校验扫码尝试归属后查询原站，确认账号身份再加密保存，不新建插件或媒体库。 */
  public async checkNeteaseQr(libraryId: string, userId: string, sessionId: string): Promise<{ status: NeteaseQrSession["status"]; account?: ContentMusicAccountState; verificationUrl?: string }> {
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.context(libraryId, userId);
      const session = this.neteaseQrSessions.get(sessionId);
      if (!session || session.libraryId !== libraryId || session.userId !== userId) {
        throw new ApiError(404, "content_music_qr_missing", "网易云二维码已失效，请重新获取");
      }
      if (session.status === "authorized") return { status: "authorized", account: await this.getNeteaseAccount(libraryId, userId) };
      if (session.status === "expired" || Date.now() >= session.expiresAt) {
        session.status = "expired";
        session.key = "";
        session.cookie = "";
        delete session.verificationUrl;
        return { status: "expired" };
      }
      if (Date.now() < session.nextPollAt) return { status: session.status,
        ...(session.status === "verification_required" ? { verificationUrl: session.verificationUrl } : {}) };
      session.nextPollAt = Date.now() + 3_000;
      const result = await this.neteaseLogin.checkQr(session.key, signal, session.cookie);
      this.checkOperation(libraryId, generation, signal);
      // 关键变量：临时设备 Cookie 随同一次扫码更新，只存在内存且不返回浏览器。
      if (result.cookie !== undefined) session.cookie = result.cookie;
      if (result.status !== "authorized") {
        session.status = result.status;
        if (result.status === "verification_required") session.verificationUrl = result.verificationUrl;
        else delete session.verificationUrl;
        if (result.status === "expired") { session.key = ""; session.cookie = ""; }
        // 验证入口只交给当前扫码会话的所属用户，不写入音乐目录或账号记录。
        return { status: session.status, ...(session.status === "verification_required" ? { verificationUrl: session.verificationUrl } : {}) };
      }
      const profile = result.cookie ? await this.neteaseLogin.account(result.cookie, signal) : null;
      if (!profile || !result.cookie) throw new ApiError(502, "content_music_login_incomplete", "网易云未返回完整登录会话，请重新扫码");
      await this.assertAvailable(libraryId, userId);
      this.checkOperation(libraryId, generation, signal);
      if (this.neteaseQrSessions.get(sessionId) !== session || Date.now() >= session.expiresAt) {
        throw new ApiError(409, "content_music_qr_changed", "网易云二维码已更新，请使用当前二维码登录");
      }
      const account = await this.saveNeteaseAccount(libraryId, userId, { cookie: result.cookie, profile, status: "logged_in", checkedAt: new Date().toISOString() }, signal, generation);
      session.status = "authorized";
      session.key = "";
      session.cookie = "";
      delete session.verificationUrl;
      return { status: "authorized", account };
    });
  }

  /** 主动检查网易登录是否仍有效，网络故障不会删除已保存的会话。 */
  public async checkNeteaseAccount(libraryId: string, userId: string): Promise<ContentMusicAccountState> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      if (!runtime.account) return this.accountState(null);
      const profile = await this.neteaseLogin.account(runtime.account.cookie, signal);
      await this.assertAvailable(libraryId, userId);
      return this.saveNeteaseAccount(libraryId, userId, { ...runtime.account, ...(profile ? { profile } : {}),
        status: profile ? "logged_in" : "expired", checkedAt: new Date().toISOString() }, signal, generation);
    });
  }

  /** 退出只移除当前音乐库的网易会话，媒体目录和 Navidrome 登录资料继续保留。 */
  public async logoutNeteaseAccount(libraryId: string, userId: string): Promise<ContentMusicAccountState> {
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.binding(libraryId, userId);
      this.clearNeteaseQrSessions(libraryId);
      return this.saveNeteaseAccount(libraryId, userId, null, signal, generation);
    });
  }

  /** 校验用户自己的网页登录会话，原站确认账号后才保存到当前音乐库。 */
  public async importNeteaseSession(libraryId: string, userId: string, cookie: string): Promise<ContentMusicAccountState> {
    const checkedCookie = validateNeteaseCookie(cookie);
    if (!/(?:^|;\s*)MUSIC_U=[^;]+/u.test(checkedCookie)) throw validationError("cookie", "请填写网易网页登录凭据 MUSIC_U");
    return this.enqueue(libraryId, async (signal, generation) => {
      await this.context(libraryId, userId);
      const profile = await this.neteaseLogin.account(checkedCookie, signal);
      if (!profile) throw new ApiError(401, "content_music_session_invalid", "网易网页登录会话无效或已失效，请重新登录网易官网并复制 MUSIC_U");
      await this.assertAvailable(libraryId, userId);
      // 关键变量：账号校验成功才取消当前二维码，失败时仍可继续扫码。
      this.clearNeteaseQrSessions(libraryId);
      return this.saveNeteaseAccount(libraryId, userId, { cookie: checkedCookie, profile, status: "logged_in", checkedAt: new Date().toISOString() }, signal, generation);
    });
  }

  /** 保存已有绑定的同步字段，不在错误路径新建记录。 */
  private async saveSync(libraryId: string, userId: string, sync: ContentSourceSyncState): Promise<void> {
    await this.database.query("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ sync_status: sync.status, sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
  }

  /** 给目录持久化提供每次写入前的归属、状态和代际复核。 */
  private beforeWrite(runtime: MusicRuntimeContext, signal: AbortSignal, generation: number): () => Promise<void> {
    return async () => {
      this.checkOperation(runtime.libraryId, generation, signal);
      await this.assertAvailable(runtime.libraryId, runtime.userId);
      this.checkOperation(runtime.libraryId, generation, signal);
    };
  }

  /** 刷新自动发现摘要与新专辑第一页，再同步可选补充目录，不扫描网易全站。 */
  public async syncLibrary(libraryId: string, userId: string): Promise<ContentSourceSyncState> {
    this.accept(libraryId);
    if (this.jobs.has(libraryId)) throw new ApiError(409, "content_library_sync_running", "在线音乐库正在同步");
    const controller = new AbortController();
    let resolveStarted!: (sync: ContentSourceSyncState) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<ContentSourceSyncState>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const operation = this.enqueue(libraryId, async (signal, generation) => {
      let claimed = false;
      let sync = { ...emptyMusicSync(), status: "queued" as ContentSourceSyncState["status"], startedAt: new Date().toISOString() };
      try {
        const runtime = await this.context(libraryId, userId);
        await this.database.query.transaction(async (transaction) => {
          const query = transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId });
          if (this.database.databaseType !== "sqlite") query.forUpdate();
          const binding = await query.first();
          if (!binding) throw new ApiError(404, "content_music_library_not_found", "在线音乐库不存在");
          if (["queued", "running"].includes(String(binding.sync_status))) throw new ApiError(409, "content_library_sync_running", "在线音乐库正在同步");
          await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ sync_status: "queued", sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
        });
        claimed = true;
        resolveStarted(sync);
        sync = { ...sync, status: "running" };
        await this.saveSync(libraryId, userId, sync);
        const processed = new Set<string>();
        const beforeWrite = this.beforeWrite(runtime, signal, generation);
        const discovery = await this.readDiscoveryPlaylists(runtime, signal, generation, true);
        for (const playlist of discovery.playlists) processed.add(`playlist:${playlist.id}`);
        const discoveredAlbums = await this.readDiscoveryAlbums(runtime, DISCOVERY_ALBUM_PAGE_SIZE, 0, signal, generation, true);
        for (const album of discoveredAlbums) processed.add(`album:${album.id}`);
        sync = { ...sync, processedCount: processed.size, pageCount: 3 };
        await this.saveSync(libraryId, userId, sync);
        for (const albumId of runtime.configuration.albumIds) {
          await beforeWrite();
          const content = await runtime.adapter.album(albumId, signal);
          await persistContentMusic({ database: this.database, repository: this.repository, userId, libraryId, instanceId: runtime.source.id, albums: [content.album], songs: content.songs, beforeWrite });
          for (const song of content.songs) processed.add(`song:${song.id}`);
          sync = { ...sync, processedCount: processed.size, pageCount: sync.pageCount + 1 };
          await this.saveSync(libraryId, userId, sync);
        }
        for (const playlistId of runtime.configuration.playlistIds) {
          await beforeWrite();
          const songs = await runtime.adapter.playlist(playlistId, signal);
          await persistContentMusic({ database: this.database, repository: this.repository, userId, libraryId, instanceId: runtime.source.id, songs, beforeWrite });
          for (const song of songs) processed.add(`song:${song.id}`);
          sync = { ...sync, processedCount: processed.size, pageCount: sync.pageCount + 1 };
          await this.saveSync(libraryId, userId, sync);
        }
        await beforeWrite();
        await this.saveSync(libraryId, userId, { ...sync, status: "completed", finishedAt: new Date().toISOString(), lastError: null });
      } catch (error) {
        if (claimed) {
          const lastError = signal.aborted ? "音乐目录同步已取消，可重新同步" : error instanceof ApiError ? error.message : "音乐目录同步失败，请检查源站与数据库状态后重试";
          await this.saveSync(libraryId, userId, { ...sync, status: "failed", finishedAt: new Date().toISOString(), lastError });
        }
        throw error;
      }
    }, controller);
    this.jobs.set(libraryId, { controller, promise: operation });
    const finish = () => { if (this.jobs.get(libraryId)?.promise === operation) this.jobs.delete(libraryId); };
    void operation.then(finish, (error) => { rejectStarted(error); finish(); });
    return started;
  }

  /** 搜索各类实体使用源站自己的窗口，入库后仍按源站顺序返回，不再本地二次截页。 */
  public async search(libraryId: string, userId: string, query: string, options: ContentMusicSearchOptions): Promise<{ artists: MediaItemRecord[]; albums: MediaItemRecord[]; songs: MediaItemRecord[] }> {
    const searchTerm = query.trim();
    if (!searchTerm || searchTerm.length > 200) throw validationError("query", "音乐搜索词必须为 1 至 200 个字符");
    for (const [key, value] of Object.entries(options)) if (!Number.isSafeInteger(value) || value < 0 || (key.endsWith("Count") && value > 500)) throw validationError(key, "搜索数量或起点无效");
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const [artistResult, albumResult, songResult] = await Promise.allSettled([
        options.artistCount ? runtime.adapter.searchArtists(searchTerm, options.artistCount, options.artistOffset, signal) : Promise.resolve([]),
        options.albumCount ? runtime.adapter.searchAlbums(searchTerm, options.albumCount, options.albumOffset, signal) : Promise.resolve([]),
        options.songCount ? runtime.adapter.searchSongs(searchTerm, options.songCount, options.songOffset, signal) : Promise.resolve([]),
      ]);
      for (const result of [artistResult, albumResult, songResult]) if (result.status === "rejected") throw result.reason;
      const artists = artistResult.status === "fulfilled" ? artistResult.value : [];
      const albums = albumResult.status === "fulfilled" ? albumResult.value : [];
      const songs = songResult.status === "fulfilled" ? songResult.value : [];
      const ids = await persistContentMusic({ database: this.database, repository: this.repository, userId, libraryId, instanceId: runtime.source.id, artists, albums, songs, beforeWrite: this.beforeWrite(runtime, signal, generation) });
      const records = await this.repository.listCatalogItemsByIds([...ids.artistIds, ...ids.albumIds, ...ids.songIds], userId);
      const recordsById = new Map(records.filter((item) => item.libraryId === libraryId).map((item) => [item.id, item]));
      /** 批量目录查询按 ID 恢复每种源结果的原始分页顺序。 */
      const ordered = (itemIds: string[]): MediaItemRecord[] => itemIds.flatMap((id) => { const item = recordsById.get(id); return item ? [item] : []; });
      return { artists: ordered(ids.artistIds), albums: ordered(ids.albumIds), songs: ordered(ids.songIds) };
    });
  }

  /** 按稳定 ID 恢复源顺序，同时排除其它媒体库和已清空的目录条目。 */
  private async orderedCatalogItems(runtime: MusicRuntimeContext, ids: string[]): Promise<MediaItemRecord[]> {
    if (!ids.length) return [];
    const records = await this.repository.listCatalogItemsByIds([...new Set(ids)], runtime.userId);
    const recordsById = new Map(records.filter((record) => record.libraryId === runtime.libraryId).map((record) => [record.id, record]));
    return ids.flatMap((id) => { const record = recordsById.get(id); return record ? [record] : []; });
  }

  /** 缓存按当前库、实例、网易 UID 和会话摘要隔离，Cookie 原文不会进入缓存键或目录。 */
  private neteaseAccountKey(runtime: MusicRuntimeContext): string {
    if (!runtime.account || runtime.account.status !== "logged_in") return `${runtime.source.id}:anonymous`;
    const cookieHash = createHash("sha256").update(runtime.account.cookie, "utf8").digest("hex");
    return `${runtime.source.id}:${runtime.account.profile.userId}:${cookieHash}`;
  }

  /** 喜欢 ID 使用五分钟内存快照，获取失败继续抛错，不缓存失败产生的空列表。 */
  private async readNeteaseLikedSongs(runtime: MusicRuntimeContext, signal: AbortSignal, generation: number): Promise<NeteaseLikedSongCache> {
    this.checkOperation(runtime.libraryId, generation, signal);
    const accountKey = this.neteaseAccountKey(runtime);
    if (!runtime.account || runtime.account.status !== "logged_in") {
      return { accountKey, expiresAt: 0, likedAt: new Date().toISOString(), remoteSongIds: [] };
    }
    const cached = this.neteaseLikedSongs.get(runtime.libraryId);
    if (cached && cached.accountKey === accountKey && cached.expiresAt > Date.now()) return cached;
    const remoteSongIds = await runtime.adapter.likedSongIds(runtime.account.profile.userId, signal);
    this.checkOperation(runtime.libraryId, generation, signal);
    // 关键变量：源站没有返回喜欢时间，使用本次成功读取的观测时间作为协议星标时间；缓存期间保持稳定。
    const value = { accountKey, expiresAt: Date.now() + PLAYLIST_DETAIL_CACHE_MS, likedAt: new Date().toISOString(), remoteSongIds };
    this.neteaseLikedSongs.set(runtime.libraryId, value);
    return value;
  }

  /** 推荐、排行榜与账号歌单只加载摘要，不在列表请求中读取全部曲目。 */
  private async readDiscoveryPlaylists(runtime: MusicRuntimeContext, signal: AbortSignal, generation: number, force = false): Promise<DiscoveryPlaylistCache> {
    this.checkOperation(runtime.libraryId, generation, signal);
    const accountKey = this.neteaseAccountKey(runtime);
    const cached = this.discoveryPlaylists.get(runtime.libraryId);
    if (!force && cached && cached.accountKey === accountKey && cached.expiresAt > Date.now()) return cached;
    const results = await Promise.allSettled([
      runtime.adapter.recommendedPlaylists(30, signal), runtime.adapter.charts(signal),
      runtime.account?.status === "logged_in" ? runtime.adapter.userPlaylists(runtime.account.profile.userId, signal) : Promise.resolve([] as NeteasePlaylist[]),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const recommendations = results[0]?.status === "fulfilled" ? results[0].value : [];
    const charts = results[1]?.status === "fulfilled" ? results[1].value : [];
    const accountPlaylists = results[2]?.status === "fulfilled" ? results[2].value : [];
    // 关键变量：账号歌单优先展示并按真实远端 ID 去重，避免同一收藏同时出现在推荐列表。
    const accountPlaylistIds = new Set(accountPlaylists.map((playlist) => playlist.id));
    const chartIds = new Set(charts.map((playlist) => playlist.id));
    const playlists = [
      ...accountPlaylists.filter((playlist) => playlist.category === "liked"),
      ...accountPlaylists.filter((playlist) => playlist.category !== "liked"),
      ...recommendations.filter((playlist) => !chartIds.has(playlist.id) && !accountPlaylistIds.has(playlist.id)),
      ...charts.filter((playlist) => !accountPlaylistIds.has(playlist.id)),
    ];
    this.checkOperation(runtime.libraryId, generation, signal);
    const value = { accountKey, expiresAt: Date.now() + DISCOVERY_CACHE_MS, fetchedAt: new Date().toISOString(), playlists };
    this.discoveryPlaylists.set(runtime.libraryId, value);
    return value;
  }

  /** 固定五十张为源缓存页，客户端任意 size/offset 都按同一源窗口截取。 */
  private async readDiscoveryAlbumPage(runtime: MusicRuntimeContext, offset: number, signal: AbortSignal, generation: number, force: boolean): Promise<DiscoveryAlbumPageCache> {
    const key = `${runtime.libraryId}:${offset}`;
    const cached = this.discoveryAlbumPages.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) {
      const records = await this.orderedCatalogItems(runtime, cached.albumIds);
      if (records.length === cached.albumIds.length) return cached;
    }
    const page = await runtime.adapter.newAlbums(DISCOVERY_ALBUM_PAGE_SIZE, offset, signal);
    const ids = await persistContentMusic({ database: this.database, repository: this.repository, userId: runtime.userId, libraryId: runtime.libraryId,
      instanceId: runtime.source.id, albums: page.albums, beforeWrite: this.beforeWrite(runtime, signal, generation) });
    this.checkOperation(runtime.libraryId, generation, signal);
    const value = { expiresAt: Date.now() + DISCOVERY_CACHE_MS, albumIds: ids.albumIds, hasMore: page.hasMore };
    this.discoveryAlbumPages.set(key, value);
    return value;
  }

  /** 专辑窗口跨源缓存页时继续读下一页，返回源站顺序而非入库时间顺序。 */
  private async readDiscoveryAlbums(runtime: MusicRuntimeContext, count: number, offset: number, signal: AbortSignal, generation: number, force = false): Promise<MediaItemRecord[]> {
    const ids: string[] = [];
    let sourceOffset = Math.floor(offset / DISCOVERY_ALBUM_PAGE_SIZE) * DISCOVERY_ALBUM_PAGE_SIZE;
    let skip = offset - sourceOffset;
    while (ids.length < count) {
      this.checkOperation(runtime.libraryId, generation, signal);
      const page = await this.readDiscoveryAlbumPage(runtime, sourceOffset, signal, generation, force);
      ids.push(...page.albumIds.slice(skip, skip + count - ids.length));
      if (!page.hasMore) break;
      sourceOffset += DISCOVERY_ALBUM_PAGE_SIZE;
      skip = 0;
    }
    return this.orderedCatalogItems(runtime, ids);
  }

  /** 新库进入艺术家或非最新排序前，自动补入新专辑第一页以提供可浏览目录。 */
  public async ensureDiscoveryCatalog(libraryId: string, userId: string): Promise<void> {
    await this.listDiscoveryAlbums(libraryId, userId, DISCOVERY_ALBUM_PAGE_SIZE, 0);
  }

  /** 最新专辑按标准协议分页，手动配置 ID 不再是浏览网易目录的前置条件。 */
  public async listDiscoveryAlbums(libraryId: string, userId: string, count: number, offset: number): Promise<MediaItemRecord[]> {
    if (!Number.isSafeInteger(count) || count < 0 || count > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw validationError("offset", "专辑数量或起点无效");
    return this.enqueue(libraryId, async (signal, generation) => this.readDiscoveryAlbums(await this.context(libraryId, userId), count, offset, signal, generation));
  }

  /** 网易账号歌单、公开推荐和排行榜作为标准只读歌单，不写入协议账号自建歌单表。 */
  public async listDiscoveryPlaylists(libraryId: string, userId: string): Promise<ContentMusicPlaylist[]> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const cached = await this.readDiscoveryPlaylists(runtime, signal, generation);
      return cached.playlists.map((playlist) => mapContentMusicPlaylist(playlist, libraryId, runtime.source.id, runtime.source.createdAt, cached.fetchedAt));
    });
  }

  /** 批量读取当前库的网易喜欢标记，不请求歌曲详情，供所有协议列表复用。 */
  public async readNeteaseLikedSongState(libraryId: string, userId: string): Promise<NeteaseLikedSongState> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const cached = await this.readNeteaseLikedSongs(runtime, signal, generation);
      return { songIds: new Set(cached.remoteSongIds.map((remoteId) => contentMusicItemId(libraryId, runtime.source.id, "song", remoteId))), likedAt: cached.likedAt };
    });
  }

  /** 返回协议条目 ID 集合，源喜欢的取消操作可以在任何本地偏好写入前整批预检。 */
  public async readNeteaseLikedSongIds(libraryId: string, userId: string): Promise<ReadonlySet<string>> {
    return (await this.readNeteaseLikedSongState(libraryId, userId)).songIds;
  }

  /** 收藏页按需补齐喜欢歌曲的真实目录，已有评分、播放历史和本地收藏不参与写入。 */
  public async listNeteaseLikedSongs(libraryId: string, userId: string): Promise<{ songs: MediaItemRecord[]; likedAt: string }> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const cached = await this.readNeteaseLikedSongs(runtime, signal, generation);
      const itemIds = cached.remoteSongIds.map((remoteId) => contentMusicItemId(libraryId, runtime.source.id, "song", remoteId));
      const previousItems = await this.orderedCatalogItems(runtime, itemIds);
      const previousById = new Map(previousItems.map((item) => [item.id, item]));
      const missingRemoteIds = cached.remoteSongIds.filter((remoteId, index) => {
        const item = previousById.get(itemIds[index] ?? "");
        const source = item?.metadata.contentSource;
        return !item || !source || typeof source !== "object" || (source as Record<string, unknown>).detailsLoaded !== true;
      });
      if (missingRemoteIds.length) {
        const songs = await runtime.adapter.songs(missingRemoteIds, signal);
        const returnedIds = new Set(songs.map((song) => song.id));
        const missingCount = missingRemoteIds.filter((remoteId) => !returnedIds.has(remoteId)).length;
        if (missingCount) throw new ApiError(502, "content_music_liked_songs_incomplete", `网易云未返回 ${missingCount} 首喜欢歌曲的完整详情，请稍后重试`);
        await persistContentMusic({ database: this.database, repository: this.repository, userId, libraryId, instanceId: runtime.source.id, songs,
          beforeWrite: this.beforeWrite(runtime, signal, generation) });
      }
      this.checkOperation(libraryId, generation, signal);
      return { songs: await this.orderedCatalogItems(runtime, itemIds), likedAt: cached.likedAt };
    });
  }

  /** 源歌单 ID 必须属于当前库；推荐排序变化和服务重启不影响已保存的身份。 */
  private playlistRemoteId(runtime: MusicRuntimeContext, id: string): string {
    const remoteId = contentMusicPlaylistRemoteId(runtime.libraryId, runtime.source.id, id);
    if (!remoteId) throw new ApiError(404, "content_music_playlist_missing", "此源歌单不属于当前音乐库");
    return remoteId;
  }

  /** 打开歌单时补齐真实曲目并保存标准歌曲目录，保留源曲序与重复条目。 */
  public async getDiscoveryPlaylist(libraryId: string, userId: string, playlistId: string): Promise<{ playlist: ContentMusicPlaylist; songs: MediaItemRecord[] }> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const accountKey = this.neteaseAccountKey(runtime);
      const remoteId = this.playlistRemoteId(runtime, playlistId);
      const key = `${libraryId}:${remoteId}`;
      let cached = this.discoveryPlaylistDetails.get(key);
      let songs = cached && cached.accountKey === accountKey && cached.expiresAt > Date.now() ? await this.orderedCatalogItems(runtime, cached.songIds) : null;
      if (!cached || cached.accountKey !== accountKey || cached.expiresAt <= Date.now() || !songs || songs.length !== cached.songIds.length) {
        const discoveryCache = this.discoveryPlaylists.get(libraryId);
        let summary = discoveryCache?.accountKey === accountKey ? discoveryCache.playlists.find((playlist) => playlist.id === remoteId) : undefined;
        if (!summary && runtime.account?.status === "logged_in") {
          const discovery = await this.readDiscoveryPlaylists(runtime, signal, generation);
          summary = discovery.playlists.find((playlist) => playlist.id === remoteId);
        }
        const detail = await runtime.adapter.playlistDetail(remoteId, signal);
        const ids = await persistContentMusic({ database: this.database, repository: this.repository, userId, libraryId,
          instanceId: runtime.source.id, songs: detail.songs, beforeWrite: this.beforeWrite(runtime, signal, generation) });
        const description = detail.missingSongIds.length ? `${detail.playlist.description}\n源站未提供 ${detail.missingSongIds.length} 首歌曲的详情。`.trim() : detail.playlist.description;
        const playlist = { ...detail.playlist, category: summary?.category ?? detail.playlist.category, description, songCount: detail.songs.length,
          ...(summary?.ownerId ? { ownerId: summary.ownerId } : {}), ...(summary?.ownerName ? { ownerName: summary.ownerName } : {}),
          ...(summary?.public === undefined ? {} : { public: summary.public }) };
        this.checkOperation(libraryId, generation, signal);
        cached = { accountKey, expiresAt: Date.now() + PLAYLIST_DETAIL_CACHE_MS, fetchedAt: new Date().toISOString(), playlist, songIds: ids.songIds };
        this.discoveryPlaylistDetails.set(key, cached);
        songs = await this.orderedCatalogItems(runtime, ids.songIds);
      }
      return { playlist: mapContentMusicPlaylist(cached.playlist, libraryId, runtime.source.id, runtime.source.createdAt, cached.fetchedAt), songs: songs ?? [] };
    });
  }

  /** 封面优先使用发现摘要，封面请求不下载完整歌单曲目或音频。 */
  public async getDiscoveryPlaylistCover(libraryId: string, userId: string, playlistId: string): Promise<string> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const accountKey = this.neteaseAccountKey(runtime);
      const remoteId = this.playlistRemoteId(runtime, playlistId);
      const detail = this.discoveryPlaylistDetails.get(`${libraryId}:${remoteId}`);
      const discoveryCache = this.discoveryPlaylists.get(libraryId);
      const summary = discoveryCache?.accountKey === accountKey && discoveryCache.expiresAt > Date.now()
        ? discoveryCache.playlists.find((playlist) => playlist.id === remoteId) : undefined;
      const cachedArtwork = summary?.artwork ?? (detail?.accountKey === accountKey && detail.expiresAt > Date.now() ? detail.playlist.artwork : null);
      if (cachedArtwork) return cachedArtwork;
      const discovery = await this.readDiscoveryPlaylists(runtime, signal, generation);
      const playlist = discovery.playlists.find((playlist) => playlist.id === remoteId);
      if (!playlist?.artwork) throw new ApiError(404, "content_music_playlist_cover_missing", "网易歌单封面暂时不可用");
      return playlist.artwork;
    });
  }

  /** 读取当前库自己的实体定位，不能用其他音乐库条目请求此源。 */
  private async item(libraryId: string, userId: string, itemId: string, instanceId: string): Promise<{ record: MediaItemRecord; remoteId: string; kind: ContentMusicRemoteKind; loaded: boolean }> {
    const record = await this.repository.getCatalogItem(itemId, userId);
    const source = record.metadata.contentSource && typeof record.metadata.contentSource === "object" ? record.metadata.contentSource as Record<string, unknown> : {};
    const expectedKind = record.itemType === "music.track" ? "song" : record.itemType === "music.album" ? "album" : record.itemType === "music.artist" ? "artist" : null;
    if (record.libraryId !== libraryId || record.mediaType !== "music" || source.instanceId !== instanceId || source.remoteKind !== expectedKind || !expectedKind) throw new ApiError(404, "content_music_item_not_found", "此音乐条目不属于当前内容源库");
    return { record, remoteId: neteaseRemoteId(source.remoteItemId), kind: expectedKind, loaded: source.detailsLoaded === true };
  }

  /** 源搜索快照进入专辑或艺术家详情时补曲目、专辑关系，稳定 ID 保持不变。 */
  private async hydrate(runtime: MusicRuntimeContext, itemId: string, signal: AbortSignal, generation: number): Promise<void> {
    const item = await this.item(runtime.libraryId, runtime.userId, itemId, runtime.source.id);
    if (item.loaded) return;
    const common = { database: this.database, repository: this.repository, userId: runtime.userId, libraryId: runtime.libraryId, instanceId: runtime.source.id, beforeWrite: this.beforeWrite(runtime, signal, generation) };
    if (item.kind === "song") {
      const songs = await runtime.adapter.songs([item.remoteId], signal);
      if (!songs.length) throw new ApiError(404, "content_music_song_missing", "网易歌曲不存在或暂时不可访问");
      await persistContentMusic({ ...common, songs });
    } else if (item.kind === "album") {
      const content = await runtime.adapter.album(item.remoteId, signal);
      await persistContentMusic({ ...common, albums: [content.album], songs: content.songs });
    } else {
      const content = await runtime.adapter.artist(item.remoteId, signal);
      await persistContentMusic({ ...common, artists: [content.artist], albums: content.albums, loadedArtistIds: [content.artist.id] });
    }
  }

  /** 协议详情入口按需补齐源目录，已完整加载的条目继续读取本地索引。 */
  public async hydrateItem(libraryId: string, userId: string, itemId: string): Promise<void> {
    return this.enqueue(libraryId, async (signal, generation) => { await this.hydrate(await this.context(libraryId, userId), itemId, signal, generation); });
  }

  /** 即时解析音频并记录真实格式资料，完整签名地址只返回给本次协议请求。 */
  public async resolveSong(libraryId: string, userId: string, itemId: string, maxBitRate?: number, parentSignal?: AbortSignal): Promise<ContentMusicPlayback> {
    return this.enqueue(libraryId, async (signal, generation) => {
      const runtime = await this.context(libraryId, userId);
      const item = await this.item(libraryId, userId, itemId, runtime.source.id);
      if (item.kind !== "song") throw new ApiError(404, "content_music_song_missing", "此条目不是可播放歌曲");
      if (runtime.account?.status === "expired") throw new ApiError(403, "content_music_netease_login_expired", "网易云登录已失效，请在云助手重新扫码登录");
      let playback: NeteasePlayback;
      try {
        playback = await runtime.adapter.resolveSong(item.remoteId, maxBitRate, signal);
      } catch (error) {
        // 仅原站明确报告登录失效时更新状态，歌曲受限或网络失败保留原登录。
        if (error instanceof ApiError && error.code === "content_music_netease_login_expired" && runtime.account) {
          await this.saveNeteaseAccount(libraryId, userId, { ...runtime.account, status: "expired", checkedAt: new Date().toISOString() }, signal, generation);
        }
        throw error;
      }
      const beforeWrite = this.beforeWrite(runtime, signal, generation);
      await beforeWrite();
      const metadata = { ...item.record.metadata, audioContainer: playback.suffix, audioBitRate: Math.round(playback.bitRate * 1000), audioSize: playback.size };
      if (JSON.stringify(metadata) !== JSON.stringify(item.record.metadata)) {
        await this.database.query("media_items").where({ id: itemId, user_id: userId, library_id: libraryId }).whereNull("deleted_at").update({ metadata_json: JSON.stringify(metadata), updated_at: new Date().toISOString() });
        await beforeWrite();
        await this.repository.publishContentSourceCatalogChanges(userId, libraryId, [itemId]);
      }
      return { ...playback, mode: runtime.configuration.playbackMode };
    }, new AbortController(), parentSignal);
  }

  /** 歌词按稳定歌曲定位实时获取，不要求歌曲有网盘文件记录。 */
  public async lyrics(libraryId: string, userId: string, itemId: string): Promise<string> {
    return this.enqueue(libraryId, async (signal) => {
      const runtime = await this.context(libraryId, userId);
      const item = await this.item(libraryId, userId, itemId, runtime.source.id);
      if (item.kind !== "song") throw new ApiError(404, "content_music_song_missing", "此条目不是歌曲");
      return runtime.adapter.lyrics(item.remoteId, signal);
    });
  }
}
