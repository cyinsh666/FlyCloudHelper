import type { Knex } from "knex";

/** 升级时的服务归属；同一服务可以出现在多个新媒体库，旧数据只迁入原媒体库。 */
export interface HistoricalLibraryOwnership {
  userId: string;
  libraryId: string;
}

/** 从旧关联字段和新来源关系中定位原媒体库，兼容迁移中断后只剩一侧旧字段。 */
export async function readHistoricalLibraryOwnership(database: Knex): Promise<Map<string, HistoricalLibraryOwnership>> {
  const services = await database("cloud_services").select("*").whereNull("deleted_at");
  const libraries = await database("media_libraries").select("*");
  const sources = await database("library_sources").select("service_id", "user_id", "library_id");
  const libraryById = new Map(libraries.map((library) => [String(library.id), library]));
  const ownership = new Map<string, HistoricalLibraryOwnership>();
  for (const service of services) {
    const serviceId = String(service.id);
    const userId = String(service.user_id);
    // 关键变量：双向旧字段是原媒体库的直接证据，聚合库新增的来源不能覆盖这个归属。
    const explicitIds = new Set<string>();
    if (service.library_id) explicitIds.add(String(service.library_id));
    for (const library of libraries) {
      if (String(library.service_id ?? "") === serviceId) explicitIds.add(String(library.id));
    }
    let candidateIds = [...explicitIds];
    if (candidateIds.length === 0) {
      const linkedLibraries = sources.filter((source) => String(source.service_id ?? "") === serviceId
        && String(source.user_id) === userId).map((source) => libraryById.get(String(source.library_id)))
        .filter((library) => library && String(library.user_id) === userId);
      const originalLibraries = linkedLibraries.filter((library) => library.library_kind === "legacy_single_source");
      candidateIds = [...new Set((originalLibraries.length > 0 ? originalLibraries : linkedLibraries)
        .map((library) => String(library.id)))];
    }
    if (candidateIds.length === 0) continue;
    if (candidateIds.length !== 1) {
      // 不猜测多个媒体库中的归属，保留旧表供修正后重新启动迁移。
      continue;
    }
    const libraryId = candidateIds[0]!;
    const library = libraryById.get(libraryId);
    if (!library || String(library.user_id) !== userId
      || (library.service_id && String(library.service_id) !== serviceId)) continue;
    ownership.set(serviceId, { userId, libraryId });
  }
  return ownership;
}

/** 要求旧记录有唯一、同用户的媒体库归属，避免升级时串库或跨用户搬迁。 */
export function requireHistoricalLibrary(
  ownership: Map<string, HistoricalLibraryOwnership>,
  serviceId: unknown,
  tableName: string,
  userId?: unknown,
): string {
  const target = ownership.get(String(serviceId));
  if (!target || (userId !== undefined && String(userId) !== target.userId)) {
    console.error(JSON.stringify({
      日志关键字: "codex-schema-upgrade", 事件: "旧数据归属校验失败", 旧表: tableName,
      服务ID: String(serviceId), 原因: "未找到唯一且属于同一用户的原媒体库",
    }));
    throw new Error(`数据库升级停止：${tableName} 的旧记录缺少明确的原媒体库归属`);
  }
  return target.libraryId;
}

/** 放宽旧列非空限制；只修改空值约束，保留原来的类型、外键和索引。 */
export async function allowHistoricalServiceIdNull(database: Knex, tableNames: string[]): Promise<void> {
  for (const tableName of tableNames) {
    if (!(await database.schema.hasColumn(tableName, "service_id"))) continue;
    const info = await database(tableName).columnInfo("service_id");
    if (info.nullable !== false) continue;
    await database.schema.alterTable(tableName, (table) => table.setNullable("service_id"));
  }
}

/** 补齐历史协议地址；保留已设置的后缀，单来源旧库继续使用原服务 ID。 */
export async function backfillHistoricalProtocolPaths(database: Knex, protocol: "jellyfin" | "emby" | "navidrome"): Promise<void> {
  const ownership = await readHistoricalLibraryOwnership(database);
  const serviceByLibraryId = new Map([...ownership].map(([serviceId, target]) => [target.libraryId, serviceId]));
  const pathColumn = `${protocol}_path_suffix`;
  const lookupColumn = `${protocol}_path_suffix_lookup`;
  const libraries = await database("media_libraries").select("*");
  for (const library of libraries) {
    const suffix = String(library[pathColumn] ?? "").trim()
      || String(library.service_id ?? serviceByLibraryId.get(String(library.id)) ?? library.id);
    const lookup = suffix.toLowerCase();
    if (library[pathColumn] === suffix && library[lookupColumn] === lookup) continue;
    const conflict = await database("media_libraries").where({ [lookupColumn]: lookup }).whereNot("id", library.id).first("id");
    if (conflict) throw new Error(`数据库升级停止：${protocol} 历史地址后缀重复，媒体库 ${String(library.id)}`);
    await database("media_libraries").where({ id: library.id }).update({ [pathColumn]: suffix, [lookupColumn]: lookup });
  }
}

