import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { buildLiveM3u, liveResourceUrl, liveSignature, sendLiveResource, validLiveSignature } from "./stream.js";

/** 管理端按真实所有者处理，普通用户始终限制在自己的直播库。 */
async function owned(runtime: ApiRuntime, request: FastifyRequest, libraryId: string, admin: boolean) {
  const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
  return runtime.liveLibraries.get(libraryId, admin ? undefined : user.id);
}

/** 导出只包含管理页面需要的资料，不回显脚本、状态文件或引擎回环端口。 */
async function presentation(runtime: ApiRuntime, request: FastifyRequest, state: Awaited<ReturnType<ApiRuntime["liveLibraries"]["get"]>>) {
  const token = liveSignature(runtime, `${state.library.id}:${state.configuration.subscriptionRevision}:subscription`);
  return { libraryId: state.library.id, displayName: state.library.displayName, source: state.source,
    configuration: state.configuration, channels: state.channels, runtimeStatus: state.runtimeStatus,
    subscriptionUrl: `${await publicRoot(runtime, request)}/live/${encodeURIComponent(state.library.id)}/all.m3u?token=${token}`, epgSuggestions: state.epgSuggestions };
}

/** 外网地址优先使用云助手公开地址配置；未配置时输出当前请求所在地址。 */
async function publicRoot(runtime: ApiRuntime, request: FastifyRequest): Promise<string> {
  return (await runtime.publicAccess.getStatus()).publicBaseUrl ?? `${request.protocol}://${request.host}`;
}

/** 注册独立 M3U 入口和直播库管理，不启用 Jellyfin/Emby 或网盘协议。 */
export async function registerLiveRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const base = `${admin ? "/api/v1/admin" : "/api/v1"}/libraries/:libraryId/live`;
    server.get<{ Params: { libraryId: string } }>(base, async (request) => presentation(runtime, request, await owned(runtime, request, request.params.libraryId, admin)));
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(base, async (request) => {
      const state = await owned(runtime, request, request.params.libraryId, admin);
      await runtime.liveLibraries.update(state.library.id, state.library.userId, request.body ?? {});
      return presentation(runtime, request, await runtime.liveLibraries.get(state.library.id, state.library.userId));
    });
    server.post<{ Params: { libraryId: string } }>(`${base}/subscription/reset`, async (request) => {
      const state = await owned(runtime, request, request.params.libraryId, admin);
      await runtime.liveLibraries.resetSubscription(state.library.id, state.library.userId);
      return presentation(runtime, request, await runtime.liveLibraries.get(state.library.id, state.library.userId));
    });
    server.post<{ Params: { libraryId: string } }>(`${base}/start`, async (request) => {
      const state = await owned(runtime, request, request.params.libraryId, admin);
      await runtime.liveLibraries.available(state.library.id);
      await runtime.liveLibraries.process.ensure(state.source.id, state.manifest);
      return { runtimeStatus: runtime.liveLibraries.process.status(state.source.id) };
    });
  }

  server.route<{ Params: { libraryId: string; "*": string }; Querystring: Record<string, string> }>({
    method: ["GET", "HEAD"], url: "/live/:libraryId/*", logLevel: "silent",
    handler: async (request, reply) => {
      const state = await runtime.liveLibraries.available(request.params.libraryId);
      const query = request.query;
      // 直播无需账号，地址凭据随本库重置而失效；资源签名继续限制中转目标。
      const libraryScope = `${state.library.id}:${state.configuration.subscriptionRevision}`;
      if (typeof query.token !== "string" || !validLiveSignature(runtime, `${libraryScope}:subscription`, query.token))
        throw new ApiError(401, "live_subscription_invalid", "直播订阅地址已失效，请复制最新的 M3U 地址");
      const auth = new URLSearchParams({ token: query.token });
      const base = `${await publicRoot(runtime, request)}/live/${encodeURIComponent(state.library.id)}`;
      const route = request.params["*"];
      reply.header("Cache-Control", "private, no-store");
      if (route === "all.m3u") {
        const selected = state.channels.filter((channel) => state.configuration.channelIds.includes(channel.id));
        return reply.type("audio/x-mpegurl; charset=utf-8").send(buildLiveM3u(selected, base, auth, state.configuration.playbackMode, state.configuration.epgUrl));
      }
      let target: string;
      let playlist = true;
      let mode: "direct" | "relay" = "relay";
      // 关键变量：校验路由与资源签名后才启动来源，错误或过期请求不能创建常驻进程。
      if (route !== "resource" && !/^channels\/[a-zA-Z0-9_-]+\.m3u8$/u.test(route)) throw new ApiError(404, "live_route_not_found", "直播接口不存在");
      if (route === "resource" && (!query.target || query.target.length > 16000 || !validLiveSignature(runtime, `${libraryScope}:resource:${query.target}:${query.playlist}:${query.mode}`, query.signature)))
        throw new ApiError(401, "live_resource_invalid", "直播资源凭据无效");
      const origin = await runtime.liveLibraries.process.ensure(state.source.id, state.manifest);
      try {
        const latest = await runtime.liveLibraries.available(state.library.id);
        if (latest.configuration.subscriptionRevision !== state.configuration.subscriptionRevision)
          throw new ApiError(401, "live_subscription_invalid", "直播订阅地址已失效，请复制最新的 M3U 地址");
      }
      catch (error) {
        if (!(error instanceof ApiError && error.code === "live_subscription_invalid")) await runtime.liveLibraries.process.stop(state.source.id);
        throw error;
      }
      if (route === "resource") {
        if (!query.target || query.target.length > 16000 || !validLiveSignature(runtime, `${libraryScope}:resource:${query.target}:${query.playlist}:${query.mode}`, query.signature))
          throw new ApiError(401, "live_resource_invalid", "直播资源凭据无效");
        target = Buffer.from(query.target, "base64url").toString("utf8");
        playlist = query.playlist === "1";
        mode = query.mode === "direct" ? "direct" : "relay";
      } else {
        const match = /^channels\/([a-zA-Z0-9_-]+)\.m3u8$/u.exec(route);
        const channel = state.channels.find((entry) => entry.id === match?.[1] && state.configuration.channelIds.includes(entry.id));
        if (!channel) throw new ApiError(404, "live_channel_not_found", "直播频道不存在或未选择");
        if (query.mode && query.mode !== "direct" && query.mode !== "relay") throw validationError("mode", "播放方式无效");
        mode = query.mode === "direct" ? "direct" : query.mode === "relay" ? "relay" : state.configuration.playbackMode;
        if (mode === "direct" && channel.requiresRelay) throw new ApiError(409, "live_relay_required", "此频道需要设备签名，请使用中转播放");
        const upstream = new URL(`/${channel.id}.m3u8`, origin);
        if (channel.catchup) for (const key of ["playseek", "start", "end", "utc", "lutc", "starttime", "endtime"]) {
          const value = query[key]; if (value) { if (value.length > 100) throw validationError(key, "回看时间参数过长"); upstream.searchParams.set(key, value); }
        }
        target = upstream.href;
      }
      return sendLiveResource(runtime, request, reply, { origin, target, playlist, mode,
        resource: (url, childPlaylist) => liveResourceUrl(runtime, base, auth, libraryScope, url, childPlaylist, mode) });
    },
  });
}
