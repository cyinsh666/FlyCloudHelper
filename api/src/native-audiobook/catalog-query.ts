import type { Knex } from "knex";
import type { MediaItemRecord } from "../domain.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { nativeHash } from "./store.js";

/** 目录游标只保存有界锚点，绑定当前入口账号和查询条件。 */
export interface CatalogCursor {
  scope: string;
  revision: string;
  id?: string;
  value?: string | number;
  direction?: "next" | "previous";
  page?: number;
}

/** 严格读取分页大小，零不能被解释为下载所有条目。 */
export function catalogLimit(query: Record<string, unknown>, fallback = 30): number {
  if (query.limit === undefined) return fallback;
  const value = typeof query.limit === "string" && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : query.limit;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100)
    throw new ApiError(400, "invalid_limit", "分页数量必须为 1 至 100 的整数");
  return value;
}

/** 查询文本设置长度边界，拒绝数组、对象和非文本值。 */
export function catalogText(value: unknown, name: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ApiError(400, "invalid_query", `${name}必须是有效文本`);
  return value.trim();
}

/** 截断显示文字时保留 Unicode 字符边界，并按实际 JSON 转义后的字节数约束。 */
export function boundedText(value: unknown, maxCharacters = 128, maxBytes = 512): string {
  const characters = Array.from(typeof value === "string" ? value : "").slice(0, maxCharacters);
  while (characters.length && Buffer.byteLength(JSON.stringify(characters.join("")), "utf8") > maxBytes) characters.pop();
  return characters.join("");
}

/** 作者和演播者只投影有界名称，不携带来源原始对象。 */
export function catalogNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(values.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as Record<string, unknown>).name : null;
    return typeof name === "string" && name.trim() ? [boundedText(name.trim())] : [];
  }))].slice(0, 30);
}

/** 直接映射已授权的单行，禁止详情读取附加文件数和媒体探测统计。 */
export function nativeCatalogItem(row: Record<string, unknown>): MediaItemRecord {
  return {
    id: String(row.id), userId: String(row.user_id), serviceId: String(row.service_id ?? ""),
    libraryId: String(row.library_id), libraryKind: String(row.library_kind ?? "legacy_single_source") as MediaItemRecord["libraryKind"],
    mediaType: "audiobook", itemType: String(row.item_type), regionGroup: "other",
    title: String(row.title ?? ""), sortTitle: String(row.sort_title ?? row.title ?? ""), subtitle: String(row.subtitle ?? ""),
    year: row.year === null || row.year === undefined ? null : Number(row.year), premiereDate: row.premiere_date ? String(row.premiere_date) : null,
    overview: String(row.overview ?? ""), posterUrl: row.poster_url ? String(row.poster_url) : null,
    backdropUrl: null, matchState: row.match_state as MediaItemRecord["matchState"],
    externalIds: {}, metadata: parseJsonObject(row.metadata_json), fileCount: 0, mediaProbeSummary: null,
    ownerUsername: "", serviceName: String(row.service_name ?? ""), sourceNames: [],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

/** 读取已知数据库 JSON 路径；路径由服务端常量提供，不接收客户端 SQL。 */
export function catalogJson(runtime: ApiRuntime, column: string, path: string): Knex.Raw {
  const query = runtime.database.query;
  if (runtime.database.databaseType === "postgres")
    return query.raw("(NULLIF(??, '')::jsonb #>> ?::text[])", [column, `{${path.split(".").join(",")}}`]);
  if (runtime.database.databaseType === "mysql")
    return query.raw("(CASE WHEN JSON_VALID(??) THEN JSON_UNQUOTE(JSON_EXTRACT(??, ?)) ELSE NULL END)", [column, column, `$.${path}`]);
  return query.raw("(CASE WHEN json_valid(??) THEN json_extract(??, ?) ELSE NULL END)", [column, column, `$.${path}`]);
}

/** 精确匹配 JSON 数组成员，不使用可能命中简介和其他字段的模糊全文条件。 */
export function whereCatalogArray(runtime: ApiRuntime, builder: Knex.QueryBuilder, path: string, value: string, member?: "id" | "name"): void {
  const column = "m.metadata_json";
  if (runtime.database.databaseType === "postgres") {
    const expression = "NULLIF(??, '')::jsonb #> ?::text[]";
    builder.whereRaw(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END) AS native_member(value) WHERE ${member ? "native_member.value ->> ?" : "native_member.value #>> '{}'"} = ?)`,
      [column, `{${path.split(".").join(",")}}`, column, `{${path.split(".").join(",")}}`, ...(member ? [member] : []), value]);
  } else if (runtime.database.databaseType === "mysql") {
    const candidate = JSON.stringify(member ? { [member]: value } : value);
    builder.whereRaw("JSON_CONTAINS(CASE WHEN JSON_VALID(??) THEN JSON_EXTRACT(??, ?) ELSE JSON_ARRAY() END, CAST(? AS JSON)) = 1", [column, column, `$.${path}`, candidate]);
  } else {
    builder.whereRaw(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(??) THEN ?? ELSE '{}' END, ?) AS native_member WHERE ${member ? "json_extract(CASE WHEN native_member.type = 'object' THEN native_member.value ELSE '{}' END, ?)" : "native_member.value"} = ?)`,
      [column, column, `$.${path}`, ...(member ? [`$.${member}`] : []), value]);
  }
}

/** 用完整作用域验证不透明游标，客户端不能把另一库的锚点拿来续页。 */
export function readCatalogCursor(value: unknown, scope: unknown[], revision?: string): CatalogCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 4096) throw new ApiError(400, "invalid_cursor", "目录游标无效");
  let cursor: CatalogCursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CatalogCursor; }
  catch { throw new ApiError(400, "invalid_cursor", "目录游标无效"); }
  if (!cursor || cursor.scope !== nativeHash(JSON.stringify(scope)) || typeof cursor.revision !== "string"
    || (cursor.id !== undefined && (typeof cursor.id !== "string" || cursor.id.length > 128))
    || (cursor.direction !== undefined && !["next", "previous"].includes(cursor.direction))
    || (cursor.value !== undefined && typeof cursor.value !== "string" && typeof cursor.value !== "number"))
    throw new ApiError(400, "invalid_cursor", "目录游标不属于当前查询");
  if (revision !== undefined && cursor.revision !== revision) throw new ApiError(409, "catalog_changed", "目录已更新，请重新定位");
  return cursor;
}

/** 游标仅包含查询作用域及当前页末条锚点，不携带令牌或音频地址。 */
export function makeCatalogCursor(scope: unknown[], revision: string, anchor: Omit<CatalogCursor, "scope" | "revision">): string {
  return Buffer.from(JSON.stringify({ scope: nativeHash(JSON.stringify(scope)), revision, ...anchor })).toString("base64url");
}

/** 返回统一有界分页对象，总数未知时明确为空。 */
export function catalogPage(items: unknown[], revision: string, next: string | null, previous: string | null = null, total: number | null = null): Record<string, unknown> {
  return { Items: items, NextCursor: next, PreviousCursor: previous, HasMore: next !== null, TotalCount: total, CatalogRevision: revision };
}
