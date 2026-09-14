import { ApiError } from "../errors.js";
import fs from "node:fs/promises";
import { acquireMusicBudget, withMusicRequestBudget } from "../providers/request-budget.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import type { ScanJobRecord, SourceFileRecord } from "../domain.js";
import { createStableId, describeMediaFile, getFileExtension, type MediaDescriptor } from "../media/filename.js";
import type { ProviderAdapter, ProviderConnectionContext, ProviderEntry, ScanRoot } from "../providers/types.js";
import type { ServiceRepository } from "../service-repository.js";
import type { EnrichedMetadata } from "../worker.js";
import { applyAudioTagsToDescriptor, createAudioTagFingerprint } from "./audio-tag-reader.js";
import { applyMusicSidecars, readBoundedAudioTags } from "./file-reader.js";
import { MusicScanState, type MusicStageTask } from "./scan-state.js";

interface FileWork { entry: ProviderEntry; source: SourceFileRecord }
interface OnlineWork extends FileWork { descriptor: MediaDescriptor; fingerprint: string; fileError: string }
interface MusicScanInput {
  job: ScanJobRecord; database: FlyCloudHelperDatabase; repository: ServiceRepository; config: ApiConfig;
  adapter: ProviderAdapter; connection: Record<string, unknown>; context: ProviderConnectionContext;
  roots: ScanRoot[]; scanProfile: Record<string, unknown>; settings: Record<string, unknown>; signal: AbortSignal;
  enrich: (descriptor: MediaDescriptor, signal: AbortSignal) => Promise<EnrichedMetadata>;
  persist: (descriptor: MediaDescriptor, source: SourceFileRecord, metadata: EnrichedMetadata | undefined, signal: AbortSignal) => Promise<string[]>;
  control: () => Promise<void>;
  failure: (stage: string, entry: ProviderEntry | undefined, error: string) => Promise<void>;
}

/** 音乐独立三阶段调度，标签完成即可浏览，不等待全库在线资料。 */
export async function runMusicScan(input: MusicScanInput): Promise<void> {
  // 明确账号字段优先，缺失时用凭据摘要隔离，不把明文放进预算键。
  const identity = input.connection.account || input.connection.userId || input.connection.accountId || input.connection.user_id
    || input.connection.uid || input.connection.loginName || input.connection.userName || input.connection.username || input.connection.authorization || JSON.stringify(input.connection);
  const accountKey = createHash("sha256").update(JSON.stringify([input.adapter.descriptor.type, input.connection.baseUrl ?? "", identity])).digest("hex");
  return withMusicRequestBudget(accountKey, () => runStages(input));
}

