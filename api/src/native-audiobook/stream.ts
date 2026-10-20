import type { FastifyReply, FastifyRequest } from "fastify";
import { parseJsonObject, type MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import { openMusicFileStream } from "../music/file-stream.js";
import { validateProviderUrl } from "../providers/network.js";
import type { ProviderFileStreamAccess } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import { buildUpstreamHeaders, copyMediaResponseHeaders, resolveRelayAccess, type RelayLibraryRow } from "../routes/media-stream-routes.js";
import type { NativeAccess } from "./access.js";
import { nativeHash } from "./store.js";
import type { NativeContext } from "./types.js";

/** 只在内存使用的当前音频输入；绝不写进播放会话、章节或日志。 */
export interface NativePlayable {
  access: ProviderFileStreamAccess;
  mimeType: string;
  durationSeconds: number | null;
  audioStartOffsetSeconds: number;
  audioEndOffsetSeconds: number | null;
  independentFile: boolean;
  resourceIdentity: string;
  fileName: string;
  sourceVersion: string | null;
  localCatalogRevision: string | null;
}
/** 缓存记录同时绑定来源凭据、稳定资源和请求模式。 */
interface CachedPlayable { value?: NativePlayable; promise?: Promise<NativePlayable>; expiresAt: number; controller: AbortController; foreground: number; prefetch: number; }
/** 调用方的临时订阅独立，取消一个消费者不回收正在运行的 Python 实例。 */
interface PlayableSubscription { promise: Promise<NativePlayable>; cancel: () => void; }
/** 每个章会话保留上游资源校验信息，地址更新时不能盲目续接旧字节。 */
interface ResourceValidator { etag: string | null; modified: string | null; length: string | null; urlHash: string; expiresAt: number; }

/** 读取真实时长，未知保留 null，不能把零变成可用全书时间轴。 */
function knownSeconds(value: unknown): number | null { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? seconds : null; }

/** 原生协议复用底层 Provider 网络能力，独立管理单章临时缓存和消费者。 */
export class NativeAudioStream {
  private readonly cache = new Map<string, CachedPlayable>();
  private readonly requests = new Set<AbortController>();
  private readonly validators = new Map<string, ResourceValidator>();
  public constructor(private readonly runtime: ApiRuntime, private readonly access: NativeAccess) {}

  /** 仅查询当前章的实际音频文件，跳过通用仓储对内嵌全目录和媒体探测的展开。 */
  private async physicalFile(context: NativeContext, chapter: MediaItemRecord): Promise<Record<string, unknown>> {
    const physicalId = typeof chapter.metadata.nativePhysicalChapterId === "string" ? chapter.metadata.nativePhysicalChapterId : chapter.id;
    const query = this.runtime.database.query("file_links as fl").join("source_files as f", "f.id", "fl.source_file_id").join("library_sources as ls", "ls.id", "f.library_source_id").leftJoin("cloud_services as s", "s.id", "ls.service_id")
      .where({ "fl.item_id": physicalId, "fl.user_id": context.service.OwnerUserId, "ls.user_id": context.service.OwnerUserId, "ls.library_id": chapter.libraryId, "ls.status": "active", "f.status": "active" })
      .where((active) => active.where((owned) => owned.where({ "ls.source_mode": "owned_copy", "ls.connection_status": "valid" }))
        .orWhere((linked) => linked.where({ "ls.source_mode": "linked_service", "s.connection_status": "valid" }).whereIn("s.status", ["active", "scanning"])))
      .select("f.id as fileId", "f.library_source_id as librarySourceId", "f.name", "f.size", "f.modified_at as modifiedAt", "f.locator_json as sourceLocatorJson", "fl.locator_json as linkLocatorJson")
      .orderBy("ls.sort_order", "asc").orderBy("f.path", "asc").orderBy("f.id", "asc");
    if (typeof chapter.metadata.nativeFileId === "string") query.where("f.id", chapter.metadata.nativeFileId);
    const row = await query.first();
    if (!row) throw new ApiError(404, "chapter_unavailable", "章节没有当前可用的音频文件");
    return { ...row, playbackLocator: { ...parseJsonObject(row.linkLocatorJson), ...parseJsonObject(row.sourceLocatorJson) } };
  }

  /** 来源配置或凭据变化会更换缓存作用域，不复用旧的登录 Cookie。 */
  private async scope(context: NativeContext, chapter: MediaItemRecord, mode: string): Promise<{ key: string; sourceVersion: string | null }> {
    let sourceRevision: unknown = chapter.updatedAt;
    let sourceVersion: string | null = null;
    if (String(chapter.libraryKind) === "content_source_audiobook") {
      sourceVersion = await this.access.sourceVersion(context, chapter.libraryId);
      sourceRevision = sourceVersion;
    } else {
      const file = await this.physicalFile(context, chapter);
      const source = await this.runtime.repository.getLibrarySource(String(file.librarySourceId), context.service.OwnerUserId);
      if (source.status !== "active" || source.serviceStatus !== null && !["active", "scanning"].includes(source.serviceStatus)) throw new ApiError(503, "source_unavailable", "音频所属来源暂不可用");
      sourceRevision = [source.id, source.credentialRevision, file.fileId, file.modifiedAt, file.size];
    }
    return { key: `${nativeHash(JSON.stringify([context.service.ServiceId, context.account.AccountId, context.authSession.AuthSessionId, context.service.PermissionsRevision, context.account.PermissionsRevision, chapter.libraryId, chapter.id, chapter.updatedAt, chapter.metadata.nativeLocalCatalogRevision ?? null, sourceRevision]))}:${mode}`, sourceVersion };
  }

  /** 只解析一个已有稳定身份的章，不读取全书 filesForBook 或详情。 */
  private async resolveFresh(context: NativeContext, chapter: MediaItemRecord, priority: "foreground" | "prefetch", signal: AbortSignal, sourceVersion: string | null): Promise<NativePlayable> {
    await this.access.assertLibrary(context, chapter.libraryId);
    const metadata = chapter.metadata;
    const start = typeof metadata.audioStartOffsetSeconds === "number" && metadata.audioStartOffsetSeconds >= 0 ? metadata.audioStartOffsetSeconds : 0;
    const end = typeof metadata.audioEndOffsetSeconds === "number" && metadata.audioEndOffsetSeconds > start ? metadata.audioEndOffsetSeconds : null;
    const duration = end === null ? knownSeconds(Number(metadata.durationMs ?? 0) / 1000) : end - start;
    if (String(chapter.libraryKind) === "content_source_audiobook") {
      if (await this.access.sourceVersion(context, chapter.libraryId) !== sourceVersion) throw new ApiError(409, "source_changed", "听书来源已变化，请重新取址");
      const result = await this.runtime.contentAudiobooks.resolveChapterPlayback(chapter.libraryId, context.service.OwnerUserId, chapter.id, { signal, priority });
      if (await this.access.sourceVersion(context, chapter.libraryId) !== sourceVersion) throw new ApiError(409, "source_changed", "听书来源已变化，请重新取址");
      return { access: { url: result.url, headers: result.headers, expiresAt: null }, mimeType: /^audio\//i.test(result.mimeType) ? result.mimeType : "application/octet-stream", durationSeconds: duration, audioStartOffsetSeconds: start, audioEndOffsetSeconds: end, independentFile: start === 0 && end === null, resourceIdentity: nativeHash(JSON.stringify([chapter.id, chapter.updatedAt])), fileName: chapter.title, sourceVersion, localCatalogRevision: null };
    }
    const file = await this.physicalFile(context, chapter);
    const source = await this.runtime.repository.getLibrarySource(String(file.librarySourceId), context.service.OwnerUserId);
    if (source.libraryId !== chapter.libraryId || source.status !== "active" || source.serviceStatus !== null && !["active", "scanning"].includes(source.serviceStatus)) throw new ApiError(503, "source_unavailable", "音频所属来源暂不可用");
    const library: RelayLibraryRow = { id: chapter.libraryId, library_source_id: source.id, service_id: source.serviceId ?? "", provider_type: source.providerType, service_status: source.serviceStatus ?? "active", credential_revision: source.credentialRevision, relay_playback_enabled: true };
    const locator = file.playbackLocator && typeof file.playbackLocator === "object" ? file.playbackLocator as Record<string, unknown> : {};
    const access = await resolveRelayAccess(this.runtime, library, context.service.OwnerUserId, locator, signal);
    const suffix = String(file.name).split(".").pop()?.toLowerCase();
    const mime = ({ mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" } as Record<string, string>)[suffix ?? ""] ?? "application/octet-stream";
    return { access, mimeType: mime, durationSeconds: duration, audioStartOffsetSeconds: start, audioEndOffsetSeconds: end, independentFile: start === 0 && end === null, resourceIdentity: nativeHash(JSON.stringify([chapter.id, file.fileId, file.modifiedAt, file.size])), fileName: String(file.name ?? chapter.title), sourceVersion: null, localCatalogRevision: typeof metadata.nativeLocalCatalogRevision === "string" ? metadata.nativeLocalCatalogRevision : null };
  }

  /** 合并相同取址；前台加入待执行预取时把优先级提升至实际源调度层。 */
  public async subscribe(context: NativeContext, chapter: MediaItemRecord, mode: string, priority: "foreground" | "prefetch" = "foreground", force = false, signal?: AbortSignal): Promise<PlayableSubscription> {
    signal?.throwIfAborted();
    const { key, sourceVersion } = await this.scope(context, chapter, mode);
    signal?.throwIfAborted();
    let entry = this.cache.get(key);
    if (entry?.value && (entry.expiresAt <= Date.now() || force)) { this.cache.delete(key); entry = undefined; }
    if (!entry && mode === "Auto" && !force) {
      const base = key.slice(0, key.lastIndexOf(":"));
      for (const actual of ["Direct", "Relay"] as const) {
        const candidate = this.cache.get(`${base}:${actual}`);
        if (candidate?.value && candidate.expiresAt > Date.now() && this.method(context, candidate.value, "Auto") === actual) { entry = candidate; this.cache.set(key, candidate); break; }
      }
    }
    if (!entry) {
      this.trim();
      if ([...this.cache.values()].filter((value) => value.promise).length >= 64) throw new ApiError(503, "playback_resolver_busy", "当前取址请求较多，请稍后重试");
      const controller = new AbortController();
      entry = { expiresAt: 0, controller, foreground: 0, prefetch: 0 };
      this.cache.set(key, entry);
      const current = entry;
      current.promise = this.resolveFresh(context, chapter, priority, controller.signal, sourceVersion).then((value) => {
        if (controller.signal.aborted) throw new ApiError(499, "request_cancelled", "播放取址已取消");
        current.value = value;
        const sourceExpiry = value.access.expiresAt ? Date.parse(value.access.expiresAt) - 10000 : Infinity;
        const configured = Number(process.env.FLYAUDIOBOOK_PLAYBACK_CACHE_SECONDS ?? 60);
        const ttl = Number.isFinite(configured) ? Math.min(300, Math.max(5, configured)) * 1000 : 60000;
        current.expiresAt = Math.min(Date.now() + ttl, Number.isFinite(sourceExpiry) ? sourceExpiry : Infinity);
        current.promise = undefined;
        // 关键变量：Auto的最终模式单独绑定，显式播放与自动切章可复用相同实际模式的预解析。
        this.cache.set(`${key.slice(0, key.lastIndexOf(":"))}:${this.method(context, value, mode)}`, current);
        return value;
      }).catch((error) => { if (this.cache.get(key) === current) this.cache.delete(key); throw error; });
    }
    const current = entry;
    current[priority] += 1;
    if (priority === "foreground" && current.promise && String(chapter.libraryKind) === "content_source_audiobook") this.runtime.contentAudiobooks.promoteChapterPlayback(chapter.libraryId, context.service.OwnerUserId, chapter.id);
    let cancelled = false;
    let rejectWait: (error: Error) => void = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    /** 一个消费者取消只调整自己的引用，不中止仍有等待者的取址。 */
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      rejectWait(new ApiError(499, "request_cancelled", "本次播放取址等待已取消"));
      current[priority] = Math.max(0, current[priority] - 1);
      if (!current.foreground && current.prefetch && current.promise && String(chapter.libraryKind) === "content_source_audiobook") this.runtime.contentAudiobooks.setChapterPlaybackPriority(chapter.libraryId, context.service.OwnerUserId, chapter.id, "prefetch");
      if (!current.foreground && !current.prefetch && current.promise) { current.controller.abort(); if (this.cache.get(key) === current) this.cache.delete(key); }
    };
    /** 每个消费者等待期限独立，超时不会回收仍被其他消费者使用的源执行。 */
    const timer = setTimeout(cancel, priority === "foreground" ? 45000 : 30000);
    timer.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    const promise = Promise.race([current.value ? Promise.resolve(current.value) : current.promise!, cancellation]).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); cancel(); });
    this.trim();
    return { promise, cancel };
  }

  /** 短时缓存最多保存256个输入，不让数千章目录扩大常驻内存。 */
  private trim(): void {
    for (const [key, value] of this.cache) if (!value.promise && value.expiresAt <= Date.now()) this.cache.delete(key);
    if (this.cache.size <= 256) return;
    for (const [key, value] of this.cache) { if (!value.promise) this.cache.delete(key); if (this.cache.size <= 256) break; }
  }

  /** 当前章创建及媒体请求共用同一缓存，公开结果不含上游 URL。 */
  public async resolve(context: NativeContext, chapter: MediaItemRecord, mode: string, force = false, signal?: AbortSignal): Promise<NativePlayable> { return (await this.subscribe(context, chapter, mode, "foreground", force, signal)).promise; }

  /** Auto 才允许根据源请求头回退中转；显式直连不可用时返回原因。 */
  public method(context: NativeContext, input: NativePlayable, requested: string): "Direct" | "Relay" {
    const privateHeaders = Object.keys(input.access.headers).length > 0;
    if (requested === "Direct") { if (privateHeaders) throw new ApiError(422, "direct_playback_unsupported", "当前来源需要服务端请求头，请选择中转播放"); return "Direct"; }
    if (requested === "Relay" || context.service.RelayPlaybackEnabled || privateHeaders) return "Relay";
    return "Direct";
  }

  /** 中转只转发真实 HTTP 能力，不伪造 Range、时长或分章裁剪。 */
  public async send(context: NativeContext, chapter: MediaItemRecord, mode: "Direct" | "Relay", request: FastifyRequest, reply: FastifyReply, download: boolean, validate: () => Promise<void>, cacheMode: string = mode, resource?: { key: string; identity: string }): Promise<FastifyReply> {
    await validate();
    if (download && !context.account.CanDownload) throw new ApiError(403, "download_forbidden", "当前账号没有下载权限");
    const range = request.headers.range;
    if (typeof range === "string" && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.includes(","))) throw new ApiError(416, "range_not_supported", "仅支持单段有效字节范围");
    const controller = new AbortController();
    this.requests.add(controller);
    /** 断开请求立即停止上游流；周期复核只终止本连接。 */
    const abort = (): void => controller.abort();
    const timer = setInterval(() => { void validate().catch(abort); }, 5000);
    timer.unref();
    /** 每条完成或失败路径都清理监听和认证复核计时器。 */
    const cleanup = (): void => { clearInterval(timer); this.requests.delete(controller); request.raw.off("aborted", abort); reply.raw.off("close", abort); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const initial = await this.resolve(context, chapter, cacheMode, false, controller.signal);
      if (range && resource && initial.resourceIdentity !== resource.identity) throw new ApiError(409, "audio_resource_changed", "当前音频资源已改变，请重新创建播放会话");
      if (download && !initial.independentFile) throw new ApiError(422, "chapter_download_unsupported", "该逻辑章节位于共享音频中，暂不支持单章下载");
      await validate();
      if (mode === "Direct" && !download) {
        this.method(context, initial, "Direct");
        await validateProviderUrl(initial.access.url, { allowInsecureHttp: this.runtime.config.allowInsecureProviderHttp });
        cleanup();
        reply.header("Cache-Control", "private, no-store");
        return reply.redirect(initial.access.url, 307);
      }
      /** 地址失效最多刷新一次；旧资源字节偏移不能拼接不同的新资源。 */
      const renew = async (): Promise<ProviderFileStreamAccess> => {
        await validate();
        // 关键变量：其他Range请求已刷新成功时复用新对象，避免较迟的失效请求再次强制重取。
        const cached = await this.resolve(context, chapter, cacheMode, false, controller.signal);
        const refreshed = cached !== initial ? cached : await this.resolve(context, chapter, cacheMode, true, controller.signal);
        if (refreshed.resourceIdentity !== initial.resourceIdentity && range) throw new ApiError(409, "audio_resource_changed", "音频资源已改变，请重新创建播放会话");
        return refreshed.access;
      };
      let activeAccess = initial.access;
      /** 记录实际使用的取址，成功后核对来源返回的实体校验值。 */
      const renewTracked = async (): Promise<ProviderFileStreamAccess> => { activeAccess = await renew(); return activeAccess; };
      const priorValidator = resource ? this.validators.get(resource.key) : undefined;
      const requestHeaders = buildUpstreamHeaders(request, {});
      if (range && priorValidator && !requestHeaders["If-Range"]) {
        const validator = priorValidator.etag && !priorValidator.etag.startsWith("W/") ? priorValidator.etag : priorValidator.modified;
        if (validator) requestHeaders["If-Range"] = validator;
      }
      const upstream = await openMusicFileStream(renewTracked, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: requestHeaders }, { allowInsecureHttp: this.runtime.config.allowInsecureProviderHttp }, controller.signal, initial.access);
      if (resource && upstream.statusCode !== 416) {
        /** 只保存实体校验信息；来源签名地址仅参与内存摘要，不进入数据库或日志。 */
        const header = (name: string): string | null => { const value = upstream.headers[name]; return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? null : null; };
        const contentRange = header("content-range");
        const totalLength = contentRange ? /\/(\d+)$/.exec(contentRange)?.[1] ?? null : upstream.statusCode === 200 ? header("content-length") : null;
        const current: ResourceValidator = { etag: header("etag"), modified: header("last-modified"), length: totalLength, urlHash: nativeHash(activeAccess.url), expiresAt: Date.now() + 30 * 60000 };
        const etagChanged = priorValidator?.etag && current.etag && priorValidator.etag !== current.etag;
        const sizeChanged = priorValidator?.length && current.length && priorValidator.length !== current.length;
        const addressChanged = priorValidator && priorValidator.urlHash !== current.urlHash;
        const provenSame = priorValidator?.etag && current.etag && !current.etag.startsWith("W/") && priorValidator.etag === current.etag
          || priorValidator?.modified && current.modified === priorValidator.modified && priorValidator.length && current.length === priorValidator.length;
        if (range && priorValidator && (etagChanged || sizeChanged || addressChanged && !provenSame)) { upstream.body.destroy(); throw new ApiError(409, "audio_resource_changed", "来源音频资源已改变或无法确认一致，请重新创建会话后定位"); }
        this.validators.set(resource.key, current);
        for (const [key, value] of this.validators) if (value.expiresAt <= Date.now()) this.validators.delete(key);
        if (this.validators.size > 512) this.validators.delete(this.validators.keys().next().value!);
      }
      const typeHeader = upstream.headers["content-type"];
      const mime = Array.isArray(typeHeader) ? typeHeader[0] ?? "" : typeHeader ?? "";
      if (upstream.statusCode !== 416 && /^(?:text\/html|application\/json)(?:;|$)/i.test(mime)) { upstream.body.destroy(); throw new ApiError(502, "source_audio_response_invalid", "来源没有返回可播放音频"); }
      upstream.body.once("close", cleanup);
      upstream.body.once("error", cleanup);
      copyMediaResponseHeaders(reply, upstream.headers);
      if (upstream.statusCode !== 416 && (!mime || /^application\/octet-stream(?:;|$)/i.test(mime))) reply.type(initial.mimeType);
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(initial.fileName.slice(0, 256))}`);
      reply.code(upstream.statusCode);
      return reply.send(upstream.body);
    } catch (error) {
      cleanup();
      if (error instanceof ApiError) {
        if (error.code === "music_file_missing") throw new ApiError(error.statusCode, "source_audio_missing", "当前章节音频已不存在或暂不可用");
        if (error.code === "music_file_access_denied") throw new ApiError(error.statusCode, "source_audio_access_denied", "重新取址后仍无法读取音频，请检查来源授权或稍后重试");
        if (error.code === "music_file_read_failed") throw new ApiError(error.statusCode, "source_audio_read_failed", "当前章节音频读取失败，请稍后重试");
      }
      throw error;
    }
  }

  /** 服务关闭只清理本协议内存和上游连接，不影响 ABS 或插件进程。 */
  public close(): void { for (const entry of this.cache.values()) entry.controller.abort(); for (const controller of this.requests) controller.abort(); this.cache.clear(); this.requests.clear(); this.validators.clear(); }
}
