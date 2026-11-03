import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { loadNotificationEventSettings, saveNotificationEventSettings } from "../notification-events.js";
import { telegramNotificationSettingName } from "../telegram-notification-service.js";

/** 写入 Telegram 通知设置相关的管理员审计记录。 */
async function auditTelegramSetting(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType: "system_configuration",
    targetId: telegramNotificationSettingName,
    result: "success",
    detail,
  });
}

/** 注册超级管理员的外部通知渠道设置接口。 */
export async function registerAdminNotificationSettingsRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/admin/notification-settings", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const [telegram, events] = await Promise.all([
      runtime.telegramNotifications.getSettings(), loadNotificationEventSettings(runtime.database),
    ]);
    return { telegram, events };
  });

  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/notification-settings/events", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const events = await saveNotificationEventSettings(runtime.database, request.body, operator.id);
    await runtime.database.addAudit({
      id: randomUUID(), operatorUserId: operator.id, operatorUsername: operator.username,
      operationType: "update_notification_events", targetType: "system_configuration",
      targetId: "notification_events", result: "success",
      detail: { 凭据异常: events.credentialAbnormal, 整理执行完成: events.organizeCompleted,
        扫描识别完成: events.scanCompleted, 视频规格分析完成: events.mediaProbeCompleted },
    });
    return { events };
  });

  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/notification-settings/telegram", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const settings = await runtime.telegramNotifications.saveSettings({
      enabled: request.body.enabled,
      botToken: request.body.botToken,
      chatId: request.body.chatId,
      telegramUserId: request.body.telegramUserId,
      updatedByUserId: operator.id,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-telegram-notification",
      事件: settings.enabled ? "更新并启用Telegram通知" : "更新并关闭Telegram通知",
      用户ID: operator.id,
      BotToken已配置: settings.botTokenConfigured,
      目标类型: settings.destinationType === "chat" ? "聊天" : "个人",
      配置修订: settings.configurationRevision,
    });
    await auditTelegramSetting(runtime, operator, "update_telegram_notification_channel", {
      是否启用: settings.enabled,
      BotToken已配置: settings.botTokenConfigured,
      目标类型: settings.destinationType === "chat" ? "聊天" : "个人",
      配置修订: settings.configurationRevision,
    });
    return { telegram: settings };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/notification-settings/telegram/test", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    try {
      await runtime.telegramNotifications.sendTestMessage({
        botToken: request.body.botToken,
        chatId: request.body.chatId,
        telegramUserId: request.body.telegramUserId,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-telegram-notification",
        事件: "Telegram测试通知发送成功",
        用户ID: operator.id,
      });
      await auditTelegramSetting(runtime, operator, "test_telegram_notification_channel", { 测试结果: "发送成功" });
      return { sent: true };
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-telegram-notification",
        事件: "Telegram测试通知发送失败",
        用户ID: operator.id,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  });
}
