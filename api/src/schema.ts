import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { repairDuplicateCatalogFileLinks } from "./catalog-file-link-repair.js";

import { createMusicScanTables } from "./music/scan-state.js";

export const currentSchemaVersion = 60;

/** 仅在目标表缺少字段时追加字段，兼容已完成认证阶段初始化的 SQLite。 */
async function addColumnIfMissing(
  database: Knex,
  tableName: string,
  columnName: string,
  callback: (table: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (!(await database.schema.hasColumn(tableName, columnName))) {
    await database.schema.alterTable(tableName, callback);
  }
}

/** 单独创建索引并容忍上次迁移中断后已经存在的索引。 */
async function addIndexIfMissing(
  database: Knex,
  tableName: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  try {
    await database.schema.alterTable(tableName, (table) => {
      table.index(columns, indexName);
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const duplicateIndex = databaseError.code === "42P07"
      || databaseError.code === "42710"
      || databaseError.code === "ER_DUP_KEYNAME"
      || /index .* already exists/iu.test(databaseError.message);
    if (!duplicateIndex) throw error;
  }
}

/** 单独创建唯一约束，并容忍上次迁移已经完成但版本号尚未写回的情况。 */
async function addUniqueIfMissing(
  database: Knex,
  tableName: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  try {
    await database.schema.alterTable(tableName, (table) => {
      table.unique(columns, { indexName });
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const duplicateIndex = databaseError.code === "42P07"
      || databaseError.code === "ER_DUP_KEYNAME"
      || /(?:index|constraint) .* already exists/iu.test(databaseError.message);
    if (!duplicateIndex) throw error;
  }
}

/** 删除历史唯一约束，并容忍约束已经不存在或迁移中断后已被删除。 */
async function dropUniqueIfExists(
  database: Knex,
  tableName: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  try {
    await database.schema.alterTable(tableName, (table) => {
      table.dropUnique(columns, indexName);
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const constraintMissing = databaseError.code === "42704"
      || databaseError.code === "ER_CANT_DROP_FIELD_OR_KEY"
      || /(?:constraint|index).*?(?:does not exist|not found|no such)|no such (?:index|constraint)/iu
        .test(databaseError.message);
    if (!constraintMissing) throw error;
  }
}

/** 删除首期单来源约束，当前仍由业务入口限制一对一，为后续一个媒体库接入多个服务保留结构能力。 */
async function dropLegacyLibrarySingleSourceUnique(database: Knex): Promise<void> {
  try {
    await database.schema.alterTable("library_sources", (table) => {
      table.dropUnique(["user_id", "library_id"], "uq_library_sources_library");
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const constraintMissing = databaseError.code === "42704"
      || databaseError.code === "ER_CANT_DROP_FIELD_OR_KEY"
      || /(?:constraint|index).*?(?:does not exist|not found|no such)|no such (?:index|constraint)/iu
        .test(databaseError.message);
    if (!constraintMissing) throw error;
  }
}

/** 删除已经下线的聚合服务表及其中的全部历史数据。 */
async function dropRemovedAggregateServiceTables(database: Knex): Promise<void> {
  // 关键变量：按外键依赖从子表到主表删除，不保留旧聚合账号、索引或观看状态。
  const removedTables = [
    "aggregate_item_preferences",
    "aggregate_playback_history",
    "aggregate_playback_sessions",
    "aggregate_playback_progress",
    "aggregate_protocol_sessions",
    "aggregate_media_item_members",
    "aggregate_index_jobs",
    "aggregate_media_items",
    "aggregate_service_members",
    "aggregate_access_accounts",
    "aggregate_services",
  ];
  for (const tableName of removedTables) {
    await database.schema.dropTableIfExists(tableName);
  }
}

/** 创建认证和实例状态基础表。 */
async function createIdentityTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("system_state"))) {
    await database.schema.createTable("system_state", (table) => {
      table.integer("singleton_id").primary();
      table.string("service_instance_id", 64).notNullable();
      table.string("initial_setup_completed_at", 40).nullable();
      table.string("credential_key_fingerprint", 64).nullable();
      table.string("credential_key_source", 32).nullable();
      table.integer("credential_key_backup_required").notNullable().defaultTo(0);
      table.integer("schema_version").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  } else {
    await addColumnIfMissing(database, "system_state", "service_instance_id", (table) => {
      table.string("service_instance_id", 64).nullable();
    });
    await addColumnIfMissing(database, "system_state", "schema_version", (table) => {
      table.integer("schema_version").nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_fingerprint", (table) => {
      table.string("credential_key_fingerprint", 64).nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_source", (table) => {
      table.string("credential_key_source", 32).nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_backup_required", (table) => {
      table.integer("credential_key_backup_required").notNullable().defaultTo(0);
    });
  }

  if (!(await database.schema.hasTable("user_accounts"))) {
    await database.schema.createTable("user_accounts", (table) => {
      table.string("id", 64).primary();
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable().unique();
      table.string("role", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("last_login_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  } else {
    await addColumnIfMissing(database, "user_accounts", "last_login_at", (table) => {
      table.string("last_login_at", 40).nullable();
    });
  }

  if (!(await database.schema.hasTable("user_passwords"))) {
    await database.schema.createTable("user_passwords", (table) => {
      table.string("user_id", 64).primary().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.text("password_hash").notNullable();
      table.string("password_changed_at", 40).notNullable();
    });
  }

  if (!(await database.schema.hasTable("user_external_identities"))) {
    await database.schema.createTable("user_external_identities", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("provider", 32).notNullable();
      table.string("identity_hash", 128).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["provider", "identity_hash"], { indexName: "uq_user_external_identity" });
      table.unique(["user_id", "provider"], { indexName: "uq_user_external_provider" });
      table.index(["user_id"], "idx_user_external_identities_user");
    });
  }

  if (!(await database.schema.hasTable("user_sessions"))) {
    await database.schema.createTable("user_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("token_hash", 64).notNullable().unique();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("last_seen_at", 40).notNullable();
      table.string("revoked_at", 40).nullable();
      table.index(["user_id"], "idx_user_sessions_user_id");
      table.index(["expires_at"], "idx_user_sessions_expires_at");
    });
  }

  if (!(await database.schema.hasTable("refresh_tokens"))) {
    await database.schema.createTable("refresh_tokens", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("token_hash", 64).notNullable().unique();
      table.string("family_id", 64).notNullable();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("rotated_at", 40).nullable();
      table.string("revoked_at", 40).nullable();
      table.index(["user_id"], "idx_refresh_tokens_user_id");
      table.index(["family_id"], "idx_refresh_tokens_family_id");
    });
  }
}

/** 创建网盘服务、媒体库、来源关系和配置修订表。 */
async function createServiceTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("cloud_services"))) {
    await database.schema.createTable("cloud_services", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("display_name", 255).notNullable();
      table.string("provider_type", 64).notNullable();
      table.string("status", 32).notNullable();
      table.string("connection_status", 64).notNullable();
      table.integer("credential_revision").notNullable();
      table.string("device_id", 255).nullable();
      table.string("device_name", 255).nullable();
      table.string("client_name", 255).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("deleted_at", 40).nullable();
      table.index(["user_id", "status"], "idx_cloud_services_user_status");
    });
  } else {
    // 关键变量：旧数据库可能已标记为最新版本，但历史建表分支没有补过这三个客户端来源字段。
    const clientMetadataColumns = ["device_id", "device_name", "client_name"] as const;
    const missingClientMetadataColumns: string[] = [];
    for (const columnName of clientMetadataColumns) {
      if (!(await database.schema.hasColumn("cloud_services", columnName))) {
        missingClientMetadataColumns.push(columnName);
      }
    }
    await addColumnIfMissing(database, "cloud_services", "device_id", (table) => {
      table.string("device_id", 255).nullable();
    });
    await addColumnIfMissing(database, "cloud_services", "device_name", (table) => {
      table.string("device_name", 255).nullable();
    });
    await addColumnIfMissing(database, "cloud_services", "client_name", (table) => {
      table.string("client_name", 255).nullable();
    });
    if (missingClientMetadataColumns.length > 0) {
      console.info(`[codex-cloud-service-schema] 事件=补齐网盘服务客户端来源字段 表名=cloud_services 缺失字段=${missingClientMetadataColumns.join(",")} 结果=成功`);
    }
  }
  if (!(await database.schema.hasTable("media_libraries"))) {
    await database.schema.createTable("media_libraries", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("display_name", 255).notNullable();
      table.string("data_type", 32).notNullable();
      table.string("library_kind", 64).notNullable().defaultTo("legacy_single_source");
      table.string("singleton_key", 64).nullable();
      table.bigInteger("catalog_version").notNullable().defaultTo(0);
      table.integer("notification_enabled").notNullable().defaultTo(0);
      table.integer("scan_profile_revision").notNullable().defaultTo(1);
      table.integer("metadata_profile_revision").notNullable().defaultTo(1);
      table.string("last_scan_at", 40).nullable();
      table.integer("jellyfin_relay_playback_enabled").notNullable().defaultTo(1);
      table.integer("jellyfin_download_enabled").notNullable().defaultTo(1);
      table.integer("jellyfin_region_libraries_enabled").notNullable().defaultTo(0);
      table.integer("jellyfin_enabled").notNullable().defaultTo(0);
      table.integer("emby_relay_playback_enabled").notNullable().defaultTo(0);
      table.integer("emby_download_enabled").notNullable().defaultTo(1);
      table.integer("emby_region_libraries_enabled").notNullable().defaultTo(0);
      table.integer("emby_enabled").notNullable().defaultTo(0);
      table.integer("navidrome_enabled").notNullable().defaultTo(0);
      table.integer("navidrome_relay_playback_enabled").notNullable().defaultTo(1);
      table.string("navidrome_path_suffix", 255).notNullable();
      table.string("navidrome_path_suffix_lookup", 255).notNullable();
      table.string("jellyfin_path_suffix", 255).notNullable();
      table.string("jellyfin_path_suffix_lookup", 255).notNullable();
      table.string("emby_path_suffix", 255).notNullable();
      table.string("emby_path_suffix_lookup", 255).notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id"], "idx_media_libraries_user");
      table.unique(["user_id", "singleton_key"], { indexName: "uq_media_libraries_singleton" });
      table.unique(["jellyfin_path_suffix_lookup"], { indexName: "uq_media_libraries_jellyfin_path_suffix" });
      table.unique(["emby_path_suffix_lookup"], { indexName: "uq_media_libraries_emby_path_suffix" });
      table.unique(["navidrome_path_suffix_lookup"], { indexName: "uq_media_libraries_navidrome_path_suffix" });
    });
  } else {
    await addColumnIfMissing(database, "media_libraries", "display_name", (table) => {
      table.string("display_name", 255).notNullable().defaultTo("");
    });
    await addColumnIfMissing(database, "media_libraries", "data_type", (table) => {
      table.string("data_type", 32).notNullable().defaultTo("video");
    });
    await addColumnIfMissing(database, "media_libraries", "library_kind", (table) => {
      table.string("library_kind", 64).notNullable().defaultTo("legacy_single_source");
    });
    await addColumnIfMissing(database, "media_libraries", "singleton_key", (table) => {
      table.string("singleton_key", 64).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "notification_enabled", (table) => {
      table.integer("notification_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "scan_profile_revision", (table) => {
      table.integer("scan_profile_revision").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "metadata_profile_revision", (table) => {
      table.integer("metadata_profile_revision").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "last_scan_at", (table) => {
      table.string("last_scan_at", 40).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_relay_playback_enabled", (table) => {
      table.integer("jellyfin_relay_playback_enabled").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_download_enabled", (table) => {
      table.integer("jellyfin_download_enabled").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_region_libraries_enabled", (table) => {
      table.integer("jellyfin_region_libraries_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_enabled", (table) => {
      table.integer("jellyfin_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "emby_relay_playback_enabled", (table) => {
      table.integer("emby_relay_playback_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "emby_download_enabled", (table) => {
      table.integer("emby_download_enabled").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "emby_region_libraries_enabled", (table) => {
      table.integer("emby_region_libraries_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "emby_enabled", (table) => {
      table.integer("emby_enabled").notNullable().defaultTo(0);
    });
    // 历史音乐服务始终中转，新增开关默认开启，升级后保持原有行为。
    await addColumnIfMissing(database, "media_libraries", "navidrome_relay_playback_enabled", (table) => {
      table.integer("navidrome_relay_playback_enabled").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "navidrome_enabled", (table) => {
      table.integer("navidrome_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "navidrome_path_suffix", (table) => {
      table.string("navidrome_path_suffix", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "navidrome_path_suffix_lookup", (table) => {
      table.string("navidrome_path_suffix_lookup", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_path_suffix", (table) => {
      table.string("jellyfin_path_suffix", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_path_suffix_lookup", (table) => {
      table.string("jellyfin_path_suffix_lookup", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "emby_path_suffix", (table) => {
      table.string("emby_path_suffix", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "emby_path_suffix_lookup", (table) => {
      table.string("emby_path_suffix_lookup", 255).nullable();
    });
  }

  if (!(await database.schema.hasTable("library_sources"))) {
    await database.schema.createTable("library_sources", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("RESTRICT");
      table.string("source_mode", 32).notNullable().defaultTo("linked_service");
      table.string("display_name", 255).notNullable();
      table.string("provider_type", 64).notNullable();
      table.string("connection_status", 64).notNullable().defaultTo("valid");
      table.integer("credential_revision").notNullable().defaultTo(0);
      table.text("configuration_json").notNullable().defaultTo("{}");
      table.string("status", 32).notNullable().defaultTo("active");
      table.integer("sort_order").notNullable().defaultTo(0);
      table.string("last_scan_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "service_id"], { indexName: "uq_library_sources_library_service" });
      table.index(["library_id", "status", "sort_order"], "idx_library_sources_library_order");
    });
  } else {
    await addColumnIfMissing(database, "library_sources", "source_mode", (table) => {
      table.string("source_mode", 32).notNullable().defaultTo("linked_service");
    });
    await addColumnIfMissing(database, "library_sources", "display_name", (table) => {
      table.string("display_name", 255).notNullable().defaultTo("");
    });
    await addColumnIfMissing(database, "library_sources", "provider_type", (table) => {
      table.string("provider_type", 64).notNullable().defaultTo("");
    });
    await addColumnIfMissing(database, "library_sources", "connection_status", (table) => {
      table.string("connection_status", 64).notNullable().defaultTo("valid");
    });
    await addColumnIfMissing(database, "library_sources", "credential_revision", (table) => {
      table.integer("credential_revision").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "library_sources", "configuration_json", (table) => {
      table.text("configuration_json").notNullable().defaultTo("{}");
    });
    await addColumnIfMissing(database, "library_sources", "last_scan_at", (table) => {
      table.string("last_scan_at", 40).nullable();
    });
  }

  if (!(await database.schema.hasTable("service_credentials"))) {
    await database.schema.createTable("service_credentials", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("encrypted_payload").notNullable();
      table.integer("key_version").notNullable();
      table.integer("schema_version").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "service_id", "revision"], { indexName: "uq_service_credentials_revision" });
    });
  }

  if (!(await database.schema.hasTable("library_source_credentials"))) {
    await database.schema.createTable("library_source_credentials", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("encrypted_payload").notNullable();
      table.integer("key_version").notNullable();
      table.integer("schema_version").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "library_source_id", "revision"], { indexName: "uq_library_source_credentials_revision" });
      table.index(["library_source_id", "status"], "idx_library_source_credentials_active");
    });
  }

  if (!(await database.schema.hasTable("library_scan_profiles"))) {
    await database.schema.createTable("library_scan_profiles", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "library_id", "revision"], { indexName: "uq_library_scan_profiles_revision" });
    });
  }

  if (!(await database.schema.hasTable("library_metadata_profiles"))) {
    await database.schema.createTable("library_metadata_profiles", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "library_id", "revision"], { indexName: "uq_library_metadata_profiles_revision" });
    });
  }

  if (!(await database.schema.hasTable("service_import_sources"))) {
    await database.schema.createTable("service_import_sources", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("source_device_id", 200).notNullable();
      table.string("source_local_service_id", 200).notNullable();
      table.string("request_id", 200).notNullable();
      table.string("provider_type", 64).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "source_device_id", "source_local_service_id"], { indexName: "uq_service_import_source" });
      table.unique(["user_id", "request_id"], { indexName: "uq_service_import_request" });
      table.index(["service_id"], "idx_service_import_sources_service");
    });
  }

  if (!(await database.schema.hasTable("library_access_accounts"))) {
    await database.schema.createTable("library_access_accounts", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable();
      table.text("password_hash").notNullable();
      table.text("protocol_password_encrypted").nullable();
      table.integer("password_required").notNullable().defaultTo(0);
      table.integer("credential_revision").notNullable().defaultTo(1);
      table.string("status", 32).notNullable().defaultTo("active");
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "username_lookup"], { indexName: "uq_library_access_username" });
    });
  }
  await addColumnIfMissing(database, "library_access_accounts", "password_required", (table) => {
    // 关键变量：缺少密码状态字段的旧结构按新的默认规则补为免密码。
    table.integer("password_required").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "library_access_accounts", "protocol_password_encrypted", (table) => {
    table.text("protocol_password_encrypted").nullable();
  });

  if (!(await database.schema.hasTable("library_protocol_sessions"))) {
    await database.schema.createTable("library_protocol_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("protocol", 32).notNullable();
      table.string("token_hash", 64).notNullable().unique();
      table.integer("credential_revision").notNullable();
      table.string("device_id", 255).nullable();
      table.string("device_name", 255).nullable();
      table.string("client_name", 255).nullable();
      table.string("expires_at", 40).notNullable();
      table.string("last_seen_at", 40).notNullable();
      table.string("revoked_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.index(["library_id", "protocol", "revoked_at"], "idx_library_protocol_sessions_library");
      table.index(["account_id", "expires_at"], "idx_library_protocol_sessions_account");
    });
  }
}

/** 在媒体目录表之后创建服务级播放数据表，确保 PostgreSQL 外键目标已经存在。 */
async function createPlaybackTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("library_playback_progress"))) {
    await database.schema.createTable("library_playback_progress", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("played").notNullable().defaultTo(0);
      table.integer("hidden_from_resume").notNullable().defaultTo(0);
      table.integer("play_count").notNullable().defaultTo(0);
      table.string("last_played_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "item_id"], { indexName: "uq_library_playback_progress" });
      table.index(["library_id", "account_id", "updated_at"], "idx_library_progress_resume");
    });
  }
  await addColumnIfMissing(database, "library_playback_progress", "media_source_id", (table) => {
    table.string("media_source_id", 128).nullable();
  });

  if (!(await database.schema.hasTable("library_playback_sessions"))) {
    await database.schema.createTable("library_playback_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.string("status", 32).notNullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("paused").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("stopped_at", 40).nullable();
      table.index(["library_id", "account_id", "status"], "idx_library_play_sessions_active");
    });
  }

  if (!(await database.schema.hasTable("library_playback_history"))) {
    await database.schema.createTable("library_playback_history", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("play_session_id", 64).notNullable().unique();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("completed").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("stopped_at", 40).notNullable();
      table.index(["library_id", "account_id", "stopped_at"], "idx_library_play_history_recent");
    });
  }

  if (!(await database.schema.hasTable("library_item_preferences"))) {
    await database.schema.createTable("library_item_preferences", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("starred_at", 40).nullable();
      table.integer("rating").notNullable().defaultTo(0);
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "item_id"], { indexName: "uq_library_item_preferences" });
      table.index(["library_id", "account_id", "starred_at"], "idx_library_item_preferences_starred");
    });
  }

  if (!(await database.schema.hasTable("library_jellyfin_virtual_preferences"))) {
    await database.schema.createTable("library_jellyfin_virtual_preferences", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      // 关键变量：Person 等虚拟 Jellyfin 条目没有 media_items 外键，直接保存稳定协议 ID。
      table.string("protocol_item_id", 64).notNullable();
      table.string("item_type", 32).notNullable();
      table.string("starred_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "protocol_item_id"], { indexName: "uq_library_jellyfin_virtual_preference" });
      table.index(["library_id", "account_id", "starred_at"], "idx_library_jellyfin_virtual_preference_starred");
    });
  }

  if (!(await database.schema.hasTable("library_music_playlists"))) {
    await database.schema.createTable("library_music_playlists", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_access_accounts").onDelete("CASCADE");
      table.string("name", 255).notNullable();
      table.text("comment").nullable();
      table.integer("is_public").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["library_id", "account_id", "updated_at"], "idx_library_music_playlists_account");
    });
  }
  if (!(await database.schema.hasTable("library_music_playlist_items"))) {
    await database.schema.createTable("library_music_playlist_items", (table) => {
      table.string("id", 64).primary();
      table.string("playlist_id", 64).notNullable().references("id").inTable("library_music_playlists").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.integer("sort_order").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["playlist_id", "sort_order"], "idx_library_music_playlist_items_order");
    });
  }
}

