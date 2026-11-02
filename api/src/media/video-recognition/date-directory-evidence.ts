import path from "node:path";
import type { ProviderEntry } from "../../providers/types.js";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import { WebdavMediaPathEvidence } from "../app-recognition/WebdavMediaPathEvidence.js";
import { collectEpisodeEvidence } from "./context-evidence.js";
import { compareVideoTitle } from "./title-comparison.js";
import { isRecognitionVideo } from "./video-entry.js";

/** 目录形态只提供节目候选，不能代替官方系列身份或单集位置。 */
export interface DateDirectoryEvidence {
  titleCandidates: string[];
  videoCount: number;
  datedVideoCount: number;
  distinctDates: number;
  periodTaggedFiles: number;
  originalMediaType?: "movie" | "tv" | "unknown";
  originalYear?: number | null;
}

/** 完整目录一次收集日期结构；混合桶、合集和扫描根不能用比例猜作品。 */
export function collectDateDirectoryEvidence(entries: ProviderEntry[], root: string, directory: string,
  enumerationComplete: boolean): { evidence: DateDirectoryEvidence; fileIds: Set<string> } | null {
  if (!enumerationComplete || root === directory || WebdavMediaPathEvidence.isMixedMediaBucketDirectory(directory)
    || WebdavMediaPathEvidence.isCollectionContainerDirectory(directory)) return null;
  const videos = entries.filter(isRecognitionVideo);
  if (videos.length < 3) return null;
  const fileIds = new Set<string>();
  const dates = new Set<string>();
  let periodTaggedFiles = 0;
  for (const entry of videos) {
    if (!/^(?:19|20)\d{2}[._-]?\d{2}[._-]?\d{2}/u.test(entry.name)) continue;
    const evidence = collectEpisodeEvidence(entry.path, []);
    if (evidence.dates.length !== 1) continue;
    fileIds.add(entry.resourceId);
    dates.add(evidence.dates[0]!);
    if (/期|加更|特别企划/u.test(entry.name)) periodTaggedFiles += 1;
  }
  if (dates.size < 3 || fileIds.size / videos.length < 0.6 || periodTaggedFiles < 2) return null;
  const rawTitle = path.posix.basename(directory);
  // 状态词须位于末尾并有分隔，不从正式作品名内部删“更新”等正文。
  const withoutStatus = rawTitle.replace(/[\s._-]+(?:持续更新|更新中|更新|已完结|完结)\s*$/u, "");
  const titleCandidates: string[] = [];
  for (const raw of [withoutStatus, rawTitle]) {
    const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(raw);
    if (title && !WebdavVideoNameParser.isWeakScrapeTitle(title)
      && !titleCandidates.some((previous) => compareVideoTitle(previous) === compareVideoTitle(title))) titleCandidates.push(title);
  }
  if (!titleCandidates.length) return null;
  return { fileIds, evidence: { titleCandidates, videoCount: videos.length, datedVideoCount: fileIds.size,
    distinctDates: dates.size, periodTaggedFiles } };
}
