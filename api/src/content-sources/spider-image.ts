import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { openSpiderProxyResource, type ContentSourceResourceResponse } from "./spider-proxy.js";

// 关键变量：源代理图片与现有协议图片保持相同上限，不把完整媒体误读为图片。
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 已由协议层解析的媒体图片与媒体库范围，不允许演员头像或网盘地址调用脚本代理。 */
interface SpiderImageScope {
  ownerUserId: string;
  libraryId: string;
  libraryKind: string;
}

/** 读取内容源专用图片，源实例归属继续由通用代理入口校验。 */
export async function sendSpiderSourceImage(
  runtime: ApiRuntime,
  scope: SpiderImageScope,
  request: FastifyRequest,
  reply: FastifyReply,
  source: { url: string; sourceType: "media" | "person" },
): Promise<FastifyReply> {
  if (scope.libraryKind !== "content_source_video" || source.sourceType !== "media") {
    throw new ApiError(404, "content_image_not_found", "内容源图片不存在");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 10_000);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  let body: ContentSourceResourceResponse["body"] | undefined;
  try {
    const response = await openSpiderProxyResource(runtime, source.url, {}, scope, controller.signal);
    body = response.body;
    if (response.statusCode < 200 || response.statusCode >= 300) throw new ApiError(502, "content_image_upstream_failed", "内容源图片暂时不可用");
    const length = Number(response.headers["content-length"] ?? 0);
    if (length > MAX_IMAGE_BYTES) throw new ApiError(413, "content_image_too_large", "图片文件过大");
    const contentType = String(response.headers["content-type"] ?? "image/jpeg");
    if (!contentType.toLowerCase().startsWith("image/")) throw new ApiError(502, "content_image_invalid", "内容源返回了非图片内容");
    reply.header("Content-Type", contentType).header("Cache-Control", "private, max-age=86400");
    if (request.method === "HEAD") {
      if (length > 0) reply.header("Content-Length", length);
      return reply.send();
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      controller.signal.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_IMAGE_BYTES) throw new ApiError(413, "content_image_too_large", "图片文件过大");
      chunks.push(buffer);
    }
    const image = Buffer.concat(chunks);
    reply.header("Content-Length", image.length);
    return reply.send(image);
  } finally {
    body?.destroy();
    clearTimeout(timer);
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}
