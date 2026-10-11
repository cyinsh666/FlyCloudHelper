import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireConfirmation, requireRequestUser, requireSuperAdmin } from "../http.js";
import { buildJellyfinPath, validateJellyfinPathSuffix } from "../jellyfin-path.js";
import { buildEmbyPath, validateEmbyPathSuffix } from "../emby-path.js";
import { buildNavidromePath, validateNavidromePathSuffix } from "../navidrome-path.js";
import type { ApiRuntime } from "../runtime.js";

/** 校验媒体库归属；聚合库和在线库使用库本身作为协议配置日志主体。 */
async function requireManagedLibrary(runtime: ApiRuntime, request: FastifyRequest, libraryId: string, admin: boolean) {
  const operator = admin
    ? await requireSuperAdmin(request, runtime.database)
    : await requireRequestUser(request, runtime.database);
  const library = await runtime.repository.getLibrary(libraryId, admin ? undefined : operator.id);
  const service = library.libraryKind !== "legacy_single_source"
    ? { id: library.id, providerType: library.sources[0]?.providerType ?? "" }
    : await runtime.repository.getServiceDetail(library.sourceServiceId, admin ? undefined : operator.id);
  return { operator, service, library };
}

/** 判断 Provider 是否具备媒体中转能力，兼容现有两种能力标识。 */
function supportsRelayPlayback(runtime: ApiRuntime, providerType: string): boolean {
  if (!providerType) return false;
  const capabilities = runtime.providers.get(providerType).descriptor.capabilities;
  return capabilities.includes("relayPlayback") || capabilities.includes("relay");
}

/** 云聚合中转能力由全部已配置来源共同决定，避免启用后某个版本无法中转。 */
function librarySupportsRelayPlayback(
  runtime: ApiRuntime,
  library: Awaited<ReturnType<ApiRuntime["repository"]["getLibrary"]>>,
): boolean {
  if (library.libraryKind === "content_source_video") return true;
  if (library.libraryKind !== "cloud_aggregate_video") return supportsRelayPlayback(runtime, library.providerType);
  return library.sources.length > 0
    && library.sources.every((source) => supportsRelayPlayback(runtime, source.providerType));
}

/** 只有声明支持音乐且按音乐数据创建的网盘服务才开放 Navidrome。 */
function supportsNavidrome(runtime: ApiRuntime, providerType: string, dataType: string): boolean {
  return dataType === "music"
    && runtime.providers.get(providerType).descriptor.supportedDataTypes.includes("music");
}

