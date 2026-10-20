import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createUsernameLookup, hashPassword, validatePassword, validateUsername } from "../auth.js";
import type { PublicUserRecord } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { NativeAccess, nativeAccountKey, nativeAccountPrefix, nativeAuthSessionKey, nativeAuthSessionPrefix, nativePublicAccount, nativePublicAuthSession, nativeServiceKey, nativeSuffixKey, nativeUsernameKey, validateNativePathSuffix } from "./access.js";
import { NativeStore, nativeHash, nativeScope } from "./store.js";
import type { NativeAccount, NativeAuthSession, NativeQuery, NativeService, NativeStored, NativeStoredRow } from "./types.js";
import { appendNativePermissionChange } from "./user-state.js";

/** 用户入口索引只存稳定 ID，实际配置始终从主记录读取。 */
function ownerServicePrefix(ownerUserId: string): string { return `ab1:owner:${nativeHash(ownerUserId)}:`; }

/** 所有权索引和入口实体随同一事务维护。 */
function ownerServiceKey(service: NativeService): string { return `${ownerServicePrefix(service.OwnerUserId)}${nativeHash(service.ServiceId)}`; }

/** 单库设置页按实际库定位入口，不扫描所有用户或所有入口。 */
function libraryServicePrefix(libraryId: string): string { return `ab1:libsvc:${nativeHash(libraryId)}:`; }

/** 同一实际库可以被多个原生入口引用，索引只存关联身份。 */
function libraryServiceKey(libraryId: string, serviceId: string): string { return `${libraryServicePrefix(libraryId)}${nativeHash(serviceId)}`; }

/** 请求对象限制为普通 JSON 对象，不把数组当配置。 */
function readBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("body", "请求参数必须为对象");
  return value as Record<string, unknown>;
}

/** 配置布尔值采用明确类型，避免字符串 false 被当真。 */
function optionalBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (body[key] === undefined) return fallback;
  if (typeof body[key] !== "boolean") throw validationError(key, "开关必须为布尔值");
  return body[key] as boolean;
}

/** 名称只做必要的首尾空白处理，并限制单条配置体积。 */
function readName(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 128) throw validationError(key, "名称须为 1 至 128 个字符");
  return value.trim();
}

/** 入口和账号的库授权都是有界的显式集合。 */
function readLibraryIds(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && !value.length) || value.some((id) => typeof id !== "string" || !id || id.length > 128)) throw validationError("LibraryIds", "请指定最多 100 个有效媒体库");
  const ids = [...new Set(value as string[])];
  if (ids.length !== value.length) throw validationError("LibraryIds", "媒体库不能重复选择");
  return ids;
}

/** 分页参数严格有界，不支持 offset 或请求全部记录。 */
function readPage(query: unknown, scope: string, prefix: string): { limit: number; after?: string } {
  const input = query && typeof query === "object" ? query as Record<string, unknown> : {};
  const limit = input.limit === undefined ? 30 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "invalid_limit", "分页数量必须在 1 到 100 之间");
  if (input.cursor === undefined) return { limit };
  if (typeof input.cursor !== "string" || input.cursor.length > 2048) throw new ApiError(400, "invalid_cursor", "分页游标无效");
  try {
    const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { scope?: unknown; after?: unknown };
    if (cursor.scope !== scope || typeof cursor.after !== "string" || !cursor.after.startsWith(prefix) || cursor.after.length > 100) throw new Error("invalid cursor");
    return { limit, after: cursor.after };
  } catch { throw new ApiError(400, "invalid_cursor", "分页游标无效或不属于当前列表"); }
}

/** 下一页游标绑定当前账号和列表，不携带敏感参数。 */
function pageResponse<T>(items: T[], rows: Array<NativeStoredRow<unknown>>, limit: number, scope: string): Record<string, unknown> {
  const hasMore = rows.length > limit;
  const last = rows[Math.min(limit, rows.length) - 1];
  return { Items: items, HasMore: hasMore, NextCursor: hasMore && last ? Buffer.from(JSON.stringify({ scope, after: last.key })).toString("base64url") : null, PreviousCursor: null, TotalCount: null };
}

/** 递增内部凭据版本，不让已撤销令牌在重新启用后恢复。 */
function nextCredentialRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, "native_revision_exhausted", "凭据版本无法继续更新");
  return value + 1;
}

