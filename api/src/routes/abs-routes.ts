import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { AbsAccessService } from "../abs/access.js";
import { AbsSocketHub } from "../abs/socket.js";
import { AbsProgressService } from "../abs/progress.js";
import { AbsSessionService } from "../abs/sessions.js";
import { AbsCollectionService, type AbsListKind } from "../abs/collections.js";
import { absEntityId, listAbsBookSummaries, loadAbsBook, mapAbsBook } from "../abs/catalog.js";
import {
  absFacets,
  absFilterData,
  absPage,
  absPersonalized,
  absServerSettings,
  buildAbsLoginPayload,
  buildAbsUser,
  mapAbsLibrary,
} from "../abs/presentation.js";
import { sendAbsCover, streamAbsItemFile, streamAbsTrack } from "../abs/stream.js";
import { readAbsArray, readAbsObject, type AbsContext } from "../abs/types.js";
import { absLibraryContext, withAbsLibraryViews } from "../abs/library-views.js";

/** 注册独立 ABS v2.37.1 兼容入口，不接管云助手根路由或复制 ABS Web 后台。 */
export async function registerAbsRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const access = runtime.absAccess;
  const hub = new AbsSocketHub(server, runtime, access);
  const progress = new AbsProgressService(runtime, hub, access);
  const sessions = new AbsSessionService(runtime, progress, hub);
  const collections = new AbsCollectionService(runtime, hub);
  const loginAttempts = new Map<string, { startedAt: number; count: number }>();
  server.route<{
    Params: { pathSuffix: string; "*": string };
    Querystring: Record<string, unknown>;
    Body: Record<string, unknown>;
  }>({
    method: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    url: "/abs/:pathSuffix/*",
    logLevel: "silent",
    handler: async (request, reply) => {
      try {
        const state = await runtime.database.getSystemState();
        if (state.setupRequired || state.credentialKeyBackupRequired)
          throw new ApiError(503, "abs_setup_incomplete", "请先完成云助手初始化和密钥备份");
        const library = await access.getLibrary(request.params.pathSuffix);
        const route = (request.params["*"] ?? "").replace(/^\/+|\/+$/gu, "");
        const parts = route.split("/");
        const method = request.method === "HEAD" ? "GET" : request.method;
        const query = request.query ?? {};
        const body = Array.isArray(request.body) ? { progress: request.body } : readAbsObject(request.body);
        if (method === "OPTIONS")
          return reply.header("Allow", "GET,HEAD,POST,PATCH,DELETE,OPTIONS").code(204).send();
        if (route === "status" && ["GET", "HEAD"].includes(method))
          return {
            app: "audiobookshelf",
            serverVersion: "2.37.1",
            isInit: true,
            language: "zh-cn",
            authMethods: ["local"],
            authFormData: { authLoginCustomMessage: "Fly 云助手 ABS 有声书服务" },
          };
        if (["ping", "healthcheck"].includes(route) && ["GET", "HEAD"].includes(method))
          return route === "ping" ? { success: true } : reply.code(200).send();
        if (route === "login" && method === "POST") {
          const key = `${library.id}:${request.ip}`;
          const now = Date.now();
          let window = loginAttempts.get(key);
          if (!window || window.startedAt + 60000 < now) {
            window = { startedAt: now, count: 0 };
            loginAttempts.set(key, window);
          }
          if (++window.count > 20)
            throw new ApiError(429, "abs_login_rate_limit", "登录请求过于频繁，请稍后重试");
          if (loginAttempts.size > 10000)
            for (const [oldKey, value] of loginAttempts)
              if (value.startedAt + 60000 < now) loginAttempts.delete(oldKey);
          const result = await access.login(library, body.username, body.password);
          const payload = await buildAbsLoginPayload(runtime, result.context, access, progress);
          const user = readAbsObject(payload.user);
          const returnTokens = request.headers["x-return-tokens"] === "true";
          user.accessToken = result.accessToken;
          user.refreshToken = returnTokens ? result.refreshToken : null;
          if (!returnTokens) setRefreshCookie(reply, request, result.context.basePath, result.refreshToken);
          return { ...payload, user };
        }
        if (route === "auth/refresh" && method === "POST") {
          const token = refreshFromRequest(request);
          const result = await access.refresh(library, token);
          const payload = await buildAbsLoginPayload(runtime, result.context, access, progress);
          const user = readAbsObject(payload.user);
          user.accessToken = result.accessToken;
          user.refreshToken = request.headers["x-refresh-token"] ? result.refreshToken : null;
          if (!request.headers["x-refresh-token"])
            setRefreshCookie(reply, request, result.context.basePath, result.refreshToken);
          return { ...payload, user };
        }
        if (route === "logout" && method === "POST") {
          await access.logout(library, refreshFromRequest(request));
          return reply
            .clearCookie("refresh_token", { path: `/abs/${encodeURIComponent(library.abs_path_suffix)}` })
            .code(200)
            .send();
        }
        // 官方播放器的公开音轨通过不可猜测 session ID 获取，只能访问该 session 所属的真实库和账号。
        if (
          parts[0] === "public" &&
          parts[1] === "session" &&
          parts[3] === "track" &&
          parts.length === 5 &&
          ["GET", "HEAD"].includes(method)
        ) {
          const session = await runtime.database
            .query("library_abs_playback_sessions")
            .where({ id: parts[2], library_id: library.id, status: "active" })
            .where("updated_at", ">", Date.now() - 36 * 3600000)
            .first();
          if (!session) throw new ApiError(404, "abs_session_not_found", "播放会话不存在或已结束");
          const account = await access.getAccount(library.id, String(session.account_id));
          if (account.status !== "active") throw new ApiError(401, "abs_account_disabled", "协议账号已停用");
          const context = access.context(library, account);
          const track = await sessions.track(context, String(session.id), Number(parts[4]));
          return streamAbsTrack(runtime, context, track, request, reply);
        }
        // 关键变量：鉴权范围仍是真实库；分类视图只影响 ABS 的目录和展示，不替换账号及进度外键。
        let context = await withAbsLibraryViews(runtime, await access.authenticate(library, bearerFromRequest(request, query)));
        if (route === "api/authorize" && method === "POST")
          return buildAbsLoginPayload(runtime, context, access, progress);
        if (route === "api/me" && method === "GET") return buildAbsUser(runtime, context, access, progress);
        if (route === "api/libraries" && method === "GET") {
          const libraries = [];
          for (const view of context.libraryViews ?? []) {
            const viewContext = absLibraryContext(context, view.id);
            const mapped = mapAbsLibrary(viewContext, library);
            if (String(query.include ?? "").split(",").includes("stats"))
              mapped.stats = await libraryStats(runtime, viewContext);
            libraries.push(mapped);
          }
          return { libraries };
        }
        if (parts[0] === "api" && parts[1] === "libraries" && parts[2]) {
          context = absLibraryContext(context, parts[2]);
          if (method !== "GET")
            throw new ApiError(403, "abs_management_forbidden", "请通过云助手管理页面修改媒体库");
          const action = parts[3];
          if (!action) {
            const mapped = mapAbsLibrary(context, library);
            if (
              String(query.include ?? "")
                .split(",")
                .includes("filterdata")
            ) {
              const { books } = await listAbsBookSummaries(runtime, context, { limit: 0 });
              const playlistCount = await collections.count(context, "playlists");
              return {
                filterdata: absFilterData(context, books),
                issues: books.filter((book) => book.detailsLoaded !== false && !book.audioFileCount).length,
                numUserPlaylists: playlistCount,
                library: mapped,
              };
            }
            return mapped;
          }
          if (action === "items") {
            const result = await listAbsBookSummaries(runtime, context, query);
            return {
              results: result.books.map((book) => ({
                ...mapAbsBook(context, book, false),
                ...(result.collapsed.get(book.item.id)
                  ? { collapsedSeries: result.collapsed.get(book.item.id) }
                  : {}),
              })),
              total: result.total,
              limit: result.limit,
              page: result.page,
              sortBy: query.sort ?? "media.metadata.title",
              sortDesc: query.desc === "1",
              filterBy: query.filter ?? null,
              mediaType: "book",
              minified: query.minified === "1",
              collapseseries: result.collapseseries,
              include: String(query.include ?? ""),
            };
          }
          if (action === "personalized") return absPersonalized(runtime, context, progress);
          if (action === "stats") return libraryStats(runtime, context);
          if (action === "collections" || action === "playlists")
            return absPage(await collections.list(context, action), query);
          if (["authors", "narrators", "series", "search", "filterdata"].includes(action ?? ""))
            return libraryEntities(runtime, context, action!, parts[4], query);
        }
        if (parts[0] === "api" && parts[1] === "authors" && parts[2] && method === "GET") {
          const { books } = await listAbsBookSummaries(runtime, context, { limit: 0 });
          const author = absFacets(context, books).authors.find((entry) => entry.id === parts[2]);
          if (!author) throw new ApiError(404, "abs_author_not_found", "作者不存在");
          if (parts[3] === "image") throw new ApiError(404, "abs_author_image_not_found", "作者暂无图片");
          return {
            ...author,
            libraryItems: books
              .filter((book) => book.authors.some((entry) => entry.id === parts[2]))
              .map((book) => mapAbsBook(context, book, false)),
          };
        }
        if (parts[0] === "api" && parts[1] === "series" && parts[2] && parts.length === 3 && method === "GET")
          return libraryEntities(runtime, context, "series", parts[2], query);
        if (parts[0] === "api" && parts[1] === "items" && parts[2]) {
          if (parts[2] === "batch" && parts[3] === "get" && method === "POST") {
            const ids = readAbsArray(body.libraryItemIds ?? body.ids).map(String);
            return {
              libraryItems: await Promise.all(
                ids.map(async (id) => mapAbsBook(context, await loadAbsBook(runtime, context, id))),
              ),
            };
          }
          const itemId = parts[2];
          const action = parts[3];
          if (action === "cover" && ["GET", "HEAD"].includes(method)) {
            const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
            if (item.libraryId !== context.libraryId || item.itemType !== "audiobook.book")
              throw new ApiError(404, "abs_book_not_found", "有声书不存在");
            if (String(item.libraryKind) === "content_source_audiobook") {
              // 关键变量：海报墙读取封面不触发整书详情，未取章节的在线书也能直接显示摘要封面。
              await runtime.contentAudiobooks.assertLibraryAvailable(context.libraryId, context.ownerUserId);
              return sendAbsCover(runtime, context, { item }, request, reply);
            }
          }
          const book = await loadAbsBook(runtime, context, itemId);
          if (!action && method === "GET") {
            const mapped = mapAbsBook(context, book, true);
            if (
              String(query.include ?? "")
                .split(",")
                .includes("progress")
            )
              mapped.userMediaProgress = await progress.get(context, book);
            return mapped;
          }
          if (action === "cover" && ["GET", "HEAD"].includes(method))
            return sendAbsCover(runtime, context, book, request, reply);
          if (action === "play" && method === "POST" && parts.length === 4)
            return sessions.start(context, book, body);
          if (action === "file" && parts[4] && ["GET", "HEAD"].includes(method))
            return streamAbsItemFile(
              runtime,
              context,
              itemId,
              parts[4],
              request,
              reply,
              parts[5] === "download",
            );
          if (action === "download" && ["GET", "HEAD"].includes(method)) {
            if (book.tracks.length !== 1)
              throw new ApiError(
                501,
                "abs_archive_unavailable",
                "多文件作品请通过音轨下载，当前不生成整书 ZIP",
              );
            return streamAbsTrack(runtime, context, book.tracks[0]!, request, reply, true);
          }
          if (["POST", "PATCH", "DELETE"].includes(method))
            throw new ApiError(403, "abs_management_forbidden", "当前账号不能通过 ABS 修改媒体库文件");
        }
        if (parts[0] === "api" && parts[1] === "session") {
          if (parts[2] === "local-all" && method === "POST") {
            if (!Array.isArray(body.sessions))
              throw new ApiError(400, "abs_local_sessions_invalid", "缺少离线会话数组");
            const results: Record<string, unknown>[] = [];
            for (const value of body.sessions) {
              const local: Record<string, unknown> = {
                ...readAbsObject(value),
                deviceInfo: body.deviceInfo ?? readAbsObject(value).deviceInfo,
              };
              try {
                results.push(await sessions.syncLocal(context, local));
              } catch (error) {
                results.push({
                  id: local.id ?? null,
                  success: false,
                  error: error instanceof ApiError ? error.message : "离线会话同步失败",
                });
              }
            }
            return { results };
          }
          if (parts[2] === "local" && method === "POST") {
            await sessions.syncLocal(context, body);
            return reply.code(200).send();
          }
          if (parts[2] && parts[3] === "sync" && method === "POST") {
            await sessions.sync(context, parts[2], body);
            return reply.code(200).send();
          }
          if (parts[2] && parts[3] === "close" && method === "POST") {
            await sessions.sync(context, parts[2], body, true);
            return reply.code(200).send();
          }
          if (parts[2] && parts.length === 3 && method === "GET") return sessions.get(context, parts[2]);
        }
        if (parts[0] === "api" && parts[1] === "me") {
          const result = await handleMe(
            runtime,
            context,
            parts,
            method,
            body,
            query,
            access,
            progress,
            sessions,
            reply,
          );
          if (result.handled) return result.value;
        }
        if (parts[0] === "api" && (parts[1] === "collections" || parts[1] === "playlists"))
          return handleLists(context, parts[1], parts.slice(2), method, body, collections, reply);
        if (route === "api/me/sessions" && method === "GET") {
          const rows = await runtime.database
            .query("library_abs_auth_sessions")
            .where({ account_id: context.accountId })
            .where("expires_at", ">", Date.now());
          return {
            sessions: rows.map((row) => ({
              id: row.id,
              createdAt: Number(row.created_at),
              updatedAt: Number(row.updated_at),
              current: false,
              deviceInfo: {},
            })),
            total: rows.length,
            numPages: 1,
            page: 0,
            itemsPerPage: rows.length,
          };
        }
        if (route === "api/me/password" && method === "PATCH") {
          await access.login(library, context.username, body.password);
          await access.updateAccount(context.libraryId, context.accountId, { password: body.newPassword });
          return reply.code(200).send();
        }
        throw new ApiError(404, "abs_route_not_found", "该 ABS 接口尚未提供");
      } catch (error) {
        if (reply.sent) return reply;
        const status = error instanceof ApiError ? error.statusCode : 500;
        return reply
          .code(status)
          .send({ error: error instanceof ApiError ? error.message : "ABS 协议请求失败" });
      }
    },
  });
  // 无尾斜杠的根入口也明确告知用途，不让生产 SPA 返回 HTML 200。
  server.get("/abs/:pathSuffix", async (_request, reply) =>
    reply.code(404).send({ error: "请使用 ABS 播放器连接该服务地址；此入口不提供 Web 管理页面" }),
  );
}

