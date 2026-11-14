import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import type { TelegramBotService } from "./service.js";

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
