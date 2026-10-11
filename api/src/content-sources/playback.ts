import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { probeHlsRunTimeTicks } from "./hls-relay.js";
import type { ContentPlaybackSource } from "./types.js";

// 关键变量：失败或直播清单没有准确总时长时，短期内不重复请求相同来源的清单。
const lastDurationProbeAt = new Map<string, number>();
const pendingDurationProbes = new Map<string, Promise<number>>();

/** 在线内容源库使用独立来源定位，不创建假的网盘文件。 */
export function isContentSourceLibrary(libraryKind: unknown): boolean {
  return String(libraryKind) === "content_source_video";
}

/** 按服务端实际探测的完整清单时长读取来源，不使用源站 vod_duration 文本。 */
export function readContentRunTimeTicks(sources: ContentPlaybackSource[], sourceId?: string, itemId?: string): number {
  const selected = sourceId && sourceId !== itemId ? sources.find((source) => source.id === sourceId) : sources[0];
  return selected && Number.isFinite(selected.runTimeTicks) ? Math.max(0, selected.runTimeTicks) : 0;
}

/** 优先排列账号最近成功播放的线路，其余线路保持同步时的稳定顺序。 */
export function prioritizeContentSources(sources: ContentPlaybackSource[], recentSourceId: string): ContentPlaybackSource[] {
  return recentSourceId ? [...sources].sort((left, right) => Number(right.id === recentSourceId) - Number(left.id === recentSourceId)) : sources;
}

/** 请求上下文中的真实协议前缀用于生成 Http Path，避免重复拼接 /jf 或 /e。 */
export function contentPlaybackServerRoot(request: FastifyRequest): string {
  const rawPath = request.url.split("?", 1)[0] ?? "";
  const prefix = rawPath.match(/^\/(?:j|e)\/[^/]+(?:\/emby)?(?=\/|$)/iu)?.[0]
    ?? rawPath.replace(/\/(?:Items|Videos?)\/.*$/iu, "");
  const protocol = String(request.headers["x-forwarded-proto"] ?? request.protocol).split(",", 1)[0]?.trim() || request.protocol;
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",", 1)[0]?.trim();
  if (!host || !["http", "https"].includes(protocol)) return prefix;
  try { return `${new URL(`${protocol}://${host}`).origin}${prefix}`; }
  catch { return prefix; }
}

/** 构造标准 Http MediaSourceInfo，只声明原始 HLS/MP4 直放能力与实际已知规格。 */
export function mapContentMediaSource(
  source: ContentPlaybackSource,
  protocolItemId: string,
  accessToken = "",
  playSessionId = "",
  serverRoot = "",
  route?: "auto" | "origin" | "server",
): Record<string, unknown> {
  const query = new URLSearchParams({ static: "true", MediaSourceId: source.id });
  if (accessToken) query.set("api_key", accessToken);
  if (playSessionId) query.set("PlaySessionId", playSessionId);
  // 显式请求沿用原协议入口的路线参数；默认自动由服务器读取该协议的库配置。
  if (route === "origin" || route === "server") query.set("FlyCloudPlaybackRoute", route);
  const extension = source.container === "hls" ? "m3u8" : "mp4";
  // 关键变量：媒体源 ID 始终使用数据库来源 ID，不随首选线路排序或账号进度变化。
  const directStreamUrl = `/Videos/${encodeURIComponent(protocolItemId)}/stream.${extension}?${query.toString()}`;
  return {
    Protocol: "Http",
    Id: source.id,
    Path: serverRoot ? `${serverRoot}${directStreamUrl}` : directStreamUrl,
    Name: `${source.sourceName} · ${source.lineName} · ${source.name}`,
    Type: "Default",
    Container: source.container,
    MimeType: source.container === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4",
    IsRemote: true,
    RunTimeTicks: source.runTimeTicks > 0 ? source.runTimeTicks : undefined,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    SupportsProbing: false,
    DirectStreamUrl: directStreamUrl,
    AddApiKeyToDirectStreamUrl: false,
    RequiredHttpHeaders: {},
    MediaStreams: [],
    MediaAttachments: [],
    Formats: [],
  };
}

/** 首次 PlaybackInfo 探测准确时长，失败时仍允许客户端自行请求媒体。 */
async function refreshContentDuration(runtime: ApiRuntime, source: ContentPlaybackSource, ownerUserId: string, libraryId: string): Promise<number> {
  if (source.runTimeTicks > 0 || source.container !== "hls") return source.runTimeTicks;
  const pending = pendingDurationProbes.get(source.id);
  if (pending) return pending;
  if (Date.now() - (lastDurationProbeAt.get(source.id) ?? 0) < 5 * 60_000) return 0;
  if (lastDurationProbeAt.size > 5_000) lastDurationProbeAt.clear();
  lastDurationProbeAt.set(source.id, Date.now());
  const probe = (async () => {
    const controller = new AbortController();
    // 取址与清单探测共用二十秒预算，不能把两段超时依次累加。
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const access = await runtime.contentSources.resolvePlayback(source.id, ownerUserId, libraryId, controller.signal);
      const ticks = access.container === "hls" ? await probeHlsRunTimeTicks(runtime, access.url, access.headers, controller.signal) : 0;
      if (ticks > 0) await runtime.contentSources.updatePlaybackDuration(source.id, ownerUserId, ticks);
      return ticks;
    } catch { return 0; }
    finally { clearTimeout(timeout); pendingDurationProbes.delete(source.id); }
  })();
  pendingDurationProbes.set(source.id, probe);
  return probe;
}

/** 在线 PlaybackInfo 的来源选择、最近线路与真实清单时长统一处理。 */
export async function prepareContentPlaybackSources(
  runtime: ApiRuntime,
  itemId: string,
  ownerUserId: string,
  libraryId: string,
  requestedSourceId: string,
  recentSourceId: string,
): Promise<ContentPlaybackSource[]> {
  const sources = prioritizeContentSources(await runtime.contentSources.listPlaybackSources(itemId, ownerUserId), recentSourceId);
  const selected = requestedSourceId && requestedSourceId !== itemId ? sources.filter((source) => source.id === requestedSourceId) : sources;
  if (selected.length === 0) throw new ApiError(404, "content_playback_source_not_found", requestedSourceId ? "指定在线播放来源不存在" : "媒体条目没有可播放的在线来源");
  // 首期每次只探测最终首选线路，其余线路在实际媒体请求时各自累计完整清单时长。
  const primary = selected[0];
  if (primary) primary.runTimeTicks = await refreshContentDuration(runtime, primary, ownerUserId, libraryId);
  return selected;
}
