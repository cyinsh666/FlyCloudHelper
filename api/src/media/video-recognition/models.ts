import type { EpisodeEvidence, ProviderIdEvidence } from "./context-evidence.js";
import type { DateDirectoryEvidence } from "./date-directory-evidence.js";
import type { VideoInputMediaKind } from "./video-entry.js";
import type { VideoNumberingContext, VideoSourceOrdinal } from "./numbering-context.js";
import type { VideoNfoEvidence, VideoNfoSidecar, VideoNfoDiagnostic } from "./nfo-evidence.js";
import type { VideoSeasonContextEvidence } from "./path-title-evidence.js";

/** 已枚举祖先目录的子目录名，仅用于核对索引结构，不传任何连接配置。 */
export interface VideoAncestorDirectorySnapshot {
  directoryPath: string;
  enumerationComplete: boolean;
  childDirectories: string[];
}

/** 备用标题必须保留层级与结构依据，不能靠删词后的文字直接认定身份。 */
export interface VideoDirectoryTitleEvidence {
  title: string;
  year: number | null;
  sourcePath: string;
  originalTitle: string;
  kind: "alphabet_index" | "peer_index" | "language_version_parent";
  peerCount: number;
  matchingPeers: number;
}

/** APP 与云助手传递的目录快照；文件路径相对于扫描根，不传连接凭据。 */
export interface VideoRecognitionInput {
  rootPath: string;
  directoryPath: string;
  enumerationComplete: boolean;
  files: Array<{ id: string; name: string; size?: number; modifiedAt?: string | null; etag?: string | null;
    /** 调用端已有分类；缺省才使用默认后缀。 */
    mediaKind?: VideoInputMediaKind }>;
  childDirectories?: string[];
  ancestorDirectorySnapshots?: VideoAncestorDirectorySnapshot[];
  sidecarPolicy?: "ignore" | "use";
  sidecars?: VideoNfoSidecar[];
}

/** 保留查询来源，避免一次清理丢失原始标题后无法回退。 */
export interface VideoTitleEvidence {
  title: string;
  source: "rule" | "numeric_title" | "classification_tag" | "file_structure" | "file_fallback" | "parent_directory" | "date_directory" | "directory_structure" | "path_structure" | "nfo";
  /** 备用目录候选自己的年份不覆盖原始强年份。 */
  year?: number | null;
}

/** 规则结果与最终在线身份分开；解析成功不代表已经识别正确。 */
export interface VideoRecognitionItem {
  fileId: string;
  filePath: string;
  mediaType: "movie" | "tv" | "unknown";
  year: number | null;
  seasonNumber: number | null;
  episodeNumbers: number[];
  tmdbId: number | null;
  titles: VideoTitleEvidence[];
  workKey: string;
  reasons: string[];
  requiresReview: boolean;
  contentRole?: "unknown" | "commentary";
  /** 原始来源修订与算法派生字段分开，规则升级不应清空人工确认。 */
  sourceVersion?: { size: number; modifiedAt: string | null; etag: string | null };
  providerIdEvidence?: ProviderIdEvidence | null;
  episodeEvidence?: EpisodeEvidence;
  dateDirectoryEvidence?: DateDirectoryEvidence;
  directoryTitleEvidence?: VideoDirectoryTitleEvidence[];
  numberingContext?: VideoNumberingContext;
  sourceOrdinal?: VideoSourceOrdinal;
  nfoEvidence?: VideoNfoEvidence;
  seasonContextEvidence?: VideoSeasonContextEvidence;
}

/** 目录规则版本由接口和实验回放共同使用。 */
export interface VideoRecognitionResult {
  ruleVersion: string;
  enumerationComplete: boolean;
  items: VideoRecognitionItem[];
  sidecarDiagnostics?: VideoNfoDiagnostic[];
}
