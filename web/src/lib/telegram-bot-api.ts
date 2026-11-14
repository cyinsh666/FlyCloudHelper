import { requestJson } from "./api";

/** 网页只读取绑定摘要，Bot Token 继续由原通知设置维护。 */
export interface TelegramBindingSummary {
  bindings: Array<{ telegramId: string; displayName: string; enabled: boolean; boundAt: string }>;
  codes: TelegramBindingCode[];
  bot: { enabled: boolean; username: string | null; workerEnabled: boolean };
}

/** 已发放绑定码的列表只返回标识和有效期。 */
export interface TelegramBindingCode {
  id: string;
  expiresAt: string;
}

export interface TelegramBotStatus {
  enabled: boolean;
  username: string | null;
  workerEnabled: boolean;
  receiving: boolean;
  botTokenConfigured: boolean;
  error: string | null;
}

/** 管理端仅指定目标用户，个人端由服务端从登录会话读取用户。 */
function bindingPath(userId?: string): string {
  return userId ? `/api/v1/admin/users/${encodeURIComponent(userId)}/telegram` : "/api/v1/telegram";
}

/** 读取用户的机器人绑定状态。 */
export function getTelegramBinding(userId?: string): Promise<TelegramBindingSummary> {
  return requestJson(bindingPath(userId));
}

/** 一次性绑定码只在生成响应中展示，刷新后不回显。 */
export function generateTelegramBindingCode(userId?: string): Promise<TelegramBindingCode & { code: string }> {
  return requestJson(bindingPath(userId) + "/binding-code", { method: "POST" });
}

/** 个人只可解绑，启停授权由管理员处理。 */
export function manageTelegramBinding(action: "enable" | "disable" | "unbind", telegramId: string, userId?: string): Promise<{ success: boolean }> {
  return requestJson(bindingPath(userId) + "/binding", { method: "POST", body: JSON.stringify({ action, telegramId }) });
}

/** 读取后台机器人接收状态。 */
export function getTelegramBotStatus(): Promise<TelegramBotStatus> { return requestJson("/api/v1/admin/telegram-bot"); }

/** 复用已有通知 Bot 的 Token，单独控制交互是否开启。 */
export function configureTelegramBot(enabled: boolean): Promise<TelegramBotStatus> {
  return requestJson("/api/v1/admin/telegram-bot", { method: "PUT", body: JSON.stringify({ enabled }) });
}
