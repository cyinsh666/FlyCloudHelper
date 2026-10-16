import type { Knex } from "knex";

/** 创建 ABS 独立协议表；由主数据库升级流程调用，兼容 SQLite、PostgreSQL 和 MySQL。 */
export async function initializeAbsSchema(query: Knex): Promise<void> {
  const columns: Array<[string, (table: Knex.AlterTableBuilder) => void]> = [
    [
      "abs_enabled",
      (table) => {
        table.integer("abs_enabled").notNullable().defaultTo(0);
      },
    ],
    [
      "abs_path_suffix",
      (table) => {
        table.string("abs_path_suffix", 255).nullable();
      },
    ],
    [
      "abs_path_suffix_lookup",
      (table) => {
        table.string("abs_path_suffix_lookup", 255).nullable();
      },
    ],
    [
      "abs_relay_playback_enabled",
      (table) => {
        table.integer("abs_relay_playback_enabled").notNullable().defaultTo(1);
      },
    ],
  ];
  for (const [name, create] of columns)
    if (!(await query.schema.hasColumn("media_libraries", name)))
      await query.schema.alterTable("media_libraries", create);
  const missingPaths = await query("media_libraries").select("id").whereNull("abs_path_suffix_lookup");
  for (const row of missingPaths)
    await query("media_libraries")
      .where({ id: row.id })
      .update({ abs_path_suffix: String(row.id), abs_path_suffix_lookup: String(row.id).toLowerCase() });
  // 唯一索引跟随专用标记，避免重复启动在各数据库上反复建索引。
  const marker = "abs_schema_initialized_v1";
  if (!(await query("system_settings").where({ setting_key: marker }).first())) {
    try {
      await query.schema.alterTable("media_libraries", (table) => {
        table.unique(["abs_path_suffix_lookup"], { indexName: "uq_libraries_abs_path" });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/already exists|duplicate key name|already an object/iu.test(message)) throw error;
    }
  }
  if (!(await query.schema.hasTable("library_abs_accounts")))
    await query.schema.createTable("library_abs_accounts", (table) => {
      table.string("id", 64).primary();
      table
        .string("library_id", 64)
        .notNullable()
        .references("id")
        .inTable("media_libraries")
        .onDelete("CASCADE");
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable();
      table.text("password_hash").notNullable();
      table.integer("password_required").notNullable().defaultTo(1);
      table.integer("credential_revision").notNullable().defaultTo(1);
      table.string("status", 20).notNullable().defaultTo("active");
      table.integer("can_download").notNullable().defaultTo(1);
      table.bigInteger("created_at").notNullable();
      table.bigInteger("updated_at").notNullable();
      table.unique(["library_id", "username_lookup"], { indexName: "uq_abs_account_username" });
    });
  if (!(await query.schema.hasTable("library_abs_auth_sessions")))
    await query.schema.createTable("library_abs_auth_sessions", (table) => {
      table.string("id", 64).primary();
      table
        .string("account_id", 64)
        .notNullable()
        .references("id")
        .inTable("library_abs_accounts")
        .onDelete("CASCADE");
      table.string("refresh_hash", 64).notNullable().unique();
      table.string("previous_refresh_hash", 64).nullable();
      table.bigInteger("previous_valid_until").nullable();
      table.bigInteger("expires_at").notNullable();
      table.integer("credential_revision").notNullable();
      table.text("refresh_encrypted").nullable();
      table.bigInteger("created_at").notNullable();
      table.bigInteger("updated_at").notNullable();
    });
  if (!(await query.schema.hasTable("library_abs_progress")))
    await query.schema.createTable("library_abs_progress", (table) => {
      addStateScope(table);
      table.double("current_time").notNullable().defaultTo(0);
      table.double("duration").notNullable().defaultTo(0);
      table.integer("is_finished").notNullable().defaultTo(0);
      table.integer("hide_from_continue").notNullable().defaultTo(0);
      table.bigInteger("started_at").notNullable();
      table.bigInteger("finished_at").nullable();
      table.bigInteger("updated_at").notNullable();
      table.unique(["library_id", "account_id", "item_id"], { indexName: "uq_abs_progress" });
    });
  if (!(await query.schema.hasTable("library_abs_bookmarks")))
    await query.schema.createTable("library_abs_bookmarks", (table) => {
      addStateScope(table);
      table.double("time_seconds").notNullable();
      table.text("title").notNullable();
      table.bigInteger("created_at").notNullable();
      table.bigInteger("updated_at").notNullable();
      table.unique(["library_id", "account_id", "item_id", "time_seconds"], {
        indexName: "uq_abs_bookmark_time",
      });
    });
  if (!(await query.schema.hasTable("library_abs_playback_sessions")))
    await query.schema.createTable("library_abs_playback_sessions", (table) => {
      addStateScope(table);
      table.string("client_session_id", 255).nullable();
      table.string("device_id", 255).notNullable();
      table.text("device_json").notNullable();
      /** 播放建立时固定的书籍、音轨身份和章节时间轴；历史会话缺失时不能按当前目录重建。 */
      table.text("snapshot_json", "longtext").nullable();
      table.string("media_player", 255).notNullable();
      table.string("status", 20).notNullable();
      table.double("current_time").notNullable().defaultTo(0);
      table.double("duration").notNullable().defaultTo(0);
      table.double("time_listening").notNullable().defaultTo(0);
      table.double("start_time").notNullable().defaultTo(0);
      table.bigInteger("created_at").notNullable();
      table.bigInteger("updated_at").notNullable();
      table.bigInteger("closed_at").nullable();
      table.unique(["account_id", "client_session_id"], { indexName: "uq_abs_local_session" });
      table.index(["library_id", "account_id", "status"], "idx_abs_open_sessions");
    });
  // 64 升级到 65 只补字段，重启或升级中断后重试不会覆盖原会话与原播放记录。
  if (!(await query.schema.hasColumn("library_abs_playback_sessions", "snapshot_json"))) {
    await query.schema.alterTable("library_abs_playback_sessions", (table) => {
      table.text("snapshot_json", "longtext").nullable();
    });
  }
  for (const kind of ["collections", "playlists"] as const) {
    const name = `library_abs_${kind}`;
    if (!(await query.schema.hasTable(name)))
      await query.schema.createTable(name, (table) => {
        table.string("id", 64).primary();
        table
          .string("library_id", 64)
          .notNullable()
          .references("id")
          .inTable("media_libraries")
          .onDelete("CASCADE");
        table
          .string("account_id", 64)
          .notNullable()
          .references("id")
          .inTable("library_abs_accounts")
          .onDelete("CASCADE");
        table.string("name", 255).notNullable();
        table.text("description").notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("updated_at").notNullable();
      });
    if (!(await query.schema.hasTable(`${name}_items`)))
      await query.schema.createTable(`${name}_items`, (table) => {
        table.string("id", 64).primary();
        table.string("parent_id", 64).notNullable().references("id").inTable(name).onDelete("CASCADE");
        table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
        table.integer("sort_order").notNullable();
        table.index(["parent_id", "sort_order"], `idx_abs_${kind}_order`);
      });
  }
  if (!(await query.schema.hasTable("library_abs_preferences")))
    await query.schema.createTable("library_abs_preferences", (table) => {
      table
        .string("account_id", 64)
        .primary()
        .references("id")
        .inTable("library_abs_accounts")
        .onDelete("CASCADE");
      table.text("settings_json").notNullable();
      table.bigInteger("updated_at").notNullable();
    });
  if (!(await query("system_settings").where({ setting_key: marker }).first()))
    await query("system_settings").insert({
      setting_key: marker,
      setting_value: "1",
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
}

/** 共享状态均以真实媒体条目外键归属，清库和删账号自动删除关联状态。 */
function addStateScope(table: Knex.CreateTableBuilder): void {
  table.string("id", 64).primary();
  table
    .string("library_id", 64)
    .notNullable()
    .references("id")
    .inTable("media_libraries")
    .onDelete("CASCADE");
  table
    .string("account_id", 64)
    .notNullable()
    .references("id")
    .inTable("library_abs_accounts")
    .onDelete("CASCADE");
  table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
}
