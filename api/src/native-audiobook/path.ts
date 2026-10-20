import type { FastifyRequest } from "fastify";
import type { ApiRuntime } from "../runtime.js";

/** 返回当前原生入口的站内路径，保留部署公开地址或代理声明的前缀。 */
export async function nativeRequestBasePath(runtime: ApiRuntime, request: FastifyRequest, suffix: string): Promise<string> {
  const marker = `/a/${encodeURIComponent(suffix)}`;
  const pathname = request.url.split("?", 1)[0] ?? "";
  const markerIndex = pathname.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (markerIndex > 0) return pathname.slice(0, markerIndex + marker.length);
  const forwarded = request.headers["x-forwarded-prefix"];
  if (typeof forwarded === "string" && /^\/(?!\/)[A-Za-z0-9_~!$&'()*+,;=:@%/.-]*$/.test(forwarded) && forwarded.length <= 1000) {
    const prefix = forwarded.replace(/\/+$/, "");
    if (!prefix.split("/").some((part) => part === "." || part === "..")) return `${prefix}${marker}`;
  }
  const configured = await runtime.publicAccess.getStatus();
  if (configured.publicBaseUrl) {
    const prefix = new URL(configured.publicBaseUrl).pathname.replace(/\/+$/, "");
    return `${prefix}${marker}`;
  }
  return marker;
}
