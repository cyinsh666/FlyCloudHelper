import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import { contentKey } from "./cms-adapter.js";
import { isSpiderProxyUrl, readSpiderProxyInstance } from "./spider-proxy.js";
import { resolveSpiderWebPlayback } from "./spider-web-parser.js";
import type { CmsContentItem, CmsContentPage, CmsPlaybackEpisode, ContentSourceCategory, ContentSourceManifest, ContentVideoContainer, VideoSourceAdapter } from "./types.js";

/** Python 与 JavaScript 宿主都通过同一有界调用接口返回 Spider 结果。 */
export interface SpiderSourceRuntime {
  /** 按源实例调用固定接口，取消信号由具体运行时释放进程和网络资源。 */
  invoke(instanceId: string, scriptPath: string, method: string, args: unknown[], signal?: AbortSignal,
    options?: { priority?: number; discardRunningOnCancel?: boolean }): Promise<unknown>;
}

/** Spider 只接受字典或明确的 JSON 文本，不把其他返回值猜成内容数据。 */
function objectResult(value: unknown, sourceKind: "python" | "javascript"): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new ApiError(502, `${sourceKind}_source_result_invalid`, "Spider 源没有返回有效 JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, `${sourceKind}_source_result_invalid`, "Spider 源没有返回内容对象");
  return value as Record<string, unknown>;
}

/** 目录文字去除 HTML，保留源站的实际名称。 */
function text(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").trim();
}

/** 根据源明确返回的地址或类型读取格式，尚未取址时保持未知。 */
function mediaContainer(value: string, declaredType?: unknown): ContentVideoContainer {
  if (declaredType === "hls" || declaredType === "m3u8") return "hls";
  if (declaredType === "mp4") return "mp4";
  try {
    const url = new URL(value);
    if (/\.m3u8$/iu.test(url.pathname)) return "hls";
    if (/\.mp4$/iu.test(url.pathname)) return "mp4";
  } catch { /* Spider 分集标识在播放时解析，不伪装成网址。 */ }
  return "unknown";
}

/** 分集身份与 CMS 保持相同规则，签名地址及 Spider 标识不参与稳定键。 */
function episodeIdentity(name: string, index: number): { key: string; season: number; episode: number } {
  const explicit = name.match(/S(\d+)\s*E(\d+)/iu);
  if (explicit) return { key: `s${Number(explicit[1])}e${Number(explicit[2])}`, season: Number(explicit[1]), episode: Number(explicit[2]) };
  const numbered = name.match(/^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/u);
  const episode = numbered ? Number(numbered[1]) : index + 1;
  return { key: numbered ? `s1e${episode}` : `label_${contentKey(name)}`, season: 1, episode };
}

/** Spider 详情中的地址槽保存取址输入；无论是否看似 URL，都交给 playerContent。 */
function readEpisodes(raw: Record<string, unknown>): CmsPlaybackEpisode[] {
  const flags = String(raw.vod_play_from ?? "").split("$$$");
  const groups = String(raw.vod_play_url ?? "").split("$$$");
  const episodes: CmsPlaybackEpisode[] = [];
  for (const [lineIndex, group] of groups.entries()) {
    const lineName = flags[lineIndex]?.trim();
    if (!lineName) continue;
    const keys = new Set<string>(); // 关键变量：同线路的重复身份不能被猜成不同媒体版本。
    for (const [index, entry] of group.split("#").entries()) {
      const separator = entry.indexOf("$");
      if (separator <= 0) continue;
      const name = text(entry.slice(0, separator));
      const playbackId = entry.slice(separator + 1).trim();
      if (!name || !playbackId) continue;
      const identity = episodeIdentity(name, index);
      if (keys.has(identity.key)) throw new ApiError(422, "content_episode_ambiguous", "源站同一线路的单集标识重复，无法准确播放");
      keys.add(identity.key);
      episodes.push({ lineName, name, episodeKey: identity.key, seasonNumber: identity.season, episodeNumber: identity.episode, playbackId, container: mediaContainer(playbackId) });
    }
  }
  return episodes;
}

