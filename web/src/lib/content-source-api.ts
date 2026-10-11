import { requestJson } from "@/lib/api";

/** 一个可独立启停的内容源插件版本。 */
export interface ContentSourcePlugin {
  pluginId: string;
  version: string;
  displayName: string;
  status: "enabled" | "disabled" | "imported" | "uninstalled";
  adapter: string;
  description: string;
}

/** 用户配置的内容源实例；绑定媒体库后不再用于创建第二个库。 */
export interface ContentSourceInstance {
  id: string;
  pluginId: string;
  pluginVersion: string;
  displayName: string;
  status: "active" | "disabled";
  pluginStatus: ContentSourcePlugin["status"];
  libraryId: string | null;
}

/** 源站分类与父分类关系。 */
export interface ContentSourceCategory {
  id: string;
  name: string;
  parentId: string | null;
}

/** 在线媒体库的最近目录同步状态。 */
export interface ContentSourceSync {
  status: "idle" | "queued" | "running" | "completed" | "failed";
  processedCount: number;
  pageCount: number;
  nextPageByCategory: Record<string, number>;
  /** 未完成批次保留原范围；重试不再为已完成分类增加页数。 */
  pendingBatch?: {
    pageCount: number;
    sample: boolean;
    endPageExclusiveByCategory: Record<string, number>;
    completedCategoryIds: string[];
    remainingSampleCountByCategory: Record<string, number>;
  };
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 内容源库独立配置，不使用网盘扫描路径。 */
export interface ContentSourceLibraryState {
  source: ContentSourceInstance;
  configuration: { categoryIds: string[]; initialPageCount: number; categories?: ContentSourceCategory[] };
  sync: ContentSourceSync;
  plugin?: ContentSourcePlugin;
}

/** 在线源的播放方式；两种协议独立保存，缺省由服务端返回自动模式。 */
export type ContentSourcePlaybackMode = "auto" | "direct" | "relay";
export type ContentSourcePlaybackProtocol = "jellyfin" | "emby";
export interface ContentSourcePlaybackModes {
  jellyfin: ContentSourcePlaybackMode;
  emby: ContentSourcePlaybackMode;
}

/** 创建时一次性返回的协议密码；后续管理页只提供修改密码。 */
export interface ContentSourceLibraryCreateResult {
  libraryId: string;
  sync?: ContentSourceSync;
  accessCredentials?: { account: { username: string }; password: string };
  embyAccessCredentials?: { account: { username: string }; password: string };
}

/** 读取可用插件；普通用户只会收到已启用的版本。 */
export function listContentSourcePlugins(): Promise<{ items: ContentSourcePlugin[] }> {
  return requestJson("/api/v1/content-source-plugins");
}

/** 启用或停用指定内容源插件，保留已有实例和媒体库目录。 */
export function updateContentSourcePlugin(plugin: ContentSourcePlugin, enabled: boolean): Promise<unknown> {
  return requestJson(`/api/v1/admin/content-source-plugins/${encodeURIComponent(plugin.pluginId)}/${encodeURIComponent(plugin.version)}/${enabled ? "enable" : "disable"}`, {
    method: "POST", body: "{}",
  });
}

/** 从 JSON 文件导入声明式源插件，不执行文件中的脚本。 */
export async function importContentSourcePlugin(file: File): Promise<ContentSourcePlugin> {
  const manifest: unknown = JSON.parse(await file.text()); // 关键变量：清单结构由服务端校验后保存。
  return (await requestJson<{ plugin: ContentSourcePlugin }>("/api/v1/admin/content-source-plugins/import", {
    method: "POST", body: JSON.stringify({ manifest }),
  })).plugin;
}

/** 卸载源插件，已有媒体库和用户播放记录继续保留。 */
export function uninstallContentSourcePlugin(plugin: ContentSourcePlugin): Promise<unknown> {
  return requestJson(`/api/v1/admin/content-source-plugins/${encodeURIComponent(plugin.pluginId)}/${encodeURIComponent(plugin.version)}/uninstall`, {
    method: "POST", body: "{}",
  });
}

/** 读取当前用户自己的内容源实例。 */
export function listContentSources(): Promise<{ items: ContentSourceInstance[] }> {
  return requestJson("/api/v1/content-sources");
}

/** 创建一个插件配置实例，空配置使用插件提供的默认接口。 */
export async function createContentSource(input: {
  pluginId: string; pluginVersion: string; displayName: string;
}): Promise<ContentSourceInstance> {
  return (await requestJson<{ source: ContentSourceInstance }>("/api/v1/content-sources", {
    method: "POST", body: JSON.stringify(input),
  })).source;
}

/** 启停当前用户的配置实例，保留其独立媒体库和播放记录。 */
export async function updateContentSourceStatus(sourceId: string, status: "active" | "disabled", admin = false): Promise<ContentSourceInstance> {
  return (await requestJson<{ source: ContentSourceInstance }>(`${admin ? "/api/v1/admin" : "/api/v1"}/content-sources/${encodeURIComponent(sourceId)}`, {
    method: "PATCH", body: JSON.stringify({ status }),
  })).source;
}

/** 从当前实例读取分类，供用户选择小范围同步。 */
export function listContentSourceCategories(sourceId: string): Promise<{ items: ContentSourceCategory[] }> {
  return requestJson(`/api/v1/content-sources/${encodeURIComponent(sourceId)}/categories`);
}

/** 创建在线影视库并开始首轮同步，每个源实例只关联一个库。 */
export function createContentSourceLibrary(sourceId: string, input: {
  displayName: string; categoryIds: string[]; initialPageCount: number;
}): Promise<ContentSourceLibraryCreateResult> {
  return requestJson(`/api/v1/content-sources/${encodeURIComponent(sourceId)}/libraries`, {
    method: "POST", body: JSON.stringify(input),
  });
}

/** 读取在线库配置和同步状态；管理员使用管理端路由。 */
export function getContentSourceLibrary(libraryId: string, admin = false): Promise<ContentSourceLibraryState> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}`);
}

/** 读取当前在线库可选择的视频叶分类，不包含源站禁用的内容类型。 */
export function listContentSourceLibraryCategories(libraryId: string, admin = false): Promise<{ items: ContentSourceCategory[] }> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}/categories`);
}

/** 保存分类选择，不启动同步；已有媒体、观看记录和分类进度由服务端保留。 */
export function updateContentSourceLibraryCategories(libraryId: string, categoryIds: string[], admin = false): Promise<ContentSourceLibraryState> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}/categories`, {
    method: "PATCH", body: JSON.stringify({ categoryIds }),
  });
}

/** 读取在线库的协议播放模式，不使用网盘中转开关推断当前模式。 */
export function getContentSourcePlaybackModes(libraryId: string, admin = false): Promise<ContentSourcePlaybackModes> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}/playback-modes`);
}

/** 仅保存当前协议的在线播放模式，响应返回服务端确认后的两种协议配置。 */
export function updateContentSourcePlaybackMode(libraryId: string, protocol: ContentSourcePlaybackProtocol, mode: ContentSourcePlaybackMode, admin = false): Promise<ContentSourcePlaybackModes> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}/playback-modes`, {
    method: "PATCH", body: JSON.stringify({ protocol, mode }),
  });
}

/** 重新同步已选分类，目录和播放记录沿用已有条目标识。 */
export function syncContentSourceLibrary(libraryId: string, input: { mode: "next" | "refresh"; pageCount?: number }, admin = false): Promise<unknown> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/content-source-libraries/${encodeURIComponent(libraryId)}/sync`, {
    method: "POST", body: JSON.stringify(input),
  });
}
