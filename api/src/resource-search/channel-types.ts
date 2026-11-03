import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ResourceSearchEngine, readTelegramChannelPage } from "./engine.js";

const scanIntervalMs = 24 * 60 * 60_000;
const failureRetryMs = 60 * 60_000;
const pageLimit = 3;
const channelsPerRun = 12;
const parallelChannels = 4;

/** 近期样本数量和累计发现的类型分开保存，避免把未检出当作频道从未分享。 */
export interface ChannelCloudTypes {
  channel: string;
  recentCounts: Record<string, number>;
  observedTypes: string[];
  sampledMessages: number;
  oldestMessageId: number | null;
  newestMessageId: number | null;
  checkedAt: string | null;
  lastAttemptAt: string;
  error: string | null;
}

interface ChannelTypeCache {
  version: 1;
  updatedAt: string;
  pageLimit: number;
  channels: Record<string, ChannelCloudTypes>;
}

/** 手动分析的进度仅用于当前进程展示，频道类型结果始终以缓存文件为准。 */
export interface ChannelTypeAnalysisStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  error: string | null;
}

/** 已启用 Telegram 频道的网盘类型定时样本，只写入 data 缓存文件。 */
export class ChannelTypeCacheWorker {
  private readonly engine: ResourceSearchEngine;
  private readonly fileName: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private manualRun: Promise<void> | null = null;
  private manualStatus: ChannelTypeAnalysisStatus = { running: false, startedAt: null, finishedAt: null,
    total: 0, completed: 0, succeeded: 0, failed: 0, error: null };
  private stopping = false;

  public constructor(config: ApiConfig, database: FlyCloudHelperDatabase,
    private readonly log: (level: "info" | "warn", fields: Record<string, string | number | boolean | null>) => void) {
    this.engine = new ResourceSearchEngine(database);
    this.fileName = path.join(config.exportDirectory, "resource-search", "channel-cloud-types.json");
  }

  /** 启动后先扫一批，之后继续分批处理到期频道。 */
  public start(): void { this.stopping = false; this.schedule(1000); }

  /** 关闭时等待当前批次落盘，避免留下半写入文件。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([this.running, this.manualRun]);
  }

  /** 返回手动分析进度，页面读取状态不会触发频道请求。 */
  public analysisStatus(): ChannelTypeAnalysisStatus { return { ...this.manualStatus }; }