/** Cookie 仅在当前 ABS 子路径生效，多个库地址的浏览器登录不会互相覆盖。 */
function setRefreshCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  basePath: string,
  token: string,
): void {
  reply.setCookie("refresh_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.protocol === "https",
    path: basePath,
    maxAge: 30 * 86400,
  });
}
/** 当前 ABS API 允许官方 Bearer 与媒体 URL query token。 */
function bearerFromRequest(request: FastifyRequest, query: Record<string, unknown>): string {
  const authorization = request.headers.authorization;
  const bearer = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  return bearer ? bearer.trim() : typeof query.token === "string" ? query.token : "";
}
/** 刷新 header 优先于 Cookie，响应方式依照官方约定。 */
function refreshFromRequest(request: FastifyRequest): string {
  const token = request.headers["x-refresh-token"];
  return typeof token === "string" ? token : (request.cookies.refresh_token ?? "");
}
/** 库统计来源于真实作品与音轨，不用固定假数量通过客户端检查。 */
async function libraryStats(runtime: ApiRuntime, context: AbsContext): Promise<Record<string, unknown>> {
  const { books } = await listAbsBookSummaries(runtime, context, { limit: 0 });
  const facets = absFacets(context, books);
  return {
    totalItems: books.length,
    totalAuthors: facets.authors.length,
    totalGenres: facets.genres.length,
    totalDuration: books.reduce((sum, book) => sum + book.duration, 0),
    totalSize: books.reduce((sum, book) => sum + book.size, 0),
    numAudioTracks: books.reduce((sum, book) => sum + book.audioFileCount, 0),
    longestItems: [...books]
      .sort((left, right) => right.duration - left.duration)
      .slice(0, 10)
      .map((book) => ({ id: book.item.id, title: book.item.title, duration: book.duration })),
  };
}

