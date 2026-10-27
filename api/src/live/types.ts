import { validationError } from "../errors.js";
import type { ContentSourceManifest } from "../content-sources/types.js";

/** 静态频道身份与展示资料，不保存临时直播地址或设备凭据。 */
export interface LiveChannel {
  id: string;
  name: string;
  group: string;
  tvgId: string;
  logo: string;
  catchup: boolean;
  requiresRelay: boolean;
}

/** 每类独立服务必须有明确运行适配，本轮仅支持已识别的 YSP 网关。 */
export interface LiveSourceDefinition {
  engine: "ysp";
  channels: LiveChannel[];
  epgUrls: string[];
}

/** 配置保存在既有内容源绑定 configuration_json，不新增数据库结构。 */
export interface LiveLibraryConfiguration {
  enabled: boolean;
  channelIds: string[];
  playbackMode: "direct" | "relay";
  epgUrl: string;
  /** 订阅地址修订，重置时更换以撤销旧地址。 */
  subscriptionRevision: string;
}

/** 校验频道和外部节目单的公开 HTTP 地址；空值表示没有配置。 */
export function liveHttpUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value.length <= 2000) return url.href;
  } catch { /* 无效的展示地址不进入订阅。 */ }
  throw validationError("url", "请填写有效的 HTTP 或 HTTPS 地址");
}

/** 独立直播服务清单必须绑定导入原文件及具体运行引擎，不能指向任意启动命令。 */
export function validateLiveManifest(raw: Record<string, unknown>, common: Pick<ContentSourceManifest, "protocolVersion" | "pluginId" | "version" | "displayName" | "description">): ContentSourceManifest {
  const scriptHash = String(raw.scriptHash ?? "");
  if (!/^[a-f0-9]{64}$/u.test(scriptHash) || raw.scriptFile !== `python-sources/${scriptHash}/source.py`)
    throw validationError("scriptFile", "直播脚本必须使用导入时保存的固定路径和摘要");
  const definition = raw.liveConfig as LiveSourceDefinition | undefined;
  if (!definition || definition.engine !== "ysp" || !Array.isArray(definition.channels) || !definition.channels.length || definition.channels.length > 256)
    throw validationError("liveConfig", "直播源缺少受支持的 YSP 引擎或频道目录");
  const ids = new Set<string>();
  const channels = definition.channels.map((channel): LiveChannel => {
    if (!channel || typeof channel.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(channel.id) || ids.has(channel.id)
      || typeof channel.name !== "string" || !channel.name || channel.name.length > 100
      || typeof channel.group !== "string" || channel.group.length > 100)
      throw validationError("channels", "直播频道身份、名称或分组无效");
    ids.add(channel.id);
    return { id: channel.id, name: channel.name, group: channel.group, tvgId: String(channel.tvgId ?? channel.id).slice(0, 100),
      logo: liveHttpUrl(channel.logo), catchup: channel.catchup === true, requiresRelay: channel.requiresRelay === true };
  });
  return { ...common, adapter: "python_live", mediaType: "video", endpoint: "", scriptFile: String(raw.scriptFile), scriptHash,
    movieCategoryIds: [], excludedCategoryIds: [], headers: {},
    liveConfig: { engine: "ysp", channels, epgUrls: Array.isArray(definition.epgUrls) ? definition.epgUrls.slice(0, 5).map(liveHttpUrl).filter(Boolean) : [] } };
}
