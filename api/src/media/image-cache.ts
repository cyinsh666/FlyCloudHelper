import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ApiError } from "../errors.js";
import { providerFetch } from "../providers/network.js";

/** 单张图片与扫描预取队列的上限，避免异常图片拖垮扫描和协议请求。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_WARM_QUEUE = 500;

interface CachedImageMetadata {
  contentType: string;
  size: number;
}

export interface CachedImage {
  contentType: string;
  body: Buffer;
}

/** Jellyfin 与 Emby 共用的持久图片缓存；缓存失败不会阻止已经取得的图片返回客户端。 */
export class ProtocolImageCache {
  /** 相同 URL 的客户端请求与扫描预取共用一次源站下载。 */
  private readonly inFlight = new Map<string, Promise<CachedImage>>();
  /** 扫描任务只把图片地址入队，不等待图片下载。 */
  private readonly warmQueue: string[] = [];
  private readonly queuedUrls = new Set<string>();
  private activeWarmers = 0;

  /** directory 位于持久化 data 目录，容器重启后仍可直接读取。 */
  public constructor(private readonly directory: string) {}

  /** 根据完整图片 URL 生成固定缓存位置，不在文件名中保存源站地址或凭据。 */
  private cachePaths(url: string): { body: string; metadata: string } {
    const key = createHash("sha256").update(url, "utf8").digest("hex");
    const parent = path.join(this.directory, key.slice(0, 2));
    return { body: path.join(parent, `${key}.body`), metadata: path.join(parent, `${key}.json`) };
  }

  /** 只读取完整落盘且大小合法的图片，缺失或损坏时交给源站补齐。 */
  private async read(url: string): Promise<CachedImage | null> {
    const paths = this.cachePaths(url);
    try {
      const metadata = JSON.parse(await fs.readFile(paths.metadata, "utf8")) as CachedImageMetadata;
      if (!metadata.contentType?.toLowerCase().startsWith("image/")
        || !Number.isInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) return null;
      const body = await fs.readFile(paths.body);
      return body.length === metadata.size ? { contentType: metadata.contentType, body } : null;
    } catch {
      return null;
    }
  }

  /** 先写临时文件再公布元数据，避免中断时让客户端读到半张图片。 */
  private async write(url: string, image: CachedImage): Promise<void> {
    const paths = this.cachePaths(url);
    const suffix = randomUUID();
    const temporaryBody = `${paths.body}.${suffix}.tmp`;
    const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`;
    try {
      await fs.mkdir(path.dirname(paths.body), { recursive: true });
      await fs.writeFile(temporaryBody, image.body);
      await fs.rename(temporaryBody, paths.body);
      await fs.writeFile(temporaryMetadata, JSON.stringify({ contentType: image.contentType, size: image.body.length }));
      await fs.rename(temporaryMetadata, paths.metadata);
    } finally {
      await Promise.allSettled([fs.unlink(temporaryBody), fs.unlink(temporaryMetadata)]);
    }
  }

  /** 本地未命中时取一次原图，校验类型和大小后落盘；并发请求共享同一次下载。 */
  public async getOrFetch(url: string): Promise<CachedImage> {
    const cached = await this.read(url);
    if (cached) return cached;
    const existing = this.inFlight.get(url);
    if (existing) return existing;
    const pending = this.fetchAndStore(url);
    this.inFlight.set(url, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(url) === pending) this.inFlight.delete(url);
    }
  }

  /** 限时获取上游图片；磁盘不可写时仍返回本次已下载的图片。 */
  private async fetchAndStore(url: string): Promise<CachedImage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await providerFetch(new URL(url), { method: "GET" },
        { allowInsecureHttp: true }, controller.signal);
      if (!response.ok) throw new ApiError(502, "protocol_image_upstream_failed", "图片服务暂时不可用");
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_IMAGE_BYTES) throw new ApiError(413, "protocol_image_too_large", "图片文件过大");
      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.toLowerCase().startsWith("image/")) {
        throw new ApiError(502, "protocol_image_content_invalid", "图片服务返回了非图片内容");
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > MAX_IMAGE_BYTES) {
        throw new ApiError(body.length > MAX_IMAGE_BYTES ? 413 : 502,
          "protocol_image_size_invalid", "图片文件大小无效");
      }
      const image = { contentType, body };
      await this.write(url, image).catch(() => undefined);
      return image;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 扫描落库后低并发预取新图片，队列满时由客户端首次访问补齐。 */
  public warm(urls: Array<string | null | undefined>): void {
    for (const value of urls) {
      if (!value || this.queuedUrls.has(value) || this.inFlight.has(value)
        || this.warmQueue.length >= MAX_WARM_QUEUE) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      } catch { continue; }
      this.queuedUrls.add(value);
      this.warmQueue.push(value);
    }
    this.drainWarmQueue();
  }

  /** 只让两张图片同时请求源站，不占用扫描任务的完成边界。 */
  private drainWarmQueue(): void {
    while (this.activeWarmers < 2 && this.warmQueue.length > 0) {
      const url = this.warmQueue.shift();
      if (!url) break;
      this.activeWarmers += 1;
      void this.getOrFetch(url).catch(() => undefined).finally(() => {
        this.queuedUrls.delete(url);
        this.activeWarmers -= 1;
        this.drainWarmQueue();
      });
    }
  }
}
