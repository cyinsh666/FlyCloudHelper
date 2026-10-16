import type { ApiRuntime } from "../runtime.js";
import { absEntityId, absNames, listAbsBookSummaries, mapAbsBook } from "./catalog.js";
import type { AbsAccessService } from "./access.js";
import type { AbsProgressService } from "./progress.js";
import { absBookGenres, absDefaultLibraryId, absLibraryView, withAbsLibraryViews } from "./library-views.js";
import { readAbsObject, type AbsBook, type AbsContext, type AbsLibraryRow } from "./types.js";
import type { AbsBookSummary } from "./catalog-summary.js";

/** 真实对外能力对应官方字段，不声明不存在的 transcode:false 协商。 */
export function absServerSettings(): Record<string, unknown> {
  return {
    version: "2.37.1",
    serverVersion: "2.37.1",
    language: "zh-cn",
    timeZone: "UTC",
    authActiveAuthMethods: ["local"],
    authLoginCustomMessage: "Fly 云助手 ABS 有声书服务",
    authOpenIDAutoLaunch: false,
    logLevel: 2,
    bookshelves: [],
    sortingIgnorePrefix: false,
    sortingPrefixes: [],
    chromecastEnabled: false,
    disableWatcher: true,
    coverAspectRatio: 0,
    bookshelfView: 0,
    bookshelfSortBy: "media.metadata.title",
    bookshelfSortDesc: false,
    podcastEpisodeSchedule: "",
    scannerFindCovers: false,
    scannerParseSubtitle: false,
    scannerPreferAudioMetadata: true,
    storeCoverWithItem: false,
    storeMetadataWithItem: false,
    loginRateLimitMaxRequests: 20,
    loginRateLimitWindowMs: 60000,
  };
}

/** 构造完整用户对象，Socket user_updated 与 HTTP 使用同一结构。 */
export async function buildAbsUser(
  runtime: ApiRuntime,
  context: AbsContext,
  access: AbsAccessService,
  progress: AbsProgressService,
): Promise<Record<string, unknown>> {
  context = await withAbsLibraryViews(runtime, context);
  // 用户对象覆盖此服务下全部可访问分类；选中分类只影响库目录，不裁剪账号自身状态。
  const userContext = { ...context, viewLibraryId: undefined };
  const [account, mediaProgress, bookmarks, settings] = await Promise.all([
    access.getAccount(context.libraryId, context.accountId),
    progress.list(userContext),
    progress.bookmarks(userContext),
    runtime.database.query("library_abs_preferences").where({ account_id: context.accountId }).first(),
  ]);
  const publicSettings = { ...readAbsObject(settings?.settings_json) };
  return {
    id: context.accountId,
    username: context.username,
    email: "",
    type: "user",
    token: access.legacyToken(context),
    isOldToken: false,
    isActive: true,
    isLocked: false,
    createdAt: Date.parse(account.createdAt),
    lastSeen: Date.now(),
    mediaProgress,
    bookmarks,
    seriesHideFromContinueListening: [],
    permissions: {
      download: context.canDownload,
      upload: false,
      delete: false,
      update: false,
      accessAllLibraries: false,
      accessAllTags: true,
      accessExplicitContent: true,
      createEreader: false,
      selectedTagsNotAccessible: false,
    },
    librariesAccessible: context.libraryViews?.map((view) => view.id) ?? [context.libraryId],
    itemTagsSelected: [],
    hasOpenIDLink: false,
    ...(settings ? { settings: publicSettings } : {}),
  };
}

/** 登录和 authorize 返回官方共同信封，账号永不获得后台管理权限。 */
export async function buildAbsLoginPayload(
  runtime: ApiRuntime,
  context: AbsContext,
  access: AbsAccessService,
  progress: AbsProgressService,
): Promise<Record<string, unknown>> {
  context = await withAbsLibraryViews(runtime, context);
  return {
    user: await buildAbsUser(runtime, context, access, progress),
    userDefaultLibraryId: absDefaultLibraryId(context),
    serverSettings: absServerSettings(),
    ereaderDevices: [],
    Source: "FlyCloudHelper",
  };
}

/** 分类映射为标准 ABS 媒体库，底层仍共用原库、账号和单个虚拟根文件夹。 */
export function mapAbsLibrary(context: AbsContext, library: AbsLibraryRow): Record<string, unknown> {
  const view = absLibraryView(context);
  return {
    id: view.id,
    name: view.name,
    folders: [
      {
        id: absEntityId(context.libraryId, "folder", view.id),
        fullPath: "/books",
        libraryId: view.id,
        addedAt: Date.parse(library.created_at),
      },
    ],
    displayOrder: view.displayOrder,
    icon: "audiobooks",
    mediaType: "book",
    provider: "audible",
    settings: {
      coverAspectRatio: 0,
      disableWatcher: true,
      autoScanCronExpression: null,
      audiobooksOnly: true,
      hideSingleBookSeries: false,
      onlyShowLaterBooksInContinueSeries: false,
      metadataPrecedence: ["audioMetatags", "folderStructure"],
      markAsFinishedPercentComplete: null,
      markAsFinishedTimeRemaining: 10,
    },
    lastScan: library.last_scan_at ? Date.parse(library.last_scan_at) : null,
    lastScanVersion: "2.37.1",
    createdAt: Date.parse(library.created_at),
    lastUpdate: Date.parse(library.updated_at),
  };
}

