import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import { categoryMatches } from "./catalog.js";
import type { ContentSourceCategory, ContentSourceCategoryDefinition, ContentSourceManifest } from "./types.js";

/** 合并源分类名称快照，取消选择或源站移除分类时仍保留原名称和父分类关系。 */
export function mergeCategoryCatalog(configuration: { categories?: ContentSourceCategory[]; categoryCatalog?: ContentSourceCategory[] }, incoming: ContentSourceCategory[]): ContentSourceCategory[] {
  const categoriesById = new Map<string, ContentSourceCategory>();
  for (const category of [...(configuration.categories ?? []), ...(configuration.categoryCatalog ?? []), ...incoming]) {
    categoriesById.set(category.id, category);
  }
  return [...categoriesById.values()];
}

/** 读取源分类定义并缓存，图片和鉴权请求不重复扫描媒体元数据。 */
export class SourceCategoryLibraryReader {
  private readonly cache = new Map<string, { signature: string; promise: Promise<ContentSourceCategoryDefinition[]> }>();

  /** 仅使用当前数据库，不向源站发起分类请求。 */
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 目录版本或分类配置变化后失效，入口只展示当前选中分类与真实未分类内容。 */
  public async read(libraryId: string, userId: string): Promise<ContentSourceCategoryDefinition[]> {
    const binding = await this.database.query("content_source_libraries as b")
      .join("media_libraries as l", "l.id", "b.library_id")
      .join("content_source_instances as i", "i.id", "b.instance_id")
      .join("content_source_plugins as p", function joinPinnedCategoryPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
      .select("b.configuration_json", "l.catalog_version", "p.manifest_json")
      .where({ "b.library_id": libraryId, "b.user_id": userId, "l.user_id": userId }).first();
    if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
    const configuration = parseJsonObject(binding.configuration_json);
    // 关键变量：历史同步游标不再生成动态分类入口，取消选择后不继续向该分类查源。
    const signature = JSON.stringify([binding.catalog_version, binding.configuration_json, binding.manifest_json]);
    const cacheKey = `${userId}:${libraryId}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.signature === signature) return cached.promise;
    const promise = this.buildDefinitions(libraryId, userId, configuration, parseJsonObject(binding.manifest_json) as unknown as ContentSourceManifest);
    const entry = { signature, promise };
    this.cache.set(cacheKey, entry);
    try {
      return await promise;
    } catch (error) {
      if (this.cache.get(cacheKey) === entry) this.cache.delete(cacheKey);
      throw error;
    }
  }

  /** 使用既有三个数据库的 JSON 取值语法，只选择分类字段，不传输完整媒体元数据。 */
  private categoryField(key: "categoryId" | "categoryName" | "parentCategoryId", alias: string) {
    if (this.database.databaseType === "postgres") return this.database.query.raw("(??::jsonb -> ? ->> ?) as ??", ["metadata_json", "contentSource", key, alias]);
    if (this.database.databaseType === "mysql") return this.database.query.raw("JSON_UNQUOTE(JSON_EXTRACT(??, ?)) as ??", ["metadata_json", `$.contentSource.${key}`, alias]);
    return this.database.query.raw("json_extract(??, ?) as ??", ["metadata_json", `$.contentSource.${key}`, alias]);
  }

  /** 分类入口来自当前选择，实际元数据只补名称、媒体类型与未分类兜底。 */
  private async buildDefinitions(libraryId: string, userId: string, configuration: Record<string, unknown>, manifest: ContentSourceManifest): Promise<ContentSourceCategoryDefinition[]> {
    const rows = await this.database.query("media_items")
      .distinct(this.categoryField("categoryId", "category_id"), this.categoryField("categoryName", "category_name"), this.categoryField("parentCategoryId", "parent_category_id"), "item_type")
      .where({ library_id: libraryId, user_id: userId }).whereNull("deleted_at")
      .whereIn("item_type", ["video.movie", "video.series"]);
    const catalog = mergeCategoryCatalog({ categories: configuration.categories as ContentSourceCategory[] | undefined, categoryCatalog: configuration.categoryCatalog as ContentSourceCategory[] | undefined }, []);
    const categoryIds = new Set(configuration.categoryIds as string[] ?? []);
    const actualCategories = new Map<string, ContentSourceCategory>();
    // 关键变量：入口类型依据该分类的实际顶层媒体类型，混合分类不能声明为单一电影或节目库。
    const itemTypesByCategory = new Map<string, Set<string>>();
    let hasUncategorizedItems = false;
    for (const row of rows) {
      const id = String(row.category_id ?? "").trim();
      if (!id || id === "null") {
        hasUncategorizedItems = true;
        continue;
      }
      const itemTypes = itemTypesByCategory.get(id) ?? new Set<string>();
      itemTypes.add(String(row.item_type));
      itemTypesByCategory.set(id, itemTypes);
      const parentId = row.parent_category_id === null || row.parent_category_id === undefined || row.parent_category_id === "null" ? null : String(row.parent_category_id);
      actualCategories.set(id, { id, name: String(row.category_name ?? "").trim() || `分类 ${id}`, parentId });
    }
    const completeCatalog = mergeCategoryCatalog({ categoryCatalog: [...actualCategories.values()] }, catalog);
    const definitions: ContentSourceCategoryDefinition[] = [];
    for (const id of categoryIds) {
      const category = completeCatalog.find((item) => item.id === id);
      const definition: ContentSourceCategoryDefinition = { categoryId: id, name: category?.name ?? `分类 ${id}`, parentId: category?.parentId ?? null };
      const itemTypes = itemTypesByCategory.get(id);
      if (itemTypes?.size === 1) {
        definition.collectionType = itemTypes.has("video.movie") ? "movies" : "tvshows";
      } else if (!itemTypes?.size) {
        // 空分类只接受已有清单明确的电影分类，其他空分类省略 CollectionType。
        if (categoryMatches(id, manifest.movieCategoryIds ?? [], completeCatalog)) definition.collectionType = "movies";
      }
      definitions.push(definition);
    }
    if (hasUncategorizedItems) definitions.push({ categoryId: null, name: "未分类", parentId: null });
    return definitions;
  }
}
