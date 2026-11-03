import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError, validationError } from "../errors.js";
import type { ProviderAdapter, ProviderConnectionContext, ProviderDirectory } from "../providers/types.js";

/** 网盘服务自己的转存落点，与影片整理来源和目标配置分开保存。 */
export type ServiceTransferDirectory = Pick<ProviderDirectory, "resourceId" | "displayPath" | "driveId">;

const transferDirectorySettingPrefix = "resource_transfer_directory:";

/** 读取服务已保存的转存目录；旧服务没有配置时返回空。 */
export async function getServiceTransferDirectory(database: FlyCloudHelperDatabase, serviceId: string):
  Promise<ServiceTransferDirectory | null> {
  const row = await database.query("system_settings")
    .where({ setting_key: `${transferDirectorySettingPrefix}${serviceId}` }).first();
  if (!row) return null;
  try {
    const value = JSON.parse(String(row.setting_value)) as ServiceTransferDirectory;
    if (value && typeof value.resourceId === "string" && value.resourceId
      && typeof value.displayPath === "string" && value.displayPath) return value;
  } catch { /* 统一返回配置错误。 */ }
  throw new ApiError(500, "transfer_directory_corrupt", "服务转存目录配置无法读取");
}

/** 由 Provider 重新核对目录身份，避免使用过期或前端伪造的路径。 */
export async function verifyServiceTransferDirectory(adapter: ProviderAdapter, connection: Record<string, unknown>,
  selected: ServiceTransferDirectory, context?: ProviderConnectionContext): Promise<ServiceTransferDirectory> {
  if (!selected || typeof selected.resourceId !== "string" || !selected.resourceId || selected.resourceId.length > 2000
    || typeof selected.displayPath !== "string" || !selected.displayPath || selected.displayPath.length > 2000
    || (selected.driveId !== undefined && (typeof selected.driveId !== "string" || selected.driveId.length > 500))) {
    throw validationError("directory", "请选择有效的网盘转存目录");
  }
  const listing = await adapter.browseDirectories(connection, selected, undefined, context);
  if (listing.current.resourceId !== selected.resourceId || listing.current.displayPath !== selected.displayPath
    || (selected.driveId && listing.current.driveId !== selected.driveId)) {
    throw new ApiError(409, "transfer_directory_changed", "转存目录已变化，请重新选择");
  }
  return { resourceId: listing.current.resourceId, displayPath: listing.current.displayPath,
    ...(listing.current.driveId ? { driveId: listing.current.driveId } : {}) };
}

/** 保存或清空服务级转存目录，不触及整理任务配置。 */
export async function saveServiceTransferDirectory(database: FlyCloudHelperDatabase, serviceId: string,
  userId: string, directory: ServiceTransferDirectory | null): Promise<ServiceTransferDirectory | null> {
  const settingKey = `${transferDirectorySettingPrefix}${serviceId}`;
  await database.query.transaction(async (transaction) => {
    if (!directory) { await transaction("system_settings").where({ setting_key: settingKey }).delete(); return; }
    const previous = await transaction("system_settings").where({ setting_key: settingKey }).first();
    const now = new Date().toISOString();
    const next = { setting_value: JSON.stringify(directory), revision: Number(previous?.revision ?? 0) + 1,
      updated_by_user_id: userId, updated_at: now };
    if (previous) await transaction("system_settings").where({ setting_key: settingKey }).update(next);
    else await transaction("system_settings").insert({ setting_key: settingKey, ...next, created_at: now });
  });
  return directory;
}
