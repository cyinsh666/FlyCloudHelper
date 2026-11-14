import { randomUUID } from "node:crypto";
import type { NotificationRecord } from "../domain.js";
import type { ApiRuntime } from "../runtime.js";
import type { ServiceOrganizeManager } from "../organize/manager.js";
import type { ServiceOrganizeScheduler } from "../organize/schedule.js";
import type { MovieSubscriptionWorker } from "../subscriptions/worker.js";
import { TelegramInteractions, type TelegramUpdate } from "./interactions.js";
import { TelegramBotStore } from "./store.js";
import { TelegramTransfers } from "./transfers.js";

/** 机器人总开关与原管理员通知开关独立，复用同一 Bot Token。 */
export interface TelegramBotConfiguration { enabled: boolean; username: string | null }

/** 单实例长轮询和任务推进；共享数据库的多进程通过租约避免抢消息。 */
export class TelegramBotService {
  public readonly store: TelegramBotStore;
  public readonly transfers: TelegramTransfers;
  private readonly interactions: TelegramInteractions;
  private readonly instanceId = randomUUID();
  private stopping = false;
  private receiver: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private lease = false;
  private maintenance: Promise<void> | null = null;
  private taskTick: Promise<void> | null = null;
  private notificationQueue: Promise<void> = Promise.resolve();
  private error: string | null = null;
  private botRevision: number | null = null;
  private botId: number | null = null;

  public constructor(private readonly runtime: ApiRuntime, subscriptions: MovieSubscriptionWorker,
    manager: ServiceOrganizeManager, scheduler: ServiceOrganizeScheduler) {
    this.store = new TelegramBotStore(runtime.database);
    this.transfers = new TelegramTransfers(runtime, this.store, manager, scheduler);
    this.interactions = new TelegramInteractions(runtime, this.store, this.transfers, subscriptions, manager);
  }

  /** 配置和实际运行状态分开，关闭 Worker 的本地开发实例不会抢收消息。 */
  public async status() {
    const configuration = await this.store.get<TelegramBotConfiguration>("configuration", { enabled: false, username: null });
    return { ...configuration, workerEnabled: this.runtime.config.workerEnabled, receiving: Boolean(this.receiver && this.lease),
      error: this.error, botTokenConfigured: (await this.runtime.telegramNotifications.getSettings()).botTokenConfigured };
  }

  /** 开启时检查 Token 和 webhook 冲突，不擅自删除其他系统的 webhook。 */
  public async configure(enabled: boolean, actorUserId: string) {
    let username: string | null = null;
    if (enabled) {
      const bot = await this.runtime.telegramNotifications.callBotApi<{ id: number; username: string }>("getMe", {});
      const webhook = await this.runtime.telegramNotifications.callBotApi<{ url: string }>("getWebhookInfo", {});
      if (webhook.url) throw new Error("该机器人已设置 webhook，请先解除原接收配置后再启用云助手交互");
      username = bot.username;
    }
    await this.store.put("configuration", { enabled, username }, actorUserId);
    if (!enabled) this.pollAbort?.abort();
    this.error = null;
    return this.status();
  }

  /** 所有后台能力受同一个 Worker 环境开关控制。 */
  public start(): void {
    if (!this.runtime.config.workerEnabled) return;
    this.stopping = false;
    this.schedule(1000);
  }

  /** 先取消长轮询，再等待正在处理的更新和任务落库，最后释放接收租约。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.pollAbort?.abort();
    await this.receiver;
    await this.maintenance;
    await this.taskTick;
    await this.notificationQueue;
    await this.runtime.database.query("system_settings").where({ setting_key: "telegram_bot:lease", setting_value: this.instanceId }).delete();
  }

  /** 个人通知按所属用户分发，原有管理员通知继续走原队列。 */
  public enqueueNotification(notification: NotificationRecord): void {
    if (!this.runtime.config.workerEnabled || notification.category !== "task") return;
    this.notificationQueue = this.notificationQueue.then(async () => {
      const configuration = await this.store.get<TelegramBotConfiguration>("configuration", { enabled: false, username: null });
      if (!configuration.enabled) return;
      const bindings = (await this.store.listBindings(notification.userId)).filter((binding) => binding.enabled);
      if (!bindings.length) return;
      if (!(await this.store.preferences(notification.userId)).notifications) return;
      // 关键变量：管理员通知本来就发给同一个私聊时，不重复发送相同内容。
      const admin = await this.runtime.telegramNotifications.getSettings();
      const deliveries = await Promise.allSettled(bindings.map(async (binding) => {
        if (admin.enabled && admin.destinationId === binding.chatId) return;
        const current = await this.store.resolve(binding.telegramId);
        if (current?.userId !== notification.userId || current.generation !== binding.generation) return;
        await this.interactions.send(current.chatId, `${notification.title}\n\n${notification.message}`);
      }));
      for (const delivery of deliveries) {
        if (delivery.status === "rejected") this.log("个人任务通知发送失败", delivery.reason);
      }
    }).catch((error: unknown) => this.log("个人任务通知发送失败", error));
  }

