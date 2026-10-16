import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiRuntime } from "../runtime.js";
import { ApiError } from "../errors.js";
import { providerStream, validateProviderUrl } from "../providers/network.js";
import type { ProviderFileStreamAccess } from "../providers/types.js";
import { openMusicFileStream } from "../music/file-stream.js";
import { resolveNavidromeDirectPlayback } from "../music/navidrome-playback.js";
import {
  buildUpstreamHeaders,
  copyMediaResponseHeaders,
  resolveRelayAccess,
  type RelayLibraryRow,
} from "../routes/media-stream-routes.js";
import { loadAbsBook } from "./catalog.js";
import type { AbsBook, AbsContext, AbsTrack } from "./types.js";

/** 按真实文件所属来源加载取址上下文，不能固定使用媒体库第一个服务。 */
async function relayForTrack(
  runtime: ApiRuntime,
  context: AbsContext,
  track: AbsTrack,
): Promise<RelayLibraryRow> {
  const sourceId = String(track.file.librarySourceId ?? "");
  const source = await runtime.repository.getLibrarySource(sourceId, context.ownerUserId);
  if (
    source.libraryId !== context.libraryId ||
    source.status !== "active" ||
    (source.serviceStatus !== null && !["active", "scanning"].includes(source.serviceStatus))
  )
    throw new ApiError(503, "abs_source_unavailable", "章节所属网盘来源暂不可用");
  // 遗留 owned_copy 来源没有 cloud_services 引用，中转通过来源自己的凭据读取。
  return {
    id: context.libraryId,
    library_source_id: sourceId,
    service_id: source.serviceId ?? "",
    provider_type: source.providerType,
    service_status: source.serviceStatus ?? "active",
    credential_revision: source.credentialRevision,
    relay_playback_enabled: context.relayPlaybackEnabled ? 1 : 0,
  };
}

