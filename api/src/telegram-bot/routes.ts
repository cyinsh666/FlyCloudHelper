import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import type { TelegramBotService } from "./service.js";
import type { TelegramPreferences } from "./store.js";

/** 用户绑定管理与机器人总开关；普通用户接口没有任意 userId 参数。 */
export async function registerTelegramBotRoutes(server: FastifyInstance, runtime: ApiRuntime, bot: TelegramBotService): Promise<void> {
  server.get("/api/v1/admin/telegram-bot", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return bot.status();
  });
  server.put<{ Body: { enabled?: unknown } }>("/api/v1/admin/telegram-bot", async (request) => {
    const actor = await requireSuperAdmin(request, runtime.database);
    if (typeof request.body?.enabled !== "boolean") throw validationError("enabled", "机器人开关必须是布尔值");
    try { return await bot.configure(request.body.enabled, actor.id); }
    catch (error) { throw error instanceof ApiError ? error : new ApiError(422, "telegram_bot_configuration", error instanceof Error ? error.message : "机器人配置失败"); }
  });

  /** 个人偏好只修改当前会话用户，沿用机器人目标、自动入库检查和同账号写锁。 */
  server.patch<{ Body: Record<string, unknown> }>("/api/v1/telegram/preferences", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw validationError("preferences", "个人偏好必须是对象");
    }
    // 关键变量：只把本次明确提供的字段写回，避免覆盖机器人同时修改的其他个人选项。
    const patch: Partial<TelegramPreferences> = {};
    if (Object.hasOwn(body, "defaultServiceId")) {
      if (body.defaultServiceId !== null && (typeof body.defaultServiceId !== "string" || !body.defaultServiceId.trim())) {
        throw validationError("defaultServiceId", "默认网盘必须是服务 ID，清空时请传 null");
      }
      patch.defaultServiceId = body.defaultServiceId as string | null;
    }
    if (Object.hasOwn(body, "notifications")) {
      if (typeof body.notifications !== "boolean") throw validationError("notifications", "个人任务通知必须是布尔值");
      patch.notifications = body.notifications;
    }
    if (Object.hasOwn(body, "autoImportServiceIds")) {
      const serviceIds = body.autoImportServiceIds;
      if (!Array.isArray(serviceIds) || serviceIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw validationError("autoImportServiceIds", "自动入库网盘必须是服务 ID 数组");
      }
      patch.autoImportServiceIds = [...new Set(serviceIds as string[])];
    }
    if (Object.keys(patch).length === 0) throw validationError("preferences", "没有可更新的个人偏好");

    if (patch.defaultServiceId || patch.autoImportServiceIds?.length) {
      // 关键变量：目标列表已限定当前用户及支持的网盘类型，不因管理员身份扩大范围。
      const targets = await bot.transfers.targets(user.id);
      if (patch.defaultServiceId && !targets.some((target) => target.id === patch.defaultServiceId)) {
        throw validationError("defaultServiceId", "请选择自己的光鸭或夸克网盘服务");
      }
      const current = await bot.store.preferences(user.id);
      for (const serviceId of patch.autoImportServiceIds ?? []) {
        // 历史项允许保留或逐项移除，不因服务已失效而阻止用户关闭其他自动入库项。
        if (current.autoImportServiceIds.includes(serviceId)) continue;
        if (!targets.some((target) => target.id === serviceId)) {
          throw validationError("autoImportServiceIds", "自动入库只能选择自己的光鸭或夸克网盘服务");
        }
        // 新增开启时沿用机器人的目录、整理能力和视频库扫描范围检查。
        try { await bot.transfers.validateImport(user.id, serviceId); }
        catch (error) {
          throw error instanceof ApiError ? error : validationError("autoImportServiceIds", error instanceof Error ? error.message : "当前服务不满足自动入库条件");
        }
      }
    }
    await bot.store.updatePreferences(user.id, (preferences) => {
      if (patch.defaultServiceId !== undefined) preferences.defaultServiceId = patch.defaultServiceId;
      if (patch.notifications !== undefined) preferences.notifications = patch.notifications;
      if (patch.autoImportServiceIds !== undefined) preferences.autoImportServiceIds = patch.autoImportServiceIds;
    });
    return { preferences: await bot.store.preferences(user.id) };
  });

  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/users/:userId/telegram" : "/api/v1/telegram";
    /** 后台先验证管理员，个人入口固定使用当前登录用户。 */
    async function owner(request: Parameters<typeof requireRequestUser>[0]): Promise<string> {
      if (!admin) return (await requireRequestUser(request, runtime.database)).id;
      await requireSuperAdmin(request, runtime.database);
      const userId = (request.params as { userId: string }).userId;
      await runtime.database.findPublicUserById(userId);
      return userId;
    }
    server.get(prefix, async (request) => {
      const userId = await owner(request);
      const [bindings, codes, preferences, status] = await Promise.all([
        bot.store.listBindings(userId), bot.store.listCodes(userId), bot.store.preferences(userId), bot.status(),
      ]);
      return { binding: bindings[0] ?? null, bindings, codes, preferences,
        bot: { enabled: status.enabled, username: status.username, workerEnabled: status.workerEnabled } };
    });
    server.post(`${prefix}/binding-code`, async (request, reply) => {
      const userId = await owner(request);
      reply.header("Cache-Control", "no-store");
      return bot.store.issueCode(userId);
    });
    server.post<{ Body: { action?: unknown; telegramId?: unknown } }>(`${prefix}/binding`, async (request) => {
      const userId = await owner(request);
      const action = request.body?.action;
      const telegramId = request.body?.telegramId;
      if (action !== "unbind" && (!admin || (action !== "disable" && action !== "enable"))) {
        throw validationError("action", "绑定操作无效");
      }
      if (telegramId !== undefined && (typeof telegramId !== "string" || !/^\d{1,16}$/u.test(telegramId))) {
        throw validationError("telegramId", "TG 账号 ID 无效");
      }
      await bot.store.manageBinding(userId, action, telegramId);
      return { success: true };
    });
  }
}