/**
 * 创建 Emby 独立账号、会话和用户状态表。
 *
 * Emby 不能复用 Jellyfin 的账号或观看状态；即使两个协议访问同一媒体库，也必须拥有完全独立的数据边界。
 */
async function createEmbyProtocolTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("library_emby_accounts"))) {
    await database.schema.createTable("library_emby_accounts", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable();
      table.text("password_hash").notNullable();
      table.integer("password_required").notNullable().defaultTo(0);
      table.integer("credential_revision").notNullable().defaultTo(1);
      table.string("status", 32).notNullable().defaultTo("active");
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "username_lookup"], { indexName: "uq_library_emby_username" });
      table.index(["library_id", "status"], "idx_library_emby_accounts_service");
    });
  }

  if (!(await database.schema.hasTable("library_emby_sessions"))) {
    await database.schema.createTable("library_emby_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      table.string("token_hash", 64).notNullable().unique();
      table.integer("credential_revision").notNullable();
      table.string("device_id", 255).nullable();
      table.string("device_name", 255).nullable();
      table.string("client_name", 255).nullable();
      table.string("expires_at", 40).notNullable();
      table.string("last_seen_at", 40).notNullable();
      table.string("revoked_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.index(["library_id", "revoked_at"], "idx_library_emby_sessions_service");
      table.index(["account_id", "expires_at"], "idx_library_emby_sessions_account");
    });
  }

  if (!(await database.schema.hasTable("library_emby_playback_progress"))) {
    await database.schema.createTable("library_emby_playback_progress", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("played").notNullable().defaultTo(0);
      table.integer("hidden_from_resume").notNullable().defaultTo(0);
      table.integer("play_count").notNullable().defaultTo(0);
      table.string("last_played_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "item_id"], { indexName: "uq_library_emby_playback_progress" });
      table.index(["library_id", "account_id", "updated_at"], "idx_library_emby_progress_resume");
    });
  }

  if (!(await database.schema.hasTable("library_emby_playback_sessions"))) {
    await database.schema.createTable("library_emby_playback_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.string("status", 32).notNullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("paused").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("stopped_at", 40).nullable();
      table.index(["library_id", "account_id", "status"], "idx_library_emby_play_sessions_active");
    });
  }

  if (!(await database.schema.hasTable("library_emby_playback_history"))) {
    await database.schema.createTable("library_emby_playback_history", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("play_session_id", 64).notNullable().unique();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("completed").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("stopped_at", 40).notNullable();
      table.index(["library_id", "account_id", "stopped_at"], "idx_library_emby_play_history_recent");
    });
  }

  if (!(await database.schema.hasTable("library_emby_item_preferences"))) {
    await database.schema.createTable("library_emby_item_preferences", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("starred_at", 40).nullable();
      table.integer("rating").notNullable().defaultTo(0);
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "item_id"], { indexName: "uq_library_emby_item_preferences" });
      table.index(["library_id", "account_id", "starred_at"], "idx_library_emby_item_preferences_starred");
    });
  }

  if (!(await database.schema.hasTable("library_emby_virtual_preferences"))) {
    await database.schema.createTable("library_emby_virtual_preferences", (table) => {
      table.string("id", 64).primary();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("library_emby_accounts").onDelete("CASCADE");
      // 关键变量：演员等虚拟 Emby 条目没有 media_items 主键，只保存协议层稳定 ID。
      table.string("protocol_item_id", 64).notNullable();
      table.string("item_type", 32).notNullable();
      table.string("starred_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "account_id", "protocol_item_id"], { indexName: "uq_library_emby_virtual_preference" });
      table.index(["library_id", "account_id", "starred_at"], "idx_library_emby_virtual_preferences_starred");
    });
  }
}

