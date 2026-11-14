import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";
import { ResourceSearchEngine, readTelegramChannelPage, type TelegramChannelMessage } from "../resource-search/engine.js";
import { readShareTransferStatus, submitShareTransfer, type ShareTransferStatus } from "../resource-search/share-transfer.js";
import { getServiceTransferDirectory, getSubscriptionTransferRename } from "../resource-search/transfer-directory.js";
import type { ApiRuntime } from "../runtime.js";
import { matchSubscription } from "./matching.js";
import { listStoredSubscriptions, type MovieSubscription } from "./store.js";
import { prepareSubscriptionTransferRoot, finishSubscriptionTransferRoot, type SubscriptionTransferRoot } from "./transfer-root.js";

const subscriptionPollMs = 10 * 60_000;
// 关键变量：已提交的网盘转存任务每 30 秒查询一次，频道查找仍按独立周期执行。
const transferStatusPollMs = 30_000;
const feedPageLimit = 40;

interface ChannelCursor {
  activatedAt: string;
  lastMessageId: number;
  /** 本轮开始读取的时间，供正常巡检覆盖两轮之间的调度间隔。 */
  lastCheckedAt?: string;
}
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
  /** 使用独立接收目录的批次保存目录和提交时的身份快照。 */
  transferRoot?: SubscriptionTransferRoot;
  /** 网盘已完成时只重试命名，不再反复查询或提交分享。 */
  transferCompleted?: boolean;
  /** 只给本版本新确认完成的转存补发通知，不追发历史已完成记录。 */
  completionNotificationPending?: boolean;
  /** 同一远端转存任务跨频道出现时，沿用已记录的通知时间去重。 */
  completionNotificationAt?: string;
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

