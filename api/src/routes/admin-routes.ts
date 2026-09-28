import { listMusicStageTasks } from "../music/task-query.js";
import { retryMusicScan } from "../music/retry.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { authenticateUser, createUsernameLookup, hashPassword, validatePassword, validatePasswordConfirmation, validateUsername } from "../auth.js";
import type { JobStatus, MatchState, MediaType, ServiceStatus, UserRole, UserStatus } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import {
  readPagination,
  requireConfirmation,
  requireObject,
  requireString,
  requireSuperAdmin,
  toUserDto,
} from "../http.js";
import {
  applyManualVideoMatch,
  clearManualVideoMatch,
  searchManualVideoMatches,
} from "../media/manual-video-match.js";
import { hydrateRealtimeVideoDetails } from "../media/realtime-video-details.js";
import type { ApiRuntime } from "../runtime.js";
import {
  loadMusicSourceSettings,
  loadTmdbBaseUrls,
  musicSourceSettingName,
  saveMusicSourceSettings,
  saveTmdbBaseUrls,
  tmdbBaseUrlSettingName,
  tmdbKeySettingName,
  validateTmdbKeyList,
} from "../system-settings.js";
import { streamJobEvents } from "./event-stream.js";
import { attachLibrarySourceId, notifyFinishedLibraryScanJob } from "./library-routes.js";
import {
  consumeProviderAuthorization,
  attachConnectionAuthMode,
  getScanRootsForMode,
  hasHttpProviderAddress,
  readProviderDirectoryParent,
  readMusicMetadataLogFields,
  readVideoMetadataLogFields,
  resolveProviderConnection,
  requireSameCloudDriveAccount,
  validateConfiguredScanRoots,
  validateMetadataProfile,
  validateProviderDataType,
  validateProviderAccess,
  validateScanProfile,
  validateServiceDataType,
} from "./service-routes.js";

/** 写入统一的超级管理员操作审计。 */
async function audit(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  targetType: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType,
    targetId,
    result: "success",
    detail,
  });
}

/** 要求管理员用当前密码完成高风险角色操作的重新认证。 */
async function requireRecentAuthentication(runtime: ApiRuntime, operator: { username: string }, body: Record<string, unknown>): Promise<void> {
  if (typeof body.currentPassword !== "string") {
    throw validationError("currentPassword", "高风险操作需要输入当前管理员密码");
  }
  await authenticateUser(runtime.database, operator.username, body.currentPassword);
}

/** 删除指定根目录内当前用户独占的数据目录，不允许目录范围越出配置根路径。 */
async function removeUserOwnedDirectory(rootDirectory: string, userId: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedTarget = path.resolve(resolvedRoot, userId);
  // 关键变量：用户 ID 必须只解析为根目录下的一个直接子目录。
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new ApiError(500, "invalid_user_data_directory", "用户数据目录不正确，无法彻底删除");
  }
  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

/** 返回不含 Key 原文或局部值的 TMDB 系统配置状态。 */
async function getTmdbConfigurationStatus(runtime: ApiRuntime) {
  const [setting, baseUrlSettings] = await Promise.all([
    runtime.database.getSystemSecretSetting(tmdbKeySettingName),
    loadTmdbBaseUrls(runtime.database),
  ]);
  const status = runtime.tmdb.getStatus();
  return {
    source: status.configuredCount > 0 ? "system" : "missing",
    configurationRevision: setting?.revision ?? 0,
    baseUrlSource: baseUrlSettings.source,
    baseUrlConfigurationRevision: baseUrlSettings.configurationRevision,
    ...status,
  };
}

