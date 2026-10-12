import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { ContentSourceManifest, ContentSourcePluginRecord } from "./types.js";

/** 单个 Python 源的上传上限；文件按原始字节保存，不改写源代码。 */
export const PYTHON_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** 只将上传文件名用于显示，不允许它参与服务器存储路径。 */
function sourceDisplayName(filename: string, inspectedName: string): string {
  const originalName = path.basename(filename.replace(/\\/gu, "/")).replace(/\.py$/iu, "");
  return (inspectedName.trim() || originalName.trim() || "Python 内容源").replace(/[\r\n]/gu, " ").slice(0, 100);
}

/** 按完整 SHA256 保存原始脚本；同内容重复上传只校验已有文件，不覆盖它。 */
async function savePythonSource(absolutePath: string, bytes: Buffer, scriptHash: string): Promise<boolean> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await fs.writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.lstat(absolutePath);
    if (!existing.isFile()) throw new ApiError(409, "python_source_file_invalid", "已有 Python 源文件不可用，请检查插件目录");
    const existingHash = createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
    if (existingHash !== scriptHash) throw new ApiError(409, "python_source_hash_mismatch", "已有 Python 源文件校验失败，请重新安装该源");
    return false;
  }
}

/** 只把文件不存在视为可修复缺失，现有脚本和权限错误都不进入补写流程。 */
async function pythonSourceMissing(absolutePath: string): Promise<boolean> {
  try {
    await fs.lstat(absolutePath);
    return false;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** 上传仅做 UTF-8 和 AST 检查；新源登记待启用插件，已有源缺失时只补回脚本。 */
export async function importPythonSource(runtime: ApiRuntime, filename: string, bytes: Buffer): Promise<ContentSourcePluginRecord> {
  if (!filename.toLowerCase().endsWith(".py")) throw new ApiError(415, "python_source_file_type_invalid", "请选择 .py 内容源文件");
  if (bytes.length === 0) throw new ApiError(400, "python_source_empty", "Python 源文件不能为空");
  if (bytes.length > PYTHON_SOURCE_MAX_BYTES) throw new ApiError(413, "python_source_too_large", "Python 源文件不能超过 2 MB");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "python_source_encoding_invalid", "Python 源文件必须使用 UTF-8 编码");
  }

  // 关键变量：文件身份由完整原始字节确定，上传名和脚本声明都不能影响存储路径。
  const scriptHash = createHash("sha256").update(bytes).digest("hex");
  const pluginId = `py.${scriptHash.slice(0, 24)}`;
  const version = "1.0.0";
  // 关键变量：按脚本内容身份复用原记录，文件改名不会产生第二份插件。
  const previous = (await runtime.contentSources.listPlugins(true)).find((plugin) => plugin.pluginId === pluginId && plugin.version === version);
  const scriptFile = path.posix.join("python-sources", scriptHash, "source.py");
  const absolutePath = path.resolve(runtime.config.pluginDirectory, scriptFile);
  // 关键变量：仍安装的插件只允许补回缺失文件，原有名称、状态和关联不变。
  const repairingInstalledPlugin = previous !== undefined && previous.status !== "uninstalled";
  if (repairingInstalledPlugin && !await pythonSourceMissing(absolutePath)) {
    throw new ApiError(409, "content_plugin_already_exists", "已添加插件，不要重复导入");
  }
  const createdFile = await savePythonSource(absolutePath, bytes, scriptHash);
  if (repairingInstalledPlugin && !createdFile) {
    throw new ApiError(409, "content_plugin_already_exists", "脚本已补回，不要重复导入");
  }
  let inspection: { name: string; methods: string[] };
  try {
    // 关键变量：inspect 使用 AST 识别 Spider 和基础方法，导入管理端不运行源的初始化逻辑。
    inspection = await runtime.contentSources.pythonRuntime.inspect(absolutePath);
  } catch (error) {
    if (createdFile) await fs.rm(absolutePath, { force: true });
    throw error;
  }

  // 关键变量：重新安装已卸载脚本时保留原清单，避免上传名改变已绑定的源信息。
  if (previous) {
    if (repairingInstalledPlugin) {
      // 关键变量：补写只恢复文件，返回最新记录以保留期间发生的启停或卸载操作。
      const current = (await runtime.contentSources.listPlugins(true)).find((plugin) => plugin.pluginId === pluginId && plugin.version === version);
      if (!current) throw new ApiError(404, "content_plugin_not_found", "内容源插件版本不存在");
      return current;
    }
    return runtime.contentSources.setPluginStatus(pluginId, version, "imported");
  }
  const manifest: ContentSourceManifest = {
    protocolVersion: 1,
    pluginId,
    version,
    displayName: sourceDisplayName(filename, inspection.name),
    description: "Python Spider 视频内容源，通过 Jellyfin、Emby 提供目录、搜索和播放，实际能力以源站解析结果为准。",
    adapter: "python_spider",
    endpoint: "",
    scriptFile,
    scriptHash,
    movieCategoryIds: [],
    excludedCategoryIds: [],
    headers: {},
    pythonConfig: { extend: "", pageSize: 20 },
  };
  return runtime.contentSources.importPlugin(manifest);
}
