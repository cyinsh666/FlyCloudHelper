import type { FlyCloudHelperDatabase } from "./database.js";
import type { NotificationRecord } from "./domain.js";
import { ApiError, validationError } from "./errors.js";
import type { ProtocolImageCache } from "./media/image-cache.js";
import type { CredentialVault } from "./secrets.js";

/** Telegram 通知配置在系统级加密配置表中的稳定标识。 */
export const telegramNotificationSettingName = "telegram_notification_channel";

export type TelegramDestinationType = "chat" | "user";

interface TelegramNotificationConfiguration {
  enabled: boolean;
  botToken: string;
  destinationType: TelegramDestinationType;
  destinationId: string;
  configurationRevision: number;
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  botTokenConfigured: boolean;
  destinationType: TelegramDestinationType;
  destinationId: string;
  chatId: string;
  telegramUserId: string;
  configurationRevision: number;
}

type TelegramNotificationLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

const notificationCategoryLabels: Record<NotificationRecord["category"], string> = {
  task: "任务",
  security: "敏感操作",
  system: "系统",
};

/** 校验 Telegram Bot Token，避免把明显错误的值保存为系统凭据。 */
function validateBotToken(value: unknown, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError("botToken", "Bot Token 不能为空");
    return "";
  }
  if (typeof value !== "string") {
    throw validationError("botToken", "Bot Token 格式无效");
  }
  const botToken = value.trim();
  if (!/^[1-9]\d{5,15}:[A-Za-z0-9_-]{20,100}$/u.test(botToken)) {
    throw validationError("botToken", "Bot Token 格式无效，请填写 BotFather 提供的完整 Token");
  }
  return botToken;
}

/** 校验 Telegram 目标类型。 */
function validateDestinationType(value: unknown): TelegramDestinationType {
  if (value !== "chat" && value !== "user") {
    throw validationError("destinationType", "Telegram 接收目标类型无效");
  }
  return value;
}

/** 校验可选的群聊 Chat ID，并把 t.me/ 后面的公开 ID 转成 Bot API 需要的 @目标。 */
function validateChatId(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  const chatId = String(value).trim();
  // 关键变量：页面只填写 t.me/ 后面的内容；已有 @ 配置仍可读取，最终统一交给 Bot API 使用。
  const publicChatName = chatId.startsWith("@") ? chatId.slice(1) : chatId;
  const publicChatIdValid = /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(publicChatName);
  const numericChatIdValid = /^-?[1-9]\d*$/u.test(chatId) && chatId.length <= 24;
  if (!publicChatIdValid && !numericChatIdValid) {
    throw validationError("chatId", "群聊 Chat ID 格式无效，请填写 t.me/ 后面的内容，例如 yaiinotice");
  }
  return publicChatIdValid ? `@${publicChatName}` : chatId;
}

/** 把 Bot API 使用的 @群聊目标转换为页面可编辑的 t.me/ 后缀。 */
function toEditableChatId(destinationId: string): string {
  return destinationId.startsWith("@") ? destinationId.slice(1) : destinationId;
}

/** 校验可选的个人 TG ID，并保留字符串精度。 */
function validateTelegramUserId(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  const telegramUserId = String(value).trim();
  if (!/^[1-9]\d*$/u.test(telegramUserId) || telegramUserId.length > 24) {
    throw validationError("telegramUserId", "个人 TG ID 必须是有效的正整数");
  }
  return telegramUserId;
}

/** 强制聊天 Chat ID 与个人 TG ID 二选一，并转换为 Telegram 的统一发送目标。 */
function resolveDestination(
  chatIdValue: unknown,
  telegramUserIdValue: unknown,
  required: boolean,
): { destinationType: TelegramDestinationType; destinationId: string; chatId: string; telegramUserId: string } {
  const chatId = validateChatId(chatIdValue);
  const telegramUserId = validateTelegramUserId(telegramUserIdValue);
  if (chatId && telegramUserId) {
    throw validationError("telegramTarget", "聊天 Chat ID 和个人 TG ID 只能填写一个，请清空其中一项");
  }
  if (required && !chatId && !telegramUserId) {
    throw validationError("telegramTarget", "聊天 Chat ID 和个人 TG ID 必须填写一个");
  }
  return {
    destinationType: telegramUserId ? "user" : "chat",
    destinationId: telegramUserId || chatId,
    chatId,
    telegramUserId,
  };
}

/** 把站内通知转换为适合 Telegram 阅读的纯文本。 */
function buildTelegramMessage(notification: Pick<NotificationRecord, "category" | "title" | "message">): string {
  return [
    `FlyCloudHelper · ${notificationCategoryLabels[notification.category]}`,
    notification.title,
    notification.message,
  ].join("\n\n");
}

