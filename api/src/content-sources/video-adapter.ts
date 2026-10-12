import { ApiError } from "../errors.js";
import { CmsJsonAdapter } from "./cms-adapter.js";
import type { CmsPlaybackEpisode, ContentSourceManifest, VideoSourceAdapter } from "./types.js";

/** CMS 保持已有目录实现，直连线路在统一取址接口中返回原请求头。 */
export class CmsVideoSourceAdapter extends CmsJsonAdapter implements VideoSourceAdapter {
  public constructor(private readonly sourceManifest: ContentSourceManifest, allowInsecureHttp: boolean) {
    super(sourceManifest, allowInsecureHttp);
  }

  /** CMS 分集自身包含真实地址，不执行 Python 的播放解析。 */
  public async resolveEpisode(episode: CmsPlaybackEpisode): Promise<{ url: string; headers: Record<string, string>; container: CmsPlaybackEpisode["container"] }> {
    if (!episode.url) throw new ApiError(502, "content_source_playback_missing", "内容源没有返回视频地址");
    return { url: episode.url, headers: { ...this.sourceManifest.headers }, container: episode.container };
  }
}
