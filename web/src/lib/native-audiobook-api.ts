import { requestJson, type MediaLibrary } from "@/lib/api";

/** 管理端公开入口对象，不包含密码、访问令牌或来源配置。 */
export interface NativeAudiobookService {
  ServiceId: string; OwnerUserId: string; Name: string; Mode: "SingleLibrary" | "MultiLibrary";
  PathSuffix: string; Path: string; Url: string | null; LibraryIds: string[]; Enabled: boolean;
  RelayPlaybackEnabled: boolean; PermissionsRevision: string; CreatedAt: string; UpdatedAt: string; Deleting: boolean;
}

/** 账号列表只能读取授权摘要，已有密码不可读取。 */
export interface NativeAudiobookAccount {
  AccountId: string; ServiceId: string; Username: string; DisplayName: string; AllowedLibraryIds: string[];
  Enabled: boolean; CanDownload: boolean; PermissionsRevision: string; CreatedAt: string; UpdatedAt: string;
}

/** 设备页只展示名称、客户端版本和有效期。 */
export interface NativeAudiobookDevice {
  AuthSessionId: string; DeviceInfo: { DeviceId: string; DeviceName: string; Client: string; Version: string };
  CreatedAt: string; ExpiresAt: string;
}

/** 新协议管理列表使用服务端游标，不能获取无限量记录。 */
export interface NativeAudiobookPage<T> { Items: T[]; NextCursor: string | null; HasMore: boolean; TotalCount: number | null; }
/** 创建和编辑入口共享相同显式字段，不修改实际媒体库。 */
export interface NativeAudiobookServiceInput { Name: string; Mode: NativeAudiobookService["Mode"]; PathSuffix: string; LibraryIds: string[]; Enabled: boolean; RelayPlaybackEnabled: boolean; }
/** 密码省略时保留旧值，新建省略则由服务端生成。 */
export interface NativeAudiobookAccountInput { Username: string; DisplayName: string; Password?: string; AllowedLibraryIds: string[]; Enabled: boolean; CanDownload: boolean; }

const base = "/api/v1/audiobook-services";

/** 分页参数只提交明确值，所有管理列表每页二十项。 */
function pageQuery(cursor: string | null, libraryId?: string): string {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  if (libraryId) query.set("libraryId", libraryId);
  return query.toString();
}

/** 统一入口页或实际库设置页按服务端索引分页查询。 */
export function listNativeAudiobookServices(cursor: string | null, libraryId?: string): Promise<NativeAudiobookPage<NativeAudiobookService>> {
  return requestJson(`${base}?${pageQuery(cursor, libraryId)}`);
}

/** 读取当前入口最终配置，用于刷新账号授权范围。 */
export async function getNativeAudiobookService(serviceId: string): Promise<NativeAudiobookService> {
  return (await requestJson<{ Service: NativeAudiobookService }>(`${base}/${encodeURIComponent(serviceId)}`)).Service;
}

/** 入口新建和修改仅作用于独立协议配置。 */
export async function saveNativeAudiobookService(serviceId: string | null, input: NativeAudiobookServiceInput): Promise<NativeAudiobookService> {
  return (await requestJson<{ Service: NativeAudiobookService }>(serviceId ? `${base}/${encodeURIComponent(serviceId)}` : base,
    { method: serviceId ? "PATCH" : "POST", body: JSON.stringify(input) })).Service;
}

/** 删除协议入口，服务端保留实际库、插件及 ABS 配置。 */
export async function deleteNativeAudiobookService(serviceId: string): Promise<void> { await requestJson(`${base}/${encodeURIComponent(serviceId)}`, { method: "DELETE" }); }

/** 账号路径始终包含所属入口，避免同名账号串域。 */
function accountPath(serviceId: string, accountId?: string): string { return `${base}/${encodeURIComponent(serviceId)}/accounts${accountId ? `/${encodeURIComponent(accountId)}` : ""}`; }

/** 分页读取账号，密码不进入页面资源缓存。 */
export function listNativeAudiobookAccounts(serviceId: string, cursor: string | null): Promise<NativeAudiobookPage<NativeAudiobookAccount>> { return requestJson(`${accountPath(serviceId)}?${pageQuery(cursor)}`); }

/** 创建仅在当前响应返回生成密码，编辑留空不重置。 */
export function saveNativeAudiobookAccount(serviceId: string, accountId: string | null, input: NativeAudiobookAccountInput | Partial<NativeAudiobookAccountInput>): Promise<{ Account: NativeAudiobookAccount; Password?: string }> {
  return requestJson(accountPath(serviceId, accountId ?? undefined), { method: accountId ? "PATCH" : "POST", body: JSON.stringify(input) });
}

/** 删除账号及其原生使用记录。 */
export async function deleteNativeAudiobookAccount(serviceId: string, accountId: string): Promise<void> { await requestJson(accountPath(serviceId, accountId), { method: "DELETE" }); }

/** 撤销该入口账号的全部设备登录，保留收听记录。 */
export async function revokeNativeAudiobookDevices(serviceId: string, accountId: string): Promise<void> { await requestJson(`${accountPath(serviceId, accountId)}/revoke-sessions`, { method: "POST", body: "{}" }); }

/** 分页读取仍有效的设备会话。 */
export function listNativeAudiobookDevices(serviceId: string, accountId: string, cursor: string | null): Promise<NativeAudiobookPage<NativeAudiobookDevice>> { return requestJson(`${accountPath(serviceId, accountId)}/sessions?${pageQuery(cursor)}`); }

/** 撤销单个设备，不误撤销同账号的其他设备。 */
export async function revokeNativeAudiobookDevice(serviceId: string, accountId: string, authSessionId: string): Promise<void> { await requestJson(`${accountPath(serviceId, accountId)}/sessions/${encodeURIComponent(authSessionId)}`, { method: "DELETE" }); }

/** 沿用既有实际库列表接口，但显式分页，不调用固定下载两百项的旧封装。 */
export function listNativeLibraryChoices(admin: boolean, offset: number, search: string, ownerUserId?: string): Promise<{ items: MediaLibrary[]; total: number }> {
  const query = new URLSearchParams({ dataType: "audiobook", limit: "20", offset: String(offset) });
  if (search) query.set("search", search);
  if (admin && ownerUserId) query.set("userId", ownerUserId);
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/libraries?${query}`);
}

/** 优先复制管理员配置的公开地址，未配置时使用当前网页入口。 */
export function nativeAudiobookAddress(service: NativeAudiobookService): string { return service.Url || `${window.location.origin}${service.Path}`; }
