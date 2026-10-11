import type { ContentSourceManifest } from "../types.js";

/** 文件中已有的虎牙资源源，复用固定 CMS JSON 适配器和标准视频协议。 */
export const huyaResourcesManifest: ContentSourceManifest = {
  protocolVersion: 1,
  pluginId: "cms.huya-resources",
  version: "1.0.0",
  displayName: "虎牙｜资源",
  description: "来自 Ubox 源配置的 CMS JSON 视频源，包含电视剧、动漫、短剧、电影和综艺。仅使用直接 HLS/MP4 线路；短剧全集视频不会拆分成虚拟单集。",
  adapter: "cms_json",
  endpoint: "https://www.huyaapi.com/api.php/provide/vod/",
  // 关键变量：电影根及独立单片分类按源站分类定义，子分类通过分类树匹配。
  movieCategoryIds: ["2", "8", "31"],
  excludedCategoryIds: [],
  headers: { "User-Agent": "Mozilla/5.0" },
};
