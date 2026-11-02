import path from "node:path";
import type { ProviderEntry } from "../../providers/types.js";
import type { VideoAncestorDirectorySnapshot, VideoDirectoryTitleEvidence } from "./models.js";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import { WebdavMediaPathEvidence } from "../app-recognition/WebdavMediaPathEvidence.js";
import { collectFileTitleStructure } from "./file-title-evidence.js";
import { compareVideoTitle } from "./title-comparison.js";
import { isRecognitionVideo, recognitionParserEntry } from "./video-entry.js";

/** 语言版本节点须完整闭合，不从普通作品名中截出语言词。 */
const LANGUAGE_DIRECTORY = /^(?:国语|粤语|日语|英语|韩语|台语|泰语|俄语|法语|德语|西班牙语|葡萄牙语)(?:\s*[（(【\[].*[）)】\]])?$/u;

/** 只有明确结构目录可以继承索引作品名，另一个命名作品形成边界。 */
function transparentDirectory(name: string): boolean {
  return LANGUAGE_DIRECTORY.test(name)
    || /^(?:Season[ ._-]*\d{1,2}|S\d{1,2}|第[零〇一二两三四五六七八九十\d]{1,3}季)(?:[ ._-]*[（(【\[].*[）)】\]])?$/iu.test(name)
    || /^\d{1,4}\s*[-~至]\s*\d{1,4}$/u.test(name)
    || /^(?:[248]K|\d{3,4}[pi]|REMUX|BluRay|WEB-DL|原盘|蓝光)(?:[ ._-]*(?:国语|粤语|日语|英语|中字|双字))?$/iu.test(name);
}

/** 索引前缀与文字正文分开；短片名和普通英文不会因这一步被删掉。 */
function indexedName(value: string): { prefix: string; body: string } | null {
  const match = /^([A-Z]{1,3})[.．]\s*(.+)$/u.exec(value);
  if (!match || [...match[2]!].filter((character) => /\p{Script=Han}/u.test(character)).length < 2) return null;
  return { prefix: match[1]!, body: match[2]! };
}

/** 从已经确认的作品层产生候选，年份只附在这个候选上。 */
function titleEvidence(raw: string, sourcePath: string, kind: VideoDirectoryTitleEvidence["kind"],
  peerCount: number, matchingPeers: number): VideoDirectoryTitleEvidence | null {
  const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(raw);
  if (!title || WebdavVideoNameParser.isWeakScrapeTitle(title)) return null;
  return { title, year: collectFileTitleStructure(raw + ".mkv").independentYear,
    sourcePath, originalTitle: path.posix.basename(sourcePath), kind, peerCount, matchingPeers };
}

/** 范围桶、前缀落点、明确分隔和多数同级同形同时成立才提供去索引候选。 */
function alphabetEvidence(workPath: string, parent: VideoAncestorDirectorySnapshot | undefined): VideoDirectoryTitleEvidence | null {
  if (!parent?.enumerationComplete) return null;
  const peers = [...new Set(parent.childDirectories)];
  if (peers.length < 3) return null;
  const range = /^([A-Z]{1,3})\s*[-~]\s*([A-Z]{1,3})$/u.exec(path.posix.basename(parent.directoryPath));
  const name = path.posix.basename(workPath);
  if (!peers.includes(name)) return null;
  const parsed = indexedName(name);
  if (!parsed) return null;
  if (!range) {
    const matching = peers.map(indexedName).filter((peer) => peer?.prefix.length === parsed.prefix.length);
    if (peers.length < 5 || matching.length / peers.length < 0.8 || new Set(matching.map((peer) => peer!.prefix)).size < 3) return null;
    return titleEvidence(parsed.body, workPath, "peer_index", peers.length, matching.length);
  }
  if (range[1]!.length !== range[2]!.length || range[1]! > range[2]!) return null;
  /** 同一字母宽度及范围，防止把格式相似的普通名称算入支持比例。 */
  function inRange(value: ReturnType<typeof indexedName>): boolean {
    return Boolean(value && value.prefix.length === range![1]!.length
      && value.prefix >= range![1]! && value.prefix <= range![2]!);
  }
  if (!parsed || !inRange(parsed)) return null;
  const matchingPeers = peers.filter((child) => inRange(indexedName(child))).length;
  if (matchingPeers < 3 || matchingPeers / peers.length < 0.6) return null;
  return titleEvidence(parsed.body, workPath, "alphabet_index", peers.length, matchingPeers);
}

/** 一次收集当前目录链的备用标题，保持原强标题、媒体类型及全局年份不变。 */
export function collectDirectoryTitleEvidence(root: string, directory: string, entries: ProviderEntry[],
  enumerationComplete: boolean, ancestors: VideoAncestorDirectorySnapshot[]): VideoDirectoryTitleEvidence[] {
  const snapshots = new Map(ancestors.map((snapshot) => [snapshot.directoryPath, snapshot]));
  const results: VideoDirectoryTitleEvidence[] = [];
  let cursor = directory;
  while (cursor !== root && cursor !== "/") {
    const candidate = alphabetEvidence(cursor, snapshots.get(path.posix.dirname(cursor)));
    const descendants = path.posix.relative(cursor, directory).split("/").filter(Boolean);
    if (candidate && descendants.every(transparentDirectory)
      && !results.some((previous) => compareVideoTitle(previous.title) === compareVideoTitle(candidate.title))) results.push(candidate);
    cursor = path.posix.dirname(cursor);
  }
  // 语言名必须完整位于节点开头，其后的备注有括号边界；同级还要有足够的集号结构。
  const languageDirectory = LANGUAGE_DIRECTORY.test(path.posix.basename(directory));
  const parentPath = path.posix.dirname(directory);
  if (enumerationComplete && languageDirectory && parentPath !== root && parentPath !== "/"
    && !WebdavMediaPathEvidence.isMixedMediaBucketDirectory(parentPath)
    && !WebdavMediaPathEvidence.isCollectionContainerDirectory(parentPath)) {
    const videos = entries.filter(isRecognitionVideo);
    const episodeFiles = videos.filter((entry) => WebdavVideoNameParser.looksLikeEpisodeFileName(recognitionParserEntry(entry).name)).length;
    if (episodeFiles >= 3 && episodeFiles / videos.length >= 0.8) {
      const candidate = titleEvidence(path.posix.basename(parentPath), parentPath, "language_version_parent", videos.length, episodeFiles);
      if (candidate && !results.some((previous) => compareVideoTitle(previous.title) === compareVideoTitle(candidate.title))) results.push(candidate);
    }
  }
  return results.sort((left, right) => right.sourcePath.split("/").length - left.sourcePath.split("/").length);
}
