import { parseExpressionAt } from "acorn";
import { load } from "cheerio";

/** 公开搜索站返回的统一网盘分享结果。 */
export interface PublicSiteResult {
  title: string;
  shareUrl: string;
  password: string;
  postedAt: string | null;
  messageUrl: string;
}

/** 可配置的公开站点名称；key 与搜索来源配置中的 key 一致。 */
export const publicSiteNames: Record<string, string> = {
  pansearch: "PanSearch",
  quarkres: "热门夸克资源",
  quark4k: "Quark4K",
  haitunsou: "海豚搜",
  kdocs_guangya_didida: "光鸭滴滴嗒",
  kdocs_mobile_didida: "移动滴滴嗒",
};

// 关键变量：每个上游请求限制 12 秒和 3 MiB，避免慢站点或异常页面占住搜索请求。
const requestTimeoutMs = 12_000;
const maximumResponseBytes = 3 * 1024 * 1024;
const maximumResults = 30;
const shareUrlPattern = /https?:\/\/[^\s<>"'，。；;、）)]+/giu;

/** 有界读取公开站点响应，拒绝非成功状态及超大页面。 */
async function fetchSiteText(url: string, referer: string, accept = "application/json, text/html;q=0.9"): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      "Accept": accept,
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": referer,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`公开搜索站返回 HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > maximumResponseBytes) throw new Error("公开搜索站响应过大");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteCount += part.value.byteLength;
      if (byteCount > maximumResponseBytes) throw new Error("公开搜索站响应过大");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 将公开站点给出的日期转成页面使用的 ISO 时间。 */
function parsePostedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** 对公开站点结果做最小的关键词核对，避免站内搜索返回不相关作品。 */
function titleMatchesKeyword(title: string, keyword: string): boolean {
  const titleText = title.toLocaleLowerCase();
  const terms = keyword.replace(/[《》〈〉「」『』]/gu, "").toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return terms.length > 0 && terms.every((term) => titleText.includes(term));
}

/** 只接受常见网盘的分享地址，具体链接格式仍交给统一搜索引擎识别。 */
function readShareUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate.trim().replace(/&amp;/gu, "&").replace(/[.!?。！？，,]+$/u, ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    const accepted = [
      "pan.quark.cn", "drive.uc.cn", "pan.baidu.com", "aliyundrive.com", "www.aliyundrive.com",
      "alipan.com", "www.alipan.com", "guangyapan.com", "www.guangyapan.com", "pan.xunlei.com",
      "cloud.189.cn", "115.com", "www.115.com", "pan.115.com", "115cdn.com", "www.115cdn.com",
      "anxia.com", "www.anxia.com", "123pan.com", "www.123pan.com", "123684.com", "www.123684.com",
      "123685.com", "www.123685.com", "123912.com", "www.123912.com", "123pan.cn", "www.123pan.cn",
      "123592.com", "www.123592.com", "caiyun.139.com", "yun.139.com", "mypikpak.com", "www.mypikpak.com",
    ].includes(host);
    return accepted ? url.toString() : null;
  } catch { return null; }
}

/** 从正文 HTML 的锚点与纯文本中提取分享地址。 */
function extractShareUrls(content: string): string[] {
  const $ = load(`<div>${content}</div>`);
  const hrefs = $("a[href]").map((_index, element) => $(element).attr("href") ?? "").get();
  const candidates = [...hrefs, ...(content.match(shareUrlPattern) ?? []), ...($.root().text().match(shareUrlPattern) ?? [])];
  return [...new Set(candidates.map(readShareUrl).filter((url): url is string => Boolean(url)))];
}

/** 链接中的提取码优先于作品正文中的公共提取码。 */
function extractPassword(shareUrl: string, content: string): string {
  const params = new URL(shareUrl).searchParams;
  return params.get("pwd") ?? params.get("password") ?? params.get("passcode") ?? params.get("code")
    ?? /(?:提取码|访问码|密码|pwd|code)\s*[:：=]?\s*([A-Za-z0-9]{4,8})/iu.exec(content)?.[1] ?? "";
}

