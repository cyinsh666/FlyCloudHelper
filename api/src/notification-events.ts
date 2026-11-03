import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";

/** 系统通知设置中可独立控制的四类业务事件。 */
export type NotificationEvent = "credential_abnormal" | "organize_completed" | "scan_completed" | "media_probe_completed";

export interface NotificationEventSettings {
  credentialAbnormal: boolean;
  organizeCompleted: boolean;
  scanCompleted: boolean;
  mediaProbeCompleted: boolean;
  configurationRevision: number;
}

/** 旧配置保持原有扫描和规格通知行为，新事件也默认开启。 */
const defaultSettings: NotificationEventSettings = {
  credentialAbnormal: true,
  organizeCompleted: true,
  scanCompleted: true,
  mediaProbeCompleted: true,
  configurationRevision: 0,
};
const settingKey = "notification_events";

/** 校验四个开关，拒绝部分提交导致其他开关意外复位。 */
function readSwitches(value: unknown): Omit<NotificationEventSettings, "configurationRevision"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("events", "通知项目设置无效");
  }
  const input = value as Record<string, unknown>;
  for (const key of ["credentialAbnormal", "organizeCompleted", "scanCompleted", "mediaProbeCompleted"] as const) {
    if (typeof input[key] !== "boolean") throw validationError(key, "通知开关必须是布尔值");
  }
  return {
    credentialAbnormal: input.credentialAbnormal as boolean,
    organizeCompleted: input.organizeCompleted as boolean,
    scanCompleted: input.scanCompleted as boolean,
    mediaProbeCompleted: input.mediaProbeCompleted as boolean,
  };
}

/** 读取系统级通知项目；未设置时沿用默认开启状态。 */
export async function loadNotificationEventSettings(database: FlyCloudHelperDatabase): Promise<NotificationEventSettings> {
  const row = await database.query("system_settings").where({ setting_key: settingKey }).first();
  if (!row) return { ...defaultSettings };
  try {
    return { ...readSwitches(JSON.parse(String(row.setting_value))), configurationRevision: Number(row.revision ?? 0) };
  } catch {
    throw new ApiError(503, "notification_events_invalid", "通知项目配置无法读取");
  }
}

/** 保存四类通知开关，立即对新生成的通知生效。 */
export async function saveNotificationEventSettings(
  database: FlyCloudHelperDatabase,
  value: unknown,
  updatedByUserId: string,
): Promise<NotificationEventSettings> {
  const switches = readSwitches(value);
  const configurationRevision = await database.query.transaction(async (transaction) => {
    const previous = await transaction("system_settings").where({ setting_key: settingKey }).first();
    const revision = Number(previous?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    const update = { setting_value: JSON.stringify(switches), revision, updated_by_user_id: updatedByUserId, updated_at: now };
    if (previous) await transaction("system_settings").where({ setting_key: settingKey }).update(update);
    else await transaction("system_settings").insert({ setting_key: settingKey, ...update, created_at: now });
    return revision;
  });
  return { ...switches, configurationRevision };
}

/** 判断一个业务事件是否应写入通知；未标记事件的旧通知不受影响。 */
export async function notificationEventEnabled(database: FlyCloudHelperDatabase, event: NotificationEvent): Promise<boolean> {
  const settings = await loadNotificationEventSettings(database);
  if (event === "credential_abnormal") return settings.credentialAbnormal;
  if (event === "organize_completed") return settings.organizeCompleted;
  if (event === "scan_completed") return settings.scanCompleted;
  return settings.mediaProbeCompleted;
}
