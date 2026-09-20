import type { FastifyRequest } from "fastify";
import type { ApiRuntime } from "../runtime.js";
import type { RelayLibraryRow } from "../routes/media-stream-routes.js";

/** 只使用 Provider 明确允许交给客户端的直链；依赖认证头或取址失败时返回中转原因。 */
export async function resolveNavidromeDirectPlayback(
  runtime: ApiRuntime,
  library: RelayLibraryRow,
  userId: string,
  locator: Record<string, unknown>,
  request: FastifyRequest,
  signal: AbortSignal,
): Promise<{ url: string | null; fallbackReason: string }> {
  const adapter = runtime.providers.get(library.provider_type);
  if (!adapter.resolveFileAccess) return { url: null, fallbackReason: "网盘不支持客户端直链" };
  try {
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(library.service_id, userId));
    // 115、123 的签名链接绑定播放器 UA，与现有视频直连规则一致。
    const usesPlayerUserAgent = library.provider_type === "cloud115" || library.provider_type === "cloud123";
    const playerUserAgent = request.headers["user-agent"];
    const access = await adapter.resolveFileAccess(connection, locator, signal, {
      playbackUserAgent: usesPlayerUserAgent ? playerUserAgent : undefined,
      persistConnection: async (nextConnection) => {
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: library.service_id, userId, credentialRevision: Number(library.credential_revision),
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
      },
    });
    signal.throwIfAborted();
    if (!/^https?:\/\//iu.test(access.url)) return { url: null, fallbackReason: "未生成可用直链" };
    const requiresHeaders = Object.entries(access.headers).some(([name, value]) => {
      return !(usesPlayerUserAgent && name.toLowerCase() === "user-agent" && playerUserAgent && value === playerUserAgent);
    });
    if (requiresHeaders) return { url: null, fallbackReason: "上游需要额外请求头" };
    return { url: access.url, fallbackReason: "" };
  } catch {
    signal.throwIfAborted();
    // 不把可能含临时链接或凭据的上游异常写入日志。
    return { url: null, fallbackReason: "网盘直链解析失败" };
  }
}
