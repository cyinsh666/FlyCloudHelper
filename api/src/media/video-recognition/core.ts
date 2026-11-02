import path from "node:path";
import { createHash } from "node:crypto";
import { validationError } from "../../errors.js";
import { parseFlymbyVideoDirectory, parseFlymbyVideoName } from "../flymby-video-parser.js";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import type { ProviderEntry } from "../../providers/types.js";
import type { VideoAncestorDirectorySnapshot, VideoRecognitionInput, VideoRecognitionItem, VideoRecognitionResult, VideoTitleEvidence } from "./models.js";
import { collectFileTitleStructure, isExplicitCommentaryFile } from "./file-title-evidence.js";
import { collectEpisodeEvidence, collectProviderIdEvidence } from "./context-evidence.js";
import { compareVideoTitle } from "./title-comparison.js";
import { collectDateDirectoryEvidence } from "./date-directory-evidence.js";
import { collectDirectoryTitleEvidence } from "./directory-title-evidence.js";
import { isRecognitionVideo, recognitionParserEntry, type VideoRecognitionEntry } from "./video-entry.js";
import { collectNumberingContext } from "./numbering-context.js";
import { applyVideoNfoEvidence } from "./nfo-evidence.js";
import { collectPathTitleEvidence } from "./path-title-evidence.js";
export { compareVideoTitle } from "./title-comparison.js";

/** 新工具的版本独立于旧扫描器，实验期间保留旧入口的行为。 */
export const VIDEO_RECOGNITION_RULE_VERSION = "video-recognition-experiment-v15";

/** 只接受明确的资源绝对路径，不静默修改资源身份。 */
function checkPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\u0000")
    || value.split("/").some((part) => part === "." || part === "..")) {
    throw validationError(field, "请提供不含相对跳转的资源路径");
  }
  return value.length > 1 ? value.replace(/\/+$/u, "") : "/";
}

/** 祖先只接收已经枚举的目录名，不越过扫描根，也不把缺失快照假装成完整快照。 */
function readAncestorSnapshots(input: VideoRecognitionInput, root: string, directory: string): VideoAncestorDirectorySnapshot[] {
  if (input.ancestorDirectorySnapshots === undefined) return [];
  if (!Array.isArray(input.ancestorDirectorySnapshots) || input.ancestorDirectorySnapshots.length > 32) {
    throw validationError("ancestorDirectorySnapshots", "请提供最多 32 个祖先目录快照");
  }
  const paths = new Set<string>();
  return input.ancestorDirectorySnapshots.map((snapshot) => {
    const current = checkPath(snapshot?.directoryPath, "ancestorDirectorySnapshots");
    const inRoot = root === "/" || current === root || current.startsWith(root + "/");
    const isAncestor = current === "/" ? directory !== "/" : directory.startsWith(current + "/");
    if (!inRoot || !isAncestor || paths.has(current) || typeof snapshot.enumerationComplete !== "boolean"
      || !Array.isArray(snapshot.childDirectories) || snapshot.childDirectories.length > 5000
      || snapshot.childDirectories.some((name) => typeof name !== "string" || !name || /[/\\\u0000]/u.test(name) || name === "." || name === "..")) {
      throw validationError("ancestorDirectorySnapshots", "祖先快照必须位于扫描根内且目录名有效");
    }
    paths.add(current);
    return { directoryPath: current, enumerationComplete: snapshot.enumerationComplete, childDirectories: [...new Set(snapshot.childDirectories)] };
  });
}

