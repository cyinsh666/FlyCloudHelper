import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { providerStream } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";
import { canDirectContentPlayback } from "./direct-playback.js";
import type { ContentSourcePlaybackProtocol } from "./types.js";

/** 已认证的协议账号范围；票据不能跨账号、媒体库或单集使用。 */
export interface ContentRelayContext {
  ownerUserId: string;
  libraryId: string;
  accountId: string;
  accessToken: string;
}

/** 服务端保存的资源定位，客户端只得到随机票据和自己的协议令牌。 */
interface HlsResourceTicket {
  /** 来源协议随子清单票据传递，诊断不能把 Emby 失败记为 Jellyfin。 */
  protocol: ContentSourcePlaybackProtocol;
  ownerUserId: string;
  libraryId: string;
  accountId: string;
  itemId: string;
  sourceId: string;
  url: string;
  headers: Record<string, string>;
  manifest: boolean;
  /** 视频媒体清单可更新时长，音轨和字幕清单不能覆盖影片总时长。 */
  measureDuration: boolean;
  expiresAt: number;
}

// 关键变量：票据只驻留当前进程，六小时内访问续期，重启后重新打开播放即可取新票据。
const resourceTickets = new Map<string, HlsResourceTicket>();
let lastTicketPruneAt = 0;
const TICKET_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const MAX_RESOURCE_TICKETS = 50_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** 清理过期票据，并限制长期播放时内存中的定位条目数量。 */
function pruneResourceTickets(): void {
  const now = Date.now();
  if (now - lastTicketPruneAt >= 60_000) {
    for (const [id, ticket] of resourceTickets) {
      if (ticket.expiresAt <= now) resourceTickets.delete(id);
    }
    lastTicketPruneAt = now;
  }
  while (resourceTickets.size >= MAX_RESOURCE_TICKETS) {
    const first = resourceTickets.keys().next().value as string | undefined;
    if (!first) break;
    resourceTickets.delete(first);
  }
}

/** 为清单引用分配不可反解的票据，不向客户端传递源站 URL 或请求头。 */
function issueResourceTicket(ticket: Omit<HlsResourceTicket, "expiresAt">): string {
  pruneResourceTickets();
  const id = randomBytes(24).toString("base64url");
  resourceTickets.set(id, { ...ticket, expiresAt: Date.now() + TICKET_LIFETIME_MS });
  return id;
}

/** 将完整媒体清单的 EXTINF 累计秒数转换为标准 100ns ticks。 */
export function readHlsRunTimeTicks(manifest: string): number {
  if (!/^#EXTM3U(?:\r?\n|$)/u.test(manifest.trimStart()) || !/^#EXT-X-ENDLIST\s*$/mu.test(manifest)) return 0;
  const durations = [...manifest.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)[^\r\n]*$/gmu)];
  if (durations.length === 0) return 0;
  const seconds = durations.reduce((total, match) => total + Number(match[1]), 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10_000_000) : 0;
}

/** 有界读取清单正文，不将影片分片或完整视频缓存进内存。 */
async function readManifestBody(body: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MANIFEST_BYTES) {
      body.destroy();
      throw new ApiError(502, "content_manifest_too_large", "内容源播放清单过大");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, "");
}

/** 检查清单引用使用 HTTP(S)，并按最终重定向地址解析相对路径。 */
function resolveManifestUri(uri: string, finalUrl: URL): string {
  let url: URL;
  try { url = new URL(uri, finalUrl); }
  catch { throw new ApiError(502, "content_manifest_uri_invalid", "内容源播放清单包含无效地址"); }
  if (!/^https?:$/u.test(url.protocol)) throw new ApiError(502, "content_manifest_protocol_unsupported", "内容源播放清单包含不支持的资源协议");
  return url.href;
}

/** 同源子资源保留源请求头，跨域资源移除账号与 Cookie 等敏感认证头。 */
function childResourceHeaders(headers: Record<string, string>, parent: URL, child: URL): Record<string, string> {
  if (parent.origin === child.origin) return { ...headers };
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !["authorization", "proxy-authorization", "cookie"].includes(key.toLowerCase())));
}

/** 根据当前协议路由生成完整的服务内资源路径，兼容 /jf、/e 及 /emby alias。 */
function resourceBasePath(request: FastifyRequest, protocolItemId: string): string {
  const path = request.url.split("?", 1)[0] ?? "";
  const prefix = path.replace(/\/Videos?\/[^/]+\/.*$/iu, "");
  return `${prefix}/Videos/${encodeURIComponent(protocolItemId)}/content/`;
}

