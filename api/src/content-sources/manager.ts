import { randomUUID } from "node:crypto";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ServiceRepository } from "../service-repository.js";
import { validateProviderUrl } from "../providers/network.js";
import { categoryMatches, persistCmsContent } from "./catalog.js";
import { contentKey, validateContentManifest } from "./cms-adapter.js";
import { CmsVideoSourceAdapter } from "./video-adapter.js";
import { PythonVideoSourceAdapter } from "./python-adapter.js";
import { PythonSpiderRuntime } from "./python-runtime.js";
import { ContentItemDetailLoader, type ContentItemDetailContext } from "./content-detail-loader.js";
import { DynamicContentCatalog, type DynamicCatalogContext, type DynamicCatalogQuery } from "./dynamic-catalog.js";
import { initializeContentSourceSchema } from "./schema.js";
import { mergeCategoryCatalog, SourceCategoryLibraryReader } from "./source-category-library.js";
import type { CmsCatalogContentItem, ContentPlaybackSource, ContentSourceBrowseOptions, ContentSourceBrowseResult, ContentSourceCategory, ContentSourceCategoryDefinition, ContentSourceInstance, ContentSourceManifest, ContentSourcePendingBatch, ContentSourcePlaybackMode, ContentSourcePlaybackModes, ContentSourcePlaybackProtocol, ContentSourcePluginRecord, ContentSourceSearchOptions, ContentSourceSyncState, ContentVideoContainer, VideoSourceAdapter } from "./types.js";

// 关键变量：只有已核对关键词搜索和分页的 CMS 插件实时查源，其他插件继续搜索已有目录。
const CMS_REMOTE_SEARCH_PLUGIN_IDS = new Set([
  "cms.movie-paradise",
  "cms.huya-resources",
  "cms.jinying-resources",
  "cms.modu-resources",
  "cms.maoyan-resources",
  "cms.guangsu-resources",
]);

interface ContentLibraryConfiguration {
  categoryIds: string[];
  categories: ContentSourceCategory[];
  /** 保存已知分类树名称，取消选择不删除历史分类名称。 */
  categoryCatalog?: ContentSourceCategory[];
  /** 在线库两套协议独立配置，旧库未配置时均使用自动模式。 */
  playbackModes?: Partial<ContentSourcePlaybackModes>;
  initialPageCount: number;
}

/** 为旧库和未配置的协议应用自动模式，只接受已支持的播放模式。 */
function libraryPlaybackModes(configuration: ContentLibraryConfiguration): ContentSourcePlaybackModes {
  const modes = configuration.playbackModes;
  return {
    jellyfin: modes?.jellyfin === "direct" || modes?.jellyfin === "relay" ? modes.jellyfin : "auto",
    emby: modes?.emby === "direct" || modes?.emby === "relay" ? modes.emby : "auto",
  };
}

/** 读取受上限限制的同步分页数量。 */
function pageCount(value: unknown, maximum = 20): number {
  const count = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw validationError("pageCount", `同步页数必须为 1 至 ${maximum} 的整数`);
  return count;
}

/** 空目录的持久同步状态。 */
function emptySync(): ContentSourceSyncState {
  return { status: "idle", processedCount: 0, pageCount: 0, nextPageByCategory: {}, startedAt: null, finishedAt: null, lastError: null };
}

/** 创建和编辑都只展示源站支持的视频叶分类，父分类和排除分类不参与全选。 */
function selectableVideoCategories(categories: ContentSourceCategory[], manifest: ContentSourceManifest): ContentSourceCategory[] {
  const parentIds = new Set(categories.map((category) => category.parentId).filter((id) => id !== null));
  return categories.filter((category) => !parentIds.has(category.id) && !categoryMatches(category.id, manifest.excludedCategoryIds ?? [], categories));
}

/** 校验明确选择的分类集合，不限制全选数量，并保存源站名称快照。 */
function selectedVideoCategories(input: string[], available: ContentSourceCategory[]): Pick<ContentLibraryConfiguration, "categoryIds" | "categories"> {
  const categoryIds = [...new Set(input)];
  if (!categoryIds.length) throw validationError("categoryIds", "请至少选择一个视频叶分类");
  const availableIds = new Set(available.map((category) => category.id));
  if (categoryIds.some((id) => !availableIds.has(id))) throw validationError("categoryIds", "请只选择源站现有且支持视频库的叶分类");
  return { categoryIds, categories: available.filter((category) => categoryIds.includes(category.id)) };
}

/** 清单转换为管理端公开摘要，接口地址和请求头保留在服务端。 */
function mapPlugin(row: Record<string, unknown>): ContentSourcePluginRecord {
  const manifest = parseJsonObject(row.manifest_json);
  return { pluginId: String(row.plugin_id), version: String(row.version), displayName: String(manifest.displayName), description: String(manifest.description ?? ""), adapter: manifest.adapter === "netease_http" ? "netease_http" : manifest.adapter === "python_spider" ? "python_spider" : "cms_json", status: String(row.status) as ContentSourcePluginRecord["status"] };
}

/** 管理内容源插件和用户实例，统一 CMS、Python 视频目录与即时播放取址。 */
export class ContentSourceManager {
  public readonly pythonRuntime: PythonSpiderRuntime;
  private readonly pythonAdapters = new Map<string, PythonVideoSourceAdapter>();
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly categoryLibraryReader: SourceCategoryLibraryReader;
  private readonly dynamicCatalog: DynamicContentCatalog;
  private readonly itemDetails: ContentItemDetailLoader;
  // 关键变量：同步与浏览共用每条源内容的写入队列，避免两次 generation 互相淘汰播放线路。
  private readonly contentWrites = new Map<string, Promise<void>>();
  private closing = false;

  /** 复用既有数据库和目录仓储，建立按实例复用且按需启动的 Python 宿主。 */
  public constructor(private readonly database: FlyCloudHelperDatabase, private readonly config: ApiConfig, private readonly repository: ServiceRepository) {
    this.pythonRuntime = new PythonSpiderRuntime(config.pluginDirectory, config.pythonPath);
    this.categoryLibraryReader = new SourceCategoryLibraryReader(database);
    this.dynamicCatalog = new DynamicContentCatalog(
      (libraryId, userId, query) => this.dynamicContext(libraryId, userId, query),
      (context, content, itemTypes, signal) => this.persistDynamicContent(context, content, itemTypes, signal),
      (context, itemIds, itemTypes) => this.validateDynamicIndex(context, itemIds, itemTypes),
    );
    this.itemDetails = new ContentItemDetailLoader(database, repository,
      (libraryId, userId, itemId) => this.itemDetailContext(libraryId, userId, itemId),
      (context, operation, signal) => this.withContentWrite(context.libraryId, context.instanceId, context.remoteItemId, operation, signal));
  }

  /** 创建内容表，不自动安装插件；保留已有插件记录并处理重启中断的同步。 */
  public async initialize(): Promise<void> {
    await initializeContentSourceSchema(this.database);
    const now = new Date().toISOString();
    const interrupted = await this.database.query("content_source_libraries").whereIn("sync_status", ["queued", "running"]);
    for (const binding of interrupted) {
      const previous = parseJsonObject(binding.sync_json) as unknown as ContentSourceSyncState;
      await this.saveSync(String(binding.library_id), { ...emptySync(), ...previous, status: "failed", finishedAt: now, lastError: "服务重启中断了同步，可重新同步尚未完成的页面" });
    }
  }

