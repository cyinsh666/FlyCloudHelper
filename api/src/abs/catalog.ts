import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { absBookEntities, absEntityId, absNames } from "./catalog-metadata.js";
import { loadAbsBookSummaries, type AbsBookSummary } from "./catalog-summary.js";
import { absBookGenres, absBookLibraryId, absBookMatchesLibrary, withAbsLibraryViews } from "./library-views.js";
export { absEntityId, absNames } from "./catalog-metadata.js";
export type { AbsBookSummary } from "./catalog-summary.js";
import {
  readAbsArray,
  readAbsObject,
  readAbsSeconds,
  type AbsBook,
  type AbsContext,
  type AbsTrack,
} from "./types.js";

/** 获取当前库内的真实作品及完整音轨，任何其他媒体类型均不能越界投影。 */
export async function loadAbsBook(
  runtime: ApiRuntime,
  context: AbsContext,
  itemId: string,
): Promise<AbsBook> {
  context = await withAbsLibraryViews(runtime, context);
  let item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId || item.itemType !== "audiobook.book" || !absBookMatchesLibrary(context, item))
    throw new ApiError(404, "abs_book_not_found", "有声书不存在");
  const onlineAudiobook = String(item.libraryKind) === "content_source_audiobook";
  if (onlineAudiobook) {
    await runtime.contentAudiobooks.ensureBookDetails(context.libraryId, context.ownerUserId, item.id);
    item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (!absBookMatchesLibrary(context, item))
      throw new ApiError(404, "abs_book_not_found", "此分类中不存在该有声书");
  }
  const [children, files] = await Promise.all([
    runtime.repository.listCatalogChildren(item.id, context.ownerUserId),
    onlineAudiobook
      ? runtime.contentAudiobooks.filesForBook(context.libraryId, context.ownerUserId, item.id)
      : runtime.repository.listItemFiles(item.id, context.ownerUserId),
  ]);
  const chapters = children
    .filter((child) => child.itemType === "audiobook.chapter")
    .sort((left, right) => {
      return (
        Number(left.metadata.discNumber ?? 1) - Number(right.metadata.discNumber ?? 1) ||
        Number(left.metadata.chapterNumber ?? 0) - Number(right.metadata.chapterNumber ?? 0) ||
        left.sortTitle.localeCompare(right.sortTitle, "zh-CN", { numeric: true }) ||
        left.id.localeCompare(right.id)
      );
    });
  const tracks: AbsTrack[] = [];
  const timeline: AbsBook["chapters"] = [];
  // 关键变量：一书数千章时一次建立查找表；同章多来源仍保留原有第一个文件的优先顺序。
  const filesByChapter = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const chapterId = String(file.itemId);
    if (!filesByChapter.has(chapterId)) filesByChapter.set(chapterId, file);
  }
  let offset = 0;
  for (const child of chapters) {
    const file = filesByChapter.get(child.id);
    if (!file) {
      if (onlineAudiobook) throw new ApiError(409, "abs_audio_details_incomplete", "有声书章节身份尚未读取完整，请重新打开详情");
      continue;
    }
    const metadata = child.metadata;
    const probe = readAbsObject(file.mediaProbeResult);
    const duration =
      readAbsSeconds(Number(metadata.durationMs ?? 0) / 1000) || readAbsSeconds(probe.durationSeconds);
    if (onlineAudiobook && duration <= 0)
      throw new ApiError(409, "abs_duration_missing", "有声书章节缺少真实时长，暂不能建立全书播放时间轴");
    const name = String(file.name ?? metadata.fileName ?? child.title);
    const suffix = name.split(".").pop()?.toLowerCase() ?? "";
    const index = tracks.length + 1;
    const mimeType = onlineAudiobook && typeof metadata.mimeType === "string" && /^audio\//iu.test(metadata.mimeType)
      ? metadata.mimeType : absAudioMime(suffix);
    // contentUrl 按官方返回相对 ABS 根路径，由客户端自身保留配置的 base path。
    tracks.push({
      index,
      ino: String(file.fileId),
      chapterId: child.id,
      title: child.title,
      startOffset: offset,
      duration,
      mimeType,
      codec: String(metadata.codec ?? ""),
      contentUrl: `/api/items/${item.id}/file/${String(file.fileId)}`,
      metadata: {
        filename: name,
        ext: suffix ? `.${suffix}` : "",
        path: `/books/${item.id}/${name}`,
        relPath: name,
        size: Number(file.size ?? 0),
        mtimeMs: file.modifiedAt ? Date.parse(String(file.modifiedAt)) : 0,
      },
      file: onlineAudiobook ? { ...file, contentSourceAudiobook: true, bookItemId: item.id } : file,
    });
    const embedded = readAbsArray(metadata.chapters)
      .map(readAbsObject)
      .filter(
        (chapter) =>
          Number.isFinite(Number(chapter.start)) &&
          Number(chapter.start) >= 0 &&
          Number(chapter.end) > Number(chapter.start),
      );
    if (embedded.length > 0)
      for (const chapter of embedded)
        timeline.push({
          id: timeline.length,
          start: offset + Number(chapter.start),
          end: offset + Math.min(duration || Number(chapter.end), Number(chapter.end)),
          title: String(chapter.title || child.title),
        });
    else timeline.push({ id: timeline.length, start: offset, end: offset + duration, title: child.title });
    offset += duration;
  }
  const entities = absBookEntities(
    context,
    item.metadata,
    chapters.flatMap((child) => absNames(child.metadata.authors)),
    chapters.flatMap((child) => absNames(child.metadata.narrators)),
  );
  if (onlineAudiobook && tracks.length === 0)
    throw new ApiError(409, "abs_audio_details_incomplete", "有声书当前没有可播放的免费章节");
  return {
    item,
    bookId: absEntityId(context.libraryId, "book", item.id),
    tracks,
    chapters: timeline,
    duration: offset,
    ...entities,
  };
}

