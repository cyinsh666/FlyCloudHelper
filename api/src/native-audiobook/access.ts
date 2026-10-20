import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createUsernameLookup, hashSessionToken, verifyPassword } from "../auth.js";
import { parseJsonObject } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { nativeRequestBasePath } from "./path.js";
import { NativeStore, nativeHash, nativeKey, nativeScope } from "./store.js";
import type { NativeAccount, NativeAuthSession, NativeContext, NativeDeviceInfo, NativeLibraryAccess, NativeQuery, NativeService } from "./types.js";

/** 入口实体使用全局稳定 ID；后缀单独索引，可改地址而不改身份。 */
export function nativeServiceKey(serviceId: string): string { return nativeKey("svc", serviceId); }

/** 账号按入口前缀存储，支持服务内有界分页。 */
export function nativeAccountPrefix(serviceId: string): string { return `ab1:acct:${nativeHash(serviceId)}:`; }

/** 账号 ID 不包含用户名，改名不改变进度身份。 */
export function nativeAccountKey(serviceId: string, accountId: string): string { return `${nativeAccountPrefix(serviceId)}${nativeHash(accountId)}`; }

/** 单账号设备认证会话的范围索引。 */
export function nativeAuthSessionPrefix(serviceId: string, accountId: string): string { return `ab1:auth:${nativeScope(serviceId, accountId)}:`; }

/** 登录会话主键与播放会话主键分开。 */
export function nativeAuthSessionKey(serviceId: string, accountId: string, sessionId: string): string { return `${nativeAuthSessionPrefix(serviceId, accountId)}${nativeHash(sessionId)}`; }

/** 令牌索引只保留摘要，用于常数次查找所属认证会话。 */
export function nativeTokenKey(tokenHash: string): string { return nativeKey("token", tokenHash); }

/** 地址唯一索引保留实际查询值，防止散列碰撞静默串服务。 */
export function nativeSuffixKey(pathSuffix: string): string { return nativeKey("suffix", pathSuffix.toLowerCase()); }

/** 用户名只在当前入口内查重，大小写规则沿用已有登录方式。 */
export function nativeUsernameKey(serviceId: string, username: string): string { return nativeKey("username", serviceId, createUsernameLookup(username)); }

/** 地址后缀支持中文，与现有库协议地址的编辑体验一致。 */
export function validateNativePathSuffix(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 64 || !/^[\p{L}\p{N}_-]+$/u.test(value.trim())) throw validationError("PathSuffix", "地址后缀须为 1 至 64 个文字、数字、短横线或下划线");
  return value.trim();
}

/** 账号投影不包含密码校验值及内部凭据修订号。 */
export function nativePublicAccount(account: NativeAccount): Record<string, unknown> {
  return { AccountId: account.AccountId, ServiceId: account.ServiceId, Username: account.Username, DisplayName: account.DisplayName, AllowedLibraryIds: account.AllowedLibraryIds, Enabled: account.Enabled, CanDownload: account.CanDownload, PermissionsRevision: account.PermissionsRevision, CreatedAt: account.CreatedAt, UpdatedAt: account.UpdatedAt };
}

/** 设备列表不能返回访问令牌摘要或其他账号资料。 */
export function nativePublicAuthSession(session: NativeAuthSession): Record<string, unknown> {
  return { AuthSessionId: session.AuthSessionId, DeviceInfo: session.DeviceInfo, CreatedAt: session.CreatedAt, ExpiresAt: session.ExpiresAt };
}

/** 校验小型登录设备对象，不接收额外的上游凭据。 */
function readDeviceInfo(value: unknown): NativeDeviceInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("DeviceInfo", "请提供客户端设备信息");
  const input = value as Record<string, unknown>;
  const result: NativeDeviceInfo = { DeviceId: "", DeviceName: "", Client: "", Version: "" };
  for (const key of ["DeviceId", "DeviceName", "Client", "Version"] as const) {
    const field = input[key];
    if (typeof field !== "string" || !field.trim() || [...field].length > 128) throw validationError(`DeviceInfo.${key}`, "设备信息必须为 1 至 128 个字符");
    result[key] = field;
  }
  return result;
}