/** 构造媒体库协议配置；账号、会话和观看状态全部按媒体库隔离。 */
async function buildLibraryAccessSettings(runtime: ApiRuntime, libraryId: string) {
  const libraryRecord = await runtime.repository.getLibrary(libraryId);
  const accounts = await runtime.serviceAccess.listByLibrary(libraryId);
  const account = accounts[0];
  if (!account) throw new ApiError(404, "service_access_account_not_found", "协议访问账号不存在");
  const library = await runtime.database.query("media_libraries")
    .select(
      "jellyfin_enabled",
      "jellyfin_path_suffix",
      "jellyfin_relay_playback_enabled",
      "jellyfin_download_enabled",
      "jellyfin_region_libraries_enabled",
      "emby_enabled",
      "emby_path_suffix",
      "emby_relay_playback_enabled",
      "emby_download_enabled",
      "emby_region_libraries_enabled",
      "navidrome_enabled",
      "navidrome_relay_playback_enabled",
      "navidrome_path_suffix",
    )
    .where({ id: libraryId })
    .first();
  if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
  const jellyfinPathSuffix = String(library.jellyfin_path_suffix ?? "").trim() || libraryId;
  const navidromePathSuffix = String(library.navidrome_path_suffix ?? "").trim() || libraryId;
  const embyPathSuffix = String(library.emby_path_suffix ?? "").trim() || libraryId;
  const navidromeSupported = libraryRecord.libraryKind !== "cloud_aggregate_video"
    && supportsNavidrome(runtime, libraryRecord.providerType, libraryRecord.dataType);
  const embyAccounts = await runtime.embyAccess.listByLibrary(libraryId);
  return {
    relayPlaybackSupported: librarySupportsRelayPlayback(runtime, libraryRecord),
    jellyfinRelayPlaybackEnabled: Number(library.jellyfin_relay_playback_enabled) === 1,
    jellyfinDownloadEnabled: library.jellyfin_download_enabled === undefined || Number(library.jellyfin_download_enabled) === 1,
    jellyfinRegionLibrariesEnabled: Number(library.jellyfin_region_libraries_enabled) === 1,
    jellyfinEnabled: Number(library.jellyfin_enabled) === 1,
    jellyfinUrl: await runtime.publicAccess.buildJellyfinUrl(jellyfinPathSuffix),
    jellyfinPath: buildJellyfinPath(jellyfinPathSuffix),
    jellyfinPathSuffix,
    embyEnabled: Number(library.emby_enabled) === 1,
    embyUrl: await runtime.publicAccess.buildEmbyUrl(embyPathSuffix),
    embyPath: buildEmbyPath(embyPathSuffix),
    embyPathSuffix,
    embyRelayPlaybackEnabled: Number(library.emby_relay_playback_enabled) === 1,
    embyDownloadEnabled: library.emby_download_enabled === undefined || Number(library.emby_download_enabled) === 1,
    embyRegionLibrariesEnabled: Number(library.emby_region_libraries_enabled) === 1,
    embyAccounts,
    navidromeSupported,
    navidromeRelayPlaybackEnabled: Number(library.navidrome_relay_playback_enabled ?? 1) === 1,
    navidromeEnabled: navidromeSupported && Number(library.navidrome_enabled) === 1,
    navidromeUrl: navidromeSupported ? await runtime.publicAccess.buildNavidromeUrl(navidromePathSuffix) : null,
    navidromePath: buildNavidromePath(navidromePathSuffix),
    navidromePathSuffix,
    account,
    accounts,
  };
}

