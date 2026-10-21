import type { Knex } from "knex";
import type { MediaItemRecord } from "../domain.js";
import type { ApiRuntime } from "../runtime.js";
import { absBookEntities, absEntityId, absNames } from "./catalog-metadata.js";
import { absBookGenres, absBookMatchesLibrary, withAbsLibraryViews } from "./library-views.js";
import { readAbsArray, readAbsObject, readAbsSeconds, type AbsBook, type AbsContext } from "./types.js";

/** 目录只需要书目和聚合值，不携带真实文件定位、完整章节或可播放音轨。 */
export interface AbsBookSummary extends Omit<AbsBook, "tracks" | "chapters"> {
  audioFileCount: number;
  chapterCount: number;
  size: number;
  hasInvalidDuration: boolean;
  /** 在线书目尚未补全时，零轨数仅表示未知，不能作为丢失文件。 */
  detailsLoaded?: boolean;
}

/** 只有详情和播放才加载 AbsBook；目录筛选、计数与自然排序均使用该批量摘要。 */
export async function loadAbsBookSummaries(
  runtime: ApiRuntime,
  context: AbsContext,
  itemIds?: string[],
): Promise<AbsBookSummary[]> {
  if (itemIds?.length === 0) return [];
  context = await withAbsLibraryViews(runtime, context);
  const query = runtime.database
    .query("media_items as b")
    .join("media_libraries as l", "l.id", "b.library_id")
    .join("user_accounts as u", "u.id", "b.user_id")
    .select("b.*", "l.library_kind", "l.display_name as service_name", "u.username as owner_username")
    .where({
      "b.library_id": context.libraryId,
      "b.user_id": context.ownerUserId,
      "b.item_type": "audiobook.book",
    })
    .whereNull("b.deleted_at");
  // 源站浏览只装配当前窗口或客户端小页的摘要，避免每次追加都读取全库。
  if (itemIds) query.whereIn("b.id", itemIds);
  const rows = await query;
  // 关键变量：先按分类收窄目录，再统计、排序和分页；不加载章节或请求源站详情。
  const visibleRows = rows.filter((row) => absBookMatchesLibrary(context, {
    metadata: readAbsObject(row.metadata_json),
  }));
  if (!visibleRows.length) return [];

  // 关键变量：在线章节没有网盘 source_files；列表直接使用详情入库时保存的真实聚合值。
  if (visibleRows.every((row) => String(row.library_kind) === "content_source_audiobook")) {
    await runtime.contentAudiobooks.assertLibraryAvailable(context.libraryId, context.ownerUserId);
    return visibleRows.map((row) => {
      const item = mapSummaryItem(row, context);
      const detailsLoaded = item.metadata.audioDetailsLoaded === true;
      const audioFileCount = Math.floor(readAbsSeconds(item.metadata.audioFileCount));
      const duration = readAbsSeconds(Number(item.metadata.durationMs ?? 0) / 1000);
      item.fileCount = audioFileCount;
      return {
        item, bookId: absEntityId(context.libraryId, "book", item.id), ...absBookEntities(context, item.metadata),
        duration, audioFileCount,
        chapterCount: Math.floor(readAbsSeconds(item.metadata.chapterCount ?? audioFileCount)),
        size: readAbsSeconds(item.metadata.size), detailsLoaded,
        hasInvalidDuration: detailsLoaded && (audioFileCount === 0 || duration <= 0),
      };
    });
  }

  // 关键变量：数据库仅投影每个物理音频的几个聚合标量，不传回 metadata.chapters 或网盘取址。
  const audioRows = await runtime.database
    .query("media_relations as r")
    .join("media_items as c", "c.id", "r.child_item_id")
    .join("media_items as b", "b.id", "r.parent_item_id")
    .join("file_links as fl", function joinSummaryFileLink() {
      this.on("fl.item_id", "=", "c.id").andOn("fl.user_id", "=", "r.user_id");
    })
    .join("source_files as f", "f.id", "fl.source_file_id")
    .join("library_sources as ls", "ls.id", "f.library_source_id")
    .leftJoin("cloud_services as source_service", "source_service.id", "ls.service_id")
    .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
    .select("r.parent_item_id", "c.id as chapter_id", "f.size")
    .select({
      duration_ms: summaryJsonScalar(runtime, "c.metadata_json", "durationMs"),
      probe_duration: summaryJsonScalar(runtime, "p.result_json", "durationSeconds"),
      embedded_chapter_count: summaryEmbeddedChapterCount(runtime),
    })
    .where({
      "r.user_id": context.ownerUserId,
      "r.library_id": context.libraryId,
      "b.user_id": context.ownerUserId,
      "b.library_id": context.libraryId,
      "b.item_type": "audiobook.book",
      "c.user_id": context.ownerUserId,
      "c.library_id": context.libraryId,
      "c.item_type": "audiobook.chapter",
      "f.status": "active",
    })
    .whereNull("b.deleted_at")
    .whereNull("c.deleted_at")
    .where((builder) =>
      builder
        .where((owned) =>
          owned.where({
            "ls.source_mode": "owned_copy",
            "ls.status": "active",
            "ls.connection_status": "valid",
          }),
        )
        .orWhere((linked) =>
          linked
            .where({
              "ls.source_mode": "linked_service",
              "ls.status": "active",
              "source_service.connection_status": "valid",
            })
            .whereIn("source_service.status", ["active", "scanning"]),
        ),
    )
    .orderBy("ls.sort_order", "asc")
    .orderBy("f.path", "asc")
    .orderBy("f.id", "asc");

  const summaries = new Map<string, AbsBookSummary>();
  for (const row of visibleRows) {
    const item = mapSummaryItem(row, context);
    summaries.set(item.id, {
      item,
      bookId: absEntityId(context.libraryId, "book", item.id),
      ...absBookEntities(context, item.metadata),
      duration: 0,
      audioFileCount: 0,
      chapterCount: 0,
      size: 0,
      hasInvalidDuration: false,
    });
  }
  // 同一内部章节若有多个来源，沿用详情选取的来源顺序，只统计实际播放的第一个文件。
  const countedChapters = new Set<string>();
  for (const row of audioRows) {
    const chapterKey = `${String(row.parent_item_id)}\0${String(row.chapter_id)}`;
    const summary = summaries.get(String(row.parent_item_id));
    if (!summary || countedChapters.has(chapterKey)) continue;
    countedChapters.add(chapterKey);
    const duration =
      readAbsSeconds(Number(row.duration_ms ?? 0) / 1000) || readAbsSeconds(row.probe_duration);
    summary.duration += duration;
    summary.audioFileCount += 1;
    summary.chapterCount += Math.max(1, Number(row.embedded_chapter_count) || 0);
    summary.size += readAbsSeconds(row.size);
    summary.hasInvalidDuration ||= duration <= 0;
    summary.item.fileCount = summary.audioFileCount;
  }
  await fillSummaryEntities(runtime, context, summaries);
  return [...summaries.values()];
}

