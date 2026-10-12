import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import { providerProbeStream } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";
import { buildUpstreamHeaders, copyMediaResponseHeaders } from "../routes/media-stream-routes.js";
import { openMusicFileStream } from "./file-stream.js";

/** 读取在线音乐请求参数，表单与 URL 参数使用同一规则。 */
function readStreamParameter(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

/** Subsonic 最大码率以 kbps 为单位，0 表示使用音源默认质量。 */
function readMaximumBitRate(query: Record<string, unknown>): number {
  const text = readStreamParameter(query.maxBitRate).trim();
  if (!text) return 0;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new ApiError(422, "navidrome_max_bit_rate_invalid", "最大码率必须是非负整数");
  }
  return value;
}

/** 输出音源原始音频，不依赖网盘文件，也不把 Subsonic 凭据发送给音源。 */
export async function streamContentSourceSong(
  runtime: ApiRuntime,
  libraryId: string,
  ownerUserId: string,
  item: MediaItemRecord,
  query: Record<string, unknown>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const cleanup = (): void => {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    const maximumBitRate = readMaximumBitRate(query);
    const requestedFormat = readStreamParameter(query.format).trim().toLowerCase();
    /** 每次重取地址都校验真实音频规格，不用原文件冒充转码结果。 */
    const resolve = async () => {
      const resolved = await runtime.contentMusic.resolveSong(libraryId, ownerUserId, item.id, maximumBitRate, controller.signal);
      controller.signal.throwIfAborted();
      if (requestedFormat && requestedFormat !== "raw" && requestedFormat !== resolved.suffix.toLowerCase()) {
        throw new ApiError(422, "navidrome_audio_format_unsupported", "当前音源不支持请求的音频格式，服务器未提供转码");
      }
      if (maximumBitRate > 0 && resolved.bitRate > maximumBitRate) {
        throw new ApiError(422, "navidrome_audio_bit_rate_unsupported", "当前音源不支持请求的最大码率，服务器未提供转码");
      }
      return resolved;
    };
    let access = await resolve();
    // 关键变量：客户端协议账号、Cookie 和查询参数不会加入源站请求头。
    const upstreamHeaders = buildUpstreamHeaders(request, {});
    const networkOptions = {
      allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
      logConnectionFailure: (fields: Record<string, string | number | boolean | null>) => runtime.logBusinessEvent("warn", fields),
    };
    const hasRequiredHeaders = Object.entries(access.headers ?? {}).some(([, value]) => Boolean(value));
    if (access.mode !== "relay" && !hasRequiredHeaders) {
      try {
        // 关键变量：只探测一个字节，确认匿名地址可访问后才交给客户端直连。
        const probe = await providerProbeStream(access.url, {
          method: "GET", headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
        }, networkOptions, controller.signal);
        const contentType = String(probe.headers["content-type"] ?? access.contentType).split(";")[0]?.trim().toLowerCase() ?? "";
        const canPlay = probe.statusCode >= 200 && probe.statusCode < 300
          && (contentType.startsWith("audio/") || contentType === "application/octet-stream");
        const directUrl = probe.finalUrl.href;
        probe.body.destroy();
        if (canPlay) {
          cleanup();
          reply.header("Cache-Control", "private, no-store");
          // POST 使用 303 转为 GET，防止客户端把带协议凭据的表单发送给音频服务器。
          return reply.redirect(directUrl, request.method === "POST" ? 303 : 307);
        }
        if (access.mode === "direct") {
          throw new ApiError(503, "content_music_direct_unavailable", "音源地址暂时无法直连");
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        if (access.mode === "direct") throw error;
        // 自动模式继续使用服务端中转；源站仍不可读时由中转请求返回协议错误。
      }
    } else if (access.mode === "direct") {
      throw new ApiError(422, "content_music_direct_headers_required", "当前音源需要额外请求头，请使用自动或中转模式");
    }
    const upstream = await openMusicFileStream(async () => {
      access = await resolve();
      return { url: access.url, headers: access.headers ?? {}, expiresAt: null };
    }, {
      method: request.method === "HEAD" ? "HEAD" : "GET", headers: upstreamHeaders,
    }, networkOptions, controller.signal, { url: access.url, headers: access.headers ?? {}, expiresAt: null });
    upstreamBody = upstream.body;
    if (upstream.statusCode === 416) {
      upstream.body.destroy();
      throw new ApiError(416, "content_music_range_unavailable", "请求的音频范围无效");
    }
    const contentType = String(upstream.headers["content-type"] ?? access.contentType).split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      upstream.body.destroy();
      throw new ApiError(503, "content_music_audio_unavailable", "音源没有返回可播放音频");
    }
    upstream.body.once("close", cleanup);
    copyMediaResponseHeaders(reply, upstream.headers);
    if (!upstream.headers["content-type"]) reply.type(access.contentType);
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(`${item.title}.${access.suffix}`)}`);
    reply.status(upstream.statusCode);
    if (request.method === "HEAD") {
      upstream.body.destroy();
      cleanup();
      return reply.send();
    }
    return reply.send(upstream.body);
  } catch (error) {
    cleanup();
    upstreamBody?.destroy();
    throw error;
  }
}
