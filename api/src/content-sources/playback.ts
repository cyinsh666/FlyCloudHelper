import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { probeContentMediaInfo } from "./hls-relay.js";
import type { ContentPlaybackSource, ContentVideoContainer } from "./types.js";

/** 同一次取址同时返回实际格式和时长，不缓存源站临时地址。 */
interface ContentPlaybackProbeResult {
  container: ContentVideoContainer;
  runTimeTicks: number;
}

// 关键变量：失败或直播清单没有准确总时长时，短期内不重复请求相同来源的清单。
const lastDurationProbeAt = new Map<string, number>();
const pendingDurationProbes = new Map<string, Promise<ContentPlaybackProbeResult>>();

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

/** 构造标准 Http MediaSourceInfo；格式未知时使用无后缀入口，不虚构容器和 MIME。 */
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
  const extension = source.container === "hls" ? ".m3u8" : source.container === "mp4" ? ".mp4" : "";
  // 关键变量：媒体源 ID 始终使用数据库来源 ID，不随首选线路排序或账号进度变化。
  const directStreamUrl = `/Videos/${encodeURIComponent(protocolItemId)}/stream${extension}?${query.toString()}`;
  return {
    Protocol: "Http",
    Id: source.id,
    Path: serverRoot ? `${serverRoot}${directStreamUrl}` : directStreamUrl,
    Name: `${source.sourceName} · ${source.lineName} · ${source.name}`,
    Type: "Default",
    Container: source.container === "unknown" ? undefined : source.container,
    MimeType: source.container === "hls" ? "application/vnd.apple.mpegurl" : source.container === "mp4" ? "video/mp4" : undefined,
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

/** 未知来源先即时取址确定格式，HLS 复用同次结果探测时长；失败仍保留可请求入口。 */
async function refreshContentDuration(runtime: ApiRuntime, source: ContentPlaybackSource, ownerUserId: string, libraryId: string): Promise<ContentPlaybackProbeResult> {
  const result: ContentPlaybackProbeResult = { container: source.container, runTimeTicks: source.runTimeTicks };
  // 关键变量：已有时长不能替代格式判断，Python 来源仍需在 PlaybackInfo 中解析实际媒体格式。
  const needsFormat = source.container === "unknown";
  if (!needsFormat && (source.runTimeTicks > 0 || source.container !== "hls")) return result;
  const pending = pendingDurationProbes.get(source.id);
  if (pending) return pending;
  const shouldProbeDuration = source.runTimeTicks <= 0 && Date.now() - (lastDurationProbeAt.get(source.id) ?? 0) >= 5 * 60_000;
  if (!needsFormat && !shouldProbeDuration) return result;
  if (shouldProbeDuration) {
    if (lastDurationProbeAt.size > 5_000) lastDurationProbeAt.clear();
    lastDurationProbeAt.set(source.id, Date.now());
  }
  const probe = (async () => {
    const controller = new AbortController();
    // 取址与清单探测共用二十秒预算，不能把两段超时依次累加。
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const access = await runtime.contentSources.resolvePlayback(source.id, ownerUserId, libraryId, controller.signal);
      result.container = access.container;
      if (access.container !== "unknown" && (access.container !== "hls" || !shouldProbeDuration)) return result;
      const media = await probeContentMediaInfo(runtime, access.url, access.headers, shouldProbeDuration, controller.signal);
      result.container = media.container === "unknown" ? access.container : media.container;
      const ticks = media.runTimeTicks;
      if (ticks > 0) {
        await runtime.contentSources.updatePlaybackDuration(source.id, ownerUserId, ticks);
        result.runTimeTicks = ticks;
      }
      return result;
    } catch { return result; }
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
  const item = await runtime.repository.getCatalogItem(itemId, ownerUserId);
  if (item.libraryId !== libraryId) throw new ApiError(404, "content_item_not_found", "媒体条目不存在");
  // PlaybackInfo 可以从列表直接调用，必须先补当前条目的线路，不能要求先访问详情页。
  await runtime.contentSources.ensureItemDetail(libraryId, ownerUserId, itemId);
  const sources = prioritizeContentSources(await runtime.contentSources.listPlaybackSources(itemId, ownerUserId), recentSourceId);
  const selected = requestedSourceId && requestedSourceId !== itemId ? sources.filter((source) => source.id === requestedSourceId) : sources;
  if (selected.length === 0) throw new ApiError(404, "content_playback_source_not_found", requestedSourceId ? "指定在线播放来源不存在" : "媒体条目没有可播放的在线来源");
  // 首期每次只探测最终首选线路，其余线路在实际媒体请求时各自累计完整清单时长。
  const primary = selected[0];
  if (primary) {
    const prepared = await refreshContentDuration(runtime, primary, ownerUserId, libraryId);
    primary.container = prepared.container;
    primary.runTimeTicks = prepared.runTimeTicks;
  }
  return selected;
}
