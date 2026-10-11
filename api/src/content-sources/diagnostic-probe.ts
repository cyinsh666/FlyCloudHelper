import type { IncomingMessage } from "node:http";
import { ApiError } from "../errors.js";
import { providerProbeStream } from "../providers/network.js";
import { readHlsRunTimeTicks } from "./hls-relay.js";

/** 将业务错误转换为诊断摘要，不返回源地址、签名参数或请求头。 */
export function summarizeContentError(error: unknown): { message: string; upstreamStatus: number | null } {
  const code = error instanceof ApiError ? error.code : "";
  const knownStatuses: Record<string, number> = {
    provider_authentication_failed: 401, provider_permission_denied: 403,
    provider_rate_limited: 429,
    provider_resource_not_found: 404, content_diagnostic_unauthorized: 401,
    content_diagnostic_forbidden: 403, content_diagnostic_missing: 404,
  };
  const status = knownStatuses[code] ?? (error instanceof ApiError && /(?:http_failed|request_failed|diagnostic_http)$/u.test(code)
    ? Number(error.message.match(/(?:HTTP|状态码)\s+(\d{3})/u)?.[1] ?? 0) || null : null);
  if (status) return { message: `源站返回 HTTP ${status}`, upstreamStatus: status };
  if (code.includes("disabled")) return { message: "媒体库、源配置或插件已停用", upstreamStatus: null };
  if (code.includes("categories_missing")) return { message: "源站未返回有效的分类目录", upstreamStatus: null };
  if (code.includes("missing") || code.includes("not_found")) return { message: "播放内容或线路已不存在，请刷新已入库内容", upstreamStatus: null };
  if (code.includes("container_changed")) return { message: "播放格式已变化，请刷新已入库内容", upstreamStatus: null };
  if (code.includes("manifest") || code.includes("json")) return { message: "源站未返回有效的目录或播放清单", upstreamStatus: null };
  if (code.includes("timeout") || code.includes("cancel") || (error instanceof Error && /Abort|Timeout/u.test(error.name))) return { message: "请求超时或已取消", upstreamStatus: null };
  return { message: "源站或播放资源暂时无法读取", upstreamStatus: null };
}

/** 读取完整清单或少量资源前缀；上游忽略 Range 时也及时关闭连接。 */
async function readProbeBody(body: IncomingMessage, maximumBytes: number, complete: boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0; // 关键变量：清单有上限，视频资源最多保留 4 KB。
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (complete && receivedBytes + buffer.length > maximumBytes) throw new ApiError(502, "content_diagnostic_manifest_large", "播放清单超过诊断范围");
      const selected = buffer.subarray(0, maximumBytes - receivedBytes);
      chunks.push(selected);
      receivedBytes += selected.length;
      if (!complete && receivedBytes > 0) break;
    }
    return Buffer.concat(chunks);
  } finally {
    body.destroy();
  }
}

/** 在诊断内保留原始 HTTP 状态，避免把源站 403 显示成云助手 502。 */
function requireProbeStatus(status: number): void {
  if (status === 200 || status === 206) return;
  throw new ApiError(502, "content_diagnostic_http", `源站返回 HTTP ${status}`);
}

/** 确认视频、分片或密钥返回了实际字节，拒绝 HTML/JSON 错误页。 */
async function probeResource(url: string, headers: Record<string, string>, allowInsecureHttp: boolean, signal: AbortSignal): Promise<void> {
  const response = await providerProbeStream(url, { method: "GET", headers: { ...headers, Range: "bytes=0-4095" } }, { allowInsecureHttp }, signal);
  try {
    requireProbeStatus(response.statusCode);
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    const bytes = await readProbeBody(response.body, 4096, false);
    if (!bytes.length || type.includes("text/html") || type.includes("application/json") || /^<(?:!doctype|html|head|body)\b/iu.test(bytes.subarray(0, 80).toString("utf8").trimStart())) {
      throw new ApiError(502, "content_diagnostic_manifest_invalid", "源站未返回有效媒体资源");
    }
  } finally {
    response.body.destroy();
  }
}

/** 只检查一个视频变体及首尾分片、必要 KEY/MAP；不下载完整影片。 */
export async function probeContentLine(input: {
  url: string; headers: Record<string, string>; container: "hls" | "mp4";
  allowInsecureHttp: boolean; signal: AbortSignal;
}): Promise<number> {
  const headers = { ...input.headers, Accept: "*/*", "Accept-Encoding": "identity" };
  if (input.container === "mp4") {
    await probeResource(input.url, headers, input.allowInsecureHttp, input.signal);
    return 0;
  }
  let manifestUrl = input.url;
  for (let depth = 0; depth < 4; depth += 1) {
    input.signal.throwIfAborted();
    const response = await providerProbeStream(manifestUrl, { method: "GET", headers }, { allowInsecureHttp: input.allowInsecureHttp }, input.signal);
    let manifest: string;
    try {
      requireProbeStatus(response.statusCode);
      manifest = (await readProbeBody(response.body, 2 * 1024 * 1024, true)).toString("utf8");
    } finally {
      response.body.destroy();
    }
    if (!/^#EXTM3U(?:\r?\n|$)/u.test(manifest.trimStart())) throw new ApiError(502, "content_diagnostic_manifest_invalid", "源站未返回有效 HLS 播放清单");
    const lines = manifest.split(/\r?\n/u).map((line) => line.trim());
    const variantIndex = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF:"));
    if (variantIndex >= 0) {
      const variant = lines.slice(variantIndex + 1).find((line) => line && !line.startsWith("#"));
      if (!variant) throw new ApiError(502, "content_diagnostic_manifest_invalid", "视频变体清单不存在");
      manifestUrl = new URL(variant, response.finalUrl).href;
      continue;
    }
    const segments = lines.filter((line) => line && !line.startsWith("#"));
    if (!segments.length) throw new ApiError(502, "content_diagnostic_manifest_invalid", "播放清单没有分片");
    // 关键变量：只抽取一个变体首尾分片和最多两个必要资源，成功不代表整片全部资源可用。
    const references = new Set<string>([segments[0]!, segments[segments.length - 1]!]);
    for (const line of lines.filter((line) => /^#EXT-X-(?:KEY|MAP):/u.test(line)).slice(0, 2)) {
      const uri = line.match(/\bURI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/u);
      const reference = uri?.[1] ?? uri?.[2] ?? uri?.[3];
      if (reference && !reference.startsWith("data:")) references.add(reference);
    }
    for (const reference of references) {
      await probeResource(new URL(reference, response.finalUrl).href, headers, input.allowInsecureHttp, input.signal);
    }
    return readHlsRunTimeTicks(manifest);
  }
  throw new ApiError(502, "content_diagnostic_manifest_invalid", "播放清单嵌套超过诊断范围");
}
