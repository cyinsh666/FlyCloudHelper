import { FlymbyVideoTitleCleaner } from "../media/flymby-video-title-cleaner.js";

/** TMDB 候选判断所需的身份字段，不依赖网络客户端。 */
export interface TmdbCandidateIdentity {
  id: number;
  title: string;
  originalTitle: string;
  date: string;
  popularity: number;
}

/** 保留中英文和数字用于强标题比较，续集数字参与身份判断。 */
export function buildTmdbStrongTitleKey(value: string): string {
  return FlymbyVideoTitleCleaner.normalizeSearchText(value).replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, "");
}

/** 标题或原名完全一致才属于强匹配。 */
export function isTmdbStrongTitleMatch(query: string, candidate: Pick<TmdbCandidateIdentity, "title" | "originalTitle">): boolean {
  const key = buildTmdbStrongTitleKey(query);
  return Boolean(key && [candidate.title, candidate.originalTitle].some((title) => buildTmdbStrongTitleKey(title) === key));
}

/** 提取英文词集合，过滤与鸿蒙相同的停用词。 */
function englishTitleTokens(value: string): string[] {
  const stopWords = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "part", "season"]);
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 2 && !stopWords.has(token)))];
}

/** 按鸿蒙的强相等、中文包含比例和英文词重合比例判断标题兼容性。 */
export function isTmdbCandidateTitleCompatible(query: string, candidate: Pick<TmdbCandidateIdentity, "title" | "originalTitle">): boolean {
  if (!buildTmdbStrongTitleKey(query)) return false;
  if (isTmdbStrongTitleMatch(query, candidate)) return true;
  const titles = [candidate.title, candidate.originalTitle];
  const chineseQuery = query.replace(/[^0-9\u4e00-\u9fa5]+/gu, "");
  if (chineseQuery.length >= 2 && titles.some((title) => {
    const chineseTitle = title.replace(/[^0-9\u4e00-\u9fa5]+/gu, "");
    const shorter = Math.min(chineseQuery.length, chineseTitle.length);
    const longer = Math.max(chineseQuery.length, chineseTitle.length);
    return shorter >= 2 && shorter / longer >= 0.7
      && (chineseQuery.includes(chineseTitle) || chineseTitle.includes(chineseQuery));
  })) return true;
  const queryTokens = englishTitleTokens(query);
  if (queryTokens.length === 0) return false;
  return titles.some((title) => {
    const tokens = englishTitleTokens(title);
    if (queryTokens.length === 1) return tokens.length === 1 && tokens[0] === queryTokens[0];
    const matched = queryTokens.filter((token) => tokens.includes(token)).length;
    return matched >= 1 && matched / queryTokens.length >= 0.7 && matched / Math.max(1, tokens.length) >= 0.5;
  });
}

/** 从候选日期提取有效年份。 */
export function tmdbCandidateYear(candidate: Pick<TmdbCandidateIdentity, "date">): number | null {
  return /^\d{4}/u.test(candidate.date) ? Number(candidate.date.slice(0, 4)) : null;
}

/** 候选必须先通过标题和年份门槛，再按鸿蒙评分挑选；同名跨年歧义不自动绑定。 */
export function pickStrictTmdbCandidate<T extends TmdbCandidateIdentity>(
  mediaType: "movie" | "tv", candidates: T[], query: string, year: number | null,
): T | undefined {
  const compatible = candidates.filter((candidate) => isTmdbCandidateTitleCompatible(query, candidate)
    && (!year || tmdbCandidateYear(candidate) === year));
  const exactYears = new Set(compatible.filter((candidate) => isTmdbStrongTitleMatch(query, candidate))
    .map(tmdbCandidateYear).filter((value) => value !== null));
  if (!year && exactYears.size >= 2) return undefined;
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const candidate of compatible) {
    const score = mediaType === "movie"
      ? (isTmdbStrongTitleMatch(query, candidate) ? 1000 : 100) + (year ? 200 : 0) + Math.min(20, candidate.popularity)
      : scoreTvCandidate(candidate, query, year);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** 节目评分沿用鸿蒙的标题、首播年份及流行度权重。 */
function scoreTvCandidate(candidate: TmdbCandidateIdentity, query: string, year: number | null): number {
  const queryText = FlymbyVideoTitleCleaner.normalizeSearchText(query);
  let score = candidate.popularity + (year && tmdbCandidateYear(candidate) === year ? 120 : 0);
  for (const title of [candidate.title, candidate.originalTitle]) {
    const text = FlymbyVideoTitleCleaner.normalizeSearchText(title);
    if (!text) continue;
    if (text === queryText) score += 1000;
    else if (text.includes(queryText) || queryText.includes(text)) score += 80;
    if (queryText.length >= 2 && text.startsWith(queryText) && text.length > queryText.length
      && /[\u4e00-\u9fa5]/u.test(text.slice(queryText.length, queryText.length + 1))) score -= 450;
  }
  return score;
}

/** 与 APP 第 5 版一致：严格匹配失败后标题优先，同分比较年份，再保留搜索顺序。 */
export function pickAppTmdbFallbackCandidate<T extends TmdbCandidateIdentity>(
  candidates: T[], query: string, year: number | null,
): T | undefined {
  let selected: T | undefined;
  let bestTitleScore = -1001;
  let bestYearMatched = false;
  for (const candidate of candidates) {
    const titleScore = isTmdbStrongTitleMatch(query, candidate) ? 1000
      : isTmdbCandidateTitleCompatible(query, candidate) ? 100 : -1000;
    const yearMatched = Boolean(year && tmdbCandidateYear(candidate) === year);
    if (titleScore > bestTitleScore || (titleScore === bestTitleScore && yearMatched && !bestYearMatched)) {
      selected = candidate;
      bestTitleScore = titleScore;
      bestYearMatched = yearMatched;
    }
  }
  return selected;
}

/** 合并同类型两轮结果，保留首轮顺序并按 TMDB ID 去重。 */
export function mergeTmdbCandidates<T extends TmdbCandidateIdentity>(first: T[], second: T[]): T[] {
  const merged = new Map(first.map((candidate) => [candidate.id, candidate]));
  for (const candidate of second) if (!merged.has(candidate.id)) merged.set(candidate.id, candidate);
  return [...merged.values()];
}
