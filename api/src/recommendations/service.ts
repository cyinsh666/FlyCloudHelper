import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import type { TmdbKeyPool } from "../metadata/tmdb.js";
import { fetchReleaseList, releaseListDetail, releaseLists, type ReleaseListCache } from "./release-lists.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const UPSTREAM_PAGE_SIZE = 50;
const DETAIL_CONCURRENCY = 8;
const MANUAL_SYNC_INTERVAL_MS = 60 * 1000;
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface RecommendationBlock {
  id: string;
  title: string;
  description: string | null;
  group: string;
  category: string | null;
  mediaType: string | null;
  itemCount: number;
  posterUrl: string | null;
  lastUpdated: string | null;
}

export interface RecommendationItem {
  rank: number;
  title: string;
  overview: string | null;
  posterUrl: string | null;
  tmdbId: number | null;
  mediaType: string | null;
  rating: number | null;
  releaseDate: string | null;
  /** 院线地区上映日期或下一集播出日期。 */
  scheduleDate?: string;
}

interface RecommendationDetail {
  block: RecommendationBlock;
  items: RecommendationItem[];
}

interface RecommendationSnapshot {
  version: 1;
  updatedAt: string;
  blocks: RecommendationBlock[];
  details: Record<string, RecommendationDetail>;
}

type RecommendationLogger = (level: "info" | "warn", fields: Record<string, string | number | boolean | null>) => void;

/** 只把对象形式的上游 JSON 作为可读取记录。 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 读取可选字符串，不让上游空值进入卡片标题和图片。 */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 将榜单封面统一转成可展示的 HTTPS 地址。 */
function posterUrl(value: unknown): string | null {
  const image = optionalString(value);
  if (!image) return null;
  if (image.startsWith("https://")) return image;
  if (/^\/[A-Za-z0-9._-]+$/u.test(image)) return `https://image.tmdb.org/t/p/w500${image}`;
  return null;
}

/** 与现有 FlymbyServer 榜单保持同一业务分组，页面按返回值动态生成标签。 */
function blockGroup(id: string, category: string | null): string {
  if (id === "flymby-hongguo-hot-short-drama") return "短剧";
  if (id.startsWith("community-douban-hot-") || id.startsWith("community-endata-hot-")
    || id.startsWith("community-guduo-") || id === "community-iqiyi-hot-tv"
    || id === "community-anilist-trending" || id === "community-bangumi-calendar"
    || id === "community-justwatch-streaming-charts") return "今日热度";
  if (id === "community-douban-chinese-best-tv" || id.startsWith("community-iqiyi-")
    || id.startsWith("community-tencent-x-") || id.startsWith("community-youku-")) return "华语与地区";
  if (id === "community-douban-top250" || ["community-zh-studio-", "community-imdb-", "community-rt-",
    "community-maoyan-", "community-bfi-", "community-rolling-", "community-wga-", "community-tspdt-",
    "community-letterboxd-"].some((prefix) => id.startsWith(prefix))) return "高分经典";
  if (id === "flymby-test-tmdb-top-animation" || category === "anime" || id.startsWith("community-mal-")
    || id.startsWith("community-bangumi-top-") || id.startsWith("community-anichart-")
    || id.startsWith("collection-") || id.startsWith("community-douban-popular-anime")
    || id.startsWith("community-douban-top-animation") || id.startsWith("community-douban-healing-anime")
    || id.startsWith("community-douban-cn-animation")) return "动画追番";
  return "热门推荐";
}

/** 只接受已发布、带内容且有稳定 ID 的榜单。 */
function readBlock(value: unknown): RecommendationBlock | null {
  const source = record(value);
  const id = optionalString(source?.id);
  const title = optionalString(source?.title);
  const itemCount = source?.itemCount;
  if (!id || !BLOCK_ID_PATTERN.test(id) || !title || !Number.isInteger(itemCount) || Number(itemCount) <= 0) return null;
  const category = optionalString(source?.category);
  return {
    id, title, description: optionalString(source?.description), group: blockGroup(id, category), category,
    mediaType: id === "flymby-hongguo-hot-short-drama" ? "short_drama" : optionalString(source?.mediaType),
    itemCount: Number(itemCount), posterUrl: null, lastUpdated: null,
  };
}

