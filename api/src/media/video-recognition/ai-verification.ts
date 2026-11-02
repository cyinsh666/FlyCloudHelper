import path from "node:path";
import type { TmdbRecognitionIdentity } from "../../metadata/tmdb.js";
import type { VideoRecognitionInput, VideoRecognitionItem } from "./models.js";
import { collectFileTitleStructure } from "./file-title-evidence.js";
import { compareVideoTitle } from "./title-comparison.js";

/** 自动经验的桥梁来自完整原文或有边界结构，不采用模型自报的确信程度。 */
export interface VideoAiStrongProof {
  kind: "complete_source_title_and_official_identity";
  sourceTitle: string;
  sourcePath: string;
  officialTitle: string;
  officialId: number;
  officialMediaType: "movie" | "tv";
  verifiedAt: string;
}

/** 官方名和建议同名仍不够；另核对原文、明确编号、类型及来源年份。 */
export function verifyAiSourceIdentity(input: VideoRecognitionInput, item: VideoRecognitionItem,
  identity: TmdbRecognitionIdentity, suggestedTitle: string): VideoAiStrongProof | null {
  if (item.nfoEvidence?.conflicts.length || item.contentRole === "commentary" || item.reasons.includes("conflicting_explicit_ids")
    || item.providerIdEvidence?.boundaryTitle || (item.tmdbId && item.tmdbId !== identity.id)) return null;
  const episode = item.episodeEvidence;
  if (episode?.seasonConflict) return null;
  const strongTv = Boolean(episode?.hasExplicitEpisode || episode?.explicitSeason !== null && episode?.explicitSeason !== undefined
    || episode?.dates.length && /第\s*[0-9零〇一二三四五六七八九十百]+\s*期|加更(?:版)?|特别企划/u.test(path.posix.basename(item.filePath)));
  if (identity.mediaType === "movie" && strongTv) return null;
  if (identity.mediaType === "tv" && item.mediaType !== "tv" && !strongTv && !item.dateDirectoryEvidence) return null;
  if (item.year && identity.year !== item.year && !identity.releaseYears?.includes(item.year)) return null;
  const officialTitle = [identity.title, identity.originalTitle, ...identity.alternativeTitles]
    .find((title) => compareVideoTitle(title) === compareVideoTitle(suggestedTitle));
  if (!officialTitle || !compareVideoTitle(officialTitle)) return null;
  // 关键变量：只看文件自身和直接作品目录；更远祖先必须已有结构作用域证据。
  const fileName = path.posix.basename(item.filePath);
  const directory = path.posix.dirname(item.filePath);
  const rawDirectory = path.posix.basename(directory);
  const root = input.rootPath.replace(/\/+$/u, "") || "/";
  const sourceTitles = [{ title: fileName.replace(/\.[^.]+$/u, ""), sourcePath: item.filePath },
    ...collectFileTitleStructure(fileName, item.year).titles.map((title) => ({ title, sourcePath: item.filePath })),
    ...(directory !== root ? [{ title: rawDirectory, sourcePath: directory },
      { title: rawDirectory.replace(/[\s._-]+(?:持续更新|更新中|更新|已完结|完结)\s*$/u, ""), sourcePath: directory }] : []),
    ...(item.directoryTitleEvidence ?? []).map((evidence) => ({ title: evidence.title, sourcePath: evidence.sourcePath })),
    ...(item.dateDirectoryEvidence?.titleCandidates ?? []).map((title) => ({ title, sourcePath: directory }))];
  const source = sourceTitles.find((candidate) => compareVideoTitle(candidate.title) === compareVideoTitle(officialTitle));
  return source ? { kind: "complete_source_title_and_official_identity", sourceTitle: source.title,
    sourcePath: source.sourcePath, officialTitle, officialId: identity.id, officialMediaType: identity.mediaType,
    verifiedAt: new Date().toISOString() } : null;
}