/** 原生入口账号与管理登录、ABS 账号、网盘凭据完全分离。 */
export class NativeAccess {
  public constructor(private readonly runtime: ApiRuntime, private readonly store: NativeStore) {}

  /** 通过唯一后缀索引读取入口，空库或全部库失效时不静默改绑。 */
  public async getServiceBySuffix(pathSuffix: string): Promise<NativeService> {
    const suffix = validateNativePathSuffix(pathSuffix);
    const index = await this.store.get<{ ServiceId: string; Lookup: string }>(nativeSuffixKey(suffix));
    if (!index || index.value.Lookup !== suffix.toLowerCase()) throw new ApiError(404, "service_unavailable", "原生听书服务不存在或未启用");
    const row = await this.store.get<NativeService>(nativeServiceKey(index.value.ServiceId));
    if (!row || row.value.ServiceId !== index.value.ServiceId || row.value.PathSuffix.toLowerCase() !== suffix.toLowerCase()) throw new ApiError(404, "service_unavailable", "原生听书服务不存在或未启用");
    await this.assertServiceAvailable(row.value);
    return row.value;
  }

  /** 校验入口所有者及至少一个有效实际库，不依赖遗留的引用数组。 */
  private async assertServiceAvailable(service: NativeService, query: NativeQuery = this.runtime.database.query): Promise<void> {
    if (!service.Enabled || !service.LibraryIds.length || service.LibraryIds.length > 100) throw new ApiError(404, "service_unavailable", "原生听书服务未启用或暂无可用媒体库");
    const owner = await query("user_accounts").where({ id: service.OwnerUserId, status: "active" }).select("id").first();
    const library = await query("media_libraries").where({ user_id: service.OwnerUserId, data_type: "audiobook", status: "active" }).whereIn("id", service.LibraryIds).select("id").first();
    if (!owner || !library) throw new ApiError(404, "service_unavailable", "原生听书服务暂无可用媒体库");
  }

  /** 配置交集是候选范围，实际库存在性和归属由 assertLibrary 再验证。 */
  public visibleLibraryIds(context: NativeContext): string[] {
    const allowed = new Set(context.account.AllowedLibraryIds);
    return context.service.LibraryIds.filter((id) => allowed.has(id));
  }

  /** 每次访问重新校验当前账号、入口范围和实际库生命周期。 */
  public async assertLibrary(context: NativeContext, libraryId: string): Promise<NativeLibraryAccess> {
    const fresh = await this.refreshContext(context);
    if (!this.visibleLibraryIds(fresh).includes(libraryId)) throw new ApiError(404, "library_unavailable", "当前媒体库不可访问");
    const row = await this.runtime.database.query("media_libraries").where({ id: libraryId, user_id: fresh.service.OwnerUserId, data_type: "audiobook", status: "active" }).select("id", "user_id", "display_name", "data_type", "library_kind", "status").first();
    if (!row) throw new ApiError(404, "library_unavailable", "当前媒体库不可访问");
    if (row.library_kind === "content_source_audiobook") await this.sourceVersion(fresh, libraryId);
    return { id: String(row.id), userId: String(row.user_id), displayName: String(row.display_name), dataType: "audiobook", libraryKind: row.library_kind as NativeLibraryAccess["libraryKind"], status: "active" };
  }

