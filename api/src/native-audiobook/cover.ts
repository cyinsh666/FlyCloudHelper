import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { providerStream } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";
import type { MediaItemRecord } from "../domain.js";

/** 封面直接读取已授权书籍的图片，不补详情、不扫描音频或触发全书时长探测。 */
export async function sendNativeCover(runtime: ApiRuntime, book: MediaItemRecord, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  if (!book.posterUrl) throw new ApiError(404, "cover_unavailable", "作品暂无封面");
  const local = book.posterUrl.match(/^\/api\/v1\/music-artwork\/([a-f0-9]{64}\.(?:jpg|png|webp))$/u);
  if (local?.[1]) {
    const file = path.join(runtime.config.musicArtworkDirectory, local[1]);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new ApiError(404, "cover_unavailable", "封面文件不存在");
    reply.type(local[1].endsWith("png") ? "image/png" : local[1].endsWith("webp") ? "image/webp" : "image/jpeg");
    reply.header("Content-Length", stat.size).header("Cache-Control", "private, max-age=300");
    return reply.send(request.method === "HEAD" ? undefined : fs.createReadStream(file));
  }
  if (!/^https?:\/\//i.test(book.posterUrl)) throw new ApiError(404, "cover_unavailable", "封面地址不可用");
  const controller = new AbortController();
  /** 页面取消只结束本次图片请求，不干预源脚本和其他播放。 */
  const abort = (): void => controller.abort();
  /** 完成、失败和断开都移除请求监听。 */
  const cleanup = (): void => { request.raw.off("aborted", abort); reply.raw.off("close", abort); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    const upstream = await providerStream(book.posterUrl, { method: request.method === "HEAD" ? "HEAD" : "GET" },
      { allowInsecureHttp: runtime.config.allowInsecureProviderHttp }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    const type = String(upstream.headers["content-type"] ?? "").split(";")[0]!;
    if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !/^image\//i.test(type)) {
      upstream.body.destroy();
      throw new ApiError(502, "cover_unavailable", "来源封面暂时无法读取");
    }
    upstream.body.once("close", cleanup);
    upstream.body.once("error", cleanup);
    reply.type(type).header("Cache-Control", "private, max-age=300");
    return reply.send(upstream.body);
  } catch (error) { cleanup(); throw error; }
}
