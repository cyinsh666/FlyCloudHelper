import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { NativeAccess } from "./access.js";
import { NativeCatalog } from "./catalog.js";
import { sendNativeCover } from "./cover.js";
import { registerNativeAudiobookManagement } from "./management.js";
import { NativePlayback } from "./playback.js";
import { nativeLocalChapters } from "./local-chapters.js";
import { nativeRequestBasePath } from "./path.js";
import { NativeStore } from "./store.js";
import type { NativeContext } from "./types.js";
import { NativeUserState } from "./user-state.js";

/** 原生客户端只使用这些已声明路由，不借用 ABS/Jellyfin 的账号或 DTO。 */
export async function registerNativeAudiobookRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const store = new NativeStore(runtime.database);
  const access = new NativeAccess(runtime, store);
  const catalog = new NativeCatalog(runtime, store, access);
  const state = new NativeUserState(runtime, store, access, catalog);
  const playback = new NativePlayback(runtime, store, access, catalog, state);
  await registerNativeAudiobookManagement(server, runtime, store, access);
  await server.register(async (native) => {
    const base = "/a/:pathSuffix";
    const api = `${base}/api/v1`;
    native.addHook("onClose", async () => {
      playback.close();
      await nativeLocalChapters(runtime).shutdown();
    });
    native.addHook("onSend", async (_request, reply, payload) => {
      if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "private, no-store");
      return payload;
    });

    /** 错误体保持原生协议格式，来源错误仅返回可展示的文案。 */
    native.setErrorHandler((error, request, reply) => {
      const statusValue = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
      const status = error instanceof ApiError ? error.statusCode : typeof statusValue === "number" ? statusValue : 500;
      const code = error instanceof ApiError ? error.code : status === 413 ? "request_too_large" : "internal_error";
      const message = error instanceof ApiError ? error.message : status === 413 ? "请求内容超过大小限制" : "听书服务暂时无法处理请求";
      const retryAfter = error instanceof ApiError ? error.fields?.find((field) => field.field === "retryAfterSeconds")?.message : undefined;
      if (status === 429 && retryAfter && /^[1-9][0-9]{0,3}$/.test(retryAfter) && Number(retryAfter) <= 3600)
        reply.header("Retry-After", retryAfter);
      const nativeDetails = error instanceof ApiError && "nativeDetails" in error ? error.nativeDetails as { Progress?: Record<string, unknown> } : null;
      const progress = nativeDetails?.Progress;
      const details = progress ? { Progress: Object.fromEntries(["BookId", "ChapterId", "PositionSeconds", "ChapterCompleted", "BookCompleted", "HiddenFromContinueListening", "UpdatedAt", "Revision"].map((key) => [key, progress[key]])) } : error instanceof ApiError ? error.fields ?? null : null;
      return reply.code(status).send({ Error: { Code: code, Message: message,
        Retryable: [409, 429, 502, 503, 504].includes(status), RequestId: request.id,
        Details: details,
      } });
    });

    /** 只接收对象查询参数；Fastify 已解析字符串，分页校验交给对应目录方法。 */
    function query(request: FastifyRequest): Record<string, unknown> {
      return request.query && typeof request.query === "object" && !Array.isArray(request.query) ? request.query as Record<string, unknown> : {};
    }

    /** 参数读取集中处理，所有业务路由都重新通过入口账号认证。 */
    function params(request: FastifyRequest): Record<string, string> { return request.params as Record<string, string>; }
    /** 幂等键只接受一个明确文本值，不把重复请求头拼接成另一个操作。 */
    function idempotency(request: FastifyRequest): string | undefined {
      const value = request.headers["idempotency-key"];
      if (value !== undefined && typeof value !== "string") throw new ApiError(400, "invalid_idempotency_key", "幂等键必须是单个文本值");
      return value;
    }
    /** 路径后缀只界定入口，不替代令牌中的账号和设备身份。 */
    async function context(request: FastifyRequest): Promise<NativeContext> { return access.requireContext(request, params(request).pathSuffix!); }

    /** 前台断开只取消本次取址消费者，不终止其他调用者共享的执行。 */
    async function playbackRequest(request: FastifyRequest, reply: FastifyReply, operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
      const controller = new AbortController();
      /** 当前请求中断时通知播放服务释放自己的等待引用。 */
      const abort = (): void => controller.abort();
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      if (request.raw.aborted || reply.raw.destroyed) controller.abort();
      try { return await operation(controller.signal); }
      finally { request.raw.off("aborted", abort); reply.raw.off("close", abort); }
    }

    /** 权限在响应前复核，避免把已撤销范围中的缓存交给客户端。 */
    async function sendJson(request: FastifyRequest, reply: FastifyReply, current: NativeContext, result: unknown): Promise<FastifyReply> {
      const fresh = await access.refreshContext(current);
      if (fresh.service.PermissionsRevision !== current.service.PermissionsRevision || fresh.account.PermissionsRevision !== current.account.PermissionsRevision)
        throw new ApiError(503, "consistent_read_retry_required", "账号权限已变化，请重新读取");
      return reply.send(result);
    }

    /** 读取数据前后校验账号状态版本，ETag 根据本次一致的实际表示计算。 */
    async function cached(request: FastifyRequest, reply: FastifyReply, load: (current: NativeContext) => Promise<Record<string, unknown>>): Promise<FastifyReply> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await context(request);
        const before = await state.syncRevision(current);
        const result = await load(current);
        if (before !== await state.syncRevision(current)) continue;
        const fresh = await access.refreshContext(current);
        if (fresh.service.PermissionsRevision !== current.service.PermissionsRevision || fresh.account.PermissionsRevision !== current.account.PermissionsRevision) continue;
        if (result.Status === "Preparing") return reply.code(202).header("Retry-After", 2).send(result);
        if (result.Status === "Failed") throw new ApiError(502, "source_directory_failed", "来源章节目录准备失败，请稍后重试");
        const payload = JSON.stringify(result);
        const etag = `"${createHash("sha256").update(JSON.stringify([current.service.ServiceId, current.account.AccountId, fresh.service.PermissionsRevision, fresh.account.PermissionsRevision])).update(payload).digest("hex")}"`;
        reply.header("ETag", etag).header("Cache-Control", "private, no-cache").header("Vary", "Authorization");
        if (request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) return reply.code(304).send();
        return reply.send(result);
      }
      throw new ApiError(503, "consistent_read_retry_required", "目录或用户状态正在更新，请稍后重试");
    }

    native.get(`${base}/System/Info/Public`, async (request) => {
      const service = await access.getServiceBySuffix(params(request).pathSuffix!);
      const system = await runtime.database.getSystemState();
      return { Protocol: "FlyAudioBook", ApiVersion: 1, ServerId: system.serviceInstanceId, ServiceId: service.ServiceId,
        ServerName: service.Name, Mode: service.Mode, ApiBasePath: `${await nativeRequestBasePath(runtime, request, service.PathSuffix)}/api/v1`,
        Capabilities: { UnknownDuration: true, ChapterPagination: true, ChapterPlayback: true, AtomicChapterAdvance: true, IncrementalSync: true, RealtimeSearch: true },
      };
    });
    native.post(`${api}/Users/AuthenticateByName`, { bodyLimit: 16384 }, async (request) => {
      const suffix = params(request).pathSuffix!;
      return access.authenticate(suffix, request.body, await nativeRequestBasePath(runtime, request, suffix));
    });
    native.get(`${api}/Users/Me`, async (request) => access.me(await context(request)));
    native.post(`${api}/Sessions/Logout`, async (request, reply) => { await access.logout(await context(request)); return reply.code(204).send(); });

    native.get(`${api}/Libraries`, async (request, reply) => cached(request, reply, (current) => catalog.libraries(current, query(request))));
    native.get(`${api}/Libraries/:libraryId/Categories`, async (request, reply) => cached(request, reply, (current) => catalog.categories(current, params(request).libraryId!, query(request))));
    native.get(`${api}/Libraries/:libraryId/Books`, async (request, reply) => cached(request, reply, (current) => catalog.books(current, params(request).libraryId!, query(request))));
    native.get(`${api}/Libraries/:libraryId/Series`, async (request, reply) => cached(request, reply, (current) => catalog.series(current, params(request).libraryId!, query(request))));
    native.get(`${api}/Libraries/:libraryId/Search`, async (request, reply) => {
      const current = await context(request);
      return playbackRequest(request, reply, async (signal) => sendJson(request, reply, current,
        await catalog.search(current, params(request).libraryId!, query(request), signal)));
    });
    native.get(`${api}/Books/:bookId`, async (request, reply) => cached(request, reply, (current) => catalog.detail(current, params(request).bookId!, state)));
    native.get(`${api}/Books/:bookId/Chapters`, async (request, reply) => cached(request, reply, (current) => catalog.chapters(current, params(request).bookId!, query(request), state)));
    native.get(`${api}/Books/:bookId/Chapters/:chapterId`, async (request, reply) => cached(request, reply, (current) => catalog.chapter(current, params(request).bookId!, params(request).chapterId!, state)));
    native.route({ method: ["GET", "HEAD"], url: `${api}/Books/:bookId/Cover`, handler: async (request, reply) => {
      const current = await context(request);
      const book = await catalog.assertBook(current, params(request).bookId!);
      await access.assertLibrary(current, book.libraryId);
      return sendNativeCover(runtime, book, request, reply);
    } });

    native.post(`${api}/Playback/Sessions`, { bodyLimit: 16384 }, async (request, reply) => {
      const current = await context(request);
      return playbackRequest(request, reply, (signal) => playback.create(current, request.body, idempotency(request), signal));
    });
    native.post(`${api}/Playback/Sessions/:playSessionId/Events`, { bodyLimit: 16384 }, async (request) => playback.events(await context(request), params(request).playSessionId!, request.body));
    native.post(`${api}/Playback/Sessions/:playSessionId/Advance`, { bodyLimit: 16384 }, async (request, reply) => {
      const current = await context(request);
      return playbackRequest(request, reply, (signal) => playback.advance(current, params(request).playSessionId!, request.body, idempotency(request), signal));
    });
    native.route({ method: ["GET", "HEAD"], url: `${api}/Playback/Sessions/:playSessionId/Stream`, handler: async (request, reply) => playback.stream(await context(request), params(request).playSessionId!, request, reply) });
    native.route({ method: ["GET", "HEAD"], url: `${api}/Books/:bookId/Chapters/:chapterId/Download`, handler: async (request, reply) => playback.download(await context(request), params(request).bookId!, params(request).chapterId!, request, reply) });

    native.get(`${api}/Books/:bookId/Progress`, async (request, reply) => cached(request, reply, (current) => state.progress(current, params(request).bookId!)));
    native.patch(`${api}/Books/:bookId/Progress`, { bodyLimit: 16384 }, async (request) => state.patchProgress(await context(request), params(request).bookId!, request.body));
    native.get(`${api}/Users/Me/ContinueListening`, async (request, reply) => cached(request, reply, (current) => state.continueListening(current, query(request))));
    native.get(`${api}/Users/Me/Favorites`, async (request, reply) => cached(request, reply, (current) => state.favorites(current, query(request))));
    native.put(`${api}/Books/:bookId/Favorite`, async (request) => state.favorite(await context(request), params(request).bookId!, true));
    native.delete(`${api}/Books/:bookId/Favorite`, async (request) => state.favorite(await context(request), params(request).bookId!, false));
    native.get(`${api}/Books/:bookId/Bookmarks`, async (request, reply) => cached(request, reply, (current) => state.bookmarks(current, params(request).bookId!, query(request))));
    native.post(`${api}/Books/:bookId/Bookmarks`, { bodyLimit: 16384 }, async (request, reply) => reply.code(201).send(await state.createBookmark(await context(request), params(request).bookId!, request.body)));
    native.patch(`${api}/Books/:bookId/Bookmarks/:bookmarkId`, { bodyLimit: 16384 }, async (request) => state.updateBookmark(await context(request), params(request).bookId!, params(request).bookmarkId!, request.body));
    native.delete(`${api}/Books/:bookId/Bookmarks/:bookmarkId`, async (request) => state.deleteBookmark(await context(request), params(request).bookId!, params(request).bookmarkId!));
    native.get(`${api}/Users/Me/ListeningHistory`, async (request, reply) => cached(request, reply, (current) => state.history(current, query(request))));
    native.get(`${api}/Users/Me/Changes`, async (request, reply) => {
      const current = await context(request);
      return sendJson(request, reply, current, await state.changes(current, query(request)));
    });
    native.all(`${base}/*`, async () => { throw new ApiError(404, "endpoint_not_found", "原生听书接口不存在"); });
  });
}
