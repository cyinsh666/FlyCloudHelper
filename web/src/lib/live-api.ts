import { requestJson } from "./api";

/** 直播频道保留源站身份，实际播放地址在客户端请求时读取。 */
export interface LiveChannel {
  id: string; name: string; group: string; tvgId: string; logo: string; catchup: boolean; requiresRelay: boolean;
}

/** 独立直播库配置；结构由现有内容源 JSON 字段保存。 */
export interface LiveLibraryState {
  libraryId: string; displayName: string;
  source: { id: string; displayName: string; status: string; pluginStatus: string };
  configuration: { enabled: boolean; channelIds: string[]; playbackMode: "direct" | "relay"; epgUrl: string };
  channels: LiveChannel[]; subscriptionUrl: string;
  runtimeStatus: "running" | "starting" | "stopped"; epgSuggestions: string[];
}

/** 所有操作固定当前库和管理入口，不刷新其他页面或服务。 */
export function liveApi<T>(libraryId: string, admin: boolean, suffix = "", method = "GET", body?: unknown): Promise<T> {
  return requestJson(`${admin ? "/api/v1/admin" : "/api/v1"}/libraries/${encodeURIComponent(libraryId)}/live${suffix}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