  /** 停止后台请求并等待写入收尾，避免关闭数据库之后任务继续运行。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const adapter of this.pythonAdapters.values()) adapter.invalidate();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([this.dynamicCatalog.shutdown(), this.itemDetails.close(), ...[...this.jobs.values()].map((job) => job.promise)]);
    await this.pythonRuntime.close();
    this.pythonAdapters.clear();
  }

  /** 普通用户只看到启用版本，管理员能够看到全部安装状态。 */
  public async listPlugins(includeDisabled = false): Promise<ContentSourcePluginRecord[]> {
    const query = this.database.query("content_source_plugins").orderBy("plugin_id", "asc").orderBy("created_at", "desc");
    if (!includeDisabled) query.where({ status: "enabled" });
    return (await query).map(mapPlugin);
  }

  /** 脚本显式升级后仍复用原插件身份；重传新版按当前摘要匹配原记录。 */
  public async findPythonPluginByScriptHash(scriptHash: string): Promise<ContentSourcePluginRecord | null> {
    const rows = await this.database.query("content_source_plugins").select("*").orderBy("created_at", "asc");
    const matches = rows.filter((row) => {
      const manifest = parseJsonObject(row.manifest_json);
      return manifest.adapter === "python_spider" && manifest.scriptHash === scriptHash;
    });
    const row = matches.find((entry) => entry.status !== "uninstalled") ?? matches[0];
    return row ? mapPlugin(row) : null;
  }

