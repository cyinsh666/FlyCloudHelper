import type { FastifyRequest } from "fastify";
import type { ProviderFileAccess } from "./providers/types.js";

/** 固定主文件的历史别名，过滤或调整首选版本时不重新分配媒体源 ID。 */
export function toEmbyMediaSourceId(
  protocolItemId: string,
  fileId: string,
  primaryFileId: string,
  stableVersionIds: boolean,
): string {
  return stableVersionIds || fileId !== primaryFileId ? fileId : protocolItemId;
}

/** 仅为已支持播放器 UA 签名的网盘传递当前取流请求的 UA。 */
export function supportsEmbyPlaybackUserAgent(providerType: string): boolean {
  return providerType === "cloud115" || providerType === "cloud123";
}

/** 播放器已使用相同 UA 时允许直连，其他鉴权及固定请求头仍要求中转。 */
export function hasRequiredEmbyPlaybackHeaders(
  access: ProviderFileAccess,
  request: FastifyRequest,
  providerType: string,
): boolean {
  return Object.entries(access.headers).some(([name, value]) => {
    if ((supportsEmbyPlaybackUserAgent(providerType) || providerType === "baidupan")
      && name.toLowerCase() === "user-agent") {
      const playerUserAgent = request.headers["user-agent"]; // 关键变量：以实际媒体请求的 UA 校验，不能用登录请求推测。
      return typeof playerUserAgent !== "string" || !playerUserAgent || value !== playerUserAgent;
    }
    return true;
  });
}

/** 使用标准媒体源字段声明百度直连所需 UA，中转媒体源不要求客户端改变请求头。 */
export function readEmbyPlaybackRequiredHeaders(providerType: string, originPlayback: boolean): Record<string, string> {
  return originPlayback && providerType === "baidupan" ? { "User-Agent": "pan.baidu.com" } : {};
}