  /** 请求只接受原生 Bearer，不读取管理 Cookie 或查询字符串令牌。 */
  public async requireContext(request: FastifyRequest, pathSuffix: string): Promise<NativeContext> {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(authorization) : null;
    if (!match) throw new ApiError(401, "authentication_required", "请先登录原生听书服务");
    const tokenHash = hashSessionToken(match[1]!);
    const token = await this.store.get<{ ServiceId: string; AccountId: string; AuthSessionId: string }>(nativeTokenKey(tokenHash));
    if (!token) throw new ApiError(401, "session_revoked", "登录已失效，请重新登录");
    const service = await this.getServiceBySuffix(pathSuffix);
    if (token.value.ServiceId !== service.ServiceId) throw new ApiError(401, "session_revoked", "当前令牌不属于此听书服务");
    const account = await this.store.get<NativeAccount>(nativeAccountKey(service.ServiceId, token.value.AccountId));
    const session = await this.store.get<NativeAuthSession>(nativeAuthSessionKey(service.ServiceId, token.value.AccountId, token.value.AuthSessionId));
    if (!account || !session || session.value.AuthSessionId !== token.value.AuthSessionId || !this.equalDigest(session.value.TokenHash, tokenHash)) throw new ApiError(401, "session_revoked", "登录已失效，请重新登录");
    const basePath = await nativeRequestBasePath(this.runtime, request, pathSuffix);
    return this.refreshContext({ service, account: account.value, authSession: session.value, basePath });
  }

  /** 长流、排队和共享取址后也能重新验证身份，不需要保留原始访问令牌。 */
  public async refreshContext(context: NativeContext, query?: NativeQuery): Promise<NativeContext> {
    if (query) {
      // 关键变量：固定入口→账号→认证会话顺序，撤销和状态提交之间不能插入新的旧权限写入。
      await this.store.lock(nativeServiceKey(context.service.ServiceId), query);
      await this.store.lock(nativeAccountKey(context.service.ServiceId, context.account.AccountId), query);
      await this.store.lock(nativeAuthSessionKey(context.service.ServiceId, context.account.AccountId, context.authSession.AuthSessionId), query);
    }
    const [service, account, session] = await Promise.all([
      this.store.get<NativeService>(nativeServiceKey(context.service.ServiceId), query),
      this.store.get<NativeAccount>(nativeAccountKey(context.service.ServiceId, context.account.AccountId), query),
      this.store.get<NativeAuthSession>(nativeAuthSessionKey(context.service.ServiceId, context.account.AccountId, context.authSession.AuthSessionId), query),
    ]);
    if (!service || !account || !session || account.value.ServiceId !== service.value.ServiceId || account.value.AccountId !== context.account.AccountId || session.value.ServiceId !== service.value.ServiceId || session.value.AccountId !== account.value.AccountId || session.value.AuthSessionId !== context.authSession.AuthSessionId || !this.equalDigest(session.value.TokenHash, context.authSession.TokenHash)) throw new ApiError(401, "session_revoked", "登录已失效，请重新登录");
    if (Date.parse(session.value.ExpiresAt) <= Date.now()) throw new ApiError(401, "token_expired", "登录已到期，请重新登录");
    if (!account.value.Enabled || account.value.CredentialRevision !== session.value.AccountCredentialRevision || service.value.CredentialRevision !== session.value.ServiceCredentialRevision) throw new ApiError(401, "session_revoked", "登录已失效，请重新登录");
    await this.assertServiceAvailable(service.value, query);
    return { service: service.value, account: account.value, authSession: session.value, basePath: context.basePath };
  }

  /** 状态事务内复核当前授权，复用事务连接避免 SQLite 单连接等待自身。 */
  public async assertTransactionContext(context: NativeContext, libraryId: string, query: NativeQuery, expectedSourceVersion?: string | null): Promise<NativeContext> {
    const fresh = await this.refreshContext(context, query);
    if (!this.visibleLibraryIds(fresh).includes(libraryId)) throw new ApiError(404, "library_unavailable", "当前媒体库不可访问");
    let libraryQuery = query("media_libraries").where({ id: libraryId, user_id: fresh.service.OwnerUserId, data_type: "audiobook", status: "active" }).select("id", "library_kind");
    if (this.runtime.database.databaseType !== "sqlite") libraryQuery = libraryQuery.forUpdate();
    const row = await libraryQuery.first();
    if (!row) throw new ApiError(404, "library_unavailable", "当前媒体库不可访问");
    const sourceVersion = row.library_kind === "content_source_audiobook" ? await this.sourceVersion(fresh, libraryId, query, true) : null;
    if (expectedSourceVersion !== undefined && expectedSourceVersion !== sourceVersion) throw new ApiError(409, "source_changed", "听书来源已变化，请重新取址");
    return fresh;
  }

