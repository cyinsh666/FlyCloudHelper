import type { Knex } from "knex";
import type { DatabaseType } from "../config.js";

/** 读取目录条目首次入库时写入的批次，旧条目未记录此字段。 */
export function readCatalogEntryBatch(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.entryBatchId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从服务端取批次，忽略来源元数据里的同名字段。 */
export function withCatalogEntryBatch(
  metadata: Record<string, unknown>,
  entryBatchId: string | undefined,
): Record<string, unknown> {
  if (metadata.entryBatchId === entryBatchId) return metadata;
  const result = { ...metadata };
  if (entryBatchId === undefined) delete result.entryBatchId;
  else result.entryBatchId = entryBatchId;
  return result;
}

/** 批量 UPSERT 在 MySQL 和 SQLite、PostgreSQL 分别使用各自的新行引用。 */
export function incomingCatalogColumn(query: Knex, databaseType: DatabaseType, column: string): Knex.Raw {
  return databaseType === "mysql" ? query.raw("VALUES(??)", [column]) : query.raw("??", [`excluded.${column}`]);
}

/** 冲突时保留数据库当前行的首次入库批次，常规更新直接沿用原序列化格式。 */
export function preserveCatalogEntryBatchOnConflict(query: Knex, databaseType: DatabaseType): Knex.Raw {
  const stored = "media_items.metadata_json";
  const incoming = databaseType === "mysql" ? "VALUES(metadata_json)" : "excluded.metadata_json";
  if (databaseType === "postgres") {
    const oldBatch = `NULLIF(${stored}::jsonb ->> 'entryBatchId', '')`;
    const newBatch = `NULLIF(${incoming}::jsonb ->> 'entryBatchId', '')`;
    return query.raw(`CASE WHEN ${oldBatch} IS NOT DISTINCT FROM ${newBatch} THEN ${incoming}
      WHEN ${oldBatch} IS NULL THEN (${incoming}::jsonb - 'entryBatchId')::text
      ELSE (${incoming}::jsonb || jsonb_build_object('entryBatchId', ${oldBatch}))::text END`);
  }
  if (databaseType === "mysql") {
    const oldBatch = `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${stored}, '$.entryBatchId')), '')`;
    const newBatch = `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${incoming}, '$.entryBatchId')), '')`;
    return query.raw(`CASE WHEN ${oldBatch} <=> ${newBatch} THEN ${incoming}
      WHEN ${oldBatch} IS NULL THEN JSON_REMOVE(${incoming}, '$.entryBatchId')
      ELSE JSON_SET(${incoming}, '$.entryBatchId', ${oldBatch}) END`);
  }
  const oldBatch = `NULLIF(json_extract(${stored}, '$.entryBatchId'), '')`;
  const newBatch = `NULLIF(json_extract(${incoming}, '$.entryBatchId'), '')`;
  return query.raw(`CASE WHEN ${oldBatch} IS ${newBatch} THEN ${incoming}
    WHEN ${oldBatch} IS NULL THEN json_remove(${incoming}, '$.entryBatchId')
    ELSE json_set(${incoming}, '$.entryBatchId', ${oldBatch}) END`);
}
