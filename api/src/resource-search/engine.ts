import { load } from "cheerio";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError } from "../errors.js";
import { publicSiteNames, searchPublicSite } from "./public-sites.js";

/** 可由页面维护的公开频道或代码内置搜索站。 */
export interface SearchSource {
  kind: string;
  key: string;
  enabled: boolean;
}

/** 网盘分享搜索的统一候选结果；后续网站适配器也返回此结构。 */
export interface ShareSearchResult {
  title: string;
  shareUrl: string;
  cloudType: string;
  password: string;
  source: string;
  sourceKind: string;
  sourceName: string;
  postedAt: string | null;
  messageUrl: string;
}

/** 新增网站搜索时实现此接口，并在下面的适配器列表注册。 */
export interface SearchAdapter {
  kind: string;
  defaultSources: SearchSource[];
  validateSource(source: SearchSource): boolean;
  search(keyword: string, source: SearchSource): Promise<ShareSearchResult[]>;
}

/** 预置频道名单取自 PanSou 发布配置的快照；运行时不读取或调用 PanSou。 */
const defaultChannels = [
  "tgsearchers7",
  "Aliyun_4K_Movies",
  "yunpanx",
  "yp123pan",
  "yunpanxunlei",
  "tianyifc",
  "peccxinpd",
  "gotopan",
  "PanjClub",
  "baicaoZY",
  "MCPH02",
  "MCPH03",
  "bdwpzhpd",
  "Q66Share",
  "ucwpzy",
  "shareAliyun",
  "Quark_Movies",
  "XiangxiuNBB",
  "ucquark",
  "xx123pan",
  "yingshifenxiang123",
  "zyfb123",
  "Lsp115",
  "taoxgzy",
  "Channel_Shares_115",
  "vip115hot",
  "wp123zy",
  "yunpan139",
  "yunpan189",
  "yunpanuc",
  "yydf_hzl",
  "leoziyuan",
  "yoyokuakeduanju",
  "TG654TG",
  "QukanMovie",
  "yeqingjie_GJG666",
  "movielover8888_film3",
  "Baidu_netdisk",
  "D_wusun",
  "FLMdongtianfudi",
  "KaiPanshare",
  "rjyxfx",
  "PikPak_Share_Channel",
  "newproductsourcing",
  "QuarkFree",
  "yunpanNB",
  "kkdj001",
  "xxzlzn",
  "pxyunpanxunlei",
  "jxwpzy",
  "kuakedongman",
  "xiangnikanj",
  "solidsexydoll",
  "guoman4K",
  "zdqxm",
  "kduanju",
  "cilidianying",
  "CBduanju",
  "SharePanFilms",
  "dzsgx",
  "BooksRealm",
  "douerpan",
  "Netdisk_Movies",
  "yunpanquark",
  "ciliziyuanku",
  "jzmm_123pan",
  "wpan8",
  "mqte5",
  "regengguangya",
  "regeng115",
  "regeng123",
  "yy80986098",
  "pan_guangya",
  "guangyapan_episode",
  "guangya_hdhive",
  "guangyapindao",
  "quark_res",
  "domgmingapk",
  "dianying4k",
  "tgbokee",
  "ucshare",
  "gokuapan",
  "WFYSFX03",
  "gimy100",
  "gimy115iso",
  "fcij5",
  "xvth5",
  "xuexiziliaobaibaoku",
  "phzvip",
  "jdbigdiscount",
  "youxigs",
  "zhoulanziyuan",
  "seedhub_pro",
  "jnjy_5",
  "xxziliao",
  "wpzyk",
  "ruanjianfenxiang77",
  "jpnd5",
  "XunLeiPinDao",
  "a123fxme",
  "WPpindao",
  "kuyupan",
  "djya5",
  "zh_vip",
  "gdsharing",
  "guangyaya2026",
  "alyp_17362",
  "baidyunpan",
  "yunpans",
  "rbzhwpzy",
  "Panzi88com",
];
// 关键变量：正文中的候选 URL 与网页锚点一起处理，只有下方列出的网盘分享域名才会进入结果。
const shareLinkPattern = /https?:\/\/[^\s<>"'，。；;、）)]+/giu;
const sourceSettingKey = "resource_search_sources_v2";
const legacySourceSettingKey = "resource_search_sources";

/** 识别公开网盘分享链接的类型；仅检查域名和分享路径，不请求网盘服务。 */
function parseCloudShareUrl(input: string): { cloudType: string; url: string } | null {
  const guangya = parseGuangyaShareUrl(input);
  if (guangya) return { cloudType: "guangya", url: guangya.url };
  try {
    const parsed = new URL(input.trim().replace(/[.!?。！？，,]+$/u, ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    let cloudType = "";
    if (host === "pan.quark.cn" && pathname.startsWith("/s/")) cloudType = "quark";
    else if (host === "drive.uc.cn" && pathname.startsWith("/s/")) cloudType = "uc";
    else if (host === "pan.baidu.com" && (pathname.startsWith("/s/") || pathname.startsWith("/share/"))) cloudType = "baidu";
    else if (["www.aliyundrive.com", "aliyundrive.com", "www.alipan.com", "alipan.com"].includes(host) && pathname.startsWith("/s/")) cloudType = "aliyun";
    else if (host === "pan.xunlei.com" && pathname.startsWith("/s/")) cloudType = "xunlei";
    else if (host === "cloud.189.cn" && pathname.startsWith("/t/")) cloudType = "tianyi";
    else if (["115.com", "www.115.com", "pan.115.com", "115cdn.com", "www.115cdn.com", "anxia.com", "www.anxia.com"].includes(host) && pathname.startsWith("/s/")) cloudType = "115";
    else if (["123pan.com", "www.123pan.com", "123684.com", "www.123684.com", "123685.com", "www.123685.com", "123912.com", "www.123912.com", "123pan.cn", "www.123pan.cn", "123592.com", "www.123592.com"].includes(host) && pathname.startsWith("/s/")) cloudType = "123";
    else if (host === "caiyun.139.com" && (pathname.startsWith("/m/") || pathname.startsWith("/share"))) cloudType = "mobile";
    else if (host === "yun.139.com" && pathname === "/shareweb/" && parsed.hash.startsWith("#/w/i/")) cloudType = "mobile";
    else if (["mypikpak.com", "www.mypikpak.com"].includes(host) && pathname.startsWith("/s/")) cloudType = "pikpak";
    if (!cloudType) return null;
    return { cloudType, url: parsed.toString() };
  } catch { return null; }
}

/** 仅接受光鸭官方域名和完整的分享 ID，移除页面锚点。 */
export function parseGuangyaShareUrl(input: string): { shareId: string; code: string; url: string } | null {
  try {
    const parsed = new URL(input.trim());
    if (parsed.protocol !== "https:" || !["guangyapan.com", "www.guangyapan.com"].includes(parsed.hostname)) return null;
    const matched = /^\/s\/([0-9A-Za-z_-]+)\/?$/u.exec(parsed.pathname);
    if (!matched?.[1]) return null;
    const code = parsed.searchParams.get("pwd") ?? parsed.searchParams.get("code") ?? parsed.searchParams.get("password") ?? "";
    return { shareId: matched[1], code, url: `https://www.guangyapan.com/s/${matched[1]}${code ? `?pwd=${encodeURIComponent(code)}` : ""}` };
  } catch { return null; }
}

/** 从消息链接和正文收集各网盘分享，同一消息中的相同链接只保留一次。 */
function extractShareUrls(text: string, hrefs: string[]): Array<{ cloudType: string; url: string }> {
  const values = [...hrefs, ...(text.match(shareLinkPattern) ?? [])];
  const links = values.map(parseCloudShareUrl).filter((value): value is { cloudType: string; url: string } => Boolean(value));
  return [...new Map(links.map((link) => [link.url, link])).values()];
}

/** Telegram 搜索页可能混入无关消息；按消息正文再次核对用户输入的关键词。 */
function messageMatchesKeyword(messageText: string, keyword: string): boolean {
  // 关键变量：书名号只用于输入展示，空格用于分词；每个词都必须出现在同一条消息中。
  const terms = keyword.replace(/[《》〈〉「」『』]/gu, "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const searchableText = messageText.toLocaleLowerCase();
  return terms.length > 0 && terms.every((term) => searchableText.includes(term));
}

/** 跳过频道分类、日期和资源说明，只从正文中选择作品标题。 */
function isTitleLine(line: string): boolean {
  if (!line || line === "." || line.startsWith("http") || /^#[^\s]+$/u.test(line)) return false;
  const text = line.replace(/^[^\p{L}\p{N}]+/gu, "");
  if (/^\d{1,4}(?:年|[-/.])\d{1,2}/u.test(text)) return false;
  if (/^(?:夸克|百度|阿里|光鸭|迅雷|天翼|UC|115|123|PikPak|移动)(?:网盘|云盘)?\s*[:：]?$/iu.test(text)) return false;
  return !/^(?:类型|分享|网盘|简介|介绍|描述|更多资源|标签|链接|地址|提取码|访问码|密码|大小)\s*[:：]/u.test(text);
}

/** 优先使用“名称”字段，否则采用第一条可用的作品标题行。 */
function messageTitle(lines: string[], keyword: string): string {
  const named = lines.find((line) => /^名称\s*[:：]/u.test(line));
  if (named) return named.replace(/^名称\s*[:：]\s*/u, "").slice(0, 180);
  const matching = lines.find((line) => isTitleLine(line) && messageMatchesKeyword(line, keyword));
  return (matching ?? lines.find(isTitleLine) ?? keyword).slice(0, 180);
}

/** 多作品消息中，以链接所在行或最近的上方标题行为该链接确定作品名。 */
function linkWorkTitle(lines: string[], shareUrl: string, fallbackTitle: string): { title: string; matched: boolean } {
  const lineIndex = lines.findIndex((line) => extractShareUrls(line, []).some((link) => link.url === shareUrl));
  if (lineIndex < 0) return { title: fallbackTitle, matched: false };
  const line = lines[lineIndex]!;
  const urlIndex = line.search(/https?:\/\//iu);
  const beforeUrl = urlIndex < 0 ? "" : line.slice(0, urlIndex).trim();
  const sameLineTitle = beforeUrl.includes("丨") ? beforeUrl.split("丨")[0]?.trim() ?? "" : beforeUrl;
  if (sameLineTitle && isTitleLine(sameLineTitle)) {
    return { title: sameLineTitle.slice(0, 180), matched: true };
  }
  for (let index = lineIndex - 1; index >= 0; index--) {
    const candidate = lines[index]!;
    if (extractShareUrls(candidate, []).length > 0 || !isTitleLine(candidate)) continue;
    return { title: candidate.replace(/^名称\s*[:：]\s*/u, "").slice(0, 180), matched: true };
  }
  return { title: fallbackTitle, matched: false };
}

/** 参照 PanSou 的时间与合集词权重，让较新且完整的资源优先显示。 */
function resultScore(item: ShareSearchResult): number {
  const daysOld = item.postedAt ? (Date.now() - Date.parse(item.postedAt)) / 86_400_000 : Infinity;
  const timeScore = daysOld <= 1 ? 500 : daysOld <= 3 ? 400 : daysOld <= 7 ? 300
    : daysOld <= 30 ? 200 : daysOld <= 90 ? 100 : daysOld <= 365 ? 50 : 20;
  const priorityTerms = ["合集", "系列", "全", "完", "最新", "附", "complete"];
  const priorityIndex = priorityTerms.findIndex((term) => item.title.toLocaleLowerCase().includes(term));
  return timeScore + (priorityIndex < 0 ? 0 : (priorityTerms.length - priorityIndex) * 70);
}

/** 读取公开频道的 Telegram 搜索页，不需要机器人登录。 */
class TelegramSearchAdapter implements SearchAdapter {
  public readonly kind = "telegram";
  public readonly defaultSources: SearchSource[] = defaultChannels.map((key) => ({ kind: this.kind, key, enabled: true }));

  /** Telegram 公开频道名称必须能安全拼入 t.me/s 路径。 */
  public validateSource(source: SearchSource): boolean {
    return source.kind === this.kind && /^[A-Za-z0-9_]{5,32}$/u.test(source.key);
  }

  /** 按频道查询并从每条消息中提取标题、时间、链接和提取码。 */
  public async search(keyword: string, source: SearchSource): Promise<ShareSearchResult[]> {
    // 关键变量：书名号是用户输入的展示符号，不作为 Telegram 频道检索词。
    const queryKeyword = keyword.replace(/[《》〈〉「」『』]/gu, "").trim();
    if (!queryKeyword) return [];
    const response = await fetch(`https://t.me/s/${source.key}?q=${encodeURIComponent(queryKeyword)}`, {
      headers: { "User-Agent": "Mozilla/5.0 FlyCloudHelper/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Telegram 搜索请求失败（${response.status}）`);
    const html = await response.text();
    if (html.length > 3_000_000) throw new Error("Telegram 搜索响应过大");
    const $ = load(html);
    const results: ShareSearchResult[] = [];
    $(".tgme_widget_message_wrap").each((_index, wrapper) => {
      const message = $(wrapper).find(".tgme_widget_message").first();
      const post = message.attr("data-post") ?? "";
      const body = message.find(".tgme_widget_message_text").first();
      // 关键变量：克隆正文只用于搜索解析，保留 <br> 分行并把隐藏在锚点中的分享地址补进对应行。
      const textBody = body.clone();
      textBody.find("a[href]").each((_linkIndex, anchor) => {
        const link = $(anchor);
        const href = link.attr("href") ?? "";
        if (parseCloudShareUrl(href) && !link.text().includes(href)) link.text(`${link.text()} ${href}`);
      });
      textBody.find("br").replaceWith("\n");
      const messageText = textBody.text().trim();
      if (!messageMatchesKeyword(messageText, keyword)) return;
      const hrefs = message.find(".tgme_widget_message_text a[href], .tgme_widget_message_inline_keyboard a[href]")
        .map((_linkIndex, link) => $(link).attr("href") ?? "").get();
      const password = /(?:提取码|访问码|密码)\s*[:：]?\s*([A-Za-z0-9]{4,8})/iu.exec(messageText)?.[1] ?? "";
      const lines = messageText.split(/\n/u).map((line) => line.trim()).filter(Boolean);
      const defaultTitle = messageTitle(lines, keyword);
      const shares = extractShareUrls(messageText, hrefs);
      // 关键变量：一条消息可能包含多个不同网盘的分享链接。
      for (const share of shares) {
        const work = shares.length > 4 ? linkWorkTitle(lines, share.url, defaultTitle) : { title: defaultTitle, matched: false };
        // 明确识别到链接所属作品时按作品标题过滤；其余沿用 Telegram 正文匹配结果。
        if (work.matched && !messageMatchesKeyword(work.title, keyword)) continue;
        // 关键变量：链接自带的提取码优先于消息中的公共提取码。
        const shareParams = new URL(share.url).searchParams;
        const linkPassword = shareParams.get("pwd") ?? shareParams.get("code") ?? shareParams.get("password") ?? "";
        results.push({ title: work.title, shareUrl: share.url, cloudType: share.cloudType,
          password: linkPassword || password,
          source: `Telegram / ${source.key}`, sourceKind: "telegram", sourceName: source.key,
          postedAt: message.find(".tgme_widget_message_date time").attr("datetime") ?? null,
          messageUrl: /^[-\w]+\/\d+$/u.test(post) ? `https://t.me/${post}` : `https://t.me/s/${source.key}` });
      }
    });
    return results;
  }
}

/** 无需登录的公开搜索站适配器；每个站点只负责返回候选，链接类型由云助手统一识别。 */
class PublicSiteSearchAdapter implements SearchAdapter {
  public readonly kind = "public_site";
  public readonly defaultSources: SearchSource[] = Object.keys(publicSiteNames)
    .map((key) => ({ kind: this.kind, key, enabled: true }));

  /** 站点只能从代码中注册的适配器列表选择，不能通过配置注入任意请求地址。 */
  public validateSource(source: SearchSource): boolean {
    return source.kind === this.kind && Object.hasOwn(publicSiteNames, source.key);
  }

  /** 将公开站点结果映射到与 Telegram 相同的网盘分享结构。 */
  public async search(keyword: string, source: SearchSource): Promise<ShareSearchResult[]> {
    const candidates = await searchPublicSite(source.key, keyword);
    const results: ShareSearchResult[] = [];
    for (const candidate of candidates) {
      const share = parseCloudShareUrl(candidate.shareUrl);
      if (!share || !messageMatchesKeyword(candidate.title, keyword)) continue;
      results.push({ title: candidate.title.slice(0, 180), shareUrl: share.url, cloudType: share.cloudType,
        password: candidate.password, source: `站点 / ${publicSiteNames[source.key]}`,
        sourceKind: this.kind, sourceName: publicSiteNames[source.key] ?? source.key,
        postedAt: candidate.postedAt, messageUrl: candidate.messageUrl });
    }
    return results;
  }
}

/** 新增网站来源时实现 SearchAdapter 并注册；运行时始终由云助手直接调用来源。 */
const adapters = new Map<string, SearchAdapter>([
  ["telegram", new TelegramSearchAdapter()], ["public_site", new PublicSiteSearchAdapter()],
]);

/** 公开站点的临时网络错误允许重试一次，站点返回格式错误则直接反馈。 */
function isTransientSiteFailure(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  return reason.name === "TimeoutError" || /fetch failed|HTTP (?:429|5\d\d)/iu.test(reason.message);
}

/** 搜索单个来源；公开站点出现临时网络错误时补发一次请求。 */
async function searchSource(keyword: string, source: SearchSource): Promise<ShareSearchResult[]> {
  const adapter = adapters.get(source.kind)!;
  try {
    return await adapter.search(keyword, source);
  } catch (reason) {
    if (source.kind !== "public_site" || !isTransientSiteFailure(reason)) throw reason;
    return adapter.search(keyword, source);
  }
}

/** 将失败原因转换为页面可读的简短提示。 */
function searchFailureReason(reason: unknown): string {
  if (!(reason instanceof Error)) return "请求失败";
  if (reason.name === "TimeoutError") return "请求超时";
  if (reason.message === "fetch failed") return "网络连接失败";
  return reason.message.slice(0, 120);
}

/** 读取已保存的全局来源配置并丢弃未注册的旧适配器。 */
function parseConfiguredSources(value: unknown): SearchSource[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed)) throw new ApiError(500, "search_sources_corrupt", "搜索来源配置无效");
  return parsed.filter((item): item is SearchSource => item && typeof item.kind === "string"
    && typeof item.key === "string" && typeof item.enabled === "boolean"
    && Boolean(adapters.get(item.kind)?.validateSource(item)));
}

/** 系统级频道配置与搜索执行器；普通用户和管理员共用数据库中的相同来源。 */
export class ResourceSearchEngine {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 读取全局来源配置；首次启用公开站点时沿用已有频道配置。 */
  public async listSources(): Promise<SearchSource[]> {
    const row = await this.database.query("system_settings").where({ setting_key: sourceSettingKey }).first();
    if (row) {
      const configured = parseConfiguredSources(row.setting_value);
      // 关键变量：已保存旧配置的用户也能看到新加入的代码适配站点，已有启停状态保持不变。
      const missingSites = adapters.get("public_site")!.defaultSources
        .filter((site) => !configured.some((source) => source.kind === site.kind && source.key === site.key));
      return [...configured, ...missingSites];
    }
    const previous = await this.database.query("system_settings").where({ setting_key: legacySourceSettingKey }).first();
    const channels = previous ? parseConfiguredSources(previous.setting_value) : adapters.get("telegram")!.defaultSources;
    return [...channels, ...adapters.get("public_site")!.defaultSources];
  }

  /** 原子保存全局频道配置并增加修订号。 */
  public async saveSources(sources: SearchSource[], actorUserId: string): Promise<SearchSource[]> {
    if (!Array.isArray(sources) || sources.length > 150 || sources.some((source) => !source
      || typeof source.kind !== "string" || typeof source.key !== "string" || typeof source.enabled !== "boolean"
      || !adapters.get(source.kind)?.validateSource(source))
      || new Set(sources.map((source) => `${source.kind}:${source.key.toLowerCase()}`)).size !== sources.length) {
      throw new ApiError(422, "search_sources_invalid", "搜索来源配置无效");
    }
    await this.database.query.transaction(async (transaction) => {
      const previous = await transaction("system_settings").where({ setting_key: sourceSettingKey }).first();
      const now = new Date().toISOString();
      const next = { setting_value: JSON.stringify(sources), revision: Number(previous?.revision ?? 0) + 1,
        updated_by_user_id: actorUserId, updated_at: now };
      if (previous) await transaction("system_settings").where({ setting_key: sourceSettingKey }).update(next);
      else await transaction("system_settings").insert({ setting_key: sourceSettingKey, ...next, created_at: now });
    });
    return sources;
  }

  /** 同时查询已启用来源，按网盘分享链接去重，并返回来源错误供页面提示。 */
  public async search(keyword: string): Promise<{ items: ShareSearchResult[]; errors: string[] }> {
    const sources = (await this.listSources()).filter((source) => source.enabled);
    // 关键变量：频道超过百个，限制并发请求数。
    const settled: PromiseSettledResult<ShareSearchResult[]>[] = new Array(sources.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(24, sources.length) }, async () => {
      while (nextIndex < sources.length) {
        const index = nextIndex++;
        const source = sources[index]!;
        try {
          settled[index] = { status: "fulfilled", value: await searchSource(keyword, source) };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    }));
    const items = new Map<string, ShareSearchResult>();
    const errors: string[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        const source = sources[index];
        const sourceName = source?.kind === "telegram" ? `tg:${source.key}`
          : source?.kind === "public_site" ? `站点:${publicSiteNames[source.key] ?? source.key}` : "未知来源";
        errors.push(`${sourceName}：${searchFailureReason(outcome.reason)}`);
        return;
      }
      for (const item of outcome.value) {
        const key = `${item.cloudType}:${item.shareUrl}`;
        const existing = items.get(key);
        if (!existing || (item.postedAt ?? "") > (existing.postedAt ?? "")) items.set(key, item);
      }
    });
    return { items: [...items.values()].sort((a, b) => resultScore(b) - resultScore(a)
      || (b.postedAt ?? "").localeCompare(a.postedAt ?? "")).slice(0, 500), errors };
  }

}
