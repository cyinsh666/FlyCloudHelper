import type { MovieSubscription } from "./store.js";

export interface SubscriptionMatch { subscription: MovieSubscription | null; reason: string | null }

/** 去掉发布消息中的年份、季集和画质后，只保留作品标题用于严格比较。 */
function cleanWorkTitle(value: string): string {
  const title = value.normalize("NFKC").replace(/\.(?:mkv|mp4|avi|mov)$/iu, "").trim();
  const parenthesizedYear = /[ (【]\s*(?:19|20)\d{2}\s*[)】]/u.exec(title);
  const episodeOrQuality = /(?:\bS\d{1,2}(?:E\d{1,3})?\b|\bSeason[ ._-]*\d+\b|第\s*\d+\s*[季集期]|\b(?:2160p|1080p|720p|4k|8k|WEB-DL|WEBRip|BluRay|HDR|H\.?26[45])\b)/iu.exec(title);
  // 关键变量：有括号年份时，前面的“1923”“2049”等数字仍属于作品名。
  const bareYear = parenthesizedYear ? null : /[\s._-](?:19|20)\d{2}(?=$|[\s._-])/u.exec(title);
  const positions = [parenthesizedYear?.index, episodeOrQuality?.index, bareYear?.index]
    .filter((position): position is number => position !== undefined);
  const withoutSuffix = positions.length ? title.slice(0, Math.min(...positions)) : title;
  return withoutSuffix.replace(/(?:全集|全季|合集|完结)$/u, "").trim();
}

/** 比较时忽略空白和常见分隔符，保留所有汉字和字母数字以免模糊误命中。 */
function titleKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 发布标题明确标出年份时检查 TMDB 年份；标题开头的数字作品名不当作年份。 */
function publishedYear(value: string): number | null {
  const text = value.normalize("NFKC");
  const found = /[ (【]\s*((?:19|20)\d{2})\s*[)】]/u.exec(text)
    ?? /[\s._-]((?:19|20)\d{2})(?=$|[\s._-])/u.exec(text);
  return found ? Number(found[1]) : null;
}

/** 只接受唯一且年份、电影/剧集类型没有冲突的订阅。 */
export function matchSubscription(title: string, subscriptions: MovieSubscription[]): SubscriptionMatch {
  const candidate = titleKey(cleanWorkTitle(title));
  if (!candidate) return { subscription: null, reason: null };
  const rawTitle = titleKey(title);
  const sameTitle = subscriptions.filter((item) => [item.title, item.originalTitle]
    .some((alias) => titleKey(alias) === candidate || titleKey(alias) === rawTitle));
  if (!sameTitle.length) return { subscription: null, reason: null };
  const year = sameTitle.some((item) => [item.title, item.originalTitle]
    .some((alias) => titleKey(alias) === rawTitle)) ? null : publishedYear(title);
  const episodeLike = /\bS\d{1,2}(?:E\d{1,3})?\b|\bSeason[ ._-]*\d+\b|第\s*\d+\s*[季集期]/iu.test(title.normalize("NFKC"));
  const compatible = sameTitle.filter((item) => (!episodeLike || item.mediaType === "tv")
    && (year === null || item.year === null || year === item.year));
  if (compatible.length === 1) return { subscription: compatible[0]!, reason: null };
  if (compatible.length > 1) return { subscription: null, reason: "同名订阅不止一部，无法确定 TMDB 作品" };
  return { subscription: null, reason: episodeLike ? "发布信息与订阅的电影/剧集类型不符" : "发布年份与 TMDB 作品不符" };
}