/** 注册超级管理员的用户、服务、任务、目录与系统状态接口。 */
export async function registerAdminRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/admin/status", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const [overview, userCount, state] = await Promise.all([
      runtime.repository.getOverview(),
      runtime.database.query("user_accounts").count<{ count: string | number }[]>({ count: "id" }).first(),
      runtime.database.getSystemState(),
    ]);
    return {
      service: "flycloud-helper",
      serviceInstanceId: state.serviceInstanceId,
      schemaVersion: state.schemaVersion,
      userCount: Number(userCount?.count ?? 0),
      ...overview,
      worker: runtime.worker.getStatus(),
      mediaProbeWorker: runtime.mediaProbeWorker.getStatus(),
      database: { type: runtime.config.databaseType, connected: true },
    };
  });

  server.get("/api/v1/admin/config/status", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const [pluginCount, enabledPluginCount, tmdbStatus, publicAccess, aiModels, musicSources] = await Promise.all([
      runtime.database.query("metadata_plugin_versions").count<{ count: string | number }[]>({ count: "id" }).first(),
      runtime.database.query("metadata_plugin_versions").where({ status: "enabled" }).count<{ count: string | number }[]>({ count: "id" }).first(),
      getTmdbConfigurationStatus(runtime),
      runtime.publicAccess.getStatus(),
      runtime.aiModels.getSummary(),
      loadMusicSourceSettings(runtime.database),
    ]);
    return {
      database: { type: runtime.config.databaseType, schemaVersion: (await runtime.database.getSystemState()).schemaVersion },
      tmdb: tmdbStatus,
      publicAccess,
      music: {
        sources: musicSources,
        musicBrainz: { status: "available" },
        acoustId: {
          status: "unavailable",
          configured: Boolean(runtime.config.acoustidApiKey),
          reasonCode: "provider_media_stream_not_implemented",
        },
        fingerprint: {
          status: "unavailable",
          configured: Boolean(runtime.config.fpcalcPath),
          reasonCode: "provider_media_stream_not_implemented",
        },
      },
      credentials: { configured: Boolean(runtime.config.credentialMasterKey), source: runtime.config.credentialKeySource },
      plugins: {
        directoryReady: true,
        installedCount: Number(pluginCount?.count ?? 0),
        enabledCount: Number(enabledPluginCount?.count ?? 0),
      },
      aiModels,
      worker: runtime.worker.getStatus(),
    };
  });

  /** 读取系统级音乐刮削来源集合。 */
  server.get("/api/v1/admin/config/music-sources", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { musicSources: await loadMusicSourceSettings(runtime.database) };
  });

  /** 保存系统级音乐刮削来源集合，之后新启动的扫描会读取新修订。 */
  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/music-sources", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const settings = await saveMusicSourceSettings(runtime.database, {
      enabledSources: request.body.enabledSources,
      updatedByUserId: operator.id,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-music-source-config",
      事件: settings.source === "default" ? "恢复全部音乐刮削来源" : "更新音乐刮削来源",
      用户ID: operator.id,
      启用来源数量: settings.enabledSources.length,
      配置修订: settings.configurationRevision,
    });
    await audit(runtime, operator, "update_music_scrape_sources", "system_configuration", musicSourceSettingName, {
      启用来源: settings.enabledSources,
      配置修订: settings.configurationRevision,
    });
    return { musicSources: settings };
  });

  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/tmdb-keys", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const keys = validateTmdbKeyList(request.body.keys);
    const configurationRevision = await runtime.database.saveSystemSecretSetting({
      settingKey: tmdbKeySettingName,
      encryptedPayload: runtime.vault.encrypt({ keys }),
      updatedByUserId: operator.id,
    });
    runtime.tmdb.replaceKeys(keys);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-tmdb-config",
      事件: keys.length > 0 ? "更新TMDB系统配置" : "清空TMDB系统配置",
      用户ID: operator.id,
      配置修订: configurationRevision,
      Key数量: keys.length,
      有效并发: runtime.tmdb.getStatus().effectiveConcurrency,
    });
    await audit(runtime, operator, "update_tmdb_keys", "system_configuration", tmdbKeySettingName, {
      配置修订: configurationRevision,
      Key数量: keys.length,
    });
    return { tmdb: await getTmdbConfigurationStatus(runtime) };
  });

  /** 保存 TMDB API 与图片代理地址，并即时更新当前进程中的后续请求。 */
  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/tmdb-base-urls", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const settings = await saveTmdbBaseUrls(runtime.database, {
      apiBaseUrl: request.body.apiBaseUrl,
      imageBaseUrl: request.body.imageBaseUrl,
      updatedByUserId: operator.id,
    });
    runtime.tmdb.replaceBaseUrls(settings);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-tmdb-proxy",
      事件: settings.source === "default" ? "恢复TMDB默认地址" : "更新TMDB代理地址",
      用户ID: operator.id,
      配置来源: settings.source === "database" ? "系统设置" : "默认地址",
      配置修订: settings.configurationRevision,
    });
    await audit(runtime, operator, "update_tmdb_base_urls", "system_configuration", tmdbBaseUrlSettingName, {
      配置来源: settings.source === "database" ? "系统设置" : "默认地址",
      配置修订: settings.configurationRevision,
    });
    return { tmdb: await getTmdbConfigurationStatus(runtime) };
  });

  server.delete<{ Body: Record<string, unknown> }>("/api/v1/admin/config/tmdb-cache", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, "tmdb-cache");
    const result = await runtime.tmdbCache.clearAll();
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-tmdb-cache",
      事件: "管理员清空TMDB共享缓存",
      用户ID: operator.id,
      数据库删除数量: result.deletedCount,
      丢弃待写入数量: result.discardedPendingCount,
      清空内存数量: result.clearedMemoryCount,
    });
    await audit(runtime, operator, "clear_tmdb_cache", "system_configuration", "tmdb_metadata_cache", {
      数据库删除数量: result.deletedCount,
      丢弃待写入数量: result.discardedPendingCount,
      清空内存数量: result.clearedMemoryCount,
    });
    return result;
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/users", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return runtime.database.listUsers({
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      role: typeof request.query.role === "string" ? request.query.role as UserRole : undefined,
      status: typeof request.query.status === "string" ? request.query.status as UserStatus : undefined,
      ...readPagination(request.query),
    });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/users", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    const user = await runtime.database.createUser({
      userId: randomUUID(),
      username,
      usernameLookup: createUsernameLookup(username),
      passwordHash: await hashPassword(password),
      role: "user",
    });
    await audit(runtime, operator, "create_user", "user", user.id);
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "管理员创建账号",
      message: `超级管理员“${operator.username}”创建了账号“${user.username}”。`,
      actionPath: "/admin/users",
    });
    return reply.status(201).send({ user: toUserDto(user) });
  });

  server.get<{ Params: { userId: string } }>("/api/v1/admin/users/:userId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const user = await runtime.database.findPublicUserById(request.params.userId);
    const [services, jobs, overview] = await Promise.all([
      runtime.repository.listServices({ userId: user.id, limit: 200, offset: 0 }),
      runtime.repository.listJobs({ userId: user.id, limit: 50, offset: 0 }),
      runtime.repository.getOverview(user.id),
    ]);
    return { user: toUserDto(user), overview, services: services.items, recentJobs: jobs.items };
  });

  server.post<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/password-reset", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const targetUser = await runtime.database.findPublicUserById(request.params.userId);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    await runtime.database.resetUserPassword(request.params.userId, await hashPassword(password));
    await audit(runtime, operator, "reset_user_password", "user", request.params.userId);
    await runtime.database.createNotificationSafely({
      userId: targetUser.id,
      category: "security",
      tone: "danger",
      title: "账号密码已重置",
      message: `超级管理员“${operator.username}”重置了你的账号密码。`,
      actionPath: null,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "danger",
      title: "管理员重置用户密码",
      message: `超级管理员“${operator.username}”重置了账号“${targetUser.username}”的密码。`,
      actionPath: "/admin/users",
      excludeUserId: targetUser.id,
    });
    return reply.status(204).send();
  });

  server.put<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/role", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.userId);
    await requireRecentAuthentication(runtime, operator, request.body);
    const role = request.body.role;
    if (role !== "user" && role !== "super_admin") {
      throw validationError("role", "角色只支持 user 或 super_admin");
    }
    const user = await runtime.database.updateUserRole(request.params.userId, role);
    await audit(runtime, operator, "update_user_role", "user", user.id, { 新角色: role });
    await runtime.database.createNotificationSafely({
      userId: user.id,
      category: "security",
      tone: "warning",
      title: "账号角色已修改",
      message: `超级管理员“${operator.username}”将你的账号角色修改为${role === "super_admin" ? "超级管理员" : "普通用户"}。`,
      actionPath: null,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "管理员修改用户角色",
      message: `超级管理员“${operator.username}”修改了账号“${user.username}”的角色。`,
      actionPath: "/admin/users",
      excludeUserId: user.id,
    });
    return { user: toUserDto(user) };
  });

  server.patch<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/status", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "用户状态只支持 active 或 disabled");
    }
    const user = await runtime.database.updateUserStatus(request.params.userId, status);
    await audit(runtime, operator, "update_user_status", "user", user.id, { 新状态: status });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: status === "active" ? "启用用户" : "停用用户",
      用户ID: operator.id,
      目标用户ID: user.id,
    });
    await runtime.database.createNotificationSafely({
      userId: user.id,
      category: "security",
      tone: "warning",
      title: status === "active" ? "账号已启用" : "账号已停用",
      message: `超级管理员“${operator.username}”${status === "active" ? "启用" : "停用"}了你的账号。`,
      actionPath: null,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: status === "active" ? "管理员启用用户" : "管理员停用用户",
      message: `超级管理员“${operator.username}”${status === "active" ? "启用" : "停用"}了账号“${user.username}”。`,
      actionPath: "/admin/users",
      excludeUserId: user.id,
    });
    return { user: toUserDto(user) };
  });

  server.post<{ Params: { userId: string } }>("/api/v1/admin/users/:userId/sessions/revoke", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const targetUser = await runtime.database.findPublicUserById(request.params.userId);
    await runtime.database.revokeAllUserSessions(request.params.userId);
    await audit(runtime, operator, "revoke_user_sessions", "user", request.params.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: "撤销用户全部会话",
      用户ID: operator.id,
      目标用户ID: request.params.userId,
    });
    await runtime.database.createNotificationSafely({
      userId: targetUser.id,
      category: "security",
      tone: "danger",
      title: "全部登录会话已撤销",
      message: `超级管理员“${operator.username}”撤销了你的全部登录会话。`,
      actionPath: null,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "danger",
      title: "管理员撤销用户会话",
      message: `超级管理员“${operator.username}”撤销了账号“${targetUser.username}”的全部登录会话。`,
      actionPath: "/admin/users",
      excludeUserId: targetUser.id,
    });
    return reply.status(204).send();
  });

  server.delete<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.userId);
    if (request.params.userId === operator.id) {
      throw new ApiError(409, "cannot_delete_current_user", "不能删除当前登录的超级管理员");
    }
    const targetUser = await runtime.database.findPublicUserById(request.params.userId);
    await runtime.database.updateUserStatus(request.params.userId, "pending_delete");
    await audit(runtime, operator, "schedule_user_delete", "user", request.params.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: "管理员删除用户",
      用户ID: operator.id,
      目标用户ID: targetUser.id,
    });
    await runtime.database.createNotificationSafely({
      userId: targetUser.id,
      category: "security",
      tone: "danger",
      title: "账号已进入删除状态",
      message: `超级管理员“${operator.username}”已将你的账号标记为待删除。`,
      actionPath: null,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "danger",
      title: "管理员删除用户",
      message: `超级管理员“${operator.username}”将账号“${targetUser.username}”标记为待删除。`,
      actionPath: "/admin/users",
      excludeUserId: targetUser.id,
    });
    return reply.status(202).send({ status: "pending_delete" });
  });

  /** 彻底清理已经处于待删除状态的其他用户。 */
  server.delete<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/purge", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.userId);
    if (request.params.userId === operator.id) {
      throw new ApiError(409, "cannot_delete_current_user", "不能删除当前登录的超级管理员");
    }
    const targetUser = await runtime.database.assertUserCanBePurged(request.params.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: "管理员开始彻底删除用户",
      用户ID: operator.id,
      目标用户ID: targetUser.id,
    });
    try {
      await Promise.all([
        removeUserOwnedDirectory(runtime.config.exportDirectory, targetUser.id),
        removeUserOwnedDirectory(path.join(runtime.config.exportDirectory, "scan-failures"), targetUser.id),
      ]);
      await runtime.database.purgePendingUser(targetUser.id);
      await audit(runtime, operator, "purge_user", "user", null);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-user-action",
        事件: "管理员彻底删除用户完成",
        用户ID: operator.id,
        目标用户ID: targetUser.id,
      });
      return reply.status(204).send();
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-user-action",
        事件: "管理员彻底删除用户失败",
        用户ID: operator.id,
        目标用户ID: targetUser.id,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/services", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const jellyfinFilter = request.query.jellyfinEnabled === "true"
      ? true
      : request.query.jellyfinEnabled === "false" ? false : undefined;
    const result = await runtime.repository.listServices({
      userId: typeof request.query.userId === "string" ? request.query.userId : undefined,
      providerType: typeof request.query.providerType === "string" ? request.query.providerType : undefined,
      dataType: typeof request.query.dataType === "string" ? request.query.dataType as MediaType : undefined,
      status: typeof request.query.status === "string" ? request.query.status as ServiceStatus : undefined,
      jellyfinEnabled: jellyfinFilter,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...readPagination(request.query),
    });
    // 关键变量：管理端列表仅追加登录类型，用于区分官方光鸭和三方光鸭。
    const items = await Promise.all(result.items.map((service) => attachConnectionAuthMode(runtime, service)));
    return { ...result, items };
  });

  /** 管理员代用户创建只包含基础信息和登录凭据的网盘服务。 */
  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/services", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const owner = await runtime.database.findPublicUserById(requireString(request.body, "userId", "目标用户 ID", 100));
    const provider = requireObject(request.body, "provider", "Provider");
    const providerType = requireString(provider, "type", "Provider 类型", 64);
    const resolvedConnection = resolveProviderConnection(
      runtime,
      operator.id,
      owner.id,
      providerType,
      requireObject(provider, "connection", "连接配置"),
    );
    const adapter = runtime.providers.get(providerType);
    await validateProviderAccess(adapter, resolvedConnection.connection, { fullRoots: [], incrementalRoots: [] });
    const service = await runtime.repository.createService({
      serviceId: randomUUID(),
      userId: owner.id,
      displayName: requireString(request.body, "displayName", "服务名称", 100),
      providerType,
      encryptedConnection: runtime.vault.encrypt(resolvedConnection.connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
    });
    consumeProviderAuthorization(runtime, operator.id, resolvedConnection.authorizationSessionId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-service-upload",
      阶段: "管理员创建网盘服务",
      管理员ID: operator.id,
      目标用户ID: owner.id,
      服务ID: service.id,
      网盘类型: providerType,
      结果: "成功",
    });
    await audit(runtime, operator, "create_service", "service", service.id, {
      目标用户ID: owner.id,
      网盘类型: providerType,
    });
    return reply.status(201).send({ service });
  });

  server.get<{ Params: { serviceId: string } }>("/api/v1/admin/services/:serviceId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    return { service: await attachConnectionAuthMode(runtime, service) };
  });

  server.get<{ Params: { serviceId: string }; Querystring: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/directories", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
    const listing = await runtime.providers.get(service.providerType).browseDirectories(
      connection,
      readProviderDirectoryParent(request.query),
      undefined,
      {
        persistConnection: async (nextConnection) => {
          await runtime.repository.refreshActiveEncryptedConnection({
            serviceId: service.id,
            userId: service.userId,
            credentialRevision: service.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-provider-token-refresh",
            事件: "管理员目录浏览期间保存Provider刷新令牌",
            管理员ID: operator.id,
            服务ID: service.id,
            凭据修订: service.credentialRevision,
          });
        },
      },
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-directory-picker",
      事件: "管理员浏览网盘目录",
      管理员ID: operator.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      子目录数量: listing.items.length,
    });
    return listing;
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/connection/validate", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const connection = resolveProviderConnection(
      runtime,
      operator.id,
      service.userId,
      service.providerType,
      requireObject(request.body, "connection", "连接配置"),
    ).connection;
    const result = await runtime.providers.get(service.providerType).validateConnection(connection);
    const currentConnection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, service.userId),
    );
    requireSameCloudDriveAccount(service.providerType, currentConnection, connection);
    return result;
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/connection", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const resolvedConnection = resolveProviderConnection(
      runtime,
      operator.id,
      service.userId,
      service.providerType,
      requireObject(request.body, "connection", "连接配置"),
    );
    const connection = resolvedConnection.connection;
    const adapter = runtime.providers.get(service.providerType);
    await validateProviderAccess(adapter, connection, { fullRoots: [], incrementalRoots: [] });
    const currentConnection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, service.userId),
    );
    requireSameCloudDriveAccount(service.providerType, currentConnection, connection);
    const updated = await runtime.repository.updateConnection({
      serviceId: service.id,
      userId: service.userId,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
    });
    consumeProviderAuthorization(runtime, operator.id, resolvedConnection.authorizationSessionId);
    if (service.providerType === "guangya" && connection.authMode === "official_api") {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "管理员同步光鸭官方API连接并更新服务",
        管理员ID: operator.id,
        目标用户ID: service.userId,
        服务ID: service.id,
      });
    }
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "管理员使用HTTP地址更新Provider连接",
        用户ID: operator.id,
        服务ID: service.id,
        网盘类型: service.providerType,
      });
    }
    await audit(runtime, operator, "update_service_connection", "service", service.id);
    return { service: updated };
  });

  server.post<{ Params: { serviceId: string } }>("/api/v1/admin/services/:serviceId/connection/reconnect", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const adapter = runtime.providers.get(service.providerType);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, service.userId),
    );
    try {
      await validateProviderAccess(adapter, connection, { fullRoots: [], incrementalRoots: [] }, {
        persistConnection: async (nextConnection) => {
          await runtime.repository.refreshActiveEncryptedConnection({
            serviceId: service.id,
            userId: service.userId,
            credentialRevision: service.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-provider-token-refresh",
            事件: "管理员重连期间保存Provider刷新令牌",
            管理员ID: operator.id,
            服务ID: service.id,
            凭据修订: service.credentialRevision,
          });
        },
      });
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-provider-reconnect",
        事件: "管理员使用当前配置重连失败",
        管理员ID: operator.id,
        服务ID: service.id,
        网盘类型: service.providerType,
        错误码: error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "provider_reconnect_failed",
      });
      throw error;
    }
    const updated = await runtime.repository.restoreServiceConnection(service.id, service.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-provider-reconnect",
      事件: "管理员使用当前配置重连成功",
      管理员ID: operator.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      凭据修订: service.credentialRevision,
    });
    await audit(runtime, operator, "reconnect_service_connection", "service", service.id, {
      凭据修订: service.credentialRevision,
    });
    return { service: updated };
  });

  server.put<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/scan-profile", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    if (library.libraryKind === "cloud_aggregate_video") {
      throw new ApiError(409, "aggregate_scan_profile_is_source_scoped", "云聚合扫描路径需要由媒体库所属用户在各来源中分别配置");
    }
    const service = await runtime.repository.getServiceDetail(library.sourceServiceId, library.userId);
    const updateScope = request.body.updateScope === "paths" ? "paths" : "profile";
    const scanProfile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      library.providerType,
      library.dataType,
      runtime.providers.get(library.providerType).descriptor.recommendedScanSettings,
      updateScope === "paths",
    );
    const nextScanProfile = attachLibrarySourceId(scanProfile, library.sourceId);
    const recommendedSettings = runtime.providers.get(library.providerType).descriptor.recommendedScanSettings;
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, library.userId));
    await validateConfiguredScanRoots(runtime.providers.get(library.providerType), connection, nextScanProfile, {
      persistConnection: async (nextConnection) => {
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: service.id,
          userId: library.userId,
          credentialRevision: service.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-flycloud-provider-token-refresh",
          事件: "管理员扫描路径验证期间保存Provider刷新令牌",
          管理员ID: operator.id,
          服务ID: service.id,
          凭据修订: service.credentialRevision,
        });
      },
    });
    const updated = await runtime.repository.updateScanProfile(
      library.id,
      library.userId,
      nextScanProfile,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-scan-concurrency",
      事件: updateScope === "paths" ? "管理员保存媒体库扫描路径并保留任务数" : "管理员保存媒体库任务数",
      管理员ID: operator.id,
      服务ID: service.id,
      媒体库ID: library.id,
      扫描任务数: Number(nextScanProfile.scanDirectoryConcurrency),
      刮削任务数: Number(nextScanProfile.scrapeTaskConcurrency),
      Provider默认扫描任务数: recommendedSettings.scanDirectoryConcurrency.default,
      Provider默认刮削任务数: recommendedSettings.scrapeTaskConcurrency.default,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-scan-path",
      事件: "管理员更新媒体库扫描路径",
      用户ID: operator.id,
      服务ID: service.id,
      媒体库ID: library.id,
      全量路径数: getScanRootsForMode(nextScanProfile, "full").length,
      增量路径数: getScanRootsForMode(nextScanProfile, "incremental").length,
      扫描目录并发: Number(nextScanProfile.scanDirectoryConcurrency ?? 0),
      刮削任务并发: Number(nextScanProfile.scrapeTaskConcurrency ?? 0),
    });
    await audit(runtime, operator, "update_library_scan_profile", "library", library.id, { 服务ID: service.id });
    return { library: updated };
  });

  server.put<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/metadata-profile", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    const profile = validateMetadataProfile(requireObject(request.body, "metadata", "元数据配置"), library.dataType);
    await runtime.aiModels.validateMetadataProfile(profile);
    const updated = await runtime.repository.updateMetadataProfile(
      library.id,
      library.userId,
      profile,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-metadata-profile",
      事件: library.dataType === "music" ? "管理员更新音乐元数据配置" : "管理员更新影视元数据配置",
      管理员ID: operator.id,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      ...(library.dataType === "music"
        ? readMusicMetadataLogFields(profile)
        : readVideoMetadataLogFields(profile)),
    });
    await audit(runtime, operator, "update_library_metadata_profile", "library", library.id);
    return { library: updated };
  });

  /** 管理员手动为媒体库中已有但缺少规格的视频建立独立后台任务。 */
  server.post<{ Params: { libraryId: string } }>("/api/v1/admin/libraries/:libraryId/media-probes/backfill", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    if (library.dataType !== "video") throw new ApiError(409, "media_probe_video_only", "只有影视媒体库可以分析视频规格");
    if (library.status !== "active") throw new ApiError(409, "library_not_active", "请先启用媒体库，再分析已有视频规格");
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-ffprobe-backfill",
      事件: "开始创建已有视频规格后台任务",
      管理员ID: operator.id,
      目标用户ID: library.userId,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
    });
    const aggregateResult = library.libraryKind === "cloud_aggregate_video"
      ? await runtime.repository.enqueueExistingLibraryMediaProbes(library.id, library.userId, operator.id)
      : null;
    const legacyResult = aggregateResult
      ? null
      : await runtime.repository.enqueueExistingServiceMediaProbes(library.sourceServiceId, library.userId, operator.id);
    const jobIds = aggregateResult?.jobIds ?? (legacyResult?.jobId ? [legacyResult.jobId] : []);
    const jobs = await Promise.all(jobIds.map((jobId) => runtime.repository.getJob(jobId)));
    const queuedCount = aggregateResult?.queuedCount ?? legacyResult?.queuedCount ?? 0;
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-ffprobe-backfill",
      事件: "管理员触发已有视频规格分析",
      管理员ID: operator.id,
      目标用户ID: library.userId,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      后台任务ID: jobIds[0] ?? null,
      来源任务数量: jobIds.length,
      入队文件数量: queuedCount,
    });
    await audit(runtime, operator, "backfill_media_probes", "background_job", jobIds[0] ?? library.id, {
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      入队文件数量: queuedCount,
    });
    return reply.status(jobIds.length > 0 ? 202 : 200).send({ job: jobs[0] ?? null, jobs, queuedCount });
  });

  /** 管理员保存任意媒体库的任务完成通知开关。 */
  server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/notification-settings", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    if (typeof request.body.notificationEnabled !== "boolean") {
      throw validationError("notificationEnabled", "任务完成通知开关必须是布尔值");
    }
    const library = await runtime.repository.updateServiceNotificationEnabled(
      request.params.libraryId,
      undefined,
      request.body.notificationEnabled,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-notification",
      事件: "管理员更新媒体库任务通知开关",
      管理员ID: operator.id,
      目标用户ID: library.userId,
      媒体库ID: library.id,
      服务ID: library.sourceServiceId,
      是否启用任务通知: library.notificationEnabled,
    });
    await audit(runtime, operator, "update_library_notification", "library", library.id, {
      是否启用任务通知: library.notificationEnabled,
    });
    return { library };
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/admin/libraries/:libraryId/scan-jobs", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const library = await runtime.repository.getLibrary(request.params.libraryId);
    const profiles = await runtime.repository.getLibraryProfiles(library.id, library.userId);
    const scanMode = request.body.scanMode;
    if (scanMode !== "incremental" && scanMode !== "full") throw validationError("scanMode", "扫描模式无效");
    if (library.status !== "active") throw new ApiError(409, "library_not_active", "请先启用媒体库");
    if (await runtime.repository.findUnfinishedLibraryScanJob(library.id, library.userId)) {
      throw new ApiError(409, "scan_job_conflict", "当前媒体库已有未结束任务，不能重复启动");
    }
    const requestId = requireString(request.body, "requestId", "请求 ID", 200);
    const clientDeviceId = typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId : `admin:${operator.id}`;
    if (library.libraryKind === "cloud_aggregate_video") {
      const readySources = library.sources.filter((source) => source.status === "active"
        && source.connectionStatus === "valid"
        && source.credentialConfigured
        && (source.serviceStatus === null || source.serviceStatus === "active"));
      if (readySources.length === 0) throw new ApiError(409, "library_sources_not_ready", "请先添加并授权至少一个可用来源");
      // 关键变量：管理员触发与用户触发使用同一路径参与规则。
      const scanSources = readySources.filter((source) => {
        const scan = source.configuration.scan;
        return Boolean(scan && typeof scan === "object" && !Array.isArray(scan)
          && getScanRootsForMode(scan as Record<string, unknown>, scanMode).length > 0);
      });
      if (scanSources.length === 0) {
        throw new ApiError(409, "scan_paths_not_configured", `请先为至少一个可用来源配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
      }
      const parent = await runtime.repository.createLibraryScanJob({
        id: randomUUID(), userId: library.userId, libraryId: library.id,
        requestedByUserId: operator.id, requestId, clientDeviceId, scanMode,
        sourceCount: scanSources.length,
      });
      for (const source of scanSources) {
        await runtime.repository.createScanJob({
          jobId: randomUUID(), userId: library.userId, libraryId: library.id,
          librarySourceId: source.id, parentJobId: parent.id,
          requestedByUserId: operator.id, requestId: `${requestId.slice(0, 130)}:${source.id}`,
          clientDeviceId, scanMode, runtimeRevision: "scanner-worker-v1",
          tmdbKeyPoolRevision: runtime.tmdb.revision,
          aiModel: await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile),
          pluginVersions: await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile),
        });
      }
      const aggregateJob = await runtime.repository.refreshLibraryScanJob(parent.id);
      await audit(runtime, operator, "create_aggregate_scan_job", "library_scan_job", parent.id, {
        媒体库ID: library.id,
        来源数量: scanSources.length,
      });
      return reply.status(202).send({ job: aggregateJob });
    }
    if (getScanRootsForMode(profiles.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: library.userId,
      libraryId: library.id,
      librarySourceId: library.sourceId,
      requestedByUserId: operator.id,
      requestId,
      clientDeviceId,
      scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      aiModel: await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile),
      pluginVersions: await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile),
    });
    await audit(runtime, operator, "create_scan_job", "scan_job", job.id, { 媒体库ID: library.id, 服务ID: library.sourceServiceId });
    return reply.status(202).send({ job });
  });

  server.get<{ Params: { libraryId: string; jobId: string } }>(
    "/api/v1/admin/libraries/:libraryId/library-scan-jobs/:jobId",
    async (request) => {
      await requireSuperAdmin(request, runtime.database);
      const existingJob = await runtime.repository.getLibraryScanJob(request.params.jobId);
      if (existingJob.libraryId !== request.params.libraryId) throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      return { job: await runtime.repository.refreshLibraryScanJob(existingJob.id) };
    },
  );

  server.post<{ Params: { libraryId: string; jobId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/libraries/:libraryId/library-scan-jobs/:jobId/control",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const action = request.body.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw validationError("action", "控制动作只支持 pause、resume 或 cancel");
      }
      const job = await runtime.repository.getLibraryScanJob(request.params.jobId);
      if (job.libraryId !== request.params.libraryId) throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      const updatedJob = await runtime.repository.requestLibraryScanJobControl(job.id, job.userId, action);
      if (action !== "resume") {
        for (const child of job.sourceJobs.filter((sourceJob) => sourceJob.status === "running")) {
          runtime.worker.interruptJobControl(child.id, action);
        }
      }
      await notifyFinishedLibraryScanJob(runtime, updatedJob.id, job.userId);
      await audit(runtime, operator, "control_library_scan_job", "library_scan_job", job.id, {
        媒体库ID: job.libraryId,
        控制动作: action,
        来源子任务数量: job.sourceJobs.length,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-scan-parent",
        事件: "管理员控制云聚合扫描父任务",
        管理员ID: operator.id,
        媒体库ID: job.libraryId,
        父任务ID: job.id,
        控制动作: action,
      });
      return { job: updatedJob };
    },
  );

  server.delete<{ Params: { libraryId: string; jobId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/libraries/:libraryId/library-scan-jobs/:jobId",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      requireConfirmation(request.body, request.params.jobId);
      const job = await runtime.repository.getLibraryScanJob(request.params.jobId);
      if (job.libraryId !== request.params.libraryId) throw new ApiError(404, "library_scan_job_not_found", "媒体库扫描任务不存在");
      await runtime.repository.deleteLibraryScanJob(job.id);
      for (const child of job.sourceJobs) await runtime.failureReports.remove(child);
      await audit(runtime, operator, "delete_library_scan_job", "library_scan_job", job.id, {
        媒体库ID: job.libraryId,
        来源子任务数量: job.sourceJobs.length,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-library-scan-parent",
        事件: "管理员删除云聚合扫描父任务",
        管理员ID: operator.id,
        媒体库ID: job.libraryId,
        父任务ID: job.id,
        来源子任务数量: job.sourceJobs.length,
      });
      return reply.status(204).send();
    },
  );

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/status", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") throw validationError("status", "服务状态无效");
    const service = await runtime.repository.updateServiceStatus(request.params.serviceId, undefined, status);
    await audit(runtime, operator, "update_service_status", "service", service.id, { 新状态: status });
    return { service };
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    // 关键变量：删除后无法再读取服务归属，先保存通知需要的用户和服务名称。
    const service = await runtime.repository.getServiceMediaContext(request.params.serviceId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-delete",
      事件: "管理员开始删除云端服务",
      管理员ID: operator.id,
      服务ID: request.params.serviceId,
    });
    try {
      await runtime.repository.deleteService(request.params.serviceId);
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-service-delete",
        事件: "管理员删除云端服务失败",
        管理员ID: operator.id,
        服务ID: request.params.serviceId,
        错误码: error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "service_delete_failed",
      });
      throw error;
    }
    await audit(runtime, operator, "delete_service", "service", request.params.serviceId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-delete",
      事件: "管理员删除云端服务成功",
      管理员ID: operator.id,
      服务ID: request.params.serviceId,
    });
    await runtime.database.createNotificationSafely({
      userId: service.userId,
      category: "security",
      tone: "warning",
      title: "服务已被管理员删除",
      message: `云端服务“${service.displayName}”已由超级管理员“${operator.username}”删除。`,
      actionPath: "/app/services",
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "管理员删除服务",
      message: `超级管理员“${operator.username}”删除了账号“${service.ownerUsername}”的服务“${service.displayName}”。`,
      actionPath: "/admin/services",
      excludeUserId: service.userId,
    });
    return reply.status(204).send();
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/jobs", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const status = typeof request.query.status === "string" ? request.query.status : "";
    const supportedStatuses: JobStatus[] = ["queued", "running", "retry_waiting", "paused", "completed", "failed", "cancelled"];
    if (status && status !== "active" && !supportedStatuses.includes(status as JobStatus)) {
      throw validationError("status", "任务状态筛选值无效");
    }
    const jobType = typeof request.query.jobType === "string" ? request.query.jobType : "";
    if (jobType && jobType !== "scan" && jobType !== "media_probe") {
      throw validationError("jobType", "任务类型筛选值无效");
    }
    return runtime.repository.listJobs({
      userId: typeof request.query.userId === "string" ? request.query.userId : undefined,
      serviceId: typeof request.query.serviceId === "string" ? request.query.serviceId : undefined,
      status: status && status !== "active" ? status as JobStatus : undefined,
      statuses: status === "active" ? ["queued", "running", "retry_waiting", "paused"] : undefined,
      jobType: jobType ? jobType as "scan" | "media_probe" : undefined,
      groupParentJobs: request.query.groupParentJobs === "true",
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { jobId: string }; Querystring: Record<string, unknown> }>("/api/v1/admin/jobs/:jobId/music-tasks", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.getJob(request.params.jobId);
    return listMusicStageTasks(runtime.database.query, job, request.query);
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { job: await runtime.repository.getJob(request.params.jobId) };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/cancel", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.requestJobControl(request.params.jobId, undefined, "cancel");
    const interrupted = job.jobType === "media_probe"
      ? runtime.mediaProbeWorker.interruptJobControl(job.id, "cancel")
      : runtime.worker.interruptJobControl(job.id, "cancel");
    // 规格分析任务可能正处于两个文件之间；没有 ffprobe 可中断时由接口直接完成状态切换。
    const updatedJob = job.jobType === "media_probe" && !interrupted && job.status === "running"
      ? await runtime.repository.applyMediaProbeJobControl(job.id, "cancel")
      : job;
    await audit(runtime, operator, "cancel_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员终止后台任务",
      管理员ID: operator.id,
      任务ID: job.id,
      后台任务类型: job.jobType,
      控制动作: "cancel",
      是否中断运行请求: interrupted,
    });
    return { job: updatedJob };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/pause", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.requestJobControl(request.params.jobId, undefined, "pause");
    const interrupted = job.jobType === "media_probe"
      ? runtime.mediaProbeWorker.interruptJobControl(job.id, "pause")
      : runtime.worker.interruptJobControl(job.id, "pause");
    // 规格分析任务可能正处于两个文件之间；没有 ffprobe 可中断时由接口直接完成状态切换。
    const updatedJob = job.jobType === "media_probe" && !interrupted && job.status === "running"
      ? await runtime.repository.applyMediaProbeJobControl(job.id, "pause")
      : job;
    await audit(runtime, operator, "pause_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员暂停后台任务",
      管理员ID: operator.id,
      任务ID: job.id,
      后台任务类型: job.jobType,
      控制动作: "pause",
      是否中断运行请求: interrupted,
    });
    return { job: updatedJob };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/resume", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.resumeJob(request.params.jobId);
    await audit(runtime, operator, "resume_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员继续后台任务",
      管理员ID: operator.id,
      任务ID: job.id,
      控制动作: "resume",
    });
    return { job };
  });

  server.delete<{ Body: Record<string, unknown> }>("/api/v1/admin/jobs/completed", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, "completed");
    // 管理端与用户端采用相同清理范围，不包含已取消和未结束任务。
    const includeFailed = request.body.includeFailed === true;
    const result = await runtime.repository.deleteCompletedJobs(undefined, includeFailed);
    for (const job of result.scanJobs) await runtime.failureReports.remove(job);
    await audit(runtime, operator, "clear_completed_jobs", "scan_job", null, { deletedCount: result.deletedCount, includeFailed });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-clear",
      事件: includeFailed ? "管理员清除已完成和失败任务" : "管理员清除已完成任务",
      管理员ID: operator.id,
      包含失败任务: includeFailed,
      删除任务数量: result.deletedCount,
    });
    return { deletedCount: result.deletedCount };
  });

  server.delete<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/admin/jobs/:jobId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.jobId);
    const job = await runtime.repository.getJob(request.params.jobId);
    await runtime.repository.deleteScanJob(request.params.jobId);
    if (job.jobType === "scan") await runtime.failureReports.remove(job);
    await audit(runtime, operator, "delete_scan_job", "scan_job", request.params.jobId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-delete",
      事件: "管理员删除后台任务",
      管理员ID: operator.id,
      任务ID: request.params.jobId,
    });
    return reply.status(204).send();
  });

  /** 管理员为失败或已取消任务创建新的关联重试任务，原任务记录保持不变。 */
  server.post<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/admin/jobs/:jobId/retry", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const sourceJob = await runtime.repository.getJob(request.params.jobId);
    if (sourceJob.jobType === "media_probe") {
      const job = await runtime.repository.retryMediaProbeJob(sourceJob.id, undefined, operator.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-media-ffprobe",
        事件: "管理员重试规格后台任务",
        管理员ID: operator.id,
        原任务ID: sourceJob.id,
        新任务ID: job.id,
      });
      await audit(runtime, operator, "retry_media_probe_job", "background_job", job.id, { 原任务ID: sourceJob.id });
      return reply.status(202).send({ job });
    }
    if (sourceJob.dataType === "music") {
      const job = await retryMusicScan(runtime, sourceJob, request.body?.musicStage);
      await audit(runtime, operator, "retry_music_stage", "scan_job", job.id, { 阶段: String(request.body?.musicStage ?? "全部") });
      return reply.status(202).send({ job });
    }
    if (sourceJob.status !== "failed" && sourceJob.status !== "cancelled") {
      throw new ApiError(409, "job_not_retryable", "只有失败或已取消任务可以重试");
    }
    const profiles = await runtime.repository.getLibraryProfiles(sourceJob.libraryId, sourceJob.userId);
    const retriesAiSupplement = sourceJob.snapshot.taskPurpose === "ai_supplement_unmatched";
    const aiModelSnapshot = retriesAiSupplement
      ? await runtime.aiModels.buildUnmatchedSupplementTaskSnapshot(profiles.metadataProfile)
      : await runtime.aiModels.buildTaskSnapshot(profiles.metadataProfile);
    if (retriesAiSupplement && !aiModelSnapshot) {
      throw new ApiError(409, "ai_cleaning_not_enabled", "请先在服务元数据配置中启用 AI 目录文件清洗");
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: sourceJob.userId,
      libraryId: sourceJob.libraryId,
      librarySourceId: sourceJob.librarySourceId,
      requestedByUserId: operator.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId : `admin:${operator.id}`,
      scanMode: sourceJob.scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      aiModel: aiModelSnapshot,
      taskPurpose: retriesAiSupplement ? "ai_supplement_unmatched" : "standard",
      retryOfJobId: sourceJob.id,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(profiles.metadataProfile),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-retry",
      事件: retriesAiSupplement ? "管理员重试AI补充未匹配任务" : "管理员重试扫描任务",
      管理员ID: operator.id,
      原任务ID: sourceJob.id,
      新任务ID: job.id,
      服务ID: job.serviceId,
    });
    await audit(runtime, operator, "retry_scan_job", "scan_job", job.id, { 原任务ID: sourceJob.id });
    return reply.status(202).send({ job });
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/media-probe-failures", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { items: await runtime.repository.listMediaProbeJobFailures(request.params.jobId) };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/jobs/events", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    const jobId = typeof request.query.jobId === "string" ? request.query.jobId : undefined;
    let userId: string | undefined;
    if (typeof request.query.userId === "string") {
      userId = (await runtime.database.findPublicUserById(request.query.userId)).id;
    }
    if (jobId) await runtime.repository.getJob(jobId, userId);
    const headerValue = request.headers["last-event-id"];
    const sequence = Math.max(0, Number.parseInt(String(headerValue ?? request.query.afterSequence ?? 0), 10) || 0);
    streamJobEvents(reply, sequence, (afterSequence) => runtime.repository.listJobEvents({
      userId,
      jobId,
      afterSequence,
      limit: 200,
    }));
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/catalog/items", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const userId = typeof request.query.userId === "string" ? request.query.userId : undefined;
    const serviceId = typeof request.query.serviceId === "string" ? request.query.serviceId : undefined;
    const libraryId = typeof request.query.libraryId === "string" ? request.query.libraryId : undefined;
    if (!userId && !serviceId && !libraryId) {
      throw validationError("userId", "全局海报墙必须指定用户、服务或媒体库范围");
    }
    const sortValue = request.query.sort;
    return runtime.repository.listCatalogItems({
      userId,
      serviceId,
      libraryId,
      mediaType: typeof request.query.mediaType === "string" ? request.query.mediaType as MediaType : undefined,
      itemType: typeof request.query.itemType === "string" ? request.query.itemType : undefined,
      matchState: typeof request.query.matchState === "string" ? request.query.matchState as MatchState : undefined,
      search: typeof request.query.search === "string" ? request.query.search : undefined,
      sort: sortValue === "title_asc"
        || sortValue === "year_desc"
        || sortValue === "premiere_date_desc"
        ? sortValue
        : "created_desc",
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    return { item: await hydrateRealtimeVideoDetails(runtime, item) };
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/children", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { items: await runtime.repository.listCatalogChildren(request.params.itemId) };
  });

  /** 管理端返回音乐专辑或歌曲关联的艺术家。 */
  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/artists", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    const artists = await runtime.repository.listCatalogMusicArtists(item.id);
    request.log.info({
      日志关键字: "codex-flycloud-helper-music-album-detail",
      事件: "管理员读取音乐条目关联艺术家",
      媒体条目ID: item.id,
      媒体条目类型: item.itemType,
      艺术家数量: artists.length,
    });
    return { items: artists };
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/paths", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { items: await runtime.repository.listCatalogItemPaths(request.params.itemId) };
  });

  server.get<{
    Params: { itemId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/admin/catalog/items/:itemId/manual-match/search", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    return {
      items: await searchManualVideoMatches(runtime, item, {
        query: request.query.query,
        mediaType: request.query.mediaType,
        year: request.query.year,
      }),
    };
  });

  server.post<{
    Params: { itemId: string };
    Body: Record<string, unknown>;
  }>("/api/v1/admin/catalog/items/:itemId/manual-match", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    const updatedItem = await applyManualVideoMatch(runtime, item, {
      mediaType: request.body.mediaType,
      tmdbId: request.body.tmdbId,
    });
    await audit(runtime, operator, "manual_match_media_item", "media_item", item.id, {
      匹配类型: request.body.mediaType,
      TMDB编号: request.body.tmdbId,
      所属用户: item.ownerUsername,
    });
    return { item: updatedItem };
  });

  server.post<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/manual-match/clear", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    const updatedItem = await clearManualVideoMatch(runtime, item);
    await audit(runtime, operator, "clear_media_item_match", "media_item", item.id, {
      所属用户: item.ownerUsername,
    });
    return { item: updatedItem };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/audit-logs", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const pagination = readPagination(request.query);
    return runtime.database.listAuditLogs(pagination.limit, pagination.offset);
  });
}