/** 作者、系列、搜索与筛选复用同一完整目录，不另造来源私有 API。 */
async function libraryEntities(
  runtime: ApiRuntime,
  context: AbsContext,
  action: string,
  id: string | undefined,
  query: Record<string, unknown>,
): Promise<unknown> {
  let remoteBookIds: string[] | null = null;
  if (action === "search") {
    const library = await runtime.repository.getLibrary(context.libraryId, context.ownerUserId);
    if (String(library.libraryKind) === "content_source_audiobook") {
      const term = String(query.q ?? "").trim();
      if (!term) throw new ApiError(400, "abs_search_required", "缺少搜索关键词");
      const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit) || 12)));
      const view = context.libraryViews?.find((entry) => entry.id === context.viewLibraryId);
      remoteBookIds = await runtime.contentAudiobooks.search(context.libraryId, context.ownerUserId, term, limit, undefined, view?.categoryId ?? undefined);
    }
  }
  const result = await listAbsBookSummaries(runtime, context, { limit: 0 });
  // 关键变量：原站命中的书籍可能与关键词没有字面包含关系，不能再用本地标题筛掉真实搜索结果。
  const books = remoteBookIds === null ? result.books : remoteBookIds.flatMap((bookId) => {
    const book = result.books.find((entry) => entry.item.id === bookId);
    return book ? [book] : [];
  });
  const facets = absFacets(context, books);
  if (action === "filterdata") return absFilterData(context, books);
  if (action === "authors") {
    const page = absPage(facets.authors, query);
    return { ...page, authors: page.results };
  }
  if (action === "narrators") {
    const page = absPage(facets.narrators, query);
    return { ...page, narrators: page.results };
  }
  if (action === "series") {
    const entities: Record<string, unknown>[] = facets.series.map((series) => ({
      ...series,
      books: books
        .filter((book) => book.series.some((entry) => entry.id === series.id))
        .sort(
          (left, right) =>
            Number(left.series.find((entry) => entry.id === series.id)?.sequence ?? 0) -
            Number(right.series.find((entry) => entry.id === series.id)?.sequence ?? 0),
        )
        .map((book) => mapAbsBook(context, book, false)),
    }));
    if (id) {
      const series = entities.find((entry) => entry.id === id);
      if (!series) throw new ApiError(404, "abs_series_not_found", "系列不存在");
      if (
        String(query.include ?? "")
          .split(",")
          .includes("progress")
      ) {
        const libraryItemIds = books
          .filter((book) => book.series.some((entry) => entry.id === id))
          .map((book) => book.item.id);
        const finished = await runtime.database
          .query("library_abs_progress")
          .select("item_id")
          .where({ library_id: context.libraryId, account_id: context.accountId, is_finished: 1 })
          .whereIn("item_id", libraryItemIds);
        series.progress = {
          libraryItemIds,
          libraryItemIdsFinished: finished.map((row) => String(row.item_id)),
          isFinished: libraryItemIds.length > 0 && finished.length === libraryItemIds.length,
        };
      }
      return series;
    }
    return absPage(entities, query);
  }
  const q = String(query.q ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN");
  if (!q) throw new ApiError(400, "abs_search_required", "缺少搜索关键词");
  const limit = Math.max(1, Number(query.limit) || 12);
  return {
    book: books
      .filter(
        (book) =>
          remoteBookIds !== null || book.item.title.toLocaleLowerCase("zh-CN").includes(q) ||
          book.authors.some((author) => author.name.toLocaleLowerCase("zh-CN").includes(q)),
      )
      .slice(0, limit)
      .map((book) => ({
        libraryItem: mapAbsBook(context, book, false),
        matchKey: "title",
        matchText: book.item.title,
      })),
    authors: facets.authors
      .filter((entry) => String(entry.name).toLocaleLowerCase("zh-CN").includes(q))
      .slice(0, limit)
      .map((author) => ({ author })),
    series: facets.series
      .filter((entry) => String(entry.name).toLocaleLowerCase("zh-CN").includes(q))
      .slice(0, limit)
      .map((series) => ({ series })),
    narrators: facets.narrators
      .filter((entry) => String(entry.name).toLocaleLowerCase("zh-CN").includes(q))
      .slice(0, limit),
    tags: facets.tags.filter((tag) => tag.toLocaleLowerCase("zh-CN").includes(q)).slice(0, limit),
  };
}