/** 创建扫描任务、源文件和媒体目录表。 */
async function createCatalogTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("library_scan_jobs"))) {
    await database.schema.createTable("library_scan_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("requested_by_user_id", 64).notNullable();
      table.string("request_id", 200).notNullable();
      table.string("client_device_id", 200).notNullable();
      table.string("scan_mode", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("control_action", 32).notNullable().defaultTo("none");
      table.integer("source_count").notNullable().defaultTo(0);
      table.integer("completed_source_count").notNullable().defaultTo(0);
      table.integer("failed_source_count").notNullable().defaultTo(0);
      table.integer("cancelled_source_count").notNullable().defaultTo(0);
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("discovered_count").notNullable().defaultTo(0);
      table.bigInteger("error_count").notNullable().defaultTo(0);
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("created_at", 40).notNullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      // 关键变量：多个来源子任务并发收尾时，只允许一个 Worker 领取父任务汇总通知。
      table.string("notification_sent_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "client_device_id", "request_id"], { indexName: "uq_library_scan_jobs_request" });
      table.index(["library_id", "status", "created_at"], "idx_library_scan_jobs_library_status");
    });
  }
  await addColumnIfMissing(database, "library_scan_jobs", "notification_sent_at", (table) => {
    table.string("notification_sent_at", 40).nullable();
  });

  if (!(await database.schema.hasTable("scan_jobs"))) {
    await database.schema.createTable("scan_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("RESTRICT");
      table.string("parent_job_id", 64).nullable().references("id").inTable("library_scan_jobs").onDelete("CASCADE");
      table.string("requested_by_user_id", 64).notNullable();
      table.string("request_id", 200).notNullable();
      table.string("client_device_id", 200).notNullable();
      table.string("scan_mode", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable();
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").nullable();
      table.bigInteger("discovered_count").notNullable().defaultTo(0);
      table.bigInteger("skipped_count").notNullable().defaultTo(0);
      table.bigInteger("matched_count").nullable();
      table.bigInteger("unmatched_count").nullable();
      table.bigInteger("error_count").notNullable().defaultTo(0);
      table.text("current_path").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.integer("retry_count").notNullable().defaultTo(0);
      table.text("snapshot_json").notNullable();
      table.string("control_action", 32).notNullable().defaultTo("none");
      table.string("created_at", 40).notNullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
      table.string("active_started_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "client_device_id", "request_id"], { indexName: "uq_scan_jobs_request" });
      table.index(["user_id", "status"], "idx_scan_jobs_user_status");
      table.index(["service_id", "status"], "idx_scan_jobs_service_status");
      table.index(["parent_job_id", "status"], "idx_scan_jobs_parent_status");
      table.index(["library_source_id", "status"], "idx_scan_jobs_source_status");
      table.index(["status", "next_retry_at"], "idx_scan_jobs_retry_due");
    });
  }
  await addColumnIfMissing(database, "scan_jobs", "matched_count", (table) => {
    table.bigInteger("matched_count").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "unmatched_count", (table) => {
    table.bigInteger("unmatched_count").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "current_path", (table) => {
    table.text("current_path").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "next_retry_at", (table) => {
    table.string("next_retry_at", 40).nullable();
    // 关键索引：Worker 只按等待状态和到期时间查询，不扫描全部历史任务。
    table.index(["status", "next_retry_at"], "idx_scan_jobs_retry_due");
  });
  await addColumnIfMissing(database, "scan_jobs", "retry_count", (table) => {
    table.integer("retry_count").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "scan_jobs", "active_duration_ms", (table) => {
    table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "scan_jobs", "active_started_at", (table) => {
    table.string("active_started_at", 40).nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "parent_job_id", (table) => {
    table.string("parent_job_id", 64).nullable().references("id").inTable("library_scan_jobs").onDelete("CASCADE");
    table.index(["parent_job_id", "status"], "idx_scan_jobs_parent_status");
  });
  // 兼容升级时已经处于运行中的旧任务：从本次升级时刻开始计时，不追算之前可能包含暂停或停机的时间。
  await database("scan_jobs")
    .where({ status: "running" })
    .whereNull("active_started_at")
    .update({ active_started_at: new Date().toISOString() });

  if (!(await database.schema.hasTable("library_scan_schedules"))) {
    await database.schema.createTable("library_scan_schedules", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("scan_mode", 32).notNullable();
      table.integer("enabled").notNullable().defaultTo(0);
      table.string("schedule_type", 32).notNullable();
      table.integer("interval_minutes").nullable();
      table.string("time_of_day", 5).nullable();
      table.integer("day_of_week").nullable();
      table.integer("day_of_month").nullable();
      table.integer("timezone_offset_minutes").notNullable().defaultTo(0);
      table.integer("quiet_period_enabled").notNullable().defaultTo(0);
      table.string("quiet_start_time", 5).nullable();
      table.string("quiet_end_time", 5).nullable();
      table.string("next_run_at", 40).nullable();
      table.string("last_triggered_at", 40).nullable();
      table.string("last_job_id", 64).nullable();
      table.text("last_error").nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "library_id", "scan_mode"], { indexName: "uq_library_scan_schedules_mode" });
      table.index(["enabled", "next_run_at"], "idx_library_scan_schedules_due");
    });
  }
  if (await database.schema.hasTable("service_scan_schedules")) {
    const legacySchedules = await database("service_scan_schedules as schedule")
      .join("library_sources as source", "source.service_id", "schedule.service_id")
      .select("schedule.*", "source.library_id");
    for (const schedule of legacySchedules) {
      const exists = await database("library_scan_schedules").where({
        user_id: schedule.user_id,
        library_id: schedule.library_id,
        scan_mode: schedule.scan_mode,
      }).first();
      if (!exists) {
        const { service_id: _serviceId, library_id: libraryId, ...values } = schedule;
        await database("library_scan_schedules").insert({ ...values, library_id: libraryId });
      }
    }
    await database.schema.dropTable("service_scan_schedules");
  }


  if (!(await database.schema.hasTable("scan_job_events"))) {
    await database.schema.createTable("scan_job_events", (table) => {
      table.increments("sequence").primary();
      table.string("user_id", 64).notNullable();
      table.string("job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("event_type", 64).notNullable();
      table.text("payload_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["job_id", "sequence"], "idx_scan_job_events_job_sequence");
      table.index(["user_id", "sequence"], "idx_scan_job_events_user_sequence");
    });
  }

  if (!(await database.schema.hasTable("scan_job_checkpoints"))) {
    await database.schema.createTable("scan_job_checkpoints", (table) => {
      table.string("job_id", 64).primary().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("RESTRICT");
      table.integer("checkpoint_version").notNullable();
      table.string("scan_session_id", 64).notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("provider_type", 64).notNullable();
      table.text("provider_state_json").notNullable();
      table.text("progress_json").notNullable();
      table.text("nfo_sidecars_json").notNullable();
      table.text("changed_item_ids_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id", "updated_at"], "idx_scan_job_checkpoints_user_updated");
      table.index(["service_id", "updated_at"], "idx_scan_job_checkpoints_service_updated");
    });
  }
  await addColumnIfMissing(database, "scan_job_checkpoints", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("scan_root_runs"))) {
    await database.schema.createTable("scan_root_runs", (table) => {
      table.string("id", 64).primary();
      table.string("job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).nullable();
      table.string("library_id", 64).notNullable();
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("RESTRICT");
      table.string("root_key", 64).notNullable();
      table.text("root_resource_id").notNullable();
      table.text("display_path").notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("status", 32).notNullable();
      table.bigInteger("warning_count").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["job_id", "root_key"], { indexName: "uq_scan_root_runs_job_root" });
      table.index(["library_id", "status"], "idx_scan_root_runs_library_status");
    });
  }
  await addColumnIfMissing(database, "scan_root_runs", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("tmdb_metadata_cache"))) {
    await database.schema.createTable("tmdb_metadata_cache", (table) => {
      // 缓存键为查询条件的 SHA-256，不保存用户、服务、网盘凭据或原始查询标题。
      table.string("cache_key", 64).primary();
      table.string("cache_kind", 32).notNullable();
      table.string("media_type", 16).notNullable();
      table.bigInteger("provider_item_id").notNullable();
      table.integer("season_number").nullable();
      table.string("language", 32).notNullable();
      table.string("region", 16).notNullable();
      table.integer("details_synchronized").notNullable().defaultTo(0);
      table.text("payload_json").notNullable();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["expires_at"], "idx_tmdb_metadata_cache_expires");
      table.index(["cache_kind", "provider_item_id"], "idx_tmdb_metadata_cache_provider_item");
    });
  }

  if (!(await database.schema.hasTable("source_files"))) {
    await database.schema.createTable("source_files", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("RESTRICT");
      table.string("provider_resource_id", 512).notNullable();
      table.string("parent_resource_id", 512).nullable();
      table.text("path").notNullable();
      table.text("name").notNullable();
      table.string("extension", 32).notNullable();
      table.bigInteger("size").notNullable();
      table.string("modified_at", 40).nullable();
      table.string("etag", 255).nullable();
      table.string("scan_root_key", 64).nullable();
      table.string("generation_id", 64).notNullable();
      table.integer("metadata_profile_revision").notNullable().defaultTo(0);
      table.string("recognition_revision", 128).nullable();
      table.text("locator_json").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "library_id", "library_source_id", "provider_resource_id"], { indexName: "uq_source_files_source_resource" });
      table.index(["library_id", "generation_id"], "idx_source_files_generation");
      table.index(["library_id", "scan_root_key", "generation_id"], "idx_source_files_root_generation");
    });
  }
  await addColumnIfMissing(database, "source_files", "scan_root_key", (table) => {
    table.string("scan_root_key", 64).nullable();
  });
  await addColumnIfMissing(database, "source_files", "metadata_profile_revision", (table) => {
    table.integer("metadata_profile_revision").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "source_files", "recognition_revision", (table) => {
    table.string("recognition_revision", 128).nullable();
  });
  await addColumnIfMissing(database, "source_files", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("media_item_source_candidates"))) {
    await database.schema.createTable("media_item_source_candidates", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.string("source_file_id", 64).notNullable().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("candidate_key", 160).notNullable();
      table.string("identity_key", 128).notNullable();
      table.string("candidate_role", 32).notNullable();
      // 兼容本轮已创建的数据库结构保留该列；统一元数据不再按网盘来源优先级排序。
      table.integer("source_priority").notNullable().defaultTo(0);
      table.integer("completeness_score").notNullable().defaultTo(0);
      table.text("payload_json").notNullable();
      table.string("status", 32).notNullable().defaultTo("active");
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "library_id", "source_file_id", "candidate_key"], { indexName: "uq_media_item_source_candidate" });
      table.index(["library_id", "identity_key", "status"], "idx_media_item_candidates_identity");
      table.index(["library_source_id", "status"], "idx_media_item_candidates_source");
    });
  }

  if (!(await database.schema.hasTable("catalog_projection_jobs"))) {
    await database.schema.createTable("catalog_projection_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.string("source_scan_job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("source_file_id", 64).notNullable().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("event_key", 200).notNullable();
      table.string("identity_key", 128).notNullable();
      table.string("action", 32).notNullable();
      table.text("payload_json").notNullable();
      table.string("status", 32).notNullable().defaultTo("queued");
      table.integer("attempt_count").notNullable().defaultTo(0);
      table.integer("max_attempts").notNullable().defaultTo(5);
      table.string("lease_owner", 100).nullable();
      table.string("lease_expires_at", 40).nullable();
      table.string("next_retry_at", 40).nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.unique(["source_scan_job_id", "event_key"], { indexName: "uq_catalog_projection_job_event" });
      table.index(["status", "next_retry_at", "created_at"], "idx_catalog_projection_jobs_claim");
      table.index(["source_scan_job_id", "status"], "idx_catalog_projection_jobs_scan_status");
      table.index(["library_id", "identity_key", "status"], "idx_catalog_projection_jobs_identity");
    });
  }

  if (!(await database.schema.hasTable("audio_file_tags"))) {
    await database.schema.createTable("audio_file_tags", (table) => {
      // 关键变量：一个源文件只保存当前文件指纹对应的一份音频标签，文件变化后原位覆盖。
      table.string("source_file_id", 64).primary().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("fingerprint", 64).notNullable();
      table.string("status", 32).notNullable();
      table.string("parser_version", 40).notNullable();
      table.text("tag_json").notNullable();
      table.text("technical_json").notNullable();
      table.text("artwork_json").notNullable();
      table.bigInteger("read_bytes_limit").notNullable().defaultTo(0);
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("read_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["library_id", "status"], "idx_audio_file_tags_library_status");
      table.index(["service_id", "updated_at"], "idx_audio_file_tags_service_updated");
    });
  }

  if (!(await database.schema.hasTable("nfo_sidecar_cache"))) {
    await database.schema.createTable("nfo_sidecar_cache", (table) => {
      // 关键变量：缓存使用Provider稳定资源ID和文件指纹，未变化的NFO无需再次从网盘下载。
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.string("provider_resource_id", 512).notNullable();
      table.text("path").notNullable();
      table.bigInteger("size").notNullable();
      table.string("modified_at", 40).nullable();
      table.string("etag", 255).nullable();
      table.string("parser_version", 40).notNullable();
      table.text("metadata_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "library_id", "library_source_id", "provider_resource_id"], { indexName: "uq_nfo_sidecar_cache_source_resource" });
      table.index(["service_id", "library_id"], "idx_nfo_sidecar_cache_service_library");
    });
  }
  await addColumnIfMissing(database, "nfo_sidecar_cache", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("media_probe_jobs"))) {
    await database.schema.createTable("media_probe_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("library_source_id", 64).nullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.string("requested_by_user_id", 64).notNullable();
      table.string("trigger_type", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable();
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").notNullable().defaultTo(0);
      table.bigInteger("error_count").notNullable().defaultTo(0);
      table.text("current_file_name").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.string("control_action", 32).notNullable().defaultTo("none");
      table.text("snapshot_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
      table.string("active_started_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id", "status", "created_at"], "idx_media_probe_jobs_user_status");
      table.index(["service_id", "status"], "idx_media_probe_jobs_service_status");
    });
  }
  await addColumnIfMissing(database, "media_probe_jobs", "error_code", (table) => {
    table.string("error_code", 100).nullable();
  });
  await addColumnIfMissing(database, "media_probe_jobs", "error_message", (table) => {
    table.text("error_message").nullable();
  });
  await addColumnIfMissing(database, "media_probe_jobs", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("media_file_probes"))) {
    await database.schema.createTable("media_file_probes", (table) => {
      // 关键变量：一个源文件只保存一份当前指纹对应的规格结果，文件变化时原位重新排队。
      table.string("source_file_id", 64).primary().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("library_source_id", 64).nullable();
      table.string("probe_job_id", 64).nullable();
      table.string("fingerprint", 64).notNullable();
      table.string("status", 32).notNullable();
      table.integer("attempt_count").notNullable().defaultTo(0);
      table.text("result_json").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["status", "next_retry_at", "created_at"], "idx_media_file_probes_queue");
      table.index(["service_id", "status"], "idx_media_file_probes_service_status");
      table.index(["library_id"], "idx_media_file_probes_library");
      table.index(["probe_job_id", "status"], "idx_media_file_probes_job_status");
    });
  }
  await addColumnIfMissing(database, "media_file_probes", "probe_job_id", (table) => {
    table.string("probe_job_id", 64).nullable();
    table.index(["probe_job_id", "status"], "idx_media_file_probes_job_status");
  });
  await addColumnIfMissing(database, "media_file_probes", "library_source_id", (table) => {
    table.string("library_source_id", 64).nullable();
  });

  if (!(await database.schema.hasTable("media_items"))) {
    await database.schema.createTable("media_items", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).nullable();
      table.string("library_id", 64).notNullable();
      table.string("identity_key", 128).notNullable();
      table.string("media_type", 32).notNullable();
      table.string("item_type", 64).notNullable();
      table.string("region_group", 32).notNullable().defaultTo("other");
      table.text("title").notNullable();
      table.text("sort_title").notNullable();
      table.text("subtitle").notNullable();
      table.integer("year").nullable();
      table.string("premiere_date", 40).nullable();
      table.text("overview").notNullable();
      table.text("poster_url").nullable();
      table.text("backdrop_url").nullable();
      table.string("match_state", 32).notNullable();
      table.text("external_ids_json").notNullable();
      table.text("metadata_json").notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("deleted_at", 40).nullable();
      table.unique(["user_id", "library_id", "identity_key"], { indexName: "uq_media_items_identity" });
      table.index(["user_id", "library_id", "media_type"], "idx_media_items_library_type");
      table.index(["library_id"], "idx_media_items_library");
      table.index(["service_id", "media_type"], "idx_media_items_service_type");
      table.index(["service_id", "item_type", "region_group", "deleted_at"], "idx_media_items_service_region");
      table.index(["user_id", "library_id", "deleted_at", "created_at"], "idx_media_items_catalog_created");
      table.index(["user_id", "library_id", "deleted_at", "sort_title"], "idx_media_items_catalog_title");
      table.index(["user_id", "library_id", "deleted_at", "year"], "idx_media_items_catalog_year");
      table.index(["user_id", "library_id", "deleted_at", "premiere_date"], "idx_media_items_catalog_premiere");
      table.index(["user_id", "deleted_at", "match_state"], "idx_media_items_user_match");
    });
  }
  await addColumnIfMissing(database, "media_items", "region_group", (table) => {
    // 关键变量：历史节目不执行地区补全，升级后统一留在“其他节目”。
    table.string("region_group", 32).notNullable().defaultTo("other");
  });
  await addIndexIfMissing(
    database,
    "media_items",
    ["service_id", "item_type", "region_group", "deleted_at"],
    "idx_media_items_service_region",
  );

  if (!(await database.schema.hasTable("media_relations"))) {
    await database.schema.createTable("media_relations", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("parent_item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("child_item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("relation_type", 64).notNullable();
      table.integer("sort_order").notNullable().defaultTo(0);
      table.unique(["user_id", "parent_item_id", "child_item_id", "relation_type"], { indexName: "uq_media_relations_pair" });
      table.index(["library_id"], "idx_media_relations_library");
      table.index(["parent_item_id"], "idx_media_relations_parent_item");
      table.index(["child_item_id"], "idx_media_relations_child_item");
    });
  }

  if (!(await database.schema.hasTable("file_links"))) {
    await database.schema.createTable("file_links", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("source_file_id", 64).notNullable().references("id").inTable("source_files").onDelete("CASCADE");
      table.text("locator_json").notNullable();
      table.unique(["user_id", "item_id", "source_file_id"], { indexName: "uq_file_links_item_file" });
      table.unique(["user_id", "library_id", "source_file_id"], { indexName: "uq_file_links_source_owner" });
      table.index(["library_id"], "idx_file_links_library");
      table.index(["item_id"], "idx_file_links_item");
      table.index(["source_file_id"], "idx_file_links_source_file");
    });
  }

  if (!(await database.schema.hasTable("catalog_changes"))) {
    await database.schema.createTable("catalog_changes", (table) => {
      table.increments("id").primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.bigInteger("catalog_version").notNullable();
      table.string("entity_type", 64).notNullable();
      table.string("entity_id", 64).notNullable();
      table.string("change_type", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["user_id", "library_id", "catalog_version"], "idx_catalog_changes_version");
      table.index(["library_id"], "idx_catalog_changes_library");
    });
  }
}

