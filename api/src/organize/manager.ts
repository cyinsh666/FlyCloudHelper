import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { parseFlymbyVideoDirectory, parseFlymbyVideoName } from "../media/flymby-video-parser.js";
import { WebdavVideoNameParser } from "../media/app-recognition/WebdavVideoNameParser.js";
import { prepareOrganizeAi, recognizeUnmatchedByAi } from "./recognition-ai.js";
import type { ProviderAdapter, ProviderBrowseEntry, ProviderConnectionContext, ProviderFileOrganizer, ProviderMutationResult } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import type { OrganizeDirectory, OrganizeJob, OrganizeJobItem, OrganizeMode, OrganizePlan, OrganizePlanItem, OrganizeTaskSummary } from "./types.js";

const VIDEO_EXTENSION = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|mpg|mpeg|rmvb|webm|3gp|iso)$/iu;
const MAX_FILES = 5000;
const MAX_DIRECTORIES = 2000;
const MAX_ENTRIES = 20_000;
/** 临时网盘故障最多自动继续三次，间隔逐步增加，避免故障期间反复写网盘。 */
const AUTO_RETRY_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);
/** 只接受明确表示连接中断或限流的稳定错误码，不把凭据、冲突和文件变化列入自动重试。 */
const RETRYABLE_PROVIDER_CODES = new Set([
  "provider_connection_timeout", "provider_connection_refused", "provider_network_unreachable",
  "provider_dns_resolution_failed", "provider_unavailable", "provider_rate_limited",
  "cloud139_rate_limited", "quark_organize_move_pending",
]);

/** 仅临时网络、限流及已持久化的远端任务等待超时可自动继续。 */
function isRetryableOrganizeFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (RETRYABLE_PROVIDER_CODES.has(error.code)) return true;
    return error.code === "provider_request_failed" && /状态码 (?:429|502|503|504)$/u.test(error.message);
  }
  if (!(error instanceof Error)) return false;
  return error.message === "网盘文件任务等待超时，可稍后继续任务"
    || error.message === "传输结果尚未确认，请稍后继续任务"
    || error.message === "批量覆盖删除尚未完成，请稍后继续任务";
}

/** 从文件名提取可重复验证的命名标签，不读取媒体字节。 */
function readNameTags(name: string, resolution: string, source: string): string[] {
  const tags: string[] = [];
  for (const candidate of [resolution, source]) if (candidate && !tags.includes(candidate)) tags.push(candidate);
  for (const pattern of [/\b(?:4K|8K|2160p|1440p|1080p|720p|576p|480p)\b/iu,
    /\b(?:WEB[ ._-]?DL|WEB[ ._-]?Rip|BluRay|BDRip|REMUX|HDTV)\b/iu,
    /\b(?:HEVC|AVC|H\.?26[45]|X\.?26[45])\b/iu, /\b(?:HDR10\+?|HDR|DV|Dolby[ ._-]?Vision)\b/iu,
    /\b(?:Atmos|DTS(?:-HD)?|TrueHD|AAC|DDP?(?:[ ._-]?[257]\.[01])?)\b/iu]) {
    const value = pattern.exec(name)?.[0]?.replace(/[ ._-]+/gu, "-") ?? "";
    if (value && !tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) tags.push(value);
  }
  return tags.map((tag) => tag.replace(/[^\p{L}\p{N}+.-]/gu, "").slice(0, 40)).filter(Boolean);
}

/** 文件系统安全名称只处理路径非法字符，标题身份仍由 TMDB 匹配决定。 */
function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").replace(/[. ]+$/gu, "").trim().slice(0, 160);
}

