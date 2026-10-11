import { parseJsonObject } from "../domain.js";
import type { ApiRuntime } from "../runtime.js";

/** 协议查源始终限制在当前账号所属用户和媒体库中。 */
interface ProtocolItemScope {
  ownerUserId: string;
  libraryId: string;
  /** 来自 Jellyfin、Emby 已认证上下文，在线源条目不绑定 cloud_services。 */
  libraryKind?: string;
}

/** 一个外部媒体编号条件；多个条件之间按任一命中处理。 */
interface ProviderIdCondition {
  provider: string;
  value: string;
}

/** Ids 与外部编号条件取交集；undefined 表示没有提交该筛选。 */
export interface ProtocolItemIdentityFilter {
  itemIds?: string[];
  providerIds?: ProviderIdCondition[];
}

/** 读取 PascalCase/camelCase 参数，多个值使用协议规定的逗号分隔。 */
function readQueryList(query: Record<string, unknown>, key: string): string[] | undefined {
  const value = query[key] ?? query[`${key.charAt(0).toLowerCase()}${key.slice(1)}`];
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** 解析 Ids 和 provider.id 条件，外部编号中的后续小数点保持原样。 */
export function readProtocolItemIdentityFilter(query: Record<string, unknown>,
  decodeItemId: (value: string) => string): ProtocolItemIdentityFilter {
  const itemIds = readQueryList(query, "Ids");
  const providerValues = readQueryList(query, "AnyProviderIdEquals");
  const providerIds = providerValues?.flatMap((entry): ProviderIdCondition[] => {
    const separator = entry.indexOf(".");
    if (separator <= 0 || separator === entry.length - 1) return [];
    return [{ provider: entry.slice(0, separator).trim().toLowerCase(), value: entry.slice(separator + 1).trim() }];
  });
  return { itemIds: itemIds?.map(decodeItemId), providerIds };
}

/** 外部编号按 provider 名称不区分大小写、编号值精确匹配，不使用片名推测。 */
export function matchesProtocolItemIdentity(filter: ProtocolItemIdentityFilter, itemId: string,
  providerIds: Record<string, unknown>): boolean {
  if (filter.itemIds !== undefined && !filter.itemIds.includes(itemId)) return false;
  if (filter.providerIds === undefined) return true;
  return filter.providerIds.some((condition) => Object.entries(providerIds).some(([key, value]) =>
    key.toLowerCase() === condition.provider && String(value ?? "") === condition.value));
}

/** 在协议分页前读取当前媒体库的身份字段，避免先截取前 20/500 项后才匹配 TMDB。 */
export async function resolveProtocolItemIdentityIds(runtime: ApiRuntime, scope: ProtocolItemScope,
  filter: ProtocolItemIdentityFilter): Promise<string[] | undefined> {
  if (filter.providerIds === undefined) return filter.itemIds;
  if (filter.providerIds.length === 0 || filter.itemIds?.length === 0) return [];
  const query = runtime.database.query("media_items as item")
    .where({ "item.user_id": scope.ownerUserId, "item.library_id": scope.libraryId })
    .whereNull("item.deleted_at").select("item.id", "item.external_ids_json");
  // 关键变量：只为已认证在线库解除网盘依赖，普通库仍执行原内连接与服务删除过滤。
  if (scope.libraryKind === "content_source_video") query.whereNull("item.service_id");
  else query.join("cloud_services as service", "service.id", "item.service_id").whereNull("service.deleted_at");
  // 这里只读取轻量身份字段，具体媒体详情和文件信息仍由各协议按匹配结果查询。
  let rows: Array<Record<string, unknown>> = [];
  if (filter.itemIds === undefined) {
    rows = await query;
  } else {
    for (let offset = 0; offset < filter.itemIds.length; offset += 300) {
      rows.push(...await query.clone().whereIn("item.id", filter.itemIds.slice(offset, offset + 300)));
    }
  }
  const itemIds = rows.filter((row) => matchesProtocolItemIdentity(filter, String(row.id),
    parseJsonObject(row.external_ids_json))).map((row) => String(row.id));
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-tmdb-source-cloud-drive", 阶段: "协议外部编号筛选", 媒体库ID: scope.libraryId,
    指定条目数量: filter.itemIds?.length ?? 0, 外部编号条件数: filter.providerIds.length, 匹配数量: itemIds.length,
  });
  return itemIds;
}
