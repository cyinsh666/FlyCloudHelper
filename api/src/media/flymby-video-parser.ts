import path from "node:path";
import type { ProviderEntry } from "../providers/types.js";
import { WebdavVideoNameParser, normalizeWebdavVideoSearchText } from "./app-recognition/WebdavVideoNameParser.js";
import { WebdavVideoTitleCleaner } from "./app-recognition/WebdavVideoTitleCleaner.js";
import { WebdavVideoMediaTypeRecognizer } from "./app-recognition/WebdavVideoMediaTypeRecognizer.js";
import { WebdavMediaMovieEvidence } from "./app-recognition/WebdavMediaMovieEvidence.js";
import { WebdavMediaPathEvidence } from "./app-recognition/WebdavMediaPathEvidence.js";
import { WebdavMovieParentFallbackHelper } from "./app-recognition/WebdavMovieParentFallbackHelper.js";
import { WebdavScannedVideoFile } from "./app-recognition/models.js";
import { WebdavMediaRecognitionInput, WebdavMediaDirectoryInput, WebdavDirectoryVideoFileIndex, type WebdavDirectoryTvScanContext } from "./app-recognition/WebdavMediaRecognitionModels.js";
import { normalizeWebdavPath } from "./app-recognition/path.js";

export type FlymbyParsedVideoType = "movie" | "tv";
// 关键变量：同步 APP 标题优先第 5 版，并使旧源文件识别和 AI 查询缓存失效。
export const FLYMBY_VIDEO_NAME_CLEANER_VERSION = "flymby-app-64c528ba-recognition-v5-20260913";

export interface FlymbyParsedVideoName {
  mediaType: FlymbyParsedVideoType;
  fileName: string;
  baseName: string;
  title: string;
  query: string;
  /** 电影目录查询无候选时，从原始文件名提取的第二查询词。 */
  fallbackQuery: string;
  /** 本次媒体类型和标题的主要识别依据，仅供诊断日志使用。 */
  recognitionReason: string;
  /** 明确电影目录是否阻止了一次文件名节目误判。 */
  blockedFalseEpisode: boolean;
  /** 是否因文件名为空或过弱而使用父目录标题。 */
  usedParentTitleFallback: boolean;
  /** 是否使用节目目录年份替换了单集文件年份。 */
  seriesYearCorrected: boolean;
  /** 是否由高密度季集文件纠正了上级电影分类。 */
  overrodeMovieCategoryWithEpisodes?: boolean;
  /** 是否从被弱集号规则影响的原始文件名恢复了电影标题。 */
  recoveredNumericMovieTitle?: boolean;
  /** 是否将节目分类目录中的单文件或同片多版本纠正为电影。 */
  overrodeTvCategoryWithMovieVariants?: boolean;
  /** 是否只使用同名电影目录年份，阻止更上层节目年份越级覆盖。 */
  movieDirectoryYearCorrected?: boolean;
  /** 是否通过数字目录名与多数同名前缀季集文件确认了纯数字节目名。 */
  confirmedNumericSeriesTitle?: boolean;
  /** 数字电影片名由独立发行年份确认，允许通过弱标题门槛。 */
  confirmedNumericMovieTitle?: boolean;
  /** 直属父目录补查身份，只由完整目录枚举生成。 */
  parentMovieDirectoryPath?: string;
  parentMovieFallback?: { parentPath: string; query: string; year: number | null };
  /** 合集内不同文件片名的独立任务身份。 */
  collectionFileTitle?: string;
  /** APP 判型原因和清洗命中项，供失败报告追查。 */
  recognitionDetail?: string;
  titleNoise?: string[];
  year: number | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeNumbers: number[];
  imdbId: string;
  tmdbId: number;
  resolution: string;
  source: string;
  releaseGroup: string;
  /** AI 只补充查询词，不修改真实文件名、媒体类型或季集结构。 */
  aiCleanedTitle?: string;
  aiAlternateTitle?: string;
  aiConfidence?: number;
  aiReason?: string;
}


/** 去掉显式 TMDB 标记，保持 APP 查询词构造顺序。 */
function stripTmdbId(value: string): string {
  return value.replace(/[\{\[\(【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}\s*[\}\]\)】）]?/gi, " ");
}