/** PanSearch 先从首页取得当前 buildId，再读取 Next.js 的搜索 JSON。 */
async function searchPanSearch(keyword: string): Promise<PublicSiteResult[]> {
  const site = "https://www.pansearch.me";
  const home = await fetchSiteText(`${site}/search`, `${site}/`, "text/html");
  const buildId = /"buildId":"([A-Za-z0-9_-]+)"/u.exec(home)?.[1];
  if (!buildId) throw new Error("PanSearch 搜索页面缺少 buildId");
  // 关键变量：站点每页约 10 条，三个分页并行读取后统一限制为 30 条。
  const pages = await Promise.allSettled([0, 10, 20].map(async (offset) => {
    const requestUrl = `${site}/_next/data/${buildId}/search.json?keyword=${encodeURIComponent(keyword)}&offset=${offset}`;
    const payload = JSON.parse(await fetchSiteText(requestUrl, `${site}/search`, "application/json")) as {
      pageProps?: { data?: { data?: Array<{ id?: number; content?: string; pan?: string; time?: string }> } };
    };
    return payload.pageProps?.data?.data ?? [];
  }));
  const entries = pages.flatMap((page) => page.status === "fulfilled" ? page.value : []);
  if (pages.every((page) => page.status === "rejected")) throw new Error("PanSearch 搜索请求失败");
  const results: PublicSiteResult[] = [];
  for (const item of entries) {
    const content = typeof item.content === "string" ? item.content : "";
    const title = (/名称\s*[:：]\s*([^\n<]+)/u.exec(content)?.[1] ?? load(`<div>${content}</div>`).text()).trim().slice(0, 180);
    if (!titleMatchesKeyword(title, keyword)) continue;
    for (const shareUrl of extractShareUrls(content)) {
      results.push({ title, shareUrl, password: extractPassword(shareUrl, content),
        postedAt: parsePostedAt(item.time), messageUrl: `${site}/search?keyword=${encodeURIComponent(keyword)}` });
      if (results.length >= maximumResults) return results;
    }
  }
  return results;
}

/** 热门夸克资源公开 JSON 接口直接提供每条分享链接。 */
async function searchQuarkRes(keyword: string): Promise<PublicSiteResult[]> {
  const site = "https://squark.cc.cd";
  const payload = JSON.parse(await fetchSiteText(`${site}/api/search?kw=${encodeURIComponent(keyword)}`, `${site}/`, "application/json")) as {
    code?: number;
    data?: Array<{ title?: string; content?: string; datetime?: string; links?: Array<{ url?: string; password?: string }> }>;
  };
  if (payload.code !== 200 || !Array.isArray(payload.data)) throw new Error("热门夸克资源搜索响应无效");
  const results: PublicSiteResult[] = [];
  for (const item of payload.data) {
    const title = String(item.title ?? "").trim().slice(0, 180);
    if (!titleMatchesKeyword(title, keyword)) continue;
    for (const link of item.links ?? []) {
      const shareUrl = readShareUrl(String(link.url ?? ""));
      if (!shareUrl || new URL(shareUrl).hostname !== "pan.quark.cn") continue;
      results.push({ title, shareUrl, password: String(link.password ?? "") || extractPassword(shareUrl, item.content ?? ""),
        postedAt: parsePostedAt(item.datetime), messageUrl: site });
      if (results.length >= maximumResults) return results;
    }
  }
  return results;
}

/** Quark4K 从讨论 JSON 中关联帖子正文，再提取真实分享链接。 */
async function searchQuark4K(keyword: string): Promise<PublicSiteResult[]> {
  const site = "https://quark4k.com";
  const include = "user,lastPostedUser,mostRelevantPost,mostRelevantPost.user,tags,tags.parent,firstPost";
  const requestUrl = `${site}/api/discussions?include=${encodeURIComponent(include)}&filter[q]=${encodeURIComponent(keyword)}&sort&page[offset]=0&page[limit]=50`;
  const payload = JSON.parse(await fetchSiteText(requestUrl, `${site}/`, "application/vnd.api+json")) as {
    data?: Array<{ id?: string; attributes?: { title?: string; createdAt?: string }; relationships?: {
      mostRelevantPost?: { data?: { id?: string } }; firstPost?: { data?: { id?: string } };
    } }>;
    included?: Array<{ id?: string; type?: string; attributes?: { contentHtml?: string } }>;
  };
  if (!Array.isArray(payload.data) || !Array.isArray(payload.included)) throw new Error("Quark4K 搜索响应无效");
  const posts = new Map(payload.included.filter((item) => item.type === "posts").map((item) => [item.id, item.attributes?.contentHtml ?? ""]));
  const results: PublicSiteResult[] = [];
  for (const item of payload.data) {
    const title = String(item.attributes?.title ?? "").trim().slice(0, 180);
    if (!titleMatchesKeyword(title, keyword)) continue;
    const postId = item.relationships?.mostRelevantPost?.data?.id ?? item.relationships?.firstPost?.data?.id;
    const content = postId ? posts.get(postId) ?? "" : "";
    for (const shareUrl of extractShareUrls(content)) {
      if (new URL(shareUrl).hostname !== "pan.quark.cn") continue;
      results.push({ title, shareUrl, password: extractPassword(shareUrl, content),
        postedAt: parsePostedAt(item.attributes?.createdAt), messageUrl: `${site}/d/${encodeURIComponent(String(item.id ?? ""))}` });
      if (results.length >= maximumResults) return results;
    }
  }
  return results;
}

