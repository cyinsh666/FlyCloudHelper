import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin, requireString } from "../http.js";
import { ServiceOrganizeManager } from "../organize/manager.js";
import { ServiceOrganizeScheduler } from "../organize/schedule.js";
import { ResourceSearchEngine, parseGuangyaShareUrl, parseQuarkShareUrl, type SearchSource } from "../resource-search/engine.js";
import type { QuarkProvider } from "../providers/quark.js";
import type { ApiRuntime } from "../runtime.js";

/** 注册资源搜索、Telegram 频道配置及同网盘分享转存。 */
export async function registerResourceSearchRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const engine = new ResourceSearchEngine(runtime.database);
  const organizeManager = new ServiceOrganizeManager(runtime);
  const scheduler = new ServiceOrganizeScheduler(runtime, organizeManager);

  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/resource-search" : "/api/v1/resource-search";

    /** 管理员可选任意已有服务，普通用户只访问自己的服务。 */
    async function actor(request: FastifyRequest): Promise<{ userId: string; ownerId?: string }> {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      return { userId: user.id, ownerId: admin ? undefined : user.id };
    }

    /** 加载服务凭据及刷新回写回调，转存全程不向浏览器发送 Token。 */
    async function serviceConnection(serviceId: string, ownerId?: string) {
      const service = await runtime.repository.getServiceDetail(serviceId, ownerId);
      if (service.providerType !== "guangya" && service.providerType !== "quark") {
        throw new ApiError(422, "search_transfer_provider_invalid", "当前只支持光鸭和夸克分享转存");
      }
      if (service.status !== "active" || service.connectionStatus !== "valid") {
        throw new ApiError(409, "search_transfer_service_unavailable", "网盘服务当前不可用");
      }
      const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
      if (!runtime.providers.get(service.providerType).fileOrganizer?.supports(connection)) {
        throw new ApiError(422, "search_transfer_auth_unsupported", "当前网盘登录方式不支持转存");
      }
      return { service, connection, persistConnection: async (nextConnection: Record<string, unknown>) => {
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: service.id, userId: service.userId, credentialRevision: service.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
      } };
    }

    server.get(`${prefix}/sources`, async (request) => {
      await actor(request);
      return { items: await engine.listSources() };
    });
    if (admin) {
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
        const schedule = await scheduler.get(service.id, ownerId);
        const capability = await organizeManager.capabilities(service.id, ownerId);
        return { serviceId: service.id, serviceName: service.displayName, providerType: service.providerType,
          sources: capability.supported ? schedule.sources : [],
          reason: capability.supported ? schedule.sources.length ? null : "尚未设置影片整理来源目录" : capability.reason };
      }));
      return { items };
    });
    server.post<{ Body: { serviceId?: string; sourceDirectoryId?: string; shareUrl?: string; password?: string } }>(
      `${prefix}/transfer`, async (request, reply) => {
        const { ownerId, userId } = await actor(request);
        const body = request.body ?? {};
        const serviceId = requireString(body, "serviceId", "网盘服务", 100);
        const sourceDirectoryId = requireString(body, "sourceDirectoryId", "整理来源目录", 200);
        const shareUrl = requireString(body, "shareUrl", "网盘分享链接", 1000);
        const guangyaShare = parseGuangyaShareUrl(shareUrl);
        const quarkShare = parseQuarkShareUrl(shareUrl);
        if (!guangyaShare && !quarkShare) throw validationError("shareUrl", "请输入有效的光鸭或夸克分享链接");
        const password = typeof body.password === "string" ? body.password.trim() : "";
        if (password.length > 32) throw validationError("password", "提取码过长");
        const { service, connection, persistConnection } = await serviceConnection(serviceId, ownerId);
        if ((service.providerType === "guangya" && !guangyaShare)
          || (service.providerType === "quark" && !quarkShare)) {
          throw new ApiError(422, "search_transfer_provider_mismatch", "分享链接与目标网盘服务类型不一致");
        }
        const schedule = await scheduler.get(serviceId, ownerId);
        const source = schedule.sources.find((item) => item.resourceId === sourceDirectoryId);
        if (!source || !source.resourceId) {
          throw new ApiError(422, "search_transfer_source_missing", "请先在该网盘服务设置影片整理来源目录");
        }
        if (quarkShare) {
          const provider = runtime.providers.get("quark") as QuarkProvider;
          const context = { persistConnection };
          const token = await provider.getShareToken(connection, quarkShare.shareId, password || quarkShare.code, context);
          const entries = await provider.listShareRoot(connection, quarkShare.shareId, token, context);
          if (!entries.length) throw new ApiError(422, "search_share_empty", "分享中没有可转存文件");
          // 关键变量：提交后网络异常不能自动重试，避免夸克已收到请求时重复转存。
          const taskId = await provider.saveShareRoot(connection, quarkShare.shareId, token, entries, source.resourceId, context);
          runtime.logBusinessEvent("info", { 日志关键字: "codex-resource-search-transfer", 事件: "提交夸克分享转存",
            用户ID: userId, 服务ID: service.id, 来源目录ID: source.resourceId, 文件数量: entries.length, 任务ID: taskId });
          return reply.status(202).send({ taskId, fileCount: entries.length });
        }
        if (!guangyaShare) throw validationError("shareUrl", "请输入有效的光鸭分享链接");
        const parsed = guangyaShare;
        const client = runtime.providers.guangyaWebClient;
        const tokenData = await client.mutateFile(connection, "/userres/v1/get_share_access_token",
          { shareId: parsed.shareId, code: password || parsed.code }, persistConnection);
        const accessToken = typeof tokenData.accessToken === "string" ? tokenData.accessToken : "";
        if (!accessToken) throw new ApiError(422, "search_share_unavailable", "分享链接无效或提取码错误");
        const fileIds: string[] = [];
        let cursor: number | undefined;
        for (let page = 0; page < 50; page += 1) {
          // 关键变量：光鸭分享列表的 cursor 必须保持数字类型，按响应值继续翻页。
          const payload: Record<string, unknown> = { pageSize: 100, accessToken, orderBy: 0, sortType: 0, parentId: "" };
          if (cursor !== undefined) payload.cursor = cursor;
          const data = await client.mutateFile(connection, "/userres/v1/get_share_page_files_list", payload, persistConnection);
          const list = Array.isArray(data.list) ? data.list as Array<Record<string, unknown>> : [];
          for (const item of list) {
            if (typeof item.fileId === "string" && item.fileId) fileIds.push(item.fileId);
          }
          const next = Number(data.cursor);
          if (list.length === 0 || !Number.isFinite(next) || next <= 0 || next === cursor || data.hasMore === false) break;
          if (page === 49) throw new ApiError(422, "search_share_too_large", "分享目录过大，无法完整读取");
          cursor = next;
        }
        if (!fileIds.length) throw new ApiError(422, "search_share_empty", "分享中没有可转存文件");
        // 提交可能已到达光鸭，网络错误时不自动重试，以免重复转存。
        const submitted = await client.mutateFile(connection, "/userres/v1/restore_share",
          { accessToken, fileIds, parentId: source.resourceId }, persistConnection);
        const taskId = String(submitted.taskId ?? "");
        if (!taskId) throw new ApiError(503, "search_transfer_task_missing", "转存已提交，但未收到任务编号；请检查目标目录");
        runtime.logBusinessEvent("info", { 日志关键字: "codex-resource-search-transfer", 事件: "提交光鸭分享转存",
          用户ID: userId, 服务ID: service.id, 来源目录ID: source.resourceId, 文件数量: fileIds.length, 任务ID: taskId });
        return reply.status(202).send({ taskId, fileCount: fileIds.length });
      });
    server.get<{ Params: { taskId: string }; Querystring: { serviceId?: string } }>(
      `${prefix}/transfer-tasks/:taskId`, async (request) => {
        const { ownerId } = await actor(request);
        const serviceId = request.query.serviceId ?? "";
        if (!serviceId || !/^[0-9A-Za-z_-]{1,128}$/u.test(request.params.taskId)) throw validationError("taskId", "转存任务参数无效");
        const { service, connection, persistConnection } = await serviceConnection(serviceId, ownerId);
        if (service.providerType === "quark") {
          const provider = runtime.providers.get("quark") as QuarkProvider;
          return { status: await provider.shareTransferTaskStatus(connection, request.params.taskId, { persistConnection }) };
        }
        if (!/^\d+$/u.test(request.params.taskId)) throw validationError("taskId", "光鸭转存任务参数无效");
        const data = await runtime.providers.guangyaWebClient.mutateFile(connection, "/userres/v1/get_task_status",
          { taskId: request.params.taskId }, persistConnection);
        const status = Number(data.status ?? -1);
        return { status: status === 2 ? "completed" : status === 3 ? "failed" : status === 0 ? "pending" : "running" };
      });
  }
}
