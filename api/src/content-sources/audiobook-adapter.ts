import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import type { PythonInvocationOptions, PythonSpiderRuntime } from "./python-runtime.js";
import type { ContentSourceCategory } from "./types.js";
import { AUDIOBOOK_SEARCH_CATEGORY, type AudiobookChapterPage, type AudiobookSourceCard, type AudiobookSourceCategory, type AudiobookSourceDetail, type AudiobookSourceManifest, type AudiobookSourcePage, type AudiobookSourceTrack } from "./audiobook-types.js";

/** Spider 返回值必须是对象或明确的 JSON 对象文本。 */
function objectResult(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new ApiError(502, "audiobook_source_result_invalid", "听书源没有返回有效 JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "audiobook_source_result_invalid", "听书源返回格式无效");
  const result = value as Record<string, unknown>;
  // 关键变量：只接受固定错误码，不将源站正文、临时地址或脚本异常直接暴露给客户端。
  if (Object.hasOwn(result, "cloud_helper_error")) {
    const detail = result.cloud_helper_error;
    if (detail && typeof detail === "object" && !Array.isArray(detail) && (detail as Record<string, unknown>).code === "rate_limited") {
      const supplied = Number((detail as Record<string, unknown>).retryAfterSeconds);
      const retryAfter = Number.isSafeInteger(supplied) && supplied >= 1 && supplied <= 3600 ? supplied : 10;
      throw new ApiError(429, "audiobook_source_rate_limited", `听书源请求过于频繁，请 ${retryAfter} 秒后重试`, [{ field: "retryAfterSeconds", message: String(retryAfter) }]);
    }
    throw new ApiError(502, "audiobook_source_call_failed", "听书源请求失败，请稍后重试");
  }
  return result;
}

/** 展示文字仅去除简单 HTML，不据标题推断远端身份。 */
function text(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").trim();
}

/** 人物数组和源明确使用的分隔文本都保留独立名称。 */
function names(value: unknown): string[] {
  const values = Array.isArray(value) ? value : text(value).split(/[,，/|]/u);
  return [...new Set(values.map(text).filter(Boolean))];
}

/** 远端 ID 必须是稳定非空文本，不能使用临时 HTTP 地址作为章节身份。 */
function identity(value: unknown, chapter = false): string {
  if (typeof value !== "string" && typeof value !== "number") throw new ApiError(502, "audiobook_source_identity_missing", "听书源缺少稳定内容标识");
  const id = String(value).trim();
  if (!id || id.length > 1024 || (chapter && /^https?:\/\//iu.test(id))) throw new ApiError(502, "audiobook_source_identity_missing", "听书源缺少稳定内容标识");
  return id;
}

/** 文件后缀仅来自源明确给出的音频 MIME，不从取址参数猜测格式。 */
export function audiobookAudioExtension(mimeType: string): string {
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return ({ "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/x-matroska": "mka", "audio/webm": "webm" } as Record<string, string>)[mime] ?? "";
}

/** 听书 Spider 复用常驻隔离宿主；每个实例有独立会话和初始化参数。 */
export class PythonAudiobookSourceAdapter {
  private readonly scriptPath: string;
  private scriptReady: Promise<void> | null = null;
  private invalidated = false;
  private cacheGeneration = 0;
  private readonly availableMethods = new Set<string>();
  // 关键变量：只在内存短暂保存详情及播放器输入，Range 重试不重复枚举整本章节。
  private readonly detailCache = new Map<string, { expiresAt: number; detail: AudiobookSourceDetail }>();
  private readonly detailRequests = new Map<string, Promise<AudiobookSourceDetail>>();
  private readonly legacyDirectories = new Map<string, { detail: AudiobookSourceDetail; snapshotId: string }>();
  public readonly sessionId: string;

  /** 脚本位置必须位于插件根目录，输入不接受远端执行路径。 */
  public constructor(private readonly manifest: AudiobookSourceManifest, private readonly runtime: PythonSpiderRuntime, instanceId: string, pluginDirectory: string) {
    const directory = path.resolve(pluginDirectory);
    this.scriptPath = path.resolve(directory, manifest.scriptFile ?? "");
    if (!manifest.scriptFile || !this.scriptPath.startsWith(`${directory}${path.sep}`)) throw new ApiError(422, "audiobook_script_path_invalid", "听书源脚本位置无效");
    this.sessionId = `audiobook:${instanceId}`;
  }

  /** 停用后旧适配器不能重新启动 Python 进程。 */
  public invalidate(): void { this.invalidated = true; this.clearDetails(); }

  /** 清库或停用丢弃短期详情，后续读取不能复用旧目录或旧播放器输入。 */
  public clearDetails(): void { this.cacheGeneration += 1; this.detailCache.clear(); this.detailRequests.clear(); this.legacyDirectories.clear(); }

  /** 异步调用前后均检查实例生命周期。 */
  private requireActive(): void {
    if (this.invalidated) throw new ApiError(409, "audiobook_source_stopped", "听书源已停止，请重新打开");
  }

  /** 首次执行核对安装摘要与脚本明确的听书声明。 */
  private async ensureScript(): Promise<void> {
    this.scriptReady ??= (async () => {
      let bytes: Buffer;
      try { bytes = await readFile(this.scriptPath); } catch { throw new ApiError(503, "python_source_script_unavailable", "Python 源脚本缺失，请重新导入"); }
      if (createHash("sha256").update(bytes).digest("hex") !== this.manifest.scriptHash) throw new ApiError(409, "python_source_script_changed", "Python 源脚本内容与安装版本不一致，请重新导入");
      const inspected = await this.runtime.inspect(this.scriptPath);
      if (inspected.mediaType !== "audiobook") throw new ApiError(422, "audiobook_source_declaration_missing", "Python 源未声明有声书能力");
      for (const method of inspected.methods) this.availableMethods.add(method);
    })();
    try { await this.scriptReady; } catch (error) { this.scriptReady = null; throw error; }
  }

  /** 初始化由宿主保证幂等，取消后下一次调用仍恢复同一初始化配置。 */
  private async call(method: string, args: unknown[], signal?: AbortSignal, options?: PythonInvocationOptions): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    this.requireActive();
    await this.ensureScript();
    this.requireActive();
    const scheduling = options ?? {};
    scheduling.discardRunningOnCancel = true;
    await this.runtime.invoke(this.sessionId, this.scriptPath, "init", [this.manifest.pythonConfig?.extend ?? ""], signal, scheduling);
    this.requireActive();
    const result = await this.runtime.invoke(this.sessionId, this.scriptPath, method, args, signal, scheduling);
    this.requireActive();
    signal?.throwIfAborted();
    return objectResult(result);
  }

  /** 分类直接使用源 ID 和名称，不借用影视分类推断规则。 */
  public async categories(signal?: AbortSignal): Promise<ContentSourceCategory[]> {
    const result = await this.call("homeContent", [false], signal);
    if (!Array.isArray(result.class)) throw new ApiError(502, "audiobook_source_categories_missing", "听书源没有返回分类");
    return result.class.map((value) => {
      const row = objectResult(value);
      return { id: identity(row.type_id), name: text(row.type_name), parentId: row.type_pid && String(row.type_pid) !== "0" ? String(row.type_pid) : null };
    }).filter((category) => category.name && category.id !== AUDIOBOOK_SEARCH_CATEGORY);
  }

  /** 分类整页读取摘要，禁止在列表阶段调用 detailContent。 */
  public async page(categoryId: string, page: number, signal?: AbortSignal): Promise<AudiobookSourcePage> {
    return this.readPage(await this.call("categoryContent", [categoryId, String(page), false, {}], signal), categoryId);
  }

  /** 实时搜索独立于本地已导入目录，缺分类时明确使用搜索虚拟归属。 */
  public async search(term: string, page = 1, signal?: AbortSignal): Promise<AudiobookSourcePage> {
    return this.readPage(await this.call("searchContent", [term, false, String(page)], signal));
  }

  /** 源总页数和原始条数独立保留，不把付费过滤后的空页当末尾。 */
  private readPage(result: Record<string, unknown>, categoryId?: string): AudiobookSourcePage {
    if (!Array.isArray(result.list) || result.list.length > 200) throw new ApiError(502, "audiobook_source_list_invalid", "听书源单页列表无效或超过 200 条");
    const declaredRaw = Number(result.raw_count ?? result.list.length);
    const rawItemCount = Number.isSafeInteger(declaredRaw) && declaredRaw >= result.list.length ? declaredRaw : result.list.length;
    const declaredPages = Number(result.pagecount);
    const sourcePageCount = Number.isSafeInteger(declaredPages) && declaredPages >= 1 ? declaredPages : result.__python_search_paged__ === false ? 1 : null;
    return { items: result.list.map((value) => this.card(objectResult(value), categoryId)), rawItemCount, sourcePageCount };
  }

  /** 提取源摘要字段，播放输入及远端音频地址不进入目录卡片。 */
  private card(raw: Record<string, unknown>, categoryId?: string): AudiobookSourceCard {
    const title = text(raw.vod_name);
    if (!title) throw new ApiError(502, "audiobook_source_title_missing", "听书源条目缺少标题");
    // 关键变量：分类页的收录与源条目主分类均为真实观察，搜索不借用当前浏览分类。
    const declaredCategory = typeof raw.type_id === "string" || typeof raw.type_id === "number" ? String(raw.type_id).trim() : "";
    const actualCategory = categoryId || declaredCategory || AUDIOBOOK_SEARCH_CATEGORY;
    const categories: AudiobookSourceCategory[] = [];
    if (categoryId && categoryId !== AUDIOBOOK_SEARCH_CATEGORY) categories.push({ id: categoryId, name: categoryId === declaredCategory ? text(raw.type_name) : "" });
    if (declaredCategory && declaredCategory !== AUDIOBOOK_SEARCH_CATEGORY && !categories.some((category) => category.id === declaredCategory)) categories.push({ id: declaredCategory, name: text(raw.type_name) });
    const categoryName = categories.find((category) => category.id === actualCategory)?.name || (actualCategory === AUDIOBOOK_SEARCH_CATEGORY ? "实时搜索" : "");
    return { id: identity(raw.vod_id), title, categoryId: actualCategory, categoryName, categories, overview: text(raw.vod_content), posterUrl: /^https?:\/\//iu.test(String(raw.vod_pic ?? "")) ? String(raw.vod_pic) : null, authors: names(raw.vod_author), narrators: names(raw.vod_narrator), genres: names(raw.vod_class) };
  }

  /** 完整详情必须显式返回稳定章节数组，不从播放字符串或标题制造章节 ID。 */
  public async detail(remoteBookId: string, signal?: AbortSignal, options?: PythonInvocationOptions): Promise<AudiobookSourceDetail> {
    signal?.throwIfAborted();
    this.requireActive();
    const now = Date.now();
    for (const [id, cached] of this.detailCache) if (cached.expiresAt <= now) this.detailCache.delete(id);
    const cached = this.detailCache.get(remoteBookId);
    if (cached) return cached.detail;
    let request = this.detailRequests.get(remoteBookId);
    if (!request) {
      const generation = this.cacheGeneration;
      request = this.loadDetail(remoteBookId, signal, options).then((detail) => {
        this.requireActive();
        if (generation !== this.cacheGeneration) return detail;
        // 最多保存八本短期详情，避免长篇章节数组无限积累。
        while (this.detailCache.size >= 8) this.detailCache.delete(this.detailCache.keys().next().value!);
        this.detailCache.set(remoteBookId, { expiresAt: Date.now() + 60000, detail });
        return detail;
      });
      this.detailRequests.set(remoteBookId, request);
      const complete = (): void => { if (this.detailRequests.get(remoteBookId) === request) this.detailRequests.delete(remoteBookId); };
      void request.then(complete, complete);
    }
    return request;
  }

  /** 真实章节详情由源显式返回，结果仅在短期内存中复用。 */
  private async loadDetail(remoteBookId: string, signal?: AbortSignal, options?: PythonInvocationOptions): Promise<AudiobookSourceDetail> {
    const result = await this.call("detailContent", [[remoteBookId]], signal, options);
    if (!Array.isArray(result.list)) throw new ApiError(502, "audiobook_source_detail_invalid", "听书源没有返回详情列表");
    const raw = result.list.find((entry) => entry && typeof entry === "object" && String((entry as Record<string, unknown>).vod_id ?? "") === remoteBookId) as Record<string, unknown> | undefined;
    if (!raw) throw new ApiError(404, "audiobook_source_book_missing", "听书源作品已不存在或暂不可用");
    return this.readDetail(raw);
  }

  /** 章节页和旧完整详情共用严格身份校验，不允许重复 ID 或临时地址充当身份。 */
  private readDetail(raw: Record<string, unknown>): AudiobookSourceDetail {
    if (!Array.isArray(raw.vod_audio_tracks) || raw.vod_audio_tracks.length > 20000) throw new ApiError(422, "audiobook_source_tracks_missing", "听书源没有返回标准音频章节列表");
    const ids = new Set<string>();
    const tracks: AudiobookSourceTrack[] = raw.vod_audio_tracks.map((value) => {
      const row = objectResult(value);
      const id = identity(row.id, true);
      if (ids.has(id)) throw new ApiError(422, "audiobook_source_track_ambiguous", "听书源返回重复章节身份，无法准确播放");
      ids.add(id);
      if (typeof row.playbackId !== "string" || !row.playbackId || row.playbackId.length > 32768) throw new ApiError(422, "audiobook_source_playback_missing", "听书章节缺少播放器输入");
      const declared = row.duration == null ? null : Number(row.duration);
      const duration = declared !== null && Number.isFinite(declared) && declared > 0 ? declared : null;
      const mimeType = typeof row.mimeType === "string" && /^audio\/[a-z0-9.+-]+$/iu.test(row.mimeType) ? row.mimeType.toLowerCase() : "application/octet-stream";
      const order = Number(row.order);
      return { id, title: text(row.title) || id, duration, mimeType, playbackId: row.playbackId, flag: text(row.flag) || "audiobook", ...(Number.isSafeInteger(order) && order > 0 ? { order } : {}) };
    });
    return { ...this.card(raw), tracks };
  }

  /** 新 Spider 每次只取一页；旧 Spider 明确保留完整详情回退，不冒充上游分页。 */
  public async chapterPage(remoteBookId: string, page: number, signal?: AbortSignal): Promise<AudiobookChapterPage> {
    await this.ensureScript();
    if (!this.availableMethods.has("audioChapterPage")) {
      let snapshot = this.legacyDirectories.get(remoteBookId);
      if (!snapshot) {
        if (this.legacyDirectories.size >= 4) throw new ApiError(503, "audiobook_directory_busy", "旧听书源正在整理其他作品，请稍后重试");
        const detail = await this.detail(remoteBookId, signal, { priority: 3 });
        snapshot = { detail, snapshotId: createHash("sha256").update(JSON.stringify(detail.tracks.map((track) => [track.id, track.title, track.duration, track.order]))).digest("hex") };
        this.legacyDirectories.set(remoteBookId, snapshot);
      }
      const complete = snapshot.detail;
      const size = 100;
      return { detail: { ...complete, tracks: complete.tracks.slice((page - 1) * size, page * size).map((track, index) => ({ ...track, order: track.order ?? (page - 1) * size + index + 1 })) }, page, pageCount: Math.max(1, Math.ceil(complete.tracks.length / size)), rawItemCount: Math.min(size, Math.max(0, complete.tracks.length - (page - 1) * size)), authoritative: true, snapshotId: snapshot.snapshotId };
    }
    const result = await this.call("audioChapterPage", [remoteBookId, page], signal, { priority: 3 });
    if (!Array.isArray(result.list)) throw new ApiError(502, "audiobook_source_detail_invalid", "听书章节页没有返回作品资料");
    const raw = result.list.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>).vod_id) === remoteBookId);
    if (!raw || typeof raw !== "object") throw new ApiError(502, "audiobook_source_detail_invalid", "听书章节页作品身份不匹配");
    const detail = this.readDetail(raw as Record<string, unknown>);
    const pageCount = Number(result.pagecount);
    const rawItemCount = Number(result.raw_count);
    if (detail.tracks.length > 200 || !Number.isSafeInteger(pageCount) || pageCount < page || pageCount > 1000 || !Number.isSafeInteger(rawItemCount) || rawItemCount < detail.tracks.length) throw new ApiError(502, "audiobook_source_page_invalid", "听书章节分页范围无效");
    if (detail.tracks.some((track) => track.order === undefined)) throw new ApiError(502, "audiobook_source_order_missing", "听书章节页缺少书内真实顺序");
    const snapshotId = typeof result.snapshot_id === "string" && result.snapshot_id.length <= 256 ? result.snapshot_id : null;
    return { detail, page, pageCount, rawItemCount, authoritative: result.authoritative === true && Boolean(snapshotId), snapshotId };
  }

  /** 一轮目录完成或失败后释放旧源的完整快照，不让分批让队造成TTL失效后反复抓全书。 */
  public releaseChapterDirectory(remoteBookId: string): void { this.legacyDirectories.delete(remoteBookId); }

  /** 已索引章节直接使用永久身份取址；只对没有扩展能力的旧源读取完整详情。 */
  public async resolveChapterPlayback(remoteBookId: string, remoteChapterId: string, signal?: AbortSignal, options?: PythonInvocationOptions): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    await this.ensureScript();
    if (this.availableMethods.has("audioChapterPlayback")) return this.readPlayback(await this.call("audioChapterPlayback", [remoteBookId, remoteChapterId], signal, options), "application/octet-stream");
    const detail = await this.detail(remoteBookId, signal, options);
    const track = detail.tracks.find((entry) => entry.id === remoteChapterId);
    if (!track) throw new ApiError(410, "audiobook_chapter_gone", "源站已移除此音频章节");
    return this.playback(track, signal, options);
  }

  /** 提升已排队的初始化或取址调用；调用者仍然共享原有结果。 */
  public promotePlayback(queueKey: string): void { this.runtime.promote(this.sessionId, queueKey); }

  /** 同一共享请求的消费者变化只调整待执行优先级。 */
  public setPlaybackPriority(queueKey: string, priority: number): void { this.runtime.setPriority(this.sessionId, queueKey, priority); }

  /** 每次播放重新执行播放器，源要求的额外请求头仅在本次流访问中使用。 */
  public async playback(track: AudiobookSourceTrack, signal?: AbortSignal, options?: PythonInvocationOptions): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    const result = await this.call("playerContent", [track.flag, track.playbackId, []], signal, options);
    return this.readPlayback(result, track.mimeType);
  }

  /** 取址响应只允许 HTTP 音频及有效请求头，不保存 Spider 原始播放器输入。 */
  private readPlayback(result: Record<string, unknown>, fallbackMime: string): { url: string; headers: Record<string, string>; mimeType: string } {
    if (result.parse !== undefined && result.parse !== 0 && result.parse !== "0") throw new ApiError(422, "audiobook_source_parse_required", "此听书章节需要额外网页解析，当前源无法直接播放");
    let url: URL;
    try { url = new URL(String(result.url ?? "")); } catch { throw new ApiError(502, "audiobook_source_playback_invalid", "听书源未返回有效音频地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ApiError(422, "audiobook_source_playback_unsupported", "听书源返回的音频地址不受支持");
    let rawHeaders: unknown = result.header ?? result.headers ?? {};
    if (typeof rawHeaders === "string") { try { rawHeaders = JSON.parse(rawHeaders); } catch { throw new ApiError(502, "audiobook_source_headers_invalid", "听书源播放请求头无效"); } }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(objectResult(rawHeaders))) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(key) || typeof value !== "string" || /[\r\n]/u.test(value)) throw new ApiError(502, "audiobook_source_headers_invalid", "听书源播放请求头无效");
      if (!["host", "content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) headers[key] = value;
    }
    const declaredMime = String(result.mimeType ?? fallbackMime).toLowerCase();
    return { url: url.href, headers, mimeType: /^audio\/[a-z0-9.+-]+$/u.test(declaredMime) ? declaredMime : fallbackMime };
  }
}
