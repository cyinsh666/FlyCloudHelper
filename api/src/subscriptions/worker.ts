import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import { ResourceSearchEngine, readTelegramChannelPage, type TelegramChannelMessage } from "../resource-search/engine.js";
import { readShareTransferStatus, submitShareTransfer } from "../resource-search/share-transfer.js";
import { getServiceTransferDirectory } from "../resource-search/transfer-directory.js";
import type { ApiRuntime } from "../runtime.js";
import { matchSubscription } from "./matching.js";
import { listStoredSubscriptions, type MovieSubscription } from "./store.js";

const subscriptionPollMs = 10 * 60_000;
const feedPageLimit = 40;

interface ChannelCursor { activatedAt: string; lastMessageId: number }
export interface SubscriptionActivity {
  id: string;
  channel: string;
  channelId: string;
  messageId: number;
  messageUrl: string;
  title: string;
  mediaType: "movie" | "tv" | null;
  tmdbId: number | null;
  status: "skipped" | "submitting" | "pending" | "running" | "completed" | "failed" | "needs_review";
  reason: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ServiceSubscriptionState {
  serviceId: string;
  channels: Record<string, ChannelCursor>;
  activities: SubscriptionActivity[];
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

/** 统一按时间戳比较消息时间，避免 Telegram 的时区偏移与 UTC 字符串直接比较。 */
function postedAfter(postedAt: string | null, sinceAt: string): boolean {
  if (!postedAt) return false;
  const posted = Date.parse(postedAt);
  const since = Date.parse(sinceAt);
  return Number.isFinite(posted) && Number.isFinite(since) && posted > since;
}

/** 订阅状态按服务单独保存在已有 data/exports 下，不修改数据库结构。 */
export class MovieSubscriptionWorker {
  private readonly directory: string;
  private readonly engine: ResourceSearchEngine;
  private readonly locks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;

  public constructor(private readonly runtime: ApiRuntime) {
    this.directory = path.join(runtime.config.exportDirectory, "movie-subscriptions");
    this.engine = new ResourceSearchEngine(runtime.database);
  }

  /** 启动后先检查一次，随后每分钟检查哪些服务到了十分钟巡检时间。 */
  public start(): void { this.stopping = false; this.schedule(1000); }

  /** 停止接收新巡检并等当前持久写入结束。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.activeTick;
    await Promise.all(this.locks.values());
  }

  /** 新订阅以创建时间为基线；已有频道游标继续使用，不回看旧消息。 */
  public async noteSubscriptionCreated(serviceId: string, createdAt: string): Promise<void> {
    const previouslySubscribed = (await listStoredSubscriptions(this.runtime.database))
      .some((item) => item.serviceId === serviceId);
    const available = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled)
      .map((source) => source.key);
    const channels = await this.engine.serviceChannels(serviceId, available);
    await this.serial(serviceId, async () => {
      const state = await this.readState(serviceId);
      for (const channel of channels) {
        if (!previouslySubscribed || !state.channels[channel]) {
          state.channels[channel] = { activatedAt: createdAt, lastMessageId: 0 };
        }
      }
      await this.saveState(state);
    });
  }

  /** 关注频道变更后，新频道从保存时起算，移除频道立即停止巡检。 */
  public async noteChannelsChanged(serviceId: string, channels: string[]): Promise<void> {
    await this.serial(serviceId, async () => {
      const state = await this.readState(serviceId);
      const selected = new Set(channels);
      for (const channel of Object.keys(state.channels)) if (!selected.has(channel)) delete state.channels[channel];
      const now = new Date().toISOString();
      for (const channel of channels) {
        if (!state.channels[channel]) state.channels[channel] = { activatedAt: now, lastMessageId: 0 };
      }
      state.nextRunAt = now;
      await this.saveState(state);
    });
  }

  /** 用户设置页只展示本服务最近的转存与跳过记录，不返回分享令牌。 */
  public async recent(serviceId: string): Promise<{ lastRunAt: string | null; nextRunAt: string; lastError: string | null;
    items: SubscriptionActivity[] }> {
    return this.serial(serviceId, async () => {
      const state = await this.readState(serviceId);
      return { lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, lastError: state.lastError,
        items: [...state.activities].reverse().slice(0, 100) };
    });
  }

  /** 用户主动检查当前服务时立即执行，并从本次运行重新计算下次巡检。 */
  public async runNow(serviceId: string): Promise<void> {
    const subscriptions = (await listStoredSubscriptions(this.runtime.database)).filter((item) => item.serviceId === serviceId);
    if (!subscriptions.length) throw new ApiError(422, "subscription_empty", "当前网盘服务还没有影片订阅");
    await this.serial(serviceId, async () => this.runService(await this.readState(serviceId), subscriptions));
  }

  /** 同一服务的频道变更、巡检和状态查询串行，避免 JSON 文件写入互相覆盖。 */
  private async serial<T>(serviceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(serviceId) ?? Promise.resolve();
    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => barrier);
    this.locks.set(serviceId, current);
    await previous.catch(() => {});
    try { return await action(); }
    finally { release(); if (this.locks.get(serviceId) === current) this.locks.delete(serviceId); }
  }