/** 常驻 Spider 实例承接分类、轻量卡片、按需详情、搜索与异步取址，不依赖网盘文件。 */
export class SpiderVideoSourceAdapter implements VideoSourceAdapter {
  private readonly scriptPath: string;
  private scriptReady: Promise<void> | null = null;
  private categoryCatalog: ContentSourceCategory[] = [];
  private readonly categoryHints = new Map<string, string>();
  // 关键变量：失效后旧请求不能重新创建源进程，重新启用由管理器创建新的适配器。
  private invalidated = false;

  /** 每个源实例拥有自己的适配器和 Spider 会话，脚本路径由安装摘要确定。 */
  public constructor(private readonly manifest: ContentSourceManifest, private readonly runtime: SpiderSourceRuntime, private readonly instanceId: string, pluginDirectory: string, private readonly allowInsecureHttp = false) {
    this.scriptPath = path.resolve(pluginDirectory, manifest.scriptFile ?? "");
  }

  /** 保留各运行时的错误码，目录和播放字段只实现一套解释规则。 */
  private get sourceKind(): "python" | "javascript" { return this.manifest.adapter === "catvod_js" ? "javascript" : "python"; }

  /** 分类映射与宿主共享同一内存清单，不改变数据库里安装的原始版本。 */
  public get sourceManifest(): ContentSourceManifest { return this.manifest; }

  /** 停用或清理时使旧适配器永久失效，阻止尚未完成的文件读取继续启动宿主。 */
  public invalidate(): void {
    this.invalidated = true;
  }

  /** 异步阶段前后均检查本实例是否仍可调用，不把旧适配器复用于新会话。 */
  private requireActive(): void {
    if (this.invalidated) throw new ApiError(409, "content_source_disabled", "当前 Spider 源会话已停止，请重新打开");
  }

  /** 详情缺少分类时恢复已入库的真实分类，进程重启后不要求先浏览原分类页。 */
  public useItemCategory(remoteItemId: string, categoryId: string): void {
    if (remoteItemId && categoryId) this.categoryHints.set(remoteItemId, categoryId);
  }

  /** 重启后使用已保存的真实分类树恢复目录类型，无需先请求源首页。 */
  public useCategoryCatalog(categories: ContentSourceCategory[]): void {
    this.categoryCatalog = categories;
    if (!this.manifest.movieCategoryIds.length) {
      const movieNames = new Set(["电影", "电影片", "动画电影", "动漫电影", "电影预告", "预告片", "伦理片"]);
      this.manifest.movieCategoryIds.push(...categories.filter((category) => movieNames.has(category.name)).map((category) => category.id));
    }
    // 关键变量：当前通用视频模型是点播，明确的直播分类不冒充标准点播节目。
    const liveNames = new Set(["直播", "电视直播", "电视频道", "IPTV"]);
    const excluded = this.manifest.excludedCategoryIds ?? [];
    for (const category of categories) if (liveNames.has(category.name) && !excluded.includes(category.id)) excluded.push(category.id);
    this.manifest.excludedCategoryIds = excluded;
  }

  /** 首次使用核对原始字节摘要，安装版本不允许静默替换脚本。 */
  private async ensureScript(): Promise<void> {
    this.scriptReady ??= (async () => {
      let bytes: Buffer;
      try { bytes = await readFile(this.scriptPath); } catch { throw new ApiError(503, `${this.sourceKind}_source_script_unavailable`, "Spider 源脚本缺失，请重新导入"); }
      if (createHash("sha256").update(bytes).digest("hex") !== this.manifest.scriptHash) throw new ApiError(409, `${this.sourceKind}_source_script_changed`, "Spider 源脚本内容与安装版本不一致，请重新导入");
    })();
    try { await this.scriptReady; } catch (error) { this.scriptReady = null; throw error; }
  }

