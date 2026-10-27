import { randomUUID } from "node:crypto";
import { parseJsonObject } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import type { ContentSourceManifest } from "../content-sources/types.js";
import { PythonLiveRuntime } from "./runtime.js";
import { liveHttpUrl, type LiveLibraryConfiguration, type LiveSourceDefinition } from "./types.js";

/** 直播只管理频道和订阅，不生成影视条目、章节、网盘文件或扫描任务。 */
export class LiveLibraryManager {
  public readonly process: PythonLiveRuntime;
  /** 复用已有仓储，直播进程管理单独隔离。 */
  public constructor(private readonly runtime: Pick<ApiRuntime, "config" | "database" | "repository" | "contentSources">) {
    this.process = new PythonLiveRuntime(runtime.config);
  }

  /** 分类预览只读取静态频道清单，不启动 HTTP 服务和设备注册。 */
  public async preview(pluginId: string, version: string) {
    const manifest = await this.runtime.contentSources.manifestForPlugin(pluginId, version);
    return this.definition(manifest).channels;
  }

  /** 每次读取均校验真实库所有者；停用配置仍可查看和修改。 */
  public async get(libraryId: string, userId?: string) {
    const library = await this.runtime.repository.getLibrary(libraryId, userId);
    if (library.libraryKind !== "content_source_live") throw new ApiError(409, "live_library_required", "当前媒体库不是直播媒体库");
    const binding = await this.runtime.database.query("content_source_libraries").where({ library_id: libraryId, user_id: library.userId }).first();
    if (!binding) throw new ApiError(404, "live_binding_missing", "直播媒体库源配置不存在");
    const source = (await this.runtime.contentSources.listInstances(library.userId)).find((entry) => entry.id === String(binding.instance_id));
    if (!source) throw new ApiError(404, "live_source_missing", "直播源实例不存在");
    // 管理读取允许停用插件，但必须仍有当前固定版本的清单。
    const row = await this.runtime.database.query("content_source_plugins").where({ plugin_id: source.pluginId, version: source.pluginVersion }).first();
    if (!row) throw new ApiError(404, "live_plugin_missing", "直播源插件不存在");
    const manifest = parseJsonObject(row.manifest_json) as unknown as ContentSourceManifest;
    const definition = this.definition(manifest);
    const raw = parseJsonObject(binding.configuration_json);
    const configuration: LiveLibraryConfiguration = { enabled: raw.enabled === true, playbackMode: raw.playbackMode === "direct" ? "direct" : "relay",
      channelIds: Array.isArray(raw.channelIds) ? raw.channelIds.filter((id): id is string => typeof id === "string") : [], epgUrl: String(raw.epgUrl ?? ""), subscriptionRevision: typeof raw.subscriptionRevision === "string" ? raw.subscriptionRevision : "initial" };
    return { library, source, manifest, configurationJson: binding.configuration_json, channels: definition.channels, configuration, runtimeStatus: this.process.status(source.id),
      epgSuggestions: definition.epgUrls };
  }

  /** 创建时复用已有关系表，订阅默认关闭，直播访问不创建账号。 */
  public async create(instanceId: string, userId: string, displayName: string, channelIds: unknown): Promise<{ libraryId: string }> {
    const source = await this.runtime.contentSources.sourceForInstance(instanceId, userId);
    const manifest = await this.runtime.contentSources.manifestForInstance(instanceId, userId);
    const definition = this.definition(manifest);
    const selected = this.channelIds(channelIds, definition);
    const libraryId = randomUUID();
    await this.runtime.repository.createContentSourceVideoLibrary({ libraryId, sourceId: randomUUID(), instanceId, userId, displayName,
      sourceName: source.displayName, providerType: "python_live", mediaType: "live",
      configuration: { enabled: false, channelIds: selected, playbackMode: "relay", epgUrl: definition.epgUrls[0] ?? "", subscriptionRevision: randomUUID() },
      syncState: { status: "idle", processedCount: 0, pageCount: 0, nextPageByCategory: {}, lastError: null } });
    return { libraryId };
  }

  /** 只更新直播字段；停用订阅时立即退出该实例，不触发其他库刷新或同步。 */
  public async update(libraryId: string, userId: string, body: Record<string, unknown>): Promise<void> {
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw validationError("enabled", "订阅开关必须为布尔值");
    if (body.playbackMode !== undefined && body.playbackMode !== "direct" && body.playbackMode !== "relay") throw validationError("playbackMode", "直播播放方式只支持直连或中转");
    const next = await this.changeConfiguration(libraryId, userId, (current) => ({ ...current.configuration,
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      ...(body.playbackMode !== undefined ? { playbackMode: body.playbackMode as "direct" | "relay" } : {}),
      ...(body.channelIds !== undefined ? { channelIds: this.channelIds(body.channelIds, this.definition(current.manifest)) } : {}),
      ...(body.epgUrl !== undefined ? { epgUrl: liveHttpUrl(body.epgUrl) } : {}) }));
    if (!next.enabled) await this.stopLibrary(libraryId);
  }

  /** 只更换当前库的订阅修订，不修改频道、开关、账号或来源状态。 */
  public async resetSubscription(libraryId: string, userId: string): Promise<void> {
    await this.changeConfiguration(libraryId, userId, (current) => ({ ...current.configuration, subscriptionRevision: randomUUID() }));
  }

  /** 比较原配置后写入，防止并发保存设置将刚重置的订阅地址覆盖回去。 */
  private async changeConfiguration(libraryId: string, userId: string, change: (current: Awaited<ReturnType<LiveLibraryManager["get"]>>) => LiveLibraryConfiguration): Promise<LiveLibraryConfiguration> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.get(libraryId, userId);
      const next = change(current);
      const updated = await this.runtime.database.query("content_source_libraries")
        .where({ library_id: libraryId, user_id: userId, configuration_json: current.configurationJson })
        .update({ configuration_json: JSON.stringify(next), updated_at: new Date().toISOString() });
      if (updated) return next;
    }
    throw new ApiError(409, "live_configuration_changed", "直播设置刚被修改，请重试当前操作");
  }

  /** 播放和启动共用运行门控；停用插件、实例或媒体库立即阻止新请求。 */
  public async available(libraryId: string) {
    const state = await this.get(libraryId);
    if (state.library.status !== "active" || !state.configuration.enabled) throw new ApiError(403, "live_disabled", "直播订阅尚未开启或媒体库已停用");
    await this.runtime.contentSources.sourceForInstance(state.source.id, state.library.userId);
    return state;
  }

  /** 只接受当前插件内明确存在且不重复的频道身份。 */
  private channelIds(value: unknown, definition: LiveSourceDefinition): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 256 || value.some((id) => typeof id !== "string" || !definition.channels.some((channel) => channel.id === id)))
      throw validationError("channelIds", "请至少选择一个当前直播源的频道");
    return [...new Set(value as string[])];
  }

  /** 来源必须有已实现的引擎清单，不能把普通 Python 服务猜成 YSP。 */
  private definition(manifest: ContentSourceManifest): LiveSourceDefinition {
    if (manifest.adapter !== "python_live" || manifest.liveConfig?.engine !== "ysp") throw new ApiError(422, "live_engine_unsupported", "当前插件不是已适配的 YSP 直播源");
    return manifest.liveConfig;
  }

  /** 库禁用、删除时只终止本库绑定的进程，保留插件和其他服务。 */
  public async stopLibrary(libraryId: string): Promise<void> {
    const binding = await this.runtime.database.query("content_source_libraries").where({ library_id: libraryId }).first();
    if (binding) await this.process.stop(String(binding.instance_id));
  }
}
