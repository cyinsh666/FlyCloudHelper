import type { FlyCloudHelperDatabase } from "../database.js";

/** 放宽历史媒体条目的网盘服务引用，在线内容保留真实的空引用，不创建虚假服务。 */
async function allowOnlineMediaItems(database: FlyCloudHelperDatabase): Promise<void> {
  // 关键变量：新建表已经允许为空，仅升级仍带 NOT NULL 约束的历史列。
  const serviceIdColumn = await database.query("media_items").columnInfo("service_id");
  if (serviceIdColumn.nullable !== false) return;
  await database.query.schema.alterTable("media_items", (table) => {
    // Knex 根据数据库只调整空值约束，并保留原列类型、外键、索引和已有数据。
    table.setNullable("service_id");
  });
}

/** 创建内容源独立表；不改变已有网盘文件表和媒体库协议表。 */
export async function initializeContentSourceSchema(database: FlyCloudHelperDatabase): Promise<void> {
  await allowOnlineMediaItems(database);
  // 每次访问都使用新的 Knex schema builder，避免重放前一次 createTable 操作。
  if (!(await database.query.schema.hasTable("content_source_plugins"))) {
    await database.query.schema.createTable("content_source_plugins", (table) => {
      table.string("plugin_id", 128).notNullable();
      table.string("version", 64).notNullable();
      table.text("manifest_json").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.primary(["plugin_id", "version"]);
    });
  }
  if (!(await database.query.schema.hasTable("content_source_instances"))) {
    await database.query.schema.createTable("content_source_instances", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("plugin_id", 128).notNullable();
      table.string("plugin_version", 64).notNullable();
      table.string("display_name", 255).notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id", "status"], "idx_content_instances_owner");
    });
  }
  if (!(await database.query.schema.hasTable("content_source_libraries"))) {
    await database.query.schema.createTable("content_source_libraries", (table) => {
      table.string("library_id", 64).primary().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("instance_id", 64).notNullable().references("id").inTable("content_source_instances").onDelete("RESTRICT");
      table.string("library_source_id", 64).notNullable().references("id").inTable("library_sources").onDelete("CASCADE");
      table.text("configuration_json").notNullable();
      table.text("sync_json").notNullable();
      table.string("sync_status", 32).notNullable().defaultTo("idle");
      table.string("updated_at", 40).notNullable();
      table.unique(["instance_id"], { indexName: "uq_content_library_instance" });
    });
  }
  if (!(await database.query.schema.hasTable("content_playback_sources"))) {
    await database.query.schema.createTable("content_playback_sources", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("instance_id", 64).notNullable().references("id").inTable("content_source_instances").onDelete("RESTRICT");
      table.string("remote_item_id", 128).notNullable();
      table.string("line_key", 128).notNullable();
      table.text("line_name").notNullable();
      table.string("episode_key", 128).notNullable();
      table.text("name").notNullable();
      table.string("container", 16).notNullable();
      table.bigInteger("runtime_ticks").notNullable().defaultTo(0);
      table.integer("sort_order").notNullable().defaultTo(0);
      table.string("status", 32).notNullable().defaultTo("active");
      table.string("generation_id", 64).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["library_id", "remote_item_id", "line_key", "episode_key"], { indexName: "uq_content_playback_locator" });
      table.index(["item_id", "status", "sort_order"], "idx_content_playback_item");
    });
  }
}
