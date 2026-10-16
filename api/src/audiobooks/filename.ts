import path from "node:path";
import type { MediaDescriptor } from "../media/filename.js";
import type { ProviderEntry } from "../providers/types.js";

/** 有声书目录识别修订；分组或排序规则变化后重新处理已有音频文件。 */
export const AUDIOBOOK_RECOGNITION_REVISION = "audiobook-directory-v3-stable-volume-tuples-tags-chapters-v1";

/** 将阿拉伯数字和常见中文章节数字转换为整数。 */
export function readAudiobookNumber(value: string): number {
  const text = value.replace(/[０-９]/gu, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (/^\d+$/u.test(text)) return Number(text);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (!text || !/^[零〇一二两三四五六七八九十百千万]+$/u.test(text)) return 0;
  if (![...text].some((character) => units[character]))
    return Number([...text].map((character) => digits[character]).join(""));
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of text) {
    const unit = units[character];
    if (!unit) {
      digit = digits[character] ?? 0;
      continue;
    }
    if (unit === 10000) {
      total += (section + digit || 1) * unit;
      section = 0;
    } else section += (digit || 1) * unit;
    digit = 0;
  }
  return total + section + digit;
}

/** 识别独立分卷目录，避免把“书名第十卷”误当成独立卷号。 */
function readVolumeNumber(name: string): number | null {
  const match = name
    .trim()
    .match(
      /^(?:第\s*([\d０-９零〇一二两三四五六七八九十百千万]+)\s*[卷部册辑]|[卷部册]\s*([\d０-９零〇一二两三四五六七八九十百千万]+)|(?:cd|disc|disk|part|volume|vol)[\s._-]*([\d０-９]+)|([上中下])(?:卷|部|册))(?:[\s._:：-].*)?$/iu,
    );
  if (!match) return null;
  if (match[4]) return ({ 上: 1, 中: 2, 下: 3 } as Record<string, number>)[match[4]] ?? 1;
  return Math.max(1, readAudiobookNumber(match[1] || match[2] || match[3] || "1"));
}

/** 保留标题文本，同时让数字片段按自然顺序排序。 */
function naturalSortTitle(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/\d+/gu, (digits) => digits.padStart(12, "0"));
}

/** 从文件名或标签标题读取明确章节编号，缺失编号时保留零并交给自然标题排序。 */
export function readAudiobookChapterNumber(value: string): number {
  const match =
    value.match(/第\s*([\d０-９零〇一二两三四五六七八九十百千万]+)\s*[章集回节话]/u) ??
    value.match(/(?:^|[\s._-])([\d０-９零〇一二两三四五六七八九十百千万]+)\s*[章集回节话]/u) ??
    value.match(/^\s*(?:chapter|track|第)?\s*([\d０-９零〇一二两三四五六七八九十百千万]+)(?:[\s._-]|$)/iu);
  return match ? readAudiobookNumber(match[1] || "") : 0;
}

/** 按实际作品路径和分卷构建有声书文件；扫描根只控制枚举范围，不参与作品身份。 */
export function describeAudiobookFile(entry: ProviderEntry, _scanRootPath: string): MediaDescriptor {
  const directory = path.posix.dirname(entry.path);
  let bookDirectory = directory;
  let discNumber = 1;
  // 关键变量：分卷只影响排序，所有卷仍关联同一本作品。
  let volumeNumber: number | null = null;
  while (bookDirectory !== "/" && bookDirectory !== ".") {
    const folderName = path.posix.basename(bookDirectory);
    const currentVolume = readVolumeNumber(folderName);
    if (currentVolume !== null) {
      if (volumeNumber === null) {
        volumeNumber = currentVolume;
        discNumber = currentVolume;
      }
      bookDirectory = path.posix.dirname(bookDirectory);
      continue;
    }
    if (/^(?:音频|音频文件|章节|audio|mp3|m4b|flac)$/iu.test(folderName)) {
      bookDirectory = path.posix.dirname(bookDirectory);
      continue;
    }
    break;
  }
  const stem = entry.name.replace(/\.[^.]+$/u, "").trim();
  const fileVolumeMatch =
    stem.match(/^(.*?)第\s*([\d０-９零〇一二两三四五六七八九十百千万]+)\s*[卷部册](?:[\s._:：-].*)?$/u) ??
    stem.match(/^(.*?)(?:cd|disc|disk|part|volume|vol)[\s._-]*([\d０-９]+)(?:[\s._:：-].*)?$/iu);
  const fileVolumeNumber = fileVolumeMatch ? readAudiobookNumber(fileVolumeMatch[2] || "") : 0;
  if (volumeNumber === null && fileVolumeNumber > 0) discNumber = fileVolumeNumber;
  const chapterNumber = readAudiobookChapterNumber(stem);
  // 没有章号或卷号的 M4B 视为一文件一整书，作者目录下的多本 M4B 也不会合并成作者作品。
  const standaloneBook =
    /\.m4b$/iu.test(entry.name) && volumeNumber === null && fileVolumeNumber === 0 && chapterNumber === 0;
  const volumeBookTitle = (fileVolumeMatch?.[1] || "").replace(/[\s._·-]+$/u, "").trim();
  // 关键变量：明确书名的分卷始终隔离作品，不能把作者或“有声书”容器目录中的不同书合并。
  // 已有同名作品目录继续沿用目录身份，使其下的 M4B、MP3 和 CD/第N卷目录保持同一本书。
  const namedVolumeBook =
    fileVolumeNumber > 0 &&
    volumeBookTitle.length > 0 &&
    volumeBookTitle.toLocaleLowerCase("zh-CN") !==
      path.posix.basename(bookDirectory).trim().toLocaleLowerCase("zh-CN");
  const bookTitle = standaloneBook
    ? stem
    : namedVolumeBook
      ? volumeBookTitle
      : path.posix.basename(bookDirectory) || stem;
  // 分卷使用目录与书名元组，路径或书名中的冒号不会混淆两个字段的边界。
  const bookIdentity = standaloneBook
    ? `audiobook:book:file:${entry.resourceId}`
    : namedVolumeBook
      ? `audiobook:book:volumes:${JSON.stringify([bookDirectory, volumeBookTitle])}`
      : `audiobook:book:directory:${bookDirectory}`;
  const sortTitle = `${String(discNumber).padStart(5, "0")}-${String(chapterNumber).padStart(8, "0")}-${naturalSortTitle(stem)}`;
  return {
    identityKey: `audiobook:chapter:${entry.resourceId}`,
    mediaType: "audiobook",
    itemType: "audiobook.chapter",
    title: stem,
    sortTitle,
    subtitle: bookTitle,
    year: null,
    matchState: "matched",
    metadata: {
      sourcePath: entry.path,
      fileName: entry.name,
      bookTitle,
      bookDirectory,
      chapterNumber,
      discNumber,
      durationMs: 0,
      authors: [],
      narrators: [],
      genres: [],
      chapters: [],
      explicitDiscNumber: volumeNumber !== null || fileVolumeNumber > 0,
      audiobookMetadataSource: "path",
    },
    parent: {
      identityKey: bookIdentity,
      itemType: "audiobook.book",
      title: bookTitle,
      subtitle: "有声书",
      year: null,
      sortOrder: Math.min(2_147_483_647, discNumber * 1_000_000 + chapterNumber),
      relationType: "book_chapter",
    },
  };
}