/** 当前用户进度、书签和收听历史仅修改独立 ABS 数据。 */
async function handleMe(
  runtime: ApiRuntime,
  context: AbsContext,
  parts: string[],
  method: string,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
  access: AbsAccessService,
  progress: AbsProgressService,
  sessions: AbsSessionService,
  reply: FastifyReply,
): Promise<{ handled: boolean; value?: unknown }> {
  const action = parts[2];
  const id = parts[3];
  if (action === "progress" && !id && method === "GET")
    return { handled: true, value: { mediaProgress: await progress.list(context) } };
  if (action === "progress" && id === "batch" && parts[4] === "update" && method === "PATCH") {
    const values = body.progress ?? body.mediaProgress;
    if (!Array.isArray(values))
      throw new ApiError(400, "abs_progress_batch_invalid", "播放进度批量更新需要数组");
    for (const value of values) {
      const patch = readAbsObject(value);
      await progress.update(context, await loadAbsBook(runtime, context, String(patch.libraryItemId)), patch);
    }
    return { handled: true, value: reply.code(200).send() };
  }
  if (action === "progress" && id) {
    if (method === "DELETE") {
      const row = await runtime.database
        .query("library_abs_progress")
        .where({ id, library_id: context.libraryId, account_id: context.accountId })
        .first();
      if (!row) throw new ApiError(404, "abs_progress_not_found", "播放进度不存在");
      await progress.remove(context, String(row.item_id));
      return { handled: true, value: reply.code(200).send() };
    }
    if (parts[4] === "remove-from-continue-listening" && method === "GET") {
      const row = await runtime.database
        .query("library_abs_progress")
        .where({ id, library_id: context.libraryId, account_id: context.accountId })
        .first();
      if (!row) throw new ApiError(404, "abs_progress_not_found", "播放进度不存在");
      await progress.update(context, await loadAbsBook(runtime, context, String(row.item_id)), {
        hideFromContinueListening: true,
      });
      return { handled: true, value: await buildAbsUser(runtime, context, access, progress) };
    }
    const book = await loadAbsBook(runtime, context, id);
    if (method === "GET") {
      const value = await progress.get(context, book);
      if (!value) throw new ApiError(404, "abs_progress_not_found", "播放进度不存在");
      return { handled: true, value };
    }
    if (method === "PATCH") return { handled: true, value: await progress.update(context, book, body) };
  }
  if (action === "bookmarks" && method === "GET") {
    if (id) await loadAbsBook(runtime, context, id);
    return { handled: true, value: { bookmarks: await progress.bookmarks(context, id) } };
  }
  if (action === "item" && id && parts[4] === "bookmark") {
    if (method === "POST" || method === "PATCH")
      return { handled: true, value: await progress.writeBookmark(context, id, body, method === "PATCH") };
    if (method === "DELETE" && parts[5]) {
      await progress.deleteBookmark(context, id, parts[5]);
      return { handled: true, value: reply.code(200).send() };
    }
  }
  if (action === "items-in-progress" && method === "GET") {
    const states = (await progress.list(context))
      .filter(
        (entry) => !entry.isFinished && !entry.hideFromContinueListening && Number(entry.currentTime) > 0,
      )
      .sort((left, right) => Number(right.lastUpdate) - Number(left.lastUpdate))
      .slice(0, Math.max(0, Number(query.limit) || 25));
    const { books } = await listAbsBookSummaries(runtime, context, { limit: 0 });
    const booksById = new Map(books.map((book) => [book.item.id, book]));
    const libraryItems = states.flatMap((state) => {
      const book = booksById.get(String(state.libraryItemId));
      return book ? [{ ...mapAbsBook(context, book, false), progressLastUpdate: state.lastUpdate }] : [];
    });
    return { handled: true, value: { libraryItems } };
  }
  if (action === "listening-sessions" && method === "GET")
    return { handled: true, value: await sessions.history(context, query) };
  if (action === "item" && id === "listening-sessions" && parts[4] && method === "GET") {
    await loadAbsBook(runtime, context, parts[4]);
    return { handled: true, value: await sessions.history(context, query, parts[4]) };
  }
  if (action === "listening-stats" && method === "GET")
    return { handled: true, value: await sessions.stats(context) };
  return { handled: false };
}

