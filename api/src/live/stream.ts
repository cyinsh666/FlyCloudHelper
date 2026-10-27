import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { LiveChannel } from "./types.js";

/** 资源签名绑定当前媒体库及目标地址，防止修改地址成为任意代理。 */
export function liveSignature(runtime: ApiRuntime, value: string): string {
  return createHmac("sha256", runtime.config.credentialMasterKey).update(`flycloud-live:v1:${value}`).digest("base64url");
}

/** 使用固定长度比较，公开链接不包含明文账号密码。 */
export function validLiveSignature(runtime: ApiRuntime, value: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) return false;
  const expected = Buffer.from(liveSignature(runtime, value));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 行属性只允许单行展示文本，不能插入其他频道或额外播放地址。 */
function attribute(value: string): string { return value.replace(/[\r\n"<>]/gu, " "); }

/** 导出稳定频道入口；需设备签名的频道即使库默认直连，也明确固定为中转。 */
export function buildLiveM3u(channels: LiveChannel[], base: string, auth: URLSearchParams, mode: "direct" | "relay", epg: string): string {
  const lines = [`#EXTM3U${epg ? ` url-tvg="${attribute(epg)}"` : ""}`];
  for (const channel of channels) {
    const actualMode = channel.requiresRelay ? "relay" : mode;
    let properties = `tvg-id="${attribute(channel.tvgId)}" tvg-name="${attribute(channel.name)}" tvg-logo="${attribute(channel.logo)}" group-title="${attribute(channel.group)}"`;
    if (channel.catchup) properties += ' catchup="append" catchup-days="7" catchup-source="&playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}"';
    lines.push(`#EXTINF:-1 ${properties},${attribute(channel.name)}`);
    const query = new URLSearchParams(auth); query.set("mode", actualMode);
    lines.push(`${base}/channels/${encodeURIComponent(channel.id)}.m3u8?${query}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 资源只能使用服务端从播放清单签发的地址，不能把公开出口当成任意 URL 代理。 */
export function liveResourceUrl(runtime: ApiRuntime, base: string, auth: URLSearchParams, libraryScope: string, target: string, playlist: boolean, mode: "direct" | "relay"): string {
  const encoded = Buffer.from(target).toString("base64url");
  const query = new URLSearchParams(auth);
  query.set("target", encoded); query.set("playlist", playlist ? "1" : "0"); query.set("mode", mode);
  query.set("signature", liveSignature(runtime, `${libraryScope}:resource:${encoded}:${playlist ? "1" : "0"}:${mode}`));
  return `${base}/resource?${query}`;
}

/** 分片允许访问真实源站或当前回环引擎；禁止把过期端口转发给其他本机服务。 */
function targetUrl(value: string, origin: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "live_url_invalid", "直播资源地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ApiError(400, "live_url_invalid", "直播资源地址无效");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.origin !== origin)
    throw new ApiError(409, "live_runtime_changed", "直播服务已重新启动，请重新播放频道");
  return url;
}

/** 有界读取播放清单，视频分片仍直接流式转发。 */
async function playlistText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 2 * 1024 * 1024) throw new ApiError(502, "live_playlist_too_large", "直播播放清单过大");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); }
}

/** 重写子清单、密钥、初始化段和视频分片；直连模式保留远端资源，不伪装成直连。 */
function rewritePlaylist(text: string, source: URL, origin: string, mode: "direct" | "relay", resource: (url: string, playlist: boolean) => string): string {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new ApiError(502, "live_playlist_invalid", "直播源未返回有效的 HLS 清单");
  let childPlaylist = false;
  /** 所有 URI 都先相对实际清单地址解析，防止外网客户端收到回环地址。 */
  const rewrite = (value: string, playlist: boolean): string => {
    const target = targetUrl(new URL(value, source).href, origin);
    if (mode === "direct") {
      if (target.origin === origin) throw new ApiError(409, "live_relay_required", "此频道需要签名或引擎转发，请改用中转播放");
      // 子清单仍通过稳定入口刷新，只有视频分片、密钥及初始化资源直连源站。
      return playlist || /\.m3u8$/iu.test(target.pathname) ? resource(target.href, true) : target.href;
    }
    return resource(target.href, playlist || /\.m3u8$/iu.test(target.pathname));
  };
  return text.split(/\r?\n/u).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      const result = line.replace(/URI="([^"]+)"/gu, (_, uri: string) => `URI="${rewrite(uri, /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/u.test(trimmed))}"`);
      if (trimmed.startsWith("#EXT-X-STREAM-INF:")) childPlaylist = true;
      return result;
    }
    const result = rewrite(trimmed, childPlaylist);
    childPlaylist = false;
    return result;
  }).join("\n");
}

/** 从私有网关或源站读取资源，Range/HEAD 透传，取消播放同时取消上游请求。 */
export async function sendLiveResource(runtime: ApiRuntime, request: FastifyRequest, reply: FastifyReply, options: {
  origin: string; target: string; playlist: boolean; mode: "direct" | "relay"; resource: (url: string, playlist: boolean) => string;
}): Promise<unknown> {
  const target = targetUrl(options.target, options.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  /** 客户端退出时不继续下载或占用分片连接。 */
  const cancel = (): void => { controller.abort(); clearTimeout(timer); };
  reply.raw.once("close", cancel);
  const headers: Record<string, string> = { "Accept-Encoding": "identity", ...(target.origin === options.origin ? {} : { "User-Agent": "qqlive", Referer: "https://live.cctv.cn/" }) };
  if (request.headers.range && !options.playlist) headers.Range = request.headers.range;
  let response: Response;
  try {
    response = await fetch(target, { method: request.method === "HEAD" && !options.playlist ? "HEAD" : "GET", headers,
      signal: controller.signal, redirect: "follow" });
  } catch {
    clearTimeout(timer); reply.raw.off("close", cancel);
    throw new ApiError(502, "live_upstream_unavailable", "直播源连接失败，请稍后重试或切换播放方式");
  }
  if (!response.ok && response.status !== 416) {
    clearTimeout(timer); await response.body?.cancel(); reply.raw.off("close", cancel);
    throw new ApiError(502, "live_upstream_failed", `直播源返回 HTTP ${response.status}，请稍后重试`);
  }
  reply.header("Cache-Control", "private, no-store");
  const isPlaylist = options.playlist || /mpegurl/iu.test(response.headers.get("content-type") ?? "");
  if (isPlaylist) {
    try {
      const text = await playlistText(response);
      const source = new URL(response.url || target.href);
      return reply.type("application/vnd.apple.mpegurl").send(rewritePlaylist(text, source, options.origin, options.mode, options.resource));
    } finally { clearTimeout(timer); reply.raw.off("close", cancel); }
  }
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = response.headers.get(name); if (value) reply.header(name, value);
  }
  reply.code(response.status);
  if (request.method === "HEAD" || !response.body) { clearTimeout(timer); await response.body?.cancel(); reply.raw.off("close", cancel); return reply.send(); }
  reply.raw.once("finish", () => { clearTimeout(timer); reply.raw.off("close", cancel); });
  return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
}