/** 校验目录快照，确保 APP 传入的完整性标志不被默认猜测。 */
function readEntries(input: VideoRecognitionInput): { root: string; directory: string; entries: VideoRecognitionEntry[] } {
  if (!input || typeof input !== "object") throw validationError("input", "请提供目录快照");
  const root = checkPath(input.rootPath, "rootPath");
  const directory = checkPath(input.directoryPath, "directoryPath");
  if (root !== "/" && directory !== root && !directory.startsWith(root + "/")) {
    throw validationError("directoryPath", "目录必须位于扫描根内");
  }
  if (typeof input.enumerationComplete !== "boolean" || !Array.isArray(input.files) || input.files.length > 5000) {
    throw validationError("files", "请提供最多 5000 个文件和明确的目录完整性标志");
  }
  const ids = new Set<string>(); // 文件 ID 仅用于本次来源内的结果关联。
  const entries: VideoRecognitionEntry[] = input.files.map((file) => {
    if (!file || typeof file.id !== "string" || !file.id || ids.has(file.id)
      || typeof file.name !== "string" || !file.name || /[/\\\u0000]/u.test(file.name)
      || file.name === "." || file.name === "..") throw validationError("files", "文件 ID 必须唯一且文件名有效");
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0)) throw validationError("files", "文件大小无效");
    if ((file.etag !== undefined && file.etag !== null && typeof file.etag !== "string")
      || (file.modifiedAt !== undefined && file.modifiedAt !== null && typeof file.modifiedAt !== "string")) {
      throw validationError("files", "文件来源修订无效");
    }
    ids.add(file.id);
    if (file.mediaKind !== undefined && !["video", "audio", "other"].includes(file.mediaKind)) {
      throw validationError("files", "媒体分类必须为 video、audio 或 other");
    }
    return { resourceId: file.id, parentResourceId: directory, path: path.posix.join(directory, file.name),
      name: file.name, isDirectory: false, size: file.size ?? 0, modifiedAt: file.modifiedAt ?? null, etag: file.etag ?? null,
      locator: {}, recognitionMediaKind: file.mediaKind };
  });
  if (input.childDirectories !== undefined && (!Array.isArray(input.childDirectories) || input.childDirectories.length > 5000)) {
    throw validationError("childDirectories", "子目录快照无效");
  }
  for (const name of input.childDirectories ?? []) {
    if (typeof name !== "string" || !name || /[/\\\u0000]/u.test(name) || name === "." || name === "..") {
      throw validationError("childDirectories", "子目录名称无效");
    }
    entries.push({ resourceId: path.posix.join(directory, name), parentResourceId: directory,
      path: path.posix.join(directory, name), name, isDirectory: true, size: 0, modifiedAt: null, etag: null, locator: {} });
  }
  return { root, directory, entries };
}

/** 加入有出处的查询词，过滤无信息的规格词和重复标题。 */
function addTitle(titles: VideoTitleEvidence[], title: string, source: VideoTitleEvidence["source"], confirmedNumericTitle = false): void {
  const text = title.trim();
  if (!text || (!confirmedNumericTitle && WebdavVideoNameParser.isWeakScrapeTitle(text))
    || titles.some((item) => compareVideoTitle(item.title) === compareVideoTitle(text))) return;
  titles.push({ title: text, source });
}

/** 提供者编号可能正好长得像年份；排除编号后只采纳唯一的有边界发行年份。 */
function readIndependentFileYear(name: string): number | null {
  const text = name.replace(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}/giu, "");
  const years = [...text.matchAll(/(?:^|[\s._()\[\]{}（）【】-])((?:18|19|20)\d{2})(?=$|[\s._()\[\]{}（）【】-])/gu)]
    .map((match) => Number(match[1])).filter((year) => year >= 1888 && year <= new Date().getFullYear() + 2);
  const distinct = [...new Set(years)];
  return distinct.length === 1 ? distinct[0]! : null;
}