  /** 按目录写入的固定顺序核对源绑定、版本和启停，网络等待后可比较此标识。 */
  public async sourceVersion(context: NativeContext, libraryId: string, query: NativeQuery = this.runtime.database.query, lock = false): Promise<string> {
    const rowLocks = lock && this.runtime.database.databaseType !== "sqlite";
    let bindingQuery = query("content_source_libraries").where({ library_id: libraryId, user_id: context.service.OwnerUserId }).select("instance_id", "library_source_id");
    if (rowLocks) bindingQuery = bindingQuery.forUpdate();
    const binding = await bindingQuery.first();
    if (!binding) throw new ApiError(409, "audiobook_source_unavailable", "听书媒体库绑定已改变");
    let instanceQuery = query("content_source_instances").where({ id: binding.instance_id, user_id: context.service.OwnerUserId, status: "active" }).select("id", "plugin_id", "plugin_version", "updated_at");
    if (rowLocks) instanceQuery = instanceQuery.forUpdate();
    const instance = await instanceQuery.first();
    if (!instance) throw new ApiError(409, "audiobook_source_unavailable", "听书源实例已停用");
    let pluginQuery = query("content_source_plugins").where({ plugin_id: instance.plugin_id, version: instance.plugin_version, status: "enabled" }).select("plugin_id", "version", "updated_at", "manifest_json");
    if (rowLocks) pluginQuery = pluginQuery.forUpdate();
    const plugin = await pluginQuery.first();
    if (!plugin || parseJsonObject(plugin.manifest_json).mediaType !== "audiobook") throw new ApiError(409, "content_plugin_disabled", "听书源插件已停用或类型不符");
    let sourceQuery = query("library_sources").where({ id: binding.library_source_id, user_id: context.service.OwnerUserId, library_id: libraryId, source_mode: "content_source", status: "active" }).select("id", "credential_revision", "configuration_json");
    if (rowLocks) sourceQuery = sourceQuery.forUpdate();
    const source = await sourceQuery.first();
    if (!source || parseJsonObject(source.configuration_json).instanceId !== instance.id) throw new ApiError(409, "audiobook_source_unavailable", "听书库来源已停用或绑定已改变");
    return nativeHash(JSON.stringify([binding.instance_id, binding.library_source_id, instance.plugin_id, instance.plugin_version, instance.updated_at, plugin.updated_at, source.credential_revision, source.configuration_json]));
  }

  /** 固定长度摘要比较，不在异常或日志里附带访问令牌。 */
  private equalDigest(left: string, right: string): boolean {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
  }