/** 合并重复源文件前转移其媒体关联和规格；禁止外键级联把仍有用的历史记录一起删除。 */
export async function preserveDuplicateSourceFileReferences(
  transaction: Knex.Transaction,
  retainedId: string,
  duplicateIds: string[],
): Promise<void> {
  const singleFileTables: string[] = [];
  for (const tableName of ["media_file_probes", "audio_file_tags", "music_file_snapshots"]) {
    if (await transaction.schema.hasTable(tableName)) singleFileTables.push(tableName);
  }
  const playbackTables: string[] = [];
  for (const tableName of [
    "library_playback_progress", "library_playback_sessions",
    "library_emby_playback_progress", "library_emby_playback_sessions",
  ]) {
    if (await transaction.schema.hasColumn(tableName, "media_source_id")) playbackTables.push(tableName);
  }
  for (const duplicateId of duplicateIds) {
    const links = await transaction("file_links").where({ source_file_id: duplicateId });
    for (const link of links) {
      const retainedLink = await transaction("file_links").where({
        user_id: link.user_id, library_id: link.library_id, source_file_id: retainedId,
      }).first();
      if (retainedLink) {
        // 同一文件已归属不同影片时不能猜测正确影片，整组事务回滚并保留两个关联。
        if (String(retainedLink.item_id) !== String(link.item_id)) {
          throw new Error(`数据库升级停止：重复源文件 ${duplicateId} 与 ${retainedId} 对应不同媒体条目`);
        }
        await transaction("file_links").where({ id: link.id }).delete();
      } else {
        await transaction("file_links").where({ id: link.id }).update({ source_file_id: retainedId });
      }
    }
    for (const tableName of singleFileTables) {
      const retainedResult = await transaction(tableName).where({ source_file_id: retainedId }).first();
      if (!retainedResult) {
        await transaction(tableName).where({ source_file_id: duplicateId }).update({ source_file_id: retainedId });
      }
    }
    if (await transaction.schema.hasTable("media_item_source_candidates")) {
      const candidates = await transaction("media_item_source_candidates").where({ source_file_id: duplicateId });
      for (const candidate of candidates) {
        const retainedCandidate = await transaction("media_item_source_candidates").where({
          user_id: candidate.user_id, library_id: candidate.library_id,
          source_file_id: retainedId, candidate_key: candidate.candidate_key,
        }).first();
        if (retainedCandidate) {
          if (String(retainedCandidate.identity_key) !== String(candidate.identity_key)) {
            throw new Error(`数据库升级停止：重复源文件 ${duplicateId} 的识别候选归属冲突`);
          }
          await transaction("media_item_source_candidates").where({ id: candidate.id }).delete();
        } else {
          await transaction("media_item_source_candidates").where({ id: candidate.id }).update({ source_file_id: retainedId });
        }
      }
    }
    if (await transaction.schema.hasTable("catalog_projection_jobs")) {
      await transaction("catalog_projection_jobs").where({ source_file_id: duplicateId }).update({ source_file_id: retainedId });
    }
    for (const tableName of playbackTables) {
      await transaction(tableName).where({ media_source_id: duplicateId }).update({ media_source_id: retainedId });
    }
  }
}

/** 旧协议表和当前协议表的映射，顺序保证账号、歌单先于其子记录迁入。 */
interface ProtocolTableMigration {
  legacy: string;
  current: string;
  hasServiceId: boolean;
}