/** 父级尚未汇总作者、演播者时，批量投影名称字段，禁止退回逐本完整详情读取。 */
async function fillSummaryEntities(
  runtime: ApiRuntime,
  context: AbsContext,
  summaries: Map<string, AbsBookSummary>,
): Promise<void> {
  const pending = [...summaries.values()].filter((book) => !book.authors.length || !book.narrators.length);
  for (let offset = 0; offset < pending.length; offset += 300) {
    // 关键变量：限制 IN 参数数，兼容 SQLite 的绑定数量限制。
    const ids = pending.slice(offset, offset + 300).map((book) => book.item.id);
    const rows = await runtime.database
      .query("media_relations as r")
      .join("media_items as c", "c.id", "r.child_item_id")
      .select("r.parent_item_id", "c.id", "c.sort_title")
      .select({
        authors: summaryJsonScalar(runtime, "c.metadata_json", "authors"),
        narrators: summaryJsonScalar(runtime, "c.metadata_json", "narrators"),
        disc_number: summaryJsonScalar(runtime, "c.metadata_json", "discNumber"),
        chapter_number: summaryJsonScalar(runtime, "c.metadata_json", "chapterNumber"),
      })
      .where({
        "r.user_id": context.ownerUserId,
        "r.library_id": context.libraryId,
        "c.user_id": context.ownerUserId,
        "c.library_id": context.libraryId,
        "c.item_type": "audiobook.chapter",
      })
      .whereIn("r.parent_item_id", ids)
      .whereNull("c.deleted_at");
    rows.sort(
      (left, right) =>
        Number(left.disc_number ?? 1) - Number(right.disc_number ?? 1) ||
        Number(left.chapter_number ?? 0) - Number(right.chapter_number ?? 0) ||
        String(left.sort_title).localeCompare(String(right.sort_title), "zh-CN", { numeric: true }) ||
        String(left.id).localeCompare(String(right.id)),
    );
    const names = new Map<string, { authors: string[]; narrators: string[] }>();
    for (const row of rows) {
      const id = String(row.parent_item_id);
      const entry = names.get(id) ?? { authors: [], narrators: [] };
      entry.authors.push(...summaryProjectedNames(row.authors));
      entry.narrators.push(...summaryProjectedNames(row.narrators));
      names.set(id, entry);
    }
    for (const id of ids) {
      const summary = summaries.get(id)!;
      const fallback = names.get(id);
      Object.assign(
        summary,
        absBookEntities(context, summary.item.metadata, fallback?.authors, fallback?.narrators),
      );
    }
  }
}

