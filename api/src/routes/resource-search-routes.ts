import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin, requireString } from "../http.js";
import { ResourceSearchEngine, type SearchSource } from "../resource-search/engine.js";
import type { ChannelTypeCacheWorker } from "../resource-search/channel-types.js";
import { getServiceTransferDirectory, saveServiceTransferDirectory, verifyServiceTransferDirectory,
  getSubscriptionTransferRename, saveSubscriptionTransferRename,
  type ServiceTransferDirectory } from "../resource-search/transfer-directory.js";
import { readShareTransferStatus, submitShareTransfer } from "../resource-search/share-transfer.js";
import { readGuangyaOfflineTransfer, submitGuangyaOfflineTransfer } from "../resource-search/offline-transfer.js";
import type { ApiRuntime } from "../runtime.js";
import type { MovieSubscriptionWorker } from "../subscriptions/worker.js";

/** 注册资源搜索、Telegram 频道配置及同网盘分享转存。 */
export async function registerResourceSearchRoutes(server: FastifyInstance, runtime: ApiRuntime,
  subscriptionWorker: MovieSubscriptionWorker, channelTypeCacheWorker: ChannelTypeCacheWorker): Promise<void> {
  const engine = new ResourceSearchEngine(runtime.database);

  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/resource-search" : "/api/v1/resource-search";

    /** 管理员可选任意已有服务，普通用户只访问自己的服务。 */
    async function actor(request: FastifyRequest): Promise<{ userId: string; ownerId?: string }> {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      return { userId: user.id, ownerId: admin ? undefined : user.id };
    }

    server.get(`${prefix}/sources`, async (request) => {
      await actor(request);
      return { items: await engine.listSources() };
    });
    const servicePrefix = admin ? "/api/v1/admin/services" : "/api/v1/services";

    /** 订阅命名开关按服务归属读取，默认关闭。 */
    server.get<{ Params: { serviceId: string } }>(`${servicePrefix}/:serviceId/subscription-transfer-settings`, async (request) => {
      const { ownerId } = await actor(request);
      const service = await runtime.repository.getServiceDetail(request.params.serviceId, ownerId);
      return { supported: service.providerType === "guangya" || service.providerType === "quark",
        replaceName: await getSubscriptionTransferRename(runtime.database, service.id) };
    });

    /** 保存服务级开关，不修改转存目录或已经提交的批次快照。 */
    server.put<{ Params: { serviceId: string }; Body: { replaceName?: boolean } }>(
      `${servicePrefix}/:serviceId/subscription-transfer-settings`, async (request) => {
        const { ownerId, userId } = await actor(request);
        const service = await runtime.repository.getServiceDetail(request.params.serviceId, ownerId);
        if (service.providerType !== "guangya" && service.providerType !== "quark") {
          throw new ApiError(422, "subscription_transfer_unsupported", "当前服务不支持订阅自动转存");
        }
        const replaceName = request.body?.replaceName;
        if (typeof replaceName !== "boolean") throw validationError("replaceName", "请选择是否替换订阅转存片名");
        await saveSubscriptionTransferRename(runtime.database, service.id, userId, replaceName);
        return { replaceName };
      });

    /** 读取网盘服务自己的转存目录，不回退到影片整理来源目录。 */
    server.get<{ Params: { serviceId: string } }>(`${servicePrefix}/:serviceId/transfer-directory`, async (request) => {
      const { ownerId } = await actor(request);
      await runtime.repository.getServiceDetail(request.params.serviceId, ownerId);
      return { directory: await getServiceTransferDirectory(runtime.database, request.params.serviceId) };
    });

    /** 保存已从当前网盘真实目录树中选择的转存落点。 */
    server.put<{ Params: { serviceId: string }; Body: { directory?: ServiceTransferDirectory | null } }>(
      `${servicePrefix}/:serviceId/transfer-directory`, async (request) => {
        const { ownerId, userId } = await actor(request);
        const service = await runtime.repository.getServiceDetail(request.params.serviceId, ownerId);
        const selected = request.body?.directory;
        if (selected === undefined) throw validationError("directory", "请选择网盘转存目录");
        let directory: ServiceTransferDirectory | null = null;
        if (selected !== null) {
          if (service.status !== "active" || service.connectionStatus !== "valid") {
            throw new ApiError(409, "transfer_directory_service_unavailable", "网盘服务当前不可用");
          }
          const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
          /** 网盘刷新凭据后继续保存到原服务，目录配置不依赖整理功能。 */
          const persistConnection = async (nextConnection: Record<string, unknown>): Promise<void> => {
            await runtime.repository.refreshActiveEncryptedConnection({
              serviceId: service.id, userId: service.userId, credentialRevision: service.credentialRevision,
              encryptedConnection: runtime.vault.encrypt(nextConnection),
            });
          };
          directory = await verifyServiceTransferDirectory(runtime.providers.get(service.providerType),
            connection, selected, { persistConnection });
        }
        return { directory: await saveServiceTransferDirectory(runtime.database, service.id, userId, directory) };
      });
    if (!admin) {
      /** 个人订阅设置只列出当前用户的网盘服务与系统中已启用的 TG 频道。 */
      server.get(`${prefix}/subscription-channels`, async (request) => {
        const { userId } = await actor(request);
        const channels = (await engine.listSources())
          .filter((source) => source.kind === "telegram" && source.enabled).map((source) => source.key);
        const channelTypes = await channelTypeCacheWorker.summary(channels);
        const page = await runtime.repository.listServices({ userId, limit: 10000, offset: 0 });
        const services = await Promise.all(page.items.map(async (service) => ({
          serviceId: service.id, serviceName: service.displayName, providerType: service.providerType,
          channelKeys: await engine.serviceChannels(service.id, channels),
        })));
        return { channels, channelTypes: { ...channelTypes, enabled: runtime.config.workerEnabled }, services };
      });

      /** 每次保存先核实服务归属，防止修改其他用户的关注频道。 */
      server.put<{ Params: { serviceId: string }; Body: { channelKeys?: unknown } }>(
        `${prefix}/subscription-channels/:serviceId`, async (request) => {
          const { userId } = await actor(request);
          await runtime.repository.getServiceDetail(request.params.serviceId, userId);
          const channelKeys = await engine.saveServiceChannels(request.params.serviceId, request.body?.channelKeys, userId);
          await subscriptionWorker.noteChannelsChanged(request.params.serviceId, channelKeys);
          return { channelKeys };
        });
    }
    if (admin) {
      /** 系统设置读取频道类型缓存和手动分析进度，不执行外部请求。 */
      server.get(`${prefix}/channel-types`, async (request) => {
        await actor(request);
        const channels = (await engine.listSources())
          .filter((source) => source.kind === "telegram" && source.enabled).map((source) => source.key);
        return { totalChannels: channels.length, automaticEnabled: runtime.config.workerEnabled,
          cache: await channelTypeCacheWorker.summary(channels), status: channelTypeCacheWorker.analysisStatus() };
      });

      /** 管理员立即分析所有已启用频道，HTTP 请求不等待整批扫描完成。 */
      server.post(`${prefix}/channel-types/analyze`, async (request, reply) => {
        await actor(request);
        return reply.code(202).send({ status: channelTypeCacheWorker.analyzeNow() });
      });

      server.put<{ Body: { items: SearchSource[] } }>(`${prefix}/sources`, async (request) => {
        const { userId } = await actor(request);
        return { items: await engine.saveSources(request.body?.items, userId) };
      });
    }
    server.get<{ Querystring: { keyword?: string } }>(`${prefix}/search`, async (request) => {
      await actor(request);
      const keyword = typeof request.query.keyword === "string" ? request.query.keyword.trim() : "";
      if (!keyword || keyword.length > 100) throw validationError("keyword", "请输入不超过 100 字的搜索内容");
      return engine.search(keyword);
    });
    server.get(`${prefix}/targets`, async (request) => {
      const { ownerId } = await actor(request);
      const servicePages = await Promise.all(["guangya", "quark"].map((providerType) =>
        runtime.repository.listServices({ userId: ownerId, providerType, limit: 1000, offset: 0 })));
      const items = await Promise.all(servicePages.flatMap((page) => page.items).map(async (service) => {
        const directory = await getServiceTransferDirectory(runtime.database, service.id);
        return { serviceId: service.id, serviceName: service.displayName, providerType: service.providerType,
          directory, reason: directory ? null : "尚未设置独立转存目录" };
      }));
      return { items };
    });
    server.post<{ Body: { serviceId?: string; shareUrl?: string; password?: string } }>(
      `${prefix}/transfer`, async (request, reply) => {
        const { ownerId, userId } = await actor(request);
        const body = request.body ?? {};
        const serviceId = requireString(body, "serviceId", "网盘服务", 100);
        const shareUrl = requireString(body, "shareUrl", "网盘分享链接", 1000);
        const password = typeof body.password === "string" ? body.password.trim() : "";
        const result = await submitShareTransfer(runtime, { serviceId, shareUrl, password,
          actorUserId: userId, ownerId });
        return reply.status(202).send({ taskId: result.taskId, fileCount: result.fileCount });
      });
    /** 搜索结果中的磁力由用户确认后提交到光鸭云添加，不经过本机下载。 */
    server.post<{ Body: { serviceId?: string; magnetUrl?: string } }>(
      `${prefix}/offline-transfer`, async (request, reply) => {
        const { ownerId, userId } = await actor(request);
        const body = request.body ?? {};
        const serviceId = requireString(body, "serviceId", "光鸭服务", 100);
        const magnetUrl = requireString(body, "magnetUrl", "磁力链接", 4000);
        const result = await submitGuangyaOfflineTransfer(runtime, { serviceId, magnetUrl,
          actorUserId: userId, ownerId });
        return reply.status(202).send(result);
      });
    /** 页面继续查询远端云添加进度，避免用户重复提交同一磁力。 */
    server.get<{ Params: { taskId: string }; Querystring: { serviceId?: string } }>(
      `${prefix}/offline-tasks/:taskId`, async (request) => {
        const { ownerId } = await actor(request);
        const serviceId = request.query.serviceId ?? "";
        if (!serviceId) throw validationError("serviceId", "请选择光鸭服务");
        return readGuangyaOfflineTransfer(runtime, serviceId, request.params.taskId, ownerId);
      });
    server.get<{ Params: { taskId: string }; Querystring: { serviceId?: string } }>(
      `${prefix}/transfer-tasks/:taskId`, async (request) => {
        const { ownerId } = await actor(request);
        const serviceId = request.query.serviceId ?? "";
        if (!serviceId) throw validationError("serviceId", "请选择网盘服务");
        return { status: await readShareTransferStatus(runtime, serviceId, request.params.taskId, ownerId) };
      });
  }
}