/** 海豚搜的搜索页把结果作为 JS 单引号字符串传给 JSON.parse；使用 Acorn 只解析字面量，不执行脚本。 */
async function searchHaitunsou(keyword: string): Promise<PublicSiteResult[]> {
  const site = "https://www.haitunsou.com";
  const requestUrl = `${site}/s/${encodeURIComponent(keyword)}.html`;
  const html = await fetchSiteText(requestUrl, `${site}/`, "text/html");
  const markers = ["const list = JSON.parse(", "let listItems = JSON.parse("];
  const marker = markers.map((value) => ({ value, index: html.indexOf(value) })).find((value) => value.index >= 0);
  if (!marker) throw new Error("海豚搜页面缺少搜索结果");
  const literal = parseExpressionAt(html, marker.index + marker.value.length, { ecmaVersion: "latest" }) as { type: string; value?: unknown };
  if (literal.type !== "Literal" || typeof literal.value !== "string") throw new Error("海豚搜搜索结果格式无效");
  const items = JSON.parse(literal.value) as Array<{ title?: string; name?: string; url?: string; code?: string; times?: string }>;
  if (!Array.isArray(items)) throw new Error("海豚搜搜索结果格式无效");
  const results: PublicSiteResult[] = [];
  for (const item of items) {
    const title = String(item.title ?? item.name ?? "").trim().slice(0, 180);
    if (!titleMatchesKeyword(title, keyword)) continue;
    const shareUrl = readShareUrl(String(item.url ?? ""));
    if (!shareUrl) continue;
    results.push({ title, shareUrl, password: String(item.code ?? "") || extractPassword(shareUrl, title),
      postedAt: parsePostedAt(item.times), messageUrl: requestUrl });
    if (results.length >= maximumResults) return results;
  }
  return results;
}

/** 金山文档正文中需要读取的节点字段。 */
interface KdocsNode {
  type?: string;
  text?: string;
  content?: KdocsNode[];
  marks?: Array<{ type?: string; attrs?: { href?: string } }>;
}

/** 公开文档中的标题和网盘分享链接。 */
interface KdocsEntry {
  title: string;
  shareUrl: string;
  password: string;
}

// 关键变量：两个固定的公开文档分别只提取对应网盘，缓存五分钟减少浏览器启动和上游请求。
const kdocsDocuments: Record<string, { id: string; host: string }> = {
  kdocs_guangya_didida: { id: "sm7HQyjhUUii", host: "www.guangyapan.com" },
  kdocs_mobile_didida: { id: "cgaTcowJA60p", host: "yun.139.com" },
};
const kdocsCache = new Map<string, { expiresAt: number; entries: KdocsEntry[] }>();
const kdocsLoading = new Map<string, Promise<KdocsEntry[]>>();

/** 按正文顺序收集段落，保留作品标题与下一段分享链接的对应关系。 */
function collectKdocsParagraphs(node: KdocsNode | undefined, paragraphs: KdocsNode[]): void {
  if (!node) return;
  if (node.type === "paragraph") {
    paragraphs.push(node);
    return;
  }
  for (const child of node.content ?? []) collectKdocsParagraphs(child, paragraphs);
}

/** 从一个段落读取可见文字和超链接标记。 */
function readKdocsParagraph(node: KdocsNode, texts: string[], links: string[]): void {
  if (node.type === "text") {
    if (node.text) texts.push(node.text);
    for (const mark of node.marks ?? []) {
      if (mark.type === "link" && mark.attrs?.href) links.push(mark.attrs.href);
    }
    return;
  }
  for (const child of node.content ?? []) readKdocsParagraph(child, texts, links);
}

