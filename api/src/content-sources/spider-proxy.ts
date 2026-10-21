import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { ApiError } from "../errors.js";
import type { ProviderStreamResponse } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";

/** 本地代理和真实 HTTP 资源共用流式接口，不把内存正文伪装为网络连接。 */
export type ContentSourceResourceResponse = Omit<ProviderStreamResponse, "body"> & {
  body: Readable & { setTimeout?(milliseconds: number, callback?: () => void): unknown };
};

/** 只识别宿主专用保留域名，不允许相似主机或普通源站触发代理执行。 */
export function isSpiderProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "spider.invalid";
  } catch { return false; }
}

/** 实例标识只用于服务端查归属，不能替代 Jellyfin／Emby 的账号鉴权。 */
export function readSpiderProxyInstance(value: string): string {
  if (!isSpiderProxyUrl(value)) throw new ApiError(422, "content_source_proxy_url_invalid", "内容源代理地址无效");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.port || url.username || url.password || url.pathname !== "/proxy") {
    throw new ApiError(422, "content_source_proxy_url_invalid", "内容源代理地址无效");
  }
  const instances = url.searchParams.getAll("instance");
  if (instances.length !== 1 || !instances[0] || instances[0].length > 160) throw new ApiError(422, "content_source_proxy_url_invalid", "内容源代理缺少有效实例");
  return instances[0];
}

/** 将有界代理结果转为现有媒体响应，保留分片 Range 状态和真实 MIME。 */
export async function openSpiderProxyResource(
  runtime: Pick<ApiRuntime, "contentSources">,
  value: string,
  requestHeaders: Record<string, string>,
  scope: { ownerUserId: string; libraryId: string },
  signal?: AbortSignal,
): Promise<ContentSourceResourceResponse> {
  signal?.throwIfAborted();
  const response = await runtime.contentSources.invokeSourceProxy(value, scope.ownerUserId, scope.libraryId, requestHeaders, signal);
  signal?.throwIfAborted();
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ApiError(502, "content_source_proxy_result_invalid", "内容源代理返回格式无效");
  const result = response as Record<string, unknown>;
  const statusCode = Number(result.statusCode);
  const contentType = String(result.contentType ?? "application/octet-stream");
  const encoded = result.bodyBase64;
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 599 || /[\r\n]/u.test(contentType)
    || typeof encoded !== "string" || encoded.length > 24 * 1024 * 1024
    || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(encoded)
    || (encoded.includes("=") && !/^={1,2}$/u.test(encoded.slice(encoded.indexOf("="))))) {
    throw new ApiError(502, "content_source_proxy_result_invalid", "内容源代理返回格式无效");
  }
  if (statusCode >= 400 && statusCode !== 416) throw new ApiError(502, "content_source_proxy_upstream_failed", `内容源代理读取失败，状态码 ${statusCode}`);
  // 关键变量：localProxy 只用于有界清单、分片与图片，整部视频仍沿用 HTTP 流式读取。
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 16 * 1024 * 1024) throw new ApiError(502, "content_source_proxy_too_large", "内容源代理资源超过大小限制");
  const headers: IncomingHttpHeaders = { "content-type": contentType, "content-length": String(bytes.length) };
  if (result.headers && typeof result.headers === "object" && !Array.isArray(result.headers)) {
    for (const [name, header] of Object.entries(result.headers as Record<string, unknown>)) {
      const lower = name.toLowerCase();
      if (["content-type", "content-range", "accept-ranges", "etag", "last-modified"].includes(lower)
        && typeof header === "string" && !/[\r\n]/u.test(header)) headers[lower] = header;
    }
  }
  const body = Readable.from(bytes.length ? [bytes] : []);
  /** 请求取消时立即丢弃已经取得的代理正文，不保留协议请求引用。 */
  const abort = () => body.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  body.once("close", () => signal?.removeEventListener("abort", abort));
  return { statusCode, headers, body, finalUrl: new URL(value) };
}