/** 管理 Telegram 系统配置，并串行投递已有站内通知。 */
export class TelegramNotificationService {
  private deliveryQueue: Promise<void> = Promise.resolve();
  /** 机器人列表和菜单连续发消息时，按聊天及全局发送节奏排队。 */
  private readonly botNextSendAtByChat = new Map<string, number>();
  private botNextSendAt = 0;

  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    private readonly vault: CredentialVault,
    private readonly logger: TelegramNotificationLogger,
    private readonly imageCache: ProtocolImageCache,
  ) {}

  /** 机器人交互复用加密 Token；是否接收指令由独立机器人开关控制。 */
  public async callBotApi<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const configuration = await this.loadConfiguration();
    if (!configuration.botToken) throw new ApiError(422, "telegram_bot_token_missing", "请先在 Telegram 通知设置中保存 Bot Token");
    try {
      if ((method === "sendMessage" || method === "sendPhoto") && body.chat_id !== undefined) {
        const chatId = String(body.chat_id);
        const now = Date.now();
        const sendAt = Math.max(now, this.botNextSendAt, this.botNextSendAtByChat.get(chatId) ?? 0);
        this.botNextSendAt = sendAt + 40;
        this.botNextSendAtByChat.set(chatId, sendAt + 1100);
        for (const [key, next] of this.botNextSendAtByChat) if (next < now) this.botNextSendAtByChat.delete(key);
        if (sendAt > now) await new Promise<void>((resolve) => setTimeout(resolve, sendAt - now));
      }
      const response = await fetch(`https://api.telegram.org/bot${configuration.botToken}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(15_000),
      });
      const result = await response.json() as { ok: boolean; result: T; description?: string };
      if (!response.ok || !result.ok) throw new Error(result.description || `Telegram 返回 HTTP ${response.status}`);
      return result.result;
    } catch (error) {
      // 关键变量：底层异常可能包含请求地址，统一移除 Token 后再向外抛出。
      const message = error instanceof Error ? error.message : "Telegram 请求失败";
      throw new ApiError(502, "telegram_bot_request_failed", message.replaceAll(configuration.botToken, "[已脱敏]"));
    }
  }

  /** 读取脱敏后的 Telegram 通知设置。 */
  public async getSettings(): Promise<TelegramNotificationSettings> {
    const configuration = await this.loadConfiguration();
    return {
      enabled: configuration.enabled,
      botTokenConfigured: Boolean(configuration.botToken),
      destinationType: configuration.destinationType,
      destinationId: configuration.destinationId,
      chatId: configuration.destinationType === "chat" ? toEditableChatId(configuration.destinationId) : "",
      telegramUserId: configuration.destinationType === "user" ? configuration.destinationId : "",
      configurationRevision: configuration.configurationRevision,
    };
  }

  /** 保存通知设置；空 Bot Token 表示保留已经加密保存的 Token。 */
  public async saveSettings(input: {
    enabled: unknown;
    botToken: unknown;
    chatId: unknown;
    telegramUserId: unknown;
    updatedByUserId: string;
  }): Promise<TelegramNotificationSettings> {
    if (typeof input.enabled !== "boolean") {
      throw validationError("enabled", "Telegram 通知开关必须是布尔值");
    }
    const existing = await this.loadConfiguration();
    const submittedBotToken = validateBotToken(input.botToken, false);
    const botToken = submittedBotToken || existing.botToken;
    const destination = resolveDestination(input.chatId, input.telegramUserId, input.enabled);
    if (input.enabled && !botToken) {
      throw validationError("botToken", "首次启用 Telegram 通知时必须填写 Bot Token");
    }
    const configurationRevision = await this.database.saveSystemSecretSetting({
      settingKey: telegramNotificationSettingName,
      encryptedPayload: this.vault.encrypt({
        enabled: input.enabled,
        botToken,
        destinationType: destination.destinationType,
        destinationId: destination.destinationId,
      }),
      updatedByUserId: input.updatedByUserId,
    });
    return {
      enabled: input.enabled,
      botTokenConfigured: Boolean(botToken),
      destinationType: destination.destinationType,
      destinationId: destination.destinationId,
      chatId: toEditableChatId(destination.chatId),
      telegramUserId: destination.telegramUserId,
      configurationRevision,
    };
  }

  /** 使用当前表单目标和 Bot Token 发送云助手介绍，不修改已经保存的配置。 */
  public async sendTestMessage(input: {
    botToken: unknown;
    chatId: unknown;
    telegramUserId: unknown;
  }): Promise<void> {
    const existing = await this.loadConfiguration();
    const submittedBotToken = validateBotToken(input.botToken, false);
    const botToken = submittedBotToken || existing.botToken;
    if (!botToken) {
      throw new ApiError(422, "telegram_bot_token_missing", "请填写 Bot Token 或先保存 Bot Token");
    }
    const destination = resolveDestination(input.chatId, input.telegramUserId, true);
    await this.sendMessage({
      enabled: true,
      botToken,
      destinationType: destination.destinationType,
      destinationId: destination.destinationId,
      configurationRevision: existing.configurationRevision,
    }, [
      "FlyCloudHelper 云助手",
      "你好，我是 FlyCloudHelper 云助手。这里将为你推送媒体扫描、后台任务、系统状态和敏感操作通知，帮助你及时了解云端媒体服务的运行情况。",
      "这是一条 Telegram 通知渠道测试消息。",
    ].join("\n\n"));
  }

  /** 将已写入的站内通知加入串行队列，投递异常只记录日志。 */
  public enqueue(notification: NotificationRecord & { imageUrl?: string | null }): void {
    this.deliveryQueue = this.deliveryQueue
      .then(async () => {
        const configuration = await this.loadConfiguration();
        if (!configuration.enabled || !configuration.botToken || !configuration.destinationId) return;
        const text = buildTelegramMessage(notification);
        let sentAsPhoto = false;
        if (notification.imageUrl) {
          // 关键变量：Telegram 图片说明上限为 1024 字符，剩余通知内容另发文字消息。
          const characters = [...text];
          try {
            await this.sendPhoto(configuration, characters.slice(0, 1_000).join(""), notification.imageUrl);
            sentAsPhoto = true;
          } catch (error) {
            this.logger("warn", {
              日志关键字: "codex-flycloud-telegram-notification",
              事件: "Telegram通知图片发送失败，改发文字",
              通知标题: notification.title,
              错误信息: error instanceof Error ? error.message : "未知错误",
            });
          }
          if (sentAsPhoto && characters.length > 1_000) {
            await this.sendMessage(configuration, characters.slice(1_000).join(""));
          }
        }
        if (!sentAsPhoto) await this.sendMessage(configuration, text);
        this.logger("info", {
          日志关键字: "codex-flycloud-telegram-notification",
          事件: "Telegram通知发送成功",
          通知分类: notification.category,
          通知标题: notification.title,
          通知形式: sentAsPhoto ? "图片" : "文字",
          目标类型: configuration.destinationType === "chat" ? "聊天" : "个人",
          配置修订: configuration.configurationRevision,
        });
      })
      .catch((error: unknown) => {
        this.logger("warn", {
          日志关键字: "codex-flycloud-telegram-notification",
          事件: "Telegram通知发送失败",
          通知分类: notification.category,
          通知标题: notification.title,
          错误信息: error instanceof Error ? error.message : "未知错误",
        });
      });
  }

  /** 等待已经进入队列的通知结束，供服务关闭时收尾。 */
  public async close(): Promise<void> {
    await this.deliveryQueue;
  }

  /** 解密完整配置；没有配置时返回关闭状态。 */
  private async loadConfiguration(): Promise<TelegramNotificationConfiguration> {
    const setting = await this.database.getSystemSecretSetting(telegramNotificationSettingName);
    if (!setting) {
      return {
        enabled: false,
        botToken: "",
        destinationType: "chat",
        destinationId: "",
        configurationRevision: 0,
      };
    }
    const payload = this.vault.decrypt(setting.encryptedPayload);
    try {
      const destinationType = validateDestinationType(payload.destinationType);
      return {
        enabled: payload.enabled === true,
        botToken: validateBotToken(payload.botToken, false),
        destinationType,
        destinationId: destinationType === "chat"
          ? validateChatId(payload.destinationId)
          : validateTelegramUserId(payload.destinationId),
        configurationRevision: setting.revision,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(503, "telegram_notification_configuration_invalid", "Telegram 通知配置无法读取");
      }
      throw error;
    }
  }

  /** 调用 Telegram Bot API 发送一条纯文本消息，不把 Token 或目标写入日志。 */
  private async sendMessage(configuration: TelegramNotificationConfiguration, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${configuration.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: configuration.destinationId,
        text: text.slice(0, 4_096),
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || result?.ok !== true) {
      throw new Error(result?.description || `Telegram Bot API 返回 HTTP ${response.status}`);
    }
  }

  /** 从服务器图片缓存读取背景图，再以文件方式发送，避免 Telegram 无法访问源站图片地址。 */
  private async sendPhoto(configuration: TelegramNotificationConfiguration, caption: string, imageUrl: string): Promise<void> {
    const image = await this.imageCache.getOrFetch(imageUrl);
    const form = new FormData();
    form.append("chat_id", configuration.destinationId);
    form.append("caption", caption);
    form.append("photo", new Blob([new Uint8Array(image.body)], { type: image.contentType }),
      image.contentType.includes("png") ? "backdrop.png" : "backdrop.jpg");
    const response = await fetch(`https://api.telegram.org/bot${configuration.botToken}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || result?.ok !== true) {
      throw new Error(result?.description || `Telegram Bot API 返回 HTTP ${response.status}`);
    }
  }
}
