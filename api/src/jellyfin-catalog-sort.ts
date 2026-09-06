import { createHash, randomBytes } from "node:crypto";
import type { Knex } from "knex";
import type { VideoRegionGroup } from "./domain.js";
import type { ApiRuntime } from "./runtime.js";

/** 排序只读取 Jellyfin 自己的账号状态，不修改共享目录或 Emby。 */
export interface JellyfinSortContext {
  serviceId: string;
  ownerUserId: string;
  accountId: string;
  aggregateService: boolean;
  accessToken: string;
}

type SortValue = string | number | null;
export interface JellyfinSortEntry {
  id: string;
  itemType: string;
  values: Record<string, SortValue>;
}

export interface JellyfinSortPlan {
  fields: Array<{ name: string; descending: boolean }>;
  randomSeed: string;
}

/** 所有筛选先于排序和分页，避免混合类型、收藏和演员作品被截断到 500 条。 */
export interface JellyfinSortFilters {
  itemTypes?: string[];
  itemIds?: string[];
  search?: string;
  genres?: string[];
  regionGroup?: VideoRegionGroup;
  parentId?: string;
  seasonNumber?: number;
  favorite?: boolean;
  played?: boolean;
  topLevel?: boolean;
}

const SORT_FIELDS = new Set([
  "sortname", "name", "datelastcontentadded", "datecreated", "datemodified",
  "communityrating", "random", "seriesdateplayed", "dateplayed", "productionyear",
  "premieredate", "officialrating", "criticrating", "lastcontentpremieredate",
  "parentindexnumber", "indexnumber", "playcount",
]);
const TITLE_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** 接受 PascalCase 和 camelCase 的 Jellyfin 查询参数。 */
export function readJellyfinSortQuery(query: Record<string, unknown>, key: string): unknown {
  return query[key] ?? query[`${key.charAt(0).toLowerCase()}${key.slice(1)}`];
}