/** 读取路径或文件中显式给出的 TMDB ID，不把普通数字当编号。 */
function readTmdbId(entry: ProviderEntry): number {
  const match = /(?:^|[\s._\-({\[【（])(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{2,10})(?:[\s._\-)}\]】）]|$)/i.exec(entry.path + " " + entry.name);
  return Number(match?.[1] ?? 0);
}

/** 单文件重试也使用 APP 同一判型入口；目录证据只在完整枚举后传入。 */
export function parseFlymbyVideoName(entry: ProviderEntry, rootPath: string): FlymbyParsedVideoName {
  return recognizeEntry(entry, rootPath);
}

/** 将 APP 的识别结果适配为云助手字段，不重复实现判型规则。 */
function recognizeEntry(entry: ProviderEntry, rootPath: string, directoryContext?: WebdavDirectoryTvScanContext): FlymbyParsedVideoName {
  const input = new WebdavMediaRecognitionInput();
  input.rootPath = rootPath;
  input.filePath = entry.path;
  input.fileName = entry.name;
  input.directoryContext = directoryContext;
  const result = WebdavVideoMediaTypeRecognizer.recognize(input);
  const parsed = result.parsed;
  const file = new WebdavScannedVideoFile();
  file.rootPath = rootPath;
  file.path = normalizeWebdavPath(entry.path);
  file.parentPath = WebdavVideoNameParser.getParentPath(file.path);
  file.name = entry.name;
  file.parsed = parsed;
  const tmdbId = readTmdbId(entry);
  const mediaType = tmdbId > 0
    ? WebdavVideoMediaTypeRecognizer.inferExplicitTmdbTaskType(file, parsed.mediaType === "tv" ? "tv" : "movie")
    : parsed.mediaType === "tv" ? "tv" : "movie";
  const rawQuery = parsed.query || parsed.title;
  const query = WebdavVideoTitleCleaner.cleanTitle(stripTmdbId(rawQuery)) || rawQuery.trim();
  const sourceParsed = WebdavVideoNameParser.parse(entry.name, entry.path);
  let fallbackQuery = mediaType === "movie"
    ? WebdavMediaMovieEvidence.buildFirstMoviePartFallback(rootPath, file.parentPath, query) : "";
  if (!fallbackQuery && mediaType === "movie") {
    const candidate = WebdavVideoTitleCleaner.cleanTitle(stripTmdbId(sourceParsed.query || sourceParsed.title));
    if (candidate && !WebdavVideoTitleCleaner.isGenericBucketTitle(candidate)
      && (!WebdavVideoNameParser.isWeakScrapeTitle(candidate) || hasNumericMovieTitleEvidence(entry.name, candidate))) fallbackQuery = candidate;
  }
  if (normalizeWebdavVideoSearchText(fallbackQuery) === normalizeWebdavVideoSearchText(query)) fallbackQuery = "";
  const collection = WebdavMediaPathEvidence.isCollectionContainerDirectory(file.parentPath)
    || WebdavMediaPathEvidence.isMixedMediaBucketDirectory(file.parentPath);
  const independentTitle = WebdavVideoTitleCleaner.cleanTitle(sourceParsed.title);
  const collectionFileTitle = collection && independentTitle
    && (hasNumericMovieTitleEvidence(entry.name, independentTitle)
      || (!WebdavVideoNameParser.isGenericMovieFileTitle(independentTitle) && !WebdavVideoNameParser.isWeakScrapeTitle(independentTitle)))
    ? normalizeWebdavVideoSearchText(independentTitle) : "";
  return {
    ...parsed, mediaType, query, fallbackQuery, tmdbId,
    year: parsed.year > 0 ? parsed.year : null,
    recognitionReason: result.rule, recognitionDetail: result.reason,
    blockedFalseEpisode: mediaType === "movie" && sourceParsed.mediaType === "tv",
    usedParentTitleFallback: query !== sourceParsed.query,
    seriesYearCorrected: mediaType === "tv" && parsed.year !== sourceParsed.year,
    confirmedNumericMovieTitle: hasNumericMovieTitleEvidence(entry.name, query),
    collectionFileTitle,
    titleNoise: WebdavVideoTitleCleaner.analyzeTitleNoise(entry.name).matchedWords,
    seasonNumber: mediaType === "movie" ? 0 : parsed.seasonNumber,
    episodeNumber: mediaType === "movie" ? 0 : parsed.episodeNumber,
    episodeNumbers: mediaType === "movie" ? [] : parsed.episodeNumbers,
  };
}

