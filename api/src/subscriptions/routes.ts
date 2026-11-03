import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { listStoredSubscriptions, readSubscription, subscriptionSettingKey, type MovieSubscription } from "./store.js";
import type { MovieSubscriptionWorker } from "./worker.js";

/** 只接受 TMDB 电影或剧集及其正整数 ID。 */
function subscriptionIdentity(mediaType: unknown, tmdbId: unknown): { mediaType: "movie" | "tv"; tmdbId: number } {
  if (mediaType !== "movie" && mediaType !== "tv") throw validationError("mediaType", "请选择电影或剧集");
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id < 1 || id > 1_000_000_000) throw validationError("tmdbId", "TMDB ID 无效");
  return { mediaType, tmdbId: id };
}

/** 注册个人影片订阅接口；管理员进入个人控制台时仍只操作自己的服务。 */
export async function registerMovieSubscriptionRoutes(server: FastifyInstance, runtime: ApiRuntime,
  worker: MovieSubscriptionWorker): Promise<void> {
  const prefix = "/api/v1/resource-search/subscriptions";

  /** 列出当前账号且服务仍存在的影片订阅。 */
  server.get(prefix, async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const [subscriptions, services] = await Promise.all([
      listStoredSubscriptions(runtime.database, user.id),
      runtime.repository.listServices({ userId: user.id, limit: 10000, offset: 0 }),
    ]);
    const serviceIds = new Set(services.items.map((service) => service.id));
    return { items: subscriptions.filter((item) => serviceIds.has(item.serviceId)) };
  });

  /** 以服务端读取的 TMDB 元数据创建订阅，重复添加保持原记录。 */
  server.post<{ Body: { serviceId?: unknown; mediaType?: unknown; tmdbId?: unknown } }>(prefix, async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const serviceId = request.body?.serviceId;
    if (typeof serviceId !== "string" || !serviceId || serviceId.length > 64) {
      throw validationError("serviceId", "请选择已有网盘服务");
    }
    const service = await runtime.repository.getServiceDetail(serviceId, user.id);
    if (service.providerType !== "guangya" && service.providerType !== "quark") {
      throw new ApiError(422, "subscription_provider_unsupported", "当前只支持订阅到光鸭和夸克网盘服务");
    }
    const identity = subscriptionIdentity(request.body?.mediaType, request.body?.tmdbId);
    const settingKey = subscriptionSettingKey(serviceId, identity.mediaType, identity.tmdbId);
    const existing = await runtime.database.query("system_settings").where({ setting_key: settingKey }).first();
    if (existing) {
      const item = readSubscription(existing.setting_value);
      return { item, alreadySubscribed: true };
    }

    const metadata = await runtime.tmdb.readVideoMetadata(identity.mediaType, identity.tmdbId, "zh-CN", "CN");
    if (!metadata) throw new ApiError(404, "subscription_tmdb_missing", "TMDB 中找不到这部影片");
    const now = new Date().toISOString();
    const item: MovieSubscription = { serviceId, mediaType: identity.mediaType, tmdbId: identity.tmdbId,
      title: metadata.title, originalTitle: metadata.originalTitle, year: metadata.year,
      posterUrl: metadata.posterUrl, createdAt: now };
    await worker.noteSubscriptionCreated(serviceId, now);
    // 关键变量：两个页面同时添加同一作品时，数据库唯一键阻止重复订阅记录。
    await runtime.database.query("system_settings").insert({ setting_key: settingKey,
      setting_value: JSON.stringify(item), revision: 1, updated_by_user_id: user.id, created_at: now, updated_at: now,
    }).onConflict("setting_key").ignore();
    const saved = await runtime.database.query("system_settings").where({ setting_key: settingKey }).first();
    return reply.code(201).send({ item: readSubscription(saved?.setting_value), alreadySubscribed: false });
  });

  /** 订阅页展示最近的消息处理和远端转存状态，先确认服务属于当前用户。 */
  server.get<{ Querystring: { serviceId?: string } }>(`${prefix}/activity`, async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const serviceId = request.query.serviceId;
    if (!serviceId) throw validationError("serviceId", "请选择网盘服务");
    await runtime.repository.getServiceDetail(serviceId, user.id);
    return worker.recent(serviceId);
  });

  /** 立即检查当前用户的一个服务，供新增订阅后直接验证。 */
  server.post<{ Body: { serviceId?: string } }>(`${prefix}/check`, async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const serviceId = request.body?.serviceId;
    if (!serviceId) throw validationError("serviceId", "请选择网盘服务");
    await runtime.repository.getServiceDetail(serviceId, user.id);
    await worker.runNow(serviceId);
    return worker.recent(serviceId);
  });

  /** 删除当前账号指定服务上的一条影片订阅。 */
  server.delete<{ Params: { serviceId: string; mediaType: string; tmdbId: string } }>(
    `${prefix}/:serviceId/:mediaType/:tmdbId`, async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
      const identity = subscriptionIdentity(request.params.mediaType, request.params.tmdbId);
      await runtime.database.query("system_settings").where({
        setting_key: subscriptionSettingKey(request.params.serviceId, identity.mediaType, identity.tmdbId),
        updated_by_user_id: user.id,
      }).delete();
      return reply.code(204).send();
    });
}
