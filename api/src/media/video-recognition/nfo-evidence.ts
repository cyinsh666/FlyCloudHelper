import path from "node:path";
import { createHash } from "node:crypto";
import { validationError } from "../../errors.js";
import type { VideoRecognitionInput, VideoRecognitionItem, VideoRecognitionResult } from "./models.js";
import { parseVideoRecognitionNfo, type VideoNfoRecord } from "./nfo-parser.js";
import { compareVideoTitle } from "./title-comparison.js";
import { WebdavMovieParentFallbackHelper } from "../app-recognition/WebdavMovieParentFallbackHelper.js";
import { WebdavMediaPathEvidence } from "../app-recognition/WebdavMediaPathEvidence.js";
import { collectFileTitleStructure } from "./file-title-evidence.js";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import { collectEpisodeEvidence } from "./context-evidence.js";
import type { VideoNumberingContext, VideoSourceOrdinal } from "./numbering-context.js";

/** 小文件由APP或提供者按已有设置读取；识别接口不接收任意下载地址或来源密码。 */
export interface VideoNfoSidecar {
  id: string;
  path: string;
  readStatus: "ok" | "failed" | "too_large" | "not_found";
  text?: string;
  size?: number;
  modifiedAt?: string | null;
  etag?: string | null;
}

/** 失败与忽略分开返回，不把读失败当成元数据不存在。 */
export interface VideoNfoDiagnostic {
  sidecarId: string;
  path: string;
  status: string;
  reason: string | null;
}

/** 保留对象层级、来源修订和原文散列；不在每个文件重复返回整份XML。 */
export interface VideoNfoDocument extends VideoNfoRecord {
  sidecarId: string;
  path: string;
  rawHash: string;
  sourceVersion: { size: number | null; modifiedAt: string | null; etag: string | null };
}

/** 原规则与本地证据并列，规范单集仍须在线核对。 */
export interface VideoNfoEvidence {
  documents: VideoNfoDocument[];
  work: { mediaType: "movie" | "tv"; tmdbId: number | null; title: string; year: number | null } | null;
  episodes: Array<{ seasonNumber: number; episodeNumber: number; tmdbEpisodeId: number | null; title: string; airDate: string | null }>;
  seasonNumber: number | null;
  conflicts: string[];
  /** 命名季目录的作品前缀须再与官方名称／别名核对，不能直接穿过另一个作品。 */
  scopeTitles: string[];
  /** 电影来源年与NFO年可属于不同官方发行地区，留待同一身份的发行日期核验。 */
  yearConflict?: { sourceYear: number; nfoYear: number };
  originalRule: { mediaType: VideoRecognitionItem["mediaType"]; year: number | null; tmdbId: number | null;
    seasonNumber: number | null; episodeNumbers: number[] };
}

/** 路径必须在扫描根内且资源名保持原样，不能用相对跳转或URL引入旁路元数据。 */
function sidecarPath(value: unknown, root: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || !/\.nfo$/iu.test(value) || value.includes("\u0000")
    || value.split("/").some((part) => part === "." || part === "..")
    || root !== "/" && !value.startsWith(root + "/")) throw validationError("sidecars", "NFO路径必须在扫描根内");
  return value;
}

