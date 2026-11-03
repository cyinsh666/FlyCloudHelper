import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError } from "../errors.js";

/** 作品身份固定为 TMDB 类型和 ID，展示字段只是订阅时的摘要。 */
export interface MovieSubscription {
  serviceId: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  posterUrl: string | null;
  createdAt: string;
}

export const subscriptionSettingPrefix = "movie_subscription:";

/** 服务和 TMDB 作品共同确定一条订阅记录。 */
export function subscriptionSettingKey(serviceId: string, mediaType: "movie" | "tv", tmdbId: number): string {
  return `${subscriptionSettingPrefix}${serviceId}:${mediaType}:${tmdbId}`;
}

/** 损坏的持久记录应明确报错，不能悄悄当作未订阅。 */
export function readSubscription(value: unknown): MovieSubscription {
  try {
    const record = JSON.parse(String(value)) as MovieSubscription;
    if (record && typeof record.serviceId === "string" && (record.mediaType === "movie" || record.mediaType === "tv")
      && Number.isInteger(record.tmdbId) && typeof record.title === "string" && typeof record.createdAt === "string") return record;
  } catch { /* 统一返回可读错误。 */ }
  throw new ApiError(500, "movie_subscription_corrupt", "影片订阅记录无法读取");
}

/** 读取全部或某个用户的订阅；服务归属由调用方继续核实。 */
export async function listStoredSubscriptions(database: FlyCloudHelperDatabase, userId?: string): Promise<MovieSubscription[]> {
  const query = database.query("system_settings").whereLike("setting_key", `${subscriptionSettingPrefix}%`);
  if (userId) query.where({ updated_by_user_id: userId });
  const rows = await query.orderBy("created_at", "desc");
  return rows.map((row) => readSubscription(row.setting_value));
}