  /** 导入声明式清单；同一 ID/版本不可静默替换已经安装的源地址和规则。 */
  public async importPlugin(value: unknown): Promise<ContentSourcePluginRecord> {
    const manifest = validateContentManifest(value);
    const previous = await this.database.query("content_source_plugins").where({ plugin_id: manifest.pluginId, version: manifest.version }).first();
    if (previous) {
      if (JSON.stringify(validateContentManifest(parseJsonObject(previous.manifest_json))) !== JSON.stringify(manifest)) throw new ApiError(409, "content_plugin_version_immutable", "同一插件版本已经存在，请使用新的版本号导入修改后的清单");
      if (String(previous.status) === "uninstalled") return this.setPluginStatus(manifest.pluginId, manifest.version, "imported");
      throw new ApiError(409, "content_plugin_already_exists", "已添加插件，不要重复导入");
    }
    const now = new Date().toISOString();
    try {
      await this.database.query("content_source_plugins").insert({ plugin_id: manifest.pluginId, version: manifest.version, manifest_json: JSON.stringify(manifest), status: "imported", created_at: now, updated_at: now });
    } catch (error) {
      // 关键变量：既有插件主键阻止并发重复插入，三种数据库都返回明确的重复提示。
      const code = String((error as { code?: unknown } | null)?.code ?? "");
      if (code === "23505" || code.startsWith("SQLITE_CONSTRAINT") || code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "content_plugin_already_exists", "已添加插件，不要重复导入");
      }
      throw error;
    }
    return { pluginId: manifest.pluginId, version: manifest.version, displayName: manifest.displayName, description: manifest.description, adapter: manifest.adapter, status: "imported" };
  }

  /** 启停或卸载仅改变执行状态，保留已绑定版本、实例、媒体库和观看记录。 */
  public async setPluginStatus(pluginId: string, version: string, status: ContentSourcePluginRecord["status"]): Promise<ContentSourcePluginRecord> {
    const query = this.database.query("content_source_plugins").where({ plugin_id: pluginId, version });
    // 关键变量：恢复导入只接受已卸载状态，同时重新导入时只能有一个请求成功。
    if (status === "imported") query.andWhere({ status: "uninstalled" });
    const changed = await query.update({ status, updated_at: new Date().toISOString() });
    if (!changed) {
      if (status === "imported" && await this.database.query("content_source_plugins").where({ plugin_id: pluginId, version }).first()) {
        throw new ApiError(409, "content_plugin_already_exists", "已添加插件，不要重复导入");
      }
      throw new ApiError(404, "content_plugin_not_found", "内容源插件版本不存在");
    }
    if (status !== "enabled") {
      const instances = await this.database.query("content_source_instances").select("id").where({ plugin_id: pluginId, plugin_version: version });
      for (const instance of instances) {
        await this.stopPythonAdapter(String(instance.id));
      }
      const bindings = await this.database.query("content_source_libraries as b").join("content_source_instances as i", "i.id", "b.instance_id").select("b.library_id").where({ "i.plugin_id": pluginId, "i.plugin_version": version });
      for (const binding of bindings) this.jobs.get(String(binding.library_id))?.controller.abort();
    }
    return mapPlugin(await this.database.query("content_source_plugins").where({ plugin_id: pluginId, version }).first());
  }

  /** 读取固定版本清单，并在每次使用前检查插件启用状态。 */
  private async manifest(pluginId: string, version: string): Promise<ContentSourceManifest> {
    const row = await this.database.query("content_source_plugins").where({ plugin_id: pluginId, version }).first();
    if (!row) throw new ApiError(404, "content_plugin_not_found", "内容源插件不存在");
    if (row.status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件当前未启用");
    return validateContentManifest(parseJsonObject(row.manifest_json));
  }

  /** 创建页直接引用已安装插件，适配器及源名称仍由服务端清单确定。 */
  public async manifestForPlugin(pluginId: string, version: string): Promise<ContentSourceManifest> {
    return this.manifest(pluginId, version);
  }

  /** 预览插件分类不写入实例，Python 临时会话无论成功或失败都立即释放。 */
  public async previewPluginCategories(pluginId: string, version: string, userId: string): Promise<ContentSourceCategory[]> {
    const manifest = await this.manifest(pluginId, version);
    // 关键变量：每次预览都有独立身份，不共享已有库的 Cookie、加密会话和分类上下文。
    const previewId = `preview:${userId}:${randomUUID()}`;
    const runtime = this.videoAdapter(manifest, previewId);
    try {
      return selectableVideoCategories(await runtime.adapter.categories(), runtime.manifest);
    } finally {
      if (manifest.adapter === "python_spider") await this.stopPythonAdapter(previewId);
    }
  }

  /** 查询带库关联和插件状态的源实例；用户归属始终是必填条件。 */
  public async listInstances(userId: string): Promise<ContentSourceInstance[]> {
    const rows = await this.database.query("content_source_instances as i")
      .join("content_source_plugins as p", function joinPinnedVersion() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .leftJoin("content_source_libraries as b", "b.instance_id", "i.id")
      .select("i.*", "p.status as plugin_status", "b.library_id").where({ "i.user_id": userId }).orderBy("i.created_at", "desc");
    return rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), pluginId: String(row.plugin_id), pluginVersion: String(row.plugin_version), displayName: String(row.display_name), status: String(row.status) as ContentSourceInstance["status"], pluginStatus: String(row.plugin_status) as ContentSourcePluginRecord["status"], libraryId: row.library_id ? String(row.library_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  /** 精确读取用户自己的实例。 */
  private async instance(instanceId: string, userId: string, requireActive = true): Promise<ContentSourceInstance> {
    const source = (await this.listInstances(userId)).find((item) => item.id === instanceId);
    if (!source) throw new ApiError(404, "content_source_not_found", "内容源实例不存在");
    if (requireActive && source.status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
    return source;
  }

  /** 建库时自动复用未绑定记录，同一用户同一插件不再新增重复实例。 */
  public async createInstance(userId: string, input: { pluginId: string; pluginVersion: string; displayName: string }): Promise<ContentSourceInstance> {
    const id = await this.database.query.transaction(async (transaction) => {
      // 关键变量：先锁真实账号行，再查询实例；多进程与多标签页按用户串行处理新增。
      const ownerQuery = transaction("user_accounts").select("id").where({ id: userId });
      if (this.database.databaseType !== "sqlite") ownerQuery.forUpdate();
      if (!await ownerQuery.first()) throw new ApiError(404, "user_not_found", "当前用户不存在");
      const plugin = await transaction("content_source_plugins").where({ plugin_id: input.pluginId, version: input.pluginVersion }).first();
      if (!plugin) throw new ApiError(404, "content_plugin_not_found", "内容源插件不存在");
      if (plugin.status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件当前未启用");
      validateContentManifest(parseJsonObject(plugin.manifest_json));
      const existing = await transaction("content_source_instances as i")
        .leftJoin("content_source_libraries as b", "b.instance_id", "i.id")
        .select("i.id", "i.plugin_version", "i.status", "b.library_id")
        .where({ "i.user_id": userId, "i.plugin_id": input.pluginId }).orderBy("i.created_at", "desc");
      if (existing.some((entry) => entry.library_id)) {
        throw new ApiError(409, "content_source_library_exists", "此插件已经创建媒体库，请进入已有媒体库设置");
      }
      // 关键变量：失败或中途退出留下的可用记录可继续使用，不自动修改其他旧记录。
      const available = existing.find((entry) => entry.plugin_version === input.pluginVersion && entry.status === "active");
      if (available) return String(available.id);
      if (existing.length > 0) {
        throw new ApiError(409, "content_source_instance_exists", "此插件已有停用或不同版本的源记录，不能重复添加");
      }
      const instanceId = randomUUID();
      const now = new Date().toISOString();
      await transaction("content_source_instances").insert({ id: instanceId, user_id: userId, plugin_id: input.pluginId, plugin_version: input.pluginVersion, display_name: input.displayName, status: "active", created_at: now, updated_at: now });
      return instanceId;
    });
    return this.instance(id, userId);
  }

  /** 修改实例名称或启停，不改变绑定的插件版本和媒体库身份。 */
  public async updateInstance(instanceId: string, userId: string, patch: { displayName?: string; status?: "active" | "disabled" }): Promise<ContentSourceInstance> {
    await this.instance(instanceId, userId, false);
    await this.database.query("content_source_instances").where({ id: instanceId, user_id: userId }).update({ ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}), ...(patch.status ? { status: patch.status } : {}), updated_at: new Date().toISOString() });
    const source = await this.instance(instanceId, userId, false);
    if (patch.status === "disabled" && source.libraryId) this.jobs.get(source.libraryId)?.controller.abort();
    if (patch.status === "disabled") await this.stopPythonAdapter(instanceId);
    return source;
  }

  /** 停止 CMS 与 Python 的详情任务，再释放 Python 缓存和宿主，重新启用使用新会话。 */
  private async stopPythonAdapter(instanceId: string): Promise<void> {
    await this.itemDetails.stopInstance(instanceId);
    this.pythonAdapters.get(instanceId)?.invalidate();
    this.pythonAdapters.delete(instanceId);
    await this.pythonRuntime.stopInstance(instanceId);
  }

  /** 从用户实例创建固定适配器，自动继承实例 HTTP 开关。 */
  public async adapterForInstance(instanceId: string, userId: string): Promise<{ adapter: VideoSourceAdapter; manifest: ContentSourceManifest; source: ContentSourceInstance }> {
    const source = await this.instance(instanceId, userId);
    const manifest = await this.manifest(source.pluginId, source.pluginVersion);
    return { source, ...this.videoAdapter(manifest, instanceId) };
  }

  /** CMS 保持原执行方式，Python 按实例保留适配器与分类上下文。 */
  private videoAdapter(manifest: ContentSourceManifest, instanceId: string): { adapter: VideoSourceAdapter; manifest: ContentSourceManifest } {
    if (manifest.adapter === "netease_http") throw new ApiError(409, "content_music_adapter_required", "网易音乐源请使用在线音乐目录入口");
    if (manifest.adapter === "python_spider") {
      let adapter = this.pythonAdapters.get(instanceId);
      if (!adapter) { adapter = new PythonVideoSourceAdapter(manifest, this.pythonRuntime, instanceId, this.config.pluginDirectory); this.pythonAdapters.set(instanceId, adapter); }
      return { adapter, manifest: adapter.sourceManifest };
    }
    return { adapter: new CmsVideoSourceAdapter(manifest, this.config.allowInsecureProviderHttp), manifest };
  }

  /** 保留原内部入口，让同步、分类编辑和取址共用同一视频适配器。 */
  private async adapter(instanceId: string, userId: string) { return this.adapterForInstance(instanceId, userId); }

  /** 创建入口按用户自己的实例识别适配器，不允许请求体切换已绑定的源类型。 */
  public async manifestForInstance(instanceId: string, userId: string): Promise<ContentSourceManifest> {
    const source = await this.instance(instanceId, userId);
    return this.manifest(source.pluginId, source.pluginVersion);
  }

  /** 读取可选择的视频叶分类，创建和编辑都可以直接全选返回结果。 */
  public async categories(instanceId: string, userId: string): Promise<ContentSourceCategory[]> {
    const runtime = await this.adapter(instanceId, userId);
    const categories = await runtime.adapter.categories();
    if (runtime.source.libraryId) await this.saveCategoryCatalog(runtime.source.libraryId, userId, categories);
    return selectableVideoCategories(categories, runtime.manifest);
  }

  /** 创建每实例独立视频库并安排小量首次同步，协议由用户创建完成后在库设置中启用。 */
  public async createLibrary(instanceId: string, userId: string, input: { displayName: string; categoryIds: string[]; initialPageCount?: number }) {
    const runtime = await this.adapter(instanceId, userId);
    const categories = await runtime.adapter.categories();
    const available = selectableVideoCategories(categories, runtime.manifest);
    const selected = selectedVideoCategories(input.categoryIds, available);
    const initialPageCount = pageCount(input.initialPageCount, 3);
    const configuration: ContentLibraryConfiguration = { ...selected, categoryCatalog: categories, initialPageCount };
    const libraryId = randomUUID();
    const created = await this.repository.createContentSourceVideoLibrary({ libraryId, sourceId: randomUUID(), instanceId, userId, displayName: input.displayName, sourceName: runtime.source.displayName, providerType: runtime.manifest.adapter === "python_spider" ? "python_spider" : "cms_json", configuration: configuration as unknown as Record<string, unknown>, syncState: emptySync() as unknown as Record<string, unknown> });
    const sync = await this.startLibrarySync(libraryId, userId, { pageCount: initialPageCount, sample: true });
    return { libraryId, library: created.library, sync };
  }

  /** 读取内容库及持久化同步进度，停用后的历史状态仍可查看。 */
  public async getLibrary(libraryId: string, userId: string): Promise<{ source: ContentSourceInstance; configuration: ContentLibraryConfiguration; sync: ContentSourceSyncState }> {
    const row = await this.database.query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .select("b.*").where({ "b.library_id": libraryId, "b.user_id": userId, "l.user_id": userId, "l.library_kind": "content_source_video" }).first();
    if (!row) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
    return { source: await this.instance(String(row.instance_id), userId, false), configuration: parseJsonObject(row.configuration_json) as unknown as ContentLibraryConfiguration, sync: { ...emptySync(), ...parseJsonObject(row.sync_json) } as ContentSourceSyncState };
  }

  /** 按源分类提供协议媒体库定义，不依赖源站实时可用，也不改变电影、节目条目身份。 */
  public async listLibraryCategoryDefinitions(libraryId: string, userId: string): Promise<ContentSourceCategoryDefinition[]> {
    return this.categoryLibraryReader.read(libraryId, userId);
  }

  /** 选中分类按需建立目录；源停用时不联网，协议继续展示原有本地目录。 */
  public async browseLibraryCategory(libraryId: string, userId: string, options: ContentSourceBrowseOptions): Promise<ContentSourceBrowseResult | null> {
    try { return await this.dynamicCatalog.browse(libraryId, userId, options); }
    catch (error) {
      if (error instanceof ApiError && ["content_plugin_disabled", "content_source_disabled"].includes(error.code)) return null;
      throw error;
    }
  }

  /** 已确认支持 CMS 搜索的源在导入启用后实时查词，其他插件和停用源继续原本地搜索。 */
  public async searchLibrary(libraryId: string, userId: string, options: ContentSourceSearchOptions): Promise<ContentSourceBrowseResult | null> {
    try { return await this.dynamicCatalog.search(libraryId, userId, options); }
    catch (error) {
      if (error instanceof ApiError && ["content_search_unsupported", "content_plugin_disabled", "content_source_disabled"].includes(error.code)) return null;
      throw error;
    }
  }

  /** 清空或删除在线库时先停止动态回填，实际同步检查和目录事务继续交给既有仓储。 */
  public async withLibraryCatalogChange<T>(libraryId: string, operation: () => Promise<T>): Promise<T> {
    return this.itemDetails.withLibraryChange(libraryId, () => this.dynamicCatalog.withLibraryCatalogChange(libraryId, async () => {
      const binding = await this.database.query("content_source_libraries").select("instance_id").where({ library_id: libraryId }).first();
      if (binding) await this.stopPythonAdapter(String(binding.instance_id));
      return operation();
    }));
  }

  /** 详情、选集与播放共用按需补齐；普通列表和播放来源枚举不触发源查询。 */
  public async ensureItemDetail(libraryId: string, userId: string, itemId: string, signal?: AbortSignal): Promise<void> {
    await this.itemDetails.ensure(libraryId, userId, itemId, signal);
  }

  /** 从已存在的媒体身份恢复视频源定位，用户或跨库请求不能指定远端影片。 */
  private async itemDetailContext(libraryId: string, userId: string, itemId: string): Promise<ContentItemDetailContext | null> {
    const library = await this.database.query("media_libraries").select("library_kind", "status")
      .where({ id: libraryId, user_id: userId }).first();
    if (!library || library.library_kind !== "content_source_video") return null;
    // 关键变量：仅在线 CMS 和 Python 视频库补详情，网盘与音乐库继续沿用原入口。
    const sourceType = await this.database.query("content_source_libraries as b")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinDetailPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .select("p.manifest_json", "b.library_source_id").where({ "b.library_id": libraryId, "b.user_id": userId, "i.user_id": userId }).first();
    if (!sourceType) return null;
    const adapterType = parseJsonObject(sourceType.manifest_json).adapter;
    if (adapterType !== "python_spider" && adapterType !== "cms_json") return null;
    if (library.status !== "active") throw new ApiError(409, "content_library_disabled", "媒体库已停用");
    const binding = await this.getLibrary(libraryId, userId);
    const sourceStatus = await this.database.query("library_sources").select("status")
      .where({ id: String(sourceType.library_source_id), library_id: libraryId, user_id: userId, source_mode: "content_source" }).first();
    if (!sourceStatus || sourceStatus.status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
    const runtime = await this.adapter(binding.source.id, userId);
    const item = await this.repository.getCatalogItem(itemId, userId);
    if (item.libraryId !== libraryId) throw new ApiError(404, "content_item_not_found", "媒体条目不存在");
    const source = item.metadata.contentSource;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new ApiError(409, "content_source_locator_missing", "内容源条目缺少定位，请刷新目录");
    }
    const locator = source as Record<string, unknown>;
    if (locator.instanceId !== binding.source.id || typeof locator.remoteItemId !== "string" || !locator.remoteItemId) {
      throw new ApiError(409, "content_source_locator_missing", "内容源条目定位已变化，请刷新目录");
    }
    const categories = mergeCategoryCatalog(binding.configuration, []);
    if (runtime.adapter instanceof PythonVideoSourceAdapter) {
      runtime.adapter.useCategoryCatalog(categories);
      if (typeof locator.categoryId === "string") runtime.adapter.useItemCategory(locator.remoteItemId, locator.categoryId);
    }
    return { libraryId, userId, itemId, instanceId: binding.source.id, remoteItemId: locator.remoteItemId,
      manifest: runtime.manifest, categories, adapter: runtime.adapter };
  }

  /** 每次取页或入库都核对归属、库启用状态、固定插件版本和当前所选分类。 */
  private async dynamicContext(libraryId: string, userId: string, query: DynamicCatalogQuery): Promise<DynamicCatalogContext> {
    const row = await this.database.query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .join("library_sources as ls", "ls.id", "b.library_source_id")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinDynamicPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .select("b.instance_id", "b.configuration_json", "p.plugin_id", "p.manifest_json", "p.status as plugin_status", "i.status as instance_status", "l.status as library_status", "ls.status as source_status")
      .where({ "b.library_id": libraryId, "b.user_id": userId, "l.user_id": userId, "i.user_id": userId, "ls.user_id": userId, "l.library_kind": "content_source_video" }).first();
    if (!row) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
    if (row.library_status !== "active") throw new ApiError(409, "content_library_disabled", "媒体库已停用");
    if (row.instance_status !== "active" || row.source_status !== "active") throw new ApiError(409, "content_source_disabled", "内容源实例已停用");
    if (row.plugin_status !== "enabled") throw new ApiError(409, "content_plugin_disabled", "内容源插件当前未启用");
    const configuration = parseJsonObject(row.configuration_json) as unknown as ContentLibraryConfiguration;
    const categories = mergeCategoryCatalog(configuration, []);
    const runtime = this.videoAdapter(validateContentManifest(parseJsonObject(row.manifest_json)), String(row.instance_id));
    const manifest = runtime.manifest;
    if (runtime.adapter instanceof PythonVideoSourceAdapter) runtime.adapter.useCategoryCatalog(categories);
    if (query.kind === "search" && manifest.adapter !== "python_spider" && !CMS_REMOTE_SEARCH_PLUGIN_IDS.has(String(row.plugin_id))) throw new ApiError(422, "content_search_unsupported", "此插件继续使用已入库内容搜索");
    // 关键变量：全库搜索也只接纳当前所选且仍受清单支持的视频叶分类。
    const availableIds = new Set(selectableVideoCategories(categories, manifest).map((category) => category.id));
    const selectedIds = configuration.categoryIds.filter((id) => availableIds.has(id));
    const categoryId = query.categoryId;
    if (categoryId !== undefined && !configuration.categoryIds.includes(categoryId)) throw new ApiError(404, "content_category_not_selected", "此分类不在媒体库当前选择范围内");
    if (categoryId !== undefined && !availableIds.has(categoryId)) throw new ApiError(422, "content_category_unsupported", "此分类不支持视频目录查询");
    const categoryIds = categoryId === undefined ? selectedIds : [categoryId];
    const instanceId = String(row.instance_id);
    const identity = JSON.stringify([instanceId, manifest, categories, [...configuration.categoryIds].sort()]);
    return { libraryId, userId, instanceId, query, categoryIds, identity, manifest, categories, adapter: runtime.adapter };
  }

  /** 按同一内容串行写入，等待中的请求收到取消后不再开始新的目录修改。 */
  private async withContentWrite<T>(libraryId: string, instanceId: string, remoteItemId: string, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const key = `${libraryId}:${instanceId}:${remoteItemId}`;
    const previous = this.contentWrites.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.contentWrites.set(key, current);
    await previous;
    try { signal.throwIfAborted(); return await operation(); }
    finally { release(); if (this.contentWrites.get(key) === current) this.contentWrites.delete(key); }
  }

  /** 落库前台需求与后台预取目录；人工类型优先，写入并验证后才返回动态索引父 ID。 */
  private async persistDynamicContent(context: DynamicCatalogContext, content: CmsCatalogContentItem, itemTypes: string[], signal: AbortSignal): Promise<string | null> {
    return this.withContentWrite(context.libraryId, context.instanceId, content.id, async () => {
      const current = await this.dynamicContext(context.libraryId, context.userId, context.query);
      signal.throwIfAborted();
      if (current.identity !== context.identity) throw new ApiError(409, "content_catalog_changed", "目录范围在加载期间发生变化，请重新加载");
      if (!current.categoryIds.includes(content.categoryId)) return null;
      const identityKey = `content:${current.instanceId}:${contentKey(content.id)}`;
      const existing = await this.database.query("media_items").select("id", "item_type", "metadata_json")
        .where({ library_id: current.libraryId, user_id: current.userId, identity_key: identityKey }).first();
      const manualMatch = existing ? parseJsonObject(existing.metadata_json).manualMatch : undefined;
      const movie = categoryMatches(content.categoryId, current.manifest.movieCategoryIds, current.categories)
        || Boolean(content.parentCategoryId && current.manifest.movieCategoryIds.includes(content.parentCategoryId));
      const itemType = manualMatch && typeof manualMatch === "object" && !Array.isArray(manualMatch) && Object.keys(manualMatch).length > 0
        ? String(existing.item_type) : movie ? "video.movie" : "video.series";
      if (!itemTypes.includes(itemType)) return null;
      await persistCmsContent({ database: this.database, repository: this.repository, userId: current.userId, libraryId: current.libraryId, instanceId: current.instanceId, manifest: current.manifest, categories: current.categories, content });
      signal.throwIfAborted();
      const parent = await this.database.query("media_items").select("id").where({ library_id: current.libraryId, user_id: current.userId, identity_key: identityKey }).whereNull("deleted_at").first();
      if (!parent) return null;
      const itemId = String(parent.id);
      return await this.validateDynamicIndex(current, [itemId], itemTypes) ? itemId : null;
    }, signal);
  }

  /** 查询已建立索引的真实父条目与有效播放定位，清空、迁类或线路失效后重建窗口。 */
  private async validateDynamicIndex(context: DynamicCatalogContext, itemIds: string[], itemTypes: string[]): Promise<boolean> {
    for (let offset = 0; offset < itemIds.length; offset += 100) {
      const batch = itemIds.slice(offset, offset + 100);
      const query = this.database.query("media_items as m").select("m.id", "m.metadata_json")
        .where({ "m.library_id": context.libraryId, "m.user_id": context.userId }).whereIn("m.id", batch).whereIn("m.item_type", itemTypes).whereNull("m.deleted_at");
      if (context.manifest.adapter !== "python_spider" && context.manifest.adapter !== "cms_json") query.where((builder) => builder.where((movies) => movies.where("m.item_type", "video.movie")
          .whereExists(this.database.query("content_playback_sources as p").select("p.id")
            .whereRaw("?? = ??", ["p.item_id", "m.id"]).where({ "p.library_id": context.libraryId, "p.user_id": context.userId, "p.instance_id": context.instanceId, "p.status": "active" })))
          .orWhere((series) => series.where("m.item_type", "video.series")
            .whereExists(this.database.query("media_relations as r").join("media_items as child", "child.id", "r.child_item_id").join("content_playback_sources as p", "p.item_id", "child.id").select("p.id")
              .whereRaw("?? = ??", ["r.parent_item_id", "m.id"]).where({ "r.library_id": context.libraryId, "r.user_id": context.userId, "r.relation_type": "series_episode", "child.item_type": "video.episode", "child.library_id": context.libraryId, "child.user_id": context.userId, "p.library_id": context.libraryId, "p.user_id": context.userId, "p.instance_id": context.instanceId, "p.status": "active" }).whereNull("child.deleted_at"))));
      // CMS 与 Python 卡片按稳定父身份判断可浏览性；实际线路在详情和播放时校验。
      const rows = await query;
      if (rows.length !== batch.length) return false;
      if (rows.some((row) => {
        const source = parseJsonObject(row.metadata_json).contentSource;
        if (!source || typeof source !== "object" || Array.isArray(source)) return true;
        const locator = source as Record<string, unknown>;
        return locator.instanceId !== context.instanceId
          || !context.categoryIds.includes(String(locator.categoryId ?? ""));
      })) return false;
    }
    return true;
  }

  /** 读取用户在线库的两套播放模式，停用源仍允许查看和调整配置。 */
  public async getLibraryPlaybackModes(libraryId: string, userId: string): Promise<ContentSourcePlaybackModes> {
    const binding = await this.database.query("content_source_libraries").select("configuration_json").where({ library_id: libraryId, user_id: userId }).first();
    if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
    return libraryPlaybackModes(parseJsonObject(binding.configuration_json) as unknown as ContentLibraryConfiguration);
  }

  /** 协议播放流程只读取自身模式，两套协议缺省均为自动。 */
  public async getLibraryPlaybackMode(libraryId: string, userId: string, protocol: ContentSourcePlaybackProtocol): Promise<ContentSourcePlaybackMode> {
    return (await this.getLibraryPlaybackModes(libraryId, userId))[protocol];
  }

  /** 使用与分类编辑相同的库行锁，只合并播放配置，同步中也不覆盖分类和同步状态。 */
  public async setLibraryPlaybackMode(libraryId: string, userId: string, protocol: ContentSourcePlaybackProtocol, mode: ContentSourcePlaybackMode): Promise<ContentSourcePlaybackModes> {
    if (protocol !== "jellyfin" && protocol !== "emby") throw validationError("protocol", "播放协议只支持 jellyfin 或 emby");
    if (mode !== "auto" && mode !== "direct" && mode !== "relay") throw validationError("mode", "播放模式只支持 auto、direct 或 relay");
    return this.database.query.transaction(async (transaction) => {
      const libraryQuery = transaction("media_libraries").where({ id: libraryId, user_id: userId, library_kind: "content_source_video" });
      if (this.database.databaseType !== "sqlite") libraryQuery.forUpdate();
      if (!(await libraryQuery.first())) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      const binding = await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).first();
      if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      // 关键变量：锁内读取最新配置，另一协议和分类范围始终沿用当前持久化值。
      const configuration = parseJsonObject(binding.configuration_json) as unknown as ContentLibraryConfiguration;
      const modes = libraryPlaybackModes(configuration);
      if (modes[protocol] === mode) return modes;
      modes[protocol] = mode;
      await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({
        configuration_json: JSON.stringify({ ...configuration, playbackModes: modes }), updated_at: new Date().toISOString(),
      });
      return modes;
    });
  }

  /** 保存源分类名称时重读最新配置，只合并快照，不覆盖选择、游标或未完成批次。 */
  private async saveCategoryCatalog(libraryId: string, userId: string, categories: ContentSourceCategory[]): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      const libraryQuery = transaction("media_libraries").where({ id: libraryId, user_id: userId });
      if (this.database.databaseType !== "sqlite") libraryQuery.forUpdate();
      if (!(await libraryQuery.first())) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      const binding = await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).first();
      if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      const configuration = parseJsonObject(binding.configuration_json) as unknown as ContentLibraryConfiguration;
      const categoryCatalog = mergeCategoryCatalog(configuration, categories);
      const selectedCategories = categoryCatalog.filter((category) => configuration.categoryIds.includes(category.id));
      const nextConfiguration = { ...configuration, categoryCatalog, categories: selectedCategories };
      if (JSON.stringify(nextConfiguration) === JSON.stringify(configuration)) return;
      await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({ configuration_json: JSON.stringify(nextConfiguration), updated_at: new Date().toISOString() });
    });
  }

  /** 从已有库解析所属实例，个人和管理员使用相同的可选视频分类规则。 */
  public async libraryCategories(libraryId: string, userId: string): Promise<ContentSourceCategory[]> {
    const detail = await this.getLibrary(libraryId, userId);
    return this.categories(detail.source.id, userId);
  }

  /** 修改未来导入范围，保留目录和历史游标，不自动启动同步。 */
  public async updateLibraryCategories(libraryId: string, userId: string, categoryIds: string[]): Promise<Awaited<ReturnType<ContentSourceManager["getLibrary"]>>> {
    const selected = selectedVideoCategories(categoryIds, await this.libraryCategories(libraryId, userId));
    // 关键变量：源站请求在事务外完成；保存与启动同步共用媒体库行锁，锁内重新读取最新配置和状态。
    await this.database.query.transaction(async (transaction) => {
      const libraryQuery = transaction("media_libraries").where({ id: libraryId, user_id: userId, library_kind: "content_source_video" });
      if (this.database.databaseType !== "sqlite") libraryQuery.forUpdate();
      if (!(await libraryQuery.first())) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      const binding = await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).first();
      if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      if (binding.sync_status === "queued" || binding.sync_status === "running") throw new ApiError(409, "content_sync_running", "同步期间不能修改分类，请等待本次同步结束");
      const configuration = parseJsonObject(binding.configuration_json) as unknown as ContentLibraryConfiguration;
      const previousIds = new Set(configuration.categoryIds);
      if (previousIds.size === selected.categoryIds.length && selected.categoryIds.every((id) => previousIds.has(id))) return;
      const previousSync = { ...emptySync(), ...parseJsonObject(binding.sync_json) } as ContentSourceSyncState;
      // 关键变量：取消分类也保留其游标，再次添加时继续原页；从未选择的分类从第一页开始。
      const nextPageByCategory = { ...previousSync.nextPageByCategory };
      for (const id of selected.categoryIds) nextPageByCategory[id] ??= 1;
      const sync: ContentSourceSyncState = { ...emptySync(), nextPageByCategory };
      await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).update({
        configuration_json: JSON.stringify({ ...configuration, ...selected }),
        sync_status: sync.status, sync_json: JSON.stringify(sync), updated_at: new Date().toISOString(),
      });
    });
    return this.getLibrary(libraryId, userId);
  }

  /** 持久化同步状态，页面成功后才推进该分类游标。 */
  private async saveSync(libraryId: string, sync: ContentSourceSyncState): Promise<void> {
    await this.database.query("content_source_libraries").where({ library_id: libraryId }).update({ sync_status: sync.status, sync_json: JSON.stringify(sync), updated_at: new Date().toISOString() });
  }

  /** 已确认条目被源站移除时仅停用播放定位，保留目录身份与观看记录供以后恢复。 */
  private async markRemoteUnavailable(libraryId: string, userId: string, instanceId: string, remoteItemId: string): Promise<void> {
    const rows = await this.database.query("content_playback_sources").select("item_id")
      .where({ library_id: libraryId, user_id: userId, instance_id: instanceId, remote_item_id: remoteItemId, status: "active" });
    if (!rows.length) return;
    const itemIds = [...new Set(rows.map((row) => String(row.item_id)))];
    const parentIds = new Set<string>();
    for (let offset = 0; offset < itemIds.length; offset += 100) {
      const parentRows = await this.database.query("media_relations").distinct("parent_item_id")
        .where({ library_id: libraryId, user_id: userId }).whereIn("child_item_id", itemIds.slice(offset, offset + 100));
      parentRows.forEach((row) => parentIds.add(String(row.parent_item_id)));
    }
    await this.database.query("content_playback_sources")
      .where({ library_id: libraryId, user_id: userId, instance_id: instanceId, remote_item_id: remoteItemId, status: "active" })
      .update({ status: "unavailable", updated_at: new Date().toISOString() });
    await this.repository.publishContentSourceCatalogChanges(userId, libraryId, [...itemIds, ...parentIds]);
  }

  /** 抢占媒体库同步；latest读取已选分类首页，next连续导入，refresh更新已入库条目。 */
  public async startLibrarySync(libraryId: string, userId: string, options: {
    pageCount?: number;
    mode?: "next" | "refresh" | "latest";
    sample?: boolean;
    /** 自动同步专用领取身份；手动同步不传，也不受计划开关影响。 */
    autoSyncClaim?: { revision: number; token: string };
  } = {}): Promise<ContentSourceSyncState> {
    if (this.closing) throw new ApiError(503, "content_source_stopping", "服务正在停止，请稍后同步");
    if (this.jobs.has(libraryId)) throw new ApiError(409, "content_sync_running", "此在线库已经在同步");
    const mode = options.mode ?? "next";
    const detail = await this.getLibrary(libraryId, userId);
    await this.adapter(detail.source.id, userId);
    // 关键变量：自动首页同步固定每分类一页，不借用或推进手动下一批的页数。
    const requestedPageCount = mode === "latest" ? 1 : pageCount(options.pageCount);
    const sync = await this.database.query.transaction(async (transaction) => {
      const libraryQuery = transaction("media_libraries").where({ id: libraryId, user_id: userId, status: "active" });
      if (this.database.databaseType !== "sqlite") libraryQuery.forUpdate();
      if (!(await libraryQuery.first())) throw new ApiError(409, "content_library_disabled", "媒体库已停用或不存在");
      if (options.autoSyncClaim) {
        // 关键变量：计划保存与同步入队锁同一库行，关闭或改计划先提交后，旧领取不能继续排队。
        const currentClaim = await transaction("content_source_auto_sync_plans")
          .where({ library_id: libraryId, user_id: userId, enabled: 1,
            revision: options.autoSyncClaim.revision, claim_token: options.autoSyncClaim.token })
          .select("library_id").first();
        if (!currentClaim) throw new ApiError(409, "content_auto_sync_plan_changed", "自动同步计划已修改或关闭，本次任务未启动");
      }
      // 关键变量：分类编辑可能先取得锁，目标范围必须使用锁内最新配置，不能复用事务外的旧详情。
      const binding = await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).first();
      if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
      const configuration = parseJsonObject(binding.configuration_json) as unknown as ContentLibraryConfiguration;
      const previousSync = { ...emptySync(), ...parseJsonObject(binding.sync_json) } as ContentSourceSyncState;
      // 首次启动固定目标页，失败重试不得从新游标重新增加页数；旧记录没有批次则按新请求开始。
      const pendingBatch: ContentSourcePendingBatch | undefined = mode === "next"
        ? previousSync.pendingBatch ?? {
          pageCount: requestedPageCount,
          sample: Boolean(options.sample),
          endPageExclusiveByCategory: Object.fromEntries(configuration.categoryIds.map((id) => [id, (previousSync.nextPageByCategory[id] ?? 1) + requestedPageCount])),
          completedCategoryIds: [],
          remainingSampleCountByCategory: {},
          ...(options.sample ? { sampledItemIdsByCategory: {} } : {}),
        }
        : previousSync.pendingBatch;
      const nextSync: ContentSourceSyncState = { ...previousSync, status: "queued", processedCount: 0, pageCount: mode === "next" ? pendingBatch!.pageCount : requestedPageCount, startedAt: new Date().toISOString(), finishedAt: null, lastError: null, nextPageByCategory: { ...previousSync.nextPageByCategory }, ...(pendingBatch ? { pendingBatch } : {}) };
      const changed = await transaction("content_source_libraries").where({ library_id: libraryId, user_id: userId }).whereNotIn("sync_status", ["queued", "running"]).update({ sync_status: "queued", sync_json: JSON.stringify(nextSync), updated_at: new Date().toISOString() });
      if (changed !== 1) throw new ApiError(409, "content_sync_running", "此在线库已经在同步");
      return nextSync;
    });
    const controller = new AbortController();
    const promise = this.runSync(libraryId, userId, sync, mode, controller.signal)
      .catch(() => { /* 数据库不可用时状态写入也可能失败，启动恢复会把未完成任务标为可重试。 */ })
      .finally(() => { this.jobs.delete(libraryId); });
    this.jobs.set(libraryId, { controller, promise });
    return sync;
  }

  /** 后台同步保留已入库资料；首页更新不写连续导入游标，其他模式沿用原检查点。 */
  private async runSync(libraryId: string, userId: string, sync: ContentSourceSyncState, mode: "next" | "refresh" | "latest", signal: AbortSignal): Promise<void> {
    try {
      sync.status = "running";
      await this.saveSync(libraryId, sync);
      const detail = await this.getLibrary(libraryId, userId);
      const runtime = await this.adapter(detail.source.id, userId);
      const categories = await runtime.adapter.categories(signal);
      await this.saveCategoryCatalog(libraryId, userId, categories);
      /** 单条成功入库后同时保存处理数量和样本检查点，重试不能重置剩余额度。 */
      const persist = async (content: Awaited<ReturnType<VideoSourceAdapter["detail"]>>, sampleCategoryId?: string) => {
        signal.throwIfAborted();
        const card = content.detailState === "card";
        if (content.episodes.length === 0 && !card) {
          await this.withContentWrite(libraryId, detail.source.id, content.id,
            () => this.markRemoteUnavailable(libraryId, userId, detail.source.id, content.id), signal);
          return;
        }
        if (categoryMatches(content.categoryId, runtime.manifest.excludedCategoryIds ?? [], categories)) return;
        await this.adapter(detail.source.id, userId); // 关键变量：每次入库前重新检查源和插件状态，停用后不继续写入。
        await this.withContentWrite(libraryId, detail.source.id, content.id, () => persistCmsContent({ database: this.database, repository: this.repository, userId, libraryId, instanceId: detail.source.id, manifest: runtime.manifest, categories, content }), signal);
        sync.processedCount += 1;
        if (sampleCategoryId && sync.pendingBatch?.sample) {
          const batch = sync.pendingBatch;
          batch.remainingSampleCountByCategory[sampleCategoryId] = Math.max(0, (batch.remainingSampleCountByCategory[sampleCategoryId] ?? 0) - 1);
          batch.sampledItemIdsByCategory ??= {};
          const sampledIds = batch.sampledItemIdsByCategory[sampleCategoryId] ?? [];
          if (!sampledIds.includes(content.id)) sampledIds.push(content.id);
          batch.sampledItemIdsByCategory[sampleCategoryId] = sampledIds;
        }
        await this.saveSync(libraryId, sync);
      };
      if (mode === "refresh") {
        const rows = await this.database.query("content_playback_sources as p").join("media_items as m", "m.id", "p.item_id")
          .distinct("p.remote_item_id").where({ "p.library_id": libraryId, "p.user_id": userId }).whereNull("m.deleted_at");
        for (const row of rows) {
          signal.throwIfAborted();
          try {
            if (runtime.adapter instanceof PythonVideoSourceAdapter) {
              await this.restorePythonItemCategory(runtime.adapter, libraryId, userId, detail.source.id, String(row.remote_item_id));
            }
            await persist(await runtime.adapter.detail(String(row.remote_item_id), signal));
          } catch (error) {
            if (!(error instanceof ApiError) || error.code !== "content_source_item_missing") throw error;
            await this.withContentWrite(libraryId, detail.source.id, String(row.remote_item_id),
              () => this.markRemoteUnavailable(libraryId, userId, detail.source.id, String(row.remote_item_id)), signal);
            // 确定不存在的单条内容不能阻止其余节目继续更新；临时网络失败仍交由整批失败处理。
            sync.processedCount += 1;
            await this.saveSync(libraryId, sync);
          }
        }
      } else if (mode === "latest") {
        // 关键变量：只处理当前仍有效的已选视频叶分类，源新增分类需用户选择后才参与自动同步。
        const availableIds = new Set(selectableVideoCategories(categories, runtime.manifest).map((category) => category.id));
        const selectedCategoryIds = detail.configuration.categoryIds.filter((id) => availableIds.has(id));
        const processedRemoteIds = new Set<string>();
        for (const categoryId of selectedCategoryIds) {
          signal.throwIfAborted();
          const firstPage = await runtime.adapter.page(categoryId, 1, signal);
          for (const content of firstPage.items) {
            // 源站必须返回该叶分类的真实作品；同一源条目在本次同步中只写入一次。
            if (content.categoryId !== categoryId || processedRemoteIds.has(content.id)) continue;
            await persist(content);
            processedRemoteIds.add(content.id);
          }
        }
        // 首页只是本轮样本，离开首页的旧作品继续保留，手动游标和未完成批次不变。
      } else {
        const batch = sync.pendingBatch;
        if (!batch) throw new ApiError(500, "content_sync_batch_missing", "目录同步缺少批次范围，请重新发起同步");
        for (const categoryId of detail.configuration.categoryIds) {
          if (batch.completedCategoryIds.includes(categoryId)) continue;
          let currentPage = sync.nextPageByCategory[categoryId] ?? 1;
          const endPageExclusive = batch.endPageExclusiveByCategory[categoryId];
          if (endPageExclusive === undefined) throw new ApiError(500, "content_sync_batch_missing", "目录同步缺少分类批次范围，请重新发起同步");
          // 关键变量：首次样例额度属于整个分类，跨页或重试都不能重新获得额度。
          if (batch.sample && batch.remainingSampleCountByCategory[categoryId] === undefined) {
            batch.remainingSampleCountByCategory[categoryId] = categoryMatches(categoryId, runtime.manifest.movieCategoryIds, categories) ? 3 : 1;
            await this.saveSync(libraryId, sync);
          }
          while (currentPage < endPageExclusive && (!batch.sample || batch.remainingSampleCountByCategory[categoryId]! > 0)) {
            signal.throwIfAborted();
            const page = await runtime.adapter.page(categoryId, currentPage, signal);
            if (page.items.length === 0) break;
            const sampledIds = batch.sampledItemIdsByCategory?.[categoryId] ?? [];
            const playableItems = page.items.filter((content) => (content.episodes.length > 0 || content.detailState === "card")
              && (!batch.sample || !sampledIds.includes(content.id)));
            const items = batch.sample ? playableItems.slice(0, batch.remainingSampleCountByCategory[categoryId]) : playableItems;
            for (const content of items) await persist(content, batch.sample ? categoryId : undefined);
            // 首次样例只导入少量条目，保留当前页以便下一批补齐剩余内容。
            if (batch.sample && items.length < playableItems.length) break;
            currentPage += 1;
            sync.nextPageByCategory[categoryId] = currentPage;
            await this.saveSync(libraryId, sync);
            if (currentPage > page.pageCount) break;
          }
          // 空页、源末页、样本额度用完或目标页完成，均结束本分类；重试直接跳过。
          batch.completedCategoryIds.push(categoryId);
          await this.saveSync(libraryId, sync);
        }
      }
      sync.status = "completed";
      sync.finishedAt = new Date().toISOString();
      await this.database.query("media_libraries").where({ id: libraryId, user_id: userId }).update({ last_scan_at: sync.finishedAt, updated_at: sync.finishedAt });
      await this.database.query("library_sources").where({ library_id: libraryId, source_mode: "content_source" }).update({ last_scan_at: sync.finishedAt, updated_at: sync.finishedAt });
      if (mode === "next") delete sync.pendingBatch;
    } catch (error) {
      sync.status = "failed";
      sync.finishedAt = new Date().toISOString();
      // 关键变量：数据库异常原文可能带 SQL 参数，仅记录错误代码和类型用于定位。
      const failure = error && typeof error === "object" ? error as { code?: unknown; name?: unknown } : {};
      console.warn(JSON.stringify({
        日志关键字: "codex-content-source-sync",
        事件: "内容源目录同步失败",
        媒体库ID: libraryId,
        已处理数量: sync.processedCount,
        错误代码: typeof failure.code === "string" ? failure.code : "unknown",
        错误类型: typeof failure.name === "string" ? failure.name : typeof error,
      }));
      sync.lastError = signal.aborted ? "同步已停止，已有内容和游标保留" : error instanceof ApiError ? error.message : "内容源同步失败，请检查源站与数据库状态后重试";
    } finally {
      await this.saveSync(libraryId, sync);
    }
  }

  /** 查询当前启用来源，供协议层每次取流和 HLS 子请求检查启停状态。 */
  public async listPlaybackSources(itemId: string, userId: string): Promise<ContentPlaybackSource[]> {
    const rows = await this.database.query("content_playback_sources as p")
      .join("media_items as m", function joinBoundItem() { this.on("m.id", "=", "p.item_id").andOn("m.library_id", "=", "p.library_id"); })
      .join("media_libraries as l", "l.id", "p.library_id")
      .join("content_source_libraries as binding", function joinPlaybackBinding() { this.on("binding.library_id", "=", "p.library_id").andOn("binding.instance_id", "=", "p.instance_id"); })
      .join("library_sources as ls", "ls.id", "binding.library_source_id")
      .join("content_source_instances as i", "i.id", "p.instance_id")
      .join("content_source_plugins as plugin", function joinPlaybackPlugin() { this.on("plugin.plugin_id", "=", "i.plugin_id").andOn("plugin.version", "=", "i.plugin_version"); })
      .select("p.*", "i.display_name as source_name")
      .where({ "p.item_id": itemId, "p.user_id": userId, "m.user_id": userId, "l.user_id": userId, "i.user_id": userId, "p.status": "active", "l.status": "active", "l.library_kind": "content_source_video", "ls.status": "active", "i.status": "active", "plugin.status": "enabled" })
      .whereNull("m.deleted_at").orderBy("p.sort_order", "asc").orderBy("p.id", "asc");
    return rows.map<ContentPlaybackSource>((row) => ({ id: String(row.id), itemId: String(row.item_id), instanceId: String(row.instance_id), name: String(row.name), lineName: String(row.line_name), episodeKey: String(row.episode_key), container: row.container === "hls" ? "hls" : row.container === "mp4" ? "mp4" : "unknown", runTimeTicks: Math.max(0, Number(row.runtime_ticks) || 0), sourceName: String(row.source_name) }));
  }

  /** 从既有父条目元数据恢复源分类，刷新和播放共用，不新增数据库字段。 */
  private async restorePythonItemCategory(adapter: PythonVideoSourceAdapter, libraryId: string, userId: string, instanceId: string, remoteItemId: string): Promise<void> {
    // 关键变量：稳定父身份同时覆盖电影与剧集，不依赖进程中的分类缓存。
    const identityKey = `content:${instanceId}:${contentKey(remoteItemId)}`;
    const item = await this.database.query("media_items").select("metadata_json")
      .where({ library_id: libraryId, user_id: userId, identity_key: identityKey }).whereNull("deleted_at").first();
    const source = item ? parseJsonObject(item.metadata_json).contentSource : undefined;
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    const metadata = source as Record<string, unknown>;
    if (metadata.instanceId === instanceId && metadata.remoteItemId === remoteItemId && typeof metadata.categoryId === "string") {
      adapter.useItemCategory(remoteItemId, metadata.categoryId);
    }
  }

  /** 每次播放即时读详情，只接受匹配线路及单集；地址变化不会改变 MediaSourceId。 */
  public async resolvePlayback(sourceId: string, userId: string, libraryId: string, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; container: ContentVideoContainer; sourceId: string }> {
    signal?.throwIfAborted();
    const locator = await this.database.query("content_playback_sources").where({ id: sourceId, user_id: userId, library_id: libraryId, status: "active" }).first();
    if (!locator || !(await this.listPlaybackSources(String(locator.item_id), userId)).some((source) => source.id === sourceId)) throw new ApiError(404, "content_playback_source_missing", "此在线播放来源已不可用");
    const runtime = await this.adapter(String(locator.instance_id), userId);
    if (runtime.adapter instanceof PythonVideoSourceAdapter) {
      const binding = await this.getLibrary(libraryId, userId);
      runtime.adapter.useCategoryCatalog(mergeCategoryCatalog(binding.configuration, []));
      await this.restorePythonItemCategory(runtime.adapter, libraryId, userId, String(locator.instance_id), String(locator.remote_item_id));
    }
    const detail = await runtime.adapter.detail(String(locator.remote_item_id), signal);
    signal?.throwIfAborted();
    const episodes = detail.episodes.filter((episode) => episode.lineName === String(locator.line_name) && episode.episodeKey === String(locator.episode_key));
    if (episodes.length !== 1) throw new ApiError(404, "content_playback_episode_missing", "原播放线路或单集已经不可用，请刷新已入库内容");
    const episode = episodes[0]!;
    const access = await runtime.adapter.resolveEpisode(episode, signal);
    if (runtime.manifest.adapter === "cms_json" && access.container !== locator.container) throw new ApiError(409, "content_playback_container_changed", "源站媒体格式发生变化，请先刷新已入库内容后重新播放");
    await validateProviderUrl(access.url, { allowInsecureHttp: this.config.allowInsecureProviderHttp });
    // 网络取址期间可能发生停用，返回前再次检查，禁止把失效源交给协议中转。
    if (!(await this.listPlaybackSources(String(locator.item_id), userId)).some((source) => source.id === sourceId)) throw new ApiError(409, "content_playback_disabled", "内容源已停用");
    signal?.throwIfAborted();
    return { ...access, sourceId };
  }

  /** 持久化中转实际读取的完整 HLS 时长，源站文本时长不作为准确值。 */
  public async updatePlaybackDuration(sourceId: string, userId: string, ticks: number): Promise<void> {
    if (!Number.isSafeInteger(ticks) || ticks <= 0) return;
    const source = await this.database.query("content_playback_sources").where({ id: sourceId, user_id: userId }).first();
    if (!source || Number(source.runtime_ticks) === ticks) return;
    const changed = await this.database.query("content_playback_sources").where({ id: sourceId, user_id: userId }).whereNot({ runtime_ticks: ticks }).update({ runtime_ticks: ticks });
    if (!changed) return;
    const now = new Date().toISOString();
    await this.database.query("media_items").where({ id: source.item_id, user_id: userId, library_id: source.library_id }).update({ updated_at: now });
    await this.repository.publishContentSourceCatalogChanges(userId, String(source.library_id), [String(source.item_id)]);
  }
}