/** 读取方要明确状态；忽略策略不解析或消费已经传来的内容。 */
function documents(input: VideoRecognitionInput, root: string, diagnostics: VideoNfoDiagnostic[]): VideoNfoDocument[] {
  if (input.sidecarPolicy !== undefined && !["ignore", "use"].includes(input.sidecarPolicy)) throw validationError("sidecarPolicy", "NFO策略必须为 ignore 或 use");
  if (input.sidecarPolicy !== "use") return [];
  if (input.sidecars === undefined) return [];
  if (!Array.isArray(input.sidecars) || input.sidecars.length > 128) throw validationError("sidecars", "请提供最多128份已读取NFO");
  const ids = new Set<string>(); const paths = new Set<string>(); const result: VideoNfoDocument[] = [];
  let totalBytes = 0;
  for (const sidecar of input.sidecars) {
    const currentPath = sidecarPath(sidecar?.path, root);
    if (typeof sidecar.id !== "string" || !sidecar.id || ids.has(sidecar.id) || paths.has(currentPath)
      || !["ok", "failed", "too_large", "not_found"].includes(sidecar.readStatus)) throw validationError("sidecars", "NFO标识、路径须唯一，读取状态须明确");
    ids.add(sidecar.id); paths.add(currentPath);
    if (sidecar.size !== undefined && (!Number.isSafeInteger(sidecar.size) || sidecar.size < 0)
      || sidecar.etag !== undefined && sidecar.etag !== null && typeof sidecar.etag !== "string"
      || sidecar.modifiedAt !== undefined && sidecar.modifiedAt !== null && typeof sidecar.modifiedAt !== "string") {
      throw validationError("sidecars", "NFO来源修订无效");
    }
    if (sidecar.readStatus !== "ok") { diagnostics.push({ sidecarId: sidecar.id, path: currentPath, status: sidecar.readStatus, reason: "nfo_not_read" }); continue; }
    if (typeof sidecar.text !== "string") throw validationError("sidecars", "成功读取的NFO必须包含原文");
    const bytes = Buffer.byteLength(sidecar.text, "utf8"); totalBytes += bytes;
    if (bytes > 256 * 1024 || totalBytes > 1024 * 1024) {
      diagnostics.push({ sidecarId: sidecar.id, path: currentPath, status: "too_large", reason: "nfo_size_budget_exceeded" });
      continue;
    }
    const parsed = parseVideoRecognitionNfo(sidecar.text);
    diagnostics.push({ sidecarId: sidecar.id, path: currentPath, status: parsed.records.length ? "parsed" : "unusable", reason: parsed.reason });
    for (const record of parsed.records) result.push({ ...record, sidecarId: sidecar.id, path: currentPath,
      rawHash: createHash("sha256").update(sidecar.text).digest("hex"), sourceVersion: { size: sidecar.size ?? null,
        modifiedAt: sidecar.modifiedAt ?? null, etag: sidecar.etag ?? null } });
  }
  return result;
}

/** 整剧继承只穿明确季／范围／语言／规格节点；文件自身相同显式ID可另作独立桥梁。 */
function seriesScope(document: VideoNfoDocument, item: VideoRecognitionItem): string[] | null {
  if (path.posix.basename(document.path).toLowerCase() !== "tvshow.nfo") return null;
  const owner = path.posix.dirname(document.path); const directory = path.posix.dirname(item.filePath);
  if (directory !== owner && !directory.startsWith(owner === "/" ? "/" : owner + "/")) return null;
  const id = document.identities.find((identity) => identity.provider === "tmdb" && identity.entityKind === "tv");
  if (id && item.providerIdEvidence?.layer === "file" && item.tmdbId === Number(id.id)) return [];
  const titles: string[] = [];
  for (const name of path.posix.relative(owner, directory).split("/").filter(Boolean)) {
    if (/^(?:Season[ ._-]*\d{1,2}|S\d{1,2}|第\s*[零〇一二两三四五六七八九十\d]{1,3}\s*季|\d{1,4}\s*[-~至]\s*\d{1,4}|[248]K|\d{3,4}[pi])(?:[ ._-]*[（(【\[].*[）)】\]])?$/iu.test(name)
      || /^(?:国语|粤语|日语|英语|韩语)(?:\s*[（(【\[].*[）)】\]])?$/u.test(name)) continue;
    const marker = /(?:^|[ ._-])(?:S\d{1,2}|Season[ ._-]*\d{1,2})(?=$|[ ._-])|第\s*[零〇一二两三四五六七八九十\d]{1,3}\s*季/iu.exec(name);
    if (!marker) return null;
    const tail = name.slice(marker.index + marker[0].length).replace(/^[ ._-]+/u, "");
    if (tail && !/^(?:\d{3,4}[pi]|[248]K|WEB[ ._-]?DL|WEBRip|BluRay|BDRIP|REMUX|Part[ ._-]*\d+|全集|完结)(?:\b|[ ._-])/iu.test(tail)) return null;
    const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(name.slice(0, marker.index));
    if (!title) return null;
    if (!id && ![document.title, document.originalTitle].some((value) => compareVideoTitle(value) === compareVideoTitle(title))) return null;
    titles.push(title);
  }
  return titles;
}

