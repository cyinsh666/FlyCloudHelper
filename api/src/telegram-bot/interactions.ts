import { randomBytes } from "node:crypto";
import type { ApiRuntime } from "../runtime.js";
import type { ServiceOrganizeManager } from "../organize/manager.js";
import { ResourceSearchEngine, parseGuangyaShareUrl, parseQuarkShareUrl, type ShareSearchResult } from "../resource-search/engine.js";
import { getServiceTransferDirectory } from "../resource-search/transfer-directory.js";
import { createMovieSubscription } from "../subscriptions/actions.js";
import { listStoredSubscriptions, subscriptionSettingKey, type MovieSubscription } from "../subscriptions/store.js";
import type { MovieSubscriptionWorker } from "../subscriptions/worker.js";
import { TelegramBotStore, type TelegramBinding, type TelegramTransferTask } from "./store.js";
import { TelegramTransfers } from "./transfers.js";

/** 仅接收个人聊天中的文本和按钮，不接收群内代操作。 */
export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string }; from?: { id: number; first_name?: string; username?: string } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number; type: string } } };
}

interface Button { text: string; callback_data?: string; url?: string }
interface Action { telegramId: string; generation: string; expiresAt: number; execute: (binding: TelegramBinding) => Promise<void> }
interface Dialogue { mode: "search" | "subscribe" | "transfer"; generation: string; expiresAt: number }

const mainKeyboard = { keyboard: [[{ text: "搜索资源" }, { text: "分享转存" }],
  [{ text: "添加订阅" }, { text: "我的订阅" }], [{ text: "任务记录" }, { text: "个人设置" }],
  [{ text: "使用帮助" }]], resize_keyboard: true };

/** 中文菜单和分步确认只维护交互状态，实际权限由现有业务再次校验。 */
export class TelegramInteractions {
  private readonly engine: ResourceSearchEngine;
  private readonly actions = new Map<string, Action>();
  private readonly dialogues = new Map<string, Dialogue>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(private readonly runtime: ApiRuntime, private readonly store: TelegramBotStore,
    private readonly transfers: TelegramTransfers, private readonly subscriptions: MovieSubscriptionWorker,
    private readonly manager: ServiceOrganizeManager) {
    this.engine = new ResourceSearchEngine(runtime.database);
  }

  /** 同一 TG 用户串行处理，其他用户可同时搜索或操作。 */
  public async handle(update: TelegramUpdate): Promise<void> {
    const telegramId = String(update.callback_query?.from.id ?? update.message?.from?.id ?? "");
    if (!telegramId) return;
    const previous = this.queues.get(telegramId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.process(update, telegramId));
    this.queues.set(telegramId, current);
    try { await current; } finally { if (this.queues.get(telegramId) === current) this.queues.delete(telegramId); }
  }

