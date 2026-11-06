import { load } from "cheerio";
import { parseMagnetUrl } from "./magnet.js";
import type { PublicSiteResult } from "./public-sites.js";

const siteOrigin = "https://clm64.top";
const maximumPageBytes = 2 * 1024 * 1024;
const maximumCandidates = 30;

/** 固定磁力站点的页面请求限制大小和时长，详情并发时不会无限占用搜索请求。 */
async function readSitePage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml;q=0.9",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": siteOrigin,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`磁力猫返回 HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > maximumPageBytes) throw new Error("磁力猫页面过大");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumPageBytes) throw new Error("磁力猫页面过大");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 站点把搜索和详情 HTML 包在 atob 片段内，解码后再交给 HTML 解析器。 */
function decodePage(raw: string): string {
  const encoded = /atob\(["']([A-Za-z0-9+/=]+)["']\)/su.exec(raw)?.[1];
  if (!encoded) return raw;
  const text = Buffer.from(encoded, "base64").toString("utf8");
  try { return decodeURIComponent(text); }
  catch { return text; }
}

/** 只保留详情页路径，站点结果不能把云助手引向任意主机。 */
function detailUrl(href: string): string | null {
  try {
    const url = new URL(href, siteOrigin);
    return url.origin === siteOrigin && /^\/information\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)
      ? url.toString() : null;
  } catch { return null; }
}

/** 清除站点的广告标签，保留原始片名和画质规格。 */
function cleanTitle(value: string): string {
  return value.replace(/【[^】]*】/gu, "").replace(/\s+/gu, " ").trim().slice(0, 180);
}

/** 详情页提供真实磁力；搜索列表只有标题和详情入口。 */
async function readCandidate(candidate: { title: string; url: string }): Promise<PublicSiteResult | null> {
  try {
    const html = decodePage(await readSitePage(candidate.url));
    const $ = load(html);
    const rawMagnet = $("a[href^='magnet:']").first().attr("href")
      ?? /magnet:\?[^\s"'<>]+/iu.exec(html)?.[0] ?? "";
    const magnet = parseMagnetUrl(rawMagnet);
    if (!magnet) return null;
    const title = cleanTitle($("h1.Information_title").first().text()) || candidate.title;
    return { title, shareUrl: magnet.url, password: "", postedAt: null, messageUrl: candidate.url };
  } catch { return null; }
}

/** 参考磁力猫站点的搜索流程，由云助手独立读取第一页及其详情。 */
export async function searchClmao(keyword: string): Promise<PublicSiteResult[]> {
  const encoded = encodeURIComponent(Buffer.from(keyword, "utf8").toString("base64"));
  const html = decodePage(await readSitePage(`${siteOrigin}/search?word=${encoded}&sort=time`));
  const $ = load(html);
  const candidates: Array<{ title: string; url: string }> = [];
  $("#Search_list_wrapper li a.SearchListTitle_result_title[href]").each((_index, anchor) => {
    if (candidates.length >= maximumCandidates) return;
    const title = cleanTitle($(anchor).text());
    const url = detailUrl($(anchor).attr("href") ?? "");
    if (title && url) candidates.push({ title, url });
  });
  const results: Array<PublicSiteResult | null> = new Array(candidates.length).fill(null);
  // 关键变量：详情页最多六路并发，保持搜索结果原有排序。
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex++;
      results[index] = await readCandidate(candidates[index]!);
    }
  }));
  return results.filter((item): item is PublicSiteResult => item !== null);
}