/** 只有明确作品关系才应用文档，电影共用NFO还要求完整单电影范围。 */
export function applyVideoNfoEvidence(input: VideoRecognitionInput, result: VideoRecognitionResult,
  numbering: { context: VideoNumberingContext; ordinals: Map<string, VideoSourceOrdinal> }): VideoRecognitionResult {
  if (input.sidecarPolicy === undefined || input.sidecarPolicy === "ignore") return result;
  const root = input.rootPath.replace(/\/+$/u, "") || "/";
  const diagnostics: VideoNfoDiagnostic[] = [];
  const records = documents(input, root, diagnostics);
  const directory = input.directoryPath.replace(/\/+$/u, "") || "/";
  // 只检查当前目录名，不能借远祖先季号把任意子作品目录当作同一季。
  const directorySeason = collectEpisodeEvidence("/" + path.posix.basename(directory) + "/season.nfo", []).explicitSeason;
  const movieScope = input.enumerationComplete && !WebdavMediaPathEvidence.isMixedMediaBucketDirectory(directory)
    && !WebdavMediaPathEvidence.isCollectionContainerDirectory(directory) && (result.items.length === 1
      || result.items.length > 1 && WebdavMovieParentFallbackHelper.hasSingleMovieEvidence(result.items.map((item) => path.posix.basename(item.filePath))));
  for (const item of result.items) {
    const stem = item.filePath.replace(/\.[^.]+$/u, "");
    const scopeTitles: string[] = [];
    const applied = records.filter((record) => {
      const sameStem = record.path.slice(0, -4) === stem;
      if (record.rootType === "episodedetails") return sameStem;
      if (record.rootType === "movie") return sameStem || movieScope && path.posix.dirname(record.path) === directory && path.posix.basename(record.path).toLowerCase() === "movie.nfo";
      if (record.rootType === "tvshow") {
        const scope = seriesScope(record, item);
        if (scope === null) return false;
        scopeTitles.push(...scope);
        return true;
      }
      return path.posix.dirname(record.path) === directory && path.posix.basename(record.path).toLowerCase() === "season.nfo"
        && (directorySeason !== null || records.some((candidate) => candidate.rootType === "tvshow" && seriesScope(candidate, item) !== null));
    });
    if (!applied.length) continue;
    const conflicts = applied.flatMap((record) => record.conflicts);
    const workRecords = applied.filter((record) => record.rootType === "movie" || record.rootType === "tvshow");
    const workTypes = new Set(workRecords.map((record) => record.rootType));
    const workIds = [...new Set(workRecords.flatMap((record) => record.identities.filter((identity) => identity.provider === "tmdb"
      && ["movie", "tv"].includes(identity.entityKind)).map((identity) => Number(identity.id))))];
    if (workTypes.size > 1 || workIds.length > 1) conflicts.push("conflicting_nfo_work_identities");
    const preferred = workRecords[0];
    const work = preferred ? { mediaType: preferred.rootType === "movie" ? "movie" as const : "tv" as const,
      tmdbId: workIds.length === 1 ? workIds[0]! : null, title: preferred.title, year: preferred.year } : null;
    if (work?.tmdbId && item.tmdbId && work.tmdbId !== item.tmdbId) conflicts.push("nfo_conflicts_with_explicit_work_id");
    if (work?.mediaType === "movie" && (item.episodeEvidence?.hasExplicitEpisode || item.episodeEvidence?.explicitSeason !== null && item.episodeEvidence?.explicitSeason !== undefined)) conflicts.push("movie_nfo_conflicts_with_strong_tv_evidence");
    const yearConflict = work?.mediaType === "movie" && work.year && item.year && work.year !== item.year
      ? { sourceYear: item.year, nfoYear: work.year } : undefined;
    const episodeRecords = applied.filter((record) => record.rootType === "episodedetails");
    if (episodeRecords.length && !work && item.mediaType === "movie" && item.tmdbId) {
      conflicts.push("episode_nfo_cannot_reinterpret_movie_id_as_series");
    }
    const showTitles = [...new Set(episodeRecords.map((record) => record.showTitle).filter(Boolean))];
    if (showTitles.length > 1) conflicts.push("conflicting_nfo_series_titles");
    const episodeRows = episodeRecords.filter((record) => record.seasonNumber !== null && record.episodeNumber !== null)
      .map((record) => ({ seasonNumber: record.seasonNumber!, episodeNumber: record.episodeNumber!, title: record.title, airDate: record.airDate,
        tmdbEpisodeId: Number(record.identities.find((identity) => identity.provider === "tmdb" && identity.entityKind === "episode")?.id) || null }));
    const seasonNumbers = [...new Set(applied.filter((record) => record.rootType === "season" || record.rootType === "episodedetails")
      .map((record) => record.seasonNumber).filter((number): number is number => number !== null))];
    const season = seasonNumbers.length === 1 ? seasonNumbers[0]! : null;
    if (seasonNumbers.length > 1 && applied.some((record) => record.rootType === "season")) conflicts.push("conflicting_nfo_seasons");
    const byPosition = new Map<string, typeof episodeRows[number]>();
    for (const episode of episodeRows) {
      const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
      const previous = byPosition.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(episode)) conflicts.push("conflicting_nfo_episode_records");
      byPosition.set(key, episode);
    }
    const episodes = [...byPosition.values()];
    const explicitSeason = item.episodeEvidence?.explicitSeason;
    if (explicitSeason !== null && explicitSeason !== undefined && (season !== null && season !== explicitSeason
      || episodes.some((episode) => episode.seasonNumber !== explicitSeason))) conflicts.push("nfo_conflicts_with_source_season");
    if (episodes.length && item.episodeEvidence?.hasExplicitEpisode && item.episodeNumbers.length
      && JSON.stringify([...new Set(episodes.map((episode) => episode.episodeNumber))].sort((a, b) => a - b)) !== JSON.stringify([...item.episodeNumbers].sort((a, b) => a - b))) conflicts.push("nfo_conflicts_with_source_episodes");
    item.nfoEvidence = { documents: applied, work, episodes, seasonNumber: season,
      conflicts: [...new Set(conflicts)], scopeTitles: [...new Set(scopeTitles)], yearConflict,
      originalRule: { mediaType: item.mediaType, year: item.year, tmdbId: item.tmdbId,
        seasonNumber: item.seasonNumber, episodeNumbers: [...item.episodeNumbers] } };
    if (conflicts.length) {
      item.requiresReview = true; item.reasons.push("conflicting_nfo_evidence");
      item.workKey = createHash("sha256").update(JSON.stringify([item.workKey, "nfo_conflict", item.fileId])).digest("hex");
      continue;
    }
    const originalType = item.mediaType;
    if (work) {
      item.mediaType = work.mediaType;
      if (work.tmdbId) item.tmdbId = work.tmdbId;
      if (work.year) item.year = work.year;
      const titles = workRecords.flatMap((record) => [record.title, record.originalTitle]).filter(Boolean);
      for (const title of titles.reverse()) if (!item.titles.some((evidence) => compareVideoTitle(evidence.title) === compareVideoTitle(title))) item.titles.unshift({ title, source: "nfo" });
      if (!item.reasons.includes("conflicting_explicit_ids") && item.contentRole !== "commentary") item.requiresReview = false;
      item.reasons.push("related_nfo_work_evidence");
    } else if (episodeRecords.length) {
      if (item.mediaType !== "tv") item.year = collectFileTitleStructure(path.posix.basename(directory) + ".mkv").independentYear;
      item.mediaType = "tv";
      if (showTitles.length === 1 && !item.titles.some((evidence) => compareVideoTitle(evidence.title) === compareVideoTitle(showTitles[0]!))) {
        item.titles.unshift({ title: showTitles[0]!, source: "nfo" });
      }
      if (item.titles.length && !item.reasons.includes("conflicting_explicit_ids") && item.contentRole !== "commentary") item.requiresReview = false;
      item.reasons.push("same_stem_nfo_episode_evidence");
    }
    if (item.mediaType === "movie") { item.seasonNumber = null; item.episodeNumbers = []; }
    else if (item.mediaType === "tv" && originalType !== "tv") {
      // 改型后复用先前已读取的原文证据，不拿NFO的未验证位置回填成文件明确季集。
      item.numberingContext = numbering.context; item.sourceOrdinal = numbering.ordinals.get(item.fileId);
      item.seasonNumber = item.episodeEvidence?.explicitSeason ?? null;
      item.episodeNumbers = item.sourceOrdinal?.syntax === "explicit" ? [item.sourceOrdinal.ordinal] : [];
    }
    // 同一整剧NFO覆盖的文件按作品合组；冲突已按文件隔离，单集位置仍逐文件核对。
    if (work) item.workKey = createHash("sha256").update(JSON.stringify(["nfo_work", work.mediaType,
      work.tmdbId ?? [directory, work.year], compareVideoTitle(work.title), item.providerIdEvidence?.boundaryTitle ?? null,
      scopeTitles.map(compareVideoTitle), yearConflict?.sourceYear ?? null])).digest("hex");
    else if (episodeRecords.length && showTitles.length === 1) item.workKey = createHash("sha256").update(JSON.stringify([
      directory, "nfo_episode_series", item.tmdbId, compareVideoTitle(showTitles[0]!), item.year])).digest("hex");
  }
  return { ...result, sidecarDiagnostics: diagnostics };
}
