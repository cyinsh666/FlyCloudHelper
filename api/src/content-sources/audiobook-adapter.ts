import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import type { PythonSpiderRuntime } from "./python-runtime.js";
import type { ContentSourceCategory } from "./types.js";
import { AUDIOBOOK_SEARCH_CATEGORY, type AudiobookSourceCard, type AudiobookSourceCategory, type AudiobookSourceDetail, type AudiobookSourceManifest, type AudiobookSourcePage, type AudiobookSourceTrack } from "./audiobook-types.js";

/** Spider 返回值必须是对象或明确的 JSON 对象文本。 */
function objectResult(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new ApiError(502, "audiobook_source_result_invalid", "听书源没有返回有效 JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "audiobook_source_result_invalid", "听书源返回格式无效");
  return value as Record<string, unknown>;
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
  // 关键变量：只在内存短暂保存详情及播放器输入，Range 重试不重复枚举整本章节。
  private readonly detailCache = new Map<string, { expiresAt: number; detail: AudiobookSourceDetail }>();
  private readonly detailRequests = new Map<string, Promise<AudiobookSourceDetail>>();
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
  public clearDetails(): void { this.cacheGeneration += 1; this.detailCache.clear(); this.detailRequests.clear(); }

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
    })();
    try { await this.scriptReady; } catch (error) { this.scriptReady = null; throw error; }
  }

  /** 初始化由宿主保证幂等，取消后下一次调用仍恢复同一初始化配置。 */
  private async call(method: string, args: unknown[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    this.requireActive();
    await this.ensureScript();
    this.requireActive();
    await this.runtime.invoke(this.sessionId, this.scriptPath, "init", [this.manifest.pythonConfig?.extend ?? ""], signal);
    this.requireActive();
    const result = await this.runtime.invoke(this.sessionId, this.scriptPath, method, args, signal);
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
  public async detail(remoteBookId: string, signal?: AbortSignal): Promise<AudiobookSourceDetail> {
    signal?.throwIfAborted();
    this.requireActive();
    const now = Date.now();
    for (const [id, cached] of this.detailCache) if (cached.expiresAt <= now) this.detailCache.delete(id);
    const cached = this.detailCache.get(remoteBookId);
    if (cached) return cached.detail;
    let request = this.detailRequests.get(remoteBookId);
    if (!request) {
      const generation = this.cacheGeneration;
      request = this.loadDetail(remoteBookId, signal).then((detail) => {
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
  private async loadDetail(remoteBookId: string, signal?: AbortSignal): Promise<AudiobookSourceDetail> {
    const result = await this.call("detailContent", [[remoteBookId]], signal);
    if (!Array.isArray(result.list)) throw new ApiError(502, "audiobook_source_detail_invalid", "听书源没有返回详情列表");
    const raw = result.list.find((entry) => entry && typeof entry === "object" && String((entry as Record<string, unknown>).vod_id ?? "") === remoteBookId) as Record<string, unknown> | undefined;
    if (!raw) throw new ApiError(404, "audiobook_source_book_missing", "听书源作品已不存在或暂不可用");
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
      return { id, title: text(row.title) || id, duration, mimeType, playbackId: row.playbackId, flag: text(row.flag) || "audiobook" };
    });
    return { ...this.card(raw), tracks };
  }

  /** 每次播放重新执行播放器，源要求的额外请求头仅在本次流访问中使用。 */
  public async playback(track: AudiobookSourceTrack, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; mimeType: string }> {
    const result = await this.call("playerContent", [track.flag, track.playbackId, []], signal);
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
    const declaredMime = String(result.mimeType ?? track.mimeType).toLowerCase();
    return { url: url.href, headers, mimeType: /^audio\/[a-z0-9.+-]+$/u.test(declaredMime) ? declaredMime : track.mimeType };
  }
}