/** 三阶段在账号请求作用域内执行，单实例全局文件 8、在线 4。 */
async function runStages(input: MusicScanInput): Promise<void> {
  const { job, repository, database, adapter, connection, config } = input;
  const state = new MusicScanState(database.query, job.id);
  const settings = await state.initialize(input.settings);
  Object.assign(input.settings, settings);
  const checkpoint = (await repository.getOrCreateScanJobCheckpoint(job, adapter.descriptor.type)).checkpoint;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const revision = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  const concurrency = (key: string, fallback: number, maximum: number) => Math.min(maximum, Math.max(1, Math.floor(Number(input.scanProfile[key]) || fallback)));
  const selectedStage = String(job.snapshot.musicRetryStage ?? "all");
  const runDirectory = selectedStage === "all" || selectedStage === "directory";
  const runFile = selectedStage !== "online";
  let discoveryDone = !runDirectory || await state.discoveryClosed();
  let fileDone = !runFile;
  let finished = false;
  let fatalError: unknown;
  let currentPath = "";
  let stopped = false;
  let lastProgress = 0;

  /** 定时更新进度并轮询跨进程控制，网络任务随信号中断。 */
  const publish = async (finalSnapshot = false) => {
    if (!finalSnapshot) { await input.control(); signal.throwIfAborted(); }
    if (!finalSnapshot && Date.now() - lastProgress < 1000) return;
    lastProgress = Date.now();
    const stages = await state.progress();
    const file = stages[1]!; const online = stages[2]!;
    const fileCompleted = file.succeeded + file.failed + file.skipped;
    const completed = Math.max(0, fileCompleted - online.pending - online.running);
    const currentTasks = await database.query("music_scan_tasks").select("stage", "payload").where({ job_id: job.id, status: "running" }).limit(20);
    const current = new Map(currentTasks.map((task) => {
      const payload = JSON.parse(String(task.payload)) as { path?: string; entry?: ProviderEntry };
      return [String(task.stage), payload.entry?.path ?? payload.path ?? ""];
    }));
    await repository.updateJobProgress(job.id, { stage: discoveryDone ? "scraping" : "enumerating", discoveredCount: file.total,
      totalCount: discoveryDone ? file.total : null, processedCount: completed,
      skippedCount: online.skipped, matchedCount: online.succeeded, unmatchedCount: online.unmatched,
      errorCount: stages.reduce((sum, stage) => sum + stage.failed, 0), currentPath,
      musicStages: stages.map((stage, index) => ({ ...stage, currentPath: current.get(stage.stage) ?? "", effectiveConcurrency: concurrency(index === 0 ? "scanDirectoryConcurrency" : index === 1 ? "musicFileConcurrency" : "scrapeTaskConcurrency", index === 2 ? 2 : 4, index === 2 ? 4 : 8), closed: (index === 0 ? discoveryDone : index === 1 ? fileDone : discoveryDone && fileDone) && stage.pending + stage.running === 0 })) });
  };

  /** 枚举以目录完成回调作为文件领取屏障，重放不会覆盖成功任务。 */
  const discover = async () => {
    if (discoveryDone) return;
    for (const root of input.roots) {
      signal.throwIfAborted();
      const rootKey = createStableId("scan-root", root.resourceId || root.displayPath || "/");
      const rootRun = await repository.startScanRootRun({ job, rootKey, rootResourceId: root.resourceId || root.displayPath || "/", displayPath: root.displayPath || "/" });
      const sidecars = new Map<string, ProviderEntry[]>();
      const warnings: Array<{ path: string; message: string }> = [];
      for await (const entry of adapter.enumerate(connection, [root], signal, (warning) => {
        if (/auth|credential|token.*expired/u.test(warning.code)) throw new ApiError(410, warning.code, warning.message);
        warnings.push(warning);
      }, {
        directoryConcurrency: concurrency("scanDirectoryConcurrency", 4, 8), persistConnection: input.context.persistConnection,
        loadDirectoryPage: (directoryPath, pageKey, load) => state.loadPage(directoryPath, pageKey, load, signal),
        onDirectoryComplete: async (directoryPath) => {
          const key = state.directoryKey(directoryPath);
          await state.closeDirectory(directoryPath, sidecars.get(key) ?? []);
          sidecars.delete(key);
          // 整个目录先提交，之后才等待下游；大目录不会卡死在尚未释放的文件任务上。
          while (!signal.aborted) {
            const blocked = await Promise.all([state.hasBacklog("file", 1000), state.hasBacklog("online", 500)]);
            if (!blocked.some(Boolean)) break;
            await delay(150, undefined, { signal });
          }
        },
      })) {
        signal.throwIfAborted();
        currentPath = entry.path;
        const directory = path.posix.dirname(entry.path);
        const parent = state.directoryKey(directory);
        await state.enqueue("directory", parent, parent, { path: directory });
        if (/\.(lrc|jpg|jpeg|png|webp)$/iu.test(entry.name)) {
          const entries = sidecars.get(parent) ?? []; entries.push(entry); sidecars.set(parent, entries);
          continue;
        }
        if (!describeMediaFile(entry, ["music"], root.displayPath || "/")) continue;
        const source: SourceFileRecord = { id: createStableId("src", job.userId, job.libraryId, entry.resourceId), userId: job.userId, serviceId: job.serviceId, libraryId: job.libraryId,
          providerResourceId: entry.resourceId.length > 500 ? createStableId("resource", entry.resourceId) : entry.resourceId,
          parentResourceId: entry.parentResourceId && entry.parentResourceId.length > 500 ? createStableId("resource", entry.parentResourceId) : entry.parentResourceId,
          path: entry.path, name: entry.name, extension: getFileExtension(entry.name), size: entry.size, modifiedAt: entry.modifiedAt, etag: entry.etag,
          scanRootKey: rootKey, generationId: rootRun.generationId, metadataProfileRevision: Number(job.snapshot.metadataProfileRevision), recognitionRevision: revision, locator: entry.locator };
        const prepared = (await repository.prepareSourceFiles([source]))[0]!;
        await state.enqueue("file", prepared.sourceFile.id, parent, { entry, source: prepared.sourceFile }, true);
      }
      signal.throwIfAborted();
      for (const warning of warnings) {
        const id = await state.enqueue("directory", state.directoryKey(warning.path), state.directoryKey(warning.path), { path: warning.path });
        await database.query("music_scan_tasks").where({ id }).update({ status: "failed", error: warning.message.slice(0, 600) });
        await input.failure("directory", undefined, `${warning.path}：${warning.message}`);
      }
      await repository.finishScanRootRun({ jobId: job.id, rootKey, warningCount: warnings.length });
    }
    discoveryDone = true;
    await state.closeDiscovery();
  };

  /** 文件阶段保存原始快照，在线补全失败可复用它重试。 */
  const fileTask = async (task: MusicStageTask) => {
    const work = JSON.parse(task.payload) as FileWork;
    const sidecars = await state.sidecars(task.parent_key) as ProviderEntry[];
    const fingerprint = createHash("sha256").update(createAudioTagFingerprint(work.entry) + JSON.stringify([work.entry.path, work.entry.name, sidecars.map((entry) => [entry.resourceId, entry.name, entry.size, entry.modifiedAt, entry.etag]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))]) + "music-file-v3").digest("hex");
    let cached = await database.query("music_file_snapshots").where({ source_file_id: work.source.id, file_fingerprint: fingerprint }).first();
    if (cached?.file_result) {
      const saved = JSON.parse(String(cached.file_result)) as MediaDescriptor;
      for (const image of [saved.metadata.embeddedArtworkUrl, saved.metadata.sidecarArtworkUrl]) {
        if (typeof image === "string" && image.startsWith("/api/v1/music-artwork/")) {
          try { await fs.access(path.join(config.musicArtworkDirectory, path.posix.basename(image))); }
          catch { cached = undefined; break; }
        }
      }
    }
    let descriptor = describeMediaFile(work.entry, ["music"], "/")!;
    let error = "";
    if (cached?.file_result) descriptor = JSON.parse(String(cached.file_result)) as MediaDescriptor;
    else {
      const tagFingerprint = createAudioTagFingerprint(work.entry);
      let tags = await repository.readAudioTagCache(work.source.id, tagFingerprint);
      if (tags?.artwork.url?.startsWith("/api/v1/music-artwork/")) {
        try { await fs.access(path.join(config.musicArtworkDirectory, path.posix.basename(tags.artwork.url))); }
        catch { tags = null; }
      }
      if (!tags || tags.errorCode) {
        if (!adapter.resolveFileStreamAccess) throw new Error("当前来源不支持音频读取");
        tags = await readBoundedAudioTags(config, work.entry, () => adapter.resolveFileStreamAccess!(connection, work.entry.locator, signal, input.context), signal);
        signal.throwIfAborted();
        if (tags.status !== "failed" && !tags.errorCode) await repository.saveAudioTagCache({ sourceFile: work.source, fingerprint: tagFingerprint, result: tags });
      }
      descriptor = applyAudioTagsToDescriptor(descriptor, tags);
      descriptor.metadata.fileName = work.entry.name;
      const sidecarErrors = await applyMusicSidecars({ descriptor, entries: sidecars, adapter, connection, context: input.context, config, signal });
      error = [tags.errorMessage, ...sidecarErrors].filter(Boolean).join("；");
      descriptor.metadata.fileReadError = error;
      if (!error) await database.query("music_file_snapshots").insert({ source_file_id: work.source.id, file_fingerprint: fingerprint, online_fingerprint: "", file_result: JSON.stringify(descriptor), online_result: "{}", online_status: "pending" })
        .onConflict("source_file_id").merge({ file_fingerprint: fingerprint, file_result: JSON.stringify(descriptor), online_fingerprint: "", online_status: "pending" });
    }
    signal.throwIfAborted();
    // 先提供可播放目录；已有在线快照留到下阶段一次性恢复，避免覆盖旧资料。
    if (!cached || !cached.online_fingerprint) await state.recordChanges(await input.persist(descriptor, work.source, undefined, signal));
    await state.finish(task, error ? "failed" : cached ? "skipped" : "succeeded", descriptor, error, { ...work, descriptor, fingerprint, fileError: error } satisfies OnlineWork);
    if (error) await input.failure("file", work.entry, error);
  };

  /** 在线阶段按曲目完整查询指纹缓存，不复用其他歌曲的候选。 */
  const onlineTask = async (task: MusicStageTask) => {
    const work = JSON.parse(task.payload) as OnlineWork;
    const fingerprint = createHash("sha256").update(work.fingerprint + revision).digest("hex");
    const cached = await database.query("music_file_snapshots").where({ source_file_id: work.source.id, online_fingerprint: fingerprint }).first();
    const retry = Boolean(job.snapshot.retryOfJobId);
    const reuse = cached && (!retry || ["succeeded", "skipped"].includes(String(cached.online_status)));
    const metadata = reuse ? JSON.parse(String(cached.online_result)) as EnrichedMetadata : await input.enrich(work.descriptor, signal);
    signal.throwIfAborted();
    await state.recordChanges(await input.persist(work.descriptor, work.source, metadata, signal));
    const status = metadata.metadata.onlineReadError ? "failed"
      : metadata.metadata.musicOnlineState === "skipped" ? "skipped"
      : metadata.metadata.musicOnlineState === "unmatched" ? "unmatched"
      : metadata.matchState === "matched" ? "succeeded" : "unmatched";
    await repository.markSourceFilesMetadataProcessed([work.source.id], Number(job.snapshot.metadataProfileRevision), revision);
    if (!work.fileError && status !== "failed") await database.query("music_file_snapshots").where({ source_file_id: work.source.id, file_fingerprint: work.fingerprint }).update({ online_fingerprint: fingerprint, online_result: JSON.stringify(metadata), online_status: status });
    await state.finish(task, reuse && status === "succeeded" ? "skipped" : status, metadata, String(metadata.metadata.onlineReadError ?? ""));
    if (status === "failed") await input.failure("online", work.entry, String(metadata.metadata.onlineReadError));
    if (status === "unmatched") await input.failure("online", work.entry, "在线来源未找到可信匹配，文件资料与播放已保留");
  };

  /** 各阶段独立领取，队列暂空时等待上游，不能提前结束。 */
  const consume = async (stage: "file" | "online") => {
    while (!signal.aborted) {
      if (stage === "file") {
        if (await state.hasBacklog("online", 500)) { await delay(150, undefined, { signal }); continue; }
      }
      const task = await state.claim(stage);
      if (!task) {
        if ((stage === "file" ? discoveryDone : fileDone) && await state.runnableCount(stage) === 0) return;
        await delay(150, undefined, { signal }); continue;
      }
      let release: (() => void) | undefined;
      try {
        release = await acquireMusicBudget(stage, signal);
        await (stage === "file" ? fileTask(task) : onlineTask(task));
      }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof ApiError && error.statusCode === 410) throw error;
        const message = error instanceof Error ? error.message : "音乐阶段处理失败";
        await state.finish(task, "failed", {}, message);
        await input.failure(stage, (JSON.parse(task.payload) as FileWork).entry, message);
      } finally { release?.(); }
    }
    signal.throwIfAborted();
  };
  const tasks: Promise<unknown>[] = [];
  try {
    tasks.push(discover());
    tasks.push((runFile ? Promise.all(Array.from({ length: concurrency("musicFileConcurrency", 4, 8) }, () => consume("file"))) : Promise.resolve()).then(() => { fileDone = true; }));
    tasks.push(Promise.all(Array.from({ length: concurrency("scrapeTaskConcurrency", 2, 4) }, () => consume("online"))));
    const monitor = (async () => { while (!stopped) { await publish(); await delay(500, undefined, { signal }); } })().catch((error) => { fatalError ??= error; controller.abort(); throw error; });
    // 监控异常同样取消工作，避免未处理 Promise 或暂停后继续落库。
    tasks.push(monitor);
    await Promise.race([Promise.all(tasks.slice(0, 3).map((task) => task.catch((error) => { fatalError ??= error; controller.abort(); throw error; }))), monitor]);
    stopped = true;
    await monitor;
    lastProgress = 0;
    await publish();
    const completed = job.scanMode === "full" && !job.snapshot.retryOfJobId ? await repository.listCompletedScanRootRuns(job.id) : [];
    await repository.finalizeGeneration({ userId: job.userId, serviceId: job.serviceId, libraryId: job.libraryId, generationId: checkpoint.generationId,
      completedRootGenerations: completed.map((root) => ({ rootKey: root.rootKey, generationId: root.generationId })), deleteMissing: completed.length > 0, allowDestructiveCleanup: false, changedItemIds: await state.changedItemIds() });
    const remaining = (await state.progress()).some((stage) => stage.pending + stage.running > 0);
    await repository.finishJob(job.id, remaining
      ? { status: "failed", errorCode: "music_other_stages_pending", errorMessage: "本次阶段已结束，其他阶段尚未完成，请重试全部失败内容" }
      : { status: "completed" });
    finished = true;
    console.info("codex-flycloud-music", { 事件: remaining ? "所选阶段结束，其他阶段待继续" : "三阶段扫描完成", 任务ID: job.id, 网盘类型: adapter.descriptor.type });
  } catch (error) {
    throw fatalError ?? error;
  } finally {
    stopped = true;
    controller.abort();
    await Promise.allSettled(tasks);
    if (!finished) {
      await state.releaseRunning();
      await publish(true);
    }
  }
}
