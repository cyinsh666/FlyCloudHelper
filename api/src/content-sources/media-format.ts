import { Readable } from "node:stream";
import type { ContentVideoContainer } from "./types.js";

/** 累计读取到 512 字节或流结束用于格式判断，再返回能够回放全部原始字节的媒体流。 */
export async function inspectContentBody(body: Readable): Promise<{ prefix: Buffer; stream: Readable }> {
  // 关键变量：退出前缀读取不能销毁原流，后续清单读取或媒体中转仍需继续消费它。
  const iterator = body.iterator({ destroyOnReturn: false });
  // 关键变量：首块可能只有几个字节，累计到签名判断长度；覆盖边界的完整数据块也必须保留。
  const inspectedChunks: Buffer[] = [];
  let inspectedBytes = 0;
  try {
    while (inspectedBytes < 512) {
      const result = await iterator.next();
      if (result.done) break;
      const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
      if (chunk.length === 0) continue;
      inspectedChunks.push(chunk);
      inspectedBytes += chunk.length;
    }
  } finally {
    await iterator.return?.();
  }
  if (inspectedChunks.length === 0) return { prefix: Buffer.alloc(0), stream: body };

  // 关键变量：判断只用前 512 字节，回放保留已读数据块的全部内容，不能截断最后一块。
  const prefix = Buffer.concat(inspectedChunks).subarray(0, 512);

  /** 按原顺序回放全部已读块与后续媒体字节，不把完整视频缓存到内存。 */
  async function* replayContentBody(): AsyncGenerator<Buffer> {
    for (const chunk of inspectedChunks) yield chunk;
    for await (const chunk of body) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  }

  const stream = Readable.from(replayContentBody(), { objectMode: false });
  // 关键变量：客户端结束组合流时同步释放上游连接，避免原流一直占用媒体请求名额。
  stream.once("close", () => {
    if (!body.destroyed) body.destroy();
  });
  return { prefix, stream };
}

/** 优先识别真实正文格式，再参考响应类型与最终地址，均无法判断时沿用已有格式。 */
export function detectContentContainer(
  prefix: Buffer,
  contentType: string,
  finalUrl: URL,
  fallback: ContentVideoContainer = "unknown",
): ContentVideoContainer {
  // 关键变量：伪装为图片类型或图片后缀的 HLS 清单，仍由正文标记确定真实格式。
  const textPrefix = prefix.toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  if (/^#EXTM3U(?:\r?\n|$)/u.test(textPrefix)) return "hls";
  if (prefix.length >= 8 && prefix.toString("ascii", 4, 8) === "ftyp") return "mp4";

  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(mimeType)
    || /\.m3u8?$/iu.test(finalUrl.pathname)) return "hls";
  if (mimeType === "video/mp4" || /\.mp4$/iu.test(finalUrl.pathname)) return "mp4";
  return fallback;
}