/** 服务公开配置不返回内部令牌或密码资料。 */
function publicService(service: NativeService, publicBaseUrl: string | null = null): Record<string, unknown> {
  const path = `/a/${encodeURIComponent(service.PathSuffix)}`;
  return { ServiceId: service.ServiceId, OwnerUserId: service.OwnerUserId, Name: service.Name, Mode: service.Mode, PathSuffix: service.PathSuffix, Path: path, Url: publicBaseUrl ? `${publicBaseUrl}${path}` : null, LibraryIds: service.LibraryIds, Enabled: service.Enabled, RelayPlaybackEnabled: service.RelayPlaybackEnabled, PermissionsRevision: service.PermissionsRevision, CreatedAt: service.CreatedAt, UpdatedAt: service.UpdatedAt, Deleting: service.Deleting === true };
}

/** 管理请求只能维护自己的入口，超级管理员沿用既有权限规则。 */
async function ownedService(runtime: ApiRuntime, store: NativeStore, request: FastifyRequest, serviceId: string, allowDeleting = false): Promise<{ user: PublicUserRecord; row: NativeStored<NativeService> }> {
  const user = await requireRequestUser(request, runtime.database);
  let row = await store.get<NativeService>(nativeServiceKey(serviceId));
  if (!row || row.value.ServiceId !== serviceId || (user.role !== "super_admin" && row.value.OwnerUserId !== user.id)) throw new ApiError(404, "service_unavailable", "原生听书服务不存在");
  if (row.value.Deleting && !allowDeleting) throw new ApiError(409, "service_deleting", "原生听书服务正在删除，请稍后重试");
  if (row.value.LibraryGrantCleanupPending && !row.value.Deleting) {
    await completeLibraryGrantCleanup(store, serviceId);
    row = await store.get<NativeService>(nativeServiceKey(serviceId));
    if (!row) throw new ApiError(404, "service_unavailable", "原生听书服务不存在");
  }
  return { user, row };
}

/** 账号归属始终用入口 ID 限定，不按同名账号跨入口寻找。 */
async function ownedAccount(store: NativeStore, serviceId: string, accountId: string, allowDeleting = false): Promise<NativeStored<NativeAccount>> {
  const row = await store.get<NativeAccount>(nativeAccountKey(serviceId, accountId));
  if (!row || row.value.ServiceId !== serviceId || row.value.AccountId !== accountId) throw new ApiError(404, "account_unavailable", "听书账号不存在");
  if (row.value.Deleting && !allowDeleting) throw new ApiError(409, "account_deleting", "听书账号正在删除，请稍后重试");
  return row;
}

/** 管理端校验每个实际库的归属；一个入口不跨不同云助手用户拼库。 */
async function validateLibraries(runtime: ApiRuntime, user: PublicUserRecord, ids: string[], requiredOwner?: string): Promise<string> {
  let builder = runtime.database.query("media_libraries").whereIn("id", ids).select("id", "user_id", "data_type");
  if (user.role !== "super_admin") builder = builder.where({ user_id: user.id });
  const rows = await builder;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  let owner = requiredOwner;
  for (const id of ids) {
    const library = byId.get(id);
    if (!library) throw new ApiError(404, "library_unavailable", "媒体库不存在或无权管理");
    if (library.data_type !== "audiobook") throw validationError("LibraryIds", "原生听书只能关联有声书媒体库");
    const libraryOwner = String(library.user_id);
    if (owner !== undefined && owner !== libraryOwner) throw validationError("LibraryIds", "同一入口的媒体库须属于同一个云助手用户");
    owner = libraryOwner;
  }
  return owner ?? user.id;
}

/** 关联模式只控制入口范围，不复制库和插件。 */
function readMode(value: unknown, ids: string[]): NativeService["Mode"] {
  if (value !== "SingleLibrary" && value !== "MultiLibrary") throw validationError("Mode", "请选择单库或多库入口模式");
  if (value === "SingleLibrary" && ids.length !== 1) throw validationError("LibraryIds", "独立入口必须只关联一个媒体库");
  return value;
}