const protocolTableMappings: ProtocolTableMigration[] = [
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

/** 迁移旧协议记录；整批写入成功后才移除旧表，中断重启时验证已经迁入的记录归属。 */
export async function migrateHistoricalProtocolTables(database: Knex): Promise<void> {
  const existingMappings: ProtocolTableMigration[] = [];
  for (const mapping of protocolTableMappings) {
    if (await database.schema.hasTable(mapping.legacy)) existingMappings.push(mapping);
  }
  if (existingMappings.length === 0) return;
  const ownership = await readHistoricalLibraryOwnership(database);
  let migratedCount = 0;
  let resumedCount = 0;
  await database.transaction(async (transaction) => {
    for (const mapping of existingMappings) {
      const columns = await transaction(mapping.current).columnInfo();
      let lastId: string | undefined;
      while (true) {
        // 关键变量：按稳定主键分批读取，避免大量历史播放记录一次性占用内存。
        const query = transaction(mapping.legacy).select("*").orderBy("id").limit(250);
        if (lastId !== undefined) query.where("id", ">", lastId);
        const rows = await query;
        if (rows.length === 0) break;
        for (const row of rows) {
          const values: Record<string, unknown> = { ...row };
          if (mapping.hasServiceId) {
            values.library_id = requireHistoricalLibrary(ownership, row.service_id, mapping.legacy, row.user_id);
            delete values.service_id;
          }
          // 旧总时长已由媒体规格替代；不添加任何非标准 Jellyfin/Emby 上报字段。
          if (mapping.legacy === "service_playback_progress" || mapping.legacy === "service_emby_playback_progress") {
            delete values.duration_ticks;
          }
          if ((mapping.legacy === "service_access_accounts" || mapping.legacy === "service_emby_accounts")
            && values.password_required === undefined) {
            // 历史必填密码账号缺少此列时仍保留密码校验，不能套用新版免密码默认值。
            values.password_required = String(values.password_hash ?? "").length > 0 ? 1 : 0;
          }
          const unknownColumns = Object.keys(values).filter((column) => !Object.hasOwn(columns, column));
          if (unknownColumns.length > 0) {
            throw new Error(`数据库升级停止：${mapping.legacy} 存在尚未处理的旧字段 ${unknownColumns.join(",")}`);
          }
          const existing = await transaction(mapping.current).where({ id: row.id }).first();
          if (existing) {
            // 中断重试保留新表中较新的播放状态，但主键和外键必须仍对应同一条旧记录。
            for (const key of ["library_id", "account_id", "item_id", "playlist_id", "token_hash", "play_session_id"]) {
              if (values[key] !== undefined && String(existing[key] ?? "") !== String(values[key] ?? "")) {
                throw new Error(`数据库升级停止：${mapping.current} 的记录 ${String(row.id)} 归属冲突`);
              }
            }
            resumedCount += 1;
          } else {
            await transaction(mapping.current).insert(values);
            migratedCount += 1;
          }
        }
        lastId = String(rows[rows.length - 1].id);
      }
      const missing = await transaction(`${mapping.legacy} as old`)
        .leftJoin(`${mapping.current} as current`, "current.id", "old.id")
        .whereNull("current.id").first("old.id");
      if (missing) throw new Error(`数据库升级停止：${mapping.legacy} 仍有未迁入的记录`);
    }
  });
  // MySQL DDL 会隐式提交，旧表删除放在已完成数据事务之后，失败时也能从新表恢复。
  for (const mapping of [...existingMappings].reverse()) await database.schema.dropTable(mapping.legacy);
  console.info(JSON.stringify({
    日志关键字: "codex-schema-upgrade", 事件: "旧协议表迁移完成", 新迁入记录数: migratedCount,
    中断恢复记录数: resumedCount, 迁移表数: existingMappings.length,
  }));
}

/** 将旧服务定时计划迁入原媒体库，所有旧计划核对成功后才删除旧表。 */
export async function migrateHistoricalScanSchedules(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("service_scan_schedules"))) return;
  const ownership = await readHistoricalLibraryOwnership(database);
  await database.transaction(async (transaction) => {
    const schedules = await transaction("service_scan_schedules").select("*");
    for (const schedule of schedules) {
      const libraryId = requireHistoricalLibrary(ownership, schedule.service_id, "service_scan_schedules", schedule.user_id);
      const sameId = await transaction("library_scan_schedules").where({ id: schedule.id }).first();
      if (sameId && (String(sameId.library_id) !== libraryId || String(sameId.user_id) !== String(schedule.user_id)
        || String(sameId.scan_mode) !== String(schedule.scan_mode))) {
        throw new Error("数据库升级停止：旧扫描计划与已迁入计划的归属冲突");
      }
      const existing = sameId ?? await transaction("library_scan_schedules").where({
        user_id: schedule.user_id, library_id: libraryId, scan_mode: schedule.scan_mode,
      }).first();
      if (existing) continue;
      const { service_id: _serviceId, ...values } = schedule;
      await transaction("library_scan_schedules").insert({ ...values, library_id: libraryId });
    }
  });
  await database.schema.dropTable("service_scan_schedules");
}
