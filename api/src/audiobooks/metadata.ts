import type { MediaDescriptor } from "../media/filename.js";
import { AUDIO_TAG_PARSER_VERSION, type AudioTagReadResult } from "../music/audio-tag-reader.js";
import { readAudiobookChapterNumber } from "./filename.js";

/** 将音频标签与文件内章节用于有声书资料，不调用音乐或影视在线匹配。 */
export function applyAudiobookAudioTags(
  descriptor: MediaDescriptor,
  result: AudioTagReadResult,
  options: { enabled?: boolean; preferEmbeddedMetadata?: boolean; extractEmbeddedChapters?: boolean } = {},
): MediaDescriptor {
  const metadata = descriptor.metadata;
  const useMetadata = options.enabled !== false;
  const embeddedAuthors = result.tags.authors?.length ? result.tags.authors : result.tags.artists;
  const authors = useMetadata ? embeddedAuthors : [];
  const narrators = useMetadata ? (result.tags.narrators ?? []) : [];
  const chapterNumber =
    Number(metadata.chapterNumber) ||
    (useMetadata ? result.tags.trackNumber || readAudiobookChapterNumber(result.tags.title) : 0) ||
    0;
  const discNumber =
    metadata.explicitDiscNumber === true || !useMetadata
      ? Number(metadata.discNumber) || 1
      : result.tags.discNumber || Number(metadata.discNumber) || 1;
  // 关键变量：纯卷号标签不能覆盖作品名，避免每个卷扫描时反复重命名作品。
  const taggedBookTitle =
    result.tags.album && !/^(?:第.+[卷部册]|(?:cd|disc|part|vol)[\s._-]*\d+)$/iu.test(result.tags.album)
      ? result.tags.album
      : "";
  const bookTitle =
    !useMetadata || options.preferEmbeddedMetadata === false
      ? String(metadata.bookTitle || descriptor.subtitle)
      : taggedBookTitle || String(metadata.bookTitle || descriptor.parent?.title || descriptor.subtitle);
  const title =
    !useMetadata || options.preferEmbeddedMetadata === false
      ? descriptor.title
      : result.tags.title || descriptor.title;
  return {
    ...descriptor,
    title,
    subtitle: bookTitle,
    year: useMetadata ? (result.tags.year ?? descriptor.year) : descriptor.year,
    matchState: result.technical.durationMs > 0 ? "matched" : "needs_review",
    sortTitle: `${String(discNumber).padStart(5, "0")}-${String(chapterNumber).padStart(8, "0")}-${descriptor.sortTitle.split("-").slice(2).join("-")}`,
    metadata: {
      ...metadata,
      bookTitle,
      chapterNumber,
      discNumber,
      authors,
      narrators,
      genres: useMetadata ? result.tags.genres : [],
      description: useMetadata ? result.tags.description || "" : "",
      publisher: useMetadata ? result.tags.publisher || "" : "",
      language: useMetadata ? result.tags.language || "" : "",
      durationMs: result.technical.durationMs,
      container: result.technical.container,
      codec: result.technical.codec,
      bitRate: result.technical.bitRate,
      sampleRate: result.technical.sampleRate,
      channels: result.technical.channels,
      audioContainer: result.technical.container,
      audioCodec: result.technical.codec,
      audioBitRate: result.technical.bitRate,
      audioSampleRate: result.technical.sampleRate,
      audioChannels: result.technical.channels,
      audioBitDepth: result.technical.bitDepth,
      chapters: !useMetadata || options.extractEmbeddedChapters === false ? [] : (result.chapters ?? []),
      embeddedArtwork: useMetadata && result.artwork.embedded,
      embeddedArtworkUrl: useMetadata ? result.artwork.url : null,
      tagStatus: result.status,
      tagParserVersion: AUDIO_TAG_PARSER_VERSION,
      audiobookMetadataSource: useMetadata ? "embedded_tag" : "path",
    },
    parent: descriptor.parent
      ? {
          ...descriptor.parent,
          title: bookTitle,
          subtitle: authors.join("、") || "有声书",
          year: useMetadata ? (result.tags.year ?? descriptor.parent.year) : descriptor.parent.year,
          sortOrder: Math.min(2_147_483_647, discNumber * 1_000_000 + chapterNumber),
        }
      : undefined,
  };
}

/** 为作品父项保留独立的书籍资料，不把单个音频文件的时长当作全书时长。 */
export function readAudiobookBookMetadata(descriptor: MediaDescriptor): Record<string, unknown> {
  return {
    bookDirectory: descriptor.metadata.bookDirectory,
    authors: descriptor.metadata.authors ?? [],
    narrators: descriptor.metadata.narrators ?? [],
    genres: descriptor.metadata.genres ?? [],
    description: descriptor.metadata.description ?? "",
    publisher: descriptor.metadata.publisher ?? "",
    language: descriptor.metadata.language ?? "",
    audiobookMetadataSource: descriptor.metadata.audiobookMetadataSource ?? "path",
  };
}