/** 事务内复核入口生命周期，避免删除标记后继续新增账号。 */
async function currentService(store: NativeStore, serviceId: string, query: NativeQuery): Promise<NativeStored<NativeService>> {
  const row = await store.get<NativeService>(nativeServiceKey(serviceId), query);
  if (!row || row.value.Deleting) throw new ApiError(409, "service_unavailable", "听书入口已删除或正在删除");
  if (row.value.LibraryGrantCleanupPending) throw new ApiError(409, "service_permissions_changed", "入口正在清理旧授权，请稍后重试");
  // 关键变量：同值 CAS 仅锁定配置行，防止新账号提交越过并发入口删除。
  const revision = await store.put(nativeServiceKey(serviceId), row.value, row.revision, query);
  return { value: row.value, revision };
}

/** 被移除的库授权必须清理，后续重新关联该库也不会恢复旧授权。 */
async function completeLibraryGrantCleanup(store: NativeStore, serviceId: string): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const candidates = await store.scan<NativeAccount>(nativeAccountPrefix(serviceId), { after, limit: 20 });
    if (!candidates.length) break;
    await store.transaction(async (query) => {
      const service = await store.get<NativeService>(nativeServiceKey(serviceId), query);
      if (!service || service.value.Deleting || !service.value.LibraryGrantCleanupPending) throw new ApiError(409, "service_permissions_changed", "入口状态已变化，请刷新后重试");
      for (const candidate of candidates) {
        const account = await store.get<NativeAccount>(candidate.key, query);
        if (!account || account.value.Deleting) continue;
        const ids = account.value.AllowedLibraryIds.filter((id) => service.value.LibraryIds.includes(id));
        if (ids.length === account.value.AllowedLibraryIds.length) continue;
        const updated = { ...account.value, AllowedLibraryIds: ids, PermissionsRevision: randomUUID(), UpdatedAt: new Date().toISOString() };
        await store.put(candidate.key, updated, account.revision, query);
        await appendNativePermissionChange(store, service.value, updated, query);
      }
    });
    after = candidates[candidates.length - 1]!.key;
  }
  await store.transaction(async (query) => {
    const service = await store.get<NativeService>(nativeServiceKey(serviceId), query);
    if (service?.value.LibraryGrantCleanupPending && !service.value.Deleting) await store.put(nativeServiceKey(serviceId), { ...service.value, LibraryGrantCleanupPending: false }, service.revision, query);
  });
}

/** 有界清理原生私有前缀，不碰实际媒体目录及其他协议状态。 */
async function purgePrefix(store: NativeStore, prefix: string): Promise<void> {
  for (;;) {
    const rows = await store.scan(prefix, { limit: 100 });
    if (!rows.length) return;
    await store.transaction(async (query) => {
      for (const row of rows) {
        const current = await store.get(row.key, query);
        if (current) await store.remove(row.key, current.revision, query);
      }
    });
  }
}

/** 删除账号先撤销写入资格，再分批清理，失败后可按原 ID 继续。 */
async function deleteAccountData(store: NativeStore, access: NativeAccess, serviceId: string, accountId: string): Promise<void> {
  const key = nativeAccountKey(serviceId, accountId);
  await store.transaction(async (query) => {
    const row = await store.get<NativeAccount>(key, query);
    if (row && !row.value.Deleting) await store.put(key, { ...row.value, Enabled: false, Deleting: true, CredentialRevision: nextCredentialRevision(row.value.CredentialRevision), UpdatedAt: new Date().toISOString() }, row.revision, query);
  });
  for (;;) {
    const sessions = await store.scan<NativeAuthSession>(nativeAuthSessionPrefix(serviceId, accountId), { limit: 100 });
    if (!sessions.length) break;
    await store.transaction(async (query) => {
      for (const row of sessions) await access.removeAuthSession(row.value, query);
    });
  }
  const scope = nativeScope(serviceId, accountId);
  // 关键变量：仅清理这一入口账号的原生小对象和有序索引。
  for (const kind of ["p", "cs", "bc", "ci", "f", "fi", "bm", "hi", "ps", "ev", "id", "gc", "chg"]) await purgePrefix(store, `ab1:${kind}:${scope}:`);
  await store.transaction(async (query) => {
    const sequenceKey = `ab1:seq:${scope}`;
    const sequence = await store.get(sequenceKey, query);
    if (sequence) await store.remove(sequenceKey, sequence.revision, query);
    const row = await store.get<NativeAccount>(key, query);
    if (!row) return;
    const usernameKey = nativeUsernameKey(serviceId, row.value.Username);
    const username = await store.get<{ AccountId: string }>(usernameKey, query);
    if (username?.value.AccountId === accountId) await store.remove(usernameKey, username.revision, query);
    await store.remove(key, row.revision, query);
  });
}