/** 缺失值保持为空，不能把未刮削的评分当作真实的零分。 */
function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 日期统一按时间点比较，避免时区格式不同导致字符串排序错位。 */
function readDate(value: unknown): number | null {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** 分级优先使用已有年龄值；常见美国影视分级按年龄级别而非字母顺序排列。 */
function readRatingLevel(value: unknown, inheritedLevel: unknown): number | null {
  const inherited = readNumber(inheritedLevel);
  if (inherited !== null) return inherited;
  const levels: Record<string, number> = {
    "TV-Y": 0, "G": 0, "TV-G": 0, "APPROVED": 0, "TV-Y7": 7, "TV-Y7-FV": 7,
    "PG": 10, "TV-PG": 10, "PG-13": 13, "TV-14": 14, "R": 17, "TV-MA": 17, "NC-17": 17,
    "TV-X": 18, "TV-AO": 18,
  };
  const rating = String(value ?? "").trim().toUpperCase();
  return levels[rating] ?? (/^\d{1,2}\+?$/u.test(rating) ? Number.parseInt(rating, 10) : null);
}

/** Jellyfin 专属轻量排序：只读排序列，选定页码后才装配元数据、文件和播放规格。 */
export class JellyfinCatalogSort {
  /** 随机顺序在一次分页浏览中保持不变，重新请求首页才换序；限制缓存数量。 */
  private readonly randomSeeds = new Map<string, string>();

  /** 注入现有运行环境，不创建新的数据库连接或后台任务。 */
  public constructor(private readonly runtime: ApiRuntime) {}

  /** 保留全部排序字段及各自方向，未知字段不会悄悄改成创建日期倒序。 */
  public readPlan(context: JellyfinSortContext, query: Record<string, unknown>): JellyfinSortPlan {
    const names = String(readJellyfinSortQuery(query, "SortBy") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const directions = String(readJellyfinSortQuery(query, "SortOrder") ?? "Ascending").split(",").map((value) => value.trim().toLowerCase());
    const fields = names.map((name, index) => ({ name, descending: (directions[index] ?? directions[0]) === "descending" }))
      .filter((field) => SORT_FIELDS.has(field.name));
    if (fields.length === 0) fields.push({ name: names.length === 0 ? "datecreated" : "sortname", descending: names.length === 0 });
    let randomSeed = "";
    if (fields.some((field) => field.name === "random")) {
      const scope = [context.serviceId, context.accountId, context.accessToken,
        ...["ParentId", "IncludeItemTypes", "SearchTerm", "Filters", "IsFavorite", "IsPlayed", "PersonIds", "GenreIds", "SortBy", "SortOrder"]
          .map((key) => String(readJellyfinSortQuery(query, key) ?? ""))];
      // 关键变量：缓存键只保留摘要，绝不记录令牌或原始认证数据。
      const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
      randomSeed = this.randomSeeds.get(key) ?? "";
      if (!randomSeed || Number(readJellyfinSortQuery(query, "StartIndex") ?? 0) === 0) {
        randomSeed = randomBytes(16).toString("hex");
        this.randomSeeds.delete(key);
        this.randomSeeds.set(key, randomSeed);
        if (this.randomSeeds.size > 256) this.randomSeeds.delete(this.randomSeeds.keys().next().value!);
      }
    }
    return { fields, randomSeed };
  }

  /** 提取标量元数据，兼容项目支持的三种数据库，不读取整份演职员或图片 JSON。 */
  private metadataColumn(key: string, alias: string): Knex.Raw {
    const databaseType = this.runtime.database.databaseType;
    if (databaseType === "postgres") return this.runtime.database.query.raw("(??::jsonb ->> ?) as ??", ["m.metadata_json", key, alias]);
    if (databaseType === "mysql") return this.runtime.database.query.raw("JSON_UNQUOTE(JSON_EXTRACT(??, ?)) as ??", ["m.metadata_json", `$.${key}`, alias]);
    return this.runtime.database.query.raw("json_extract(??, ?) as ??", ["m.metadata_json", `$.${key}`, alias]);
  }

  /** 有效主来源优先，否则按成员优先级选可用来源；与聚合详情的来源回退保持一致。 */
  private effectiveAggregateSource(context: JellyfinSortContext, aggregateAlias: string): Knex.Raw {
    const primary = this.runtime.database.query("media_items as primary_source")
      .join("cloud_services as primary_service", "primary_service.id", "primary_source.service_id")
      .whereRaw("?? = ??", ["primary_source.id", `${aggregateAlias}.primary_member_item_id`]).where("primary_source.user_id", context.ownerUserId)
      .whereNull("primary_source.deleted_at").whereNull("primary_service.deleted_at").select("primary_source.id").limit(1);
    const fallback = this.runtime.database.query("aggregate_media_item_members as candidate")
      .join("media_items as source", "source.id", "candidate.media_item_id")
      .join("cloud_services as source_service", "source_service.id", "source.service_id")
      .whereRaw("?? = ??", ["candidate.aggregate_item_id", `${aggregateAlias}.id`]).where("source.user_id", context.ownerUserId)
      .whereNull("source.deleted_at").whereNull("source_service.deleted_at")
      .select("source.id").orderBy("candidate.metadata_rank", "asc").orderBy("candidate.id", "asc").limit(1);
    // SQLite 不允许相关子查询在 ORDER BY 引用外层列，主来源与备用来源分开查询。
    return this.runtime.database.query.raw("COALESCE((?), (?))", [primary, fallback]);
  }

  /** 单集地区继承所属节目，不能使用单集默认的 other 地区值过滤收藏/已观看列表。 */
  private applyRegion(query: Knex.QueryBuilder, context: JellyfinSortContext, region: VideoRegionGroup): void {
    const parent = context.aggregateService
      ? this.runtime.database.query("aggregate_media_items as parent")
        .join("media_items as parent_source", "parent_source.id", this.effectiveAggregateSource(context, "parent"))
        .whereRaw("?? = ??", ["parent.id", "a.parent_aggregate_item_id"]).where("parent.status", "active").whereNull("parent.deleted_at")
      : this.runtime.database.query("media_relations as relation")
        .join("media_items as parent_source", "parent_source.id", "relation.parent_item_id")
        .whereRaw("?? = ??", ["relation.child_item_id", "m.id"]).where("parent_source.service_id", context.serviceId);
    parent.select("parent_source.id").where("parent_source.user_id", context.ownerUserId)
      .whereNull("parent_source.deleted_at").where("parent_source.region_group", region);
    query.where((builder) => builder
      .where((own) => own.whereNot("m.item_type", "video.episode").where("m.region_group", region))
      .orWhere((episode) => episode.where("m.item_type", "video.episode").whereExists(parent)));
  }

  /** 一次查询候选排序键；字段、类型和用户范围不经过共享的 CatalogSort。 */
  public async load(context: JellyfinSortContext, filters: JellyfinSortFilters, plan: JellyfinSortPlan): Promise<JellyfinSortEntry[]> {
    if (filters.itemIds?.length === 0) return [];
    const aggregate = context.aggregateService;
    const idColumn = aggregate ? "a.id" : "m.id";
    const typeColumn = aggregate ? "a.item_type" : "m.item_type";
    // 主来源暂时被删除时继续使用有效备用成员，不能让仍有可播放版本的聚合影片消失。
    const query = aggregate
      ? this.runtime.database.query("aggregate_media_items as a").join("media_items as m", "m.id", this.effectiveAggregateSource(context, "a"))
        .where({ "a.aggregate_service_id": context.serviceId, "a.status": "active" }).whereNull("a.deleted_at")
      : this.runtime.database.query("media_items as m").where("m.service_id", context.serviceId);
    query.join("cloud_services as s", "s.id", "m.service_id")
      .where("m.user_id", context.ownerUserId).whereNull("m.deleted_at").whereNull("s.deleted_at")
      .select({ id: idColumn, item_type: typeColumn, sort_title: aggregate ? "a.sort_title" : "m.sort_title",
        title: "m.title", year: aggregate ? "a.year" : "m.year", premiere_date: aggregate ? "a.premiere_date" : "m.premiere_date",
        created_at: "m.created_at", updated_at: "m.updated_at" });
    if (filters.itemTypes?.length) query.whereIn(typeColumn, filters.itemTypes);
    else if (filters.topLevel) query.whereIn(typeColumn, ["video.movie", "video.series"]);
    if (aggregate && filters.topLevel) query.whereNull("a.parent_aggregate_item_id");
    if (filters.regionGroup) this.applyRegion(query, context, filters.regionGroup);
    if (filters.search?.trim()) query.where((builder) => builder.whereLike("m.title", `%${filters.search!.trim()}%`).orWhereLike("m.subtitle", `%${filters.search!.trim()}%`));
    if (filters.genres?.length) query.where((builder) => filters.genres!.forEach((genre) => builder.orWhereLike("m.metadata_json", `%${genre}%`)));
    if (filters.parentId) {
      if (aggregate) query.where("a.parent_aggregate_item_id", filters.parentId);
      else query.whereExists(this.runtime.database.query("media_relations as relation").select("relation.id")
        .whereRaw("?? = ??", ["relation.child_item_id", "m.id"]).where("relation.parent_item_id", filters.parentId).where("relation.user_id", context.ownerUserId));
    }
    const names = new Set(plan.fields.map((field) => field.name));
    const metadataFields: Array<[string, string]> = [];
    if (names.has("communityrating")) metadataFields.push(["rating", "rating"]);
    if (names.has("criticrating")) metadataFields.push(["criticRating", "critic_rating"]);
    if (names.has("officialrating")) metadataFields.push(["officialRating", "official_rating"], ["inheritedParentalRatingValue", "rating_level"]);
    if (names.has("parentindexnumber") || filters.seasonNumber !== undefined) metadataFields.push(["seasonNumber", "season_number"]);
    if (names.has("indexnumber")) metadataFields.push(["episodeNumber", "episode_number"]);
    metadataFields.forEach(([key, alias]) => query.select(this.metadataColumn(key, alias)));
    if (filters.favorite || filters.played) {
      const stateTable = filters.favorite ? (aggregate ? "aggregate_item_preferences" : "service_item_preferences")
        : (aggregate ? "aggregate_playback_progress" : "service_playback_progress");
      const state = this.runtime.database.query(`${stateTable} as state`).select("state.id")
        .whereRaw("?? = ??", [aggregate ? "state.aggregate_item_id" : "state.item_id", idColumn])
        .where(aggregate ? "state.aggregate_service_id" : "state.service_id", context.serviceId).where("state.account_id", context.accountId);
      if (filters.favorite) state.whereNotNull("state.starred_at");
      else state.where("state.played", 1);
      query.whereExists(state);
      if (names.has("stateupdated")) query.select(state.clone().clearSelect().select("state.updated_at").as("state_updated_at"));
      if (names.has("starred") && filters.favorite) query.select(state.clone().clearSelect().select("state.starred_at").as("starred_at"));
    }
    // 关键变量：限定 ID 分批查询，避免演员作品/整剧单集超出 SQLite 参数上限，也避免扫描整个服务。
    let rows: Array<Record<string, unknown>> = [];
    if (filters.itemIds) {
      const ids = [...new Set(filters.itemIds)];
      for (let index = 0; index < ids.length; index += 300) rows.push(...await query.clone().whereIn(idColumn, ids.slice(index, index + 300)));
    } else rows = await query;
    const entries = rows.filter((row) => filters.seasonNumber === undefined || Number(row.season_number ?? 0) === filters.seasonNumber).map((row): JellyfinSortEntry => ({
      id: String(row.id), itemType: String(row.item_type), values: {
        sortname: String(row.sort_title ?? row.title ?? ""), name: String(row.title ?? ""),
        datecreated: readDate(row.created_at), datemodified: readDate(row.updated_at),
        stateupdated: readDate(row.state_updated_at), starred: readDate(row.starred_at),
        productionyear: readNumber(row.year), premieredate: readDate(row.premiere_date),
        // 现有刮削以 0 表示尚无社区评分，与 DTO 省略 CommunityRating 的行为一致。
        communityrating: readNumber(row.rating) || null, criticrating: readNumber(row.critic_rating),
        officialrating: readRatingLevel(row.official_rating, row.rating_level),
        parentindexnumber: readNumber(row.season_number), indexnumber: readNumber(row.episode_number),
      },
    }));
    if (entries.length === 0) return entries;
    if (aggregate && (names.has("datecreated") || names.has("datelastcontentadded"))) await this.loadAggregateCreatedDates(context, entries);
    if (names.has("datelastcontentadded") || names.has("lastcontentpremieredate")) await this.loadChildDates(context, entries);
    if (names.has("dateplayed") || names.has("seriesdateplayed") || names.has("playcount")) await this.loadPlaybackDates(context, entries);
    return this.sort(entries, plan);
  }

  /** 聚合创建时间取有效成员最早入库时间，重建或修改来源优先级不会重置它。 */
  private async loadAggregateCreatedDates(context: JellyfinSortContext, entries: JellyfinSortEntry[]): Promise<void> {
    const rows = await this.runtime.database.query("aggregate_media_item_members as member")
      .join("media_items as source", "source.id", "member.media_item_id").join("cloud_services as source_service", "source_service.id", "source.service_id")
      .where("member.aggregate_service_id", context.serviceId).where("source.user_id", context.ownerUserId)
      .whereNull("source.deleted_at").whereNull("source_service.deleted_at")
      .select("member.aggregate_item_id").min({ created_at: "source.created_at" }).groupBy("member.aggregate_item_id") as Array<{ aggregate_item_id: unknown; created_at: unknown }>;
    const dates = new Map(rows.map((row) => [String(row.aggregate_item_id), readDate(row.created_at)]));
    entries.forEach((entry) => { entry.values.datecreated = dates.get(entry.id) ?? entry.values.datecreated ?? null; });
  }

  /** 只汇总当前有效单集；电影或没有单集的节目回退自身入库/首映时间，不使用更新时间。 */
  private async loadChildDates(context: JellyfinSortContext, entries: JellyfinSortEntry[]): Promise<void> {
    entries.forEach((entry) => {
      entry.values.datelastcontentadded = entry.values.datecreated ?? null;
      entry.values.lastcontentpremieredate = entry.values.premieredate ?? null;
    });
    if (!entries.some((entry) => entry.itemType === "video.series")) return;
    let rows: Array<Record<string, unknown>>;
    if (context.aggregateService) {
      // 先把同一集的多个来源合成一个入库日期，再按整剧取最新，避免新增重复版本冒充新增集。
      const episodes = this.runtime.database.query("aggregate_media_items as episode")
        .join("aggregate_media_item_members as member", "member.aggregate_item_id", "episode.id")
        .join("media_items as source", "source.id", "member.media_item_id")
        .join("cloud_services as source_service", "source_service.id", "source.service_id")
        .where({ "episode.aggregate_service_id": context.serviceId, "episode.status": "active", "episode.item_type": "video.episode" })
        .where("source.user_id", context.ownerUserId).whereNull("episode.deleted_at").whereNull("source.deleted_at").whereNull("source_service.deleted_at")
        .select("episode.parent_aggregate_item_id as parent_id", "episode.premiere_date")
        .min({ created_at: "source.created_at" }).groupBy("episode.id", "episode.parent_aggregate_item_id", "episode.premiere_date");
      rows = await this.runtime.database.query.from(episodes.as("dates")).select("parent_id")
        .max({ created_at: "created_at", premiere_date: "premiere_date" }).groupBy("parent_id");
    } else {
      rows = await this.runtime.database.query("media_relations as relation")
        .join("media_items as episode", "episode.id", "relation.child_item_id")
        .where({ "episode.service_id": context.serviceId, "episode.user_id": context.ownerUserId, "episode.item_type": "video.episode" })
        .whereNull("episode.deleted_at").select("relation.parent_item_id as parent_id")
        .max({ created_at: "episode.created_at", premiere_date: "episode.premiere_date" }).groupBy("relation.parent_item_id");
    }
    const dates = new Map(rows.map((row) => [String(row.parent_id), row]));
    entries.forEach((entry) => {
      const children = entry.itemType === "video.series" ? dates.get(entry.id) : undefined;
      entry.values.datelastcontentadded = readDate(children?.created_at) ?? entry.values.datecreated ?? null;
      entry.values.lastcontentpremieredate = readDate(children?.premiere_date) ?? entry.values.premieredate ?? null;
    });
  }

  /** 播放排序使用当前 Jellyfin 账号的实际播放时间，绝不读取更新进度记录的时间。 */
  private async loadPlaybackDates(context: JellyfinSortContext, entries: JellyfinSortEntry[]): Promise<void> {
    const aggregate = context.aggregateService;
    const query = this.runtime.database.query(aggregate ? "aggregate_playback_progress as progress" : "service_playback_progress as progress")
      .where(aggregate ? "progress.aggregate_service_id" : "progress.service_id", context.serviceId).where("progress.account_id", context.accountId);
    if (aggregate) query.join("aggregate_media_items as item", "item.id", "progress.aggregate_item_id")
      .where("item.status", "active").whereNull("item.deleted_at").select("item.parent_aggregate_item_id as parent_id");
    else query.join("media_items as item", "item.id", "progress.item_id").whereNull("item.deleted_at")
      .leftJoin("media_relations as relation", "relation.child_item_id", "item.id").select("relation.parent_item_id as parent_id");
    const rows = await query.select("item.id", "progress.last_played_at", "progress.play_count", "progress.played");
    const dates = new Map<string, number>();
    const own = new Map<string, Record<string, unknown>>();
    rows.forEach((row) => {
      own.set(String(row.id), row);
      const date = readDate(row.last_played_at);
      // Jellyfin 的 SeriesDatePlayed 汇总已观看子集；仅有未完成进度不冒充已观看日期。
      if (date !== null && row.parent_id && Number(row.played) === 1) dates.set(String(row.parent_id), Math.max(dates.get(String(row.parent_id)) ?? 0, date));
    });
    entries.forEach((entry) => {
      const row = own.get(entry.id);
      const ownDate = readDate(row?.last_played_at);
      entry.values.dateplayed = ownDate;
      entry.values.seriesdateplayed = entry.itemType === "video.series" ? dates.get(entry.id) ?? ownDate : ownDate;
      entry.values.playcount = readNumber(row?.play_count) ?? 0;
    });
  }

  /** 按所有请求字段排序，空值始终置后，最终 ID 保证同值条目跨页顺序稳定。 */
  public sort(entries: JellyfinSortEntry[], plan: JellyfinSortPlan): JellyfinSortEntry[] {
    if (plan.fields.some((field) => field.name === "random")) entries.forEach((entry) => {
      entry.values.random = createHash("sha256").update(`${plan.randomSeed}:${entry.id}`).digest("hex");
    });
    return entries.sort((left, right) => {
      for (const field of plan.fields) {
        const a = left.values[field.name] ?? null;
        const b = right.values[field.name] ?? null;
        if (a === null && b !== null) return 1;
        if (b === null && a !== null) return -1;
        if (a === null || b === null) continue;
        const compared = typeof a === "number" && typeof b === "number" ? a - b : TITLE_COLLATOR.compare(String(a), String(b));
        if (compared) return field.descending ? -compared : compared;
      }
      return left.id.localeCompare(right.id);
    });
  }

  /** 诊断仅记录分页和排序键，不记录账号令牌、播放地址或完整元数据。 */
  public log(context: JellyfinSortContext, plan: JellyfinSortPlan, entries: JellyfinSortEntry[], offset: number, count: number): void {
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-sort", 事件: "Jellyfin排序完成", 服务ID: context.serviceId,
      聚合服务: context.aggregateService, 排序字段: plan.fields.map((field) => `${field.name}:${field.descending ? "降序" : "升序"}`).join(","),
      候选数量: entries.length, 分页起点: offset, 返回数量: count,
      排序样本: JSON.stringify(entries.slice(offset, offset + 3).map((entry) => ({ 条目ID: entry.id,
        排序值: plan.fields.map((field) => ({ 字段: field.name, 值: entry.values[field.name] ?? null })) }))),
    });
  }
}