/** 作品匹配只接受唯一的标题及年份结果，不在含糊候选中自动猜一个。 */
function sameTitle(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

/** 深度优先目录清理与目标路径比较使用规范展示路径，不将展示路径用作网盘写入定位。 */
function normalizedPath(value: string): string {
  return `/${value.split("/").filter(Boolean).join("/")}`;
}

/** 以原子替换方式保存一个计划或任务，避免进程退出留下半份 JSON。 */
async function saveJson(fileName: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(fileName), { recursive: true, mode: 0o700 });
  const temporary = `${fileName}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, fileName);
}

/** 读取持久对象；无效或不存在的 ID 由调用端返回稳定 404。 */
async function readJson<T>(fileName: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(fileName, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

interface OrganizeContext {
  adapter: ProviderAdapter;
  organizer: ProviderFileOrganizer;
  connection: Record<string, unknown>;
  providerContext: ProviderConnectionContext;
  userId: string;
  credentialRevision: number;
  /** 仅当前执行任务复用已确认的目标目录，避免每集重复列出分类、作品和季目录。 */
  targetDirectoryCache?: Map<string, OrganizeDirectory>;
  /** 批量传输后复用最近一次核验的目标子项；每次改名后立即刷新。 */
  directTargetListings?: Map<string, ProviderBrowseEntry[]>;
  /** 已进入旧暂存流程的历史任务继续按原阶段恢复。 */
  directEnabled?: boolean;
}

/** 已读取详情并通过唯一标题核验的 TMDB 作品。 */
interface MatchedTitle {
  id: number;
  title: string;
  year: number | null;
  genres: string[];
}

/** 网盘服务级影片整理编排；计划、任务和文件阶段与媒体库彻底隔离。 */
export class ServiceOrganizeManager {
  private readonly directory: string;
  private readonly activeServices = new Set<string>();
  private readonly activePlans = new Set<string>();
  private readonly jobWrites = new Map<string, Promise<void>>();
  private readonly creatingServices = new Set<string>();

  public constructor(private readonly runtime: ApiRuntime) {
    this.directory = path.join(runtime.config.exportDirectory, "service-organize");
  }

  /** 返回服务当前写能力，官方光鸭模式与其他只读网盘都不开放入口。 */
  public async capabilities(serviceId: string, actorUserId?: string): Promise<{ supported: boolean; mode: string; reason: string | null }> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    const adapter = this.runtime.providers.get(service.providerType);
    const connection = this.runtime.vault.decrypt(await this.runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
    const supported = service.status === "active" && service.connectionStatus === "valid"
      && Boolean(adapter.fileOrganizer?.supports(connection));
    const reason = service.status !== "active" || service.connectionStatus !== "valid"
      ? "网盘服务当前不可用，请先恢复连接"
      : "当前网盘或登录方式不支持影片整理";
    return { supported, mode: String(connection.authMode ?? ""), reason: supported ? null : reason };
  }

  /** 读取服务连接与 Provider 写适配，并保持 OAuth 令牌刷新后原位保存。 */
  private async context(serviceId: string, actorUserId?: string): Promise<OrganizeContext> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    if (service.status !== "active" || service.connectionStatus !== "valid") {
      throw new ApiError(409, "organize_service_unavailable", "网盘服务当前不可用，请先恢复连接");
    }
    const adapter = this.runtime.providers.get(service.providerType);
    const connection = this.runtime.vault.decrypt(await this.runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
    const organizer = adapter.fileOrganizer;
    if (!organizer?.supports(connection)) throw new ApiError(422, "organize_not_supported", "当前网盘或登录方式不支持影片整理");
    return {
      adapter, organizer, connection, userId: service.userId, credentialRevision: service.credentialRevision,
      providerContext: { persistConnection: async (nextConnection) => this.runtime.repository.refreshActiveEncryptedConnection({
        serviceId: service.id, userId: service.userId, credentialRevision: service.credentialRevision,
        encryptedConnection: this.runtime.vault.encrypt(nextConnection),
      }) },
    };
  }

  /** 以真实目录列表逐层核验前端选择，不能相信传入的显示路径或资源 ID。 */
  private async requireDirectory(context: OrganizeContext, selected: OrganizeDirectory): Promise<OrganizeDirectory> {
    if (!selected || typeof selected.resourceId !== "string" || typeof selected.displayPath !== "string") {
      throw new ApiError(422, "organize_directory_invalid", "请选择有效的网盘目录");
    }
    const current = await this.findDirectory(context, normalizedPath(selected.displayPath));
    if (!current) throw new ApiError(404, "organize_directory_missing", "所选网盘目录已不存在，请重新选择");
    if (current.resourceId !== selected.resourceId) throw new ApiError(409, "organize_directory_changed", "目录已变化，请重新选择");
    return current;
  }

  /** 从网盘根目录按真实名称定位路径，重启清理时目录已删除则返回空。 */
  private async findDirectory(context: OrganizeContext, displayPath: string): Promise<OrganizeDirectory | null> {
    const root = await context.adapter.browseEntries(context.connection, undefined, undefined, context.providerContext);
    let current: OrganizeDirectory = { resourceId: root.current.resourceId, displayPath: root.current.displayPath };
    for (const name of displayPath.split("/").filter(Boolean)) {
      const listing = await context.adapter.browseEntries(context.connection, current, undefined, context.providerContext);
      const next = listing.items.find((entry) => entry.isDirectory && entry.name === name);
      if (!next) return null;
      current = { resourceId: next.resourceId, displayPath: next.displayPath };
    }
    return current;
  }

  /** 创建只读预览任务，递归枚举和 TMDB 匹配在响应之后后台执行。 */
  public async createPlan(serviceId: string, actorUserId: string | undefined, input: {
    sources: OrganizeDirectory[]; target: OrganizeDirectory; mode: OrganizeMode;
    unrecognizedTransferEnabled?: boolean; unrecognizedDirectory?: OrganizeDirectory | null;
    aiAssistEnabled?: boolean; aiModelId?: string | null;
  }): Promise<OrganizePlan> {
    const context = await this.context(serviceId, actorUserId);
    if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 20
      || (input.mode !== "move" && input.mode !== "copy")) {
      throw new ApiError(422, "organize_selection_invalid", "请选择 1 至 20 个来源目录和整理模式");
    }
    const sources = await Promise.all(input.sources.map((item) => this.requireDirectory(context, item)));
    const target = await this.requireDirectory(context, input.target);
    if (input.unrecognizedTransferEnabled !== undefined && typeof input.unrecognizedTransferEnabled !== "boolean"
      || input.aiAssistEnabled !== undefined && typeof input.aiAssistEnabled !== "boolean") {
      throw new ApiError(422, "organize_options_invalid", "未识别转移或 AI 辅助选项无效");
    }
    const unrecognizedDirectory = input.unrecognizedTransferEnabled
      ? await this.requireDirectory(context, input.unrecognizedDirectory!) : null;
    const aiModelId = input.aiAssistEnabled ? String(input.aiModelId ?? "").trim() : null;
    if (input.aiAssistEnabled && !aiModelId) throw new ApiError(422, "organize_ai_model_missing", "请选择 AI 模型");
    const selectedSources = [...new Map(sources.map((item) => [item.resourceId, item])).values()];
    // 关键变量：同时选择父目录和子目录时只扫描父目录一次。
    const uniqueSources = selectedSources.filter((source) => !selectedSources.some((other) => other !== source
      && source.displayPath.startsWith(`${other.displayPath.replace(/\/$/u, "")}/`)));
    for (const source of uniqueSources) {
      if (target.displayPath === source.displayPath || target.displayPath.startsWith(`${source.displayPath.replace(/\/$/u, "")}/`)
        || source.displayPath.startsWith(`${target.displayPath.replace(/\/$/u, "")}/`)) {
        throw new ApiError(422, "organize_directories_overlap", "来源目录与目标目录不能互相包含");
      }
      if (unrecognizedDirectory && (unrecognizedDirectory.displayPath === source.displayPath
        || unrecognizedDirectory.displayPath.startsWith(`${source.displayPath.replace(/\/$/u, "")}/`)
        || source.displayPath.startsWith(`${unrecognizedDirectory.displayPath.replace(/\/$/u, "")}/`))) {
        throw new ApiError(422, "organize_unrecognized_overlap", "未识别目录与来源目录不能互相包含");
      }
    }
    if (unrecognizedDirectory && (unrecognizedDirectory.displayPath === target.displayPath
      || unrecognizedDirectory.displayPath.startsWith(`${target.displayPath.replace(/\/$/u, "")}/`)
      || target.displayPath.startsWith(`${unrecognizedDirectory.displayPath.replace(/\/$/u, "")}/`))) {
      throw new ApiError(422, "organize_targets_overlap", "未识别目录与整理目标目录不能互相包含");
    }
    const now = new Date().toISOString();
    const plan: OrganizePlan = { id: randomUUID(), userId: context.userId, serviceId, credentialRevision: context.credentialRevision,
      mode: input.mode, sourceDirectories: uniqueSources, targetDirectory: target, scannedDirectories: [],
      unrecognizedTransferEnabled: Boolean(input.unrecognizedTransferEnabled), unrecognizedDirectory,
      aiAssistEnabled: Boolean(input.aiAssistEnabled), aiModelId,
      aiFailureCount: 0, status: "preparing", error: null, items: [], createdAt: now, updatedAt: now };
    await this.withExclusiveScanSlot(serviceId, () => saveJson(this.planPath(plan.id), plan));
    this.activePlans.add(plan.id);
    void this.preparePlan(plan, context).catch(() => {
      console.error("影片整理预览保存失败");
    }).finally(() => this.activePlans.delete(plan.id));
    return plan;
  }

  /** 返回当前用户的预览，避免计划 ID 越权读取其他账号路径。 */
  public async getPlan(serviceId: string, planId: string, actorUserId?: string): Promise<OrganizePlan> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    const plan = await readJson<OrganizePlan>(this.planPath(planId));
    if (!plan || plan.serviceId !== serviceId || plan.userId !== service.userId) throw new ApiError(404, "organize_plan_missing", "整理预览不存在");
    return plan;
  }

  /** 编制目录清单和自动命名；任何 Provider 读取失败都保留失败状态，不伪装为末页。 */
  private async preparePlan(plan: OrganizePlan, context: OrganizeContext): Promise<void> {
    try {
      plan.items = [];
      plan.scannedDirectories = [];
      plan.aiFailureCount = 0;
      const entries: ProviderBrowseEntry[] = [];
      // 关键变量：保留完整目录子项，整夹转移前需确认目录树没有变化。
      const allEntries: ProviderBrowseEntry[] = [];
      // 关键变量：AI 仅参考同目录视频和 NFO 名称，不额外下载文件或读取视频内容。
      const siblingNamesByDirectory = new Map<string, string[]>();
      const seenDirectories = new Set<string>();
      const queue = [...plan.sourceDirectories];
      while (queue.length > 0) {
        if (seenDirectories.size >= MAX_DIRECTORIES) throw new ApiError(422, "organize_directory_limit", "来源目录超过 2000 个，请缩小范围");
        const directory = queue.shift()!;
        if (seenDirectories.has(directory.resourceId)) continue;
        seenDirectories.add(directory.resourceId);
        plan.scannedDirectories.push(directory);
        const listing = await context.adapter.browseEntries(context.connection, directory, undefined, context.providerContext);
        siblingNamesByDirectory.set(directory.displayPath, listing.items.filter((entry) => !entry.isDirectory
          && (VIDEO_EXTENSION.test(entry.name) || /\.nfo$/iu.test(entry.name)))
          .map((entry) => entry.name).slice(0, 24));
        for (const entry of listing.items) {
          if (plan.unrecognizedTransferEnabled) allEntries.push(entry);
          if (entry.isDirectory) queue.push({ resourceId: entry.resourceId, displayPath: entry.displayPath });
          else if (VIDEO_EXTENSION.test(entry.name)) entries.push(entry);
        }
        if (entries.length > MAX_FILES) throw new ApiError(422, "organize_file_limit", "视频文件超过 5000 个，请缩小范围");
        if (allEntries.length > MAX_ENTRIES) throw new ApiError(422, "organize_entry_limit", "未识别转移涉及的内容超过 20000 项，请缩小范围");
      }
      const matchCache = new Map<string, MatchedTitle | null>();
      // 关键变量：APP 的目录识别需要同一目录的全部视频，按真实路径分组，不改动网盘资源路径。
      const videosByDirectory = new Map<string, ProviderBrowseEntry[]>();
      for (const entry of entries) {
        const directoryPath = path.posix.dirname(entry.displayPath);
        const siblings = videosByDirectory.get(directoryPath) ?? [];
        siblings.push(entry);
        videosByDirectory.set(directoryPath, siblings);
      }
      // 关键变量：多个来源目录可能嵌套，使用最近的扫描根保持 APP 的目录上下文边界。
      const sourceRoots = [...plan.sourceDirectories].sort((left, right) => right.displayPath.length - left.displayPath.length);
      // 关键变量：完整目录规则只解析一次，随后按同目录文件的资源 ID 复用识别结果。
      const directoryRecognitionCache = new Map<string, ReturnType<typeof parseFlymbyVideoDirectory>>();
      let aiSnapshot: Awaited<ReturnType<typeof prepareOrganizeAi>> = null;
      if (plan.aiAssistEnabled) {
        try { aiSnapshot = await prepareOrganizeAi(this.runtime, plan.aiModelId ?? ""); }
        catch (error) {
          this.runtime.logBusinessEvent("warn", {
            日志关键字: "codex-flycloud-organize-ai", 事件: "AI模型不可用，继续规则识别",
            服务ID: plan.serviceId, 预览ID: plan.id,
            错误信息: error instanceof Error ? error.message : "AI 模型不可用",
          });
        }
      }
      // 关键变量：同一目录的同一规则查询词只向模型询问一次，已识别影片绝不调用模型。
      const aiCache = new Map<string, Pick<ReturnType<typeof parseFlymbyVideoName>,
        "title" | "query" | "mediaType" | "year" | "tmdbId" | "seasonNumber" | "episodeNumber" | "episodeNumbers"> | null>();
      // 关键变量：模型请求失败表示识别尚未完成，这些来源不能自动转入未识别目录。
      const aiFailedSourceIds = new Set<string>();
      for (const entry of entries) {
        const fileParsed = parseFlymbyVideoName({ ...entry, path: entry.displayPath, name: entry.name,
          parentResourceId: entry.parentResourceId, etag: entry.etag }, "/");
        const directoryPath = path.posix.dirname(entry.displayPath);
        let directoryRecognition = directoryRecognitionCache.get(directoryPath);
        if (!directoryRecognition) {
          // 只清理供识别使用的副本；部分网盘目录含零宽字符，会妨碍节目名和年份提取。
          const recognitionEntries = (videosByDirectory.get(directoryPath) ?? [entry]).map((sibling) => ({
            ...sibling, path: sibling.displayPath.replace(/\p{Cf}/gu, ""),
            name: sibling.name.replace(/\p{Cf}/gu, ""),
          }));
          const sourceRoot = sourceRoots.find((root) => directoryPath === root.displayPath
            || directoryPath.startsWith(`${root.displayPath.replace(/\/$/u, "")}/`));
          directoryRecognition = parseFlymbyVideoDirectory(recognitionEntries,
            (sourceRoot?.displayPath ?? "/").replace(/\p{Cf}/gu, ""));
          directoryRecognitionCache.set(directoryPath, directoryRecognition);
        }
        const directoryParsed = directoryRecognition.get(entry.resourceId);
        let parsed = directoryParsed?.mediaType === "tv" ? directoryParsed : fileParsed;
        let key = JSON.stringify([parsed.mediaType, parsed.query, parsed.year, parsed.tmdbId]);
        if (!matchCache.has(key)) matchCache.set(key, await this.matchEntry(parsed));
        let matched = matchCache.get(key)!;
        if (!matched && parsed !== fileParsed && fileParsed.mediaType === parsed.mediaType
          && fileParsed.seasonNumber === parsed.seasonNumber
          && fileParsed.episodeNumber === parsed.episodeNumber) {
          const fileKey = JSON.stringify([fileParsed.mediaType, fileParsed.query, fileParsed.year, fileParsed.tmdbId]);
          if (!matchCache.has(fileKey)) matchCache.set(fileKey, await this.matchEntry(fileParsed));
          const fileMatch = matchCache.get(fileKey)!;
          if (fileMatch) { parsed = fileParsed; matched = fileMatch; key = fileKey; }
        }
        // 英文发行名可以作为 TMDB 的搜索别名；命中后仍读取正式作品详情。
        if (!matched && parsed.tmdbId <= 0 && parsed.fallbackQuery) {
          const alternate = { ...parsed, title: parsed.fallbackQuery, query: parsed.fallbackQuery };
          const alternateKey = JSON.stringify([alternate.mediaType, alternate.query, alternate.year, alternate.tmdbId]);
          if (!matchCache.has(alternateKey)) matchCache.set(alternateKey, await this.matchEntry(alternate));
          matched = matchCache.get(alternateKey)!;
        }
        // 同一电影目录中的数字版本缺少片名时，可借用另一版本文件名中的英文发行名。
        const siblingVideos = videosByDirectory.get(directoryPath) ?? [];
        if (!matched && parsed.tmdbId <= 0 && siblingVideos.length > 1 && siblingVideos.length <= 5) {
          for (const sibling of siblingVideos) {
            if (sibling.resourceId === entry.resourceId) continue;
            const siblingParsed = parseFlymbyVideoName({ ...sibling, path: sibling.displayPath, name: sibling.name,
              parentResourceId: sibling.parentResourceId, etag: sibling.etag }, "/");
            if (!sameTitle(siblingParsed.title, parsed.title) || !siblingParsed.fallbackQuery) continue;
            const alternate = { ...parsed, title: siblingParsed.fallbackQuery, query: siblingParsed.fallbackQuery };
            const alternateKey = JSON.stringify([alternate.mediaType, alternate.query, alternate.year, alternate.tmdbId]);
            if (!matchCache.has(alternateKey)) matchCache.set(alternateKey, await this.matchEntry(alternate));
            matched = matchCache.get(alternateKey)!;
            if (matched) break;
          }
        }
        // 单个纯数字文件可能被目录规则判作电影；仅当同名剧集在 TMDB 唯一匹配时恢复集号。
        if (!matched && parsed.tmdbId <= 0 && parsed.mediaType === "movie"
          && /^\d{1,3}$/u.test(path.parse(entry.name).name)) {
          const numericEpisode = WebdavVideoNameParser.parse(entry.name, entry.displayPath);
          if (numericEpisode.mediaType === "tv" && numericEpisode.episodeNumber > 0) {
            const series = { ...parsed, mediaType: "tv" as const,
              seasonNumber: numericEpisode.seasonNumber, episodeNumber: numericEpisode.episodeNumber,
              episodeNumbers: numericEpisode.episodeNumbers };
            const seriesKey = JSON.stringify([series.mediaType, series.query, series.year, series.tmdbId]);
            if (!matchCache.has(seriesKey)) matchCache.set(seriesKey, await this.matchEntry(series));
            const seriesMatch = matchCache.get(seriesKey)!;
            if (seriesMatch) { parsed = series; matched = seriesMatch; key = seriesKey; }
          }
        }
        const ruleItem = this.makeItem(entry, parsed, matched);
        if (ruleItem.status === "skipped" && plan.aiAssistEnabled && !aiSnapshot) {
          plan.aiFailureCount = (plan.aiFailureCount ?? 0) + 1;
          aiFailedSourceIds.add(entry.resourceId);
          ruleItem.reason = "AI 辅助识别未完成，来源文件已保留";
        }
        if (ruleItem.status === "skipped" && aiSnapshot) {
          const aiKey = JSON.stringify([parsed.mediaType, parsed.query || entry.name, parsed.year,
            path.posix.dirname(entry.displayPath), parsed.seasonNumber,
            parsed.episodeNumber > 0 && parsed.seasonNumber >= 0 ? "" : entry.name]);
          if (!aiCache.has(aiKey)) {
            try {
              const assisted = await recognizeUnmatchedByAi(this.runtime, aiSnapshot, entry, parsed,
                siblingNamesByDirectory.get(directoryPath) ?? []);
              aiCache.set(aiKey, { title: assisted.title, query: assisted.query, mediaType: assisted.mediaType,
                year: assisted.year, tmdbId: assisted.tmdbId, seasonNumber: assisted.seasonNumber,
                episodeNumber: assisted.episodeNumber, episodeNumbers: assisted.episodeNumbers });
            } catch (error) {
              aiCache.set(aiKey, null);
              this.runtime.logBusinessEvent("warn", {
                日志关键字: "codex-flycloud-organize-ai", 事件: "未识别条目AI失败，继续规则结果",
                服务ID: plan.serviceId, 预览ID: plan.id, 来源资源ID: entry.resourceId,
                错误代码: error instanceof ApiError ? error.code : "organize_ai_request_failed",
                错误信息: error instanceof Error ? error.message : "AI 辅助识别失败",
              });
            }
          }
          const assisted = aiCache.get(aiKey);
          if (!assisted) {
            plan.aiFailureCount = (plan.aiFailureCount ?? 0) + 1;
            aiFailedSourceIds.add(entry.resourceId);
            ruleItem.reason = "AI 辅助识别未完成，来源文件已保留";
            plan.items.push(ruleItem);
            continue;
          }
          const seasonNumber = parsed.seasonNumber >= 0 ? parsed.seasonNumber : assisted.seasonNumber;
          const episodeNumber = parsed.episodeNumber > 0 ? parsed.episodeNumber : assisted.episodeNumber;
          const episodeNumbers = parsed.episodeNumber > 0 ? parsed.episodeNumbers : assisted.episodeNumbers;
          parsed = matched ? { ...parsed, seasonNumber, episodeNumber, episodeNumbers }
            : { ...parsed, ...assisted, seasonNumber, episodeNumber, episodeNumbers };
          if (!matched) {
            key = JSON.stringify([parsed.mediaType, parsed.query, parsed.year, parsed.tmdbId]);
            if (!matchCache.has(key)) matchCache.set(key, await this.matchEntry(parsed));
            matched = matchCache.get(key)!;
          }
        }
        const assistedItem = this.makeItem(entry, parsed, matched);
        plan.items.push(assistedItem.status === "ready" ? assistedItem : ruleItem);
      }
      if (plan.unrecognizedTransferEnabled && plan.unrecognizedDirectory) {
        this.addUnrecognizedItems(plan, allEntries, aiFailedSourceIds);
      }
      const targets = new Set<string>();
      for (const item of plan.items) {
        if (item.status !== "ready") continue;
        const key = [item.action === "unrecognized" ? "unrecognized" : "organize", ...item.targetParts, item.targetName].join("/");
        if (targets.has(key)) { item.status = "skipped"; item.reason = "多个来源文件生成相同目标路径"; }
        else targets.add(key);
      }
      // 关键变量：目标目录列表在本次预览中按资源 ID 缓存，避免同作品几千集重复请求网盘。
      const targetListings = new Map<string, ProviderBrowseEntry[]>();
      for (const item of plan.items) {
        if (item.status !== "ready") continue;
        let parent: OrganizeDirectory | null = item.action === "unrecognized" && plan.unrecognizedDirectory
          ? plan.unrecognizedDirectory : plan.targetDirectory;
        for (const name of item.targetParts) {
          if (!parent) break;
          let listing = targetListings.get(parent.resourceId);
          if (!listing) { listing = await this.children(context, parent); targetListings.set(parent.resourceId, listing); }
          const found = listing.find((entry) => entry.name === name);
          if (!found) { parent = null; break; }
          if (!found.isDirectory) { item.status = "skipped"; item.reason = `目标目录名被文件占用：${name}`; parent = null; break; }
          parent = { resourceId: found.resourceId, displayPath: found.displayPath };
        }
        if (!parent || item.status !== "ready") continue;
        let listing = targetListings.get(parent.resourceId);
        if (!listing) { listing = await this.children(context, parent); targetListings.set(parent.resourceId, listing); }
        const target = listing.find((entry) => entry.name === item.targetName);
        if (item.action === "unrecognized" && target) {
          item.status = "skipped"; item.reason = "未识别目标已有同名内容，已跳过以避免覆盖";
        } else if (target?.isDirectory) { item.status = "skipped"; item.reason = "目标文件名被目录占用"; }
        else item.willOverwrite = Boolean(target);
      }
      plan.status = "ready";
    } catch (error) {
      plan.status = "failed";
      plan.error = error instanceof Error ? error.message : "整理预览生成失败";
    }
    plan.updatedAt = new Date().toISOString();
    await saveJson(this.planPath(plan.id), plan);
  }

  /** 将规则及 AI 最终无法识别的内容放进独立目录；纯未识别子树整夹搬迁，混合目录仅保留原层级搬迁未识别文件。 */
  private addUnrecognizedItems(plan: OrganizePlan, allEntries: ProviderBrowseEntry[], aiFailedSourceIds: Set<string>): void {
    const unknown = plan.items.filter((item) => item.status === "skipped"
      && item.tmdbId === null && !aiFailedSourceIds.has(item.sourceId));
    // AI 未完成或已确认作品但无法按季集规则整理的文件留在来源目录，不能整夹搬走。
    const known = plan.items.filter((item) => item.status === "ready"
      || item.tmdbId !== null || aiFailedSourceIds.has(item.sourceId));
    const roots = [...plan.sourceDirectories].sort((left, right) => right.displayPath.length - left.displayPath.length);
    const scanned = new Map(plan.scannedDirectories.map((directory) => [directory.displayPath, directory]));
    const selectedFolders: string[] = [];
    const coveredFiles = new Set<string>();
    /** 查找来源根目录，仅保留其内部相对层级，来源根目录名不进入未识别目标。 */
    const rootOf = (filePath: string): OrganizeDirectory | undefined => roots.find((root) => filePath.startsWith(`${root.displayPath.replace(/\/$/u, "")}/`));
    /** 判断文件或子目录位于指定目录树内。 */
    const inside = (filePath: string, folderPath: string): boolean => filePath.startsWith(`${folderPath.replace(/\/$/u, "")}/`);
    for (const folder of [...plan.scannedDirectories].sort((left, right) => left.displayPath.length - right.displayPath.length)) {
      const root = rootOf(folder.displayPath);
      if (!root || folder.resourceId === root.resourceId || selectedFolders.some((selected) => inside(folder.displayPath, selected))) continue;
      const descendants = unknown.filter((item) => inside(item.sourcePath, folder.displayPath));
      if (!descendants.length || known.some((item) => inside(item.sourcePath, folder.displayPath))) continue;
      const parent = scanned.get(normalizedPath(path.posix.dirname(folder.displayPath)));
      if (!parent) continue;
      const relativeParent = path.posix.relative(root.displayPath, path.posix.dirname(folder.displayPath));
      plan.items.push({ sourceId: folder.resourceId, parentId: parent.resourceId,
        sourcePath: folder.displayPath, sourceName: path.posix.basename(folder.displayPath),
        size: 0, modifiedAt: null, isDirectory: true, action: "unrecognized",
        containedEntries: allEntries.filter((entry) => inside(entry.displayPath, folder.displayPath))
          .map((entry) => JSON.stringify([entry.resourceId, entry.name, entry.isDirectory, entry.size, entry.modifiedAt])).sort(),
        targetParts: relativeParent.split("/").filter(Boolean), targetName: path.posix.basename(folder.displayPath),
        category: "未识别", tmdbId: null, willOverwrite: false, status: "ready", reason: null });
      selectedFolders.push(folder.displayPath);
      descendants.forEach((item) => coveredFiles.add(item.sourceId));
    }
    // 关键变量：混合目录不能整夹移动，否则会带走已识别影片；仅转移其中未识别文件。
    for (const item of unknown) {
      if (coveredFiles.has(item.sourceId)) continue;
      const root = rootOf(item.sourcePath);
      if (!root) continue;
      const relativeParent = path.posix.relative(root.displayPath, path.posix.dirname(item.sourcePath));
      item.action = "unrecognized";
      item.targetParts = relativeParent.split("/").filter(Boolean);
      item.targetName = item.sourceName;
      item.category = "未识别";
      item.status = "ready";
      item.reason = null;
    }
    plan.items = plan.items.filter((item) => !coveredFiles.has(item.sourceId) || item.isDirectory);
  }

  /** 查询唯一且标题一致的 TMDB 作品身份，歧义结果交给计划跳过。 */
  private async matchEntry(parsed: ReturnType<typeof parseFlymbyVideoName>): Promise<MatchedTitle | null> {
    if (!parsed.query || !parsed.title) return null;
    if (parsed.tmdbId > 0) {
      const metadata = await this.runtime.tmdb.readVideoMetadata(parsed.mediaType, parsed.tmdbId, "zh-CN", "CN");
      return metadata && (sameTitle(parsed.title, metadata.title) || sameTitle(parsed.title, metadata.originalTitle))
        ? { id: metadata.id, title: metadata.title, year: metadata.year, genres: metadata.genres } : null;
    }
    const candidates = await this.runtime.tmdb.searchVideoCandidates({ mediaType: parsed.mediaType,
      title: parsed.query, year: parsed.year, language: "zh-CN", region: "CN" });
    const exact = candidates.filter((item) => (sameTitle(parsed.title, item.title) || sameTitle(parsed.title, item.originalTitle))
      && (!parsed.year || item.year === parsed.year));
    // TMDB 可能通过英文发行别名命中唯一作品，但中文地区返回的标题及原标题均非该英文名。
    const englishAlias = /[A-Za-z]{3}/u.test(parsed.query) && !/[\u3400-\u9fff]/u.test(parsed.query);
    const uniqueSameYearAlias = englishAlias && parsed.year !== null && candidates.length === 1
      && candidates[0]!.year === parsed.year ? candidates[0] : null;
    const accepted = exact.length === 1 ? exact[0] : exact.length === 0 ? uniqueSameYearAlias : null;
    if (!accepted) return null;
    const metadata = await this.runtime.tmdb.readVideoMetadata(parsed.mediaType, accepted.id, "zh-CN", "CN");
    return metadata ? { id: metadata.id, title: metadata.title, year: metadata.year, genres: metadata.genres } : null;
  }

  /** 使用同一作品名生成目录及文件名，缺少身份或季集号时只留跳过记录。 */
  private makeItem(entry: ProviderBrowseEntry, parsed: ReturnType<typeof parseFlymbyVideoName>,
    match: MatchedTitle | null): OrganizePlanItem {
    const base: OrganizePlanItem = { sourceId: entry.resourceId, parentId: entry.parentResourceId,
      sourcePath: entry.displayPath, sourceName: entry.name, size: entry.size, modifiedAt: entry.modifiedAt,
      targetParts: [], targetName: "", category: "", tmdbId: match?.id ?? null, willOverwrite: false,
      status: "skipped", reason: null };
    if (!match) { base.reason = "TMDB 身份不明确或无唯一精确匹配"; return base; }
    if (parsed.mediaType === "tv" && (parsed.seasonNumber < 0 || parsed.episodeNumber <= 0 || parsed.episodeNumbers.length > 1)) {
      base.reason = "季集号不明确或是多集文件"; return base;
    }
    const title = safeName(match.title);
    if (!title) { base.reason = "作品名无法生成合法目录"; return base; }
    const pathText = entry.displayPath;
    const anime = /动漫|动画|番剧/iu.test(pathText) || match.genres.some((genre) => /动画|animation/iu.test(genre));
    const variety = /综艺/iu.test(pathText) || match.genres.some((genre) => /真人秀|脱口秀|talk|reality/iu.test(genre));
    if (anime && variety) { base.reason = "作品分类冲突"; return base; }
    const category = parsed.mediaType === "movie" ? "电影" : anime ? "动漫" : variety ? "综艺" : "剧集";
    const year = match.year ?? parsed.year;
    const extension = path.extname(entry.name);
    const tags = readNameTags(entry.displayPath, parsed.resolution, parsed.source);
    const nameParts = [title, year ? String(year) : ""];
    if (parsed.mediaType === "tv") nameParts.push(`S${String(parsed.seasonNumber).padStart(2, "0")}E${String(parsed.episodeNumber).padStart(2, "0")}`, `第${parsed.episodeNumber}集`);
    const targetName = safeName([...nameParts, ...tags].filter(Boolean).join(".")) + extension;
    if ([...targetName].length > 255) { base.reason = "目标文件名超过网盘限制"; return base; }
    // 电影作品目录使用“片名 (年份) {tmdb-ID}”，剧集目录保持原有命名规则。
    const workDirectoryName = parsed.mediaType === "movie"
      ? `${title}${year ? ` (${year})` : ""} {tmdb-${match.id}}`
      : `${title}{tmdb-${match.id}}`;
    base.targetParts = [category, workDirectoryName, ...(parsed.mediaType === "tv" ? [`Season ${String(parsed.seasonNumber).padStart(2, "0")}`] : [])];
    base.targetName = targetName;
    base.category = category;
    base.status = "ready";
    return base;
  }

  /** 根据服务归属读取已保存任务，任务文件中不保存任何网盘凭据。 */
  public async getJob(serviceId: string, jobId: string, actorUserId?: string): Promise<OrganizeJob> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    const job = await readJson<OrganizeJob>(this.jobPath(jobId));
    if (!job || job.serviceId !== serviceId || job.userId !== service.userId) {
      throw new ApiError(404, "organize_job_missing", "整理任务不存在");
    }
    return job;
  }

  /** 列出当前服务任务，让刷新页面和重启后仍能找到执行进度。 */
  public async listJobs(serviceId: string, actorUserId?: string): Promise<OrganizeJob[]> {
    const service = await this.runtime.repository.getServiceDetail(serviceId, actorUserId);
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const jobs: OrganizeJob[] = [];
    for (const name of names) {
      if (!/^job-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const job = await readJson<OrganizeJob>(path.join(this.directory, name));
      if (job?.serviceId === serviceId && job.userId === service.userId) jobs.push(job);
    }
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 汇总权限范围内的整理任务与尚在识别的预览，供后台任务页读取进度。 */
  public async listTaskSummaries(actorUserId?: string): Promise<OrganizeTaskSummary[]> {
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const tasks: OrganizeTaskSummary[] = [];
    const jobPlanIds = new Set<string>();
    for (const name of names) {
      if (!/^job-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const job = await readJson<OrganizeJob>(path.join(this.directory, name));
      if (!job || actorUserId && job.userId !== actorUserId) continue;
      jobPlanIds.add(job.planId);
      tasks.push({ id: job.id, serviceId: job.serviceId, status: job.status,
        completedCount: job.items.filter((item) => item.stage === "completed").length,
        failedCount: job.items.filter((item) => item.stage === "failed").length,
        totalCount: job.items.length, error: job.error, autoRetryCount: job.autoRetryCount,
        nextRetryAt: job.nextRetryAt, createdAt: job.createdAt, updatedAt: job.updatedAt });
    }
    // 关键变量：已创建执行任务的预览不再作为第二条“识别中”任务展示。
    for (const name of names) {
      if (!/^schedule-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const schedule = await readJson<{ serviceId: string; userId: string; pendingPlanId: string | null }>(
        path.join(this.directory, name));
      if (!schedule?.pendingPlanId || actorUserId && schedule.userId !== actorUserId
        || jobPlanIds.has(schedule.pendingPlanId)) continue;
      const plan = await readJson<OrganizePlan>(this.planPath(schedule.pendingPlanId));
      if (!plan || plan.userId !== schedule.userId || plan.serviceId !== schedule.serviceId) continue;
      tasks.push({ id: plan.id, serviceId: plan.serviceId, status: "preparing", completedCount: 0,
        failedCount: 0, totalCount: null, error: plan.error,
        createdAt: plan.createdAt, updatedAt: plan.updatedAt });
    }
    return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 清除当前权限范围内已结束的整理记录及其预览，不触碰网盘文件和定时配置。 */
  public async clearFinishedJobs(actorUserId?: string): Promise<number> {
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    let deletedCount = 0;
    for (const name of names) {
      if (!/^job-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const fileName = path.join(this.directory, name);
      const stored = await readJson<OrganizeJob>(fileName);
      if (!stored || actorUserId && stored.userId !== actorUserId) continue;
      // 关键变量：任务可能在等待文件写入或自动继续；删除前读取最终状态。
      await this.jobWrites.get(stored.id);
      const job = await readJson<OrganizeJob>(fileName);
      if (!job || actorUserId && job.userId !== actorUserId
        || !["completed", "failed", "cancelled"].includes(job.status)) continue;
      // 计划刚落任务但调度器尚未清除待执行标记时，留给下一次清理，避免误删恢复依据。
      const schedule = await readJson<{ pendingPlanId: string | null }>(path.join(this.directory, `schedule-${job.serviceId}.json`));
      if (schedule?.pendingPlanId === job.planId) continue;
      await fs.unlink(fileName);
      await fs.unlink(this.planPath(job.planId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      deletedCount += 1;
    }
    return deletedCount;
  }

  /** 从预览创建后台任务；定时或立即执行的空结果也保存为已完成的执行记录。 */
  public async createJob(serviceId: string, planId: string, actorUserId?: string,
    recordEmptyExecution = false): Promise<OrganizeJob> {
    if (this.creatingServices.has(serviceId)) throw new ApiError(409, "organize_job_creating", "当前服务正在创建整理任务");
    this.creatingServices.add(serviceId);
    try {
      const context = await this.context(serviceId, actorUserId);
      await this.requireNoActiveScan(serviceId);
      const plan = await this.getPlan(serviceId, planId, actorUserId);
      await this.requireDirectory(context, plan.targetDirectory);
      if (plan.unrecognizedTransferEnabled && plan.unrecognizedDirectory) await this.requireDirectory(context, plan.unrecognizedDirectory);
      if (plan.status !== "ready" || plan.credentialRevision !== context.credentialRevision) {
        throw new ApiError(409, "organize_plan_stale", "预览尚未完成或服务凭据已变化，请重新预览");
      }
      const hasReadyItems = plan.items.some((item) => item.status === "ready");
      if (!hasReadyItems && !recordEmptyExecution) {
        throw new ApiError(422, "organize_plan_empty", "预览中没有可整理的影片");
      }
      const previous = await this.listJobs(serviceId, actorUserId);
      if (previous.some((job) => job.planId === planId)) {
        throw new ApiError(409, "organize_plan_used", "该预览已创建过任务，请重新生成预览");
      }
      if (this.activeServices.has(serviceId) || previous.some((job) => ["queued", "running", "paused"].includes(job.status))) {
        throw new ApiError(409, "organize_job_exists", "当前服务已有排队、运行或暂停的整理任务");
      }
      const now = new Date().toISOString();
      const job: OrganizeJob = { id: randomUUID(), planId, serviceId, userId: context.userId,
        credentialRevision: context.credentialRevision, status: hasReadyItems ? "queued" : "completed", workDirectoryId: null,
        stageDirectoryId: null, backupDirectoryId: null, error: null, autoRetryCount: 0, nextRetryAt: null,
        items: plan.items.map((item, index): OrganizeJobItem => ({ index, stage: "pending", sourceId: item.sourceId, stageRequested: false,
          stagedId: null, replacedId: null, targetParentId: null, stageParentId: null,
          backupParentId: null, pendingTaskId: null, error: null })).filter((item) => plan.items[item.index]?.status === "ready"),
        createdAt: now, updatedAt: now };
      await this.withExclusiveScanSlot(serviceId, () => this.saveJob(job));
      // 新计划由用户主动创建时，旧失败任务不再自动继续，避免两份计划先后写同一目标。
      for (const oldJob of previous) {
        if (oldJob.status !== "failed" || !oldJob.nextRetryAt) continue;
        oldJob.nextRetryAt = null;
        await this.saveJob(oldJob);
      }
      // 空结果只留下执行记录；没有网盘文件变化，不进入整理执行器或完成通知流程。
      if (hasReadyItems) this.startJob(job.id);
      return job;
    } finally { this.creatingServices.delete(serviceId); }
  }

  /** 共用服务行锁检查扫描状态，并在锁内落盘整理任务，避免双方同时创建。 */
  private async withExclusiveScanSlot<T>(serviceId: string, action: () => Promise<T>): Promise<T> {
    return this.runtime.database.query.transaction(async (transaction) => {
      let serviceLock = transaction("cloud_services").where({ id: serviceId }).select("id");
      if (this.runtime.database.databaseType !== "sqlite") serviceLock = serviceLock.forUpdate();
      await serviceLock.first();
      await this.requireNoActiveScan(serviceId, transaction);
      return action();
    });
  }

  /** 文件移动期间不与同服务正在排队或运行的扫描任务交叉。 */
  private async requireNoActiveScan(serviceId: string, query = this.runtime.database.query): Promise<void> {
    const scan = await query("scan_jobs").select("id")
      .where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first();
    if (scan) throw new ApiError(409, "organize_scan_active", "当前网盘服务有未结束的扫描任务，请稍后整理");
  }

  /** 暂停和取消只在当前文件完成后生效；automatic 只供到期轮询继续失败任务。 */
  public async controlJob(serviceId: string, jobId: string, action: "pause" | "resume" | "cancel",
    actorUserId?: string, automatic = false): Promise<OrganizeJob> {
    await this.getJob(serviceId, jobId, actorUserId);
    // 关键变量：控制操作与执行阶段共用串行写队列，避免暂停覆盖刚保存的文件进度。
    const previousWrite = this.jobWrites.get(jobId) ?? Promise.resolve();
    const update = previousWrite.catch(() => undefined).then(async () => {
      const job = await readJson<OrganizeJob>(this.jobPath(jobId));
      if (!job) throw new ApiError(404, "organize_job_missing", "整理任务不存在");
      if (action === "pause" && ["queued", "running"].includes(job.status)) job.status = "paused";
      else if (action === "resume" && ["paused", "failed"].includes(job.status)) {
        // 旧失败任务允许手动继续，但不能与同服务的新任务并行执行。
        const occupied = this.activeServices.has(serviceId) || this.creatingServices.has(serviceId)
          || (await this.listJobs(serviceId, actorUserId)).some((other) => other.id !== jobId
            && ["queued", "running", "paused"].includes(other.status));
        if (occupied) throw new ApiError(409, "organize_job_exists", "当前服务已有排队、运行或暂停的整理任务");
        if (automatic && (!job.nextRetryAt || job.nextRetryAt > new Date().toISOString()
          || (job.autoRetryCount ?? 0) >= AUTO_RETRY_DELAYS_MS.length)) {
          throw new ApiError(409, "organize_retry_not_due", "整理任务尚未到自动重试时间");
        }
        job.status = "queued";
        job.error = null;
        job.autoRetryCount = automatic ? (job.autoRetryCount ?? 0) + 1 : 0;
        job.nextRetryAt = null;
        for (const item of job.items) if (item.stage === "failed") { item.stage = "pending"; item.error = null; }
      } else if (action === "cancel" && ["queued", "running", "paused", "failed"].includes(job.status)) {
        job.status = "cancelled";
        job.nextRetryAt = null;
      }
      else throw new ApiError(409, "organize_job_action_invalid", "当前任务状态不支持此操作");
      job.updatedAt = new Date().toISOString();
      if (action === "resume") await this.withExclusiveScanSlot(serviceId, () => saveJson(this.jobPath(jobId), job));
      else await saveJson(this.jobPath(jobId), job);
      return job;
    });
    const write = update.then(() => undefined, () => undefined);
    this.jobWrites.set(jobId, write);
    let job: OrganizeJob;
    try { job = await update; }
    finally { if (this.jobWrites.get(jobId) === write) this.jobWrites.delete(jobId); }
    if (action === "resume") this.startJob(job.id);
    return job;
  }

  /** 定时轮询只继续当前任务，不重建预览；进程重启后仍读取持久化的重试时间。 */
  public async resumeDueFailedJobs(): Promise<void> {
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    // 关键变量：每个服务只看最新任务，旧失败任务不会在新计划完成后重新启动。
    const latestByService = new Map<string, OrganizeJob>();
    for (const name of names) {
      if (!/^job-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const job = await readJson<OrganizeJob>(path.join(this.directory, name));
      if (!job) continue;
      const previous = latestByService.get(job.serviceId);
      if (!previous || job.createdAt > previous.createdAt) latestByService.set(job.serviceId, job);
    }
    for (const job of latestByService.values()) {
      if (!job || job.status !== "failed" || !job.nextRetryAt || job.nextRetryAt > new Date().toISOString()
        || this.activeServices.has(job.serviceId) || this.creatingServices.has(job.serviceId)) continue;
      try {
        await this.requireNoActiveScan(job.serviceId);
        await this.controlJob(job.serviceId, job.id, "resume", job.userId, true);
      } catch (error) {
        // 其它任务和扫描暂时占用服务时保留原重试时间，下次轮询再尝试。
        if (error instanceof ApiError && ["organize_job_exists", "organize_scan_active", "organize_retry_not_due"].includes(error.code)) continue;
        this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-flycloud-organize-retry",
          事件: "整理任务自动继续失败", 任务ID: job.id,
          错误信息: error instanceof Error ? error.message : "未知错误" });
      }
    }
  }

  /** 服务启动后恢复之前正在运行的任务，暂停和失败任务由用户明确继续。 */
  public async resumePending(): Promise<void> {
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    for (const name of names) {
      if (/^plan-[0-9a-f-]{36}\.json$/iu.test(name)) {
        const plan = await readJson<OrganizePlan>(path.join(this.directory, name));
        if (plan?.status === "preparing" && !this.activePlans.has(plan.id)) {
          this.activePlans.add(plan.id);
          void this.context(plan.serviceId, plan.userId).then((context) => this.preparePlan(plan, context))
            .catch(async (error) => {
              plan.status = "failed";
              plan.error = error instanceof Error ? error.message : "预览恢复失败";
              await saveJson(this.planPath(plan.id), plan);
            }).finally(() => this.activePlans.delete(plan.id));
        }
      }
      if (!/^job-[0-9a-f-]{36}\.json$/iu.test(name)) continue;
      const job = await readJson<OrganizeJob>(path.join(this.directory, name));
      if (job && ["queued", "running"].includes(job.status)) this.startJob(job.id);
    }
  }

  /** 每个服务串行执行，避免两份任务同时修改同一目标目录。 */
  private startJob(jobId: string): void {
    void (async () => {
      const job = await readJson<OrganizeJob>(this.jobPath(jobId));
      if (!job || this.activeServices.has(job.serviceId)) return;
      this.activeServices.add(job.serviceId);
      try { await this.runJob(job.id); }
      finally {
        this.activeServices.delete(job.serviceId);
        const latest = await readJson<OrganizeJob>(this.jobPath(job.id));
        if (latest?.status === "queued") this.startJob(job.id);
      }
    })().catch(() => {
      console.error("影片整理后台任务启动失败");
    });
  }

  /** 写入最新任务阶段，所有远端写操作前后都持久化状态。 */
  private async saveJob(job: OrganizeJob): Promise<void> {
    const previousWrite = this.jobWrites.get(job.id) ?? Promise.resolve();
    const write = previousWrite.catch(() => undefined).then(async () => {
      const previous = await readJson<OrganizeJob>(this.jobPath(job.id));
      if (previous && ["paused", "cancelled"].includes(previous.status)
        && ["running", "completed", "failed"].includes(job.status)) job.status = previous.status;
      job.updatedAt = new Date().toISOString();
      await saveJson(this.jobPath(job.id), job);
    });
    this.jobWrites.set(job.id, write);
    try { await write; }
    finally { if (this.jobWrites.get(job.id) === write) this.jobWrites.delete(job.id); }
  }

  /** 保留失败文件阶段，仅为可恢复故障记录下一次自动继续时间。 */
  private async failJob(job: OrganizeJob, error: unknown): Promise<void> {
    job.status = "failed";
    const attempts = job.autoRetryCount ?? 0;
    job.nextRetryAt = isRetryableOrganizeFailure(error) && attempts < AUTO_RETRY_DELAYS_MS.length
      ? new Date(Date.now() + AUTO_RETRY_DELAYS_MS[attempts]!).toISOString() : null;
    await this.saveJob(job);
  }

  /** 远端任务必须完成才允许进入下一阶段。 */
  private async waitMutation(context: OrganizeContext, result: ProviderMutationResult, job?: OrganizeJob, item?: OrganizeJobItem): Promise<void> {
    if (!result.taskId) return;
    if (item && job) { item.pendingTaskId = result.taskId; await this.saveJob(job); }
    // 光鸭按 LitePan 的 300 毫秒节奏查询任务；其他网盘保持原有一秒间隔和总等待时长。
    const pollIntervalMs = context.adapter.descriptor.type === "guangya" ? 300 : 1000;
    const maxAttempts = Math.ceil(300_000 / pollIntervalMs);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await context.organizer.taskStatus(context.connection, result.taskId, context.providerContext);
      if (status === "completed") { if (item && job) { item.pendingTaskId = null; await this.saveJob(job); } return; }
      if (status === "failed") {
        if (item && job) { item.pendingTaskId = null; if (item.stage === "pending") item.stageRequested = false; await this.saveJob(job); }
        throw new Error("网盘文件任务执行失败");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("网盘文件任务等待超时，可稍后继续任务");
  }

  /** 读取一个目录的实时直接子项，所有目标覆盖判断均基于最新网盘状态。 */
  private async children(context: OrganizeContext, directory: OrganizeDirectory): Promise<ProviderBrowseEntry[]> {
    const listing = await context.adapter.browseEntries(context.connection, directory, undefined, context.providerContext);
    return listing.items;
  }

  /** 幂等创建目录；重启时优先采用已存在的同名目录。 */
  private async ensureDirectory(context: OrganizeContext, parent: OrganizeDirectory, name: string): Promise<OrganizeDirectory> {
    const existing = (await this.children(context, parent)).find((entry) => entry.name === name);
    if (existing) {
      if (!existing.isDirectory) throw new Error(`目标路径有同名文件：${name}`);
      return { resourceId: existing.resourceId, displayPath: existing.displayPath };
    }
    await this.waitMutation(context, await context.organizer.createDirectory(context.connection, parent.resourceId, name, context.providerContext));
    const created = (await this.children(context, parent)).find((entry) => entry.name === name && entry.isDirectory);
    if (!created) throw new Error(`网盘目录创建后未找到：${name}`);
    return { resourceId: created.resourceId, displayPath: created.displayPath };
  }

  /** 按计划目标逐级创建分类、作品和季目录。 */
  private async targetParent(context: OrganizeContext, plan: OrganizePlan, item: OrganizePlanItem): Promise<OrganizeDirectory> {
    if (item.action === "unrecognized" && !plan.unrecognizedDirectory) throw new Error("未识别转移目录缺失，请重新预览");
    let parent = item.action === "unrecognized" && plan.unrecognizedDirectory
      ? plan.unrecognizedDirectory : plan.targetDirectory;
    for (const name of item.targetParts) {
      const cacheKey = JSON.stringify([parent.resourceId, name]);
      const cached = context.targetDirectoryCache?.get(cacheKey);
      parent = cached ?? await this.ensureDirectory(context, parent, name);
      if (!cached) context.targetDirectoryCache?.set(cacheKey, parent);
    }
    return parent;
  }

  /** 支持批量写入的新任务直接到达目标；历史暂存任务继续从原阶段恢复。 */
  private canDirectTransfer(context: OrganizeContext, plan: OrganizePlan, state: OrganizeJobItem): boolean {
    const item = plan.items[state.index];
    if (!item || item.status !== "ready") return false;
    return Boolean(context.directEnabled && context.organizer.moveMany && context.organizer.copyMany
      && state.stage === "pending" && !state.stageRequested && !state.directOperation && !state.pendingTaskId);
  }

  /** 先发现计划内部同名目标，避免后一个条目覆盖前一个刚整理完成的文件。 */
  private hasEarlierDirectTarget(plan: OrganizePlan, job: OrganizeJob, state: OrganizeJobItem): boolean {
    const item = plan.items[state.index]!;
    return job.items.some((previous) => {
      if (previous.index >= state.index) return false;
      const other = plan.items[previous.index]!;
      return Boolean((other.action === "unrecognized") === (item.action === "unrecognized")
        && other.targetName === item.targetName
        && JSON.stringify(other.targetParts) === JSON.stringify(item.targetParts));
    });
  }

  /** 同来源和目标目录的文件先集中处理覆盖，再合并为一次移动或复制任务。 */
  private async startDirectBatch(context: OrganizeContext, plan: OrganizePlan, job: OrganizeJob,
    current: OrganizeJobItem): Promise<boolean> {
    if (!this.canDirectTransfer(context, plan, current)) return false;
    if (this.hasEarlierDirectTarget(plan, job, current)) return false;
    const first = plan.items[current.index]!;
    const operation = first.action === "unrecognized" ? "move" : plan.mode;
    const target = await this.targetParent(context, plan, first);
    if (first.parentId === target.resourceId) return false;
    // 关键变量：批次上限控制暂停等待时间；同一来源和目标的文件由一次网盘任务提交。
    const targetPartsKey = JSON.stringify(first.targetParts);
    const candidates = job.items.filter((state) => this.canDirectTransfer(context, plan, state)
      && plan.items[state.index]?.parentId === first.parentId
      && (plan.items[state.index]?.action === "unrecognized" ? "move" : plan.mode) === operation
      && JSON.stringify(plan.items[state.index]?.targetParts) === targetPartsKey).slice(0, 50);
    const sourceParent: OrganizeDirectory = { resourceId: first.parentId,
      displayPath: normalizedPath(path.posix.dirname(first.sourcePath)) };
    const sourceEntries = await this.children(context, sourceParent);
    const targetEntries = await this.children(context, target);
    const sourceById = new Map(sourceEntries.map((entry) => [entry.resourceId, entry]));
    const reservedNames = new Set<string>();
    const selected: OrganizeJobItem[] = [];
    for (const state of candidates) {
      const item = plan.items[state.index]!;
      const source = sourceById.get(item.sourceId);
      const existing = targetEntries.find((entry) => entry.name === item.targetName && entry.resourceId !== item.sourceId);
      const sourceNameCollision = targetEntries.find((entry) => entry.name === item.sourceName
        && entry.resourceId !== item.sourceId && entry.resourceId !== existing?.resourceId);
      if (!source || source.name !== item.sourceName || source.isDirectory !== Boolean(item.isDirectory)
        || (!item.isDirectory && (source.size !== item.size || source.modifiedAt !== item.modifiedAt))
        || (existing && (item.action === "unrecognized" || existing.isDirectory)) || sourceNameCollision
        || reservedNames.has(item.sourceName) || reservedNames.has(item.targetName)) continue;
      await this.requireUnchangedFolder(context, item);
      selected.push(state);
      state.replacedId = existing?.resourceId ?? null;
      reservedNames.add(item.sourceName);
      reservedNames.add(item.targetName);
    }
    if (!selected.includes(current)) return false;
    const batchId = randomUUID();
    const oldIds = selected.map((state) => state.replacedId).filter((id): id is string => Boolean(id));
    for (const state of selected) {
      state.directOperation = operation;
      state.directBatchId = batchId;
      state.directPhase = oldIds.length > 0 ? "delete" : "transfer";
      state.stageRequested = oldIds.length === 0;
      state.stagedId = operation === "move" ? state.sourceId : null;
      state.targetParentId = target.resourceId;
    }
    await this.saveJob(job);
    if (oldIds.length > 0) {
      const deletion = oldIds.length > 1
        ? await context.organizer.removeMany!(context.connection, oldIds, context.providerContext)
        : await context.organizer.remove(context.connection, oldIds[0]!, context.providerContext);
      if (deletion.taskId) {
        for (const state of selected) state.pendingTaskId = deletion.taskId;
        await this.saveJob(job);
        try { await this.waitMutation(context, { taskId: deletion.taskId }); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "网盘文件任务执行失败") throw error;
          for (const state of selected) {
            state.pendingTaskId = null;
            state.directDeleteFailed = true;
          }
          await this.saveJob(job);
          return true;
        }
        for (const state of selected) state.pendingTaskId = null;
        await this.saveJob(job);
      }
      context.directTargetListings?.delete(target.resourceId);
      const afterDeletion = await this.children(context, target);
      if (afterDeletion.some((entry) => oldIds.includes(entry.resourceId))) {
        throw new Error("批量覆盖删除尚未完成，请稍后继续任务");
      }
      for (const state of selected) { state.directPhase = "transfer"; state.stageRequested = true; }
      await this.saveJob(job);
    }
    const ids = selected.map((state) => state.sourceId);
    const result = operation === "move"
      ? ids.length > 1
        ? await context.organizer.moveMany!(context.connection, ids, target.resourceId, context.providerContext)
        : await context.organizer.move(context.connection, ids[0]!, target.resourceId, context.providerContext)
      : ids.length > 1
        ? await context.organizer.copyMany!(context.connection, ids, target.resourceId, context.providerContext)
        : await context.organizer.copy(context.connection, ids[0]!, target.resourceId, context.providerContext);
    context.directTargetListings?.delete(target.resourceId);
    if (result.resourceId && selected.length === 1) selected[0]!.stagedId = result.resourceId;
    if (result.taskId) {
      for (const state of selected) state.pendingTaskId = result.taskId;
      await this.saveJob(job);
    }
    return true;
  }

  /** 目标有同名内容时先按覆盖规则删除，再单项直达目标，不创建暂存目录。 */
  private async startDirectSingle(context: OrganizeContext, plan: OrganizePlan, job: OrganizeJob,
    state: OrganizeJobItem): Promise<void> {
    if (this.hasEarlierDirectTarget(plan, job, state)) throw new Error("计划中有多个条目生成同名目标，请重新预览");
    const item = plan.items[state.index]!;
    const operation = item.action === "unrecognized" ? "move" : plan.mode;
    const target = await this.targetParent(context, plan, item);
    const sourceParent: OrganizeDirectory = { resourceId: item.parentId,
      displayPath: normalizedPath(path.posix.dirname(item.sourcePath)) };
    const source = (await this.children(context, sourceParent)).find((entry) => entry.resourceId === item.sourceId);
    if (!source || source.name !== item.sourceName || source.isDirectory !== Boolean(item.isDirectory)
      || (!item.isDirectory && (source.size !== item.size || source.modifiedAt !== item.modifiedAt))) {
      throw new Error("来源文件已变化，请重新预览后创建任务");
    }
    await this.requireUnchangedFolder(context, item);
    const targetEntries = await this.children(context, target);
    context.directTargetListings?.delete(target.resourceId);
    const existing = targetEntries.find((entry) => entry.name === item.targetName && entry.resourceId !== item.sourceId);
    if (existing && item.action === "unrecognized") throw new Error("未识别目标已有同名内容，来源保持原位");
    if (existing?.isDirectory) throw new Error("目标名称被目录占用，不能覆盖");
    const sourceNameCollision = targetEntries.find((entry) => entry.name === item.sourceName
      && entry.resourceId !== item.sourceId && entry.resourceId !== existing?.resourceId);
    if (sourceNameCollision) throw new Error("目标目录已有与来源同名的其他内容，无法直接移动");
    state.directOperation = operation;
    state.directBatchId = randomUUID();
    state.targetParentId = target.resourceId;
    state.replacedId = existing?.resourceId ?? null;
    state.stagedId = operation === "move" ? item.sourceId : null;
    state.directPhase = existing ? "delete" : item.parentId === target.resourceId && operation === "move" ? "rename" : "transfer";
    if (state.directPhase === "rename") state.stage = "placed";
    await this.saveJob(job);
    if (existing) {
      const result = await context.organizer.remove(context.connection, existing.resourceId, context.providerContext);
      context.directTargetListings?.delete(target.resourceId);
      if (result.taskId) { state.pendingTaskId = result.taskId; await this.saveJob(job); }
    } else if (state.directPhase === "transfer") {
      await this.submitDirectTransfer(context, job, state, target.resourceId);
    }
  }

  /** 逐项重试和覆盖后的传输共用提交路径，先记提交意图再调用网盘接口。 */
  private async submitDirectTransfer(context: OrganizeContext, job: OrganizeJob,
    state: OrganizeJobItem, targetParentId: string): Promise<void> {
    state.directPhase = "transfer";
    state.stageRequested = true;
    await this.saveJob(job);
    const result = state.directOperation === "copy"
      ? await context.organizer.copy(context.connection, state.sourceId, targetParentId, context.providerContext)
      : await context.organizer.move(context.connection, state.sourceId, targetParentId, context.providerContext);
    context.directTargetListings?.delete(targetParentId);
    if (result.resourceId) state.stagedId = result.resourceId;
    if (result.taskId) state.pendingTaskId = result.taskId;
    await this.saveJob(job);
  }

  /** 确认删除、传输和改名三个远端阶段，任务失败时按实际文件位置决定下一步。 */
  private async finishDirectTransfer(context: OrganizeContext, plan: OrganizePlan, job: OrganizeJob,
    state: OrganizeJobItem): Promise<void> {
    const item = plan.items[state.index]!;
    const target: OrganizeDirectory = { resourceId: state.targetParentId!,
      displayPath: normalizedPath(path.posix.join(
        item.action === "unrecognized" && plan.unrecognizedDirectory
          ? plan.unrecognizedDirectory.displayPath : plan.targetDirectory.displayPath, ...item.targetParts)) };
    if (state.pendingTaskId) {
      const taskId = state.pendingTaskId;
      let failedPhase = false;
      try {
        await this.waitMutation(context, { taskId });
        for (const member of job.items) if (member.pendingTaskId === taskId) member.pendingTaskId = null;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "网盘文件任务执行失败") throw error;
        for (const member of job.items) if (member.pendingTaskId === taskId) {
          member.pendingTaskId = null;
          if (member.directPhase === "transfer") member.stageRequested = false;
          if (member.directPhase === "delete") member.directDeleteFailed = true;
        }
        failedPhase = state.directPhase !== "transfer";
      }
      context.directTargetListings?.delete(target.resourceId);
      await this.saveJob(job);
      if (failedPhase) throw new Error("网盘文件操作失败，请检查目标目录后继续任务");
    }
    if (state.directPhase === "delete") {
      const batchMembers = job.items.filter((member) => member.directBatchId === state.directBatchId
        && member.directPhase === "delete");
      const oldIds = new Set(batchMembers.map((member) => member.replacedId).filter((id): id is string => Boolean(id)));
      const remaining = (await this.children(context, target)).filter((entry) => oldIds.has(entry.resourceId));
      if (remaining.length && state.directDeleteFailed && (state.directRetryCount ?? 0) < 1) {
        for (const member of batchMembers) {
          member.directRetryCount = (member.directRetryCount ?? 0) + 1;
          member.directDeleteFailed = false;
        }
        await this.saveJob(job);
        const ids = remaining.map((entry) => entry.resourceId);
        const result = ids.length > 1
          ? await context.organizer.removeMany!(context.connection, ids, context.providerContext)
          : await context.organizer.remove(context.connection, ids[0]!, context.providerContext);
        if (result.taskId) {
          for (const member of batchMembers) member.pendingTaskId = result.taskId;
          await this.saveJob(job);
        }
        context.directTargetListings?.delete(target.resourceId);
        return this.finishDirectTransfer(context, plan, job, state);
      }
      if (remaining.length) throw new Error("旧目标删除尚未确认，请稍后继续任务");
      if (item.parentId === target.resourceId && state.directOperation === "move") {
        state.directPhase = "rename";
        state.stage = "placed";
        await this.saveJob(job);
      } else {
        await this.submitDirectTransfer(context, job, state, target.resourceId);
        return this.finishDirectTransfer(context, plan, job, state);
      }
    }
    let targetEntries = context.directTargetListings?.get(target.resourceId);
    if (!targetEntries) {
      targetEntries = await this.children(context, target);
      context.directTargetListings?.set(target.resourceId, targetEntries);
    }
    let placed = state.stagedId
      ? targetEntries.find((entry) => entry.resourceId === state.stagedId)
      : targetEntries.find((entry) => entry.name === item.sourceName && entry.isDirectory === Boolean(item.isDirectory)
        && (item.isDirectory || entry.size === item.size));
    // WebDAV 的资源 ID 就是路径；请求成功但响应丢失后，目标文件的 ID 已随 MOVE 改变。
    if (!placed && context.adapter.descriptor.type === "webdav") {
      placed = targetEntries.find((entry) => entry.name === item.sourceName
        && entry.isDirectory === Boolean(item.isDirectory) && (item.isDirectory || entry.size === item.size));
    }
    if (!placed && state.directOperation === "copy") {
      placed = targetEntries.find((entry) => entry.name === item.sourceName && entry.isDirectory === Boolean(item.isDirectory)
        && (item.isDirectory || entry.size === item.size));
    }
    if (!placed && ["quark", "cloud139"].includes(context.adapter.descriptor.type)) {
      // 写入成功与目录列表收敛存在时间差，重读目标目录后再判断是否需要人工重试。
      for (let attempt = 0; attempt < 12 && !placed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        targetEntries = await this.children(context, target);
        context.directTargetListings?.set(target.resourceId, targetEntries);
        placed = targetEntries.find((entry) => entry.resourceId === state.stagedId)
          ?? targetEntries.find((entry) => entry.name === item.sourceName
            && entry.isDirectory === Boolean(item.isDirectory) && (item.isDirectory || entry.size === item.size));
      }
    }
    if (state.directPhase === "transfer") {
      if (!placed) {
        const sourceParent: OrganizeDirectory = { resourceId: item.parentId,
          displayPath: normalizedPath(path.posix.dirname(item.sourcePath)) };
        const source = (await this.children(context, sourceParent)).find((entry) => entry.resourceId === item.sourceId);
        if (source && !state.stageRequested && (state.directRetryCount ?? 0) < 1) {
          state.directRetryCount = (state.directRetryCount ?? 0) + 1;
          await this.submitDirectTransfer(context, job, state, target.resourceId);
          return this.finishDirectTransfer(context, plan, job, state);
        }
        throw new Error(source ? "传输结果尚未确认，请稍后继续任务" : "传输后来源和目标均未找到文件");
      }
      state.stagedId = placed.resourceId;
      state.stage = "placed";
      state.directPhase = "rename";
      await this.saveJob(job);
    }
    placed = targetEntries.find((entry) => entry.resourceId === state.stagedId);
    if (!placed) throw new Error("目标目录找不到已传输的文件");
    if (placed.name !== item.targetName) {
      const placedId = placed.resourceId;
      const collision = targetEntries.find((entry) => entry.name === item.targetName
        && entry.resourceId !== placedId);
      if (collision) {
        if (item.action === "unrecognized" || collision.isDirectory) throw new Error("改名前目标出现同名内容，已保留来源文件");
        await this.waitMutation(context, await context.organizer.remove(context.connection,
          collision.resourceId, context.providerContext), job, state);
        context.directTargetListings?.delete(target.resourceId);
      }
      const result = await context.organizer.rename(context.connection, placed.resourceId, item.targetName, context.providerContext);
      await this.waitMutation(context, result, job, state);
      if (result.resourceId) state.stagedId = result.resourceId;
      context.directTargetListings?.delete(target.resourceId);
      targetEntries = await this.children(context, target);
      context.directTargetListings?.set(target.resourceId, targetEntries);
      placed = targetEntries.find((entry) => entry.resourceId === state.stagedId);
    }
    if (!placed || placed.name !== item.targetName) throw new Error("目标文件命名验证失败");
    state.stage = "completed";
    state.error = null;
    await this.saveJob(job);
  }

  /** 已提交的整批文件完成改名后才响应暂停或取消，避免留下未命名的半批文件。 */
  private async finishDirectBatch(context: OrganizeContext, plan: OrganizePlan, job: OrganizeJob,
    batchId: string): Promise<boolean> {
    for (const state of job.items.filter((item) => item.directBatchId === batchId && item.stage !== "completed")) {
      try { await this.finishDirectTransfer(context, plan, job, state); }
      catch (error) {
        state.stage = "failed";
        state.error = error instanceof Error ? error.message : "批量移动失败";
        job.error = `${plan.items[state.index]?.sourceName ?? "文件"}：${state.error}`;
        await this.failJob(job, error);
        return false;
      }
    }
    return true;
  }

  /** 整夹转移前再次枚举子树；预览后任何子项增减都会阻止搬迁。 */
  private async requireUnchangedFolder(context: OrganizeContext, item: OrganizePlanItem): Promise<void> {
    if (!item.isDirectory) return;
    const queue: OrganizeDirectory[] = [{ resourceId: item.sourceId, displayPath: item.sourcePath }];
    const currentEntries: string[] = [];
    while (queue.length) {
      const directory = queue.shift()!;
      const children = await this.children(context, directory);
      for (const child of children) {
        currentEntries.push(JSON.stringify([child.resourceId, child.name, child.isDirectory, child.size, child.modifiedAt]));
        if (child.isDirectory) queue.push({ resourceId: child.resourceId, displayPath: child.displayPath });
      }
      if (currentEntries.length > MAX_ENTRIES) throw new Error("未识别文件夹内容超过预览上限，请重新预览");
    }
    if (JSON.stringify(currentEntries.sort()) !== JSON.stringify(item.containedEntries ?? [])) {
      throw new Error("未识别文件夹内容已变化，请重新预览后整理");
    }
  }

  /** 处理文件或未识别文件夹：先暂存来源，再按计划放置和验证；普通文件继续支持旧目标备份。 */
  private async processItem(context: OrganizeContext, plan: OrganizePlan, job: OrganizeJob, state: OrganizeJobItem,
    stageRoot: OrganizeDirectory, backupRoot: OrganizeDirectory): Promise<void> {
    const item = plan.items[state.index]!;
    const stageDir = await this.ensureDirectory(context, stageRoot, `item-${state.index}`);
    const backupDir = await this.ensureDirectory(context, backupRoot, `item-${state.index}`);
    state.stageParentId = stageDir.resourceId;
    state.backupParentId = backupDir.resourceId;
    const target = await this.targetParent(context, plan, item);
    state.targetParentId = target.resourceId;
    await this.saveJob(job);

    if (item.action === "unrecognized" && !state.stageRequested && state.stage === "pending"
      && (await this.children(context, target)).some((entry) => entry.name === item.targetName)) {
      throw new Error("未识别目标已有同名内容，来源保持原位，请重新预览");
    }

    if (state.pendingTaskId) await this.waitMutation(context, { taskId: state.pendingTaskId }, job, state);
    let stageEntries = (await this.children(context, stageDir)).filter((entry) => entry.isDirectory === Boolean(item.isDirectory));
    if (stageEntries.length > 1) throw new Error("暂存目录出现多个文件，已停止以避免重复复制");
    let staged = stageEntries.find((entry) => entry.resourceId === state.stagedId || entry.name === item.sourceName) ?? stageEntries[0];
    let placed = (await this.children(context, target)).find((entry) => entry.resourceId === state.stagedId && state.stagedId !== null);
    if (!staged && !placed) {
      if (state.stageRequested) throw new Error("暂存请求尚未在网盘目录确认，已停止以避免重复复制；请稍后继续");
      const sourceParent: OrganizeDirectory = { resourceId: item.parentId, displayPath: normalizedPath(path.posix.dirname(item.sourcePath)) };
      const source = (await this.children(context, sourceParent)).find((entry) => entry.resourceId === item.sourceId);
      if (!source || source.name !== item.sourceName || source.isDirectory !== Boolean(item.isDirectory)
        || (!item.isDirectory && (source.size !== item.size || source.modifiedAt !== item.modifiedAt))) {
        throw new Error("来源文件已变化，请重新预览后创建任务");
      }
      await this.requireUnchangedFolder(context, item);
      state.stageRequested = true;
      await this.saveJob(job);
      const result = plan.mode === "move" || item.action === "unrecognized"
        ? await context.organizer.move(context.connection, source.resourceId, stageDir.resourceId, context.providerContext)
        : await context.organizer.copy(context.connection, source.resourceId, stageDir.resourceId, context.providerContext);
      await this.waitMutation(context, result, job, state);
      stageEntries = (await this.children(context, stageDir)).filter((entry) => entry.isDirectory === Boolean(item.isDirectory));
      if (stageEntries.length > 1) throw new Error("暂存目录出现多个文件，已停止以避免重复复制");
      staged = stageEntries.find((entry) => entry.resourceId === result.resourceId || entry.name === item.sourceName) ?? stageEntries[0];
      if (!staged) throw new Error("暂存文件尚未出现，请稍后继续任务");
    }
    if (staged) { state.stagedId = staged.resourceId; state.stage = "staged"; await this.saveJob(job); }
    if (!state.stagedId) throw new Error("暂存文件定位失败");

    const backupEntries = await this.children(context, backupDir);
    const backedUpFiles = backupEntries.filter((entry) => !entry.isDirectory);
    if (backedUpFiles.length > 1) throw new Error("备份目录出现多个文件，已停止覆盖");
    const backedUp = backedUpFiles[0];
    if (backedUp) state.replacedId = backedUp.resourceId;
    const currentTarget = await this.children(context, target);
    const old = currentTarget.find((entry) => entry.name === item.targetName && entry.resourceId !== state.stagedId);
    if (old && item.action === "unrecognized") throw new Error("未识别目标已有同名内容，已保留暂存内容，避免覆盖");
    if (old?.isDirectory) throw new Error("目标名称被目录占用，不能覆盖");
    if (old && !backedUp) {
      const result = await context.organizer.move(context.connection, old.resourceId, backupDir.resourceId, context.providerContext);
      await this.waitMutation(context, result, job, state);
      const movedOld = (await this.children(context, backupDir)).find((entry) => entry.resourceId === (result.resourceId ?? old.resourceId));
      if (!movedOld) throw new Error("旧目标备份未确认，已停止覆盖");
      state.replacedId = movedOld.resourceId;
    } else if (old && backedUp) throw new Error("目标又出现同名文件，已停止覆盖");
    state.stage = "backed_up";
    await this.saveJob(job);

    placed = (await this.children(context, target)).find((entry) => entry.resourceId === state.stagedId);
    if (!placed) {
      const result = await context.organizer.move(context.connection, state.stagedId, target.resourceId, context.providerContext);
      await this.waitMutation(context, result, job, state);
      if (result.resourceId) state.stagedId = result.resourceId;
      placed = (await this.children(context, target)).find((entry) => entry.resourceId === state.stagedId);
      if (!placed) throw new Error("新文件放置后未找到，已保留旧文件备份");
    }
    state.stage = "placed";
    await this.saveJob(job);
    if (placed.name !== item.targetName) {
      const collision = (await this.children(context, target)).find((entry) => entry.name === item.targetName && entry.resourceId !== state.stagedId);
      if (collision) throw new Error("重命名前目标再次发生同名冲突，已保留旧文件备份");
      const result = await context.organizer.rename(context.connection, state.stagedId, item.targetName, context.providerContext);
      await this.waitMutation(context, result, job, state);
      if (result.resourceId) state.stagedId = result.resourceId;
    }
    const verified = (await this.children(context, target)).find((entry) => entry.resourceId === state.stagedId && entry.name === item.targetName);
    if (!verified) throw new Error("新文件命名验证失败，已保留旧文件备份");
    state.stage = "renamed";
    await this.saveJob(job);
    if (state.replacedId) {
      const oldBackup = (await this.children(context, backupDir)).find((entry) => entry.resourceId === state.replacedId);
      if (oldBackup) await this.waitMutation(context, await context.organizer.remove(context.connection, oldBackup.resourceId, context.providerContext), job, state);
    }
    state.stage = "completed";
    await this.saveJob(job);
    await this.removeIfEmpty(context, stageDir);
    await this.removeIfEmpty(context, backupDir);
  }

  /** 仅删除网盘实时确认完全为空的目录。 */
  private async removeIfEmpty(context: OrganizeContext, directory: OrganizeDirectory): Promise<void> {
    if ((await this.children(context, directory)).length > 0) return;
    await this.waitMutation(context, await context.organizer.remove(context.connection, directory.resourceId, context.providerContext));
  }

  /** 实时检查目录树，任何视频或新增的子目录读取错误都会阻止整棵目录清理。 */
  private async containsSourceVideo(context: OrganizeContext, directory: OrganizeDirectory): Promise<boolean> {
    const queue = [directory];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current.resourceId)) continue;
      seen.add(current.resourceId);
      if (seen.size > MAX_DIRECTORIES) throw new Error("来源目录层级超过清理上限，已保留原目录");
      for (const entry of await this.children(context, current)) {
        if (entry.isDirectory) queue.push({ resourceId: entry.resourceId, displayPath: entry.displayPath });
        else if (VIDEO_EXTENSION.test(entry.name) || /\.strm$/iu.test(entry.name)) return true;
      }
    }
    return false;
  }

  /** 仅在整棵目录已确认没有视频后，逐项删除附属文件和子目录，最后删除空目录。 */
  private async removeVideoFreeSourceTree(context: OrganizeContext, directory: OrganizeDirectory): Promise<void> {
    const entries = await this.children(context, directory);
    if (entries.some((entry) => !entry.isDirectory && (VIDEO_EXTENSION.test(entry.name) || /\.strm$/iu.test(entry.name)))) {
      throw new Error("来源目录出现新视频，已停止清理并保留原目录");
    }
    for (const entry of entries) {
      if (entry.isDirectory) await this.removeVideoFreeSourceTree(context,
        { resourceId: entry.resourceId, displayPath: entry.displayPath });
    }
    // 关键变量：只删除再次确认仍在当前目录的非视频文件，避免清理过程中误删新加入的视频。
    const remainingFiles = (await this.children(context, directory)).filter((entry) => !entry.isDirectory);
    if (remainingFiles.some((entry) => VIDEO_EXTENSION.test(entry.name) || /\.strm$/iu.test(entry.name))) {
      throw new Error("来源目录出现新视频，已停止清理并保留原目录");
    }
    for (let offset = 0; offset < remainingFiles.length; offset += 50) {
      const batch = remainingFiles.slice(offset, offset + 50);
      if (batch.length > 1 && context.organizer.removeMany) {
        await this.waitMutation(context, await context.organizer.removeMany(context.connection,
          batch.map((entry) => entry.resourceId), context.providerContext));
      } else {
        for (const entry of batch) await this.waitMutation(context,
          await context.organizer.remove(context.connection, entry.resourceId, context.providerContext));
      }
    }
    await this.removeIfEmpty(context, directory);
  }

  /** 按层级逆序清理来源子目录；只清理本次涉及视频且整棵树已无视频的目录。 */
  private async cleanupSources(context: OrganizeContext, plan: OrganizePlan): Promise<void> {
    const scannedByPath = new Map(plan.scannedDirectories.map((directory) => [directory.displayPath, directory]));
    // 关键变量：已整夹转移的目录及子目录属于新目标，不能再按旧来源路径清理。
    const movedFolders = plan.items.filter((item) => item.status === "ready" && item.action === "unrecognized" && item.isDirectory)
      .map((item) => item.sourcePath);
    const sourceRoots = new Set(plan.sourceDirectories.map((directory) => directory.resourceId));
    for (const directory of [...plan.scannedDirectories].sort((left, right) => right.displayPath.length - left.displayPath.length)) {
      if (directory.displayPath === "/") continue;
      // 关键变量：定时任务下一轮还要读取来源根目录，只清理根目录之下的空目录。
      if (sourceRoots.has(directory.resourceId)) continue;
      if (movedFolders.some((folder) => directory.displayPath === folder
        || directory.displayPath.startsWith(`${folder}/`))) continue;
      const parentPath = normalizedPath(path.posix.dirname(directory.displayPath));
      const parent = scannedByPath.get(parentPath) ?? await this.findDirectory(context, parentPath);
      if (!parent) continue;
      const current = (await this.children(context, parent)).find((entry) => entry.isDirectory && entry.resourceId === directory.resourceId);
      if (!current) continue;
      const involved = plan.items.some((item) => item.sourcePath === directory.displayPath
        || item.sourcePath.startsWith(`${directory.displayPath.replace(/\/$/u, "")}/`));
      if (!involved) { await this.removeIfEmpty(context, directory); continue; }
      if (await this.containsSourceVideo(context, directory)) continue;
      await this.removeVideoFreeSourceTree(context, directory);
    }
  }

  /** 完成任务前再次清理空的逐文件暂存目录；任何遗留文件都会阻止“已完成”状态。 */
  private async cleanupWork(context: OrganizeContext, work: OrganizeDirectory,
    stageRoot: OrganizeDirectory, backupRoot: OrganizeDirectory): Promise<void> {
    for (const root of [stageRoot, backupRoot]) {
      for (const child of await this.children(context, root)) {
        if (child.isDirectory) await this.removeIfEmpty(context, { resourceId: child.resourceId, displayPath: child.displayPath });
      }
      if ((await this.children(context, root)).length > 0) throw new Error("任务工作目录仍有未处理文件，已保留现场");
      await this.removeIfEmpty(context, root);
    }
    if ((await this.children(context, work)).length > 0) throw new Error("任务工作目录仍有未处理文件，已保留现场");
    await this.removeIfEmpty(context, work);
  }

  /** 按最终完成的作品和视频文件发送一次整理汇总，不把未识别转移计入已整理影片。 */
  private async notifyCompletedJob(job: OrganizeJob, plan: OrganizePlan): Promise<void> {
    const completedItems = job.items.filter((item) => item.stage === "completed")
      .map((item) => plan.items[item.index])
      .filter((item): item is OrganizePlanItem => Boolean(item && item.action !== "unrecognized" && item.tmdbId !== null));
    if (completedItems.length === 0) return;
    // 关键变量：同一剧集的多集视频只算一部影片，文件数仍逐个统计。
    const workCount = new Set(completedItems.map((item) => `${item.category === "电影" ? "movie" : "tv"}:${item.tmdbId}`)).size;
    const service = await this.runtime.repository.getServiceDetail(job.serviceId, job.userId).catch(() => null);
    await this.runtime.database.createNotificationSafely({
      userId: job.userId, notificationEvent: "organize_completed", category: "task", tone: "success",
      title: "影片整理已完成",
      message: `服务“${service?.displayName ?? "网盘服务"}”的影片整理已完成：整理 ${workCount} 部影片、${completedItems.length} 个文件。`,
      actionPath: `/app/services/${job.serviceId}/organize`,
    });
  }

  /** 执行当前任务，失败时保留现场和阶段，允许之后继续。 */
  private async runJob(jobId: string): Promise<void> {
    let job = await readJson<OrganizeJob>(this.jobPath(jobId));
    if (!job || !["queued", "running"].includes(job.status)) return;
    try {
      const context = await this.context(job.serviceId, job.userId);
      context.targetDirectoryCache = new Map();
      context.directTargetListings = new Map();
      const plan = await this.getPlan(job.serviceId, job.planId, job.userId);
      // 关键变量：同目录复制可能由网盘自动改名，继续使用暂存流程才能按计划确定目标文件。
      const hasSameDirectoryCopy = plan.mode === "copy" && plan.items.some((item) => item.status === "ready"
        && item.action !== "unrecognized"
        && normalizedPath(path.posix.dirname(item.sourcePath)) === normalizedPath(path.posix.join(plan.targetDirectory.displayPath, ...item.targetParts)));
      context.directEnabled = ["guangya", "cloud115", "cloud123", "baidupan", "webdav", "cloud139", "quark"].includes(context.adapter.descriptor.type)
        && !job.workDirectoryId && !hasSameDirectoryCopy;
      await this.requireDirectory(context, plan.targetDirectory);
      if (plan.unrecognizedTransferEnabled && plan.unrecognizedDirectory) await this.requireDirectory(context, plan.unrecognizedDirectory);
      if (context.credentialRevision !== job.credentialRevision) throw new Error("服务凭据已变化，请取消旧任务并重新预览");
      job.status = "running";
      await this.saveJob(job);
      let work: OrganizeDirectory | null = null;
      let stageRoot: OrganizeDirectory | null = null;
      let backupRoot: OrganizeDirectory | null = null;
      /** 只有覆盖、复制或回退到原流程时才建立工作目录；旧任务恢复时复用已有目录。 */
      const ensureWork = async (): Promise<{ work: OrganizeDirectory; stageRoot: OrganizeDirectory; backupRoot: OrganizeDirectory }> => {
        if (!job) throw new Error("整理任务已不存在");
        if (!work || !stageRoot || !backupRoot) {
          work = await this.ensureDirectory(context, plan.targetDirectory, `.__flycloud_organize_${job.id}`);
          stageRoot = await this.ensureDirectory(context, work, "stage");
          backupRoot = await this.ensureDirectory(context, work, "backup");
          job.workDirectoryId = work.resourceId;
          job.stageDirectoryId = stageRoot.resourceId;
          job.backupDirectoryId = backupRoot.resourceId;
          await this.saveJob(job);
        }
        return { work: work!, stageRoot: stageRoot!, backupRoot: backupRoot! };
      };
      if (job.workDirectoryId) await ensureWork();
      for (const state of job.items) {
        const latest = await readJson<OrganizeJob>(this.jobPath(jobId));
        if (!latest || latest.status !== "running") return;
        job = latest;
        const current = job.items.find((item) => item.index === state.index)!;
        if (current.stage === "completed") continue;
        await this.requireNoActiveScan(job.serviceId);
        try {
          if (context.directEnabled) {
            if (!current.directOperation && !(await this.startDirectBatch(context, plan, job, current))) {
              await this.startDirectSingle(context, plan, job, current);
            }
            if (!current.directBatchId) throw new Error("批量移动状态缺少批次标识，请重新检查任务");
            if (!await this.finishDirectBatch(context, plan, job, current.directBatchId)) return;
            continue;
          }
          context.directTargetListings.clear();
          const working = await ensureWork();
          await this.processItem(context, plan, job, current, working.stageRoot, working.backupRoot);
        }
        catch (error) {
          current.stage = "failed";
          current.error = error instanceof Error ? error.message : "文件整理失败";
          job.error = `${plan.items[current.index]?.sourceName ?? "文件"}：${current.error}`;
          await this.failJob(job, error);
          return;
        }
      }
      const beforeCleanup = await readJson<OrganizeJob>(this.jobPath(jobId));
      if (!beforeCleanup || beforeCleanup.status !== "running") return;
      job = beforeCleanup;
      if (plan.mode === "move" || plan.items.some((item) => item.status === "ready" && item.action === "unrecognized")) {
        await this.cleanupSources(context, plan);
      }
      if (job.workDirectoryId) {
        const working = await ensureWork();
        await this.cleanupWork(context, working.work, working.stageRoot, working.backupRoot);
      }
      job.status = "completed";
      await this.saveJob(job);
      await this.notifyCompletedJob(job, plan);
    } catch (error) {
      const latest = await readJson<OrganizeJob>(this.jobPath(jobId));
      if (latest && ["queued", "running"].includes(latest.status)) {
        latest.error = error instanceof Error ? error.message : "影片整理失败";
        await this.failJob(latest, error);
      }
    }
  }

  /** 限制文件名参数为 UUID，防止将请求 ID 拼成任意本机路径。 */
  private planPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new ApiError(404, "organize_plan_missing", "整理预览不存在");
    return path.join(this.directory, `plan-${id}.json`);
  }

  /** 任务流水独立于媒体库和扫描任务数据库。 */
  private jobPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new ApiError(404, "organize_job_missing", "整理任务不存在");
    return path.join(this.directory, `job-${id}.json`);
  }
}