  /** 文件名只接受服务 UUID，防止状态文件逃出 data 目录。 */
  private fileName(serviceId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(serviceId)) throw new Error("订阅服务 ID 无效");
    return path.join(this.directory, `${serviceId}.json`);
  }

  /** 新服务默认立即巡检；已有文件损坏时明确报错，不重建游标造成重复转存。 */
  private async readState(serviceId: string): Promise<ServiceSubscriptionState> {
    try {
      const state = JSON.parse(await fs.readFile(this.fileName(serviceId), "utf8")) as ServiceSubscriptionState;
      if (state.serviceId !== serviceId || !state.channels || !Array.isArray(state.activities)
        || typeof state.nextRunAt !== "string") throw new Error("订阅状态文件内容无效");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { serviceId, channels: {}, activities: [], nextRunAt: new Date().toISOString(),
        lastRunAt: null, lastError: null };
    }
  }

  /** 同目录原子替换状态文件，提交前的占位记录也必须落盘。 */
  private async saveState(state: ServiceSubscriptionState): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fileName = this.fileName(state.serviceId);
    const temporary = `${fileName}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, fileName);
  }

  /** 定时器只保留一个；上轮结束后再安排下一次，避免重叠巡检。 */
  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.activeTick = this.tick().catch((error) => this.logFailure("订阅巡检入口失败", "", error))
        .finally(() => { this.activeTick = null; this.schedule(60_000); });
    }, delayMs);
  }

  /** 找出有订阅的光鸭、夸克服务，每个服务独立记录下一次运行时间。 */
  private async tick(): Promise<void> {
    const subscriptions = await listStoredSubscriptions(this.runtime.database);
    const byService = new Map<string, MovieSubscription[]>();
    for (const item of subscriptions) {
      const group = byService.get(item.serviceId) ?? [];
      group.push(item);
      byService.set(item.serviceId, group);
    }
    for (const [serviceId, items] of byService) {
      if (this.stopping) break;
      try {
        await this.serial(serviceId, async () => {
          const state = await this.readState(serviceId);
          if (state.nextRunAt > new Date().toISOString()) return;
          await this.runService(state, items);
        });
      } catch (error) { this.logFailure("服务订阅巡检失败", serviceId, error); }
    }
  }

  /** 先查已提交的任务，再读取新消息；缺少目录或登录时不推进任何频道游标。 */
  private async runService(state: ServiceSubscriptionState, subscriptions: MovieSubscription[]): Promise<void> {
    const now = new Date();
    state.lastRunAt = now.toISOString();
    state.nextRunAt = new Date(now.getTime() + subscriptionPollMs).toISOString();
    state.lastError = null;
    try {
      for (const activity of state.activities) {
        if (activity.status === "submitting") {
          activity.status = "needs_review";
          activity.reason = "服务曾在提交期间中断，需核实目标目录后处理";
          activity.updatedAt = now.toISOString();
        }
      }
      const service = await this.runtime.repository.getServiceDetail(state.serviceId);
      if (service.providerType !== "guangya" && service.providerType !== "quark") {
        state.lastError = "当前网盘暂不支持自动转存";
        return;
      }
      if (service.status !== "active" || service.connectionStatus !== "valid") {
        state.lastError = "网盘服务当前不可用";
        return;
      }
      await this.refreshTasks(state);
      if (!await getServiceTransferDirectory(this.runtime.database, state.serviceId)) {
        state.lastError = "请先设置服务的独立转存目录";
        return;
      }
      const available = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled)
        .map((source) => source.key);
      const channels = await this.engine.serviceChannels(state.serviceId, available);
      if (!channels.length) { state.lastError = "请先为网盘服务选择关注频道"; return; }
      const selected = new Set(channels);
      for (const channel of Object.keys(state.channels)) if (!selected.has(channel)) delete state.channels[channel];
      for (const channel of channels) {
        if (!state.channels[channel]) state.channels[channel] = { activatedAt: now.toISOString(), lastMessageId: 0 };
      }
      await this.saveState(state);
      const failures: string[] = [];
      for (const channel of channels) {
        if (this.stopping) break;
        try { await this.scanChannel(state, channel, service.providerType, service.userId, subscriptions); }
        catch (error) {
          failures.push(`@${channel}：${error instanceof Error ? error.message : "频道读取失败"}`);
          this.logFailure("订阅频道巡检失败", state.serviceId, error, channel);
        }
      }
      state.lastError = failures.length ? failures.slice(0, 3).join("；") : null;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "订阅巡检失败";
      this.logFailure("订阅服务运行失败", state.serviceId, error);
    } finally { await this.saveState(state); }
  }

  /** 分页读到旧游标或激活时间为止；页数超限则不推进游标，留待后续核实。 */
  private async newerMessages(channel: string, cursor: ChannelCursor): Promise<TelegramChannelMessage[]> {
    const found = new Map<number, TelegramChannelMessage>();
    let before: number | undefined;
    for (let page = 0; page < feedPageLimit; page += 1) {
      const messages = await readTelegramChannelPage(channel, before);
      if (!messages.length) return [...found.values()].sort((a, b) => a.messageId - b.messageId);
      const oldest = messages[0]!;
      for (const message of messages) {
        if (message.messageId > cursor.lastMessageId) found.set(message.messageId, message);
      }
      if (cursor.lastMessageId > 0 && oldest.messageId <= cursor.lastMessageId) {
        return [...found.values()].sort((a, b) => a.messageId - b.messageId);
      }
      if (cursor.lastMessageId === 0 && oldest.postedAt && !Number.isFinite(Date.parse(oldest.postedAt))) {
        throw new Error("Telegram 消息发布时间无效，无法确定订阅起点");
      }
      if (cursor.lastMessageId === 0 && oldest.postedAt && !postedAfter(oldest.postedAt, cursor.activatedAt)) {
        return [...found.values()].sort((a, b) => a.messageId - b.messageId);
      }
      if (cursor.lastMessageId === 0 && !oldest.postedAt) throw new Error("Telegram 消息缺少发布时间，无法确定订阅起点");
      if (before !== undefined && oldest.messageId >= before) throw new Error("Telegram 频道分页未前进");
      before = oldest.messageId;
    }
    throw new Error("Telegram 新消息过多，超过单次巡检页数上限");
  }

  /** 同一频道按消息顺序处理，成功落盘后才把最高消息 ID 写入游标。 */
  private async scanChannel(state: ServiceSubscriptionState, channel: string, providerType: string,
    ownerId: string, subscriptions: MovieSubscription[]): Promise<void> {
    const cursor = state.channels[channel]!;
    const messages = await this.newerMessages(channel, cursor);
    // 关键变量：本频道的一次巡检使用内存集合查重，避免随着历史记录增长反复扫描整个数组。
    const seenActivities = new Set(state.activities.map((item) => item.id));
    for (const message of messages) {
      if (this.stopping) break;
      if (!message.postedAt || !Number.isFinite(Date.parse(message.postedAt))) {
        for (const share of message.shares.filter((item) => item.cloudType === providerType)) {
          const digest = createHash("sha256").update(share.shareUrl).digest("hex");
          const id = `${message.channelId}:${message.messageId}:${digest}`;
          if (seenActivities.has(id)) continue;
          const now = new Date().toISOString();
          state.activities.push({ id, channel, channelId: message.channelId, messageId: message.messageId,
            messageUrl: `https://t.me/${channel}/${message.messageId}`, title: share.title,
            mediaType: null, tmdbId: null, status: "skipped", reason: "消息缺少有效发布时间，无法确定是否属于新消息",
            taskId: null, createdAt: now, updatedAt: now });
          seenActivities.add(id);
          await this.saveState(state);
        }
      }
      if (postedAfter(message.postedAt, cursor.activatedAt)) {
        for (const share of message.shares.filter((item) => item.cloudType === providerType)) {
          const eligible = subscriptions.filter((item) => postedAfter(message.postedAt, item.createdAt));
          if (!eligible.length) continue;
          const matched = matchSubscription(share.title, eligible);
          if (!matched.subscription && !matched.reason) continue;
          const digest = createHash("sha256").update(share.shareUrl).digest("hex");
          // 关键变量：频道、消息和分享链接共同确定一次转存，消息内多个分享互不覆盖。
          const activityId = `${message.channelId}:${message.messageId}:${digest}`;
          if (seenActivities.has(activityId)) continue;
          const now = new Date().toISOString();
          const activity: SubscriptionActivity = { id: activityId, channel, channelId: message.channelId, messageId: message.messageId,
            messageUrl: `https://t.me/${channel}/${message.messageId}`, title: share.title,
            mediaType: matched.subscription?.mediaType ?? null, tmdbId: matched.subscription?.tmdbId ?? null,
            status: matched.subscription ? "submitting" : "skipped", reason: matched.reason,
            taskId: null, createdAt: now, updatedAt: now };
          state.activities.push(activity);
          seenActivities.add(activityId);
          // 提交前先落盘；中途退出时保留待核实状态，不自动重发远端写请求。
          await this.saveState(state);
          if (!matched.subscription) continue;
          try {
            const submitted = await submitShareTransfer(this.runtime, { serviceId: state.serviceId,
              shareUrl: share.shareUrl, password: share.password, actorUserId: ownerId, ownerId });
            activity.status = "pending";
            activity.taskId = submitted.taskId;
            activity.updatedAt = new Date().toISOString();
            await this.saveState(state);
          } catch (error) {
            activity.status = "needs_review";
            activity.reason = error instanceof Error ? error.message : "转存提交结果不明";
            activity.updatedAt = new Date().toISOString();
            await this.saveState(state);
            this.logFailure("订阅转存需核实", state.serviceId, error, channel);
          }
        }
      }
      cursor.lastMessageId = Math.max(cursor.lastMessageId, message.messageId);
      await this.saveState(state);
    }
  }

  /** 已取得任务 ID 的分享只查询状态，失败也不直接重新提交。 */
  private async refreshTasks(state: ServiceSubscriptionState): Promise<void> {
    for (const activity of state.activities) {
      if (!activity.taskId || (activity.status !== "pending" && activity.status !== "running")) continue;
      try {
        activity.status = await readShareTransferStatus(this.runtime, state.serviceId, activity.taskId);
        activity.updatedAt = new Date().toISOString();
        await this.saveState(state);
      } catch (error) { this.logFailure("订阅转存状态查询失败", state.serviceId, error, activity.channel); }
    }
  }

  /** 业务日志只记录可读字段，不输出分享地址、密码或网页凭据。 */
  private logFailure(event: string, serviceId: string, error: unknown, channel = ""): void {
    this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-movie-subscription", 事件: event,
      服务ID: serviceId, 频道: channel, 错误信息: error instanceof Error ? error.message : String(error) });
  }
}