/** 金山文档访客页面会请求完整的 open/otl 正文，直接读取该响应而不依赖虚拟滚动的屏幕内容。 */
async function loadKdocsDocument(sourceKey: string): Promise<KdocsEntry[]> {
  const document = kdocsDocuments[sourceKey];
  if (!document) throw new Error("不支持的金山文档来源");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.FLYCLOUDHELPER_CHROMIUM_PATH
      || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium"),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const documentUrl = `https://www.kdocs.cn/l/${document.id}`;
    const [response] = await Promise.all([
      page.waitForResponse((item) => new URL(item.url()).pathname === `/api/v3/office/file/${document.id}/open/otl`, { timeout: 25_000 }),
      page.goto(documentUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }),
    ]);
    if (!response.ok()) throw new Error(`金山文档正文返回 HTTP ${response.status()}`);
    const body = await response.body();
    if (body.byteLength > 8 * 1024 * 1024) throw new Error("金山文档正文过大");
    const payload = JSON.parse(body.toString("utf8")) as { content?: KdocsNode };
    const paragraphs: KdocsNode[] = [];
    collectKdocsParagraphs(payload.content, paragraphs);
    const entries: KdocsEntry[] = [];
    let precedingTitle = "";
    for (const paragraph of paragraphs) {
      const texts: string[] = [];
      const links: string[] = [];
      readKdocsParagraph(paragraph, texts, links);
      const paragraphText = texts.join("").replace(/\s+/gu, " ").trim();
      const shareUrls = [...new Set([...links, ...(paragraphText.match(shareUrlPattern) ?? [])]
        .map(readShareUrl).filter((url): url is string => Boolean(url)))]
        .filter((url) => new URL(url).hostname === document.host);
      if (shareUrls.length > 0) {
        const title = paragraphText.replace(shareUrlPattern, "").trim() || precedingTitle;
        if (title) for (const shareUrl of shareUrls) {
          entries.push({ title: title.slice(0, 180), shareUrl, password: extractPassword(shareUrl, paragraphText) });
        }
      } else if (paragraphText && paragraphText.length <= 180
        && !/^(?:提取码|访问码|密码|链接|分类|注册|订阅链接)/u.test(paragraphText)) {
        precedingTitle = paragraphText;
      }
    }
    return entries;
  } finally {
    await browser.close();
  }
}

/** 同一文档的并发搜索共用一次读取，并在短时间内复用已解析的条目。 */
async function cachedKdocsEntries(sourceKey: string): Promise<KdocsEntry[]> {
  const cached = kdocsCache.get(sourceKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  const pending = kdocsLoading.get(sourceKey);
  if (pending) return pending;
  const loading = loadKdocsDocument(sourceKey);
  kdocsLoading.set(sourceKey, loading);
  try {
    const entries = await loading;
    kdocsCache.set(sourceKey, { entries, expiresAt: Date.now() + 5 * 60_000 });
    return entries;
  } finally {
    kdocsLoading.delete(sourceKey);
  }
}

/** 按用户关键词从指定公开文档返回当前网盘的分享条目。 */
async function searchKdocsDocument(sourceKey: string, keyword: string): Promise<PublicSiteResult[]> {
  const document = kdocsDocuments[sourceKey];
  if (!document) throw new Error("不支持的金山文档来源");
  const entries = await cachedKdocsEntries(sourceKey);
  return entries.filter((entry) => titleMatchesKeyword(entry.title, keyword)).slice(0, maximumResults)
    .map((entry) => ({ ...entry, postedAt: null, messageUrl: `https://www.kdocs.cn/l/${document.id}` }));
}

/** 按配置 key 调用对应公开站点的原生搜索接口，不经过 PanSou 服务。 */
export async function searchPublicSite(key: string, keyword: string): Promise<PublicSiteResult[]> {
  switch (key) {
    case "pansearch": return searchPanSearch(keyword);
    case "quarkres": return searchQuarkRes(keyword);
    case "quark4k": return searchQuark4K(keyword);
    case "haitunsou": return searchHaitunsou(keyword);
    case "kdocs_guangya_didida": return searchKdocsDocument(key, keyword);
    case "kdocs_mobile_didida": return searchKdocsDocument(key, keyword);
    default: throw new Error("不支持的公开搜索站");
  }
}