/** 改写主清单、媒体清单及 KEY/MAP/MEDIA 等 URI 属性，保持分片顺序与字节范围。 */
function rewriteManifest(
  manifest: string,
  finalUrl: URL,
  context: ContentRelayContext,
  ticket: Omit<HlsResourceTicket, "expiresAt">,
  basePath: string,
): string {
  if (!/^#EXTM3U(?:\r?\n|$)/u.test(manifest.trimStart())) throw new ApiError(502, "content_manifest_invalid", "内容源未返回有效 HLS 播放清单");
  let nextLineIsManifest = false;
  return manifest.split(/\r?\n/u).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    /** 保留合法内联 data URI；所有网络资源均替换为当前账号可访问的服务内票据。 */
    const rewriteUri = (uri: string, isManifest: boolean, measureDuration: boolean): string => {
      if (uri.startsWith("data:")) return uri;
      const resolved = new URL(resolveManifestUri(uri, finalUrl));
      const id = issueResourceTicket({
        ...ticket,
        url: resolved.href,
        headers: childResourceHeaders(ticket.headers, finalUrl, resolved),
        manifest: isManifest || /\.m3u8$/iu.test(resolved.pathname),
        measureDuration,
      });
      return `${basePath}${id}?${new URLSearchParams({ api_key: context.accessToken }).toString()}`;
    };
    if (!trimmed.startsWith("#")) {
      const rewritten = rewriteUri(trimmed, nextLineIsManifest, ticket.measureDuration);
      nextLineIsManifest = false;
      return rewritten;
    }
    const isTrackManifest = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/u.test(trimmed);
    const rewritten = line.replace(/\bURI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gu, (_match, quoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const uri = quoted ?? singleQuoted ?? plain ?? "";
      return `URI="${rewriteUri(uri, isTrackManifest, false)}"`;
    });
    if (/^#EXT-X-STREAM-INF:/u.test(trimmed)) nextLineIsManifest = true;
    return rewritten;
  }).join("\n");
}

/** 构造上游请求头，只转发媒体字节相关字段，不转发协议账号令牌。 */
function buildContentUpstreamHeaders(request: FastifyRequest, sourceHeaders: Record<string, string>, manifest: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...sourceHeaders, Accept: "*/*", "Accept-Encoding": "identity" };
  if (!manifest) {
    for (const [incoming, outgoing] of [["range", "Range"], ["if-range", "If-Range"]] as const) {
      const value = request.headers[incoming];
      if (typeof value === "string") headers[outgoing] = value;
    }
  }
  return headers;
}