  /** 用户名密码登录只创建一条设备会话，不返回整包用户状态。 */
  public async authenticate(pathSuffix: string, body: unknown, basePath: string): Promise<Record<string, unknown>> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw validationError("body", "登录参数格式无效");
    const input = body as Record<string, unknown>;
    const service = await this.getServiceBySuffix(pathSuffix);
    const username = typeof input.Username === "string" && [...input.Username].length <= 255 ? input.Username : "";
    const lookup = await this.store.get<{ ServiceId: string; AccountId: string; Lookup: string }>(nativeUsernameKey(service.ServiceId, username));
    const account = lookup && lookup.value.ServiceId === service.ServiceId && lookup.value.Lookup === createUsernameLookup(username) ? await this.store.get<NativeAccount>(nativeAccountKey(service.ServiceId, lookup.value.AccountId)) : null;
    if (!account || !account.value.Enabled || typeof input.Password !== "string" || [...input.Password].length > 256 || !(await verifyPassword(account.value.PasswordHash, input.Password))) throw new ApiError(401, "invalid_credentials", "用户名或密码错误");
    const deviceInfo = readDeviceInfo(input.DeviceInfo);
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const auth: NativeAuthSession = { AuthSessionId: randomUUID(), ServiceId: service.ServiceId, AccountId: account.value.AccountId, TokenHash: hashSessionToken(token), AccountCredentialRevision: account.value.CredentialRevision, ServiceCredentialRevision: service.CredentialRevision, DeviceInfo: deviceInfo, CreatedAt: now, ExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
    await this.store.transaction(async (query) => {
      const currentService = await this.store.get<NativeService>(nativeServiceKey(service.ServiceId), query);
      const currentAccount = await this.store.get<NativeAccount>(nativeAccountKey(service.ServiceId, account.value.AccountId), query);
      if (!currentService?.value.Enabled || !currentAccount?.value.Enabled || currentService.value.CredentialRevision !== auth.ServiceCredentialRevision || currentAccount.value.CredentialRevision !== auth.AccountCredentialRevision || currentAccount.value.PasswordHash !== account.value.PasswordHash) throw new ApiError(401, "invalid_credentials", "账号状态已变化，请重新登录");
      // 关键变量：登录与删除、改密并发时争用同一行版本，避免清理结束后再落孤儿会话。
      await this.store.put(nativeServiceKey(service.ServiceId), currentService.value, currentService.revision, query);
      await this.store.put(nativeAccountKey(service.ServiceId, account.value.AccountId), currentAccount.value, currentAccount.revision, query);
      await this.store.put(nativeAuthSessionKey(service.ServiceId, auth.AccountId, auth.AuthSessionId), auth, null, query);
      await this.store.put(nativeTokenKey(auth.TokenHash), { ServiceId: service.ServiceId, AccountId: auth.AccountId, AuthSessionId: auth.AuthSessionId }, null, query);
    });
    const context = await this.refreshContext({ service, account: account.value, authSession: auth, basePath });
    return { AccessToken: token, AuthSessionId: auth.AuthSessionId, ExpiresAt: auth.ExpiresAt, ...await this.me(context) };
  }

  /** 当前身份只返回权限摘要和同步起点，库及进度独立分页读取。 */
  public async me(context: NativeContext): Promise<Record<string, unknown>> {
    const fresh = await this.refreshContext(context);
    const sequence = await this.store.get<{ latestRevision?: string }>(`ab1:seq:${nativeScope(fresh.service.ServiceId, fresh.account.AccountId)}`);
    return { ServiceId: fresh.service.ServiceId, User: { AccountId: fresh.account.AccountId, Username: fresh.account.Username, DisplayName: fresh.account.DisplayName }, Permissions: { CanStream: true, CanDownload: fresh.account.CanDownload, LibraryAccess: "Assigned" }, PermissionsRevision: `${fresh.service.PermissionsRevision}:${fresh.account.PermissionsRevision}`, SyncRevision: sequence?.value.latestRevision ?? "0" };
  }

  /** 注销当前认证会话，其播放会话之后无法通过身份复核。 */
  public async logout(context: NativeContext): Promise<void> {
    await this.store.transaction(async (query) => this.removeAuthSession(context.authSession, query));
  }

  /** 删除设备记录和令牌反查索引，可供管理端撤销单个设备。 */
  public async removeAuthSession(session: NativeAuthSession, query: NativeQuery): Promise<void> {
    const key = nativeAuthSessionKey(session.ServiceId, session.AccountId, session.AuthSessionId);
    const current = await this.store.get<NativeAuthSession>(key, query);
    if (current) await this.store.remove(key, current.revision, query);
    const tokenKey = nativeTokenKey(session.TokenHash);
    const token = await this.store.get(tokenKey, query);
    if (token) await this.store.remove(tokenKey, token.revision, query);
  }
}