/** 注册原生入口、账号及设备会话的管理接口，不接受听书客户端令牌。 */
export async function registerNativeAudiobookManagement(server: FastifyInstance, runtime: ApiRuntime, store: NativeStore, access: NativeAccess): Promise<void> {
  const root = "/api/v1/audiobook-services";

  server.get(root, async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const input = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const libraryId = input.libraryId;
    if (libraryId !== undefined) {
      if (typeof libraryId !== "string" || !libraryId || libraryId.length > 128) throw validationError("libraryId", "媒体库 ID 无效");
      await validateLibraries(runtime, user, [libraryId]);
    }
    const prefix = typeof libraryId === "string" ? libraryServicePrefix(libraryId) : user.role === "super_admin" ? "ab1:svc:" : ownerServicePrefix(user.id);
    const scope = nativeHash(`${user.id}:services:${prefix}`);
    const page = readPage(request.query, scope, prefix);
    const rows = await store.scan<NativeService | { ServiceId: string }>(prefix, { ...page, limit: page.limit + 1 });
    const publicAccess = await runtime.publicAccess.getStatus();
    const items: Record<string, unknown>[] = [];
    for (const row of rows.slice(0, page.limit)) {
      const service = await store.get<NativeService>(nativeServiceKey(row.value.ServiceId));
      if (service && (user.role === "super_admin" || service.value.OwnerUserId === user.id)) items.push(publicService(service.value, publicAccess.publicBaseUrl));
    }
    return pageResponse(items, rows, page.limit, scope);
  });

  server.post(root, async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const body = readBody(request.body);
    const ids = readLibraryIds(body.LibraryIds);
    const owner = await validateLibraries(runtime, user, ids);
    const now = new Date().toISOString();
    const service: NativeService = { ServiceId: randomUUID(), OwnerUserId: owner, Name: readName(body.Name, "Name"), Mode: readMode(body.Mode, ids), PathSuffix: validateNativePathSuffix(body.PathSuffix), LibraryIds: ids, Enabled: optionalBoolean(body, "Enabled", false), RelayPlaybackEnabled: optionalBoolean(body, "RelayPlaybackEnabled", true), CredentialRevision: 1, PermissionsRevision: randomUUID(), CreatedAt: now, UpdatedAt: now };
    await store.transaction(async (query) => {
      const suffixKey = nativeSuffixKey(service.PathSuffix);
      if (await store.get(suffixKey, query)) throw new ApiError(409, "service_path_conflict", "该原生听书地址已被使用");
      await store.put(suffixKey, { ServiceId: service.ServiceId, Lookup: service.PathSuffix.toLowerCase() }, null, query);
      await store.put(nativeServiceKey(service.ServiceId), service, null, query);
      await store.put(ownerServiceKey(service), { ServiceId: service.ServiceId }, null, query);
      for (const id of service.LibraryIds) await store.put(libraryServiceKey(id, service.ServiceId), { ServiceId: service.ServiceId }, null, query);
    });
    return reply.status(201).send({ Service: publicService(service, (await runtime.publicAccess.getStatus()).publicBaseUrl) });
  });

  server.get<{ Params: { serviceId: string } }>(`${root}/:serviceId`, async (request) => {
    const { row } = await ownedService(runtime, store, request, request.params.serviceId, true);
    return { Service: publicService(row.value, (await runtime.publicAccess.getStatus()).publicBaseUrl) };
  });

  server.patch<{ Params: { serviceId: string } }>(`${root}/:serviceId`, async (request) => {
    const { user, row } = await ownedService(runtime, store, request, request.params.serviceId);
    const body = readBody(request.body);
    const ids = body.LibraryIds === undefined ? row.value.LibraryIds : readLibraryIds(body.LibraryIds);
    if (body.LibraryIds !== undefined) await validateLibraries(runtime, user, ids, row.value.OwnerUserId);
    const service: NativeService = { ...row.value, Name: body.Name === undefined ? row.value.Name : readName(body.Name, "Name"), Mode: readMode(body.Mode ?? row.value.Mode, ids), PathSuffix: body.PathSuffix === undefined ? row.value.PathSuffix : validateNativePathSuffix(body.PathSuffix), LibraryIds: ids, Enabled: optionalBoolean(body, "Enabled", row.value.Enabled), RelayPlaybackEnabled: optionalBoolean(body, "RelayPlaybackEnabled", row.value.RelayPlaybackEnabled), UpdatedAt: new Date().toISOString() };
    const permissionsChanged = JSON.stringify(ids) !== JSON.stringify(row.value.LibraryIds);
    if (permissionsChanged) service.PermissionsRevision = randomUUID();
    if (row.value.LibraryIds.some((id) => !ids.includes(id))) service.LibraryGrantCleanupPending = true;
    if (!service.Enabled && row.value.Enabled) service.CredentialRevision = nextCredentialRevision(row.value.CredentialRevision);
    await store.transaction(async (query) => {
      if (service.PathSuffix.toLowerCase() !== row.value.PathSuffix.toLowerCase()) {
        const newSuffixKey = nativeSuffixKey(service.PathSuffix);
        if (await store.get(newSuffixKey, query)) throw new ApiError(409, "service_path_conflict", "该原生听书地址已被使用");
        await store.put(newSuffixKey, { ServiceId: service.ServiceId, Lookup: service.PathSuffix.toLowerCase() }, null, query);
        const oldSuffixKey = nativeSuffixKey(row.value.PathSuffix);
        const oldSuffix = await store.get<{ ServiceId: string }>(oldSuffixKey, query);
        if (oldSuffix?.value.ServiceId === service.ServiceId) await store.remove(oldSuffixKey, oldSuffix.revision, query);
      }
      await store.put(nativeServiceKey(service.ServiceId), service, row.revision, query);
      for (const id of service.LibraryIds.filter((id) => !row.value.LibraryIds.includes(id))) await store.put(libraryServiceKey(id, service.ServiceId), { ServiceId: service.ServiceId }, null, query);
      for (const id of row.value.LibraryIds.filter((id) => !service.LibraryIds.includes(id))) {
        const key = libraryServiceKey(id, service.ServiceId);
        const index = await store.get(key, query);
        if (index) await store.remove(key, index.revision, query);
      }
    });
    if (service.LibraryGrantCleanupPending) await completeLibraryGrantCleanup(store, service.ServiceId);
    // 关键变量：服务权限版本立即生效；各账号下一次增量请求补一条权限通知。
    return { Service: publicService({ ...service, LibraryGrantCleanupPending: false }, (await runtime.publicAccess.getStatus()).publicBaseUrl) };
  });

  server.delete<{ Params: { serviceId: string } }>(`${root}/:serviceId`, async (request, reply) => {
    const { row } = await ownedService(runtime, store, request, request.params.serviceId, true);
    const service = row.value;
    if (!service.Deleting) await store.put(nativeServiceKey(service.ServiceId), { ...service, Enabled: false, Deleting: true, CredentialRevision: nextCredentialRevision(service.CredentialRevision), UpdatedAt: new Date().toISOString() }, row.revision);
    for (;;) {
      const accounts = await store.scan<NativeAccount>(nativeAccountPrefix(service.ServiceId), { limit: 100 });
      if (!accounts.length) break;
      for (const account of accounts) await deleteAccountData(store, access, service.ServiceId, account.value.AccountId);
    }
    await store.transaction(async (query) => {
      const suffixKey = nativeSuffixKey(service.PathSuffix);
      const suffix = await store.get<{ ServiceId: string }>(suffixKey, query);
      if (suffix?.value.ServiceId === service.ServiceId) await store.remove(suffixKey, suffix.revision, query);
      const ownerKey = ownerServiceKey(service);
      const owner = await store.get(ownerKey, query);
      if (owner) await store.remove(ownerKey, owner.revision, query);
      for (const id of service.LibraryIds) {
        const indexKey = libraryServiceKey(id, service.ServiceId);
        const index = await store.get(indexKey, query);
        if (index) await store.remove(indexKey, index.revision, query);
      }
      const current = await store.get(nativeServiceKey(service.ServiceId), query);
      if (current) await store.remove(nativeServiceKey(service.ServiceId), current.revision, query);
    });
    return reply.status(204).send();
  });

  server.get<{ Params: { serviceId: string } }>(`${root}/:serviceId/accounts`, async (request) => {
    const { row } = await ownedService(runtime, store, request, request.params.serviceId);
    const prefix = nativeAccountPrefix(row.value.ServiceId);
    const scope = nativeHash(`${row.value.ServiceId}:accounts`);
    const page = readPage(request.query, scope, prefix);
    const rows = await store.scan<NativeAccount>(prefix, { ...page, limit: page.limit + 1 });
    return pageResponse(rows.slice(0, page.limit).map((item) => nativePublicAccount(item.value)), rows, page.limit, scope);
  });

  server.post<{ Params: { serviceId: string } }>(`${root}/:serviceId/accounts`, async (request, reply) => {
    const { row } = await ownedService(runtime, store, request, request.params.serviceId);
    const body = readBody(request.body);
    const username = validateUsername(body.Username);
    const password = body.Password === undefined ? randomBytes(18).toString("base64url") : validatePassword(body.Password);
    const ids = body.AllowedLibraryIds === undefined ? [...row.value.LibraryIds] : readLibraryIds(body.AllowedLibraryIds, true);
    if (ids.some((id) => !row.value.LibraryIds.includes(id))) throw validationError("AllowedLibraryIds", "账号只能授权当前入口关联的媒体库");
    const now = new Date().toISOString();
    const account: NativeAccount = { AccountId: randomUUID(), ServiceId: row.value.ServiceId, Username: username, DisplayName: body.DisplayName === undefined ? username : readName(body.DisplayName, "DisplayName"), PasswordHash: await hashPassword(password), AllowedLibraryIds: ids, Enabled: optionalBoolean(body, "Enabled", true), CanDownload: optionalBoolean(body, "CanDownload", false), CredentialRevision: 1, PermissionsRevision: randomUUID(), CreatedAt: now, UpdatedAt: now };
    await store.transaction(async (query) => {
      const service = await currentService(store, account.ServiceId, query);
      if (ids.some((id) => !service.value.LibraryIds.includes(id))) throw new ApiError(409, "service_permissions_changed", "入口关联已变化，请重新选择授权");
      const usernameKey = nativeUsernameKey(account.ServiceId, username);
      if (await store.get(usernameKey, query)) throw new ApiError(409, "username_exists", "当前入口已存在同名账号");
      await store.put(usernameKey, { ServiceId: account.ServiceId, AccountId: account.AccountId, Lookup: createUsernameLookup(username) }, null, query);
      await store.put(nativeAccountKey(account.ServiceId, account.AccountId), account, null, query);
      await appendNativePermissionChange(store, service.value, account, query);
    });
    return reply.status(201).send({ Account: nativePublicAccount(account), ...(body.Password === undefined ? { Password: password } : {}) });
  });

  server.patch<{ Params: { serviceId: string; accountId: string } }>(`${root}/:serviceId/accounts/:accountId`, async (request) => {
    const { row: serviceRow } = await ownedService(runtime, store, request, request.params.serviceId);
    const row = await ownedAccount(store, serviceRow.value.ServiceId, request.params.accountId);
    const body = readBody(request.body);
    const ids = body.AllowedLibraryIds === undefined ? row.value.AllowedLibraryIds : readLibraryIds(body.AllowedLibraryIds, true);
    if (body.AllowedLibraryIds !== undefined && ids.some((id) => !serviceRow.value.LibraryIds.includes(id))) throw validationError("AllowedLibraryIds", "账号只能授权当前入口关联的媒体库");
    const username = body.Username === undefined ? row.value.Username : validateUsername(body.Username);
    const account: NativeAccount = { ...row.value, Username: username, DisplayName: body.DisplayName === undefined ? row.value.DisplayName : readName(body.DisplayName, "DisplayName"), AllowedLibraryIds: ids, Enabled: optionalBoolean(body, "Enabled", row.value.Enabled), CanDownload: optionalBoolean(body, "CanDownload", row.value.CanDownload), UpdatedAt: new Date().toISOString() };
    if (body.Password !== undefined) account.PasswordHash = await hashPassword(validatePassword(body.Password));
    const credentialsChanged = body.Password !== undefined || account.Enabled !== row.value.Enabled || account.Username !== row.value.Username;
    if (credentialsChanged) account.CredentialRevision = nextCredentialRevision(row.value.CredentialRevision);
    if (JSON.stringify(ids) !== JSON.stringify(row.value.AllowedLibraryIds) || account.CanDownload !== row.value.CanDownload) account.PermissionsRevision = randomUUID();
    await store.transaction(async (query) => {
      const service = await currentService(store, account.ServiceId, query);
      if (body.AllowedLibraryIds !== undefined && ids.some((id) => !service.value.LibraryIds.includes(id))) throw new ApiError(409, "service_permissions_changed", "入口关联已变化，请重新选择授权");
      if (createUsernameLookup(username) !== createUsernameLookup(row.value.Username)) {
        const newKey = nativeUsernameKey(account.ServiceId, username);
        if (await store.get(newKey, query)) throw new ApiError(409, "username_exists", "当前入口已存在同名账号");
        await store.put(newKey, { ServiceId: account.ServiceId, AccountId: account.AccountId, Lookup: createUsernameLookup(username) }, null, query);
        const oldKey = nativeUsernameKey(account.ServiceId, row.value.Username);
        const old = await store.get<{ AccountId: string }>(oldKey, query);
        if (old?.value.AccountId === account.AccountId) await store.remove(oldKey, old.revision, query);
      }
      await store.put(nativeAccountKey(account.ServiceId, account.AccountId), account, row.revision, query);
      if (account.PermissionsRevision !== row.value.PermissionsRevision) await appendNativePermissionChange(store, service.value, account, query);
    });
    return { Account: nativePublicAccount(account) };
  });

  server.delete<{ Params: { serviceId: string; accountId: string } }>(`${root}/:serviceId/accounts/:accountId`, async (request, reply) => {
    await ownedService(runtime, store, request, request.params.serviceId);
    await ownedAccount(store, request.params.serviceId, request.params.accountId, true);
    await deleteAccountData(store, access, request.params.serviceId, request.params.accountId);
    return reply.status(204).send();
  });

  server.get<{ Params: { serviceId: string; accountId: string } }>(`${root}/:serviceId/accounts/:accountId/sessions`, async (request) => {
    const { row: service } = await ownedService(runtime, store, request, request.params.serviceId);
    const account = await ownedAccount(store, service.value.ServiceId, request.params.accountId);
    const prefix = nativeAuthSessionPrefix(service.value.ServiceId, account.value.AccountId);
    const scope = nativeHash(`${service.value.ServiceId}:${account.value.AccountId}:sessions`);
    const page = readPage(request.query, scope, prefix);
    const rows = await store.scan<NativeAuthSession>(prefix, { ...page, limit: page.limit + 1 });
    const visible = rows.slice(0, page.limit).filter((item) => Date.parse(item.value.ExpiresAt) > Date.now() && item.value.AccountCredentialRevision === account.value.CredentialRevision && item.value.ServiceCredentialRevision === service.value.CredentialRevision);
    return pageResponse(visible.map((item) => nativePublicAuthSession(item.value)), rows, page.limit, scope);
  });

  server.post<{ Params: { serviceId: string; accountId: string } }>(`${root}/:serviceId/accounts/:accountId/revoke-sessions`, async (request) => {
    await ownedService(runtime, store, request, request.params.serviceId);
    const row = await ownedAccount(store, request.params.serviceId, request.params.accountId);
    await store.put(nativeAccountKey(row.value.ServiceId, row.value.AccountId), { ...row.value, CredentialRevision: nextCredentialRevision(row.value.CredentialRevision), UpdatedAt: new Date().toISOString() }, row.revision);
    return { Revoked: true };
  });

  server.delete<{ Params: { serviceId: string; accountId: string; authSessionId: string } }>(`${root}/:serviceId/accounts/:accountId/sessions/:authSessionId`, async (request, reply) => {
    await ownedService(runtime, store, request, request.params.serviceId);
    await ownedAccount(store, request.params.serviceId, request.params.accountId);
    const row = await store.get<NativeAuthSession>(nativeAuthSessionKey(request.params.serviceId, request.params.accountId, request.params.authSessionId));
    if (row) await store.transaction(async (query) => access.removeAuthSession(row.value, query));
    return reply.status(204).send();
  });
}
