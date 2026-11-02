import path from "node:path";
import type { ProviderEntry } from "../../providers/types.js";
import { collectEpisodeEvidence } from "./context-evidence.js";
import { isRecognitionVideo, recognitionParserEntry } from "./video-entry.js";
import { WebdavMediaPathEvidence } from "../app-recognition/WebdavMediaPathEvidence.js";
import { compareVideoTitle } from "./title-comparison.js";

/** 来源编号只描述原始命名；未核对官方顺序前不是规范单集号。 */
export interface VideoSourceOrdinal {
  ordinal: number;
  syntax: "explicit" | "leading" | "bracket" | "trailing";
  label: string;
  episodeTitle: string;
}

/** 编号上下文在完整目录中构造，再随目标文件传到在线裁决；不以联网批次重新统计。 */
export interface VideoNumberingContext {
  directoryPath: string;
  enumerationComplete: boolean;
  videoCount: number;
  numberedVideoCount: number;
  distinctOrdinalCount: number;
  minimumOrdinal: number | null;
  maximumOrdinal: number | null;
  duplicateOrdinalCount: number;
  segmentedFiles: number;
  labels: string[];
  explicitSeasons: number[];
  explicitIds: number[];
  sourceRange: { start: number; end: number } | null;
  cohortSupported: boolean;
  /** 最多六个分布取样的原文标题锚点，只用于核验，不将它们当模型生成答案。 */
  anchors: Array<{ fileId: string; ordinal: number; title: string }>;
}

/** 上下分段、合并多集或附属内容不能混入一对一编号模式。 */
function segmentedOrExtra(name: string): boolean {
  return /(?:第\s*\d+\s*[集话話]|E\d+)[ ._-]*[（(\[]?[上下中](?:集|篇|部|[）)\]]|$)|(?:^|[ ._\-\[(])(?:part[ ._-]*\d+|cd\d+|预告|花絮|样片|trailer|sample|OP\d*|ED\d*)(?=$|[ ._\-\])])|S\d+E\d+(?:E\d+|[-~]E?\d+)/iu.test(name);
}

/** 收集有闭合边界的原集号，日期、技术数字和不相容的多个标记保持未知。 */
export function collectSourceOrdinal(entry: ProviderEntry): VideoSourceOrdinal | null {
  if (!isRecognitionVideo(entry) || segmentedOrExtra(entry.name)) return null;
  const evidence = collectEpisodeEvidence(entry.path, []);
  if (evidence.dates.length || evidence.seasonConflict) return null;
  const name = recognitionParserEntry(entry).name;
  const stem = name.replace(/\.[^.]+$/u, "").replace(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}/giu, "");
  const explicit = [...stem.matchAll(/S\d{1,2}E(\d{1,4})(?!\d)|(?<![\p{L}\p{N}])EP?(\d{1,4})(?!\d)|第\s*(\d{1,4})\s*[集话話]/giu)];
  if (explicit.length) {
    const numbers = [...new Set(explicit.map((match) => Number(match[1] ?? match[2] ?? match[3])))];
    if (numbers.length !== 1) return null;
    const match = explicit[0]!;
    const tail = stem.slice(match.index! + match[0].length);
    const prefix = stem.slice(0, match.index).trim();
    const redundantIndex = /^\d+[ ._-]*$/u.test(prefix) && Number(prefix.replace(/[ ._-]/gu, "")) === numbers[0];
    return { ordinal: numbers[0]!, syntax: "explicit", label: redundantIndex ? "" : compareVideoTitle(prefix),
      episodeTitle: caption(tail) };
  }
  const leading = /^\s*(\d{1,4})(?=$|[ ._-])/u.exec(stem);
  const bracket = [...stem.matchAll(/[\[【](\d{1,4})[\]】]/gu)]
    .filter((match) => ![480, 720, 1080, 2160, 4320].includes(Number(match[1])));
  const trailing = /[ _-](\d{1,4})\s*$/u.exec(stem);
  const match = leading ?? (bracket.length === 1 ? bracket[0] : null) ?? trailing;
  if (!match) return null;
  const ordinal = Number(match[1]);
  if (ordinal <= 0 || ordinal >= 1888 && ordinal <= 2100) return null;
  const syntax = leading ? "leading" : bracket.length === 1 ? "bracket" : "trailing";
  const label = syntax === "leading" ? "" : compareVideoTitle(stem.slice(0, match.index));
  return { ordinal, syntax, label, episodeTitle: syntax === "trailing" ? "" : caption(stem.slice(match.index! + match[0].length)) };
}

