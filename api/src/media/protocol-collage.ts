import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getOutboundBrowserProxy } from "../network-proxy.js";
import type { CachedImage, ProtocolImageCache } from "./image-cache.js";

export type CollageProtocol = "jellyfin" | "emby";

export interface CollageLibrary {
  id: string;
  title: string;
  subtitle: string;
  /** 当前虚拟库中不同作品的海报地址，不能包含分集重复项。 */
  posterUrls: string[];
}

interface CollageState {
  enabled: boolean;
  generationId: string;
  covers: Record<string, string>;
}

export interface CollageCover {
  body: Buffer;
  tag: string;
}

/** 协议虚拟媒体库的拼贴封面保存在 data；开关与封面文件均不修改数据库结构。 */
export class ProtocolCollageService {
  /** 同一媒体库同一协议的状态写入依次执行，避免快速切换与后台生成互相覆盖。 */
  private readonly stateOperations = new Map<string, Promise<void>>();

  public constructor(private readonly directory: string, private readonly images: ProtocolImageCache) {}

  /** 固定身份生成私有目录，避免协议路径或媒体库 ID 进入文件路径。 */
  private directoryFor(libraryId: string, protocol: CollageProtocol): string {
    const key = createHash("sha256").update(libraryId).digest("hex");
    return path.join(this.directory, protocol, key);
  }

