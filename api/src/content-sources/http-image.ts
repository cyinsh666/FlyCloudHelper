import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { providerStream } from "../providers/network.js";

// 关键变量：与既有协议图片限制保持一致，只读取已属于在线影视条目的图片。
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 图片主机没有声明图片 MIME 时，以真实文件标识补充类型，不将普通二进制默认当成 JPEG。 */
export function readSourceImageContentType(declaredType: string, bytes: Buffer): string | null {
  if (declaredType.toLowerCase().startsWith("image/")) return declaredType;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  const signature = bytes.subarray(0, 12).toString("ascii");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
  if (signature.startsWith("BM")) return "image/bmp";
  if (signature.slice(4, 8) === "ftyp" && ["avif", "avis"].includes(signature.slice(8, 12))) return "image/avif";
  return null;
}

/** 在线影视 HTTP 图片共用有界读取与 MIME 检查；网盘图片继续使用原有协议处理流程。 */
export async function sendContentSourceHttpImage(request: FastifyRequest, reply: FastifyReply, url: URL): Promise<FastifyReply> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 10_000);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  let body: Awaited<ReturnType<typeof providerStream>>["body"] | undefined;
  try {
    // HEAD 同样检查少量真实字节，使错误标为 octet-stream 的图片也返回正确类型。
    const response = await providerStream(url, { method: "GET", headers: { "Accept-Encoding": "identity" } }, { allowInsecureHttp: true }, controller.signal);
    body = response.body;
    const length = Number(response.headers["content-length"] ?? 0);
    if (length > MAX_IMAGE_BYTES) throw new ApiError(413, "content_image_too_large", "图片文件过大");
    const declaredType = String(response.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      controller.signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_IMAGE_BYTES) throw new ApiError(413, "content_image_too_large", "图片文件过大");
      chunks.push(bytes);
      if (request.method === "HEAD" && size >= 32) break;
    }
    const bytes = Buffer.concat(chunks);
    const contentType = readSourceImageContentType(declaredType, bytes);
    if (!bytes.length || !contentType) throw new ApiError(502, "content_image_invalid", "内容源返回了非图片内容");
    reply.header("Content-Type", contentType).header("Cache-Control", "private, max-age=86400");
    if (request.method === "HEAD") {
      if (length > 0) reply.header("Content-Length", length);
      return reply.send();
    }
    return reply.header("Content-Length", bytes.length).send(bytes);
  } finally {
    body?.destroy();
    clearTimeout(timer);
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}