/** 注册用户端与管理端共用的服务协议设置接口。 */
export async function registerServiceAccessRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const registerScopedRoutes = (prefix: string, admin: boolean) => {
    server.get<{ Params: { libraryId: string } }>(`${prefix}/:libraryId/access-account`, async (request) => {
      const { service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });

    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/access-account`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const currentAccount = await runtime.serviceAccess.getByLibrary(library.id);
      const account = await runtime.serviceAccess.updateCredentials(library.id, currentAccount.id, {
        username: request.body.username,
        password: request.body.password,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-service-access-credential", 事件: "修改服务访问凭据并撤销旧会话",
        操作用户ID: operator.id, 服务ID: service.id, 凭据修订: account.credentialRevision,
        是否需要密码: account.hasPassword,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });

    server.post<{ Params: { libraryId: string } }>(`${prefix}/:libraryId/access-account/reset-password`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const currentAccount = await runtime.serviceAccess.getByLibrary(library.id);
      const generated = await runtime.serviceAccess.resetPassword(library.id, currentAccount.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "重置服务访问密码并撤销旧会话",
        操作用户ID: operator.id, 服务ID: service.id, 凭据修订: generated.account.credentialRevision,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id), password: generated.password };
    });

    server.post<{ Params: { libraryId: string } }>(`${prefix}/:libraryId/access-account/revoke-sessions`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const revokedCount = await runtime.serviceAccess.revokeSessions(library.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "撤销服务全部协议会话",
        操作用户ID: operator.id, 服务ID: service.id, 撤销会话数: revokedCount,
      });
      return { revokedCount };
    });

    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/access-accounts`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const account = await runtime.serviceAccess.createAccount(library.id, {
        username: request.body.username,
        password: request.body.password,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-account-management",
        事件: "创建Jellyfin账号",
        操作用户ID: operator.id,
        服务ID: service.id,
        Jellyfin账号ID: account.id,
        是否需要密码: account.hasPassword,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id), account };
    });

    server.patch<{ Params: { libraryId: string; accountId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/access-accounts/:accountId`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      let account = await runtime.serviceAccess.getById(library.id, request.params.accountId);
      const changesCredentials = request.body.username !== undefined || request.body.password !== undefined;
      const changesStatus = request.body.status !== undefined;
      if (!changesCredentials && !changesStatus) {
        throw new ApiError(422, "service_access_account_update_empty", "没有需要保存的 Jellyfin 账号设置");
      }
      if (changesCredentials && changesStatus) {
        throw new ApiError(422, "service_access_account_update_mixed", "账号凭据和启停状态需要分别保存");
      }
      if (changesCredentials) {
        account = await runtime.serviceAccess.updateCredentials(library.id, request.params.accountId, {
          username: request.body.username,
          password: request.body.password,
        });
      }
      if (changesStatus) {
        account = await runtime.serviceAccess.updateStatus(library.id, request.params.accountId, request.body.status);
      }
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-account-management",
        事件: "修改Jellyfin账号",
        操作用户ID: operator.id,
        服务ID: service.id,
        Jellyfin账号ID: account.id,
        账号状态: account.status,
        是否修改凭据: changesCredentials,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id), account };
    });

    server.delete<{ Params: { libraryId: string; accountId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/access-accounts/:accountId`, async (request, reply) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      requireConfirmation(request.body, request.params.accountId);
      await runtime.serviceAccess.deleteAccount(library.id, request.params.accountId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-account-management",
        事件: "删除Jellyfin账号及独立观看记录",
        操作用户ID: operator.id,
        服务ID: service.id,
        Jellyfin账号ID: request.params.accountId,
      });
      return reply.status(204).send();
    });

    server.post<{ Params: { libraryId: string; accountId: string } }>(`${prefix}/:libraryId/access-accounts/:accountId/revoke-sessions`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      await runtime.serviceAccess.getById(library.id, request.params.accountId);
      const revokedCount = await runtime.serviceAccess.revokeSessions(library.id, undefined, request.params.accountId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-account-management",
        事件: "撤销指定Jellyfin账号会话",
        操作用户ID: operator.id,
        服务ID: service.id,
        Jellyfin账号ID: request.params.accountId,
        撤销会话数: revokedCount,
      });
      return { revokedCount };
    });

    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/jellyfin-settings`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const changesJellyfinEnabled = request.body.jellyfinEnabled !== undefined;
      const changesPathSuffix = request.body.jellyfinPathSuffix !== undefined;
      const changesRegionLibraries = request.body.jellyfinRegionLibrariesEnabled !== undefined;
      const changesDownloadEnabled = request.body.jellyfinDownloadEnabled !== undefined;
      if (!changesJellyfinEnabled && !changesPathSuffix && !changesRegionLibraries && !changesDownloadEnabled) {
        throw new ApiError(422, "jellyfin_settings_empty", "没有需要保存的 Jellyfin 设置");
      }
      if (changesJellyfinEnabled && typeof request.body.jellyfinEnabled !== "boolean") {
        throw new ApiError(422, "jellyfin_enabled_invalid", "Jellyfin 开关必须是布尔值");
      }
      if (changesRegionLibraries && typeof request.body.jellyfinRegionLibrariesEnabled !== "boolean") {
        throw new ApiError(422, "jellyfin_region_libraries_invalid", "Jellyfin 节目地区分组开关必须是布尔值");
      }
      if (changesDownloadEnabled && typeof request.body.jellyfinDownloadEnabled !== "boolean") {
        throw new ApiError(422, "jellyfin_download_enabled_invalid", "Jellyfin 允许下载开关必须是布尔值");
      }
      if (library.libraryKind === "content_source_video" && request.body.jellyfinDownloadEnabled === true) {
        throw new ApiError(409, "content_source_download_unsupported", "在线内容源首批只提供播放，暂不提供完整影片下载");
      }
      const pathSuffix = changesPathSuffix ? validateJellyfinPathSuffix(request.body.jellyfinPathSuffix) : null;
      const publicAccess = await runtime.publicAccess.getStatus();
      const now = new Date().toISOString();
      if (pathSuffix) {
        const duplicate = await runtime.database.query("media_libraries")
          .select("id")
          .where({ jellyfin_path_suffix_lookup: pathSuffix.lookup })
          .whereNot({ id: library.id })
          .first();
        if (duplicate) throw new ApiError(409, "jellyfin_path_suffix_conflict", "该 Jellyfin 地址后缀已被使用，请更换后缀");
      }
      const updateValues: Record<string, unknown> = { updated_at: now };
      if (changesJellyfinEnabled) updateValues.jellyfin_enabled = request.body.jellyfinEnabled ? 1 : 0;
      if (changesRegionLibraries) {
        updateValues.jellyfin_region_libraries_enabled = request.body.jellyfinRegionLibrariesEnabled ? 1 : 0;
      }
      if (changesDownloadEnabled) {
        updateValues.jellyfin_download_enabled = request.body.jellyfinDownloadEnabled ? 1 : 0;
      }
      if (pathSuffix) {
        updateValues.jellyfin_path_suffix = pathSuffix.value;
        updateValues.jellyfin_path_suffix_lookup = pathSuffix.lookup;
      }
      try {
        await runtime.database.query("media_libraries").where({ id: library.id }).update(updateValues);
      } catch (error) {
        const databaseError = error as Error & { code?: string };
        const duplicateSuffix = databaseError.code === "23505"
          || databaseError.code === "ER_DUP_ENTRY"
          || /unique|duplicate/iu.test(databaseError.message);
        if (pathSuffix && duplicateSuffix) throw new ApiError(409, "jellyfin_path_suffix_conflict", "该 Jellyfin 地址后缀已被使用，请更换后缀");
        throw error;
      }
      const disabledJellyfin = changesJellyfinEnabled && request.body.jellyfinEnabled === false;
      const revokedCount = disabledJellyfin ? await runtime.serviceAccess.revokeSessions(library.id, "jellyfin") : 0;
      const jellyfinSettingsEvent = pathSuffix
        ? "更新媒体库Jellyfin地址"
        : changesJellyfinEnabled
          ? request.body.jellyfinEnabled ? "启用媒体库Jellyfin协议" : "停用媒体库Jellyfin协议"
          : changesRegionLibraries
            ? "更新Jellyfin节目地区分组"
            : "更新Jellyfin下载权限";
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-path", 事件: jellyfinSettingsEvent,
        操作用户ID: operator.id, 基础服务ID: service.id, 撤销会话数: revokedCount,
        Jellyfin地址后缀: pathSuffix?.value ?? null,
        公开地址来源: publicAccess.source, 是否使用云助手请求地址: !publicAccess.publicBaseUrl,
      });
      if (changesDownloadEnabled) {
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-jellyfin-download",
          事件: request.body.jellyfinDownloadEnabled ? "开启Jellyfin影片下载" : "关闭Jellyfin影片下载",
          操作用户ID: operator.id,
          基础服务ID: service.id,
          是否允许下载: request.body.jellyfinDownloadEnabled === true,
        });
      }
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });

    /** 保存独立 Emby 协议开关、地址、下载和地区虚拟媒体库设置。 */
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/emby-settings`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const changesEnabled = request.body.embyEnabled !== undefined;
      const changesPathSuffix = request.body.embyPathSuffix !== undefined;
      const changesDownload = request.body.embyDownloadEnabled !== undefined;
      const changesRegions = request.body.embyRegionLibrariesEnabled !== undefined;
      if (!changesEnabled && !changesPathSuffix && !changesDownload && !changesRegions) {
        throw new ApiError(422, "emby_settings_empty", "没有需要保存的 Emby 设置");
      }
      if (changesEnabled && typeof request.body.embyEnabled !== "boolean") {
        throw new ApiError(422, "emby_enabled_invalid", "Emby 开关必须是布尔值");
      }
      if (changesDownload && typeof request.body.embyDownloadEnabled !== "boolean") {
        throw new ApiError(422, "emby_download_enabled_invalid", "Emby 允许下载开关必须是布尔值");
      }
      if (library.libraryKind === "content_source_video" && request.body.embyDownloadEnabled === true) {
        throw new ApiError(409, "content_source_download_unsupported", "在线内容源首批只提供播放，暂不提供完整影片下载");
      }
      if (changesRegions && typeof request.body.embyRegionLibrariesEnabled !== "boolean") {
        throw new ApiError(422, "emby_region_libraries_invalid", "Emby 节目地区分组开关必须是布尔值");
      }
      const pathSuffix = changesPathSuffix ? validateEmbyPathSuffix(request.body.embyPathSuffix) : null;
      if (pathSuffix) {
        const duplicate = await runtime.database.query("media_libraries")
          .select("id")
          .where({ emby_path_suffix_lookup: pathSuffix.lookup })
          .whereNot({ id: library.id })
          .first();
        if (duplicate) throw new ApiError(409, "emby_path_suffix_conflict", "该 Emby 地址后缀已被使用，请更换后缀");
      }
      const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (changesEnabled) values.emby_enabled = request.body.embyEnabled ? 1 : 0;
      if (changesDownload) values.emby_download_enabled = request.body.embyDownloadEnabled ? 1 : 0;
      if (changesRegions) values.emby_region_libraries_enabled = request.body.embyRegionLibrariesEnabled ? 1 : 0;
      if (pathSuffix) {
        values.emby_path_suffix = pathSuffix.value;
        values.emby_path_suffix_lookup = pathSuffix.lookup;
      }
      try {
        const changed = await runtime.database.query("media_libraries").where({ id: library.id }).update(values);
        if (changed !== 1) throw new ApiError(404, "library_not_found", "媒体库不存在");
      } catch (error) {
        const databaseError = error as Error & { code?: string };
        if (pathSuffix && (databaseError.code === "23505" || databaseError.code === "ER_DUP_ENTRY" || /unique|duplicate/iu.test(databaseError.message))) {
          throw new ApiError(409, "emby_path_suffix_conflict", "该 Emby 地址后缀已被使用，请更换后缀");
        }
        throw error;
      }
      if (changesEnabled && request.body.embyEnabled === true) await runtime.embyAccess.ensureForLibrary(library.id);
      const revokedCount = changesEnabled && request.body.embyEnabled === false
        ? await runtime.embyAccess.revokeSessions(library.id)
        : 0;
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-emby-settings",
        事件: changesEnabled ? (request.body.embyEnabled ? "启用媒体库Emby协议" : "停用媒体库Emby协议") : pathSuffix ? "更新媒体库Emby地址" : changesDownload ? "更新Emby下载权限" : "更新Emby节目地区分组",
        操作用户ID: operator.id,
        服务ID: service.id,
        Emby地址后缀: pathSuffix?.value ?? null,
        撤销Emby会话数: revokedCount,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });

    /** 创建同一 Emby 服务地址下、状态彼此独立的登录账号。 */
    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/emby-access-accounts`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const account = await runtime.embyAccess.createAccount(library.id, {
        username: request.body.username,
        password: request.body.password,
      });
      runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-account", 事件: "创建Emby账号", 操作用户ID: operator.id, 服务ID: service.id, Emby账号ID: account.id });
      return { settings: await buildLibraryAccessSettings(runtime, library.id), account };
    });

    /** 修改、启停或删除独立 Emby 账号。 */
    server.patch<{ Params: { libraryId: string; accountId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/emby-access-accounts/:accountId`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const changesCredentials = request.body.username !== undefined || request.body.password !== undefined;
      const changesStatus = request.body.status !== undefined;
      if (changesCredentials === changesStatus) throw new ApiError(422, "emby_account_update_invalid", "请单独保存 Emby 账号凭据或启停状态");
      const account = changesCredentials
        ? await runtime.embyAccess.updateCredentials(library.id, request.params.accountId, {
          username: request.body.username,
          password: request.body.password,
        })
        : await runtime.embyAccess.updateStatus(library.id, request.params.accountId, request.body.status);
      runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-account", 事件: "修改Emby账号", 操作用户ID: operator.id, 服务ID: service.id, Emby账号ID: account.id, 账号状态: account.status });
      return { settings: await buildLibraryAccessSettings(runtime, library.id), account };
    });

    server.delete<{ Params: { libraryId: string; accountId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/emby-access-accounts/:accountId`, async (request, reply) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      requireConfirmation(request.body, request.params.accountId);
      await runtime.embyAccess.deleteAccount(library.id, request.params.accountId);
      runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-account", 事件: "删除Emby账号及独立观看记录", 操作用户ID: operator.id, 服务ID: service.id, Emby账号ID: request.params.accountId });
      return reply.status(204).send();
    });

    server.post<{ Params: { libraryId: string; accountId: string } }>(`${prefix}/:libraryId/emby-access-accounts/:accountId/revoke-sessions`, async (request) => {
      const { service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      await runtime.embyAccess.getById(library.id, request.params.accountId);
      return { revokedCount: await runtime.embyAccess.revokeSessions(library.id, request.params.accountId) };
    });

    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/navidrome-settings`, async (request) => {
      const { operator, service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      if (!supportsNavidrome(runtime, service.providerType, library.dataType)) {
        throw new ApiError(422, "navidrome_music_service_required", "只有音乐类型服务可以启用 Navidrome 协议");
      }
      const changesEnabled = request.body.navidromeEnabled !== undefined;
      const changesPathSuffix = request.body.navidromePathSuffix !== undefined;
      const changesRelay = request.body.navidromeRelayPlaybackEnabled !== undefined;
      if (!changesEnabled && !changesPathSuffix && !changesRelay) {
        throw new ApiError(422, "navidrome_settings_empty", "没有需要保存的 Navidrome 设置");
      }
      if (changesEnabled && typeof request.body.navidromeEnabled !== "boolean") {
        throw new ApiError(422, "navidrome_enabled_invalid", "Navidrome 开关必须是布尔值");
      }
      if (changesRelay && typeof request.body.navidromeRelayPlaybackEnabled !== "boolean") {
        throw new ApiError(422, "navidrome_relay_playback_invalid", "Navidrome 中转开关必须是布尔值");
      }
      const pathSuffix = changesPathSuffix ? validateNavidromePathSuffix(request.body.navidromePathSuffix) : null;
      if (pathSuffix) {
        const duplicate = await runtime.database.query("media_libraries")
          .select("id")
          .where({ navidrome_path_suffix_lookup: pathSuffix.lookup })
          .whereNot({ id: library.id })
          .first();
        if (duplicate) throw new ApiError(409, "navidrome_path_suffix_conflict", "该 Navidrome 地址后缀已被使用，请更换后缀");
      }
      const updateValues: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (changesRelay) updateValues.navidrome_relay_playback_enabled = request.body.navidromeRelayPlaybackEnabled ? 1 : 0;
      if (changesEnabled) updateValues.navidrome_enabled = request.body.navidromeEnabled ? 1 : 0;
      if (pathSuffix) {
        updateValues.navidrome_path_suffix = pathSuffix.value;
        updateValues.navidrome_path_suffix_lookup = pathSuffix.lookup;
      }
      let changed = 0;
      try {
        changed = await runtime.database.query("media_libraries")
          .where({ id: library.id })
          .update(updateValues);
      } catch (error) {
        const databaseError = error as Error & { code?: string };
        const duplicateSuffix = databaseError.code === "23505"
          || databaseError.code === "ER_DUP_ENTRY"
          || /unique|duplicate/iu.test(databaseError.message);
        if (pathSuffix && duplicateSuffix) throw new ApiError(409, "navidrome_path_suffix_conflict", "该 Navidrome 地址后缀已被使用，请更换后缀");
        throw error;
      }
      if (changed !== 1) throw new ApiError(404, "library_not_found", "媒体库不存在");
      const publicAccess = await runtime.publicAccess.getStatus();
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-navidrome",
        播放日志关键字: "codex-flycloud-navidrome-playback",
        中转播放: changesRelay ? request.body.navidromeRelayPlaybackEnabled === true : null,
        事件: changesRelay ? "更新Navidrome播放方式" : pathSuffix ? "更新音乐库Navidrome地址" : (request.body.navidromeEnabled ? "启用音乐库Navidrome协议" : "停用音乐库Navidrome协议"),
        操作用户ID: operator.id,
        基础服务ID: service.id,
        是否已配置公开地址: Boolean(publicAccess.publicBaseUrl),
        Navidrome地址后缀: pathSuffix?.value ?? null,
      });
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });

    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${prefix}/:libraryId/library-playback-settings`, async (request) => {
      const { service, library } = await requireManagedLibrary(runtime, request, request.params.libraryId, admin);
      const changesJellyfinRelay = request.body.jellyfinRelayPlaybackEnabled !== undefined;
      const changesEmbyRelay = request.body.embyRelayPlaybackEnabled !== undefined;
      if (library.libraryKind === "content_source_video"
        && (request.body.jellyfinRelayPlaybackEnabled === false || request.body.embyRelayPlaybackEnabled === false)) {
        throw new ApiError(409, "content_source_relay_required", "在线内容源首批通过云助手中转播放");
      }
      if (!changesJellyfinRelay && !changesEmbyRelay) {
        throw new ApiError(422, "library_playback_settings_empty", "没有需要保存的媒体库播放设置");
      }
      if (changesJellyfinRelay && typeof request.body.jellyfinRelayPlaybackEnabled !== "boolean") {
        throw new ApiError(422, "jellyfin_relay_playback_invalid", "Jellyfin 中转开关必须是布尔值");
      }
      if (changesEmbyRelay && typeof request.body.embyRelayPlaybackEnabled !== "boolean") {
        throw new ApiError(422, "emby_relay_playback_invalid", "Emby 中转开关必须是布尔值");
      }
      const enablesRelay = request.body.jellyfinRelayPlaybackEnabled === true
        || request.body.embyRelayPlaybackEnabled === true;
      if (enablesRelay && !librarySupportsRelayPlayback(runtime, library)) {
        throw new ApiError(422, "provider_relay_playback_unsupported", "当前网盘类型暂不支持中转播放");
      }
      const updateValues: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (changesJellyfinRelay) updateValues.jellyfin_relay_playback_enabled = request.body.jellyfinRelayPlaybackEnabled ? 1 : 0;
      if (changesEmbyRelay) updateValues.emby_relay_playback_enabled = request.body.embyRelayPlaybackEnabled ? 1 : 0;
      const changed = await runtime.database.query("media_libraries")
        .where({ id: library.id })
        .update(updateValues);
      if (changed !== 1) throw new ApiError(404, "library_not_found", "媒体库不存在");
      return { settings: await buildLibraryAccessSettings(runtime, library.id) };
    });
  };

  registerScopedRoutes("/api/v1/libraries", false);
  registerScopedRoutes("/api/v1/admin/libraries", true);

  server.get("/api/v1/admin/config/public-access", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { publicAccess: await runtime.publicAccess.getStatus() };
  });
  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/public-access", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    if (!runtime.publicAccess || (await runtime.publicAccess.getStatus()).source === "environment") {
      throw new ApiError(409, "public_base_url_environment_locked", "公开访问地址由环境变量控制，不能在控制台修改");
    }
    const publicAccess = await runtime.publicAccess.save(request.body.publicBaseUrl, operator.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "更新实例公开访问地址",
      操作用户ID: operator.id, 配置来源: publicAccess.source, 是否已配置: Boolean(publicAccess.publicBaseUrl),
    });
    return { publicAccess };
  });
}