/** 根据完整目录或单文件上下文生成可解释的候选，不请求网络或修改现有媒体库。 */
export function recognizeVideoDirectory(input: VideoRecognitionInput): VideoRecognitionResult {
  const { root, directory, entries } = readEntries(input);
  // 关键变量：不完整目录只能走单文件入口，禁止把部分文件推断成完整目录结构。
  const parserEntries = entries.filter((entry) => entry.isDirectory || isRecognitionVideo(entry)).map(recognitionParserEntry);
  const parserById = new Map(parserEntries.map((entry) => [entry.resourceId, entry]));
  const directoryResults = input.enumerationComplete ? parseFlymbyVideoDirectory(parserEntries, root) : null;
  const dateDirectory = collectDateDirectoryEvidence(entries, root, directory, input.enumerationComplete);
  const ancestorSnapshots = readAncestorSnapshots(input, root, directory);
  const directoryTitleEvidence = collectDirectoryTitleEvidence(root, directory, entries, input.enumerationComplete, ancestorSnapshots);
  const numbering = collectNumberingContext(entries, root, directory, input.enumerationComplete);
  const pathTitleCache = new Map<number | null, ReturnType<typeof collectPathTitleEvidence>>();
  const items: VideoRecognitionItem[] = [];
  for (const entry of entries) {
    if (!isRecognitionVideo(entry)) continue;
    const parserEntry = parserById.get(entry.resourceId)!;
    const parsed = directoryResults?.get(entry.resourceId) ?? parseFlymbyVideoName(parserEntry, root);
    const episodeEvidence = collectEpisodeEvidence(entry.path, parsed.episodeNumbers);
    let pathTitles = pathTitleCache.get(episodeEvidence.explicitSeason);
    if (!pathTitles) {
      pathTitles = collectPathTitleEvidence(root, directory, entry.path);
      pathTitleCache.set(episodeEvidence.explicitSeason, pathTitles);
    }
    const titles: VideoTitleEvidence[] = [];
    const reasons = [parsed.recognitionReason];
    const categoryTag = /^[【\[]((?:韩|日|美|英|国|港|台)(?:综|剧)|国产剧)[】\]]/u.exec(entry.name)?.[1];
    // 仅删除原文件中有明确括号边界的地区类别标签，不删除任意括号内容。
    if (categoryTag && parsed.query.startsWith(categoryTag + " ")) {
      addTitle(titles, parsed.query.slice(categoryTag.length).trim(), "classification_tag");
      reasons.push("removed_bounded_category_tag");
    }
    const numericPrefix = /^(\d{1,3})(?=[\u4e00-\u9fff])/u.exec(entry.name)?.[1];
    // 紧贴正文的数字属于原始片名；仅当旧解析标题正好是被删除前缀后的正文时恢复。
    const repairedNumericTitle = Boolean(numericPrefix && parsed.title && entry.name.startsWith(numericPrefix + parsed.title));
    if (repairedNumericTitle) {
      addTitle(titles, numericPrefix + parsed.title, "numeric_title");
      reasons.push("preserved_numeric_title_prefix");
    }
    // 已证明丢失数字的标题不能作为备用搜索词，否则会误绑另一部同名作品。
    const confirmedNumericTitle = /^\d+$/u.test(parsed.query)
      && Boolean(parsed.confirmedNumericMovieTitle || parsed.confirmedNumericSeriesTitle);
    if (!repairedNumericTitle || parsed.query !== parsed.title) addTitle(titles, parsed.query, "rule", confirmedNumericTitle);
    if (!repairedNumericTitle || parsed.fallbackQuery !== parsed.title) addTitle(titles, parsed.fallbackQuery, "file_fallback");
    if (parsed.parentMovieFallback) addTitle(titles, parsed.parentMovieFallback.query, "parent_directory");
    // 新证据追加到原候选之后；普通查询仍优先保留原有已正确识别场景。
    const fileStructure = collectFileTitleStructure(parserEntry.name, parsed.year);
    for (const title of fileStructure.titles) {
      const confirmedShortTitle = fileStructure.independentYear !== null && /^[A-Za-z]$/u.test(title);
      addTitle(titles, title, "file_structure", confirmedShortTitle);
    }
    let mediaType: VideoRecognitionItem["mediaType"] = !titles.length && parsed.tmdbId <= 0 ? "unknown" : parsed.mediaType;
    if (mediaType === "tv") for (const evidence of pathTitles.titles) addTitle(titles, evidence.title, "path_structure");
    // 备用目录词追加在原证据之后，媒体类型和全局年份不因本分支改变。
    for (const evidence of directoryTitleEvidence) {
      if (!titles.some((existing) => existing.source === "directory_structure" && compareVideoTitle(existing.title) === compareVideoTitle(evidence.title))) {
        titles.push({ title: evidence.title, source: "directory_structure", year: evidence.year });
      }
    }
    const ids = [...entry.path.slice(root === "/" ? 0 : root.length).matchAll(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{2,10})/giu)]
      .map((match) => Number(match[1]));
    const idConflict = new Set(ids).size > 1;
    if (idConflict) reasons.push("conflicting_explicit_ids");
    const idWasUsedAsYear = mediaType === "movie" && parsed.year !== null && ids.includes(parsed.year);
    let year = idWasUsedAsYear ? readIndependentFileYear(entry.name)
      : fileStructure.parsedYearInTechnicalTail ? fileStructure.independentYear : parsed.year;
    if (idWasUsedAsYear && year !== parsed.year) reasons.push("provider_id_excluded_from_year");
    if (fileStructure.parsedYearInTechnicalTail && year !== parsed.year) reasons.push("technical_tail_excluded_from_year");
    const commentary = isExplicitCommentaryFile(entry.name);
    if (commentary) reasons.push("explicit_commentary_not_feature");
    const providerIdEvidence = collectProviderIdEvidence(root, entry.path);
    let dateDirectoryEvidence: VideoRecognitionItem["dateDirectoryEvidence"];
    // 已有节目、显式编号、明确集号、独立电影年份及解说结果保持原证据优先级。
    if (mediaType !== "tv" && dateDirectory?.fileIds.has(entry.resourceId) && !commentary && !idConflict
      && parsed.tmdbId <= 0 && !episodeEvidence.hasExplicitEpisode && fileStructure.independentYear === null) {
      dateDirectoryEvidence = { ...dateDirectory.evidence, originalMediaType: mediaType, originalYear: year };
      const directoryTitles: VideoTitleEvidence[] = [];
      for (const title of dateDirectory.evidence.titleCandidates) addTitle(directoryTitles, title, "date_directory");
      if (directoryTitles.length) {
        titles.unshift(...directoryTitles);
        mediaType = "tv";
        // 原文件播出日不能当系列首播年；本候选暂不猜首播年份。
        year = null;
        reasons.push("complete_dated_programme_directory");
      }
    }
    const dateNumbering = mediaType === "tv" && episodeEvidence.dates.length > 0 && !episodeEvidence.hasExplicitEpisode;
    if (dateNumbering) reasons.push("date_requires_episode_mapping");
    if (providerIdEvidence?.boundaryTitle) reasons.push("inherited_id_crosses_named_work");
    // 编号冲突的文件独立待确认，不能和同编号的正常文件合组后继承其身份。
    const groupEvidence = idConflict || commentary ? ["separate_file_evidence", entry.resourceId, entry.path]
      : providerIdEvidence?.boundaryTitle ? [directory, mediaType, providerIdEvidence.id, providerIdEvidence.boundaryTitle]
      : parsed.tmdbId > 0 ? [mediaType, parsed.tmdbId]
      : [directory, mediaType, compareVideoTitle(titles[0]?.title ?? entry.name), year];
    const workKey = createHash("sha256").update(JSON.stringify(groupEvidence)).digest("hex");
    items.push({ fileId: entry.resourceId, filePath: entry.path, mediaType, year,
      seasonNumber: mediaType === "tv" ? (dateNumbering ? episodeEvidence.explicitSeason : parsed.seasonNumber) : null,
      episodeNumbers: mediaType === "tv" && !dateNumbering ? parsed.episodeNumbers : [], tmdbId: parsed.tmdbId || null,
      titles, workKey, reasons, contentRole: commentary ? "commentary" : "unknown",
      providerIdEvidence, episodeEvidence,
      dateDirectoryEvidence,
      directoryTitleEvidence: directoryTitleEvidence.length ? directoryTitleEvidence : undefined,
      numberingContext: mediaType === "tv" ? numbering.context : undefined,
      sourceOrdinal: mediaType === "tv" ? numbering.ordinals.get(entry.resourceId) : undefined,
      seasonContextEvidence: mediaType === "tv" && (pathTitles.context.years.length || pathTitles.context.labels.length) ? pathTitles.context : undefined,
      sourceVersion: { size: entry.size, modifiedAt: entry.modifiedAt, etag: entry.etag },
      requiresReview: mediaType === "unknown" || idConflict || commentary });
  }
  return applyVideoNfoEvidence(input, { ruleVersion: VIDEO_RECOGNITION_RULE_VERSION, enumerationComplete: input.enumerationComplete, items }, numbering);
}
