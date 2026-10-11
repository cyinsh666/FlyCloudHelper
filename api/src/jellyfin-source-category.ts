/** 读取在线条目的源站分类身份；历史缺失或无效身份只属于未分类入口。 */
export function readJellyfinSourceCategoryId(metadata: Record<string, unknown>): string | null {
  const source = metadata.contentSource;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const categoryId = (source as Record<string, unknown>).categoryId;
  return typeof categoryId === "string" && categoryId.trim() ? categoryId.trim() : null;
}

/** 按源站分类 ID 精确匹配；undefined 表示全库，null 只包含尚未补齐分类的历史条目。 */
export function matchesJellyfinSourceCategory(metadata: Record<string, unknown>, categoryId: string | null | undefined): boolean {
  return categoryId === undefined || readJellyfinSourceCategoryId(metadata) === categoryId;
}

/** 只读取真正的风格数组，避免新增源分类名称影响 Jellyfin Genres 筛选。 */
export function readJellyfinSourceGenres(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.genres)
    ? [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))]
    : [];
}