/** 标题锚点只截明确技术尾缀，保留原语言正文，不翻译、不推测缺失标题。 */
function caption(value: string): string {
  const tail = value.replace(/(?:^|[ ._\-([【])(?:\d{3,5}[x×]\d{3,5}|\d{3,4}[pi]|[248]k|x26[45]|h26[45]|WEB-DL|BluRay|BDRIP|HEVC|flac|AAC)(?:\b|[ ._\-\])】]).*$/iu, "")
    .replace(/^[\s._\-:：]+|[\s._\-]+$/gu, "").trim();
  return [...compareVideoTitle(tail)].length >= 3 && !/^(?:第?[零〇一二两三四五六七八九十百千万\d]+[集话話]?|episode\s*\d+)$/iu.test(tail) ? tail : "";
}

/** 原始目录一次统计；未知媒体范围、混合作品或重复／分段不得被目标文件截取掩盖。 */
export function collectNumberingContext(entries: ProviderEntry[], root: string, directory: string, enumerationComplete: boolean) {
  const videos = entries.filter(isRecognitionVideo);
  const ordinals = new Map<string, VideoSourceOrdinal>();
  const seasons = new Set<number>(); const ids = new Set<number>();
  let segmentedFiles = 0;
  for (const entry of videos) {
    const ordinal = collectSourceOrdinal(entry);
    if (ordinal) ordinals.set(entry.resourceId, ordinal);
    if (segmentedOrExtra(entry.name)) segmentedFiles += 1;
    const season = collectEpisodeEvidence(entry.path, []).explicitSeason;
    if (season !== null) seasons.add(season);
    for (const match of entry.path.matchAll(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{2,10})/giu)) ids.add(Number(match[1]));
  }
  const values = [...ordinals.values()];
  const distinct = [...new Set(values.map((value) => value.ordinal))].sort((a, b) => a - b);
  const labels = [...new Set(values.map((value) => value.label).filter(Boolean))];
  const range = /^(\d{1,4})\s*[-~至]\s*(\d{1,4})$/u.exec(path.posix.basename(directory));
  const sourceRange = range && Number(range[1]) <= Number(range[2]) ? { start: Number(range[1]), end: Number(range[2]) } : null;
  const candidates = [...ordinals].filter(([, value]) => value.episodeTitle)
    .map(([fileId, value]) => ({ fileId, ordinal: value.ordinal, title: value.episodeTitle })).sort((a, b) => a.ordinal - b.ordinal);
  const anchors = candidates.length <= 6 ? candidates : Array.from({ length: 6 }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / 5)]!);
  const context: VideoNumberingContext = { directoryPath: directory, enumerationComplete, videoCount: videos.length,
    numberedVideoCount: values.length, distinctOrdinalCount: distinct.length, minimumOrdinal: distinct[0] ?? null,
    maximumOrdinal: distinct.at(-1) ?? null, duplicateOrdinalCount: values.length - distinct.length, segmentedFiles,
    labels: labels.slice(0, 6), explicitSeasons: [...seasons], explicitIds: [...ids], sourceRange,
    cohortSupported: enumerationComplete && directory !== root && videos.length >= 3 && distinct.length >= 3
      && values.length / videos.length >= 0.8 && values.length === distinct.length && segmentedFiles === 0
      && labels.length <= 1 && seasons.size <= 1 && ids.size <= 1
      && (!sourceRange || distinct.every((number) => number >= sourceRange.start && number <= sourceRange.end))
      && !WebdavMediaPathEvidence.isMixedMediaBucketDirectory(directory)
      && !WebdavMediaPathEvidence.isCollectionContainerDirectory(directory), anchors };
  return { context, ordinals };
}
