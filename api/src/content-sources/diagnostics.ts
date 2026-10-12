import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { parseJsonObject } from "../domain.js";
import { ApiError } from "../errors.js";
import { probeContentLine, summarizeContentError } from "./diagnostic-probe.js";
import type { ContentSourceManager } from "./manager.js";
import type { ContentSourcePlaybackProtocol } from "./types.js";

interface CatalogDiagnostic {
  status: "unknown" | "ok" | "failed";
  categoryCount: number | null;
  elapsedMs: number | null;
  error: string | null;
}

interface LineDiagnostic {
  sourceId: string;
  itemId: string;
  title: string;
  lineName: string;
  episodeName: string;
  container: "hls" | "mp4" | "unknown";
  status: "ok" | "failed";
  elapsedMs: number;
  runTimeTicks: number;
  error: string | null;
}

/** 最近失败只保存可展示的条目定位和摘要，不能保存临时播放地址。 */
interface PlaybackFailure {
  at: string;
  protocol: ContentSourcePlaybackProtocol;
  stage: "resolve" | "relay";
  message: string;
  upstreamStatus: number | null;
}

/** 已鉴权播放路径提供的失败范围，原始错误只用于生成固定摘要。 */
interface PlaybackFailureInput {
  libraryId: string;
  ownerUserId: string;
  itemId: string;
  sourceId: string;
  protocol: ContentSourcePlaybackProtocol;
  stage: "resolve" | "relay";
  error: unknown;
}

/** 控制台读取持久化诊断，普通读取不向源站发起请求。 */
export interface ContentSourceDiagnosticsResult {
  checkedAt: string | null;
  catalog: CatalogDiagnostic;
  lines: LineDiagnostic[];
  lastPlaybackFailure: PlaybackFailure | null;
}

/** 返回没有检测记录的初始状态，启用配置不能代替源站健康检测。 */
function emptyDiagnostics(): ContentSourceDiagnosticsResult {
  return { checkedAt: null, catalog: { status: "unknown", categoryCount: null, elapsedMs: null, error: null }, lines: [], lastPlaybackFailure: null };
}

/** 读取程序自身写入的 JSON 记录，兼容没有检测历史的旧库。 */
function readDiagnosticRow(row: Record<string, unknown> | undefined): ContentSourceDiagnosticsResult {
  if (!row) return emptyDiagnostics();
  const catalog = parseJsonObject(row.catalog_json) as unknown as CatalogDiagnostic;
  let lines: LineDiagnostic[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.lines_json ?? "[]"));
    if (Array.isArray(parsed)) lines = parsed.slice(0, 3) as LineDiagnostic[];
  } catch { /* 未完成的旧记录使用空样本，不影响播放。 */ }
  const failure = row.last_failure_json ? parseJsonObject(row.last_failure_json) as unknown as PlaybackFailure : null;
  return { checkedAt: row.checked_at ? String(row.checked_at) : null, catalog: catalog.status ? catalog : emptyDiagnostics().catalog, lines, lastPlaybackFailure: failure };
}

