import { createHash } from "node:crypto";
import { readAbsArray, readAbsObject, type AbsBook, type AbsContext } from "./types.js";

/** 将内部作用域身份转换为稳定 UUID，兼容客户端对 ABS ID 的格式检查。 */
export function absEntityId(libraryId: string, kind: string, identity: string): string {
  const hex = createHash("sha256").update([libraryId, kind, identity].join("\0")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 读取有声书文本数组，保留作者、演播者的独立角色。 */
export function absNames(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return [
    ...new Set(
      readAbsArray(value).flatMap((entry) => {
        const text = typeof entry === "string" ? entry : String(readAbsObject(entry).name ?? "");
        return text.trim() ? [text.trim()] : [];
      }),
    ),
  ];
}

/** 书目摘要和完整详情共用实体身份，分页不得改变作者、系列或作品归属。 */
export function absBookEntities(
  context: AbsContext,
  metadata: Record<string, unknown>,
  fallbackAuthors: string[] = [],
  fallbackNarrators: string[] = [],
): Pick<AbsBook, "authors" | "narrators" | "series"> {
  const authorNames = absNames(metadata.authors);
  const narratorNames = absNames(metadata.narrators);
  const authors = (authorNames.length ? authorNames : [...new Set(fallbackAuthors)]).map((name) => ({
    id: absEntityId(context.libraryId, "author", name),
    name,
  }));
  const narrators = narratorNames.length ? narratorNames : [...new Set(fallbackNarrators)];
  const series = readAbsArray(metadata.series)
    .map((value) => {
      const row = readAbsObject(value);
      const name = typeof value === "string" ? value : String(row.name ?? "");
      return {
        id: absEntityId(context.libraryId, "series", name),
        name,
        sequence: row.sequence === undefined || row.sequence === null ? null : String(row.sequence),
      };
    })
    .filter((entry) => entry.name);
  if (!series.length && typeof metadata.seriesName === "string" && metadata.seriesName)
    series.push({
      id: absEntityId(context.libraryId, "series", metadata.seriesName),
      name: metadata.seriesName,
      sequence: metadata.seriesSequence === undefined ? null : String(metadata.seriesSequence),
    });
  return { authors, narrators, series };
}
