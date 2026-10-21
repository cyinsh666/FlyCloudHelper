import { SpiderVideoSourceAdapter } from "./spider-adapter.js";
import type { PythonSpiderRuntime } from "./python-runtime.js";
import type { ContentSourceManifest } from "./types.js";

/** Python 保留既有入口，目录、分类和播放字段由共用 Spider 适配器解释。 */
export class PythonVideoSourceAdapter extends SpiderVideoSourceAdapter {
  /** 每个实例仍使用原 Python 进程，已有插件和媒体身份不变。 */
  public constructor(manifest: ContentSourceManifest, runtime: PythonSpiderRuntime, instanceId: string, pluginDirectory: string, allowInsecureHttp = false) {
    super(manifest, runtime, instanceId, pluginDirectory, allowInsecureHttp);
  }
}
