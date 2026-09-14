import { ApiError } from "../errors.js";
import { providerProbeStream, readProviderRateLimitDelayMs, registerProviderSharedRateLimit, type ProviderNetworkOptions, type ProviderStreamResponse } from "../providers/network.js";
import type { ProviderFileStreamAccess } from "../providers/types.js";

/** 原音频及旁挂读取共用有限重取，只在发送正文前更换临时地址。 */
export async function openMusicFileStream(resolve: () => Promise<ProviderFileStreamAccess>, init: RequestInit, options: ProviderNetworkOptions, signal: AbortSignal, initialAccess?: ProviderFileStreamAccess): Promise<ProviderStreamResponse> {
  let access = initialAccess ?? await resolve();
  let renewed = false;
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const headers = new Headers(access.headers);
    new Headers(init.headers).forEach((value, key) => {
      if (key === "user-agent" && headers.has("user-agent")) return;
      headers.set(key, value);
    });
    const response = await providerProbeStream(access.url, { ...init, headers }, options, signal);
    const status = response.statusCode;
    if (status >= 200 && status < 300 || status === 416) return response;
    response.body.destroy();
    if ([401, 403, 410].includes(status) && !renewed) {
      renewed = true;
      access = await resolve();
      continue;
    }
    if (status === 429 && attempt < 3) {
      registerProviderSharedRateLimit(access.url, readProviderRateLimitDelayMs(String(response.headers["retry-after"] ?? ""), attempt));
      continue;
    }
    if (status === 404) throw new ApiError(404, "music_file_missing", "音乐文件或旁挂资料已不存在");
    if ([401, 403, 410].includes(status)) throw new ApiError(403, "music_file_access_denied", "重新取址后仍无法读取文件，请检查网盘授权与文件权限");
    throw new ApiError(503, "music_file_read_failed", `音乐文件读取失败：HTTP ${status}`);
  }
}
