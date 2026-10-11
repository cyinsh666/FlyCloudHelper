import { createHash } from "node:crypto";
import { ApiError, validationError } from "../errors.js";
import { providerFetch } from "../providers/network.js";
import type { CmsContentItem, CmsContentPage, CmsPlaybackEpisode, ContentSourceCategory, ContentSourceManifest } from "./types.js";

/** 给源站文字生成稳定键，不使用临时播放地址或页面顺序作为身份。 */
export function contentKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** 清除源站简介中的简单 HTML 标签，只保存文本。 */
function plainText(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").trim();
}

/** 读取只含 HTTP(S) 的图片地址，忽略源站无效图片。 */
function artworkUrl(value: unknown, endpoint: string): string | null {
  try {
    const url = new URL(String(value ?? ""), endpoint);
    return String(value ?? "") && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** 根据单集名读取季集编号；缺少季信息固定按第 1 季展示。 */
function episodeIdentity(name: string, index: number): { key: string; season: number; episode: number } {
  const seasonEpisode = name.match(/S(\d+)\s*E(\d+)/iu);
  if (seasonEpisode) {
    const season = Number(seasonEpisode[1]);
    const episode = Number(seasonEpisode[2]);
    return { key: `s${season}e${episode}`, season, episode };
  }
  const numbered = name.match(/^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/u);
  const episode = numbered ? Number(numbered[1]) : index + 1;
  return { key: numbered ? `s1e${episode}` : `label_${contentKey(name)}`, season: 1, episode };
}

/** 解析 CMS 的线路 $$$、单集 # 和集名 $ URL，并过滤非直连媒体。 */
export function parseCmsPlaybackEpisodes(raw: Record<string, unknown>): CmsPlaybackEpisode[] {
  const lineNames = String(raw.vod_play_from ?? "").split("$$$");
  const lineGroups = String(raw.vod_play_url ?? "").split("$$$");
  const result: CmsPlaybackEpisode[] = [];
  for (const [lineIndex, group] of lineGroups.entries()) {
    const lineName = lineNames[lineIndex]?.trim();
    if (!lineName) continue;
    const seen = new Set<string>(); // 关键变量：同一线路不能出现两个相同身份，否则播放不能精确定位。
    for (const [episodeIndex, entry] of group.split("#").entries()) {
      const separator = entry.indexOf("$");
      if (separator <= 0) continue;
      const name = plainText(entry.slice(0, separator));
      let url: URL;
      try { url = new URL(entry.slice(separator + 1).trim()); } catch { continue; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
      const container = /\.m3u8$/iu.test(url.pathname) ? "hls" : /\.mp4$/iu.test(url.pathname) ? "mp4" : null;
      if (!container || !name) continue;
      const identity = episodeIdentity(name, episodeIndex);
      const locator = `${lineName}:${identity.key}`;
      if (seen.has(locator)) throw new ApiError(422, "content_episode_ambiguous", "源站同一线路的单集标识重复，无法准确播放");
      seen.add(locator);
      result.push({ lineName, episodeKey: identity.key, name, episodeNumber: identity.episode, seasonNumber: identity.season, url: url.href, container });
    }
  }
  return result;
}

/** 把固定 CMS 字段转换为内容目录，不执行源文件中的脚本或解析器。 */
function readContentItem(value: unknown, manifest: ContentSourceManifest): CmsContentItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.vod_id ?? "").trim();
  const title = plainText(raw.vod_name);
  if (!id || id.length > 128 || !title) return null;
  const parsedYear = Number(raw.vod_year);
  return {
    id, title, categoryId: String(raw.type_id ?? ""),
    parentCategoryId: raw.type_id_1 ? String(raw.type_id_1) : null,
    categoryName: plainText(raw.type_name),
    year: Number.isInteger(parsedYear) && parsedYear >= 1800 && parsedYear <= 2200 ? parsedYear : null,
    overview: plainText(raw.vod_content), posterUrl: artworkUrl(raw.vod_pic, manifest.endpoint),
    area: plainText(raw.vod_area),
    genres: plainText(raw.vod_class || raw.type_name).split(/[,，/]/u).filter(Boolean),
    actors: plainText(raw.vod_actor).split(/[,，/]/u).filter(Boolean),
    directors: plainText(raw.vod_director).split(/[,，/]/u).filter(Boolean),
    episodes: parseCmsPlaybackEpisodes(raw),
  };
}

/** 固定 CMS JSON 协议适配器，按实例插件清单读取目录和即时详情。 */
export class CmsJsonAdapter {
  /** 保存固定源地址与实例网络选项。 */
  public constructor(private readonly manifest: ContentSourceManifest, private readonly allowInsecureHttp: boolean) {}

  /** 请求一页源站 JSON；Content-Type 不正确时仍以 JSON 正文校验。 */
  private async request(query: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = new URL(this.manifest.endpoint);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    let response: Response;
    try {
      response = await providerFetch(url, { method: "GET", headers: { Accept: "application/json", ...this.manifest.headers } }, {
        allowInsecureHttp: this.allowInsecureHttp,
        // 关键变量：只挑选安全字段，不记录接口查询参数、请求头、源正文或播放地址。
        logConnectionFailure: (fields) => console.warn(JSON.stringify({
          日志关键字: "codex-content-source-sync",
          事件: "内容源接口网络诊断",
          操作: query.ids ? "读取详情" : query.wd ? "实时搜索" : query.t ? "读取分类目录" : "读取分类",
          主机: fields.主机 ?? url.hostname,
          系统错误码: fields.系统错误码 ?? null,
          耗时毫秒: fields.已等待毫秒 ?? null,
        })),
      }, signal);
    } catch (error) {
      if (error instanceof ApiError && error.code.startsWith("provider_")) {
        throw new ApiError(error.statusCode, error.code, error.message.replace(/网盘/gu, "内容源").replace(/Provider/gu, "内容源"));
      }
      throw error;
    }
    if (!response.ok) throw new ApiError(502, "content_source_http_failed", `内容源接口返回 HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new ApiError(413, "content_source_response_too_large", "内容源单页响应超过 4 MB");
    try {
      const result: unknown = JSON.parse(text);
      if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
    } catch { /* 源站有时以 HTML 返回错误，不能把原始正文或地址泄露给客户端。 */ }
    throw new ApiError(502, "content_source_json_invalid", "内容源未返回有效的 CMS JSON，请检查源状态");
  }

  /** 读取原始分类树；禁用类型在创建库时再次校验。 */
  public async categories(signal?: AbortSignal): Promise<ContentSourceCategory[]> {
    const payload = await this.request({ ac: "list", pg: "1" }, signal);
    if (!Array.isArray(payload.class)) throw new ApiError(502, "content_source_categories_missing", "内容源没有返回分类");
    return payload.class.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const raw = value as Record<string, unknown>;
      const id = String(raw.type_id ?? "");
      const name = plainText(raw.type_name);
      return id && name ? [{ id, name, parentId: raw.type_pid && String(raw.type_pid) !== "0" ? String(raw.type_pid) : null }] : [];
    });
  }

  /** 读取分类详细列表，避免为列表中的每个条目额外请求一次详情。 */
  public async page(categoryId: string, page: number, signal?: AbortSignal): Promise<CmsContentPage> {
    const payload = await this.request({ ac: "detail", t: categoryId, pg: String(page) }, signal);
    return this.readPage(payload, page, categoryId);
  }

  /** 单分类搜索携带 t 减少源扫描；实际范围仍由宿主按返回分类精确过滤。 */
  public async search(searchTerm: string, page: number, categoryId?: string, signal?: AbortSignal): Promise<CmsContentPage> {
    const payload = await this.request({ ac: "detail", wd: searchTerm, pg: String(page), ...(categoryId === undefined ? {} : { t: categoryId }) }, signal);
    // 关键变量：两个内置源成功码为 1，明确失败即使附带空列表也不能伪装成没有匹配项。
    if (payload.code !== undefined && payload.code !== 1 && payload.code !== "1") throw new ApiError(502, "content_source_search_failed", "内容源搜索未成功，请稍后重试");
    return this.readPage(payload, page, categoryId, true);
  }

  /** 分类和搜索共用详情页契约；原始条数决定源尾，过滤后空候选不代表末页。 */
  private readPage(payload: Record<string, unknown>, page: number, categoryId?: string, isSearchPage = false): CmsContentPage {
    if (!Array.isArray(payload.list)) throw new ApiError(502, "content_source_list_missing", "内容源没有返回目录列表");
    if (payload.list.length > 200) throw new ApiError(422, "content_source_page_too_large", "内容源单页超过 200 个条目，请调整源站分页后再同步");
    const items: CmsContentItem[] = [];
    for (const value of payload.list) {
      try {
        const item = readContentItem(value, this.manifest);
        if (item) items.push(item);
      } catch (error) {
        // 关键变量：单条播放身份不明确不能阻断整页；详情仍拒绝该条目，不猜测同名视频的版本。
        if (!(error instanceof ApiError) || error.code !== "content_episode_ambiguous") throw error;
        const raw = value as Record<string, unknown>;
        console.warn(JSON.stringify({
          日志关键字: "codex-content-source-item-invalid", 事件: "跳过播放身份重复的源条目",
          插件ID: this.manifest.pluginId, 分类ID: categoryId ?? null, 页码: page,
          // 搜索页仅记录身份，避免标题间接带出用户搜索词。
          源条目ID: String(raw.vod_id ?? ""), ...(isSearchPage ? {} : { 标题: plainText(raw.vod_name) }),
        }));
      }
    }
    const pageCount = Number(payload.pagecount);
    const sourcePageCount = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null;
    return { items, pageCount: sourcePageCount ?? page, sourcePageCount, rawItemCount: payload.list.length };
  }

  /** 根据源站原始 ID 即时刷新详情，禁止用搜索结果替换请求条目。 */
  public async detail(remoteItemId: string, signal?: AbortSignal): Promise<CmsContentItem> {
    const payload = await this.request({ ac: "detail", ids: remoteItemId }, signal);
    if (!Array.isArray(payload.list)) throw new ApiError(502, "content_source_list_missing", "内容源详情没有返回有效的目录列表");
    // 关键变量：先按原始 ID 定位，避免缺少标题的异常详情被误认成条目已删除。
    const rawItem = payload.list.find((value) => value && typeof value === "object" && !Array.isArray(value)
      && String((value as Record<string, unknown>).vod_id ?? "").trim() === remoteItemId);
    if (!rawItem) {
      const malformedList = payload.list.some((value) => !value || typeof value !== "object" || Array.isArray(value)
        || !String((value as Record<string, unknown>).vod_id ?? "").trim());
      if (malformedList) throw new ApiError(502, "content_source_detail_invalid", "内容源详情列表格式异常");
      throw new ApiError(404, "content_source_item_missing", "内容源中的条目已经不可用");
    }
    const item = readContentItem(rawItem, this.manifest);
    if (!item) throw new ApiError(502, "content_source_detail_invalid", "内容源返回的条目详情格式异常");
    return item;
  }
}

/** 校验导入清单，首期只接受固定 CMS JSON 地址和公开请求头。 */
export function validateContentManifest(value: unknown): ContentSourceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("manifest", "插件清单必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (raw.protocolVersion !== 1 || raw.adapter !== "cms_json") throw validationError("manifest", "首期只支持 protocolVersion 1 的 cms_json 内容源插件");
  const readText = (field: string, maximum: number): string => {
    const text = typeof raw[field] === "string" ? String(raw[field]).trim() : "";
    if (!text || text.length > maximum) throw validationError(field, `${field} 不能为空且不能超过 ${maximum} 个字符`);
    return text;
  };
  const pluginId = readText("pluginId", 128);
  const version = readText("version", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(pluginId) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) throw validationError("manifest", "插件 ID 或版本格式无效");
  const endpoint = readText("endpoint", 2000);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw validationError("endpoint", "CMS 接口地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw validationError("endpoint", "首期 CMS 地址只允许不含查询参数的 HTTP(S) 地址，不能内嵌账号或锚点");
  const movieCategoryIds = Array.isArray(raw.movieCategoryIds) ? raw.movieCategoryIds.map(String) : [];
  if (!movieCategoryIds.length || movieCategoryIds.some((id) => !id || id.length > 128)) throw validationError("movieCategoryIds", "请指定电影分类 ID");
  const headers: Record<string, string> = {};
  if (raw.headers !== undefined && (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers))) throw validationError("headers", "请求头必须是字符串键值对象");
  for (const [name, headerValue] of Object.entries((raw.headers ?? {}) as Record<string, unknown>)) {
    if (!/^(user-agent|referer|accept|accept-language)$/iu.test(name) || typeof headerValue !== "string" || /[\r\n]/u.test(headerValue) || headerValue.length > 2000) throw validationError("headers", "首期插件只支持公开 User-Agent、Referer、Accept 和 Accept-Language 请求头");
    headers[name] = headerValue;
  }
  return { protocolVersion: 1, pluginId, version, displayName: readText("displayName", 100), description: String(raw.description ?? "").slice(0, 2000), adapter: "cms_json", endpoint: url.href, movieCategoryIds, excludedCategoryIds: Array.isArray(raw.excludedCategoryIds) ? raw.excludedCategoryIds.map(String) : [], headers };
}