  /** 管理员立即启动整批分析；重复点击只返回正在运行的任务状态。 */
  public analyzeNow(): ChannelTypeAnalysisStatus {
    if (this.manualRun) return this.analysisStatus();
    this.manualStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null,
      total: 0, completed: 0, succeeded: 0, failed: 0, error: null };
    this.manualRun = this.analyzeAll().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.manualStatus.error = reason;
      this.log("warn", { 日志关键字: "codex-channel-cloud-types", 事件: "手动分析频道类型失败", 错误信息: reason });
    }).finally(() => {
      this.manualStatus.running = false;
      this.manualStatus.finishedAt = new Date().toISOString();
      this.manualRun = null;
    });
    return this.analysisStatus();
  }

  /** API 只读取缓存，不触发 Telegram 网络请求。 */
  public async summary(channels: string[]): Promise<{ pageLimit: number; updatedAt: string | null; items: ChannelCloudTypes[] }> {
    const cache = await this.readCache();
    return { pageLimit: cache.pageLimit, updatedAt: cache.updatedAt || null,
      items: channels.map((channel) => cache.channels[channel]).filter((item): item is ChannelCloudTypes => Boolean(item)) };
  }

  /** 文件不存在时返回空样本；格式损坏时显式失败，避免无声丢失历史发现类型。 */
  private async readCache(): Promise<ChannelTypeCache> {
    try {
      const cache = JSON.parse(await fs.readFile(this.fileName, "utf8")) as ChannelTypeCache;
      if (cache.version !== 1 || !cache.channels || typeof cache.channels !== "object"
        || !Number.isInteger(cache.pageLimit)) throw new Error("频道网盘类型缓存格式无效");
      return cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, updatedAt: "", pageLimit, channels: {} };
    }
  }

  /** 同目录原子替换缓存，扫描失败也保留上次已发现类型。 */
  private async saveCache(cache: ChannelTypeCache): Promise<void> {
    await fs.mkdir(path.dirname(this.fileName), { recursive: true, mode: 0o700 });
    const temporary = `${this.fileName}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await fs.rename(temporary, this.fileName);
  }

  /** 单定时器调度，上一批结束后才安排下一次。 */
  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      if (this.manualRun) { this.schedule(60_000); return; }
      this.running = this.scanDue().catch((error) => this.log("warn", {
        日志关键字: "codex-channel-cloud-types", 事件: "频道类型巡检失败",
        错误信息: error instanceof Error ? error.message : String(error),
      })).finally(() => { this.running = null; this.schedule(60_000); });
    }, delayMs);
  }

  /** 手动分析所有已启用频道，逐批落盘以便页面查看实时进度和已发现的类型。 */
  private async analyzeAll(): Promise<void> {
    await this.running;
    if (this.stopping) return;
    const sources = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled);
    const cache = await this.readCache();
    const active = new Set(sources.map((source) => source.key));
    for (const channel of Object.keys(cache.channels)) {
      if (!active.has(channel)) delete cache.channels[channel];
    }
    this.manualStatus.total = sources.length;
    for (let offset = 0; offset < sources.length && !this.stopping; offset += parallelChannels) {
      const batch = sources.slice(offset, offset + parallelChannels);
      const results = await Promise.all(batch.map((source) => this.scanChannel(source.key, cache.channels[source.key])));
      for (const item of results) {
        cache.channels[item.channel] = item;
        this.manualStatus.completed += 1;
        if (item.error) this.manualStatus.failed += 1;
        else this.manualStatus.succeeded += 1;
      }
      cache.updatedAt = new Date().toISOString();
      cache.pageLimit = pageLimit;
      await this.saveCache(cache);
    }
    if (sources.length === 0) {
      cache.updatedAt = new Date().toISOString();
      await this.saveCache(cache);
    }
  }

  /** 每轮最多扫描 12 个到期频道，限制并发和 Telegram 请求量。 */
  private async scanDue(): Promise<void> {
    const sources = (await this.engine.listSources()).filter((source) => source.kind === "telegram" && source.enabled);
    const cache = await this.readCache();
    const active = new Set(sources.map((source) => source.key));
    let removedDisabledChannel = false;
    for (const channel of Object.keys(cache.channels)) {
      if (active.has(channel)) continue;
      delete cache.channels[channel];
      removedDisabledChannel = true;
    }
    const now = Date.now();
    const due = sources.map((source) => source.key).filter((channel) => {
      const previous = cache.channels[channel];
      if (!previous) return true;
      const lastAttempt = Date.parse(previous.lastAttemptAt);
      const lastSuccess = previous.checkedAt ? Date.parse(previous.checkedAt) : 0;
      return previous.error ? !Number.isFinite(lastAttempt) || now - lastAttempt >= failureRetryMs
        : !Number.isFinite(lastSuccess) || now - lastSuccess >= scanIntervalMs;
    }).slice(0, channelsPerRun);
    if (removedDisabledChannel && due.length === 0) {
      cache.updatedAt = new Date().toISOString();
      await this.saveCache(cache);
    }
    for (let offset = 0; offset < due.length && !this.stopping; offset += parallelChannels) {
      const batch = due.slice(offset, offset + parallelChannels);
      const results = await Promise.all(batch.map((channel) => this.scanChannel(channel, cache.channels[channel])));
      for (const item of results) cache.channels[item.channel] = item;
      cache.updatedAt = new Date().toISOString();
      cache.pageLimit = pageLimit;
      await this.saveCache(cache);
    }
  }

  /** 读取频道最近三页消息，只统计现有解析器识别出的网盘分享域名。 */
  private async scanChannel(channel: string, previous?: ChannelCloudTypes): Promise<ChannelCloudTypes> {
    const lastAttemptAt = new Date().toISOString();
    const base: ChannelCloudTypes = previous ?? { channel, recentCounts: {}, observedTypes: [], sampledMessages: 0,
      oldestMessageId: null, newestMessageId: null, checkedAt: null, lastAttemptAt, error: null };
    try {
      const messages = new Map<number, Awaited<ReturnType<typeof readTelegramChannelPage>>[number]>();
      let before: number | undefined;
      for (let page = 0; page < pageLimit; page += 1) {
        const items = await readTelegramChannelPage(channel, before);
        if (!items.length) break;
        for (const item of items) messages.set(item.messageId, item);
        const oldest = items[0]!.messageId;
        if (before !== undefined && oldest >= before) throw new Error("频道分页没有前进");
        before = oldest;
      }
      const recentCounts: Record<string, number> = {};
      for (const message of messages.values()) {
        for (const share of message.shares) recentCounts[share.cloudType] = (recentCounts[share.cloudType] ?? 0) + 1;
      }
      const ids = [...messages.keys()];
      return { channel, recentCounts,
        observedTypes: [...new Set([...base.observedTypes, ...Object.keys(recentCounts)])].sort(),
        sampledMessages: messages.size, oldestMessageId: ids.length ? Math.min(...ids) : null,
        newestMessageId: ids.length ? Math.max(...ids) : null, checkedAt: lastAttemptAt, lastAttemptAt, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "频道读取失败";
      this.log("warn", { 日志关键字: "codex-channel-cloud-types", 事件: "单频道类型巡检失败",
        频道: channel, 错误信息: reason });
      return { ...base, lastAttemptAt, error: reason };
    }
  }
}