/** 转换完整榜单中的一个条目，保留名次和可用于后续扩展的 TMDB ID。 */
function readItem(value: unknown, rank: number): RecommendationItem | null {
  const source = record(value);
  const title = optionalString(source?.title);
  if (!source || !title) return null;
  const tmdbId = typeof source.tmdbId === "number" && Number.isInteger(source.tmdbId) && source.tmdbId > 0
    ? source.tmdbId : null;
  const rating = typeof source.vote_average === "number" && Number.isFinite(source.vote_average)
    ? source.vote_average : null;
  return {
    rank, title, overview: optionalString(source.overview), posterUrl: posterUrl(source.poster_path), tmdbId,
    mediaType: source.source === "hongguo" ? "short_drama" : optionalString(source.media_type),
    rating, releaseDate: optionalString(source.release_date) ?? optionalString(source.first_air_date),
  };
}

/** 云助手直接同步榜单上游并原子保存快照；页面请求只读本地缓存。 */
export class RecommendationService {
  private snapshot: RecommendationSnapshot | null = null;
  private refreshPromise: Promise<void> | null = null;
  // 关键变量：手动同步沿用 Server 的每分钟一次限制，避免反复拉取全部榜单。
  private lastManualSyncAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly snapshotPath: string;
  private readonly releaseListPath: string;
  private releaseCache: ReleaseListCache = {};
  private releaseRefresh: Promise<void> | null = null;
  private readonly releaseAbort = new AbortController();
  private readonly upstreamUrl: URL;

  public constructor(cacheDirectory: string, upstreamUrl: string, private readonly logger: RecommendationLogger,
    private readonly tmdb: TmdbKeyPool) {
    this.snapshotPath = path.join(cacheDirectory, "snapshot.json");
    this.releaseListPath = path.join(cacheDirectory, "release-lists.json");
    this.upstreamUrl = new URL(upstreamUrl.endsWith("/") ? upstreamUrl : `${upstreamUrl}/`);
    if (this.upstreamUrl.protocol !== "https:") throw new Error("影视推荐榜单上游必须使用 HTTPS");
  }