/** 按北京时间确定转存当天，避免服务器时区不同导致同一链接跨频道重复提交。 */
function transferDay(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10) : "";
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

  /** 启动后先检查一次，随后每 30 秒检查网盘任务状态和频道查找时间。 */
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

  /** 按作品过滤后再截取最近记录，避免较早作品被其他作品的记录挤出。 */
  public async recent(serviceId: string, identity?: Pick<MovieSubscription, "mediaType" | "tmdbId">): Promise<{ lastRunAt: string | null; nextRunAt: string; lastError: string | null;
    items: SubscriptionActivity[] }> {
    return this.serial(serviceId, async () => {
      const state = await this.readState(serviceId);
      const activities = identity ? state.activities.filter((item) => item.mediaType === identity.mediaType
        && item.tmdbId === identity.tmdbId) : state.activities;
      return { lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, lastError: state.lastError,
        items: [...activities].reverse().slice(0, 100) };
    });
  }

  /** 单部查找只处理指定作品；整服务查找继续沿用原来的巡检计划。 */
  public async runNow(serviceId: string, identity?: Pick<MovieSubscription, "mediaType" | "tmdbId">): Promise<{ lastError: string | null }> {
    return this.serial(serviceId, async () => {
      const subscriptions = (await listStoredSubscriptions(this.runtime.database)).filter((item) => item.serviceId === serviceId);
      if (!subscriptions.length) throw new ApiError(422, "subscription_empty", "当前网盘服务还没有影片订阅");
      if (identity && !subscriptions.some((item) => item.mediaType === identity.mediaType && item.tmdbId === identity.tmdbId)) {
        throw new ApiError(404, "subscription_missing", "该作品已不在当前网盘的订阅中");
      }
      return { lastError: await this.runService(await this.readState(serviceId), subscriptions, identity) };
    });
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
        .finally(() => { this.activeTick = null; this.schedule(transferStatusPollMs); });
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
    // 取消最后一条订阅后，已提交的批次仍须继续确认转存和完成命名。
    const stateFiles = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const file of stateFiles) {
      if (/^[0-9a-f-]{36}\.json$/iu.test(file) && !byService.has(file.slice(0, -5))) byService.set(file.slice(0, -5), []);
    }
    for (const [serviceId, items] of byService) {
      if (this.stopping) break;
      try {
        await this.serial(serviceId, async () => {
          const state = await this.readState(serviceId);
          if (!items.length) { await this.refreshTasks(state); return; }
          // 频道仍每十分钟查找一次；等待中的网盘任务在每 30 秒巡检时单独更新状态。
          if (state.nextRunAt > new Date().toISOString()) {
            if (state.activities.some((activity) => activity.completionNotificationPending || activity.taskId
              && (activity.status === "pending" || activity.status === "running"))) {
              await this.refreshTasks(state);
            }
            return;
          }
          await this.runService(state, items);
        });
      } catch (error) { this.logFailure("服务订阅巡检失败", serviceId, error); }
    }
  }

  /** 先查已提交的任务，再读取新消息；缺少目录或登录时不推进任何频道游标。 */
  private async runService(state: ServiceSubscriptionState, subscriptions: MovieSubscription[],
    identity?: Pick<MovieSubscription, "mediaType" | "tmdbId">): Promise<string | null> {
    const now = new Date();
    // 关键变量：单部查找不改变整网盘的下次巡检时间及最近巡检结果。
    if (!identity) {
      state.lastRunAt = now.toISOString();
      state.nextRunAt = new Date(now.getTime() + subscriptionPollMs).toISOString();
      state.lastError = null;
    }
    let lastError: string | null = null;
    try {
      for (const activity of state.activities) {
        if (identity && (activity.mediaType !== identity.mediaType || activity.tmdbId !== identity.tmdbId)) continue;
        if (activity.status === "submitting") {
          activity.status = "needs_review";
          activity.reason = "服务曾在提交期间中断，需核实目标目录后处理";
          activity.updatedAt = now.toISOString();
        }
      }
      const service = await this.runtime.repository.getServiceDetail(state.serviceId);
      if (service.providerType !== "guangya" && service.providerType !== "quark") {
        lastError = "当前网盘暂不支持自动转存";
        return lastError;
      }
      if (service.status !== "active" || service.connectionStatus !== "valid") {
        lastError = "网盘服务当前不可用";
        return lastError;
      }
      await this.refreshTasks(state, identity);
      if (!await getServiceTransferDirectory(this.runtime.database, state.serviceId)) {
        lastError = "请先设置服务的独立转存目录";
        return lastError;
      }
      const available = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled)
        .map((source) => source.key);
      const channels = await this.engine.serviceChannels(state.serviceId, available);
      if (!channels.length) { lastError = "请先为网盘服务选择关注频道"; return lastError; }
      if (!identity) {
        const selected = new Set(channels);
        for (const channel of Object.keys(state.channels)) if (!selected.has(channel)) delete state.channels[channel];
        for (const channel of channels) {
          if (!state.channels[channel]) state.channels[channel] = { activatedAt: now.toISOString(), lastMessageId: 0 };
        }
      }
      await this.saveState(state);
      const failures: string[] = [];
      for (const channel of channels) {
        if (this.stopping) break;
        try { await this.scanChannel(state, channel, service.providerType, service.userId, subscriptions, identity); }
        catch (error) {
          failures.push(`@${channel}：${error instanceof Error ? error.message : "频道读取失败"}`);
          this.logFailure("订阅频道巡检失败", state.serviceId, error, channel);
        }
      }
      lastError = failures.length ? failures.slice(0, 3).join("；") : null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "订阅巡检失败";
      this.logFailure("订阅服务运行失败", state.serviceId, error);
    } finally {
      if (!identity) state.lastError = lastError;
      await this.saveState(state);
    }
    return lastError;
  }

  /** 只读取最近窗口内的新消息，达到页数上限时直接使用当前结果并放弃更早积压。 */
  private async newerMessages(channel: string, cursor: ChannelCursor, sinceAt: string): Promise<TelegramChannelMessage[]> {
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
      if (oldest.postedAt && Number.isFinite(Date.parse(oldest.postedAt)) && !postedAfter(oldest.postedAt, sinceAt)) {
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
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-movie-subscription",
      事件: "订阅频道达到页数上限，放弃更早积压", 频道: channel, 读取页数: feedPageLimit,
      原消息位置: cursor.lastMessageId, 最新消息位置: Math.max(cursor.lastMessageId, ...found.keys()),
      查询起始时间: sinceAt });
    return [...found.values()].sort((a, b) => a.messageId - b.messageId);
  }

  /** 同一频道按消息顺序处理，成功落盘后才把最高消息 ID 写入游标。 */
  private async scanChannel(state: ServiceSubscriptionState, channel: string, providerType: string,
    ownerId: string, subscriptions: MovieSubscription[], identity?: Pick<MovieSubscription, "mediaType" | "tmdbId">): Promise<void> {
    const cursor = state.channels[channel] ?? { activatedAt: new Date().toISOString(), lastMessageId: 0 };
    const checkStartedAt = new Date();
    const previousCheck = cursor.lastCheckedAt ? Date.parse(cursor.lastCheckedAt) : NaN;
    // 关键变量：首次读取或长时间积压只取最近十分钟，正常轮询衔接上次读取时间。
    const sinceAt = Number.isFinite(previousCheck) && checkStartedAt.getTime() - previousCheck <= subscriptionPollMs * 2
      ? cursor.lastCheckedAt! : new Date(checkStartedAt.getTime() - subscriptionPollMs).toISOString();
    const messages = await this.newerMessages(channel, cursor, sinceAt);
    // 关键变量：本频道的一次巡检使用内存集合查重，避免随着历史记录增长反复扫描整个数组。
    const seenActivities = new Set(state.activities.map((item) => item.id));
    // 关键变量：已有提交记录的日期与链接指纹，同服务跨频道、跨消息当天只提交一次。
    const submittedLinksByDay = new Set(state.activities.filter((item) => item.status !== "skipped")
      .map((item) => `${transferDay(item.createdAt)}:${item.id.slice(item.id.lastIndexOf(":") + 1)}`));
    for (const message of messages) {
      if (this.stopping) break;
      if (!message.postedAt || !Number.isFinite(Date.parse(message.postedAt))) {
        for (const share of message.shares.filter((item) => item.cloudType === providerType)) {
          if (identity) {
            const matched = matchSubscription(share.title, subscriptions).subscription;
            if (matched?.mediaType !== identity.mediaType || matched.tmdbId !== identity.tmdbId) continue;
          }
          const digest = createHash("sha256").update(share.shareUrl).digest("hex");
          const id = `${message.channelId}:${message.messageId}:${digest}`;
          if (seenActivities.has(id)) continue;
          const now = new Date().toISOString();
          state.activities.push({ id, channel, channelId: message.channelId, messageId: message.messageId,
            messageUrl: `https://t.me/${channel}/${message.messageId}`, title: share.title,
            mediaType: identity?.mediaType ?? null, tmdbId: identity?.tmdbId ?? null,
            status: "skipped", reason: "消息缺少有效发布时间，无法确定是否属于新消息",
            taskId: null, createdAt: now, updatedAt: now });
          seenActivities.add(id);
          await this.saveState(state);
        }
      }
      if (postedAfter(message.postedAt, cursor.activatedAt) && postedAfter(message.postedAt, sinceAt)) {
        for (const share of message.shares.filter((item) => item.cloudType === providerType)) {
          const eligible = subscriptions.filter((item) => postedAfter(message.postedAt, item.createdAt));
          if (!eligible.length) continue;
          const matched = matchSubscription(share.title, eligible);
          // 关键变量：仍使用完整订阅集合判断同名歧义，但仅执行选中作品。
          if (identity && (matched.subscription?.mediaType !== identity.mediaType || matched.subscription.tmdbId !== identity.tmdbId)) continue;
          if (!matched.subscription && !matched.reason) continue;
          const digest = createHash("sha256").update(share.shareUrl).digest("hex");
          // 关键变量：频道、消息和分享链接共同确定一次转存，消息内多个分享互不覆盖。
          const activityId = `${message.channelId}:${message.messageId}:${digest}`;
          if (seenActivities.has(activityId)) continue;
          const now = new Date().toISOString();
          const linkDayKey = `${transferDay(now)}:${digest}`;
          const alreadySubmittedToday = Boolean(matched.subscription && submittedLinksByDay.has(linkDayKey));
          const activity: SubscriptionActivity = { id: activityId, channel, channelId: message.channelId, messageId: message.messageId,
            messageUrl: `https://t.me/${channel}/${message.messageId}`, title: share.title,
            mediaType: matched.subscription?.mediaType ?? null, tmdbId: matched.subscription?.tmdbId ?? null,
            status: matched.subscription && !alreadySubmittedToday ? "submitting" : "skipped",
            reason: alreadySubmittedToday ? "今天已提交相同分享链接，跳过重复转存" : matched.reason,
            taskId: null, createdAt: now, updatedAt: now };
          state.activities.push(activity);
          seenActivities.add(activityId);
          // 提交前先落盘；中途退出时保留待核实状态，不自动重发远端写请求。
          await this.saveState(state);
          if (!matched.subscription || alreadySubmittedToday) continue;
          submittedLinksByDay.add(linkDayKey);
          try {
            const subscription = matched.subscription;
            // 本次提交只读取一次开关，关闭时沿用直接转存，保留分享顶层结构。
            const replaceName = await getSubscriptionTransferRename(this.runtime.database, state.serviceId);
            const submitted = await submitShareTransfer(this.runtime, { serviceId: state.serviceId,
              shareUrl: share.shareUrl, password: share.password, actorUserId: ownerId, ownerId,
              // 分享失效、为空或目录分页失败时不会调用此函数，也就不会留下空接收目录。
              prepareSubscriptionDirectory: replaceName ? async () => {
                const root = await prepareSubscriptionTransferRoot(this.runtime, state.serviceId, subscription,
                  async (prepared) => { activity.transferRoot = prepared; await this.saveState(state); });
                return root.directory!;
              } : undefined });
            activity.status = "pending";
            activity.taskId = submitted.taskId;
            activity.updatedAt = new Date().toISOString();
            await this.saveState(state);
            await this.runtime.telegramBot?.trackTransfer(ownerId, state.serviceId, submitted.taskId,
              subscription.title, "subscription").catch((error) => this.logFailure("订阅转存跟踪保存失败", state.serviceId, error));
          } catch (error) {
            activity.status = "needs_review";
            activity.reason = error instanceof Error ? error.message : "转存提交结果不明";
            activity.updatedAt = new Date().toISOString();
            await this.saveState(state);
            this.logFailure("订阅转存需核实", state.serviceId, error, channel);
          }
        }
      }
      if (!identity) {
        cursor.lastMessageId = Math.max(cursor.lastMessageId, message.messageId);
        await this.saveState(state);
      }
    }
    if (!this.stopping && !identity) {
      cursor.lastCheckedAt = checkStartedAt.toISOString();
      await this.saveState(state);
    }
  }

  /** 已取得任务 ID 的分享只查询状态，失败也不直接重新提交。 */
  private async refreshTasks(state: ServiceSubscriptionState, identity?: Pick<MovieSubscription, "mediaType" | "tmdbId">): Promise<void> {
    // 关键变量：多个频道消息可能返回同一个网盘任务编号，本轮只向网盘查询一次。
    const checkedTasks = new Map<string, ShareTransferStatus | null>();
    for (const activity of state.activities) {
      if (identity && (activity.mediaType !== identity.mediaType || activity.tmdbId !== identity.tmdbId)) continue;
      if (activity.status === "completed" && activity.completionNotificationPending) {
        await this.notifyTransferCompleted(state, activity);
        continue;
      }
      if (!activity.taskId || (activity.status !== "pending" && activity.status !== "running")) continue;
      try {
        let status: ShareTransferStatus | null | undefined = activity.transferCompleted ? "completed" : checkedTasks.get(activity.taskId);
        if (status === undefined) {
          status = await readShareTransferStatus(this.runtime, state.serviceId, activity.taskId);
          checkedTasks.set(activity.taskId, status);
        }
        if (status === null) continue;
        if (status === "completed" && activity.transferRoot) {
          activity.transferCompleted = true;
          activity.status = "running";
          activity.reason = "网盘转存已完成，正在确认根目录命名";
          await this.saveState(state);
          const ready = await finishSubscriptionTransferRoot(this.runtime, state.serviceId, activity.transferRoot,
            async () => { activity.updatedAt = new Date().toISOString(); await this.saveState(state); });
          if (!ready) continue;
          activity.reason = null;
        }
        if (status === activity.status) continue;
        activity.status = status;
        activity.updatedAt = new Date().toISOString();
        if (status === "completed") activity.completionNotificationPending = true;
        await this.saveState(state);
        if (status === "completed") await this.notifyTransferCompleted(state, activity);
        if (status === "failed") await this.runtime.telegramBot?.transfers.subscriptionFailed(state.serviceId, activity.taskId)
          .catch((error) => this.logFailure("订阅失败状态同步失败", state.serviceId, error));
      } catch (error) {
        if (activity.transferCompleted) {
          activity.reason = `网盘转存已完成，根目录命名待重试：${error instanceof Error ? error.message : "未知错误"}`;
          activity.updatedAt = new Date().toISOString();
          await this.saveState(state);
          this.logFailure("订阅根目录命名待重试", state.serviceId, error, activity.channel);
        }
        if (!checkedTasks.has(activity.taskId)) {
          checkedTasks.set(activity.taskId, null);
          this.logFailure("订阅转存状态查询失败", state.serviceId, error, activity.channel);
        }
      }
    }
  }

  /** 确认转存及接收根命名都完成后提醒一次，通知异常不改变转存结果。 */
  private async notifyTransferCompleted(state: ServiceSubscriptionState, activity: SubscriptionActivity): Promise<void> {
    try {
      const notified = state.activities.find((other) => other.taskId === activity.taskId && other.completionNotificationAt);
      if (!notified) {
        const service = await this.runtime.repository.getServiceDetail(state.serviceId);
        if (activity.taskId) await this.runtime.telegramBot?.trackTransfer(service.userId, state.serviceId,
          activity.taskId, activity.transferRoot?.identity.title ?? activity.title, "subscription", true);
        const target = activity.transferRoot?.directory ?? await getServiceTransferDirectory(this.runtime.database, state.serviceId);
        await this.runtime.database.createNotification({
          userId: service.userId, category: "task", tone: "success", title: "订阅转存已完成",
          message: `服务“${service.displayName}”的订阅转存已完成：${activity.transferRoot?.identity.title ?? activity.title}。`
            + (target ? `\n保存目录：${target.displayPath}` : "") + `\n来源：${activity.messageUrl}`,
          actionPath: `/app/services/${state.serviceId}`,
        });
      }
      activity.completionNotificationAt = notified?.completionNotificationAt ?? new Date().toISOString();
      activity.completionNotificationPending = false;
      await this.saveState(state);
    } catch (error) {
      this.logFailure("订阅转存完成通知失败", state.serviceId, error, activity.channel);
    }
  }

  /** 业务日志只记录可读字段，不输出分享地址、密码或网页凭据。 */
  private logFailure(event: string, serviceId: string, error: unknown, channel = ""): void {
    this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-movie-subscription", 事件: event,
      服务ID: serviceId, 频道: channel, 错误信息: error instanceof Error ? error.message : String(error) });
  }
}