/** 发送清单或流式媒体资源；客户端断开和单资源超时都会取消上游请求。 */
async function sendResource(
  runtime: ApiRuntime,
  context: ContentRelayContext,
  request: FastifyRequest,
  reply: FastifyReply,
  protocolItemId: string,
  ticket: Omit<HlsResourceTicket, "expiresAt">,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, ticket.manifest ? 30_000 : 120_000);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  let body: IncomingMessage | undefined;
  /** 请求结束后释放计时器与客户端监听，不保留请求对象。 */
  const cleanup = () => {
    clearTimeout(timeout);
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  };
  try {
    const upstream = await providerStream(ticket.url, {
      // 清单 HEAD 仍先获取并改写正文，使返回的长度与实际 GET 一致。
      method: ticket.manifest ? "GET" : request.method,
      headers: buildContentUpstreamHeaders(request, ticket.headers, ticket.manifest),
    }, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp }, controller.signal);
    body = upstream.body;
    const rawContentType = String(upstream.headers["content-type"] ?? "");
    const isManifest = ticket.manifest || /mpegurl/iu.test(rawContentType) || /\.m3u8$/iu.test(upstream.finalUrl.pathname);
    if (!isManifest) {
      // MP4 可能持续数小时；只限制空闲等待，不能按总播放时间截断整条字节流。
      clearTimeout(timeout);
      body.setTimeout(120_000, abort);
    }
    reply.header("Cache-Control", "private, no-store").header("X-Accel-Buffering", "no");
    if (isManifest && upstream.statusCode !== 416) {
      const manifest = await readManifestBody(body);
      if (ticket.measureDuration) {
        const ticks = readHlsRunTimeTicks(manifest);
        if (ticks > 0) await runtime.contentSources.updatePlaybackDuration(ticket.sourceId, context.ownerUserId, ticks);
      }
      // 初始取址跨域重定向后不能把原域 Cookie 再加回后续子资源。
      const finalTicket = { ...ticket, headers: childResourceHeaders(ticket.headers, new URL(ticket.url), upstream.finalUrl) };
      const rewritten = Buffer.from(rewriteManifest(manifest, upstream.finalUrl, context, finalTicket, resourceBasePath(request, protocolItemId)));
      cleanup();
      reply.status(200).type("application/vnd.apple.mpegurl").header("Content-Length", rewritten.length);
      return request.method === "HEAD" ? reply.send() : reply.send(rewritten);
    }
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const value = upstream.headers[name];
      if (value !== undefined) reply.header(name, value);
    }
    reply.status(upstream.statusCode);
    if (request.method === "HEAD") {
      body.destroy();
      cleanup();
      return reply.send();
    }
    body.once("end", cleanup);
    body.once("close", cleanup);
    body.once("error", cleanup);
    return reply.send(body);
  } catch (error) {
    body?.destroy();
    cleanup();
    // 临时播放诊断：只提取固定错误码和状态码，不能记录播放地址、请求头或原始错误正文。
    const upstreamErrorCode = error instanceof ApiError ? error.code : "unknown";
    const knownUpstreamStatuses: Record<string, number> = {
      provider_authentication_failed: 401, provider_permission_denied: 403, provider_resource_not_found: 404,
    };
    const upstreamStatus = knownUpstreamStatuses[upstreamErrorCode]
      ?? (error instanceof ApiError && upstreamErrorCode === "provider_stream_request_failed"
        ? Number(error.message.match(/状态码\s+(\d{3})/u)?.[1] ?? 0) || null : null);
    if (!request.raw.aborted && !reply.raw.destroyed) await runtime.contentSourceDiagnostics.recordPlaybackFailure({
      libraryId: context.libraryId, ownerUserId: context.ownerUserId, itemId: ticket.itemId, sourceId: ticket.sourceId,
      protocol: ticket.protocol, stage: "relay", error,
    });
    runtime.logBusinessEvent("warn", {
      日志关键字: "codex-content-source-playback", 事件: "内容源中转资源读取失败",
      媒体库ID: context.libraryId, 媒体条目ID: ticket.itemId, 播放来源ID: ticket.sourceId,
      是否播放清单: ticket.manifest, 请求方法: request.method,
      底层错误码: upstreamErrorCode, 上游HTTP状态码: upstreamStatus, 是否已取消: controller.signal.aborted,
    });
    if (error instanceof ApiError && error.code.startsWith("content_")) throw error;
    throw new ApiError(502, "content_media_upstream_failed", "内容源媒体暂时无法读取，请稍后重新打开播放");
  }
}

