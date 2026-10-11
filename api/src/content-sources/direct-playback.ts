import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ApiError } from "../errors.js";
import { providerProbeStream } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";

/** 直连判断只保存是否可用，不缓存或对外输出源站临时地址。 */
interface DirectProbeCacheEntry {
  available: boolean;
  expiresAt: number;
}

const directProbeCache = new Map<string, DirectProbeCacheEntry>();
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFESTS = 8;
const MAX_RESOURCE_PROBES = 16;

/** 在读取清单或少量媒体前缀后关闭连接，不下载完整视频。 */
async function readProbeBody(body: IncomingMessage, maximumBytes: number, complete: boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (complete && bytes + buffer.length > maximumBytes) throw new ApiError(502, "content_direct_manifest_too_large", "直连播放清单超过探测范围");
      const selected = buffer.subarray(0, maximumBytes - bytes);
      chunks.push(selected);
      bytes += selected.length;
      if (!complete && bytes > 0) break;
    }
    return Buffer.concat(chunks);
  } finally {
    body.destroy();
  }
}

/** 只使用播放器本次 UA 和普通媒体请求头，不携带源配置或协议账号凭据。 */
function directRequestHeaders(userAgent: string): Record<string, string> {
  return { Accept: "*/*", "Accept-Encoding": "identity", ...(userAgent ? { "User-Agent": userAgent } : {}) };
}

/** 确认媒体资源有实际字节，拒绝 HTML/JSON 错误页；Range 被忽略时仍只读少量前缀。 */
async function probeResource(runtime: ApiRuntime, url: string, userAgent: string, signal: AbortSignal): Promise<boolean> {
  const response = await providerProbeStream(url, { method: "GET", headers: { ...directRequestHeaders(userAgent), Range: "bytes=0-4095" } }, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp }, signal);
  try {
    if (response.statusCode !== 200 && response.statusCode !== 206) return false;
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("application/json")) return false;
    const prefix = await readProbeBody(response.body, 4096, false);
    if (prefix.length === 0) return false;
    const textPrefix = prefix.subarray(0, 80).toString("utf8").trimStart();
    return !/^<(?:!doctype\s+html|html|head|body)\b/iu.test(textPrefix);
  } finally {
    response.body.destroy();
  }
}

/** 将 HLS 网络引用相对最终响应地址展开，非法或未展开变量不能直接交给客户端。 */
function resolveHlsReference(uri: string, parent: URL): string | null {
  if (uri.startsWith("data:")) return null;
  if (uri.includes("{$")) throw new ApiError(409, "content_direct_hls_variable", "此播放清单不能可靠直连");
  const url = new URL(uri, parent);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ApiError(409, "content_direct_resource_invalid", "此播放资源不能可靠直连");
  return url.href;
}

/** 检查主清单、变体、音轨和字幕清单，以及关键资源和分片样本的无专用请求头访问。 */
async function probeHls(runtime: ApiRuntime, url: string, userAgent: string, signal: AbortSignal): Promise<boolean> {
  const pending = [{ url, depth: 0 }];
  const seenManifests = new Set<string>();
  const resources = new Set<string>();
  let hasVideoSegments = false;
  while (pending.length > 0) {
    const entry = pending.shift()!;
    if (seenManifests.has(entry.url)) continue;
    if (entry.depth >= 4 || seenManifests.size >= MAX_MANIFESTS) return false;
    seenManifests.add(entry.url);
    const response = await providerProbeStream(entry.url, { method: "GET", headers: directRequestHeaders(userAgent) }, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp }, signal);
    let manifest: string;
    try {
      if (response.statusCode !== 200) return false;
      manifest = (await readProbeBody(response.body, MAX_MANIFEST_BYTES, true)).toString("utf8").replace(/^\uFEFF/u, "");
    } finally {
      response.body.destroy();
    }
    if (!/^#EXTM3U(?:\r?\n|$)/u.test(manifest.trimStart())) return false;
    const segments: string[] = [];
    let nextLineIsManifest = false;
    for (const line of manifest.split(/\r?\n/u)) {
      const text = line.trim();
      if (!text) continue;
      if (!text.startsWith("#")) {
        const reference = resolveHlsReference(text, response.finalUrl);
        if (!reference) return false;
        if (nextLineIsManifest || /\.m3u8$/iu.test(new URL(reference).pathname)) pending.push({ url: reference, depth: entry.depth + 1 });
        else segments.push(reference);
        nextLineIsManifest = false;
        continue;
      }
      const trackManifest = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/u.test(text);
      for (const match of text.matchAll(/\bURI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gu)) {
        const reference = resolveHlsReference(match[1] ?? match[2] ?? match[3] ?? "", response.finalUrl);
        if (!reference) continue;
        if (trackManifest || /\.m3u8$/iu.test(new URL(reference).pathname)) pending.push({ url: reference, depth: entry.depth + 1 });
        else resources.add(reference);
      }
      if (/^#EXT-X-STREAM-INF:/u.test(text)) nextLineIsManifest = true;
    }
    if (segments.length > 0) {
      hasVideoSegments = true;
      // 关键变量：检查首尾及每个资源域名的样本，不因一部影片包含数千分片逐条下载。
      resources.add(segments[0]!);
      resources.add(segments[segments.length - 1]!);
      const seenOrigins = new Set<string>();
      for (const segment of segments) {
        const origin = new URL(segment).origin;
        if (!seenOrigins.has(origin)) resources.add(segment);
        seenOrigins.add(origin);
      }
    }
    if (resources.size > MAX_RESOURCE_PROBES) return false;
  }
  if (!hasVideoSegments) return false;
  for (const resource of resources) {
    if (!await probeResource(runtime, resource, userAgent, signal)) return false;
  }
  return true;
}

/** 实际播放时有界探测，自动模式失败后仍保留父请求以便继续中转。 */
export async function canDirectContentPlayback(runtime: ApiRuntime, url: string, container: "hls" | "mp4", userAgent: string, parentSignal: AbortSignal): Promise<boolean> {
  parentSignal.throwIfAborted();
  // 关键变量：地址或播放器 UA 改变必须重新判断，不记录完整临时地址，也不跨客户端复用 UA 结果。
  const key = createHash("sha256").update(JSON.stringify([url, container, userAgent])).digest("hex");
  const cached = directProbeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.available;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const abortParent = () => controller.abort();
  parentSignal.addEventListener("abort", abortParent, { once: true });
  // DNS 等待不一定响应 AbortSignal，以取消结果竞速保证及时回退，剩余请求仍会在网络层取消。
  let finishInterruptedProbe: () => void = () => {};
  const interruptedProbe = new Promise<boolean>((resolve) => {
    finishInterruptedProbe = () => resolve(false);
    controller.signal.addEventListener("abort", finishInterruptedProbe, { once: true });
  });
  let available = false;
  try {
    const probe = container === "hls" ? probeHls(runtime, url, userAgent, controller.signal) : probeResource(runtime, url, userAgent, controller.signal);
    available = await Promise.race([probe, interruptedProbe]);
    parentSignal.throwIfAborted();
  } catch {
    parentSignal.throwIfAborted();
    // 清单或资源不能无专用头读取时交由自动模式中转；显式直连不使用此探测。
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortParent);
    controller.signal.removeEventListener("abort", finishInterruptedProbe);
  }
  if (directProbeCache.size >= 1000) directProbeCache.delete(directProbeCache.keys().next().value!);
  directProbeCache.set(key, { available, expiresAt: Date.now() + (available ? 60_000 : 10_000) });
  return available;
}