  /** 初始化是宿主幂等操作，进程取消或重启后也能恢复同一初始化配置。 */
  private async call(method: string, args: unknown[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    this.requireActive();
    await this.ensureScript();
    this.requireActive();
    // 关键变量：正在播放的代理资源优先于排队目录请求，单个客户端断开只丢弃该次响应。
    const scheduling = method === "__proxy__" ? { priority: 0, discardRunningOnCancel: true } : undefined;
    // 关键变量：虚拟代理只在宿主内部识别，协议客户端永远拿不到这个内部定位。
    if (this.manifest.adapter === "python_spider") {
      await this.runtime.invoke(this.instanceId, this.scriptPath, "__set_proxy__", [`http://spider.invalid/proxy?instance=${encodeURIComponent(this.instanceId)}`], signal, scheduling);
      this.requireActive();
    }
    await this.runtime.invoke(this.instanceId, this.scriptPath, "init", [this.manifest.adapter === "catvod_js" ? this.manifest.jsConfig?.extend ?? "" : this.manifest.pythonConfig?.extend ?? ""], signal, scheduling);
    this.requireActive();
    const result = await this.runtime.invoke(this.instanceId, this.scriptPath, method, args, signal, scheduling);
    this.requireActive();
    return objectResult(result, this.sourceKind);
  }

  /** 真实分类用于协议入口和电影映射；不根据影片标题猜类别。 */
  public async categories(signal?: AbortSignal): Promise<ContentSourceCategory[]> {
    const result = await this.call("homeContent", [false], signal);
    if (!Array.isArray(result.class)) throw new ApiError(502, `${this.sourceKind}_source_categories_missing`, "Spider 源没有返回分类");
    this.categoryCatalog = result.class.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const raw = value as Record<string, unknown>;
      const id = String(raw.type_id ?? "");
      const name = text(raw.type_name);
      return id && name ? [{ id, name, parentId: raw.type_pid && String(raw.type_pid) !== "0" ? String(raw.type_pid) : null,
        ...(raw.type_all === true ? { isAll: true } : {}) }] : [];
    });
    this.useCategoryCatalog(this.categoryCatalog);
    return this.categoryCatalog;
  }

  /** 分类上下文可补充源卡片缺失的分类，分页参数仍原样传给 Spider。 */
  public async page(categoryId: string, page: number, signal?: AbortSignal): Promise<CmsContentPage> {
    const result = await this.call("categoryContent", [categoryId, String(page), false, {}], signal);
    return this.readPage(result, page, categoryId, signal);
  }

  /** 按真实源页搜索；只在宿主后续筛选当前媒体库所选分类。 */
  public async search(searchTerm: string, page: number, categoryId?: string, signal?: AbortSignal): Promise<CmsContentPage> {
    const result = await this.call("searchContent", [searchTerm, false, String(page)], signal);
    // Spider 搜索接口没有分类入参，不能把全站结果归到客户端请求的某个类别。
    return this.readPage(result, page, undefined, signal);
  }

  /** 分类及搜索列表统一转换摘要，源站自带播放字段也留到详情入口补齐。 */
  private readPage(result: Record<string, unknown>, page: number, categoryId?: string, signal?: AbortSignal): CmsContentPage {
    if (!Array.isArray(result.list) || result.list.length > 200) throw new ApiError(502, `${this.sourceKind}_source_list_invalid`, "Spider 源目录列表无效或单页超过 200 条");
    const items: CmsContentItem[] = [];
    for (const value of result.list) {
      signal?.throwIfAborted();
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      const id = String(raw.vod_id ?? "");
      if (!id || id.length > 128) continue;
      const actualCategory = this.itemCategory(raw, categoryId ?? "");
      if (actualCategory) this.categoryHints.set(id, actualCategory);
      try {
        // 关键变量：列表一律保存卡片，不因源站自带播放字段而解析分集或改写已有线路。
        const item = this.readItem(raw, actualCategory, "card");
        items.push(item);
      } catch (error) {
        const skippable = ["content_episode_ambiguous", "content_source_item_missing"];
        if (categoryId === undefined) skippable.push(`${this.sourceKind}_source_category_missing`);
        if (!(error instanceof ApiError) || !skippable.includes(error.code)) throw error;
        console.warn(JSON.stringify({ 日志关键字: this.sourceKind === "python" ? "codex-python-source" : "codex-javascript-source", 事件: "跳过源条目", 插件ID: this.manifest.pluginId, 错误码: error.code }));
      }
    }
    const declared = Number(result.pagecount);
    const total = Number(result.total);
    const limit = Number(result.limit);
    const explicitPages = Number.isInteger(declared) && declared >= 1 ? declared
      : Number.isInteger(total) && total >= 0 && Number.isInteger(limit) && limit > 0 ? Math.max(1, Math.ceil(total / limit)) : null;
    // 关键变量：无源总数时只根据明确的空源页判末尾，不制造精确总数。
    const sourcePageCount = result.__python_search_paged__ === false || result.__spider_search_paged__ === false ? 1 : result.list.length === 0 ? page : explicitPages;
    return { items, pageCount: sourcePageCount ?? page, sourcePageCount, rawItemCount: result.list.length };
  }

  /** 原 ID 查详情并保留真实类别，详情缺少分类时只能使用已知分类上下文。 */
  public async detail(remoteItemId: string, signal?: AbortSignal): Promise<CmsContentItem> {
    const result = await this.call("detailContent", [[remoteItemId]], signal);
    if (!Array.isArray(result.list)) throw new ApiError(502, `${this.sourceKind}_source_detail_invalid`, "Spider 源没有返回详情列表");
    const raw = result.list.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>).vod_id ?? "") === remoteItemId);
    if (!raw) throw new ApiError(404, "content_source_item_missing", "Spider 源中的条目已经不可用或需要更新源");
    return this.readItem(raw as Record<string, unknown>, this.categoryHints.get(remoteItemId) ?? "", "complete");
  }

  /** 固定 Spider 字段转换为现有视频目录模型，不保存取址会话或临时地址。 */
  private readItem(raw: Record<string, unknown>, categoryHint: string, detailState: "card" | "complete"): CmsContentItem {
    const id = String(raw.vod_id ?? "");
    const title = text(raw.vod_name);
    const categoryId = this.itemCategory(raw, categoryHint);
    if (!id || id.length > 128 || !title) throw new ApiError(502, `${this.sourceKind}_source_detail_invalid`, "Spider 源条目缺少有效身份或标题");
    if (!categoryId) throw new ApiError(422, `${this.sourceKind}_source_category_missing`, "Spider 源搜索及详情缺少分类信息，请更新源脚本");
    const category = this.categoryCatalog.find((item) => item.id === categoryId);
    const year = Number(raw.vod_year);
    const rating = Number(raw.vod_douban_score ?? raw.vod_score);
    return { id, title, categoryId, parentCategoryId: raw.type_id_1 ? String(raw.type_id_1) : category?.parentId ?? null,
      categoryName: text(raw.type_name) || category?.name || "", year: Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null,
      overview: text(raw.vod_content), posterUrl: /^https?:\/\//iu.test(String(raw.vod_pic ?? "")) ? String(raw.vod_pic) : null,
      backdropUrl: /^https?:\/\//iu.test(String(raw.vod_pic_slide ?? "")) ? String(raw.vod_pic_slide) : null,
      area: text(raw.vod_area), genres: text(raw.vod_class || raw.type_name).split(/[,，/]/u).filter(Boolean),
      actors: text(raw.vod_actor).split(/[,，/]/u).filter(Boolean), directors: text(raw.vod_director).split(/[,，/]/u).filter(Boolean),
      rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : null, tags: text(raw.vod_tag).split(/[|,，/]/u).filter(Boolean),
      detailState, episodes: detailState === "card" ? [] : readEpisodes(raw) };
  }

  /** 播放时调用 Spider，解析输入与最终 HTTP 地址分开，不把网页解析交给客户端。 */
  public async resolveEpisode(episode: CmsPlaybackEpisode, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; container: ContentVideoContainer }> {
    if (!episode.playbackId) throw new ApiError(502, `${this.sourceKind}_source_playback_missing`, "Spider 源缺少分集取址标识");
    const result = await this.call("playerContent", [episode.lineName, episode.playbackId, []], signal);
    const requiresParsing = result.parse !== undefined && result.parse !== 0 && result.parse !== "0";
    if (requiresParsing && isSpiderProxyUrl(String(result.url ?? ""))) throw new ApiError(422, "content_source_proxy_parse_unsupported", "脚本代理需要直接返回媒体或清单内容");
    const address = requiresParsing
      ? await resolveSpiderWebPlayback(String(result.url ?? ""), String(result.playUrl ?? ""), this.readPlaybackHeaders(result.header ?? result.headers), this.allowInsecureHttp, signal)
      : { url: String(result.url ?? ""), headers: this.readPlaybackHeaders(result.header ?? result.headers) };
    let url: URL;
    try { url = new URL(address.url); } catch { throw new ApiError(502, `${this.sourceKind}_source_playback_failed`, "Spider 源未返回有效播放地址，请尝试其他线路"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ApiError(422, `${this.sourceKind}_source_proxy_unsupported`, "此 Spider 线路需要其他播放能力");
    if (isSpiderProxyUrl(url.href) && readSpiderProxyInstance(url.href) !== this.instanceId) {
      throw new ApiError(403, "content_source_proxy_scope_invalid", "源代理不属于当前实例");
    }
    const headers = address.headers;
    return { url: url.href, headers, container: mediaContainer(url.href, result.type) };
  }
  /** 校验并复制源站请求头，禁止控制连接与媒体字节长度的字段混入。 */
  private readPlaybackHeaders(value: unknown): Record<string, string> {
    let rawHeaders: unknown = value ?? {};
    if (typeof rawHeaders === "string" && !rawHeaders.trim()) rawHeaders = {};
    if (typeof rawHeaders === "string") {
      try { rawHeaders = JSON.parse(rawHeaders); }
      catch { throw new ApiError(502, `${this.sourceKind}_source_headers_invalid`, "Spider 源播放请求头格式无效"); }
    }
    if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) throw new ApiError(502, `${this.sourceKind}_source_headers_invalid`, "Spider 源播放请求头格式无效");
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name) || typeof header !== "string" || /[\r\n]/u.test(header)) throw new ApiError(502, `${this.sourceKind}_source_headers_invalid`, "Spider 源播放请求头无效");
      if (!["host", "content-length", "connection", "transfer-encoding"].includes(name.toLowerCase())) headers[name] = header;
    }
    return headers;
  }

  /** 仅使用源明示的分类、已知浏览上下文或唯一同名分类，不从影片标题猜类型。 */
  private itemCategory(raw: Record<string, unknown>, hint: string): string {
    const explicit = String(raw.type_id ?? "").trim();
    if (explicit) return explicit;
    const known = this.categoryHints.get(String(raw.vod_id ?? ""));
    if (hint || known) return hint || known || "";
    const name = text(raw.type_name);
    const matches = name ? this.categoryCatalog.filter((category) => category.name === name) : [];
    return matches.length === 1 ? matches[0]!.id : "";
  }

  /** 宿主图片和媒体通路调用同一实例的代理，不创建公开的匿名代理接口。 */
  public async proxyResource(query: Record<string, string>, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return this.call("__proxy__", [query, headers], signal);
  }

}
