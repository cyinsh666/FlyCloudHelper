import { SpiderVideoSourceAdapter } from "./spider-adapter.js";
import type { JavaScriptSpiderRuntime } from "./js-runtime.js";
import type { ContentSourceManifest } from "./types.js";

/** 两种 CatVod JS 导出经宿主转换后，复用与 Python 相同的目录和播放契约。 */
export class JavaScriptVideoSourceAdapter extends SpiderVideoSourceAdapter {
  /** JavaScript 会话按实例隔离，源脚本只在首次实际调用时加载。 */
  public constructor(manifest: ContentSourceManifest, runtime: JavaScriptSpiderRuntime, instanceId: string, pluginDirectory: string, allowInsecureHttp = false) {
    super(manifest, runtime, instanceId, pluginDirectory, allowInsecureHttp);
  }
}