  /** 发送纯文本和按钮，标题、资源名和错误信息不作为 Telegram 富文本解析。 */
  public async send(chatId: string, text: string, rows?: Button[][]): Promise<void> {
    await this.runtime.telegramNotifications.callBotApi("sendMessage", { chat_id: chatId, text: text.slice(0, 4000),
      link_preview_options: { is_disabled: true }, ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}) });
  }

  /** 消息和回调都重新解析绑定；失效码和旧按钮不产生业务任务。 */
  private async process(update: TelegramUpdate, telegramId: string): Promise<void> {
    const chat = update.callback_query?.message?.chat ?? update.message?.chat;
    if (!chat || chat.type !== "private" || String(chat.id) !== telegramId) return;
    this.prune();
    const callback = update.callback_query;
    if (callback) await this.runtime.telegramNotifications.callBotApi("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
    try {
      const binding = await this.store.resolve(telegramId);
      if (!binding) {
        const existing = await this.store.get<{ userId: string } | null>("identity:" + telegramId, null);
        if (existing) { await this.send(telegramId, "当前绑定或云助手账号已停用，请联系管理员处理。"); return; }
        const text = update.message?.text?.trim() ?? "";
        if (text === "使用帮助" || text === "/help") { await this.send(telegramId, "请联系管理员在云助手用户管理中生成绑定码，然后在本私聊发送绑定码。绑定码有效期十分钟，仅可使用一次。"); return; }
        const code = text.replace(/^\/start\s+/u, "").replace(/^\/bind\s+/u, "");
        if (!/^[A-Fa-f0-9]{12}$/u.test(code)) {
          await this.runtime.telegramNotifications.callBotApi("sendMessage", { chat_id: telegramId,
            text: "欢迎使用云助手。请发送后台为你的云助手用户生成的绑定码。", reply_markup: { remove_keyboard: true } });
          return;
        }
        const attempt = this.attempts.get(telegramId) ?? { count: 0, until: Date.now() + 60_000 };
        if (++attempt.count > 5) { await this.send(telegramId, "绑定尝试过于频繁，请一分钟后再试。"); return; }
        this.attempts.set(telegramId, attempt);
        const from = update.message!.from!;
        const saved = await this.store.bind(code, telegramId, telegramId, from.username ? "@" + from.username : from.first_name ?? "TG 用户");
        this.attempts.delete(telegramId);
        const user = await this.runtime.database.findPublicUserById(saved.userId);
        await this.home(saved, `绑定成功，当前云助手用户：${user.username}。`);
        return;
      }
      if (callback) {
        const key = callback.data ?? "";
        const action = this.actions.get(key);
        if (!action || action.telegramId !== telegramId || action.generation !== binding.generation || action.expiresAt < Date.now()) {
          await this.send(telegramId, "该操作已失效，请从菜单重新开始。"); return;
        }
        // 关键变量：执行前消费按钮，双击和 Telegram 重送不能重复提交。
        this.actions.delete(key);
        await action.execute(binding);
        return;
      }
      const text = update.message?.text?.trim() ?? "";
      if (!text) { await this.send(telegramId, "请发送文字、分享链接，或使用下方菜单。"); return; }
      const command = text.split(/\s/u, 1)[0]!.split("@", 1)[0]!;
      const menu = ({ "/start": "主菜单", "/menu": "主菜单", "/cancel": "主菜单", "/search": "搜索资源",
        "/transfer": "分享转存", "/subscribe": "添加订阅", "/subscriptions": "我的订阅", "/tasks": "任务记录",
        "/settings": "个人设置", "/help": "使用帮助" } as Record<string, string>)[command] ?? text;
      if (["主菜单", "取消操作", "返回主菜单", "搜索资源", "分享转存", "添加订阅", "我的订阅", "任务记录", "个人设置", "使用帮助"].includes(menu)) {
        this.reset(telegramId);
        if (menu === "搜索资源" || menu === "添加订阅" || menu === "分享转存") {
          const mode = menu === "搜索资源" ? "search" : menu === "添加订阅" ? "subscribe" : "transfer";
          const argument = command.startsWith("/") ? text.slice(text.indexOf(" ") + 1).trim() : "";
          if (argument && argument !== text) { await this.input(binding, mode, argument); return; }
          this.dialogues.set(telegramId, { mode, generation: binding.generation, expiresAt: Date.now() + 30 * 60_000 });
          await this.send(telegramId, mode === "transfer" ? "请发送分享链接及提取码。" : "请输入作品名称。",
            [[this.button(binding, "取消操作", (b) => this.home(b))]]);
        } else if (menu === "我的订阅") await this.showSubscriptions(binding);
        else if (menu === "任务记录") await this.showTasks(binding, false);
        else if (menu === "个人设置") await this.settings(binding);
        else if (menu === "使用帮助") await this.help(binding);
        else await this.home(binding);
        return;
      }
      if (/https?:\/\//iu.test(text)) { this.reset(telegramId); await this.input(binding, "transfer", text); return; }
      const dialogue = this.dialogues.get(telegramId);
      if (dialogue && dialogue.generation === binding.generation && dialogue.expiresAt > Date.now()) {
        this.dialogues.delete(telegramId);
        await this.input(binding, dialogue.mode, text);
      } else await this.home(binding, "请选择下方功能，或直接发送分享链接。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败，请重新操作";
      this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-telegram-bot", 事件: "机器人交互失败", 错误信息: message });
      await this.send(telegramId, message.slice(0, 800)).catch(() => undefined);
    }
  }

  /** 展示主菜单并清空未提交的流程，已提交后台任务继续执行。 */
  private async home(binding: TelegramBinding, message = "请选择功能，也可以直接发送分享链接。"): Promise<void> {
    this.reset(binding.telegramId);
    await this.runtime.telegramNotifications.callBotApi("sendMessage", { chat_id: binding.chatId, text: message, reply_markup: mainKeyboard });
  }

  /** 三种文本输入只负责查找或生成确认页，不直接转存。 */
  private async input(binding: TelegramBinding, mode: Dialogue["mode"], text: string): Promise<void> {
    if (mode === "transfer") {
      const url = text.match(/https?:\/\/[^\s<>，。]+/iu)?.[0] ?? "";
      if (!url || url.length > 1000) { await this.send(binding.chatId, "请输入有效的分享链接。"); return; }
      const guangya = parseGuangyaShareUrl(url);
      const quark = parseQuarkShareUrl(url);
      const password = text.match(/(?:提取码|密码|访问码)\s*[:：]?\s*([A-Za-z0-9]{1,32})/u)?.[1]
        ?? guangya?.code ?? quark?.code ?? "";
      await this.resource(binding, { title: "分享链接转存", shareUrl: url, cloudType: guangya ? "guangya" : quark ? "quark" : "other",
        password, source: "私聊分享", sourceKind: "message", sourceName: "私聊分享", postedAt: null, messageUrl: "" });
      return;
    }
    if (text.length > 100) { await this.send(binding.chatId, "作品名称不能超过 100 字，请重新从菜单开始。"); return; }
    await this.send(binding.chatId, "正在查找，请稍候…");
    if (mode === "search") {
      const result = await this.engine.search(text);
      const items = result.items.filter((item) => /^https?:\/\//iu.test(item.shareUrl)).slice(0, 100);
      if (!items.length) { await this.send(binding.chatId, "没有找到资源。" + (result.errors.length ? "部分来源暂时不可用。" : "")); return; }
      await this.searchPage(binding, text, items, 0, result.errors.length);
      return;
    }
    const results = await Promise.allSettled(["movie", "tv"].map((mediaType) => this.runtime.tmdb.searchVideoCandidates({
      mediaType: mediaType as "movie" | "tv", title: text, year: null, language: "zh-CN", region: "CN" })));
    if (results.every((result) => result.status === "rejected")) throw new Error("作品搜索暂时不可用，请检查 TMDB 配置");
    const candidates = results.flatMap((result) => result.status === "fulfilled" ? result.value : []).slice(0, 30);
    if (!candidates.length) { await this.send(binding.chatId, "没有找到对应作品，请核对名称。"); return; }
    const show = async (b: TelegramBinding, page: number): Promise<void> => {
      const rows = candidates.slice(page * 5, page * 5 + 5).map((item) => [this.button(b,
        `${item.title} (${item.year ?? "未知年份"}) · ${item.mediaType === "movie" ? "电影" : "剧集"}`,
        async (current) => this.subscriptionCandidate(current, item.mediaType, item.id, () => show(current, page)))]);
      rows.push(this.pagination(b, page, candidates.length, (current, next) => show(current, next)));
      rows.push([this.button(b, "取消操作", (current) => this.home(current))]);
      await this.send(b.chatId, `请选择准确作品，第 ${page + 1} 页：`, rows.filter((row) => row.length));
    };
    await show(binding, 0);
  }

  /** 分页结果保留全部网盘类型，每条提供打开链接和转存。 */
  private async searchPage(binding: TelegramBinding, keyword: string, items: ShareSearchResult[], page: number, errors: number): Promise<void> {
    await this.send(binding.chatId, `“${keyword}”共 ${items.length} 条结果，第 ${page + 1} 页。${errors ? "部分来源暂时不可用。" : ""}`);
    for (const item of items.slice(page * 5, page * 5 + 5)) {
      await this.resource(binding, item, () => this.searchPage(binding, keyword, items, page, errors));
    }
    const rows = [this.pagination(binding, page, items.length, (b, next) => this.searchPage(b, keyword, items, next, errors)),
      [this.button(binding, "重新搜索", async (b) => {
        this.reset(b.telegramId);
        this.dialogues.set(b.telegramId, { mode: "search", generation: b.generation, expiresAt: Date.now() + 30 * 60_000 });
        await this.send(b.chatId, "请输入作品名称。", [[this.button(b, "取消操作", (current) => this.home(current))]]);
      }), this.button(binding, "返回主菜单", (b) => this.home(b))]];
    await this.send(binding.chatId, "翻页或选择其他操作：", rows.filter((row) => row.length));
  }

  /** 不隐藏不支持的转存入口，点击后明确提示用户手动处理。 */
  private async resource(binding: TelegramBinding, item: ShareSearchResult, back?: () => Promise<void>): Promise<void> {
    await this.send(binding.chatId, `${item.title}\n网盘：${this.cloudName(item.cloudType)} · 来源：${item.sourceName || item.source}${item.password ? `\n提取码：${item.password}` : ""}`,
      [[{ text: "打开链接", url: item.shareUrl }, this.button(binding, "转存", async (b) => {
        if (!["guangya", "quark"].includes(item.cloudType)) {
          await this.send(b.chatId, "暂不支持该网盘转存，请打开链接后手动转存。", [[{ text: "打开链接", url: item.shareUrl }]]); return;
        }
        await this.chooseTarget(b, item.cloudType, async (current, serviceId) => this.confirmTransfer(current, item, serviceId,
          back ?? (() => this.resource(current, item))), back ?? (() => this.resource(b, item)));
      })]]);
  }

  /** 默认网盘只用于优先排列，同类型有多个网盘时仍让用户明确选择。 */
  private async chooseTarget(binding: TelegramBinding, provider: string | undefined,
    selected: (binding: TelegramBinding, serviceId: string) => Promise<void>, back: () => Promise<void>): Promise<void> {
    const targets = await this.transfers.targets(binding.userId, provider);
    if (!targets.length) { await this.send(binding.chatId, "请先在云助手中添加对应的光鸭或夸克网盘服务。"); return; }
    const preferences = await this.store.preferences(binding.userId);
    const available = targets.filter((target) => target.available && target.directory);
    if (!available.length) { await this.send(binding.chatId, "对应网盘未登录或尚未配置转存目录，请先在网页设置。"); return; }
    if (available.length === 1) { await selected(binding, available[0]!.id); return; }
    available.sort((a, b) => Number(b.id === preferences.defaultServiceId) - Number(a.id === preferences.defaultServiceId));
    await this.send(binding.chatId, "请选择目标网盘：", [...available.map((target) => [this.button(binding,
      `${target.name}${target.id === preferences.defaultServiceId ? "（默认）" : ""}`, (b) => selected(b, target.id))]),
      [this.button(binding, "返回上一步", async () => back()), this.button(binding, "取消操作", (b) => this.home(b))]]);
  }

  /** 分享提交需要单独确认，最终点击时再次核实账号和网盘归属。 */
  private async confirmTransfer(binding: TelegramBinding, item: ShareSearchResult, serviceId: string, back: () => Promise<void>): Promise<void> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, binding.userId);
    const directory = await getServiceTransferDirectory(this.runtime.database, serviceId);
    const preferences = await this.store.preferences(binding.userId);
    await this.send(binding.chatId, `确认转存\n${item.title}\n目标：${service.displayName}\n目录：${directory?.displayPath ?? "未配置"}\n自动整理入库：${preferences.autoImportServiceIds.includes(serviceId) ? "开启" : "关闭"}`,
      [[this.button(binding, "确认转存", async (b) => {
        // 关键变量：确认提交后废弃该用户其他旧转存按钮，避免同页多次重复确认。
        this.reset(b.telegramId);
        const task = await this.transfers.submit(b.userId, serviceId, item.shareUrl, item.password, item.title);
        await this.send(b.chatId, `转存已提交\n任务：${task.id}`, [[this.button(b, "查看进度", (current) => this.transferDetail(current, task.id))]]);
      })], [this.button(binding, "返回上一步", async () => back()), this.button(binding, "取消操作", (b) => this.home(b))]]);
  }

  /** 查看候选海报和身份后，再选择订阅网盘。 */
  private async subscriptionCandidate(binding: TelegramBinding, mediaType: "movie" | "tv", tmdbId: number, back: () => Promise<void>): Promise<void> {
    const metadata = await this.runtime.tmdb.readVideoMetadata(mediaType, tmdbId, "zh-CN", "CN");
    if (!metadata) throw new Error("找不到该作品");
    if (metadata.posterUrl) await this.runtime.telegramNotifications.callBotApi("sendPhoto", {
      chat_id: binding.chatId, photo: metadata.posterUrl, caption: `${metadata.title} (${metadata.year ?? "未知年份"})`,
    }).catch(() => undefined);
    await this.send(binding.chatId, `${metadata.title} (${metadata.year ?? "未知年份"})\n${mediaType === "movie" ? "电影" : "剧集"} · TMDB ${tmdbId}`,
      [[this.button(binding, "选择网盘并订阅", (b) => this.chooseTarget(b, undefined, async (current, serviceId) => {
        const target = await this.runtime.repository.getServiceDetail(serviceId, current.userId);
        const sources = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled).map((source) => source.key);
        const channels = await this.engine.serviceChannels(serviceId, sources);
        const directory = await getServiceTransferDirectory(this.runtime.database, serviceId);
        const preferences = await this.store.preferences(current.userId);
        await this.send(current.chatId, `确认订阅：${metadata.title} (${metadata.year ?? "未知年份"})\n网盘：${target.displayName}\n目录：${directory?.displayPath ?? "未配置"}\n关注频道：${channels.length ? channels.map((channel) => "@" + channel).join("、") : "未设置，请先在网页配置"}\n自动整理入库：${preferences.autoImportServiceIds.includes(serviceId) ? "开启" : "关闭"}`,
          [[this.button(current, "确认订阅", async (actor) => {
            if (!channels.length) throw new Error("请先在网页个人设置中为该网盘配置关注频道");
            const result = await createMovieSubscription(this.runtime, this.subscriptions, actor.userId, serviceId, mediaType, tmdbId);
            await this.send(actor.chatId, result.alreadySubscribed ? "该作品已订阅。" : "订阅添加成功。", [[
              this.button(actor, "立即查找", (owner) => this.checkSubscription(owner, result.item)),
              this.button(actor, "查看订阅", (owner) => this.subscriptionDetail(owner, result.item))]]);
          })], [this.button(current, "返回上一步", (actor) => this.subscriptionCandidate(actor, mediaType, tmdbId, back)),
            this.button(current, "取消操作", (actor) => this.home(actor))]]);
      }, back))], [this.button(binding, "返回上一步", async () => back()), this.button(binding, "取消操作", (b) => this.home(b))]]);
  }

  /** 按用户列出仍归属该账号的订阅，列表明确显示对应网盘。 */
  private async showSubscriptions(binding: TelegramBinding, page = 0): Promise<void> {
    const services = await this.runtime.repository.listServices({ userId: binding.userId, limit: 10000, offset: 0 });
    const names = new Map(services.items.map((service) => [service.id, service.displayName]));
    const items = (await listStoredSubscriptions(this.runtime.database, binding.userId)).filter((item) => names.has(item.serviceId));
    const rows = items.slice(page * 5, page * 5 + 5).map((item) => [this.button(binding,
      `${item.title} (${item.year ?? "未知年份"}) · ${names.get(item.serviceId)}`, (b) => this.subscriptionDetail(b, item))]);
    rows.push(this.pagination(binding, page, items.length, (b, next) => this.showSubscriptions(b, next)));
    rows.push([this.button(binding, "添加订阅", async (b) => {
      this.dialogues.set(b.telegramId, { mode: "subscribe", generation: b.generation, expiresAt: Date.now() + 30 * 60_000 });
      await this.send(b.chatId, "请输入作品名称。", [[this.button(b, "取消操作", (current) => this.home(current))]]);
    }), this.button(binding, "返回主菜单", (b) => this.home(b))]);
    await this.send(binding.chatId, items.length ? `我的订阅 · ${items.length} 部 · 第 ${page + 1} 页` : "暂无订阅。", rows.filter((row) => row.length));
  }

  /** 点击旧订阅按钮时重新检查记录，已取消的订阅不能继续触发操作。 */
  private async requireSubscription(binding: TelegramBinding, item: MovieSubscription): Promise<void> {
    await this.runtime.repository.getServiceDetail(item.serviceId, binding.userId);
    const row = await this.runtime.database.query("system_settings").where({
      setting_key: subscriptionSettingKey(item.serviceId, item.mediaType, item.tmdbId), updated_by_user_id: binding.userId,
    }).first();
    if (!row) throw new Error("该订阅已取消，请刷新订阅列表");
  }

  /** 展示该作品最近的查找和转存状态。 */
  private async subscriptionDetail(binding: TelegramBinding, item: MovieSubscription): Promise<void> {
    await this.requireSubscription(binding, item);
    const service = await this.runtime.repository.getServiceDetail(item.serviceId, binding.userId);
    const activity = await this.subscriptions.recent(item.serviceId, item);
    await this.send(binding.chatId, `${item.title} (${item.year ?? "未知年份"})\n网盘：${service.displayName}\n上次查找：${this.date(activity.lastRunAt)}\n最近状态：${activity.items[0] ? this.status(activity.items[0].status) : "暂无转存记录"}${activity.lastError ? `\n巡检提示：${activity.lastError}` : ""}`,
      [[this.button(binding, "立即查找", (b) => this.checkSubscription(b, item)), this.button(binding, "转存记录", (b) => this.subscriptionActivity(b, item))],
        [this.button(binding, "取消订阅", async (b) => this.send(b.chatId, `确认取消“${item.title}”的订阅？已经转存的文件保留。`, [
          [this.button(b, "确认取消订阅", async (actor) => {
            await this.requireSubscription(actor, item);
            await this.runtime.database.query("system_settings").where({ setting_key: subscriptionSettingKey(item.serviceId, item.mediaType, item.tmdbId),
              updated_by_user_id: actor.userId }).delete();
            await this.showSubscriptions(actor);
          })], [this.button(b, "返回上一步", (actor) => this.subscriptionDetail(actor, item))]]))],
        [this.button(binding, "返回列表", (b) => this.showSubscriptions(b)), this.button(binding, "返回主菜单", (b) => this.home(b))]]);
  }

  /** 仅查找当前作品，保留其他订阅的公共游标和定时计划。 */
  private async checkSubscription(binding: TelegramBinding, item: MovieSubscription): Promise<void> {
    await this.requireSubscription(binding, item);
    await this.send(binding.chatId, `正在查找“${item.title}”的订阅更新，请稍候…`);
    const result = await this.subscriptions.runNow(item.serviceId, item);
    if (result.lastError) await this.send(binding.chatId, `本次作品查找提示：${result.lastError}`);
    await this.subscriptionActivity(binding, item);
  }

  /** 展示当前选中作品的记录，避免混入其他作品。 */
  private async subscriptionActivity(binding: TelegramBinding, item: MovieSubscription, page = 0): Promise<void> {
    await this.requireSubscription(binding, item);
    const activity = await this.subscriptions.recent(item.serviceId, item);
    const lines = activity.items.slice(page * 5, page * 5 + 5).map((record) =>
      `${record.title}\n${this.status(record.status)} · ${this.date(record.updatedAt)}${record.reason ? "\n" + record.reason : ""}`);
    const rows = [this.pagination(binding, page, activity.items.length, (b, next) => this.subscriptionActivity(b, item, next)),
      [this.button(binding, "刷新记录", (b) => this.subscriptionActivity(b, item, page)), this.button(binding, "返回作品", (b) => this.subscriptionDetail(b, item))]];
    await this.send(binding.chatId, `${item.title} · 转存记录\n\n${lines.join("\n\n") || "暂无记录"}`, rows.filter((row) => row.length));
  }

  /** 聚合当前用户的转存、整理和扫描记录，网页创建的相关任务也可查询。 */
  private async showTasks(binding: TelegramBinding, active: boolean, page = 0): Promise<void> {
    const [transfers, organized, scanned] = await Promise.all([
      this.store.list<TelegramTransferTask>("task:", binding.userId), this.manager.listTaskSummaries(binding.userId),
      this.runtime.repository.listJobs({ userId: binding.userId, limit: 100, offset: 0 }),
    ]);
    const items = [
      ...transfers.map((task) => ({ at: task.createdAt, state: task.stage, label: `转存 · ${task.title}`, open: (b: TelegramBinding) => this.transferDetail(b, task.id) })),
      ...organized.map((task) => ({ at: task.createdAt, state: task.status, label: `整理 · ${task.id.slice(0, 8)}`, open: async (b: TelegramBinding) => {
        await this.runtime.repository.getServiceDetail(task.serviceId, b.userId);
        const current = (await this.manager.listTaskSummaries(b.userId)).find((entry) => entry.id === task.id);
        if (!current) throw new Error("任务已删除");
        await this.send(b.chatId, `整理任务：${current.id}\n状态：${this.status(current.status)}${current.error ? "\n" + current.error : ""}`, [
          [this.button(b, "刷新状态", async (actor) => this.showTasks(actor, active, page)), this.button(b, "返回列表", (actor) => this.showTasks(actor, active, page))]]);
      } })),
      ...scanned.items.map((task) => ({ at: task.createdAt, state: task.status, label: `扫描 · ${task.id.slice(0, 8)}`, open: async (b: TelegramBinding) => {
        const current = await this.runtime.repository.getJob(task.id, b.userId);
        await this.send(b.chatId, `扫描任务：${current.id}\n状态：${this.status(current.status)}\n已处理：${current.processedCount}\n失败项：${current.errorCount}`, [
          [this.button(b, "刷新状态", (actor) => this.showTasks(actor, active, page)), this.button(b, "返回列表", (actor) => this.showTasks(actor, active, page))]]);
      } })),
    ].filter((item) => !active || !["completed", "failed", "cancelled"].includes(item.state)).sort((a, b) => b.at.localeCompare(a.at));
    const rows = items.slice(page * 5, page * 5 + 5).map((item) => [this.button(binding, `${this.status(item.state)} · ${item.label}`.slice(0, 100), item.open)]);
    rows.unshift([this.button(binding, "进行中", (b) => this.showTasks(b, true)), this.button(binding, "最近记录", (b) => this.showTasks(b, false))]);
    rows.push(this.pagination(binding, page, items.length, (b, next) => this.showTasks(b, active, next)));
    rows.push([this.button(binding, "刷新列表", (b) => this.showTasks(b, active, page)), this.button(binding, "返回主菜单", (b) => this.home(b))]);
    await this.send(binding.chatId, `${active ? "进行中任务" : "最近任务"} · ${items.length} 条`, rows.filter((row) => row.length));
  }

  /** 任务详情始终带用户条件读取持久记录。 */
  private async transferDetail(binding: TelegramBinding, taskId: string): Promise<void> {
    const task = await this.store.get<TelegramTransferTask | null>("task:" + taskId, null);
    if (!task || task.userId !== binding.userId) throw new Error("任务不存在");
    const transferDone = ["organize_wait", "organize_starting", "organize", "scan", "completed"].includes(task.stage);
    await this.send(binding.chatId, `${task.title}\n任务：${task.id}\n状态：${this.status(task.stage)}\n转存：${transferDone ? "已完成" : task.stage === "failed" ? "请查看失败原因" : "处理中"}\n自动整理入库：${task.autoImport ? "开启" : "关闭"}${task.error ? "\n失败原因：" + task.error : ""}`,
      [[this.button(binding, "刷新状态", (b) => this.transferDetail(b, taskId)), this.button(binding, "返回任务列表", (b) => this.showTasks(b, false))]]);
  }

  /** 个人选项按用户保存；转存目录继续由网页维护。 */
  private async settings(binding: TelegramBinding): Promise<void> {
    const user = await this.runtime.database.findPublicUserById(binding.userId);
    const preferences = await this.store.preferences(binding.userId);
    const targets = await this.transfers.targets(binding.userId);
    await this.send(binding.chatId, `个人设置\n当前用户：${user.username}\n默认网盘：${targets.find((target) => target.id === preferences.defaultServiceId)?.name ?? "未设置"}\n个人任务通知：${preferences.notifications ? "开启" : "关闭"}\n自动入库已开启：${targets.filter((target) => preferences.autoImportServiceIds.includes(target.id)).map((target) => target.name).join("、") || "无"}\n转存目录请在云助手网页设置。`, [
      [this.button(binding, "默认网盘", async (b) => {
        const choices = await this.transfers.targets(b.userId);
        await this.send(b.chatId, "请选择默认转存网盘：", [...choices.map((target) => [this.button(b, target.name, async (actor) => {
          await this.runtime.repository.getServiceDetail(target.id, actor.userId);
          await this.store.updatePreferences(actor.userId, (value) => { value.defaultServiceId = target.id; });
          await this.settings(actor);
        })]), [this.button(b, "返回上一步", (actor) => this.settings(actor))]]);
      }), this.button(binding, preferences.notifications ? "关闭个人通知" : "开启个人通知", async (b) => {
        await this.store.updatePreferences(b.userId, (value) => { value.notifications = !preferences.notifications; });
        await this.settings(b);
      })],
      [this.button(binding, "自动整理入库", async (b) => {
        const choices = await this.transfers.targets(b.userId);
        const value = await this.store.preferences(b.userId);
        await this.send(b.chatId, "按网盘开启自动整理入库，沿用网页整理和洗版规则。修改只影响后续新转存，已有任务继续使用提交时选项。", [
          ...choices.map((target) => {
            const enabled = value.autoImportServiceIds.includes(target.id);
            return [this.button(b, `${target.name}：${enabled ? "开启" : "关闭"}`, async (actor) => {
              await this.runtime.repository.getServiceDetail(target.id, actor.userId);
              if (!enabled) await this.transfers.validateImport(actor.userId, target.id);
              await this.store.updatePreferences(actor.userId, (current) => {
                if (enabled) current.autoImportServiceIds = current.autoImportServiceIds.filter((id) => id !== target.id);
                else if (!current.autoImportServiceIds.includes(target.id)) current.autoImportServiceIds.push(target.id);
              });
              await this.settings(actor);
            })];
          }), [this.button(b, "返回上一步", (actor) => this.settings(actor))]]);
      })],
      [this.button(binding, "解除绑定", async (b) => this.send(b.chatId, "确认解除当前 TG 账号的绑定？已有订阅和后台任务保留，解除后需要新绑定码才能使用机器人。", [
        [this.button(b, "确认解除绑定", async (actor) => {
          await this.store.manageBinding(actor.userId, "unbind", actor.telegramId);
          this.reset(actor.telegramId);
          await this.runtime.telegramNotifications.callBotApi("sendMessage", { chat_id: actor.chatId,
            text: "已解除绑定。", reply_markup: { remove_keyboard: true } });
        })], [this.button(b, "返回上一步", (actor) => this.settings(actor))]]))],
      [this.button(binding, "返回主菜单", (b) => this.home(b))],
    ]);
  }

  /** 帮助只说明当前已开放的能力，不展示管理员功能或凭据。 */
  private async help(binding: TelegramBinding): Promise<void> {
    const user = await this.runtime.database.findPublicUserById(binding.userId);
    await this.send(binding.chatId, `云助手机器人\n当前绑定：${user.username}\n\n搜索资源：输入作品名称，打开链接或转存。\n分享转存：直接发送分享链接及提取码。\n添加订阅：选择准确作品和网盘，后续查找关注频道的新资源。\n我的订阅：查看记录、立即查找或取消订阅。\n任务记录：查看转存、整理和扫描进度。\n个人设置：选择默认网盘、通知及自动整理入库。\n\n自动转存当前仅支持光鸭和夸克；其他网盘请打开链接手动处理。\n转存目录和整理、洗版、媒体库规则在网页配置。\n失败任务结束，不自动重试。\n/cancel 取消尚未提交的操作。`, [[this.button(binding, "返回主菜单", (b) => this.home(b))]]);
  }

  /** 回调只包含短随机标识，不暴露用户 ID、分享密码或网盘路径。 */
  private button(binding: TelegramBinding, text: string, execute: Action["execute"]): Button {
    const key = randomBytes(12).toString("hex");
    this.actions.set(key, { telegramId: binding.telegramId, generation: binding.generation,
      expiresAt: Date.now() + 30 * 60_000, execute });
    return { text, callback_data: key };
  }

  /** 所有列表共用五条分页，翻页不会重跑资源搜索。 */
  private pagination(binding: TelegramBinding, page: number, count: number,
    show: (binding: TelegramBinding, page: number) => Promise<void>): Button[] {
    return [...(page > 0 ? [this.button(binding, "上一页", (b) => show(b, page - 1))] : []),
      ...(page * 5 + 5 < count ? [this.button(binding, "下一页", (b) => show(b, page + 1))] : [])];
  }

  /** 取消或切换菜单时撤销该用户旧确认按钮，不影响其他人的流程。 */
  private reset(telegramId: string): void {
    this.dialogues.delete(telegramId);
    for (const [key, action] of this.actions) if (action.telegramId === telegramId) this.actions.delete(key);
  }

  /** 定期丢弃过期按钮和输入状态，避免长期聊天累积内存。 */
  private prune(): void {
    const now = Date.now();
    for (const [key, action] of this.actions) if (action.expiresAt < now) this.actions.delete(key);
    for (const [key, dialogue] of this.dialogues) if (dialogue.expiresAt < now) this.dialogues.delete(key);
    for (const [key, attempt] of this.attempts) if (attempt.until < now) this.attempts.delete(key);
  }

  /** 用稳定中文描述阶段，避免把内部状态码展示给用户。 */
  private status(value: string): string {
    return ({ submitting: "正在提交", transfer: "转存中", organize_wait: "等待整理", organize_starting: "准备整理",
      organize: "整理中", scan: "入库中", preparing: "准备中", queued: "排队中", running: "执行中", pending: "等待中",
      retry_waiting: "等待恢复", paused: "已暂停", completed: "已完成", failed: "失败，已结束", cancelled: "已取消",
      skipped: "已跳过", needs_review: "需要检查" } as Record<string, string>)[value] ?? value;
  }

  /** 时间固定以用户使用的北京时间显示。 */
  private date(value: string | null): string { return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚未执行"; }

  /** 搜索侧网盘标识与服务侧标识分开，不改变现有数据结构。 */
  private cloudName(value: string): string {
    return ({ guangya: "光鸭", quark: "夸克", aliyun: "阿里云盘", baidu: "百度网盘", "115": "115 网盘",
      "123": "123 网盘", tianyi: "天翼云盘", mobile: "移动云盘", uc: "UC 网盘", xunlei: "迅雷", pikpak: "PikPak", other: "其他网盘" } as Record<string, string>)[value] ?? value;
  }
}
