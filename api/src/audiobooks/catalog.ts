import type { Knex } from "knex";
import { parseJsonObject } from "../domain.js";

/** 从实际活动音频汇总全书时长、作者与演播者，删除文件后也重新计算。 */
export async function refreshAudiobookCatalogSummaries(
  transaction: Knex.Transaction,
  userId: string,
  libraryId: string,
  now: string,
): Promise<string[]> {
  const books = await transaction("media_items")
    .select("id", "metadata_json", "poster_url", "overview")
    .where({ user_id: userId, library_id: libraryId, item_type: "audiobook.book" })
    .whereNull("deleted_at");
  if (!books.length) return [];
  const chapters = await transaction("media_relations as r")
    .join("media_items as m", "m.id", "r.child_item_id")
    .select("r.parent_item_id", "m.metadata_json", "m.poster_url", "m.overview", "m.sort_title")
    .where({ "r.user_id": userId, "m.library_id": libraryId, "r.relation_type": "book_chapter" })
    .whereNull("m.deleted_at")
    .whereExists(function activeAudioFile() {
      this.select("f.id")
        .from("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .whereRaw("?? = ??", ["fl.item_id", "m.id"])
        .where("f.status", "active");
    })
    .orderBy("m.sort_title", "asc");
  const chaptersByBook = new Map<string, typeof chapters>();
  for (const chapter of chapters) {
    const rows = chaptersByBook.get(String(chapter.parent_item_id)) ?? [];
    rows.push(chapter);
    chaptersByBook.set(String(chapter.parent_item_id), rows);
  }
  const changedBookIds: string[] = [];
  for (const book of books) {
    const rows = chaptersByBook.get(String(book.id)) ?? [];
    const metadata = parseJsonObject(book.metadata_json);
    let durationMs = 0;
    let posterUrl = book.poster_url ? String(book.poster_url) : null;
    let overview = String(book.overview || "");
    const authors = new Set<string>();
    const narrators = new Set<string>();
    const genres = new Set<string>();
    for (const row of rows) {
      const chapter = parseJsonObject(row.metadata_json);
      const duration = Number(chapter.durationMs);
      if (Number.isFinite(duration) && duration > 0) durationMs += duration;
      for (const [field, values] of [
        ["authors", authors],
        ["narrators", narrators],
        ["genres", genres],
      ] as const) {
        const entries = chapter[field];
        if (Array.isArray(entries))
          for (const value of entries)
            if (typeof value === "string" && value.trim()) values.add(value.trim());
      }
      if (!posterUrl && row.poster_url) posterUrl = String(row.poster_url);
      if (!overview && row.overview) overview = String(row.overview);
    }
    const nextMetadata = {
      ...metadata,
      durationMs: Math.round(durationMs),
      audioFileCount: rows.length,
      authors: authors.size ? [...authors] : (metadata.authors ?? []),
      narrators: narrators.size ? [...narrators] : (metadata.narrators ?? []),
      genres: genres.size ? [...genres] : (metadata.genres ?? []),
    };
    const nextJson = JSON.stringify(nextMetadata);
    if (
      nextJson === String(book.metadata_json) &&
      posterUrl === (book.poster_url || null) &&
      overview === String(book.overview || "")
    )
      continue;
    await transaction("media_items")
      .where({ id: String(book.id), user_id: userId, library_id: libraryId })
      .update({ metadata_json: nextJson, poster_url: posterUrl, overview, updated_at: now });
    changedBookIds.push(String(book.id));
  }
  return changedBookIds;
}