  /** 启动时恢复上一份成功快照，后台刷新不阻塞 API 启动。 */
  public async start(): Promise<void> {
    try {
      const saved = record(JSON.parse(await fs.readFile(this.snapshotPath, "utf8")));
      if (saved?.version === 1 && Array.isArray(saved.blocks) && record(saved.details)) {
        this.snapshot = saved as unknown as RecommendationSnapshot;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger("warn", { 事件: "读取影视推荐榜单缓存失败", 错误: error instanceof Error ? error.message : "未知错误" });
      }
    }
    try {
      const saved = record(JSON.parse(await fs.readFile(this.releaseListPath, "utf8")));
      for (const list of releaseLists) {
        const cached = record(saved?.[list.id]);
        if (typeof cached?.updatedAt === "string" && Array.isArray(cached.items)) {
          this.releaseCache[list.id] = { updatedAt: cached.updatedAt, items: cached.items as RecommendationItem[] };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger("warn", { 事件: "读取新片与追剧缓存失败" });
    }
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
      void this.refreshReleaseLists();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
    // 关键变量：旧快照时间无效时也重新同步，避免永久停留在损坏的缓存版本。
    const cachedAt = Date.parse(this.snapshot?.updatedAt ?? "");
    if (!this.snapshot || !Number.isFinite(cachedAt) || Date.now() - cachedAt >= REFRESH_INTERVAL_MS) {
      void this.refresh().catch(() => undefined);
    }
    if (releaseLists.some(({ id }) => {
      const updatedAt = Date.parse(this.releaseCache[id]?.updatedAt ?? "");
      return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= REFRESH_INTERVAL_MS;
    })) void this.refreshReleaseLists();
  }

  /** 停止定时器；正在执行的 HTTP 请求会自行完成。 */
  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseAbort.abort();
  }

  /** 返回已缓存榜单；首次没有快照时等待同一次预热。 */
  public async list(): Promise<{ total: number; updatedAt: string; items: RecommendationBlock[] }> {
    const snapshot = await this.currentSnapshot().catch((error: unknown) => {
      if (Object.keys(this.releaseCache).length === 0) throw error;
      return null;
    });
    const releaseBlocks = releaseLists.map((list) => releaseListDetail(list, this.releaseCache[list.id]).block);
    const items = [...(snapshot?.blocks ?? []), ...releaseBlocks];
    const updatedAt = [snapshot?.updatedAt, ...releaseBlocks.map((block) => block.lastUpdated)]
      .filter((value): value is string => Boolean(value)).sort().at(-1) ?? "";
    return { total: items.length, updatedAt, items };
  }

  /** 立即从上游同步完整榜单；失败时旧快照仍保持可读。 */
  public async syncNow(): Promise<{ total: number; updatedAt: string; items: RecommendationBlock[] }> {
    if (!this.refreshPromise && Date.now() - this.lastManualSyncAt < MANUAL_SYNC_INTERVAL_MS) {
      throw new ApiError(429, "recommendation_sync_too_frequent", "榜单每 60 秒最多手动同步一次");
    }
    this.lastManualSyncAt = Date.now();
    const [upstream] = await Promise.allSettled([this.refresh(), this.refreshReleaseLists()]);
    if (upstream.status === "rejected") {
      throw new ApiError(502, "recommendation_sync_failed", "榜单同步失败，已保留上一份缓存");
    }
    return this.list();
  }

  /** 仅对本地快照分页，不在用户翻页时访问榜单上游。 */
  public async detail(id: string, page: number, pageSize: number): Promise<RecommendationBlock & {
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number }; items: RecommendationItem[];
  }> {
    if (!BLOCK_ID_PATTERN.test(id)) throw new ApiError(404, "recommendation_missing", "榜单不存在");
    const detail = await this.readDetail(id);
    if (!detail) throw new ApiError(404, "recommendation_missing", "榜单不存在");
    const totalItems = detail.items.length;
    return {
      ...detail.block,
      pagination: { page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) },
      items: detail.items.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  /** 按榜单 ID 和原始名次定位条目，详情页不信任浏览器提交的标题和 TMDB ID。 */
  public async item(blockId: string, rank: number): Promise<{ block: RecommendationBlock; item: RecommendationItem }> {
    if (!BLOCK_ID_PATTERN.test(blockId) || !Number.isInteger(rank) || rank < 1) {
      throw new ApiError(404, "recommendation_item_missing", "榜单条目不存在");
    }
    const detail = await this.readDetail(blockId);
    const item = detail?.items.find((candidate) => candidate.rank === rank);
    if (!detail || !item) throw new ApiError(404, "recommendation_item_missing", "榜单条目不存在");
    return { block: detail.block, item };
  }

  /** 新片排期和原榜单共用详情接口，各自读取对应缓存。 */
  private async readDetail(id: string): Promise<RecommendationDetail | undefined> {
    const releaseList = releaseLists.find((list) => list.id === id);
    if (releaseList) return releaseListDetail(releaseList, this.releaseCache[id]);
    return (await this.currentSnapshot()).details[id];
  }

  /** 每个排期榜单独立刷新，TMDB 或任一榜单失败时保留上次成功结果。 */
  private refreshReleaseLists(): Promise<void> {
    if (this.releaseRefresh) return this.releaseRefresh;
    if (this.releaseAbort.signal.aborted || this.tmdb.getStatus().configuredCount === 0) return Promise.resolve();
    this.releaseRefresh = this.updateReleaseCache().catch(() => {
      this.logger("warn", { 事件: "保存新片与追剧缓存失败" });
    }).finally(() => { this.releaseRefresh = null; });
    return this.releaseRefresh;
  }

  /** 顺序刷新榜单，成功后用原子写入更新缓存。 */
  private async updateReleaseCache(): Promise<void> {
    const next = { ...this.releaseCache };
    for (const list of releaseLists) {
      if (this.releaseAbort.signal.aborted) return;
      const signal = AbortSignal.any([this.releaseAbort.signal, AbortSignal.timeout(45_000)]);
      try {
        next[list.id] = await fetchReleaseList(this.tmdb, list, new Date(), signal);
        this.releaseCache = { ...next };
      } catch {
        if (!this.releaseAbort.signal.aborted) this.logger("warn", { 事件: "刷新新片与追剧榜单失败", 榜单: list.title });
      }
    }
    if (this.releaseAbort.signal.aborted) return;
    await this.saveCache(this.releaseListPath, next);
  }

  /** 先写入同目录临时文件，再原子替换缓存。 */
  private async saveCache(fileName: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(fileName), { recursive: true });
    const temporary = `${fileName}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value));
      await fs.rename(temporary, fileName);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** 多个请求共用同一次刷新，只有完整成功后才替换当前快照。 */
  public refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.fetchSnapshot().then(async (snapshot) => {
      await this.saveCache(this.snapshotPath, snapshot);
      this.snapshot = snapshot;
      this.logger("info", { 事件: "影视推荐榜单刷新完成", 榜单数量: snapshot.blocks.length });
    }).catch((error: unknown) => {
      this.logger("warn", { 事件: "影视推荐榜单刷新失败，保留旧缓存", 错误: error instanceof Error ? error.message : "未知错误" });
      throw error;
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  /** 缓存缺失时等待预热，失败后给页面稳定的可恢复错误。 */
  private async currentSnapshot(): Promise<RecommendationSnapshot> {
    if (this.snapshot) return this.snapshot;
    try { await this.refresh(); } catch { /* 首次预热错误在下方转换为服务不可用。 */ }
    if (!this.snapshot) throw new ApiError(503, "recommendations_unavailable", "影视推荐榜单正在准备，请稍后刷新");
    return this.snapshot;
  }

  /** 分页读取榜单目录，再以受控并发获取每个榜单的完整条目。 */
  private async fetchSnapshot(): Promise<RecommendationSnapshot> {
    const blocks: RecommendationBlock[] = [];
    for (let page = 0; page < 20; page += 1) {
      const payload = await this.fetchJson(`blocks/community?limit=${UPSTREAM_PAGE_SIZE}&offset=${page * UPSTREAM_PAGE_SIZE}`);
      const rawBlocks = payload.blocks;
      if (!Array.isArray(rawBlocks)) throw new Error("榜单目录格式无效");
      for (const raw of rawBlocks) {
        const block = readBlock(raw);
        if (block && !blocks.some((item) => item.id === block.id)) blocks.push(block);
      }
      if (rawBlocks.length < UPSTREAM_PAGE_SIZE) break;
      if (page === 19) throw new Error("榜单目录超过最大读取页数");
    }
    if (blocks.length === 0) throw new Error("榜单上游没有可用内容");
    const details: Record<string, RecommendationDetail> = {};
    for (let offset = 0; offset < blocks.length; offset += DETAIL_CONCURRENCY) {
      const batch = blocks.slice(offset, offset + DETAIL_CONCURRENCY);
      const fetched = await Promise.all(batch.map(async (block) => {
        const payload = await this.fetchJson(`blocks/data/${block.id}`);
        if (!Array.isArray(payload.data)) throw new Error(`榜单 ${block.id} 的内容格式无效`);
        const items = payload.data.flatMap((raw, index) => { const item = readItem(raw, index + 1); return item ? [item] : []; });
        if (items.length === 0) throw new Error(`榜单 ${block.id} 没有可展示条目`);
        const summary = { ...block, itemCount: items.length, posterUrl: items.find((item) => item.posterUrl)?.posterUrl ?? null,
          lastUpdated: optionalString(payload.lastUpdated) };
        return { block: summary, items };
      }));
      for (const detail of fetched) details[detail.block.id] = detail;
    }
    return { version: 1, updatedAt: new Date().toISOString(), blocks: blocks.map((block) => details[block.id]!.block), details };
  }

  /** 请求同一个固定 HTTPS 上游的 JSON，不向浏览器暴露地址。 */
  private async fetchJson(relativePath: string): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(relativePath, this.upstreamUrl), { headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error(`榜单上游返回 HTTP ${response.status}`);
    const payload = record(await response.json());
    if (!payload) throw new Error("榜单上游返回了无效数据");
    return payload;
  }
}