/** JSON 标量查询在 SQLite/MySQL 返回数组文本，在 PostgreSQL 返回 JSON 文本，统一读取其名称值。 */
function summaryProjectedNames(value: unknown): string[] {
  return typeof value === "string" && value.trim().startsWith("[")
    ? absNames(readAbsArray(value))
    : absNames(value);
}

/** 仅读取需要的 JSON 标量；三种数据库均不把整段章节时间轴带回 Node 进程。 */
function summaryJsonScalar(runtime: ApiRuntime, column: string, key: string): Knex.Raw {
  const query = runtime.database.query;
  if (runtime.config.databaseType === "postgres")
    return query.raw("(NULLIF(??, '')::jsonb ->> ?)", [column, key]);
  if (runtime.config.databaseType === "mysql")
    return query.raw("(CASE WHEN JSON_VALID(??) THEN JSON_UNQUOTE(JSON_EXTRACT(??, ?)) ELSE NULL END)", [
      column,
      column,
      `$.${key}`,
    ]);
  return query.raw("(CASE WHEN json_valid(??) THEN json_extract(??, ?) ELSE NULL END)", [
    column,
    column,
    `$.${key}`,
  ]);
}

/** 在数据库内计算有效内嵌章节数，保留完整详情过滤非法章节后的数量语义。 */
function summaryEmbeddedChapterCount(runtime: ApiRuntime): Knex.Raw {
  const query = runtime.database.query;
  if (runtime.config.databaseType === "postgres")
    return query.raw(
      `(
      SELECT COUNT(*) FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(NULLIF(??, '')::jsonb -> 'chapters') = 'array'
          THEN NULLIF(??, '')::jsonb -> 'chapters' ELSE '[]'::jsonb END
      ) AS chapter(value)
      WHERE jsonb_typeof(chapter.value -> 'start') = 'number'
        AND jsonb_typeof(chapter.value -> 'end') = 'number'
        AND (chapter.value ->> 'start')::numeric >= 0
        AND (chapter.value ->> 'end')::numeric > (chapter.value ->> 'start')::numeric
    )`,
      ["c.metadata_json", "c.metadata_json"],
    );
  if (runtime.config.databaseType === "mysql")
    // 扫描器只保存校验后的章数组；使用 JSON_LENGTH 保持既有 MySQL 版本要求，不引入 JSON_TABLE。
    return query.raw(
      `(CASE
      WHEN JSON_VALID(??) AND JSON_TYPE(JSON_EXTRACT(??, '$.chapters')) = 'ARRAY'
      THEN JSON_LENGTH(JSON_EXTRACT(??, '$.chapters')) ELSE 0 END
    )`,
      ["c.metadata_json", "c.metadata_json", "c.metadata_json"],
    );
  return query.raw(
    `(
    SELECT COUNT(*) FROM json_each(CASE WHEN json_valid(??) THEN ?? ELSE '{}' END, '$.chapters') AS chapter
    WHERE json_type(chapter.value, '$.start') IN ('integer', 'real')
      AND json_type(chapter.value, '$.end') IN ('integer', 'real')
      AND json_extract(chapter.value, '$.start') >= 0
      AND json_extract(chapter.value, '$.end') > json_extract(chapter.value, '$.start')
  )`,
    ["c.metadata_json", "c.metadata_json"],
  );
}

/** 书目映射只装配协议会读取的内部字段，避免仓库详情方法再次加载音轨和规格。 */
function mapSummaryItem(row: Record<string, unknown>, context: AbsContext): MediaItemRecord {
  // 关键变量：只补充当前响应的题材字段，让旧摘要的显示与筛选一致，不触发目录写入。
  const metadata = readAbsObject(row.metadata_json);
  metadata.genres = absBookGenres(context, { metadata });
  return {
    id: String(row.id),
    userId: String(row.user_id),
    serviceId: row.service_id ? String(row.service_id) : "",
    libraryId: String(row.library_id),
    libraryKind: row.library_kind as MediaItemRecord["libraryKind"],
    mediaType: "audiobook",
    itemType: "audiobook.book",
    regionGroup: "other",
    title: String(row.title),
    sortTitle: String(row.sort_title),
    subtitle: String(row.subtitle ?? ""),
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    premiereDate: row.premiere_date ? String(row.premiere_date) : null,
    overview: String(row.overview ?? ""),
    posterUrl: row.poster_url ? String(row.poster_url) : null,
    backdropUrl: row.backdrop_url ? String(row.backdrop_url) : null,
    matchState: row.match_state as MediaItemRecord["matchState"],
    externalIds: Object.fromEntries(
      Object.entries(readAbsObject(row.external_ids_json)).map(([key, value]) => [key, String(value)]),
    ),
    metadata,
    fileCount: 0,
    mediaProbeSummary: null,
    ownerUsername: String(row.owner_username),
    serviceName: String(row.service_name),
    sourceNames: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