/** 按用户和在线库隔离源站检查、少量线路抽查及最近播放失败。 */
export class ContentSourceDiagnostics {
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<ContentSourceDiagnosticsResult> }>();
  // 关键变量：播放失败写入也参与关闭收尾，不能在数据库关闭后继续保存摘要。
  private readonly failureWrites = new Set<Promise<void>>();
  private closing = false;

  /** 复用内容源目录与网络选项，不创建另一套播放账号。 */
  public constructor(private readonly options: {
    database: FlyCloudHelperDatabase;
    config: ApiConfig;
    contentSources: ContentSourceManager;
    logBusinessEvent: (level: "info" | "warn", fields: Record<string, string | number | boolean | null>) => void;
  }) {}

  /** 独立持久化诊断记录，表删除随媒体库级联，不写观看进度和同步游标。 */
  public async initialize(): Promise<void> {
    const database = this.options.database;
    if (await database.query.schema.hasTable("content_source_diagnostics")) return;
    await database.query.schema.createTable("content_source_diagnostics", (table) => {
      table.string("library_id", 64).primary().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("checked_at", 40).nullable();
      table.text("catalog_json").notNullable();
      table.text("lines_json").notNullable();
      table.text("last_failure_json").nullable();
      table.string("updated_at", 40).notNullable();
    });
  }

  /** 校验所有者后读取检测历史，即使配置停用也可以查看旧失败记录。 */
  public async get(libraryId: string, ownerUserId: string): Promise<ContentSourceDiagnosticsResult> {
    await this.options.contentSources.getLibrary(libraryId, ownerUserId);
    const row = await this.options.database.query("content_source_diagnostics").where({ library_id: libraryId, user_id: ownerUserId }).first();
    return readDiagnosticRow(row);
  }

  /** 主动检测分类接口，可选抽查最多三个已入库线路；相同库的并发检查只执行一次。 */
  public async check(libraryId: string, ownerUserId: string, checkPlayback: boolean): Promise<ContentSourceDiagnosticsResult> {
    if (this.closing) throw new ApiError(503, "content_diagnostics_stopping", "诊断服务正在停止");
    await this.options.contentSources.getLibrary(libraryId, ownerUserId);
    // 权限读取期间可能已经开始关闭，不能在关闭任务快照之后加入新的诊断。
    if (this.closing) throw new ApiError(503, "content_diagnostics_stopping", "诊断服务正在停止");
    if (this.running.has(libraryId)) throw new ApiError(409, "content_diagnostics_running", "此媒体库正在检测，请稍后刷新结果");
    const controller = new AbortController();
    const promise = this.runCheck(libraryId, ownerUserId, checkPlayback, controller.signal);
    this.running.set(libraryId, { controller, promise });
    try { return await promise; }
    finally { this.running.delete(libraryId); }
  }

  /** 关闭时取消已有源请求，并等待诊断写入结束后才关闭数据库。 */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const task of this.running.values()) task.controller.abort();
    await Promise.allSettled([
      ...[...this.running.values()].map((task) => task.promise),
      ...this.failureWrites,
    ]);
  }

  /** 在播放失败路径尽力记录摘要；数据库写入失败不能覆盖原播放错误。 */
  public async recordPlaybackFailure(input: PlaybackFailureInput): Promise<void> {
    if (this.closing) return;
    const write = this.writePlaybackFailure(input);
    this.failureWrites.add(write);
    try { await write; }
    finally { this.failureWrites.delete(write); }
  }

  /** 仅保存固定失败摘要，独立合并字段以免覆盖并发完成的主动检测结果。 */
  private async writePlaybackFailure(input: PlaybackFailureInput): Promise<void> {
    const summary = summarizeContentError(input.error);
    const failure: PlaybackFailure = { at: new Date().toISOString(), protocol: input.protocol, stage: input.stage, ...summary };
    try {
      // 关键变量：播放失败只合并最近失败字段，不覆盖另一个请求刚保存的分类/线路检测。
      await this.options.database.query("content_source_diagnostics").insert({
        library_id: input.libraryId, user_id: input.ownerUserId, checked_at: null,
        catalog_json: JSON.stringify(emptyDiagnostics().catalog), lines_json: "[]",
        last_failure_json: JSON.stringify(failure), updated_at: failure.at,
      }).onConflict("library_id").merge(["last_failure_json", "updated_at"]);
      this.options.logBusinessEvent("warn", {
        日志关键字: "codex-content-source-diagnostics", 事件: "记录内容源播放失败",
        媒体库ID: input.libraryId, 媒体条目ID: input.itemId, 播放来源ID: input.sourceId,
        协议: input.protocol, 阶段: input.stage, 原因: summary.message, 上游HTTP状态码: summary.upstreamStatus,
      });
    } catch {
      this.options.logBusinessEvent("warn", { 日志关键字: "codex-content-source-diagnostics", 事件: "播放失败摘要未能保存", 媒体库ID: input.libraryId });
    }
  }

  /** 分类检测与线路抽查分别记结果，分类失败不把源的所有影片标成失效。 */
  private async runCheck(libraryId: string, ownerUserId: string, checkPlayback: boolean, parentSignal: AbortSignal): Promise<ContentSourceDiagnosticsResult> {
    const result = emptyDiagnostics();
    const started = Date.now();
    try {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, 20_000);
      parentSignal.addEventListener("abort", abort, { once: true });
      if (parentSignal.aborted) abort();
      try {
        // 关键变量：只读当前绑定清单，不调用会保存分类快照的管理接口。
        const binding = await this.options.database.query("content_source_libraries as b")
          .join("content_source_instances as i", "i.id", "b.instance_id")
          .join("media_libraries as l", "l.id", "b.library_id")
          .join("library_sources as ls", "ls.id", "b.library_source_id")
          .join("content_source_plugins as p", function pinnedPlugin() { this.on("p.plugin_id", "=", "i.plugin_id").andOn("p.version", "=", "i.plugin_version"); })
          .select("b.instance_id", "p.manifest_json", "p.status as plugin_status", "i.status as source_status", "l.status as library_status", "ls.status as binding_status")
          .where({ "b.library_id": libraryId, "b.user_id": ownerUserId, "l.user_id": ownerUserId, "i.user_id": ownerUserId, "ls.user_id": ownerUserId }).first();
        if (!binding) throw new ApiError(404, "content_library_not_found", "内容源媒体库不存在");
        if (binding.plugin_status !== "enabled" || binding.source_status !== "active" || binding.library_status !== "active" || binding.binding_status !== "active") throw new ApiError(409, "content_source_disabled", "内容源已停用");
        const source = await this.options.contentSources.adapterForInstance(String(binding.instance_id), ownerUserId);
        const adapter = source.adapter;
        const categories = await adapter.categories(controller.signal);
        result.catalog = { status: "ok", categoryCount: categories.length, elapsedMs: Date.now() - started, error: null };
      } finally {
        clearTimeout(timeout);
        parentSignal.removeEventListener("abort", abort);
      }
    } catch (error) {
      result.catalog = { status: "failed", categoryCount: null, elapsedMs: Date.now() - started, error: summarizeContentError(error).message };
    }
    if (checkPlayback && !parentSignal.aborted) {
      const rows = await this.options.database.query("content_playback_sources as p")
        .join("media_items as m", "m.id", "p.item_id")
        .select("p.id", "p.item_id", "p.line_key", "p.line_name", "p.name", "p.container", "m.title")
        .where({ "p.library_id": libraryId, "p.user_id": ownerUserId, "p.status": "active" })
        .whereNull("m.deleted_at").orderBy("m.updated_at", "desc").orderBy("p.sort_order", "asc").limit(500);
      const seenLines = new Set<string>();
      const samples = rows.filter((row) => {
        if (seenLines.has(String(row.line_key)) || seenLines.size >= 3) return false;
        seenLines.add(String(row.line_key));
        return true;
      });
      // 不同样本并行使用各自 20 秒预算，整次线路抽查不会按样本数累加等待。
      result.lines = await Promise.all(samples.map((row) => this.checkLine(libraryId, ownerUserId, row, parentSignal)));
    }
    if (this.closing || parentSignal.aborted) throw new ApiError(503, "content_diagnostics_cancelled", "诊断已取消");
    result.checkedAt = new Date().toISOString();
    await this.options.database.query("content_source_diagnostics").insert({
      library_id: libraryId, user_id: ownerUserId, checked_at: result.checkedAt,
      catalog_json: JSON.stringify(result.catalog), lines_json: JSON.stringify(result.lines),
      last_failure_json: null, updated_at: result.checkedAt,
    }).onConflict("library_id").merge(["checked_at", "catalog_json", "lines_json", "updated_at"]);
    this.options.logBusinessEvent("info", {
      日志关键字: "codex-content-source-diagnostics", 事件: "完成内容源检测", 媒体库ID: libraryId,
      目录状态: result.catalog.status, 线路样本数量: result.lines.length, 失败线路数量: result.lines.filter((line) => line.status === "failed").length,
    });
    return this.get(libraryId, ownerUserId);
  }

  /** 一个样本即时取址、检查清单和少量分片，不更新该影片的时长或观看记录。 */
  private async checkLine(libraryId: string, ownerUserId: string, row: Record<string, unknown>, parentSignal: AbortSignal): Promise<LineDiagnostic> {
    const started = Date.now();
    const result: LineDiagnostic = {
      sourceId: String(row.id), itemId: String(row.item_id), title: String(row.title),
      lineName: String(row.line_name), episodeName: String(row.name), container: row.container === "hls" ? "hls" : row.container === "mp4" ? "mp4" : "unknown",
      status: "failed", elapsedMs: 0, runTimeTicks: 0, error: null,
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 20_000);
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) abort();
    try {
      const access = await this.options.contentSources.resolvePlayback(result.sourceId, ownerUserId, libraryId, controller.signal);
      result.runTimeTicks = await probeContentLine({ ...access, allowInsecureHttp: this.options.config.allowInsecureProviderHttp, signal: controller.signal });
      result.status = "ok";
    } catch (error) {
      result.error = summarizeContentError(error).message;
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
      result.elapsedMs = Date.now() - started;
    }
    return result;
  }
}
