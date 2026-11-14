import type { TmdbKeyPool } from "../metadata/tmdb.js";
import type { RecommendationBlock, RecommendationItem } from "./service.js";

export const releaseLists = [
  { id: "tmdb-cn-now-playing", source: "now_playing", mediaType: "movie", title: "正在上映", description: "中国大陆近期院线上映的电影" },
  { id: "tmdb-cn-upcoming", source: "upcoming", mediaType: "movie", title: "即将上映", description: "中国大陆近期计划在院线上映的电影" },
  { id: "tmdb-tv-next-seven-days", source: "on_the_air", mediaType: "tv", title: "未来 7 天更新", description: "从今天起 7 天内有新集播出的剧集 · 北京时间" },
] as const;

type ReleaseList = typeof releaseLists[number];
export type ReleaseListCache = Record<string, { updatedAt: string; items: RecommendationItem[] }>;

/** 日期采用北京时间，包含当天在内共七个自然日。 */
function dateWindow(now: Date) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const lastDay = new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10);
  return { today, lastDay };
}

/** 三张榜单卡片始终可打开，空榜单与尚未取到数据分别显示。 */
export function releaseListDetail(list: ReleaseList, cached: ReleaseListCache[string] | undefined) {
  const { today, lastDay } = dateWindow(new Date());
  const items = (cached?.items ?? []).filter((item) => {
    if (!item.scheduleDate || list.source === "now_playing") return true;
    return list.source === "upcoming" ? item.scheduleDate > today
      : item.scheduleDate >= today && item.scheduleDate <= lastDay;
  });
  const block: RecommendationBlock = {
    id: list.id, title: list.title, description: list.description, group: "新片与追剧", category: "release",
    mediaType: list.mediaType, itemCount: items.length, posterUrl: items.find((item) => item.posterUrl)?.posterUrl ?? null,
    lastUpdated: cached?.updatedAt ?? null,
  };
  return { block, items };
}

/** 分页读取候选并核对实际排期，避免压满刮削共用的 TMDB Key 池。 */
export async function fetchReleaseList(tmdb: TmdbKeyPool, list: ReleaseList, now: Date, signal: AbortSignal) {
  const firstPage = await tmdb.readReleaseList(list.source, 1, signal);
  const candidates = new Map(firstPage.items.map((item) => [item.tmdbId, item]));
  // 关键变量：每榜最多读取前三页，详情每批最多两个并发；所有请求共享现有 Key 池。
  for (let page = 2; page <= Math.min(3, firstPage.totalPages); page++) {
    const result = await tmdb.readReleaseList(list.source, page, signal);
    for (const item of result.items) if (!candidates.has(item.tmdbId)) candidates.set(item.tmdbId, item);
  }
  const { today, lastDay } = dateWindow(now);
  const items: RecommendationItem[] = [];
  const candidateList = [...candidates.values()];
  for (let offset = 0; offset < candidateList.length; offset += 2) {
    const batch = await Promise.all(candidateList.slice(offset, offset + 2).map(async (item) => {
      let scheduleDate: string | undefined;
      if (list.source === "on_the_air") {
        const next = await tmdb.readNextEpisodeDate(item.tmdbId, signal);
        if (next >= today && next <= lastDay) scheduleDate = next;
      } else {
        const dates = await tmdb.readChinaTheatricalDates(item.tmdbId, signal);
        const inWindow = dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date)
          && (!firstPage.dates.min || date >= firstPage.dates.min)
          && (!firstPage.dates.max || date <= firstPage.dates.max)).sort();
        scheduleDate = list.source === "upcoming" ? inWindow.find((date) => date > today)
          : inWindow.filter((date) => date <= today).at(-1);
      }
      return scheduleDate ? { ...item, scheduleDate, rank: 0 } : null;
    }));
    for (const item of batch) if (item) items.push(item);
  }
  items.sort((a, b) => list.source === "now_playing"
    ? b.scheduleDate!.localeCompare(a.scheduleDate!) : a.scheduleDate!.localeCompare(b.scheduleDate!));
  return { updatedAt: now.toISOString(), items: items.map((item, index) => ({ ...item, rank: index + 1 })) };
}