  /** 将开关、封面发布和旧图清理串行化，耗时的图片下载与渲染不占用此锁。 */
  private async withStateLock<T>(libraryId: string, protocol: CollageProtocol, action: () => Promise<T>): Promise<T> {
    const key = `${protocol}:${libraryId}`;
    const previous = this.stateOperations.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.stateOperations.set(key, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.stateOperations.get(key) === current) this.stateOperations.delete(key);
    }
  }

  /** 读取本库本协议的开关及当前一代已生成封面。 */
  private async readState(libraryId: string, protocol: CollageProtocol): Promise<CollageState> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.directoryFor(libraryId, protocol), "state.json"), "utf8")) as Partial<CollageState>;
      return { enabled: raw.enabled === true, generationId: typeof raw.generationId === "string" ? raw.generationId : "",
        covers: raw.covers && typeof raw.covers === "object" && !Array.isArray(raw.covers) ? raw.covers : {} };
    } catch {
      return { enabled: false, generationId: "", covers: {} };
    }
  }

  /** 先写临时状态再替换；客户端不会看到半写的封面清单。 */
  private async writeState(libraryId: string, protocol: CollageProtocol, state: CollageState): Promise<void> {
    const directory = this.directoryFor(libraryId, protocol);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `state.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(state));
      await fs.rename(temporary, path.join(directory, "state.json"));
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }

  /** 设置页读取当前开关；未配置的历史媒体库默认关闭。 */
  public async isEnabled(libraryId: string, protocol: CollageProtocol): Promise<boolean> {
    return (await this.readState(libraryId, protocol)).enabled;
  }

  /** 关闭立即隐藏旧图；重新开启建立新代，后台生成成功后逐库替换。 */
  public async setEnabled(libraryId: string, protocol: CollageProtocol, enabled: boolean,
    provideLibraries: () => Promise<CollageLibrary[]>): Promise<void> {
    const generationId = await this.withStateLock(libraryId, protocol, async () => {
      const previous = await this.readState(libraryId, protocol);
      const nextGenerationId = enabled ? randomUUID() : previous.generationId;
      await this.writeState(libraryId, protocol, { enabled, generationId: nextGenerationId, covers: {} });
      return nextGenerationId;
    });
    if (!enabled) {
      await this.removeUnusedFiles(libraryId, protocol, generationId);
      return;
    }
    void this.generate(libraryId, protocol, generationId, provideLibraries)
      .catch((error: unknown) => console.error("拼贴封面生成失败", { 协议: protocol, 媒体库ID: libraryId, 错误: error }));
  }

  /** Fisher–Yates 洗牌，让已收集作品有同等机会入选。 */
  private shuffled(urls: string[]): string[] {
    const result = [...urls];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      const selected = result[index]!;
      result[index] = result[randomIndex]!;
      result[randomIndex] = selected;
    }
    return result;
  }

  /** 新一代生成结束后删除不再引用的旧 JPEG，避免反复切换持续占用 data。 */
  private async removeUnusedFiles(libraryId: string, protocol: CollageProtocol, generationId: string): Promise<void> {
    await this.withStateLock(libraryId, protocol, async () => {
      const state = await this.readState(libraryId, protocol);
      if (state.generationId !== generationId) return;
      const directory = this.directoryFor(libraryId, protocol);
      const used = new Set(Object.values(state.covers));
      for (const fileName of await fs.readdir(directory)) {
        if (/^[a-f0-9]{64}-[a-f0-9-]{36}\.jpg$/u.test(fileName) && !used.has(fileName)) {
          await fs.unlink(path.join(directory, fileName)).catch(() => undefined);
        }
      }
    });
  }

  /** 只为恰好下载到八张不同作品海报的虚拟库创建封面。 */
  private async generate(libraryId: string, protocol: CollageProtocol, generationId: string,
    provideLibraries: () => Promise<CollageLibrary[]>): Promise<void> {
    try {
      const libraries = await provideLibraries();
      for (const library of libraries) {
        const state = await this.readState(libraryId, protocol);
        if (!state.enabled || state.generationId !== generationId) return;
        const urls = this.shuffled([...new Set(library.posterUrls)]);
        if (urls.length < 8) continue;
        const pictures: CachedImage[] = [];
        for (const url of urls) {
          try { pictures.push(await this.images.getOrFetch(url)); } catch { /* 继续使用本库其他作品。 */ }
          if (pictures.length === 8) break;
        }
        if (pictures.length !== 8) continue;
        try {
          const body = await this.render(pictures, library.title, library.subtitle);
          await this.withStateLock(libraryId, protocol, async () => {
            const current = await this.readState(libraryId, protocol);
            if (!current.enabled || current.generationId !== generationId) return;
            const directory = this.directoryFor(libraryId, protocol);
            const fileName = `${createHash("sha256").update(library.id).digest("hex")}-${generationId}.jpg`;
            await fs.writeFile(path.join(directory, fileName), body);
            current.covers[library.id] = fileName;
            await this.writeState(libraryId, protocol, current);
          });
        } catch (error) {
          console.error("单个媒体库拼贴封面生成失败", { 协议: protocol, 媒体库ID: libraryId, 虚拟库ID: library.id, 错误: error });
        }
      }
    } finally {
      await this.removeUnusedFiles(libraryId, protocol, generationId);
    }
  }

  /** Chromium 只读取内嵌图片，使用与鸿蒙版相同的 1280×720 倾斜海报布局。 */
  private async render(pictures: CachedImage[], title: string, subtitle: string): Promise<Buffer> {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: process.env.FLYCLOUDHELPER_CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], proxy: getOutboundBrowserProxy() });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      const cards = Array.from({ length: 9 }, (_, index) => {
        const picture = pictures[index % pictures.length]!;
        const column = Math.floor(index / 3);
        const row = index % 3;
        const x = -52 + column * 312;
        const y = -665 + row * 457 - (column % 2) * 72;
        return `<img style="left:${x}px;top:${y}px" src="data:${picture.contentType.split(";", 1)[0] || "image/jpeg"};base64,${picture.body.toString("base64")}" />`;
      }).join("");
      const escape = (value: string): string => value.replace(/[&<>"']/gu, (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
      await page.setContent(`<!doctype html><html><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:0;width:1280px;height:720px;overflow:hidden;background:linear-gradient(125deg,#293d60,#151e31);color:white;font-family:"Noto Sans CJK SC",sans-serif}
        .cards{position:absolute;left:650px;top:360px;transform:rotate(14deg);transform-origin:0 0}
        .cards img{position:absolute;width:290px;height:435px;object-fit:cover;border-radius:24px;box-shadow:0 8px 14px #0005}
        .copy{position:absolute;left:64px;top:220px;width:480px}.copy h1{font-size:112px;line-height:1.2;margin:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.copy p{font-size:36px;margin-top:24px}
        </style><div class="cards">${cards}</div><div class="copy"><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>
        <script>window.addEventListener("load",()=>{try{const img=document.querySelector(".cards img");const canvas=document.createElement("canvas");canvas.width=32;canvas.height=32;const context=canvas.getContext("2d");context.drawImage(img,0,0,32,32);const pixels=context.getImageData(0,0,32,32).data;let r=0,g=0,b=0,count=0;for(let i=0;i<pixels.length;i+=16){if(pixels[i+3]<128)continue;r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];count++}if(!count)return;const color=[r,g,b].map(value=>Math.max(24,Math.round(value/count*.78)));document.body.style.background="linear-gradient(125deg,rgb("+color.join(",")+"),rgb("+color.map(value=>Math.round(value*.8)).join(",")+"))";const light=(color[0]*.2126+color[1]*.7152+color[2]*.0722)>128;document.querySelector(".copy").style.color=light?"#16191D":"#FFFFFF"}catch{}})</script></html>`, { waitUntil: "load" });
      return await page.screenshot({ type: "jpeg", quality: 92 });
    } finally { await browser.close(); }
  }

  /** 标准 Images/Primary 请求读取当前有效封面；旧代文件永远不会被展示。 */
  public async getCover(libraryId: string, protocol: CollageProtocol, virtualLibraryId: string): Promise<CollageCover | null> {
    const state = await this.readState(libraryId, protocol);
    const fileName = state.enabled ? state.covers[virtualLibraryId] : undefined;
    if (!fileName || !/^[a-f0-9]{64}-[a-f0-9-]{36}\.jpg$/u.test(fileName)) return null;
    try {
      const body = await fs.readFile(path.join(this.directoryFor(libraryId, protocol), fileName));
      return body.length > 0 ? { body, tag: fileName.slice(65, -4) } : null;
    } catch { return null; }
  }

  /** Views 只读取版本标签和文件状态，不把整张 JPEG 载入列表响应路径。 */
  public async getCoverTag(libraryId: string, protocol: CollageProtocol, virtualLibraryId: string): Promise<string | null> {
    const state = await this.readState(libraryId, protocol);
    const fileName = state.enabled ? state.covers[virtualLibraryId] : undefined;
    if (!fileName || !/^[a-f0-9]{64}-[a-f0-9-]{36}\.jpg$/u.test(fileName)) return null;
    try {
      const stat = await fs.stat(path.join(this.directoryFor(libraryId, protocol), fileName));
      return stat.isFile() && stat.size > 0 ? fileName.slice(65, -4) : null;
    } catch { return null; }
  }
}