/** 即时解析指定来源，按协议播放模式跳转直连或中转原始 HLS、MP4。 */
export async function sendContentPlayback(
  runtime: ApiRuntime,
  context: ContentRelayContext,
  request: FastifyRequest,
  reply: FastifyReply,
  itemId: string,
  protocolItemId: string,
  sourceId: string,
  options: { protocol: ContentSourcePlaybackProtocol; route?: "auto" | "origin" | "server" },
) {
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId) throw new ApiError(404, "content_item_not_found", "媒体条目不存在");
  const sources = await runtime.contentSources.listPlaybackSources(itemId, context.ownerUserId);
  const source = sourceId && sourceId !== itemId ? sources.find((candidate) => candidate.id === sourceId) : sources[0];
  if (!source) throw new ApiError(404, "content_playback_source_not_found", "指定在线播放来源不存在");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 30_000);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted) abort();
  let resolving = true; // 关键变量：即时取址失败与中转资源失败分别记录，不把中转错误重复记成取址失败。
  try {
    const resolved = await runtime.contentSources.resolvePlayback(source.id, context.ownerUserId, context.libraryId, controller.signal);
    resolving = false;
    if (controller.signal.aborted) throw new ApiError(504, "content_playback_resolve_cancelled", "在线播放取址已取消或超时");
    const configuredMode = await runtime.contentSources.getLibraryPlaybackMode(context.libraryId, context.ownerUserId, options.protocol);
    controller.signal.throwIfAborted();
    // 关键变量：显式路线优先；普通客户端无须传参数，auto 使用所选协议独立保存的模式。
    const mode = options.route === "origin" ? "direct" : options.route === "server" ? "relay" : configuredMode;
    if (mode === "direct") {
      // 显式直连由实际播放器尝试；访问云助手的 UA 和跳转后的媒体 UA 可能不同，不能用前者探测拦截。
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(resolved.url, 307);
    }
    if (mode === "auto") {
      const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
      const directAvailable = await canDirectContentPlayback(runtime, resolved.url, resolved.container, userAgent, controller.signal);
      controller.signal.throwIfAborted();
      if (directAvailable) {
        // 保留 HTTP GET/HEAD 与 Range，Location 只有源地址，不附加云助手的协议令牌。
        reply.header("Cache-Control", "private, no-store");
        return reply.redirect(resolved.url, 307);
      }
    }
    controller.signal.throwIfAborted();
    return sendResource(runtime, context, request, reply, protocolItemId, {
      protocol: options.protocol,
      ownerUserId: context.ownerUserId, libraryId: context.libraryId, accountId: context.accountId,
      itemId, sourceId: source.id, url: resolved.url, headers: resolved.headers,
      manifest: resolved.container === "hls", measureDuration: true,
    });
  } catch (error) {
    if (resolving && !request.raw.aborted && !reply.raw.destroyed) await runtime.contentSourceDiagnostics.recordPlaybackFailure({
      libraryId: context.libraryId, ownerUserId: context.ownerUserId, itemId, sourceId: source.id,
      protocol: options.protocol, stage: "resolve", error,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}

/** 每个 HLS 子资源独立鉴权并校验条目与来源，不把票据作为协议登录凭据。 */
export async function sendContentResource(
  runtime: ApiRuntime,
  context: ContentRelayContext,
  request: FastifyRequest,
  reply: FastifyReply,
  itemId: string,
  protocolItemId: string,
  ticketId: string,
) {
  const ticket = resourceTickets.get(ticketId);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    resourceTickets.delete(ticketId);
    throw new ApiError(410, "content_resource_expired", "播放资源已过期，请重新打开播放");
  }
  if (ticket.ownerUserId !== context.ownerUserId || ticket.libraryId !== context.libraryId || ticket.accountId !== context.accountId || ticket.itemId !== itemId) {
    throw new ApiError(404, "content_resource_not_found", "播放资源不存在");
  }
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  const sources = await runtime.contentSources.listPlaybackSources(itemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId || !sources.some((source) => source.id === ticket.sourceId)) throw new ApiError(404, "content_resource_not_found", "播放来源已停用或不存在");
  ticket.expiresAt = Date.now() + TICKET_LIFETIME_MS;
  return sendResource(runtime, context, request, reply, protocolItemId, ticket);
}

/** 只探测清单并累计首个完整视频变体时长，不请求任何视频分片。 */
export async function probeHlsRunTimeTicks(runtime: ApiRuntime, url: string, headers: Record<string, string>, parentSignal?: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const abortParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  if (parentSignal?.aborted) abortParent();
  let currentUrl = url;
  let currentHeaders = headers;
  try {
    for (let depth = 0; depth < 4; depth += 1) {
      const upstream = await providerStream(currentUrl, { method: "GET", headers: { ...currentHeaders, Accept: "*/*", "Accept-Encoding": "identity" } }, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp }, controller.signal);
      const manifest = await readManifestBody(upstream.body);
      if (!/^#EXTM3U(?:\r?\n|$)/u.test(manifest.trimStart())) return 0;
      const ticks = readHlsRunTimeTicks(manifest);
      if (ticks > 0) return ticks;
      const lines = manifest.split(/\r?\n/u);
      const variantIndex = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF:"));
      if (variantIndex < 0) return 0;
      const variant = lines.slice(variantIndex + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
      if (!variant) return 0;
      const childUrl = new URL(resolveManifestUri(variant.trim(), upstream.finalUrl));
      const finalHeaders = childResourceHeaders(currentHeaders, new URL(currentUrl), upstream.finalUrl);
      currentHeaders = childResourceHeaders(finalHeaders, upstream.finalUrl, childUrl);
      currentUrl = childUrl.href;
    }
    return 0;
  } finally { clearTimeout(timeout); parentSignal?.removeEventListener("abort", abortParent); }
}