/** 在线有声书只在读取时刷新音频地址，使用现有网络层传递原始音频及 Range。 */
async function streamContentAbsTrack(
  runtime: ApiRuntime,
  context: AbsContext,
  track: AbsTrack,
  request: FastifyRequest,
  reply: FastifyReply,
  download: boolean,
): Promise<FastifyReply> {
  const controller = new AbortController();
  /** 客户端结束请求后取消正在进行的脚本取址和上游读取。 */
  const abort = (): void => controller.abort();
  /** 所有完成及异常出口均移除监听，流的关闭不遗留当前请求引用。 */
  const cleanup = (): void => {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) controller.abort();
  let mimeType = track.mimeType;
  /** 仅在内存保存本次取址，临时 URL 和请求头不进入会话快照及数据库。 */
  const resolve = async (): Promise<ProviderFileStreamAccess> => {
    const access = await runtime.contentAudiobooks.playback(
      context.libraryId, context.ownerUserId, track.chapterId, controller.signal,
    );
    if (/^audio\//iu.test(access.mimeType)) mimeType = access.mimeType;
    return { url: access.url, headers: access.headers, expiresAt: null };
  };
  try {
    const initialAccess = await resolve();
    controller.signal.throwIfAborted();
    // 关键变量：ABS 客户端无法附加源站 Referer/Cookie 等请求头，依赖这些字段时自动中转。
    if (!context.relayPlaybackEnabled && !download && Object.keys(initialAccess.headers).length === 0) {
      await validateProviderUrl(initialAccess.url, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp });
      controller.signal.throwIfAborted();
      cleanup();
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(initialAccess.url, 307);
    }
    const upstream = await openMusicFileStream(
      resolve,
      // 请求头只携带客户端的 Range 等通用条件，重取址时由 openMusicFileStream 合并最新源站请求头。
      { method: request.method === "HEAD" ? "HEAD" : "GET", headers: buildUpstreamHeaders(request, {}) },
      { allowInsecureHttp: runtime.config.allowInsecureProviderHttp },
      controller.signal,
      initialAccess,
    );
    upstream.body.once("close", cleanup);
    const contentType = upstream.headers["content-type"];
    const upstreamType = Array.isArray(contentType) ? (contentType[0] ?? "") : (contentType ?? "");
    if (upstream.statusCode !== 416 && /^(?:text\/html|application\/json)(?:\s*;|\s*$)/iu.test(upstreamType)) {
      upstream.body.destroy();
      throw new ApiError(502, "abs_audio_response_invalid", "源站没有返回音频，请稍后重试");
    }
    copyMediaResponseHeaders(reply, upstream.headers);
    // 多段 Range 保留完整 boundary；有真实上游类型时不以元数据覆盖它。
    if (upstream.statusCode !== 416 && (!upstreamType || /^application\/octet-stream(?:\s*;|\s*$)/iu.test(upstreamType)))
      reply.type(mimeType);
    reply.header("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(String(track.file.name ?? track.title))}`);
    reply.code(upstream.statusCode);
    return reply.send(upstream.body);
  } catch (error) {
    cleanup();
    if (error instanceof ApiError) {
      // 在线源复用原音频网络层，仅转换本入口的领域文案，保留原 HTTP 错误状态。
      if (error.code === "music_file_missing")
        throw new ApiError(error.statusCode, "abs_source_audio_missing", "有声书源音频已不存在或暂不可用");
      if (error.code === "music_file_access_denied")
        throw new ApiError(error.statusCode, "abs_source_audio_access_denied", "重新取址后仍无法读取有声书源音频，请稍后重试或检查源站状态");
      if (error.code === "music_file_read_failed")
        throw new ApiError(error.statusCode, "abs_source_audio_read_failed", "有声书源音频读取失败，请稍后重试");
    }
    throw error;
  }
}

/** 返回一个物理音轨原文，保留 Range/HEAD/416，不执行时间裁切和实时转码。 */
export async function streamAbsTrack(
  runtime: ApiRuntime,
  context: AbsContext,
  track: AbsTrack,
  request: FastifyRequest,
  reply: FastifyReply,
  download = false,
): Promise<FastifyReply> {
  if (download && !context.canDownload)
    throw new ApiError(403, "abs_download_forbidden", "当前账号没有下载权限");
  if (track.file.contentSourceAudiobook === true)
    return streamContentAbsTrack(runtime, context, track, request, reply, download);
  const library = await relayForTrack(runtime, context, track);
  const locator =
    track.file.playbackLocator && typeof track.file.playbackLocator === "object"
      ? (track.file.playbackLocator as Record<string, unknown>)
      : {};
  const controller = new AbortController();
  /** 客户端断开即停止上游请求，避免继续下载整段长音频。 */
  const abort = (): void => controller.abort();
  /** 每个出口都移除请求监听，防止长时间使用后积累失效回调。 */
  const cleanup = (): void => {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    if (!context.relayPlaybackEnabled && !download && library.service_id) {
      const direct = await resolveNavidromeDirectPlayback(
        runtime,
        library,
        context.ownerUserId,
        locator,
        request,
        controller.signal,
      );
      if (direct.url) {
        cleanup();
        reply.header("Cache-Control", "private, no-store");
        return reply.redirect(direct.url, 307);
      }
    }
    const upstream = await openMusicFileStream(
      () => resolveRelayAccess(runtime, library, context.ownerUserId, locator, controller.signal),
      { method: request.method === "HEAD" ? "HEAD" : "GET", headers: buildUpstreamHeaders(request, {}) },
      { allowInsecureHttp: runtime.config.allowInsecureProviderHttp },
      controller.signal,
    );
    upstream.body.once("close", cleanup);
    copyMediaResponseHeaders(reply, upstream.headers);
    // 多段 Range 的正文由边界分隔，必须保留上游 multipart 类型及 boundary 参数。
    const contentType = upstream.headers["content-type"];
    const upstreamType = Array.isArray(contentType) ? (contentType[0] ?? "") : (contentType ?? "");
    if (!/^multipart\/byteranges(?:\s*;|\s*$)/iu.test(upstreamType)) reply.type(track.mimeType);
    reply.header(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(String(track.file.name ?? track.title))}`,
    );
    reply.code(upstream.statusCode);
    return reply.send(upstream.body);
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** 校验作品与文件关联后再读取，不能让 fileId 绕过媒体库范围。 */
export async function streamAbsItemFile(
  runtime: ApiRuntime,
  context: AbsContext,
  itemId: string,
  fileId: string,
  request: FastifyRequest,
  reply: FastifyReply,
  download = false,
): Promise<FastifyReply> {
  const book = await loadAbsBook(runtime, context, itemId);
  const track = book.tracks.find((entry) => entry.ino === fileId);
  if (!track) throw new ApiError(404, "abs_file_not_found", "作品音频文件不存在");
  return streamAbsTrack(runtime, context, track, request, reply, download);
}

/** 服务端代理封面，让客户端只访问 ABS 自身地址，无需拿到网盘认证信息。 */
export async function sendAbsCover(
  runtime: ApiRuntime,
  context: AbsContext,
  book: Pick<AbsBook, "item">,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const url = book.item.posterUrl;
  if (!url) throw new ApiError(404, "abs_cover_not_found", "作品暂无封面");
  const local = url.match(/^\/api\/v1\/music-artwork\/([a-f0-9]{64}\.(?:jpg|png|webp))$/u);
  if (local?.[1]) {
    const target = path.join(runtime.config.musicArtworkDirectory, local[1]);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new ApiError(404, "abs_cover_not_found", "封面文件不存在");
    reply.header("Cache-Control", "private, max-age=3600");
    reply.type(
      local[1].endsWith("png") ? "image/png" : local[1].endsWith("webp") ? "image/webp" : "image/jpeg",
    );
    reply.header("Content-Length", stat.size);
    return reply.send(fs.createReadStream(target));
  }
  if (!/^https?:\/\//iu.test(url)) throw new ApiError(404, "abs_cover_not_found", "封面地址暂不可用");
  const controller = new AbortController();
  /** 断开封面请求时取消上游读取。 */
  const abort = (): void => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    const upstream = await providerStream(
      url,
      { method: request.method === "HEAD" ? "HEAD" : "GET" },
      { allowInsecureHttp: runtime.config.allowInsecureProviderHttp },
      controller.signal,
    );
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      upstream.body.destroy();
      throw new ApiError(404, "abs_cover_not_found", "作品封面读取失败");
    }
    const mime = String(upstream.headers["content-type"] ?? "").split(";")[0] ?? "";
    if (!/^image\//u.test(mime)) {
      upstream.body.destroy();
      throw new ApiError(422, "abs_cover_type_invalid", "封面不是图片");
    }
    upstream.body.once("close", () => {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    });
    reply.type(mime);
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(upstream.body);
  } catch (error) {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
    throw error;
  }
}
