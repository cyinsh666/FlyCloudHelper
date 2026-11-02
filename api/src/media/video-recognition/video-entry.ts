import path from "node:path";
import type { ProviderEntry } from "../../providers/types.js";

/** 调用方既有媒体分类优先，缺省保持原默认视频范围。 */
export type VideoInputMediaKind = "video" | "audio" | "other";

/** 仅在本模块内部携带媒体分类，不改提供者的资源定位字段。 */
export interface VideoRecognitionEntry extends ProviderEntry {
  recognitionMediaKind?: VideoInputMediaKind;
}

/** 全部证据统计共用此判断，避免自定义视频只进入部分规则。 */
export function isRecognitionVideoName(name: string, mediaKind?: VideoInputMediaKind): boolean {
  return mediaKind === undefined
    ? /\.(mp4|mkv|iso|avi|mov|wmv|flv|m4v|ts|m2ts|webm|rmvb|mpg|mpeg|3gp|strm)$/iu.test(name)
    : mediaKind === "video";
}

/** 目录、显式非视频与默认后缀统一分开。 */
export function isRecognitionVideo(entry: ProviderEntry): boolean {
  return !entry.isDirectory && isRecognitionVideoName(entry.name, (entry as VideoRecognitionEntry).recognitionMediaKind);
}

/** 旧解析器只识别固定后缀，自定义视频在私有副本使用已支持后缀；不传回真实定位。 */
export function recognitionParserEntry(entry: ProviderEntry): ProviderEntry {
  const kind = (entry as VideoRecognitionEntry).recognitionMediaKind;
  if (entry.isDirectory || kind !== "video" || isRecognitionVideoName(entry.name)) return entry;
  const extension = path.posix.extname(entry.name);
  // 明确季集、年份和规格位于末尾时可能本来没有后缀，不能把它们当自定义后缀删除。
  const extensionIsStructure = /^\.(?:s\d{1,2}(?:e\d{1,4})?|ep?\d{1,4}|\d{1,4}|\d{3,4}[pi]|[248]k|v\d+)$/iu.test(extension);
  const stem = extension && !extensionIsStructure ? entry.name.slice(0, -extension.length) : entry.name;
  const name = stem + ".mkv";
  return { ...entry, name, path: path.posix.join(path.posix.dirname(entry.path), name) };
}
