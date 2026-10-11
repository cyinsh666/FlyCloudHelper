import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

/** 默认用户头像所属的标准媒体协议。 */
type UserImageProtocol = "jellyfin" | "emby" | "navidrome";

/** 协议默认图标与其内容版本；各协议分别缓存各自的资源。 */
interface ProtocolUserImage {
  bytes: Buffer;
  imageTag: string;
}

/** 读取鸿蒙 App 复用的协议图标，源码与 dist 运行均定位到 api/assets。 */
function loadProtocolUserImage(fileName: string): ProtocolUserImage {
  // 关键变量：src/media 和 dist/media 深度相同，不依赖启动目录或 Web 构建产物。
  const imageUrl = new URL(`../../assets/protocol-icons/${fileName}`, import.meta.url);
  const bytes = readFileSync(imageUrl);
  // 关键变量：图标内容变化时更新内容版本，供影视图片标签与音乐头像 HTTP 缓存使用。
  const imageTag = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return { bytes, imageTag };
}

// 关键变量：内置图标只在模块加载时读取一次，所有媒体库共用对应协议的默认头像。
const protocolUserImages: Record<UserImageProtocol, ProtocolUserImage> = {
  jellyfin: loadProtocolUserImage("jellyfin.png"),
  emby: loadProtocolUserImage("emby.png"),
  navidrome: loadProtocolUserImage("navidrome.png"),
};

/** 返回默认头像的稳定版本，供影视 UserDto.PrimaryImageTag 和音乐头像缓存使用。 */
export function getProtocolUserImageTag(protocol: UserImageProtocol): string {
  return protocolUserImages[protocol].imageTag;
}

/** GET/HEAD 使用弱比较，兼容单个、多个 ETag 和任意现存版本的条件请求。 */
function matchesUserImageCache(request: FastifyRequest, etag: string): boolean {
  const condition = request.headers["if-none-match"];
  if (typeof condition !== "string") return false;
  return condition.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

/** 为影视图片接口和 Subsonic getAvatar 返回协议 PNG，支持 GET、HEAD 与条件缓存请求。 */
export function sendProtocolUserImage(protocol: UserImageProtocol, request: FastifyRequest, reply: FastifyReply) {
  const image = protocolUserImages[protocol];
  // 关键变量：HTTP 缓存标记与协议图标的内容版本一致。
  const etag = `"${image.imageTag}"`;
  reply.header("Content-Type", "image/png")
    .header("Cache-Control", "private, max-age=86400")
    .header("ETag", etag);
  if ((request.method === "GET" || request.method === "HEAD") && matchesUserImageCache(request, etag)) {
    return reply.status(304).send();
  }
  reply.header("Content-Length", image.bytes.length);
  return request.method === "HEAD" ? reply.send() : reply.send(image.bytes);
}