/** 标准集合与播放列表路由，未支持的变更明确返回404而非空成功。 */
async function handleLists(
  context: AbsContext,
  kind: AbsListKind,
  parts: string[],
  method: string,
  body: Record<string, unknown>,
  lists: AbsCollectionService,
  reply: FastifyReply,
): Promise<unknown> {
  const id = parts[0];
  const action = parts[1];
  if (!id && method === "GET") return { [kind]: await lists.list(context, kind) };
  if (!id && method === "POST") return lists.create(context, kind, body);
  if (id && !action && method === "GET") return lists.get(context, kind, id);
  if (id && !action && method === "PATCH") return lists.update(context, kind, id, body);
  if (id && !action && method === "DELETE") {
    await lists.remove(context, kind, id);
    return reply.code(200).send();
  }
  if (id && (action === "book" || action === "item")) {
    const itemId = method === "DELETE" ? parts[2] : (body.id ?? body.libraryItemId);
    if (typeof itemId !== "string") throw new ApiError(400, "abs_list_item_invalid", "缺少作品 ID");
    if (method === "POST" || method === "DELETE")
      return lists.changeItems(context, kind, id, [itemId], method === "DELETE");
  }
  if (id && action === "batch" && method === "POST" && (parts[2] === "add" || parts[2] === "remove")) {
    const values =
      kind === "collections"
        ? readAbsArray(body.books)
        : readAbsArray(body.items).map((entry) => readAbsObject(entry).libraryItemId);
    return lists.changeItems(context, kind, id, values.map(String), parts[2] === "remove");
  }
  throw new ApiError(404, "abs_list_route_not_found", "该书单接口尚未提供");
}