/** 把旧版本同一扫描批次共享的目录版本迁移为逐条单调递增版本。 */
async function migrateCatalogChangeVersions(database: Knex): Promise<void> {
  const libraries = await database("media_libraries").select("id", "catalog_version");
  for (const library of libraries) {
    const changes = await database("catalog_changes")
      .select("id")
      .where({ library_id: library.id })
      .orderBy("id", "asc");
    if (changes.length === 0) {
      continue;
    }
    const previousVersion = Number(library.catalog_version);
    const firstVersion = Math.max(0, previousVersion - changes.length);
    await database.transaction(async (transaction) => {
      for (const [index, change] of changes.entries()) {
        await transaction("catalog_changes").where({ id: change.id }).update({
          catalog_version: firstVersion + index + 1,
        });
      }
      await transaction("media_libraries").where({ id: library.id }).update({
        catalog_version: firstVersion + changes.length,
      });
    });
  }
}

/** 为媒体目录分页、排序和概览统计补充查询索引。 */
async function migrateCatalogQueryIndexes(database: Knex): Promise<void> {
  await database.schema.alterTable("media_items", (table) => {
    table.index(["user_id", "library_id", "deleted_at", "created_at"], "idx_media_items_catalog_created");
    table.index(["user_id", "library_id", "deleted_at", "sort_title"], "idx_media_items_catalog_title");
    table.index(["user_id", "library_id", "deleted_at", "year"], "idx_media_items_catalog_year");
    table.index(["user_id", "deleted_at", "match_state"], "idx_media_items_user_match");
  });
}