  /** 网页转存保留用户任务记录，只有启用的自动入库选项才追加后续动作。 */
  public async trackTransfer(userId: string, serviceId: string, remoteTaskId: string, title: string,
    origin: "web" | "subscription", completed = false): Promise<void> {
    if (!(await this.store.listBindings(userId)).length) return;
    await this.transfers.track(userId, serviceId, remoteTaskId, title, origin, completed);
  }

  /** 每十秒续租，长轮询和慢搜索不会阻止续租。 */
  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.maintenance = this.maintain().catch((error) => this.log("机器人后台处理失败", error));
      void this.maintenance.finally(() => this.schedule(10_000));
    }, delay);
  }

  /** 同库仅一个进程推进机器人任务；即使交互关闭，已提交的任务继续运行。 */
  private async maintain(): Promise<void> {
    this.lease = await this.acquireLease();
    if (!this.lease || this.stopping) { this.pollAbort?.abort(); return; }
    // 关键变量：任务推进独立于长轮询，不让网盘状态查询阻塞 Telegram 接收。
    if (!this.taskTick) this.taskTick = this.transfers.tick().catch((error) => this.log("转存任务检查失败", error))
      .finally(() => { this.taskTick = null; });
    const configuration = await this.store.get<TelegramBotConfiguration>("configuration", { enabled: false, username: null });
    if (!configuration.enabled) { this.pollAbort?.abort(); return; }
    if (!this.receiver) {
      this.receiver = this.receive().catch((error) => this.log("Telegram 消息接收失败", error))
        .finally(() => { this.receiver = null; });
    }
  }

  /** 持久化 update offset；按用户并行处理，坏消息跳过，不阻塞后续消息。 */
  private async receive(): Promise<void> {
    const settings = await this.runtime.telegramNotifications.getSettings();
    if (this.botRevision !== settings.configurationRevision) {
      const bot = await this.runtime.telegramNotifications.callBotApi<{ id: number }>("getMe", {});
      const webhook = await this.runtime.telegramNotifications.callBotApi<{ url: string }>("getWebhookInfo", {});
      if (webhook.url) throw new Error("机器人已配置 webhook，无法同时使用长轮询");
      this.botId = bot.id;
      await this.runtime.telegramNotifications.callBotApi("setMyCommands", { commands: [
        { command: "start", description: "绑定账号或显示主菜单" }, { command: "search", description: "搜索资源" },
        { command: "transfer", description: "分享转存" }, { command: "subscribe", description: "添加订阅" },
        { command: "subscriptions", description: "我的订阅" }, { command: "tasks", description: "任务记录" },
        { command: "settings", description: "个人设置" }, { command: "help", description: "使用帮助" },
        { command: "cancel", description: "取消未提交的操作" },
      ] });
      this.botRevision = settings.configurationRevision;
    }
    const key = "offset:" + this.botId;
    let offset = await this.store.get<number>(key, 0);
    while (!this.stopping && this.lease && (await this.store.get<TelegramBotConfiguration>("configuration", { enabled: false, username: null })).enabled) {
      this.pollAbort = new AbortController();
      let updates: TelegramUpdate[];
      try {
        updates = await this.runtime.telegramNotifications.callBotApi<TelegramUpdate[]>("getUpdates", {
          offset, timeout: 25, limit: 20, allowed_updates: ["message", "callback_query"],
        }, this.pollAbort.signal);
      } catch (error) {
        if (this.stopping || this.pollAbort.signal.aborted) return;
        throw error;
      }
      if (!this.lease || this.stopping) return;
      await Promise.all(updates.map((update) => this.interactions.handle(update).catch((error) => this.log("消息处理失败，已跳过", error))));
      if (updates.length) {
        offset = Math.max(...updates.map((update) => update.update_id)) + 1;
        await this.store.put(key, offset);
      }
      this.error = null;
      if ((await this.runtime.telegramNotifications.getSettings()).configurationRevision !== this.botRevision) return;
    }
  }

  /** 数据库比较并交换续租；共享同一数据库时本机和飞牛不会同时接收。 */
  private async acquireLease(): Promise<boolean> {
    const now = new Date().toISOString();
    await this.runtime.database.query("system_settings").insert({ setting_key: "telegram_bot:lease", setting_value: this.instanceId,
      revision: 1, updated_by_user_id: null, created_at: now, updated_at: new Date(0).toISOString(),
    }).onConflict("setting_key").ignore();
    const changed = await this.runtime.database.query("system_settings").where({ setting_key: "telegram_bot:lease" })
      .andWhere((query) => query.where({ setting_value: this.instanceId }).orWhere("updated_at", "<", new Date(Date.now() - 90_000).toISOString()))
      .update({ setting_value: this.instanceId, updated_at: now });
    return changed > 0;
  }

  /** 诊断只输出中文字段和错误，不记录 Token、绑定码或分享密码。 */
  private log(event: string, error: unknown): void {
    this.error = error instanceof Error ? error.message.slice(0, 500) : "未知错误";
    this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-telegram-bot", 事件: event, 错误信息: this.error });
  }
}