/** 完整枚举后一次准备目录证据，识别过程不新增网盘请求。 */
export function parseFlymbyVideoDirectory(entries: ProviderEntry[], rootPath: string): Map<string, FlymbyParsedVideoName> {
  const videos = entries.filter(entry => !entry.isDirectory && /\.(mp4|mkv|iso|avi|mov|wmv|flv|m4v|ts|m2ts|webm|rmvb|mpg|mpeg|3gp|strm)$/i.test(entry.name));
  const first = videos[0];
  const results = new Map<string, FlymbyParsedVideoName>();
  if (!first) return results;
  const input = new WebdavMediaDirectoryInput();
  input.rootPath = rootPath;
  input.currentPath = WebdavVideoNameParser.getParentPath(first.path);
  input.videoItems = videos.map(entry => {
    const item = new WebdavDirectoryVideoFileIndex();
    item.path = normalizeWebdavPath(entry.path); item.name = entry.name;
    item.parentPath = input.currentPath; item.fileStem = WebdavVideoNameParser.getFileStem(entry.name);
    item.extension = path.posix.extname(entry.name).slice(1).toLowerCase();
    item.item = {path: item.path, name: entry.name, isDirectory: false};
    return item;
  });
  const directories = new Set([...(first.siblingDirectoryNames ?? []), ...entries.filter(entry => entry.isDirectory).map(entry => entry.name)]);
  input.directoryItems = [...directories].map(name => ({name, path: input.currentPath + "/" + name, isDirectory: true}));
  const context = WebdavVideoMediaTypeRecognizer.prepareDirectory(input);
  const parentTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(stripTmdbId(path.posix.basename(input.currentPath)));
  const canUseParent = !context.isTv && input.currentPath !== "/"
    && !WebdavMediaPathEvidence.isCollectionContainerDirectory(input.currentPath)
    && !WebdavVideoTitleCleaner.isGenericBucketTitle(path.posix.basename(input.currentPath))
    && WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(parentTitle)
    && WebdavMovieParentFallbackHelper.hasSingleMovieEvidence(videos.map(entry => entry.name));
  const parentYear = WebdavVideoNameParser.parse(path.posix.basename(input.currentPath)).year;
  for (const entry of videos) {
    const parsed = recognizeEntry(entry, rootPath, context);
    if (canUseParent && parsed.mediaType === "movie" && parsed.tmdbId <= 0) {
      parsed.parentMovieDirectoryPath = input.currentPath;
      if (!(parentYear > 0 && parsed.year && parentYear !== parsed.year)) {
        parsed.parentMovieFallback = {parentPath: input.currentPath, query: parentTitle, year: parentYear || parsed.year};
      }
    }
    results.set(entry.resourceId, parsed);
  }
  return results;
}

/** 保留云助手稳定分组格式，同时按 APP 的直属父目录身份隔离补查任务。 */
export function buildFlymbyScrapeTaskKey(parsed: FlymbyParsedVideoName): string {
  if (parsed.tmdbId > 0) return `${parsed.mediaType}|tmdb|${parsed.tmdbId}`;
  const query = normalizeWebdavVideoSearchText(parsed.query);
  let key = parsed.imdbId ? `${parsed.mediaType}|imdb|${parsed.imdbId}` : query ? `${parsed.mediaType}|${query}|${parsed.year ?? ""}` : "";
  if (key && parsed.mediaType === "movie" && parsed.collectionFileTitle && parsed.collectionFileTitle !== query) key += `|独立片名|${encodeURIComponent(parsed.collectionFileTitle)}`;
  if (key && parsed.mediaType === "movie" && parsed.parentMovieDirectoryPath) key += `|movie-parent-v1|${encodeURIComponent(parsed.parentMovieDirectoryPath)}`;
  return key;
}

/** 弱查询标题与 APP 使用同一判定。 */
export function isWeakFlymbyScrapeTitle(value: string): boolean {
  return WebdavVideoNameParser.isWeakScrapeTitle(value);
}

/** 数字电影名需要 APP 要求的独立发行年份证据。 */
export function hasNumericMovieTitleEvidence(fileName: string, title: string): boolean {
  return WebdavVideoNameParser.hasNumericMovieTitleEvidence(fileName, title);
}