/** 根据作品真实数据生成作者、演播者、系列与筛选项。 */
export function absFacets(
  context: AbsContext,
  books: Array<Pick<AbsBook, "item" | "authors" | "narrators" | "series">>,
): {
  authors: Record<string, unknown>[];
  narrators: Record<string, unknown>[];
  series: Record<string, unknown>[];
  genres: string[];
  tags: string[];
  languages: string[];
} {
  const authors = new Map<string, { id: string; name: string; numBooks: number }>();
  const narrators = new Map<string, { id: string; name: string; numBooks: number }>();
  const series = new Map<string, { id: string; name: string; numBooks: number }>();
  for (const book of books) {
    for (const author of book.authors)
      authors.set(author.id, { ...author, numBooks: (authors.get(author.id)?.numBooks ?? 0) + 1 });
    for (const name of book.narrators) {
      const id = absEntityId(context.libraryId, "narrator", name);
      narrators.set(id, { id, name, numBooks: (narrators.get(id)?.numBooks ?? 0) + 1 });
    }
    for (const entry of book.series)
      series.set(entry.id, {
        id: entry.id,
        name: entry.name,
        numBooks: (series.get(entry.id)?.numBooks ?? 0) + 1,
      });
  }
  /** 使用中文自然名称排序，避免数字与中文书名在不同端顺序漂移。 */
  const compare = (left: { name: string }, right: { name: string }): number =>
    left.name.localeCompare(right.name, "zh-CN", { numeric: true });
  return {
    authors: [...authors.values()]
      .sort(compare)
      .map((row) => ({ ...row, asin: null, description: null, imagePath: null, addedAt: 0, updatedAt: 0 })),
    narrators: [...narrators.values()].sort(compare),
    series: [...series.values()].sort(compare),
    genres: [...new Set(books.flatMap((book) => absBookGenres(context, book.item)))],
    tags: [...new Set(books.flatMap((book) => absNames(book.item.metadata.tags)))],
    languages: [...new Set(books.flatMap((book) => absNames(book.item.metadata.language)))],
  };
}

/** filterdata 的演播者是字符串数组，不能复用 narrators 端点的实体对象数组。 */
export function absFilterData(context: AbsContext, books: AbsBookSummary[]): Record<string, unknown> {
  const facets = absFacets(context, books);
  return {
    authors: facets.authors.map((author) => ({ id: author.id, name: author.name })),
    series: facets.series.map((series) => ({ id: series.id, name: series.name })),
    narrators: facets.narrators.map((narrator) => String(narrator.name)),
    genres: facets.genres,
    tags: facets.tags,
    languages: facets.languages,
    publishers: [...new Set(books.map((book) => String(book.item.metadata.publisher ?? "")).filter(Boolean))],
    publishedDecades: [
      ...new Set(
        books.flatMap((book) => (book.item.year ? [String(Math.floor(book.item.year / 10) * 10)] : [])),
      ),
    ],
    bookCount: books.length,
    authorCount: facets.authors.length,
    seriesCount: facets.series.length,
    podcastCount: 0,
    numIssues: books.filter((book) => !book.audioFileCount || book.hasInvalidDuration).length,
    loadedAt: Date.now(),
  };
}

/** 个性书架按真实进度构造，继续收听不会从名字或下载请求推测。 */
export async function absPersonalized(
  runtime: ApiRuntime,
  context: AbsContext,
  progress: AbsProgressService,
): Promise<Record<string, unknown>[]> {
  const { books } = await listAbsBookSummaries(runtime, context, { limit: 0 });
  const states = await progress.list(context);
  const byId = new Map(books.map((book) => [book.item.id, book]));
  const inProgress = states
    .filter((state) => !state.isFinished && !state.hideFromContinueListening && Number(state.currentTime) > 0)
    .sort((left, right) => Number(right.lastUpdate) - Number(left.lastUpdate))
    .flatMap((state) => {
      const book = byId.get(String(state.libraryItemId));
      return book
        ? [
            {
              ...mapAbsBook(context, book, false),
              userMediaProgress: state,
              progressLastUpdate: state.lastUpdate,
            },
          ]
        : [];
    });
  const shelves: Record<string, unknown>[] = [];
  if (inProgress.length)
    shelves.push({
      id: "continue-listening",
      label: "Continue Listening",
      labelStringKey: "LabelContinueListening",
      type: "book",
      entities: inProgress.slice(0, 20),
      total: inProgress.length,
    });
  if (books.length)
    shelves.push({
      id: "recently-added",
      label: "Recently Added",
      labelStringKey: "LabelRecentlyAdded",
      type: "book",
      entities: [...books]
        .sort((left, right) => Date.parse(right.item.createdAt) - Date.parse(left.item.createdAt))
        .slice(0, 20)
        .map((book) => mapAbsBook(context, book, false)),
      total: books.length,
    });
  const finished = states
    .filter((state) => state.isFinished)
    .sort((left, right) => Number(right.lastUpdate) - Number(left.lastUpdate))
    .flatMap((state) => {
      const book = byId.get(String(state.libraryItemId));
      return book ? [mapAbsBook(context, book, false)] : [];
    });
  if (finished.length)
    shelves.push({
      id: "listen-again",
      label: "Listen Again",
      labelStringKey: "LabelListenAgain",
      type: "book",
      entities: finished.slice(0, 20),
      total: finished.length,
    });
  return shelves;
}

/** 所有实体列表都先筛选再分页，limit=0 真实返回完整集合。 */
export function absPage<T>(
  values: T[],
  query: Record<string, unknown>,
): { results: T[]; total: number; limit: number; page: number; numPages: number } {
  const limit = Math.max(0, Number(query.limit) || 0);
  const page = Math.max(0, Number(query.page) || 0);
  return {
    results: limit ? values.slice(page * limit, (page + 1) * limit) : values,
    total: values.length,
    limit,
    page,
    numPages: limit ? Math.ceil(values.length / limit) : 1,
  };
}