/** 映射整书对象，返回官方 expanded 结构的超集且不暴露网盘真实路径。 */
export function mapAbsBook(
  context: AbsContext,
  book: AbsBook | AbsBookSummary,
  expanded = true,
): Record<string, unknown> {
  // 摘要不伪造音轨：请求完整数据必须显式加载该作品详情。
  const detail = "tracks" in book ? book : null;
  if (expanded && !detail)
    throw new ApiError(500, "abs_book_detail_required", "完整有声书响应需要加载作品详情");
  const audioFileCount = detail ? detail.tracks.length : (book as AbsBookSummary).audioFileCount;
  const chapterCount = detail ? detail.chapters.length : (book as AbsBookSummary).chapterCount;
  const size = detail
    ? detail.tracks.reduce((sum, track) => sum + Number(track.file.size ?? 0), 0)
    : (book as AbsBookSummary).size;
  const item = book.item;
  const metadata = item.metadata;
  // 关键变量：协议库身份来自作品固定主分类，不能随请求路径或详情加载而临时改变。
  const libraryId = absBookLibraryId(context, item);
  const base = {
    id: item.id,
    ino: item.id,
    libraryId,
    folderId: absEntityId(context.libraryId, "folder", libraryId),
    path: `/books/${item.id}`,
    relPath: item.title,
    isFile: false,
    addedAt: Date.parse(item.createdAt),
    updatedAt: Date.parse(item.updatedAt),
    mtimeMs: Date.parse(item.updatedAt),
    ctimeMs: Date.parse(item.createdAt),
    birthtimeMs: Date.parse(item.createdAt),
    lastScan: Date.parse(item.updatedAt),
    scanVersion: "2.37.1",
    // 在线书目摘要未取详情时，未知章节数不等于原文件丢失。
    isMissing: audioFileCount === 0 && !(String(item.libraryKind) === "content_source_audiobook" && !(book as AbsBookSummary).detailsLoaded),
    isInvalid: false,
    mediaType: "book",
    oldLibraryItemId: null,
    media: {
      id: book.bookId,
      libraryItemId: item.id,
      metadata: {
        title: item.title,
        titleIgnorePrefix: item.title,
        subtitle: String(metadata.subtitle ?? ""),
        authors: book.authors,
        authorName: book.authors.map((author) => author.name).join(", "),
        authorNameLF: book.authors.map((author) => author.name).join(", "),
        narrators: book.narrators,
        narratorName: book.narrators.join(", "),
        series: book.series,
        seriesName: book.series
          .map((entry) => `${entry.name}${entry.sequence ? ` #${entry.sequence}` : ""}`)
          .join(", "),
        genres: absBookGenres(context, item),
        publishedYear: item.year ? String(item.year) : null,
        publishedDate: item.premiereDate,
        publisher: String(metadata.publisher ?? ""),
        description: item.overview || String(metadata.description ?? ""),
        isbn: item.externalIds.isbn ?? null,
        asin: item.externalIds.asin ?? null,
        language: String(metadata.language ?? ""),
        explicit: Boolean(metadata.explicit),
        abridged: Boolean(metadata.abridged),
      },
      coverPath: item.posterUrl ? `${context.basePath}/api/items/${item.id}/cover` : null,
      tags: absNames(metadata.tags),
      numTracks: audioFileCount,
      numAudioFiles: audioFileCount,
      numChapters: chapterCount,
      duration: book.duration,
      size,
      ebookFormat: null,
      ...(expanded
        ? {
            audioFiles: detail!.tracks.map((track) => mapAudioFile(track)),
            chapters: detail!.chapters,
            ebookFile: null,
            tracks: detail!.tracks.map((track) => mapAbsTrack(track)),
          }
        : {}),
    },
    ...(expanded
      ? {
          libraryFiles: detail!.tracks.map((track) => ({
            ino: track.ino,
            metadata: track.metadata,
            isSupplementary: false,
            fileType: "audio",
          })),
        }
      : {}),
  };
  return base;
}

/** 物理音轨保持官方 index/startOffset/duration，禁止把局部位置伪装成全书位置。 */
export function mapAbsTrack(track: AbsTrack): Record<string, unknown> {
  return {
    ...mapAudioFile(track),
    startOffset: track.startOffset,
    title: track.title,
    contentUrl: track.contentUrl,
  };
}

/** 对外音频文件对象仅保留虚拟文件路径和真实格式、时长。 */
function mapAudioFile(track: AbsTrack): Record<string, unknown> {
  return {
    index: track.index,
    ino: track.ino,
    metadata: track.metadata,
    duration: track.duration,
    codec: track.codec || null,
    mimeType: track.mimeType,
    exclude: false,
    embeddedCoverArt: null,
    trackNumFromMeta: track.index,
    discNumFromMeta: 1,
    manuallyVerified: false,
    invalid: false,
    error: null,
  };
}

/** 按真实书目摘要筛选、排序、折叠并分页，只加载返回页的完整章节与文件。 */
export async function listAbsBooks(
  runtime: ApiRuntime,
  context: AbsContext,
  query: Record<string, unknown> = {},
): Promise<Omit<AbsBookSummaryPage, "books"> & { books: AbsBook[] }> {
  const result = await listAbsBookSummaries(runtime, context, query);
  const books = await Promise.all(result.books.map((book) => loadAbsBook(runtime, context, book.item.id)));
  return { ...result, books };
}

/** 摘要目录保留完整总数与折叠系列信息，供列表、搜索、筛选器和个性书架复用。 */
interface AbsBookSummaryPage {
  books: AbsBookSummary[];
  total: number;
  limit: number;
  page: number;
  collapseseries: boolean;
  collapsed: Map<string, Record<string, unknown>>;
}

/** 全库只装配摘要，真实筛选和系列归组完成后再分页，不以截断目录代替总数。 */
export async function listAbsBookSummaries(
  runtime: ApiRuntime,
  context: AbsContext,
  query: Record<string, unknown> = {},
): Promise<AbsBookSummaryPage> {
  context = await withAbsLibraryViews(runtime, context);
  const [books, progressRows] = await Promise.all([
    loadAbsBookSummaries(runtime, context),
    runtime.database
      .query("library_abs_progress")
      .where({ library_id: context.libraryId, account_id: context.accountId }),
  ]);
  // 同一请求只读取一次进度，筛选和排序使用同一批状态。
  const progress = new Map<string, Record<string, unknown>>(
    progressRows.map((row) => [String(row.item_id), row]),
  );
  let filtered = books;
  const search = typeof query.q === "string" ? query.q.trim().toLocaleLowerCase("zh-CN") : "";
  if (search)
    filtered = filtered.filter((book) =>
      [
        book.item.title,
        book.item.overview,
        ...book.authors.map((author) => author.name),
        ...book.narrators,
        ...book.series.map((series) => series.name),
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(search),
    );
  if (query.filter) filtered = filterBooks(filtered, String(query.filter), progress);
  const sort = String(query.sort ?? "media.metadata.title");
  const desc = query.desc === "1" || query.desc === true;
  filtered.sort((left, right) => {
    let order = 0;
    if (sort === "progress")
      order =
        Number(progress.get(left.item.id)?.current_time ?? 0) / (left.duration || 1) -
        Number(progress.get(right.item.id)?.current_time ?? 0) / (right.duration || 1);
    else if (sort === "progress.createdAt")
      order =
        Number(progress.get(left.item.id)?.started_at ?? 0) -
        Number(progress.get(right.item.id)?.started_at ?? 0);
    else if (sort === "progress.finishedAt")
      order =
        Number(progress.get(left.item.id)?.finished_at ?? 0) -
        Number(progress.get(right.item.id)?.finished_at ?? 0);
    else if (/addedAt|createdAt/u.test(sort))
      order = Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt);
    else if (/updatedAt|lastUpdate/u.test(sort))
      order =
        Number(progress.get(left.item.id)?.updated_at ?? Date.parse(left.item.updatedAt)) -
        Number(progress.get(right.item.id)?.updated_at ?? Date.parse(right.item.updatedAt));
    else if (/duration/u.test(sort)) order = left.duration - right.duration;
    else if (/author/u.test(sort))
      order = left.authors
        .map((entry) => entry.name)
        .join(",")
        .localeCompare(right.authors.map((entry) => entry.name).join(","), "zh-CN", { numeric: true });
    else if (/publishedYear/u.test(sort)) order = (left.item.year ?? 0) - (right.item.year ?? 0);
    else if (/series.*sequence/u.test(sort))
      order = Number(left.series[0]?.sequence ?? 0) - Number(right.series[0]?.sequence ?? 0);
    else order = left.item.title.localeCompare(right.item.title, "zh-CN", { numeric: true });
    return (desc ? -order : order) || left.item.id.localeCompare(right.item.id);
  });
  const collapseseries =
    [true, "1", "true"].includes(query.collapseseries as string | boolean) &&
    !String(query.filter ?? "").startsWith("series.");
  const collapsed = new Map<string, Record<string, unknown>>();
  if (collapseseries) {
    const grouped = new Map<string, AbsBookSummary[]>();
    for (const book of filtered) {
      const series = book.series[0];
      if (series) grouped.set(series.id, [...(grouped.get(series.id) ?? []), book]);
    }
    const consumed = new Set<string>();
    const displayed: AbsBookSummary[] = [];
    for (const book of filtered) {
      const series = book.series[0];
      if (!series) {
        displayed.push(book);
        continue;
      }
      if (consumed.has(series.id)) continue;
      consumed.add(series.id);
      const members = grouped
        .get(series.id)!
        .sort(
          (left, right) => Number(left.series[0]?.sequence ?? 0) - Number(right.series[0]?.sequence ?? 0),
        );
      const representative = members[0]!;
      collapsed.set(representative.item.id, {
        id: series.id,
        name: series.name,
        nameIgnorePrefix: series.name,
        sequence: representative.series[0]?.sequence ?? null,
        numBooks: members.length,
        libraryItemIds: members.map((entry) => entry.item.id),
      });
      displayed.push(representative);
    }
    filtered = displayed;
    if (/title/iu.test(sort))
      filtered.sort((left, right) => {
        const leftTitle = String(collapsed.get(left.item.id)?.name ?? left.item.title);
        const rightTitle = String(collapsed.get(right.item.id)?.name ?? right.item.title);
        return (
          (desc ? -1 : 1) * leftTitle.localeCompare(rightTitle, "zh-CN", { numeric: true }) ||
          left.item.id.localeCompare(right.item.id)
        );
      });
  }
  const total = filtered.length;
  const page = readPage(query.page, 0);
  const limit = query.limit === undefined ? 0 : readPage(query.limit, 0);
  return {
    books: limit === 0 ? filtered : filtered.slice(page * limit, page * limit + limit),
    total,
    limit,
    page,
    collapseseries,
    collapsed,
  };
}

/** 按官方分类和值过滤；未知过滤器明确拒绝而非忽略条件返回全库。 */
function filterBooks(
  books: AbsBookSummary[],
  filter: string,
  states: Map<string, Record<string, unknown>>,
): AbsBookSummary[] {
  const separator = filter.indexOf(".");
  const kind = separator < 0 ? filter : filter.slice(0, separator);
  let value = separator < 0 ? "" : filter.slice(separator + 1);
  if (value) {
    try {
      value = Buffer.from(decodeURIComponent(value), "base64").toString("utf8");
    } catch {
      throw new ApiError(400, "abs_filter_invalid", "ABS 筛选参数无效");
    }
  }
  if (
    [
      "authors",
      "series",
      "narrators",
      "genres",
      "tags",
      "languages",
      "publishers",
      "publishedDecades",
      "explicit",
      "abridged",
    ].includes(kind)
  )
    return books.filter((book) => {
      if (kind === "authors") return book.authors.some((entry) => entry.id === value || entry.name === value);
      if (kind === "series")
        return value === "no-series"
          ? book.series.length === 0
          : book.series.some((entry) => entry.id === value || entry.name === value);
      if (kind === "narrators") return book.narrators.includes(value);
      if (kind === "publishers") return String(book.item.metadata.publisher ?? "") === value;
      if (kind === "publishedDecades")
        return book.item.year !== null && Math.floor(book.item.year / 10) * 10 === Number(value);
      if (kind === "explicit" || kind === "abridged") return Boolean(book.item.metadata[kind]);
      return absNames(book.item.metadata[kind === "languages" ? "language" : kind]).includes(value);
    });
  if (["progress", "issues", "missing", "ebooks", "tracks"].includes(kind)) {
    return books.filter((book) => {
      const state = states.get(book.item.id);
      if (kind === "missing") {
        if (value === "authors") return !book.authors.length;
        if (value === "series") return !book.series.length;
        if (value === "cover") return !book.item.posterUrl;
        if (value === "description") return !book.item.overview;
        if (value === "publishedYear") return !book.item.year;
        if (value === "asin" || value === "isbn") return !book.item.externalIds[value];
        if (value === "chapters") return book.detailsLoaded !== false && book.chapterCount === 0;
        if (value === "narrators") return !book.narrators.length;
        if (["genres", "tags", "subtitle", "publisher", "language"].includes(value))
          return !absNames(book.item.metadata[value]).length;
        throw new ApiError(400, "abs_filter_invalid", "不支持该缺失资料筛选");
      }
      if (kind === "issues") return (book.detailsLoaded !== false && book.audioFileCount === 0) || book.hasInvalidDuration;
      if (kind === "ebooks") return value === "no-ebook" || value === "no-supplementary";
      if (kind === "tracks")
        return book.detailsLoaded === false ? false : value === "none"
          ? book.audioFileCount === 0
          : value === "multi"
            ? book.audioFileCount > 1
            : book.audioFileCount === 1;
      if (value === "finished") return Number(state?.is_finished ?? 0) === 1;
      if (value === "not-finished") return Number(state?.is_finished ?? 0) !== 1;
      if (value === "in-progress" || value === "audio-in-progress")
        return Number(state?.current_time ?? 0) > 0 && Number(state?.is_finished ?? 0) !== 1;
      if (value === "ebook-in-progress" || value === "ebook-finished") return false;
      if (value === "not-started")
        return !state || (Number(state.current_time) === 0 && Number(state.is_finished) !== 1);
      throw new ApiError(400, "abs_filter_invalid", "不支持该进度筛选");
    });
  }
  throw new ApiError(400, "abs_filter_unsupported", "暂不支持该 ABS 筛选条件");
}

/** 分页只接受非负安全整数，limit=0 表示标准不分页。 */
function readPage(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

/** 有声书格式 MIME 与 ABS 官方一致，未识别格式不伪报 MP3。 */
export function absAudioMime(extension: string): string {
  return (
    (
      {
        mp3: "audio/mpeg",
        m4b: "audio/mp4",
        m4a: "audio/mp4",
        mp4: "audio/mp4",
        flac: "audio/flac",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        aac: "audio/aac",
        wav: "audio/wav",
        wma: "audio/x-ms-wma",
        aiff: "audio/x-aiff",
        aif: "audio/x-aiff",
        mka: "audio/x-matroska",
        ape: "audio/ape",
        alac: "audio/mp4",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