/** 从历史元数据 JSON 中读取可排序的电影上映日或节目首播日。 */
function readHistoricalPremiereDate(metadataJson: unknown): string | null {
  try {
    const metadata = JSON.parse(String(metadataJson ?? "{}")) as Record<string, unknown>;
    const rawDate = typeof metadata.releaseDate === "string"
      ? metadata.releaseDate
      : typeof metadata.airDate === "string" ? metadata.airDate : "";
    return /^\d{4}-\d{2}-\d{2}/u.test(rawDate) ? rawDate.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** 为首映日期排序增加独立字段、历史数据回填和复合索引。 */
async function migrateMediaPremiereDate(database: Knex): Promise<void> {
  await addColumnIfMissing(database, "media_items", "premiere_date", (table) => {
    table.string("premiere_date", 40).nullable();
  });
  // 关键变量：只读取顶层已匹配条目，避免把数万单集的播出日期误当成节目首映日期。
  const matchedTopLevelRows = await database("media_items")
    .select("id", "metadata_json")
    .where({ match_state: "matched" })
    .whereIn("item_type", ["video.movie", "video.series"])
    .whereNull("premiere_date");
  await database.transaction(async (transaction) => {
    for (const row of matchedTopLevelRows) {
      const premiereDate = readHistoricalPremiereDate(row.metadata_json);
      if (!premiereDate) continue;
      await transaction("media_items").where({ id: row.id }).update({ premiere_date: premiereDate });
    }
  });
  await database.schema.alterTable("media_items", (table) => {
    table.index(
      ["user_id", "library_id", "deleted_at", "premiere_date"],
      "idx_media_items_catalog_premiere",
    );
  });
}

/** 为按服务清空媒体库补齐过滤和外键级联删除索引，避免 PostgreSQL 逐条全表扫描。 */
async function migrateCatalogDeletionIndexes(database: Knex): Promise<void> {
  await addIndexIfMissing(database, "media_items", ["library_id"], "idx_media_items_library");
  await addIndexIfMissing(database, "media_relations", ["library_id"], "idx_media_relations_library");
  await addIndexIfMissing(database, "media_relations", ["parent_item_id"], "idx_media_relations_parent_item");
  await addIndexIfMissing(database, "media_relations", ["child_item_id"], "idx_media_relations_child_item");
  await addIndexIfMissing(database, "file_links", ["library_id"], "idx_file_links_library");
  await addIndexIfMissing(database, "file_links", ["item_id"], "idx_file_links_item");
  await addIndexIfMissing(database, "file_links", ["source_file_id"], "idx_file_links_source_file");
  await addIndexIfMissing(database, "catalog_changes", ["library_id"], "idx_catalog_changes_library");
}

/** 清理历史重复文件归属，并从数据库层保证一个源文件只能归属一个媒体条目。 */
async function migrateUniqueSourceFileOwnership(database: Knex): Promise<void> {
  const results = await repairDuplicateCatalogFileLinks(database);
  for (const result of results) {
    console.info(JSON.stringify({
      日志关键字: "codex-flycloud-file-link-repair",
      事件: "历史重复文件归属修复完成",
      媒体库ID: result.libraryId,
      重复源文件数量: result.duplicateSourceFileCount,
      删除旧关联数量: result.removedFileLinkCount,
      删除孤立子项数量: result.deletedLeafItemCount,
      删除孤立父项数量: result.deletedParentItemCount,
      最新目录版本: result.catalogVersion,
    }));
  }
  await addUniqueIfMissing(
    database,
    "file_links",
    ["user_id", "library_id", "source_file_id"],
    "uq_file_links_source_owner",
  );
}

/** 创建导出、插件、AI 模型和扩展审计表。 */
async function createOperationTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("user_notifications"))) {
    await database.schema.createTable("user_notifications", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("category", 32).notNullable();
      table.string("tone", 32).notNullable();
      table.string("title", 255).notNullable();
      table.text("message").notNullable();
      table.string("action_path", 500).nullable();
      table.string("created_at", 40).notNullable();
      table.index(["user_id", "created_at"], "idx_user_notifications_user_created");
    });
  }

  if (!(await database.schema.hasTable("system_secret_settings"))) {
    await database.schema.createTable("system_secret_settings", (table) => {
      table.string("setting_key", 100).primary();
      table.text("encrypted_payload").notNullable();
      table.integer("revision").notNullable();
      table.string("updated_by_user_id", 64).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }
  if (!(await database.schema.hasTable("system_settings"))) {
    await database.schema.createTable("system_settings", (table) => {
      table.string("setting_key", 100).primary();
      table.text("setting_value").notNullable();
      table.integer("revision").notNullable().defaultTo(1);
      table.string("updated_by_user_id", 64).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }

  if (!(await database.schema.hasTable("metadata_plugin_versions"))) {
    await database.schema.createTable("metadata_plugin_versions", (table) => {
      table.string("id", 64).primary();
      table.string("plugin_id", 64).notNullable();
      table.string("version", 100).notNullable();
      table.string("display_name", 255).notNullable();
      table.string("status", 32).notNullable();
      table.string("sha256", 64).notNullable();
      table.text("manifest_json").notNullable();
      table.text("installed_path").notNullable();
      table.integer("configuration_revision").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["plugin_id", "version"], { indexName: "uq_metadata_plugin_versions" });
    });
  }

  if (!(await database.schema.hasTable("metadata_plugin_configurations"))) {
    await database.schema.createTable("metadata_plugin_configurations", (table) => {
      table.string("id", 64).primary();
      table.string("plugin_id", 64).notNullable();
      table.string("version", 100).notNullable();
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.text("encrypted_secrets").nullable();
      table.text("configuration_state_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["plugin_id", "version", "revision"], { indexName: "uq_metadata_plugin_configurations" });
    });
  }

  if (!(await database.schema.hasTable("ai_model_profiles"))) {
    await database.schema.createTable("ai_model_profiles", (table) => {
      table.string("id", 64).primary();
      table.string("display_name", 100).notNullable();
      table.string("protocol", 32).notNullable();
      table.string("status", 32).notNullable();
      table.integer("configuration_revision").notNullable().defaultTo(1);
      table.string("last_check_status", 32).notNullable().defaultTo("unknown");
      table.string("last_check_error_code", 100).nullable();
      table.text("last_check_error_message").nullable();
      table.integer("last_check_latency_ms").nullable();
      table.integer("last_check_structured_output").notNullable().defaultTo(0);
      table.string("last_checked_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["status", "updated_at"], "idx_ai_model_profiles_status_updated");
    });
  }

  if (!(await database.schema.hasTable("ai_model_configurations"))) {
    await database.schema.createTable("ai_model_configurations", (table) => {
      table.string("id", 64).primary();
      table.string("model_id", 64).notNullable().references("id").inTable("ai_model_profiles").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.string("base_url", 1000).notNullable();
      table.string("model_name", 255).notNullable();
      table.integer("timeout_ms").notNullable();
      table.integer("max_concurrency").notNullable();
      table.text("encrypted_secrets").nullable();
      table.text("configuration_state_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["model_id", "revision"], { indexName: "uq_ai_model_configurations_revision" });
      table.index(["model_id", "created_at"], "idx_ai_model_configurations_model_created");
    });
  }

  if (!(await database.schema.hasTable("ai_video_name_clean_cache"))) {
    await database.schema.createTable("ai_video_name_clean_cache", (table) => {
      table.string("id", 64).primary();
      table.string("model_id", 64).notNullable().references("id").inTable("ai_model_profiles").onDelete("CASCADE");
      table.integer("model_revision").notNullable();
      table.string("prompt_version", 64).notNullable();
      table.string("cleaner_version", 64).notNullable();
      table.string("input_hash", 64).notNullable();
      table.text("result_json").notNullable();
      table.float("confidence").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("expires_at", 40).notNullable();
      table.unique(
        ["model_id", "model_revision", "prompt_version", "cleaner_version", "input_hash"],
        { indexName: "uq_ai_video_name_clean_cache_input" },
      );
      table.index(["expires_at"], "idx_ai_video_name_clean_cache_expires");
    });
  }

  if (!(await database.schema.hasTable("ai_video_name_clean_usages"))) {
    await database.schema.createTable("ai_video_name_clean_usages", (table) => {
      table.string("id", 64).primary();
      table.string("job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("model_id", 64).notNullable();
      table.integer("model_revision").notNullable();
      table.string("candidate_key", 64).notNullable();
      table.string("media_type", 16).notNullable();
      table.string("trigger_reason", 64).notNullable();
      table.string("rule_title", 300).notNullable();
      table.string("cleaned_title", 200).notNullable();
      table.string("alternate_title", 200).notNullable();
      table.float("confidence").notNullable();
      table.integer("file_count").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["job_id", "candidate_key"], { indexName: "uq_ai_video_name_clean_usages_job_candidate" });
      table.index(["job_id", "created_at"], "idx_ai_video_name_clean_usages_job_created");
    });
  }

  if (!(await database.schema.hasTable("audit_log_entries"))) {
    await database.schema.createTable("audit_log_entries", (table) => {
      table.string("id", 64).primary();
      table.string("operator_user_id", 64).nullable();
      table.string("operator_username", 255).nullable();
      table.string("operation_type", 100).notNullable();
      table.string("target_type", 64).notNullable();
      table.string("target_id", 255).nullable();
      table.string("result", 32).notNullable();
      table.text("detail_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["created_at"], "idx_audit_log_entries_created_at");
      table.index(["operator_user_id"], "idx_audit_log_entries_operator");
    });
  }
}

/** 将旧版服务级 Jellyfin 开关一次性迁移到对应媒体库。 */
async function migrateLibraryJellyfinOwnership(database: Knex): Promise<void> {
  if (!(await database.schema.hasColumn("cloud_services", "jellyfin_enabled"))) return;
  // 关键变量：只迁移旧结构中明确启用的服务，默认关闭的媒体库不需要逐条更新。
  const enabledServices = await database("cloud_services")
    .select("id")
    .where({ jellyfin_enabled: 1 })
    .whereNull("deleted_at");
  const serviceIds = enabledServices.map((service) => String(service.id));
  if (serviceIds.length > 0) {
    await database("media_libraries").whereIn("service_id", serviceIds).update({ jellyfin_enabled: 1 });
  }
}

/** 为已有媒体库生成默认 Jellyfin 地址后缀，并建立全局唯一约束。 */
async function migrateLibraryJellyfinPathSuffix(database: Knex): Promise<void> {
  const libraries = await database("media_libraries")
    .select("service_id", "jellyfin_path_suffix", "jellyfin_path_suffix_lookup");
  for (const library of libraries) {
    // 关键变量：历史媒体库继续使用服务 ID 作为后缀，避免升级时发生地址归属冲突。
    const pathSuffix = String(library.jellyfin_path_suffix ?? "").trim() || String(library.service_id);
    const pathSuffixLookup = String(library.jellyfin_path_suffix_lookup ?? "").trim() || pathSuffix.toLowerCase();
    await database("media_libraries").where({ service_id: library.service_id }).update({
      jellyfin_path_suffix: pathSuffix,
      jellyfin_path_suffix_lookup: pathSuffixLookup,
    });
  }
  await addUniqueIfMissing(database, "media_libraries", ["jellyfin_path_suffix_lookup"], "uq_media_libraries_jellyfin_path_suffix");
}

/** 为已有媒体库生成默认 Navidrome 地址后缀，并建立全局唯一约束。 */
async function migrateLibraryNavidromePathSuffix(database: Knex): Promise<void> {
  const libraries = await database("media_libraries")
    .select("service_id", "navidrome_path_suffix", "navidrome_path_suffix_lookup");
  for (const library of libraries) {
    // 关键变量：升级前的音乐库沿用服务 ID，确保不同服务的 /n/ 地址不会冲突。
    const pathSuffix = String(library.navidrome_path_suffix ?? "").trim() || String(library.service_id);
    const pathSuffixLookup = String(library.navidrome_path_suffix_lookup ?? "").trim() || pathSuffix.toLowerCase();
    await database("media_libraries").where({ service_id: library.service_id }).update({
      navidrome_path_suffix: pathSuffix,
      navidrome_path_suffix_lookup: pathSuffixLookup,
    });
  }
  await addUniqueIfMissing(database, "media_libraries", ["navidrome_path_suffix_lookup"], "uq_media_libraries_navidrome_path_suffix");
}

/** 为已有媒体库补齐 Emby 独立协议配置和全局唯一地址后缀。 */
async function migrateLibraryEmbyProtocol(database: Knex): Promise<void> {
  const libraries = await database("media_libraries")
    .select("service_id", "emby_path_suffix", "emby_path_suffix_lookup");
  for (const library of libraries) {
    // 关键变量：Emby 与 Jellyfin 可使用相同文本后缀，但各自在自己的 URL 前缀下全局唯一。
    const pathSuffix = String(library.emby_path_suffix ?? "").trim() || String(library.service_id);
    const pathSuffixLookup = String(library.emby_path_suffix_lookup ?? "").trim() || pathSuffix.toLowerCase();
    await database("media_libraries").where({ service_id: library.service_id }).update({
      emby_enabled: 0,
      emby_relay_playback_enabled: 0,
      emby_download_enabled: 1,
      emby_region_libraries_enabled: 0,
      emby_path_suffix: pathSuffix,
      emby_path_suffix_lookup: pathSuffixLookup,
    });
  }
  await addUniqueIfMissing(database, "media_libraries", ["emby_path_suffix_lookup"], "uq_media_libraries_emby_path_suffix");
}

/** 将首版 Emby 媒体库的默认播放路线调整为原始播放，用户可在协议配置中再主动开启中转。 */
async function migrateEmbyRelayPlaybackDefault(database: Knex): Promise<void> {
  await database("media_libraries").update({ emby_relay_playback_enabled: 0 });
}

/** 将旧服务级中转开关迁移为媒体库 APP 中转开关，并保留 Jellyfin 原有中转能力。 */
async function migrateLibraryRelayPlaybackSettings(database: Knex): Promise<void> {
  const services = await database("cloud_services")
    .select("id", "relay_playback_enabled", "deleted_at");
  for (const service of services) {
    // 关键变量：APP 中转沿用升级前的服务开关，Jellyfin 中转默认启用以保持升级前行为。
    const serviceDeleted = Boolean(service.deleted_at);
    await database("media_libraries").where({ service_id: service.id }).update({
      app_relay_playback_enabled: !serviceDeleted && Number(service.relay_playback_enabled) === 1 ? 1 : 0,
      jellyfin_relay_playback_enabled: serviceDeleted ? 0 : 1,
    });
  }
}

/** 每台设备只保留一个指向同一云端服务的本地卡片绑定。 */
async function migrateUniqueCloudServiceDeviceBinding(database: Knex): Promise<void> {
  const bindings = await database("client_service_links")
    .select("id", "user_id", "service_id", "client_device_id", "updated_at")
    .orderBy("updated_at", "desc");
  const seen = new Set<string>(); // 关键变量：排序后第一条是需要保留的最新绑定。
  const duplicateIds: string[] = [];
  for (const binding of bindings) {
    const key = `${binding.user_id}:${binding.service_id}:${binding.client_device_id}`;
    if (seen.has(key)) duplicateIds.push(String(binding.id));
    else seen.add(key);
  }
  if (duplicateIds.length > 0) await database("client_service_links").whereIn("id", duplicateIds).delete();
  await addUniqueIfMissing(
    database,
    "client_service_links",
    ["user_id", "service_id", "client_device_id"],
    "uq_client_service_links_cloud_device",
  );
}

/** 升级时彻底清理旧版已经软删除的服务及其专属媒体库数据。 */
async function purgeDeletedServicesV55(database: Knex, exportDirectory: string): Promise<void> {
  const deletedServices = await database("cloud_services").select("*").whereNotNull("deleted_at");
  if (deletedServices.length === 0) return;

  // 关键变量：旧版从 cloud_services.library_id 定位媒体库；中断后重试则可能已经存在 library_sources。
  const hasLegacyLibraryId = await database.schema.hasColumn("cloud_services", "library_id");
  const hasLegacyServiceId = await database.schema.hasColumn("media_libraries", "service_id");
  const cleanupTables = [
    "library_exports", "scan_jobs", "media_probe_jobs", "file_links", "media_relations",
    "catalog_changes", "nfo_sidecar_cache", "audio_file_tags", "media_file_probes",
    "source_files", "media_items", "library_sources",
  ];
  const existingTables = new Set<string>();
  for (const tableName of cleanupTables) {
    if (await database.schema.hasTable(tableName)) existingTables.add(tableName);
  }

  const purgedServices: Array<{ serviceId: string; userId: string; libraryId: string }> = [];
  await database.transaction(async (transaction) => {
    for (const service of deletedServices) {
      const serviceId = String(service.id);
      const userId = String(service.user_id);
      const legacyLibraryId = hasLegacyLibraryId ? String(service.library_id ?? "") : "";
      const sources = existingTables.has("library_sources")
        ? await transaction("library_sources").select("library_id").where({ service_id: serviceId })
        : [];
      const sourceLibraryIds = sources.map((source) => String(source.library_id));
      const libraryIds = new Set<string>([legacyLibraryId, ...sourceLibraryIds].filter(Boolean));
      if (libraryIds.size > 1) {
        console.error(`[codex-media-library-deleted-service-purge] 阶段=校验归属 结果=失败 服务ID=${serviceId} 原因=多个媒体库`);
        throw new Error("Schema 55 升级停止：已删除服务关联了多个媒体库");
      }
      const libraryId = [...libraryIds][0] ?? "";
      if (libraryId) {
        if (hasLegacyLibraryId) {
          const otherLegacyService = await transaction("cloud_services")
            .where({ library_id: libraryId }).whereNot({ id: serviceId }).first();
          if (otherLegacyService) {
            console.error(`[codex-media-library-deleted-service-purge] 阶段=校验归属 结果=失败 服务ID=${serviceId} 媒体库ID=${libraryId} 原因=媒体库仍被其他服务引用`);
            throw new Error("Schema 55 升级停止：已删除服务的媒体库仍被其他服务引用");
          }
        }
        const library = await transaction("media_libraries").where({ id: libraryId }).first();
        if (library && (String(library.user_id) !== userId
          || (hasLegacyServiceId && String(library.service_id) !== serviceId))) {
          console.error(`[codex-media-library-deleted-service-purge] 阶段=校验归属 结果=失败 服务ID=${serviceId} 媒体库ID=${libraryId} 原因=旧关系不一致`);
          throw new Error("Schema 55 升级停止：已删除服务与媒体库归属不一致");
        }
        if (existingTables.has("library_sources")) {
          const otherSource = await transaction("library_sources")
            .where({ library_id: libraryId }).whereNot({ service_id: serviceId }).first();
          if (otherSource) {
            console.error(`[codex-media-library-deleted-service-purge] 阶段=校验归属 结果=失败 服务ID=${serviceId} 媒体库ID=${libraryId} 原因=媒体库仍有其他来源`);
            throw new Error("Schema 55 升级停止：已删除服务的媒体库仍有其他来源");
          }
        }

        // 先删除任务和目录，再删除来源关系，避免新结构中的 library_source_id 外键阻止清理。
        for (const tableName of cleanupTables) {
          if (existingTables.has(tableName)) {
            await transaction(tableName).where({ library_id: libraryId }).delete();
          }
        }
        await transaction("media_libraries").where({ id: libraryId }).delete();
      }
      // 历史上允许只剩软删除服务；其凭据、配置和协议账号由服务外键级联清理。
      await transaction("cloud_services").where({ id: serviceId, user_id: userId }).delete();
      purgedServices.push({ serviceId, userId, libraryId });
    }
  });
  const exportRoot = path.resolve(exportDirectory);
  for (const purged of purgedServices) {
    if (purged.libraryId) {
      // 关键变量：只清理当前导出根目录内、由用户和媒体库 ID 构成的专属快照目录。
      const libraryExportDirectory = path.resolve(exportRoot, purged.userId, purged.libraryId);
      const relativeExportDirectory = path.relative(exportRoot, libraryExportDirectory);
      const validDirectoryIds = /^[A-Za-z0-9_-]+$/u.test(purged.userId)
        && /^[A-Za-z0-9_-]+$/u.test(purged.libraryId);
      if (!validDirectoryIds || relativeExportDirectory !== path.join(purged.userId, purged.libraryId)) {
        console.warn(`[codex-media-library-deleted-service-purge] 阶段=清理快照文件 结果=跳过 服务ID=${purged.serviceId} 媒体库ID=${purged.libraryId} 原因=路径不在导出目录内`);
      } else {
        try {
          await fs.rm(libraryExportDirectory, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[codex-media-library-deleted-service-purge] 阶段=清理快照文件 结果=失败 服务ID=${purged.serviceId} 媒体库ID=${purged.libraryId} 错误=${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
    }
    console.info(`[codex-media-library-deleted-service-purge] 阶段=清理历史软删除服务 结果=成功 服务ID=${purged.serviceId} 媒体库ID=${purged.libraryId || "无"}`);
  }
}

/** 将旧的一对一双向外键关系迁移为独立媒体库来源关系。 */
async function migrateServiceLibraryOwnershipV55(database: Knex): Promise<void> {
  const hasLegacyServiceLibraryId = await database.schema.hasColumn("cloud_services", "library_id");
  const hasLegacyLibraryServiceId = await database.schema.hasColumn("media_libraries", "service_id");
  if (!hasLegacyServiceLibraryId || !hasLegacyLibraryServiceId) return;

  const now = new Date().toISOString();
  const services = await database("cloud_services")
    .select(
      "id",
      "user_id",
      "library_id",
      "display_name",
      "provider_type",
      "connection_status",
      "credential_revision",
      "data_type",
      "notification_enabled",
      "scan_profile_revision",
      "metadata_profile_revision",
      "last_scan_at",
    )
    .whereNull("deleted_at");
  const libraries = await database("media_libraries").select("id", "user_id", "service_id");
  const libraryById = new Map(libraries.map((library) => [String(library.id), library]));
  const serviceById = new Map(services.map((service) => [String(service.id), service]));

  // 关键变量：软删除服务已提前清理，剩余关系不一致时仍停止升级，避免迁错目录或协议账号。
  const invalidRelations: string[] = [];
  for (const service of services) {
    const libraryId = String(service.library_id ?? "");
    const library = libraryById.get(libraryId);
    if (!library || String(library.service_id ?? "") !== String(service.id) || String(library.user_id) !== String(service.user_id)) {
      invalidRelations.push(`服务ID=${String(service.id)},媒体库ID=${libraryId || "空"}`);
    }
  }
  for (const library of libraries) {
    const serviceId = String(library.service_id ?? "");
    const service = serviceById.get(serviceId);
    if (!service || String(service.library_id ?? "") !== String(library.id) || String(service.user_id) !== String(library.user_id)) {
      invalidRelations.push(`服务ID=${serviceId || "空"},媒体库ID=${String(library.id)}`);
    }
  }
  if (invalidRelations.length > 0) {
    console.error("[codex-media-library-ownership-migration] 阶段=校验旧关系 结果=失败 异常关系="
      + invalidRelations.slice(0, 20).join(";"));
    throw new Error("Schema 55 升级停止：服务与媒体库旧关系不一致，请先修正日志中列出的数据");
  }

  await database.transaction(async (transaction) => {
    for (const service of services) {
      const serviceId = String(service.id);
      const libraryId = String(service.library_id);
      await transaction("media_libraries").where({ id: libraryId, user_id: service.user_id }).update({
        display_name: String(service.display_name),
        data_type: String(service.data_type ?? "video"),
        notification_enabled: Number(service.notification_enabled ?? 0),
        scan_profile_revision: Number(service.scan_profile_revision ?? 1),
        metadata_profile_revision: Number(service.metadata_profile_revision ?? 1),
        last_scan_at: service.last_scan_at ?? null,
        updated_at: now,
      });
      const existingSource = await transaction("library_sources").where({
        user_id: service.user_id,
        service_id: serviceId,
      }).first();
      if (!existingSource) {
        await transaction("library_sources").insert({
          id: randomUUID(),
          user_id: service.user_id,
          library_id: libraryId,
          service_id: serviceId,
          source_mode: "linked_service",
          display_name: String(service.display_name),
          provider_type: String(service.provider_type),
          connection_status: String(service.connection_status),
          credential_revision: Number(service.credential_revision),
          // 关键变量：旧版来源仍然引用原网盘服务，不复制独立连接配置。
          configuration_json: "{}",
          status: "active",
          sort_order: 0,
          last_scan_at: service.last_scan_at ?? null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    if (await transaction.schema.hasTable("service_scan_profiles")) {
      const rows = await transaction("service_scan_profiles").select("*");
      for (const row of rows) {
        const service = serviceById.get(String(row.service_id));
        if (!service) continue;
        const exists = await transaction("library_scan_profiles").where({
          user_id: row.user_id,
          library_id: service.library_id,
          revision: row.revision,
        }).first();
        if (!exists) {
          await transaction("library_scan_profiles").insert({
            id: row.id,
            user_id: row.user_id,
            library_id: service.library_id,
            revision: row.revision,
            configuration_json: row.configuration_json,
            created_at: row.created_at,
          });
        }
      }
    }
    if (await transaction.schema.hasTable("service_metadata_profiles")) {
      const rows = await transaction("service_metadata_profiles").select("*");
      for (const row of rows) {
        const service = serviceById.get(String(row.service_id));
        if (!service) continue;
        const exists = await transaction("library_metadata_profiles").where({
          user_id: row.user_id,
          library_id: service.library_id,
          revision: row.revision,
        }).first();
        if (!exists) {
          await transaction("library_metadata_profiles").insert({
            id: row.id,
            user_id: row.user_id,
            library_id: service.library_id,
            revision: row.revision,
            configuration_json: row.configuration_json,
            created_at: row.created_at,
          });
        }
      }
    }
  });

  console.info(`[codex-media-library-ownership-migration] 阶段=建立来源关系 结果=成功 服务数量=${services.length} 媒体库数量=${libraries.length}`);
}

/** 删除已经取消的 APP 双向同步、迁入和迁回持久化表。 */
async function dropRemovedAppSyncTables(database: Knex): Promise<void> {
  const removedTables = [
    "service_migration_chunks",
    "service_migrations",
    "service_transfer_outs",
    "client_service_links",
  ];
  for (const tableName of removedTables) {
    if (await database.schema.hasTable(tableName)) await database.schema.dropTable(tableName);
  }
}

/** 删除已经由媒体库和来源关系替代的旧服务交叉字段与配置表。 */
async function dropLegacyServiceLibraryColumns(database: Knex): Promise<void> {
  const serviceColumns = [
    "library_id",
    "data_type",
    "relay_playback_enabled",
    "notification_enabled",
    "scan_profile_revision",
    "metadata_profile_revision",
    "last_scan_at",
  ];
  for (const columnName of serviceColumns) {
    if (await database.schema.hasColumn("cloud_services", columnName)) {
      await database.schema.alterTable("cloud_services", (table) => table.dropColumn(columnName));
    }
  }
  const libraryColumns = ["service_id", "provider_type", "app_relay_playback_enabled"];
  for (const columnName of libraryColumns) {
    if (await database.schema.hasColumn("media_libraries", columnName)) {
      await database.schema.alterTable("media_libraries", (table) => table.dropColumn(columnName));
    }
  }
  for (const tableName of ["service_scan_profiles", "service_metadata_profiles"]) {
    if (await database.schema.hasTable(tableName)) await database.schema.dropTable(tableName);
  }
}

/** 为升级前的任务和文件补齐稳定来源 ID。 */
async function backfillLibrarySourceOwnership(database: Knex): Promise<void> {
  const sources = await database("library_sources").select("id", "library_id", "service_id");
  for (const source of sources) {
    await database("scan_jobs")
      .where({ library_id: source.library_id, service_id: source.service_id })
      .whereNull("library_source_id")
      .update({ library_source_id: source.id });
    await database("source_files")
      .where({ library_id: source.library_id, service_id: source.service_id })
      .whereNull("library_source_id")
      .update({ library_source_id: source.id });
    if (await database.schema.hasColumn("scan_job_checkpoints", "library_source_id")) {
      await database("scan_job_checkpoints")
        .where({ library_id: source.library_id, service_id: source.service_id })
        .whereNull("library_source_id")
        .update({ library_source_id: source.id });
    }
    if (await database.schema.hasColumn("scan_root_runs", "library_source_id")) {
      await database("scan_root_runs")
        .where({ library_id: source.library_id, service_id: source.service_id })
        .whereNull("library_source_id")
        .update({ library_source_id: source.id });
    }
    for (const tableName of ["nfo_sidecar_cache", "media_probe_jobs", "media_file_probes"]) {
      if (!(await database.schema.hasColumn(tableName, "library_source_id"))) continue;
      await database(tableName)
        .where({ library_id: source.library_id, service_id: source.service_id })
        .whereNull("library_source_id")
        .update({ library_source_id: source.id });
    }
  }
}

/** 把 Schema 55 的服务引用来源升级为同时支持媒体库自有复制来源。 */
async function migrateCloudAggregateV56(database: Knex): Promise<void> {
  const now = new Date().toISOString();
  await database("media_libraries")
    .whereNull("library_kind")
    .update({ library_kind: "legacy_single_source", singleton_key: null, updated_at: now });

  const linkedSources = await database("library_sources as ls")
    .join("cloud_services as s", "s.id", "ls.service_id")
    .select(
      "ls.id",
      "s.display_name",
      "s.provider_type",
      "s.connection_status",
      "s.credential_revision",
    );
  for (const source of linkedSources) {
    await database("library_sources").where({ id: source.id }).update({
      source_mode: "linked_service",
      display_name: String(source.display_name),
      provider_type: String(source.provider_type),
      connection_status: String(source.connection_status),
      credential_revision: Number(source.credential_revision),
      configuration_json: "{}",
      updated_at: now,
    });
  }

  await addUniqueIfMissing(
    database,
    "media_libraries",
    ["user_id", "singleton_key"],
    "uq_media_libraries_singleton",
  );
  await dropUniqueIfExists(
    database,
    "source_files",
    ["user_id", "library_id", "provider_resource_id"],
    "uq_source_files_resource",
  );
  await addUniqueIfMissing(
    database,
    "source_files",
    ["user_id", "library_id", "library_source_id", "provider_resource_id"],
    "uq_source_files_source_resource",
  );
  await dropUniqueIfExists(
    database,
    "nfo_sidecar_cache",
    ["user_id", "library_id", "provider_resource_id"],
    "uq_nfo_sidecar_cache_resource",
  );
  await addUniqueIfMissing(
    database,
    "nfo_sidecar_cache",
    ["user_id", "library_id", "library_source_id", "provider_resource_id"],
    "uq_nfo_sidecar_cache_source_resource",
  );
  await addIndexIfMissing(database, "scan_jobs", ["parent_job_id", "status"], "idx_scan_jobs_parent_status");
  await addIndexIfMissing(database, "scan_jobs", ["library_source_id", "status"], "idx_scan_jobs_source_status");

  // 关键字段：owned_copy 来源不再指向原 cloud_services，任务同样只依赖 library_source_id。
  await database.schema.alterTable("library_sources", (table) => {
    table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("RESTRICT").alter();
  });
  await database.schema.alterTable("scan_jobs", (table) => {
    table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE").alter();
  });
  await database.schema.alterTable("nfo_sidecar_cache", (table) => {
    table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE").alter();
  });
  await database.schema.alterTable("media_probe_jobs", (table) => {
    table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("CASCADE").alter();
  });

  console.info(JSON.stringify({
    日志关键字: "codex-library-source-config",
    事件: "Schema56云聚合来源结构升级完成",
    旧来源回填数量: linkedSources.length,
  }));
}

/** 修复已升级到 Schema 56 的 PostgreSQL 仍保留 service_id 非空约束，允许聚合库来源独立于网盘服务。 */
async function migrateCloudAggregateSourceNullableV57(database: Knex): Promise<void> {
  if (database.client.config.client === "pg") {
    await database.raw("ALTER TABLE library_sources ALTER COLUMN service_id DROP NOT NULL");
  } else {
    await database.schema.alterTable("library_sources", (table) => {
      table.string("service_id", 64).nullable().references("id").inTable("cloud_services").onDelete("RESTRICT").alter();
    });
  }
  console.info(JSON.stringify({
    日志关键字: "codex-library-source-config",
    事件: "Schema57放宽聚合来源服务ID非空约束",
  }));
}

/** 让云聚合来源与单媒体库共同引用独立网盘服务的统一连接状态和凭据。 */
async function migrateCloudAggregateServiceLinksV58(database: Knex): Promise<void> {
  await dropUniqueIfExists(
    database,
    "library_sources",
    ["user_id", "service_id"],
    "uq_library_sources_service",
  );
  await addUniqueIfMissing(
    database,
    "library_sources",
    ["library_id", "service_id"],
    "uq_library_sources_library_service",
  );
  const copiedSources = await database("library_sources")
    .select("id", "user_id", "library_id", "provider_type", "status", "configuration_json")
    .where({ source_mode: "owned_copy" });
  let linkedSourceCount = 0;
  let duplicateSourceCount = 0;
  const now = new Date().toISOString();
  await database.transaction(async (transaction) => {
    for (const source of copiedSources) {
      let configuration: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(source.configuration_json ?? "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) configuration = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const templateServiceId = typeof configuration.templateServiceId === "string"
        ? configuration.templateServiceId.trim()
        : "";
      if (!templateServiceId) continue;
      const service = await transaction("cloud_services")
        .where({
          id: templateServiceId,
          user_id: source.user_id,
          provider_type: source.provider_type,
        })
        .whereNull("deleted_at")
        .first();
      if (!service) continue;
      // 关键变量：Schema 56/57 允许同一模板服务被重复复制；不能为迁移强行合并或删除已有媒体数据。
      const existingLinkedSource = await transaction("library_sources")
        .where({ library_id: source.library_id, service_id: templateServiceId })
        .whereNot("id", source.id)
        .whereNot("status", "deleted")
        .first();
      if (existingLinkedSource) {
        duplicateSourceCount += 1;
        continue;
      }
      await transaction("library_sources").where({ id: source.id, user_id: source.user_id }).update({
        service_id: templateServiceId,
        source_mode: "linked_service",
        connection_status: String(service.connection_status),
        credential_revision: Number(service.credential_revision),
        status: String(source.status) === "disabled" ? "disabled" : "active",
        updated_at: now,
      });
      // 关键变量：旧聚合任务和文件原先没有 service_id，补齐后鉴权异常与恢复才能跟随同一网盘服务。
      for (const tableName of [
        "scan_jobs", "source_files", "scan_job_checkpoints", "scan_root_runs",
        "nfo_sidecar_cache", "media_probe_jobs", "media_file_probes",
      ]) {
        if (!(await transaction.schema.hasColumn(tableName, "service_id"))
          || !(await transaction.schema.hasColumn(tableName, "library_source_id"))) continue;
        await transaction(tableName)
          .where({ library_source_id: source.id })
          .whereNull("service_id")
          .update({ service_id: templateServiceId });
      }
      await transaction("library_source_credentials").where({ library_source_id: source.id }).delete();
      linkedSourceCount += 1;
    }
  });
  console.info(JSON.stringify({
    日志关键字: "codex-library-source-service-link",
    事件: "Schema58统一聚合来源服务连接",
    待处理来源数量: copiedSources.length,
    已关联服务来源数量: linkedSourceCount,
    重复来源保留兼容数量: duplicateSourceCount,
  }));
}

/**
 * 补建多来源文件写入依赖的唯一约束。
 * Schema 56 若把 PostgreSQL 的 23505 数据冲突误判为索引已存在，会在 Schema 58 留下缺失约束。
 */
async function migrateCloudAggregateSourceUniqueConstraintsV59(database: Knex): Promise<void> {
  let removedSourceFileCount = 0;
  let removedNfoCacheCount = 0;
  await database.transaction(async (transaction) => {
    /** 删除同一来源资源的历史重复副本，保留最近更新的一条供后续扫描继续覆盖。 */
    const removeDuplicateRows = async (tableName: "source_files" | "nfo_sidecar_cache"): Promise<number> => {
      const keyColumns = ["user_id", "library_id", "library_source_id", "provider_resource_id"];
      const duplicateGroups = await transaction(tableName)
        .select(keyColumns)
        .whereNotNull("library_source_id")
        .groupBy(keyColumns)
        .havingRaw("count(*) > 1");
      let removedCount = 0;
      for (const group of duplicateGroups) {
        const rows = await transaction(tableName)
          .select("id")
          .where({
            user_id: group.user_id,
            library_id: group.library_id,
            library_source_id: group.library_source_id,
            provider_resource_id: group.provider_resource_id,
          })
          .orderBy("updated_at", "desc")
          .orderBy("created_at", "desc");
        const duplicateIds = rows.slice(1).map((row) => String(row.id)); // 关键变量：第一条是保留的最新资源记录。
        if (duplicateIds.length === 0) continue;
        await transaction(tableName).whereIn("id", duplicateIds).delete();
        removedCount += duplicateIds.length;
      }
      return removedCount;
    };

    removedSourceFileCount = await removeDuplicateRows("source_files");
    removedNfoCacheCount = await removeDuplicateRows("nfo_sidecar_cache");
  });
  await addUniqueIfMissing(
    database,
    "source_files",
    ["user_id", "library_id", "library_source_id", "provider_resource_id"],
    "uq_source_files_source_resource",
  );
  await addUniqueIfMissing(
    database,
    "nfo_sidecar_cache",
    ["user_id", "library_id", "library_source_id", "provider_resource_id"],
    "uq_nfo_sidecar_cache_source_resource",
  );
  console.info(JSON.stringify({
    日志关键字: "codex-library-source-unique-index",
    事件: "Schema59补建云聚合来源文件唯一约束",
    清理重复源文件数量: removedSourceFileCount,
    清理重复NFO缓存数量: removedNfoCacheCount,
    源文件约束: "user_id+library_id+library_source_id+provider_resource_id",
    NFO缓存约束: "user_id+library_id+library_source_id+provider_resource_id",
  }));
}

/** 将旧服务级协议账号、会话和播放状态迁移到媒体库作用域。 */
async function migrateProtocolOwnershipToLibraries(database: Knex): Promise<void> {
  const sourceRows = await database("library_sources").select("service_id", "library_id");
  const libraryByServiceId = new Map(sourceRows.map((row) => [String(row.service_id), String(row.library_id)]));
  const tableMappings: Array<{ legacy: string; current: string; hasServiceId: boolean }> = [
    { legacy: "service_access_accounts", current: "library_access_accounts", hasServiceId: true },
    { legacy: "service_protocol_sessions", current: "library_protocol_sessions", hasServiceId: true },
    { legacy: "service_playback_progress", current: "library_playback_progress", hasServiceId: true },
    { legacy: "service_playback_sessions", current: "library_playback_sessions", hasServiceId: true },
    { legacy: "service_playback_history", current: "library_playback_history", hasServiceId: true },
    { legacy: "service_item_preferences", current: "library_item_preferences", hasServiceId: true },
    { legacy: "service_jellyfin_virtual_preferences", current: "library_jellyfin_virtual_preferences", hasServiceId: true },
    { legacy: "service_music_playlists", current: "library_music_playlists", hasServiceId: true },
    { legacy: "service_music_playlist_items", current: "library_music_playlist_items", hasServiceId: false },
    { legacy: "service_emby_accounts", current: "library_emby_accounts", hasServiceId: true },
    { legacy: "service_emby_sessions", current: "library_emby_sessions", hasServiceId: true },
    { legacy: "service_emby_playback_progress", current: "library_emby_playback_progress", hasServiceId: true },
    { legacy: "service_emby_playback_sessions", current: "library_emby_playback_sessions", hasServiceId: true },
    { legacy: "service_emby_playback_history", current: "library_emby_playback_history", hasServiceId: true },
    { legacy: "service_emby_item_preferences", current: "library_emby_item_preferences", hasServiceId: true },
    { legacy: "service_emby_virtual_preferences", current: "library_emby_virtual_preferences", hasServiceId: true },
  ];
  let migratedRows = 0; // 关键变量：记录本次真正迁入新媒体库表的数据量，便于正式环境核对。
  for (const mapping of tableMappings) {
    if (!(await database.schema.hasTable(mapping.legacy))) continue;
    const rows = await database(mapping.legacy).select("*");
    for (const row of rows) {
      const values: Record<string, unknown> = { ...row };
      if (mapping.legacy === "service_playback_progress") {
        // 旧版总时长字段已由媒体规格提供，新表不再存储；保留其余观看进度字段。
        delete values.duration_ticks;
      }
      if (mapping.hasServiceId) {
        const libraryId = libraryByServiceId.get(String(row.service_id));
        if (!libraryId) {
          console.error(`[codex-protocol-library-migration] 阶段=迁移协议数据 结果=失败 旧表=${mapping.legacy} 服务ID=${String(row.service_id)} 原因=缺少媒体库来源关系`);
          throw new Error("Schema 55 升级停止：协议数据找不到对应媒体库");
        }
        delete values.service_id;
        values.library_id = libraryId;
      }
      const inserted = await database(mapping.current).insert(values).onConflict("id").ignore();
      if (inserted !== undefined) migratedRows += 1;
    }
    if (mapping.legacy === "service_playback_progress" && rows.length > 0) {
      console.info(`[codex-protocol-library-migration] 阶段=迁移观看进度 结果=成功 记录数=${rows.length} 略过旧字段=duration_ticks`);
    }
  }
  // 关键变量：按外键依赖倒序删除旧表，升级完成后不保留两套协议状态。
  for (const mapping of [...tableMappings].reverse()) {
    if (await database.schema.hasTable(mapping.legacy)) await database.schema.dropTable(mapping.legacy);
  }
  if (migratedRows > 0) {
    console.info(`[codex-protocol-library-migration] 阶段=迁移协议数据 结果=成功 数据行数=${migratedRows}`);
  }
}

/** 创建或升级 FlyCloudHelper 全部后台表。 */
export async function migrateDatabase(database: Knex, exportDirectory: string): Promise<void> {
  // 关键变量：只有升级旧结构时才可能存在首期的一库一来源唯一约束。
  const hadLibrarySourcesTable = await database.schema.hasTable("library_sources");
  await createIdentityTables(database);
  await createServiceTables(database);
  if (hadLibrarySourcesTable) await dropLegacyLibrarySingleSourceUnique(database);
  await purgeDeletedServicesV55(database, exportDirectory);
  await migrateServiceLibraryOwnershipV55(database);
  await createCatalogTables(database);
  await backfillLibrarySourceOwnership(database);
  await createPlaybackTables(database);
  await createEmbyProtocolTables(database);
  await migrateProtocolOwnershipToLibraries(database);
  await createOperationTables(database);
  await createMusicScanTables(database);

  const now = new Date().toISOString();
  const existingState = await database("system_state").where({ singleton_id: 1 }).first();
  if (!existingState) {
    await dropRemovedAppSyncTables(database);
    await dropLegacyServiceLibraryColumns(database);
    await database("system_state").insert({
      singleton_id: 1,
      service_instance_id: randomUUID(),
      initial_setup_completed_at: null,
      credential_key_fingerprint: null,
      credential_key_source: null,
      credential_key_backup_required: 0,
      schema_version: currentSchemaVersion,
      created_at: now,
      updated_at: now,
    });
  } else {
    if (Number(existingState.schema_version ?? 0) < 5) {
      await migrateCatalogChangeVersions(database);
    }
    if (Number(existingState.schema_version ?? 0) < 8) {
      await migrateCatalogQueryIndexes(database);
    }
    if (Number(existingState.schema_version ?? 0) < 11) {
      await migrateMediaPremiereDate(database);
    }
    if (Number(existingState.schema_version ?? 0) < 16) {
      await migrateCatalogDeletionIndexes(database);
    }
    if (Number(existingState.schema_version ?? 0) < 20) {
      await migrateUniqueSourceFileOwnership(database);
    }
    if (Number(existingState.schema_version ?? 0) < 29) {
      await migrateLibraryJellyfinOwnership(database);
    }
    if (Number(existingState.schema_version ?? 0) < 30) {
      await migrateLibraryJellyfinPathSuffix(database);
    }
    if (Number(existingState.schema_version ?? 0) < 31) {
      await migrateLibraryRelayPlaybackSettings(database);
    }
    if (Number(existingState.schema_version ?? 0) < 32) {
      await migrateUniqueCloudServiceDeviceBinding(database);
    }
    if (Number(existingState.schema_version ?? 0) < 44) {
      await migrateLibraryNavidromePathSuffix(database);
    }
    if (Number(existingState.schema_version ?? 0) < 47) {
      await migrateLibraryEmbyProtocol(database);
    }
    if (Number(existingState.schema_version ?? 0) < 48) {
      await migrateEmbyRelayPlaybackDefault(database);
    }
    if (Number(existingState.schema_version ?? 0) < 54) {
      await dropRemovedAggregateServiceTables(database);
    }
    if (Number(existingState.schema_version ?? 0) < 56) {
      await migrateCloudAggregateV56(database);
    }
    if (Number(existingState.schema_version ?? 0) < 57) {
      await migrateCloudAggregateSourceNullableV57(database);
    }
    if (Number(existingState.schema_version ?? 0) < 58) {
      await migrateCloudAggregateServiceLinksV58(database);
    }
    if (Number(existingState.schema_version ?? 0) < 59) {
      await migrateCloudAggregateSourceUniqueConstraintsV59(database);
    }
    await dropRemovedAppSyncTables(database);
    await dropLegacyServiceLibraryColumns(database);
    await database("system_state").where({ singleton_id: 1 }).update({
      service_instance_id: existingState.service_instance_id || randomUUID(),
      schema_version: currentSchemaVersion,
      updated_at: now,
    });
  }
}
