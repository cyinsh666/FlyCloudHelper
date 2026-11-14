import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";
import { readSubscription, subscriptionSettingKey, type MovieSubscription } from "./store.js";
import type { MovieSubscriptionWorker } from "./worker.js";

/** 网页和机器人共用订阅创建入口，网盘和订阅始终归属调用用户。 */
export async function createMovieSubscription(runtime: ApiRuntime, worker: MovieSubscriptionWorker,
  userId: string, serviceId: string, mediaType: "movie" | "tv", tmdbId: number) {
  const service = await runtime.repository.getServiceDetail(serviceId, userId);
  if (service.providerType !== "guangya" && service.providerType !== "quark") {
    throw new ApiError(422, "subscription_provider_unsupported", "当前只支持订阅到光鸭和夸克网盘服务");
  }
  const settingKey = subscriptionSettingKey(serviceId, mediaType, tmdbId);
  const existing = await runtime.database.query("system_settings").where({ setting_key: settingKey }).first();
  if (existing) return { item: readSubscription(existing.setting_value), alreadySubscribed: true };
  const metadata = await runtime.tmdb.readVideoMetadata(mediaType, tmdbId, "zh-CN", "CN");
  if (!metadata) throw new ApiError(404, "subscription_tmdb_missing", "TMDB 中找不到这部影片");
  const now = new Date().toISOString();
  const item: MovieSubscription = { serviceId, mediaType, tmdbId, title: metadata.title,
    originalTitle: metadata.originalTitle, year: metadata.year, posterUrl: metadata.posterUrl, createdAt: now };
  await worker.noteSubscriptionCreated(serviceId, now);
  // 关键变量：并发添加同一作品时仍只生成一条订阅。
  await runtime.database.query("system_settings").insert({ setting_key: settingKey,
    setting_value: JSON.stringify(item), revision: 1, updated_by_user_id: userId, created_at: now, updated_at: now,
  }).onConflict("setting_key").ignore();
  const saved = await runtime.database.query("system_settings").where({ setting_key: settingKey }).first();
  return { item: readSubscription(saved?.setting_value), alreadySubscribed: false };
}
