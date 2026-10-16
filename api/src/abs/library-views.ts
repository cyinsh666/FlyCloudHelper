import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { AUDIOBOOK_SEARCH_CATEGORY } from "../content-sources/audiobook-types.js";
import { audiobookSourceCategories } from "../content-sources/audiobook-catalog.js";
import { absEntityId, absNames } from "./catalog-metadata.js";
import { readAbsObject, type AbsContext, type AbsLibraryView } from "./types.js";

/** 读取已保存的分类配置；不请求源站，不创建实际媒体库或重复插件实例。 */
export async function loadAbsLibraryViews(
  runtime: ApiRuntime,
  context: AbsContext,
): Promise<AbsLibraryView[]> {
  const library = await runtime.repository.getLibrary(context.libraryId, context.ownerUserId);
  if (String(library.libraryKind) !== "content_source_audiobook")
    return [rootLibraryView(context)];
  const { configuration } = await runtime.contentAudiobooks.getLibrary(context.libraryId, context.ownerUserId);
  // 关键变量：库身份只取分类稳定 ID，重命名和配置顺序改变均不会产生新库。
  const categoryIds = [...new Set(configuration.categoryIds)];
  const categories = [...configuration.categories, ...configuration.categoryCatalog];
  const views = categoryIds.filter((id) => id !== AUDIOBOOK_SEARCH_CATEGORY).map((categoryId, index) => ({
    id: absEntityId(context.libraryId, "library-category", categoryId),
    name: categories.find((category) => category.id === categoryId)?.name || categoryId,
    categoryId,
    displayOrder: index + 1,
  }));
  // 原站搜索没有可信分类时保留独立入口，不把搜索书籍冒充当前分类内容。
  views.push({
    id: absEntityId(context.libraryId, "library-category", AUDIOBOOK_SEARCH_CATEGORY),
    name: "搜索结果",
    categoryId: AUDIOBOOK_SEARCH_CATEGORY,
    displayOrder: views.length + 1,
  });
  return views;
}

/** 一个请求只装配一次分类视图，后续映射、过滤和用户对象复用同一份配置。 */
export async function withAbsLibraryViews(runtime: ApiRuntime, context: AbsContext): Promise<AbsContext> {
  if (context.libraryViews) return context;
  return { ...context, libraryViews: await loadAbsLibraryViews(runtime, context) };
}

/** 验证并选择分类库；真实库 ID 保留为历史聚合入口，不加入分类枚举。 */
export function absLibraryContext(context: AbsContext, id: string): AbsContext {
  if (id !== context.libraryId && !context.libraryViews?.some((view) => view.id === id))
    throw new ApiError(403, "abs_library_forbidden", "当前账号不能访问此媒体库");
  return { ...context, viewLibraryId: id };
}

/** 默认库取当前选择的第一个分类；旧网盘听书库仍返回原库 ID。 */
export function absDefaultLibraryId(context: AbsContext): string {
  return context.libraryViews?.[0]?.id ?? context.libraryId;
}

/** 映射选中库的描述；显式使用旧真实库 ID 时返回原聚合库描述。 */
export function absLibraryView(context: AbsContext): AbsLibraryView {
  if (context.viewLibraryId === context.libraryId) return rootLibraryView(context);
  return context.libraryViews?.find((view) => view.id === context.viewLibraryId)
    ?? context.libraryViews?.[0]
    ?? rootLibraryView(context);
}

/** 作品固定归属一个主分类，所有条目入口和播放响应均给出相同的库 ID。 */
export function absBookLibraryId(context: AbsContext, item: Pick<MediaItemRecord, "metadata">): string {
  const views = context.libraryViews;
  if (!views?.length || views.every((view) => view.categoryId === null)) return context.libraryId;
  const source = readAbsObject(item.metadata.contentSource);
  const categoryId = audiobookSourceCategories(source)[0]?.id ?? AUDIOBOOK_SEARCH_CATEGORY;
  return views.find((view) => view.categoryId === categoryId)?.id
    ?? views.find((view) => view.categoryId === AUDIOBOOK_SEARCH_CATEGORY)?.id
    ?? context.libraryId;
}

/** 分类目录只包含主分类匹配的书；账号全局接口和历史聚合入口保留全部范围。 */
export function absBookMatchesLibrary(context: AbsContext, item: Pick<MediaItemRecord, "metadata">): boolean {
  return !context.viewLibraryId || context.viewLibraryId === context.libraryId
    || absBookLibraryId(context, item) === context.viewLibraryId;
}

/** 分类也映射到标准题材字段；旧摘要直接按已存分类读取，无需批量改写目录。 */
export function absBookGenres(context: AbsContext, item: Pick<MediaItemRecord, "metadata">): string[] {
  const categories = audiobookSourceCategories(readAbsObject(item.metadata.contentSource));
  const names = categories.map((category) => category.name
    || context.libraryViews?.find((view) => view.categoryId === category.id)?.name || "");
  return [...new Set([...absNames(item.metadata.genres), ...names].filter(Boolean))];
}

/** 构造原库兼容描述，不改变旧网盘库和历史 ABS 库的名称与身份。 */
function rootLibraryView(context: AbsContext): AbsLibraryView {
  return { id: context.libraryId, name: context.libraryName, categoryId: null, displayOrder: 1 };
}
