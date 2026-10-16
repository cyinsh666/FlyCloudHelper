import { MusicScanStages } from "../components/MusicScanStages";
import { Link } from "@tanstack/react-router";
import { BookOpen, Download, Images, Layers3, Music2, Pause, Play, Plus, Radio, RefreshCw, RotateCcw, Settings2, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { AdminServiceFilters } from "@/components/AdminServiceFilters";
import { AiSupplementDialog } from "@/components/AiSupplementDialog";
import { ProviderSelectionIcon } from "@/components/ServiceCreateSelection";
import { FilterChip, Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  cancelScanJob,
  clearCompletedAndFailedScanJobs,
  controlLibraryScanJob,
  createManualAiSupplementJob,
  deleteLibraryScanJob,
  deleteScanJob,
  downloadScanFailureReport,
  getJobAiSupplements,
  listJobs,
  listAdminUsers,
  listMediaProbeJobFailures,
  listProviders,
  listLibraries,
  pauseScanJob,
  resumeScanJob,
  retryScanJob,
  type JobStatus,
  type JobAiSupplementResult,
  type MediaProbeFailure,
  type ScanJob,
  type ServiceListFilters,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { formatJobDateTime, formatJobDuration, getJobDurationLabel } from "@/lib/job-duration";

// 关键变量：后台任务页固定每 5 秒读取一次进度，避免轮询和 SSE 同时触发重复请求。
const JOB_PROGRESS_REFRESH_INTERVAL_MS = 5_000;

// 关键变量：右侧任务列表每页固定展示 8 条，以两列四行展示当前页任务。
const JOB_LIST_PAGE_SIZE = 8;

// 关键变量：媒体库卡片使用简短中文类型，避免在紧凑布局中展示接口枚举。
const catalogDataTypeLabels: Record<string, string> = {
  video: "影视",
  music: "音乐",
  audiobook: "有声书",
};

const jobStatusLabels: Record<JobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  retry_waiting: "等待 TMDB 恢复",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const jobStageLabels: Record<string, string> = {
  queued: "等待执行",
  enumerating: "扫描与刮削",
  classifying: "识别媒体",
  scraping: "扫描刮削",
  persisting: "写入目录",
  probing: "分析视频规格",
  completed: "已完成",
};

const backgroundJobTypeLabels = {
  scan: "扫描刮削",
  media_probe: "视频规格分析",
} as const;

type JobStatusFilter = "all" | "active" | JobStatus;
type JobTypeFilter = "all" | keyof typeof backgroundJobTypeLabels;

// 关键变量：状态筛选按展示顺序平铺，“全部”固定为第一项。
const jobStatusFilterOptions: Array<{ value: JobStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "未结束" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "运行中" },
  { value: "retry_waiting", label: "等待重试" },
  { value: "paused", label: "已暂停" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];

// 关键变量：类型筛选按展示顺序平铺，“全部”固定为第一项。
const jobTypeFilterOptions: Array<{ value: JobTypeFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "scan", label: "扫描刮削" },
  { value: "media_probe", label: "视频规格分析" },
];

/** 区分普通扫描和手动 AI 补充任务，避免任务列表只显示为全量扫描。 */
function getBackgroundJobLabel(job: ScanJob): string {
  if (job.jobType === "media_probe") return backgroundJobTypeLabels.media_probe;
  if (job.snapshot.taskPurpose === "ai_supplement_unmatched") return "AI补充未识别内容";
  return `${job.scanMode === "full" ? "全量" : "增量"}扫描刮削`;
}

const providerTypeLabels: Record<string, string> = {
  webdav: "WebDAV",
  aliyundrive: "阿里云盘",
  baidupan: "百度网盘",
  guangya: "光鸭",
};

interface JobSnapshotField {
  label: string;
  value: string;
}

interface JobPluginSnapshot {
  pluginId: string;
  version: string;
  configurationRevision: string;
  sha256: string;
}

type JobOperation = "pause" | "resume" | "cancel" | "retry" | "delete";

interface JobListGroup {
  key: string;
  parentJobId: string | null;
  jobs: ScanJob[];
}

const jobOperationLabels: Record<JobOperation, string> = {
  pause: "暂停",
  resume: "继续",
  cancel: "终止",
  retry: "重试",
  delete: "删除",
};

/** 将任务阶段转换成中文展示名称。 */
function getJobStageLabel(stage: string): string {
  return jobStageLabels[stage] ?? stage;
}

/** 返回后台任务状态文案，规格任务的等待原因不引用 TMDB。 */
function getJobStatusLabel(job: { jobType: "scan" | "media_probe"; status: JobStatus; errorCode: string | null }): string {
  if (job.jobType === "media_probe" && job.status === "retry_waiting"
    && job.errorCode === "provider_authentication_failed") return "等待重新授权";
  if (job.status === "retry_waiting" && job.jobType === "media_probe") return "等待重试";
  return jobStatusLabels[job.status];
}

/** 根据服务数据类型显示实际扫描的文件类型。 */
function getScannedMediaLabel(dataType: "video" | "music" | "audiobook"): string {
  return dataType === "video" ? "扫描视频" : "扫描音频";
}

/** 根据服务数据类型显示完成处理的媒体业务对象。 */
function getProcessedMediaLabel(dataType: "video" | "music" | "audiobook"): string {
  if (dataType === "music") return "处理曲目";
  if (dataType === "audiobook") return "处理作品";
  return "处理影片";
}

/** 根据服务数据类型说明任务处理数量的统计口径。 */
function getProcessedMediaDescription(dataType: "video" | "music" | "audiobook"): string {
  if (dataType === "music") return "已经完成标签读取、元数据刮削和落库的曲目文件数量";
  if (dataType === "audiobook") return "已完成本地标签、章节整理和落库的有声书作品数量；单个音轨文件不单独算一本书";
  return "按 Flymby APP 刮削任务聚合后，已经成功处理或最终失败的完整电影、节目数量";
}

/** 根据服务数据类型说明匹配和未匹配数量的统计口径。 */
function getMatchedMediaDescription(dataType: "video" | "music" | "audiobook", matched: boolean): string {
  const mediaName = dataType === "music" ? "曲目" : dataType === "audiobook" ? "有声书" : "完整电影或节目";
  return matched
    ? `${mediaName}中取得元数据匹配结果的数量`
    : `${mediaName}中已处理但没有取得元数据匹配结果的数量`;
}

/** 旧任务没有保存匹配数量时显示横线，避免把未知误报为零。 */
function formatOptionalCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

/** 把服务端 ISO 时间转换为当前浏览器本地时间。 */
function formatCheckpointTime(value: string | null): string {
  if (!value) return "尚未保存";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN", { hour12: false });
}

/** 旧任务曾把所有网盘文件计入发现数，改用已处理和错误数避免继续显示非媒体文件总量。 */
function getScannedMediaCount(job: {
  discoveredCount: number;
  processedCount: number;
  errorCount: number;
  matchedCount: number | null;
}): number {
  return job.matchedCount === null ? job.processedCount + job.errorCount : job.discoveredCount;
}

/** AI 补充任务的“待补充”表示剩余数量，不能直接显示任务开始时固定的总数。 */
function getAiSupplementPendingCount(job: {
  processedCount: number;
  totalCount: number | null;
  discoveredCount: number;
}): number {
  // 关键变量：新任务使用 totalCount，历史异常数据缺少总数时才回退 discoveredCount。
  const totalCount = job.totalCount ?? job.discoveredCount;
  return Math.max(0, totalCount - job.processedCount);
}

/** 读取任务冻结配置中的已知字段，不向页面输出 JSON 原文。 */
function getJobSnapshotFields(snapshot: Record<string, unknown>): JobSnapshotField[] {
  const providerType = typeof snapshot.providerType === "string" ? snapshot.providerType : "";
  const fields: Array<JobSnapshotField | null> = [
    typeof snapshot.credentialRevision === "number" ? { label: "连接配置修订", value: `r${snapshot.credentialRevision}` } : null,
    typeof snapshot.scanProfileRevision === "number" ? { label: "扫描配置修订", value: `r${snapshot.scanProfileRevision}` } : null,
    typeof snapshot.metadataProfileRevision === "number" ? { label: "元数据配置修订", value: `r${snapshot.metadataProfileRevision}` } : null,
    providerType ? { label: "网盘类型", value: providerTypeLabels[providerType] ?? providerType } : null,
    typeof snapshot.runtimeRevision === "string" ? { label: "扫描程序版本", value: snapshot.runtimeRevision } : null,
    typeof snapshot.tmdbKeyPoolRevision === "string" ? { label: "TMDB Key 池版本", value: snapshot.tmdbKeyPoolRevision } : null,
    snapshot.taskPurpose === "ai_supplement_unmatched" ? { label: "任务用途", value: "AI补充未识别内容" } : null,
    typeof snapshot.triggerType === "string" ? { label: "触发方式", value: snapshot.triggerType === "manual_backfill" ? "手动分析已有视频" : snapshot.triggerType === "scan_completed" ? "扫描完成" : snapshot.triggerType === "retry" ? "重试失败文件" : snapshot.triggerType === "reauthorized" ? "重新授权后恢复" : "服务恢复" } : null,
    typeof snapshot.sourceScanJobId === "string" && snapshot.sourceScanJobId ? { label: "来源后台任务", value: snapshot.sourceScanJobId } : null,
    typeof snapshot.retryOfJobId === "string" && snapshot.retryOfJobId ? { label: "重试来源任务", value: snapshot.retryOfJobId } : null,
  ];
  return fields.filter((field): field is JobSnapshotField => field !== null);
}

/** 读取任务冻结的插件版本和配置修订。 */
function getJobPluginSnapshots(snapshot: Record<string, unknown>): JobPluginSnapshot[] {
  if (!Array.isArray(snapshot.pluginVersions)) return [];
  return snapshot.pluginVersions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const plugin = value as Record<string, unknown>;
    if (typeof plugin.pluginId !== "string") return [];
    return [{
      pluginId: plugin.pluginId,
      version: typeof plugin.version === "string" ? plugin.version : "未知",
      configurationRevision: typeof plugin.configurationRevision === "number" ? `r${plugin.configurationRevision}` : "未知",
      sha256: typeof plugin.sha256 === "string" ? plugin.sha256 : "",
    }];
  });
}

/** 将任务状态映射为视觉语义。 */
function getJobTone(status: JobStatus): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "retry_waiting" || status === "paused") return "warning";
  return "primary";
}

/** 将任务状态映射为标题旁圆点颜色，文字说明通过 title 和 aria-label 保留。 */
function getJobStatusDotClass(status: JobStatus): string {
  if (status === "completed") return "bg-success";
  if (status === "failed" || status === "cancelled") return "bg-destructive";
  if (status === "queued" || status === "retry_waiting" || status === "paused") return "bg-warning";
  return "animate-pulse bg-primary";
}

/** 生成排队任务的简短等待说明，列表和详情保持同一套含义。 */
function getQueuedJobWaitSummary(job: ScanJob): string {
  if (job.status !== "queued") return "";
  const visibleTargets = job.waitingForJobs
    .slice(0, 3)
    .map((target) => `${target.serviceName}（${target.id.slice(0, 8)}）`);
  const omittedTargetCount = Math.max(0, job.waitingForJobs.length - visibleTargets.length);
  const targetParts = [...visibleTargets];
  if (omittedTargetCount > 0) targetParts.push(`另 ${omittedTargetCount} 个`);
  if (job.hiddenWaitingJobCount > 0) targetParts.push(`其他账号 ${job.hiddenWaitingJobCount} 个`);
  const targetText = targetParts.length > 0 ? `：${targetParts.join("、")}` : "";
  const queueText = job.queueAheadCount > 0 ? `，前方另有 ${job.queueAheadCount} 个扫描任务排队` : "";
  if (job.waitingReason === "service_scan_priority") return `等待同服务扫描任务结束${targetText}`;
  if (job.waitingReason === "scan_worker_capacity") return `等待任一运行中的扫描任务结束${targetText}${queueText}`;
  if (job.waitingReason === "media_probe_worker_capacity") return `等待视频规格执行槽位${targetText}`;
  if (job.waitingReason === "scan_queue_order") return `前方还有 ${job.queueAheadCount} 个扫描任务排队`;
  return "等待后台 Worker 领取任务";
}

/** 判断任务是否支持重试；规格任务完成但包含失败文件时也可以只重试失败项。 */
function canRetryJob(job: ScanJob): boolean {
  return job.status === "failed" || job.status === "cancelled"
    || (job.jobType === "media_probe" && job.status === "completed" && job.errorCount > 0)
    || (job.dataType === "music" && job.status === "completed" && (job.errorCount > 0 || Number(job.unmatchedCount) > 0));
}

/** 判断任务是否可以进入暂停状态。 */
function canPauseJob(job: ScanJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "retry_waiting";
}

/** 判断任务是否可以继续执行。 */
function canResumeJob(job: ScanJob): boolean {
  return job.status === "paused";
}

/** 判断任务是否允许终止。 */
function canCancelJob(job: ScanJob): boolean {
  return ["queued", "running", "retry_waiting", "paused"].includes(job.status);
}

/** 判断任务是否已经进入允许删除的终态。 */
function canDeleteJob(job: ScanJob): boolean {
  return ["completed", "failed", "cancelled"].includes(job.status);
}

/** 按云聚合父任务合并任务列表；普通扫描和视频规格任务仍各自独立展示。 */
function groupJobList(jobs: ScanJob[]): JobListGroup[] {
  const groups: JobListGroup[] = [];
  const aggregateGroupIndexes = new Map<string, number>();
  for (const job of jobs) {
    if (!job.parentJobId || job.jobType !== "scan") {
      groups.push({ key: job.id, parentJobId: null, jobs: [job] });
      continue;
    }
    const groupIndex = aggregateGroupIndexes.get(job.parentJobId);
    if (groupIndex === undefined) {
      aggregateGroupIndexes.set(job.parentJobId, groups.length);
      groups.push({ key: `aggregate:${job.parentJobId}`, parentJobId: job.parentJobId, jobs: [job] });
      continue;
    }
    groups[groupIndex]?.jobs.push(job);
  }
  return groups;
}

/** 汇总云聚合来源子任务状态，优先展示仍在执行或需要处理的状态。 */
function getAggregateGroupStatus(jobs: ScanJob[]): JobStatus {
  const statusPriority: JobStatus[] = ["running", "retry_waiting", "queued", "paused", "failed", "cancelled", "completed"];
  return statusPriority.find((status) => jobs.some((job) => job.status === status)) ?? "completed";
}

/** 渲染任务列表及选中任务详情。 */
function JobsView({ admin }: { admin: boolean }) {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [jobTypeFilter, setJobTypeFilter] = useState<JobTypeFilter>("all");
  const [jobPageOffset, setJobPageOffset] = useState(0);
  const resource = useApiResource(
    () => listJobs(admin, {
      status: statusFilter === "all" ? undefined : statusFilter,
      jobType: jobTypeFilter === "all" ? undefined : jobTypeFilter,
      groupParentJobs: true,
      limit: JOB_LIST_PAGE_SIZE,
      offset: jobPageOffset,
    }),
    [admin, statusFilter, jobTypeFilter, jobPageOffset],
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mediaProbeFailures, setMediaProbeFailures] = useState<MediaProbeFailure[]>([]);
  const [mediaProbeFailuresLoaded, setMediaProbeFailuresLoaded] = useState(false);
  const [aiSupplementDialogOpen, setAiSupplementDialogOpen] = useState(false);
  const [aiSupplementDialogJobId, setAiSupplementDialogJobId] = useState("");
  const [aiSupplementDialogServiceId, setAiSupplementDialogServiceId] = useState("");
  const [aiSupplementResult, setAiSupplementResult] = useState<JobAiSupplementResult | null>(null);
  const [aiSupplementLoading, setAiSupplementLoading] = useState(false);
  const [aiSupplementError, setAiSupplementError] = useState<string | null>(null);
  const [aiSupplementTriggering, setAiSupplementTriggering] = useState(false);
  const [aiSupplementTriggerError, setAiSupplementTriggerError] = useState<string | null>(null);
  // 关键变量：下载状态跟随任务 ID，切换任务后不会把上一任务的提示显示到当前详情。
  const [failureReportState, setFailureReportState] = useState<{
    jobId: string;
    downloading: boolean;
    message: string;
  } | null>(null);
  const [pendingJobOperations, setPendingJobOperations] = useState<Record<string, JobOperation>>({});
  const [clearingCompletedJobs, setClearingCompletedJobs] = useState(false);
  // 关键变量：引用中的任务操作会在事件处理入口同步写入，阻止 React 状态刷新前发生的连续点击。
  const pendingJobOperationsRef = useRef<Map<string, JobOperation>>(new Map());
  // 关键变量：批量清理请求同步占位，避免确认框关闭到 React 刷新之间重复提交。
  const clearingCompletedJobsRef = useRef(false);
  // 关键变量：Dialog 请求归属任务，切换任务或关闭后忽略旧请求返回。
  const aiSupplementRequestJobIdRef = useRef<string | null>(null);
  // 关键变量：同步占用手动补充请求，阻止按钮状态刷新前的连续点击。
  const aiSupplementTriggeringRef = useRef(false);
  const jobs = resource.data?.items ?? [];
  const jobGroups = useMemo(() => groupJobList(jobs), [jobs]);
  const activeJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  const activeJobGroup = activeJob ? jobGroups.find((group) => group.jobs.some((job) => job.id === activeJob.id)) : undefined;
  const activeParentJobId = activeJobGroup?.parentJobId ?? null;
  const pendingActiveJobOperation = activeJob ? pendingJobOperations[activeJob.id] : undefined;
  const pendingActiveGroupOperation = activeParentJobId ? pendingJobOperations[activeParentJobId] : undefined;
  const activeJobIsAiSupplement = activeJob?.snapshot.taskPurpose === "ai_supplement_unmatched";
  const activeJobOperationBlocked = Boolean(activeJob && (pendingActiveJobOperation || activeJob.controlAction !== "none"));
  const activeGroupOperationBlocked = Boolean(activeJobGroup && (pendingActiveGroupOperation
    || activeJobGroup.jobs.some((job) => job.controlAction !== "none")));
  const canRetryActiveJob = Boolean(activeJob && canRetryJob(activeJob));
  const canPauseActiveJob = Boolean(activeJob && canPauseJob(activeJob));
  const canResumeActiveJob = Boolean(activeJob && canResumeJob(activeJob));
  const canCancelActiveJob = Boolean(activeJob && canCancelJob(activeJob));
  const canDeleteActiveJob = Boolean(activeJob && canDeleteJob(activeJob));
  const canPauseActiveGroup = Boolean(activeParentJobId && activeJobGroup?.jobs.some(canPauseJob));
  const canResumeActiveGroup = Boolean(activeParentJobId && activeJobGroup?.jobs.some(canResumeJob));
  const canCancelActiveGroup = Boolean(activeParentJobId && activeJobGroup?.jobs.some(canCancelJob));
  const canDeleteActiveGroup = Boolean(activeParentJobId && activeJobGroup && activeJobGroup.jobs.every(canDeleteJob));
  const canDownloadFailureReport = Boolean(activeJob && activeJob.jobType === "scan" && activeJob.status !== "queued");
  const snapshotFields = activeJob ? getJobSnapshotFields(activeJob.snapshot) : [];
  const pluginSnapshots = activeJob ? getJobPluginSnapshots(activeJob.snapshot) : [];
  const jobTotal = resource.data?.total ?? 0;
  const jobPageCount = Math.max(1, Math.ceil(jobTotal / JOB_LIST_PAGE_SIZE));
  const currentJobPage = Math.floor(jobPageOffset / JOB_LIST_PAGE_SIZE) + 1;

  useEffect(() => {
    if (jobTotal === 0 || jobPageOffset < jobTotal) return;
    // 删除当前页最后一条任务后返回新的末页，避免列表停留在空白页。
    setJobPageOffset(Math.max(0, (jobPageCount - 1) * JOB_LIST_PAGE_SIZE));
  }, [jobPageCount, jobPageOffset, jobTotal]);

  useEffect(() => {
    /** 页面处于前台时才读取任务进度，后台标签页不继续占用接口。 */
    const refreshVisiblePage = (): void => {
      if (document.visibilityState !== "visible") return;
      void resource.refresh();
    };
    const timer = window.setInterval(refreshVisiblePage, JOB_PROGRESS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [resource.refresh]);

  useEffect(() => {
    if (!resource.error) return;
    console.warn("codex-job-progress-refresh", { "刷新错误": resource.error, "管理模式": admin });
  }, [admin, resource.error]);

  useEffect(() => {
    const aggregateGroups = jobGroups.filter((group) => group.parentJobId !== null);
    if (aggregateGroups.length === 0) return;
    console.info("codex-library-scan-group", {
      事件: "后台任务列表合并云聚合来源子任务",
      父任务数量: aggregateGroups.length,
      来源子任务数量: aggregateGroups.reduce((count, group) => count + group.jobs.length, 0),
      父任务ID: aggregateGroups.map((group) => group.parentJobId),
    });
  }, [jobGroups]);

  useEffect(() => {
    console.info("codex-job-list-filter", {
      "事件": "切换后台任务筛选",
      "管理模式": admin ? "管理员" : "用户",
      "状态筛选": statusFilter,
      "类型筛选": jobTypeFilter,
    });
  }, [admin, jobTypeFilter, statusFilter]);

  useEffect(() => {
    if (!activeJob || activeJob.jobType !== "media_probe" || activeJob.errorCount <= 0) {
      setMediaProbeFailures([]);
      setMediaProbeFailuresLoaded(false);
      return;
    }
    let cancelled = false;
    setMediaProbeFailuresLoaded(false);
    void listMediaProbeJobFailures(activeJob.id, admin).then((result) => {
      if (!cancelled) {
        setMediaProbeFailures(result.items);
        setMediaProbeFailuresLoaded(true);
      }
    }).catch((error) => {
      if (cancelled) return;
      setMediaProbeFailuresLoaded(true);
      console.warn("codex-media-ffprobe-task", {
        事件: "读取规格后台任务失败文件失败",
        后台任务ID: activeJob.id,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
    });
    return () => { cancelled = true; };
  }, [activeJob?.errorCount, activeJob?.id, activeJob?.jobType, admin]);

  /** 同步占用当前任务的操作槽，避免同一任务同时提交暂停、终止等互斥请求。 */
  function beginJobOperation(jobId: string, operation: JobOperation): boolean {
    const existingOperation = pendingJobOperationsRef.current.get(jobId);
    if (existingOperation) {
      console.warn("codex-flycloud-helper-job-operation", {
        事件: "拦截重复任务操作",
        任务ID: jobId,
        正在处理: jobOperationLabels[existingOperation],
        本次操作: jobOperationLabels[operation],
      });
      return false;
    }
    pendingJobOperationsRef.current.set(jobId, operation);
    setPendingJobOperations(Object.fromEntries(pendingJobOperationsRef.current));
    return true;
  }

  /** 释放指定任务操作槽；请求成功、失败都允许用户在状态刷新后重新操作。 */
  function finishJobOperation(jobId: string): void {
    pendingJobOperationsRef.current.delete(jobId);
    setPendingJobOperations(Object.fromEntries(pendingJobOperationsRef.current));
  }

  /** 通过任务重试接口保留原任务关联并创建新任务。 */
  async function retryJob(targetJob: ScanJob, musicStage?: string): Promise<void> {
    if (!canRetryJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "retry")) return;
    setMessage(targetJob.dataType === "music" ? "正在将音乐阶段重新加入队列…" : "正在创建重试任务…");
    try {
      const job = await retryScanJob(targetJobId, admin, musicStage);
      setJobPageOffset(0);
      setSelectedJobId(job.id);
      setMessage(`任务 ${job.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 二次确认后向对应 Worker 提交后台任务终止请求。 */
  async function cancelJob(targetJob: ScanJob): Promise<void> {
    if (!canCancelJob(targetJob)) return;
    if (!window.confirm(`确定终止后台任务 ${targetJob.id} 吗？已经完成的处理结果不会自动回滚。`)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "cancel")) return;
    setMessage("正在提交终止请求…");
    try {
      await cancelScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 的终止请求已提交`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "终止任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 请求对应 Worker 在安全边界暂停当前后台任务。 */
  async function pauseJob(targetJob: ScanJob): Promise<void> {
    if (!canPauseJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "pause")) return;
    setMessage("正在提交暂停请求…");
    try {
      await pauseScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 将在安全检查点暂停`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂停任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 继续已暂停后台任务，扫描任务恢复目录游标，规格任务继续剩余文件。 */
  async function resumeJob(targetJob: ScanJob): Promise<void> {
    if (!canResumeJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "resume")) return;
    setMessage("正在恢复后台任务…");
    try {
      await resumeScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 已恢复到队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "继续任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 二次确认后删除终态任务及其进度事件。 */
  async function deleteJob(targetJob: ScanJob): Promise<void> {
    if (!canDeleteJob(targetJob)) return;
    if (!window.confirm(`确定删除后台任务 ${targetJob.id} 吗？该任务的进度和错误记录将无法恢复。`)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "delete")) return;
    setMessage("正在删除任务…");
    try {
      await deleteScanJob(targetJobId, admin);
      setSelectedJobId((currentJobId) => currentJobId === targetJobId ? null : currentJobId);
      setMessage(`任务 ${targetJobId} 已删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 对云聚合父任务统一执行暂停、继续或取消，并保留各来源已经完成的结果。 */
  async function controlAggregateGroup(targetGroup: JobListGroup, action: "pause" | "resume" | "cancel"): Promise<void> {
    const parentJobId = targetGroup.parentJobId;
    const firstSourceJob = targetGroup.jobs[0];
    if (!parentJobId || !firstSourceJob) return;
    if (action === "pause" && !targetGroup.jobs.some(canPauseJob)) return;
    if (action === "resume" && !targetGroup.jobs.some(canResumeJob)) return;
    if (action === "cancel" && !targetGroup.jobs.some(canCancelJob)) return;
    if (action === "cancel" && !window.confirm(`确定取消整组云聚合扫描 ${parentJobId} 吗？已经完成的来源结果不会自动回滚。`)) return;
    const operation: JobOperation = action === "pause" ? "pause" : action === "resume" ? "resume" : "cancel";
    if (!beginJobOperation(parentJobId, operation)) return;
    setMessage(action === "pause" ? "正在暂停全部来源…" : action === "resume" ? "正在继续全部已暂停来源…" : "正在取消全部来源…");
    try {
      await controlLibraryScanJob(firstSourceJob.libraryId, parentJobId, action, admin);
      setMessage(action === "pause" ? "已提交暂停全部来源" : action === "resume" ? "已继续全部已暂停来源" : "已提交取消全部来源");
      console.info("codex-library-scan-parent", {
        事件: "后台任务页控制云聚合父任务",
        父任务ID: parentJobId,
        媒体库ID: firstSourceJob.libraryId,
        控制动作: action,
        来源子任务数量: targetGroup.jobs.length,
      });
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "聚合任务控制失败");
    } finally {
      finishJobOperation(parentJobId);
    }
  }

  /** 删除已经结束的云聚合父任务及其全部来源子任务。 */
  async function deleteAggregateGroup(targetGroup: JobListGroup): Promise<void> {
    const parentJobId = targetGroup.parentJobId;
    const firstSourceJob = targetGroup.jobs[0];
    if (!parentJobId || !firstSourceJob || !targetGroup.jobs.every(canDeleteJob)) return;
    if (!window.confirm(`确定删除整组云聚合扫描 ${parentJobId} 吗？全部来源任务、进度和错误记录都将删除。`)) return;
    if (!beginJobOperation(parentJobId, "delete")) return;
    setMessage("正在删除整组云聚合扫描…");
    try {
      await deleteLibraryScanJob(firstSourceJob.libraryId, parentJobId, admin);
      setSelectedJobId(null);
      setMessage(`云聚合扫描 ${parentJobId} 已整组删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除聚合任务失败");
    } finally {
      finishJobOperation(parentJobId);
    }
  }

  /** 二次确认后清除权限范围内全部已完成和失败任务，保留其他状态任务。 */
  async function clearCompletedJobs(): Promise<void> {
    if (clearingCompletedJobsRef.current) return;
    if (!window.confirm("确定清除全部已完成和失败任务吗？这些任务的进度、错误记录及失败报告将一并删除；已取消、排队、运行、等待重试和暂停任务都会保留。")) return;
    clearingCompletedJobsRef.current = true;
    setClearingCompletedJobs(true);
    setMessage("正在清除已完成和失败任务…");
    try {
      const deletedCount = await clearCompletedAndFailedScanJobs(admin);
      setJobPageOffset(0);
      setSelectedJobId(null);
      setMessage(`已清除 ${deletedCount.toLocaleString()} 个已完成或失败任务`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清除已完成和失败任务失败");
    } finally {
      clearingCompletedJobsRef.current = false;
      setClearingCompletedJobs(false);
    }
  }

  /** 下载任务扫描或 AI 补充阶段产生的脱敏失败报告，并在按钮旁显示结果。 */
  async function downloadSelectedFailureReport(): Promise<void> {
    if (!activeJob || !canDownloadFailureReport) return;
    const targetJob = activeJob;
    const aiSupplementTask = targetJob.snapshot.taskPurpose === "ai_supplement_unmatched";
    const downloadingMessage = aiSupplementTask ? "正在下载 AI 补充失败报告…" : "正在下载扫描失败报告…";
    setFailureReportState({ jobId: targetJob.id, downloading: true, message: downloadingMessage });
    setMessage(downloadingMessage);
    try {
      await downloadScanFailureReport(targetJob.id, admin);
      const successMessage = aiSupplementTask ? "AI 补充失败报告已开始下载" : "扫描失败报告已开始下载";
      setFailureReportState({ jobId: targetJob.id, downloading: false, message: successMessage });
      setMessage(`任务 ${targetJob.id} 的失败报告已开始下载`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "失败报告下载失败";
      console.warn(aiSupplementTask ? "codex-flycloud-helper-ai-clean" : "codex-scan-failure-report", {
        "事件": aiSupplementTask ? "AI补充失败报告下载失败" : "扫描失败报告下载失败",
        "任务ID": targetJob.id,
        "错误信息": error instanceof Error ? error.message : "未知错误",
      });
      setFailureReportState({ jobId: targetJob.id, downloading: false, message: errorMessage });
      setMessage(errorMessage);
    }
  }

  /** 打开当前扫描任务的 AI 补充汇总，并读取最近 20 条采用内容。 */
  async function openAiSupplementDialog(): Promise<void> {
    if (!activeJob || activeJob.jobType !== "scan") return;
    const targetJobId = activeJob.id;
    aiSupplementRequestJobIdRef.current = targetJobId;
    setAiSupplementDialogJobId(targetJobId);
    setAiSupplementDialogServiceId(activeJob.serviceId);
    setAiSupplementDialogOpen(true);
    setAiSupplementLoading(true);
    setAiSupplementError(null);
    setAiSupplementTriggerError(null);
    setAiSupplementResult(null);
    try {
      const result = await getJobAiSupplements(targetJobId, admin);
      if (aiSupplementRequestJobIdRef.current !== targetJobId) return;
      setAiSupplementResult(result);
    } catch (error) {
      if (aiSupplementRequestJobIdRef.current !== targetJobId) return;
      const errorMessage = error instanceof Error ? error.message : "读取 AI 补充详情失败";
      console.warn("codex-flycloud-helper-ai-clean", {
        事件: "读取任务AI补充详情失败",
        任务ID: targetJobId,
        错误信息: errorMessage,
      });
      setAiSupplementError(errorMessage);
    } finally {
      if (aiSupplementRequestJobIdRef.current === targetJobId) setAiSupplementLoading(false);
    }
  }

  /** 为当前任务所属媒体库创建一次只重试未识别内容的 AI 补充任务。 */
  async function triggerManualAiSupplement(): Promise<void> {
    if (!aiSupplementDialogServiceId || aiSupplementTriggeringRef.current) return;
    aiSupplementTriggeringRef.current = true;
    setAiSupplementTriggering(true);
    setAiSupplementTriggerError(null);
    try {
      const job = await createManualAiSupplementJob(aiSupplementDialogServiceId, admin);
      setMessage(`已创建 AI 补充任务 ${job.id}，只处理媒体库现有未匹配内容，不会重新扫描网盘`);
      aiSupplementRequestJobIdRef.current = null;
      setAiSupplementDialogOpen(false);
      await resource.refresh();
      setSelectedJobId(job.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "创建 AI 补充任务失败";
      console.warn("codex-flycloud-helper-ai-clean", {
        事件: "手动创建未识别内容AI补充任务失败",
        服务ID: aiSupplementDialogServiceId,
        错误信息: errorMessage,
      });
      setAiSupplementTriggerError(errorMessage);
    } finally {
      aiSupplementTriggeringRef.current = false;
      setAiSupplementTriggering(false);
    }
  }

  /** 关闭 AI 补充详情并使尚未完成的旧请求失效。 */
  function closeAiSupplementDialog(): void {
    aiSupplementRequestJobIdRef.current = null;
    setAiSupplementDialogOpen(false);
  }

  return (
    <>
      <PageHeader
        title={admin ? "全部后台任务" : "后台任务"}
        actions={<>
          <SecondaryButton onClick={() => void resource.refresh()}><Radio className="size-4" /> 每 5 秒刷新</SecondaryButton>
          {activeParentJobId && activeJobGroup && <>
            <span className="self-center text-xs text-muted-foreground">聚合任务</span>
            <SecondaryButton onClick={() => void controlAggregateGroup(activeJobGroup, "pause")} disabled={!canPauseActiveGroup || activeGroupOperationBlocked}><Pause className="size-4" /> {pendingActiveGroupOperation === "pause" ? "暂停处理中…" : "暂停全部"}</SecondaryButton>
            <SecondaryButton onClick={() => void controlAggregateGroup(activeJobGroup, "resume")} disabled={!canResumeActiveGroup || activeGroupOperationBlocked}><Play className="size-4" /> {pendingActiveGroupOperation === "resume" ? "正在继续…" : "继续全部"}</SecondaryButton>
            <SecondaryButton onClick={() => void controlAggregateGroup(activeJobGroup, "cancel")} disabled={!canCancelActiveGroup || activeGroupOperationBlocked}><Square className="size-4" /> {pendingActiveGroupOperation === "cancel" ? "取消处理中…" : "取消全部"}</SecondaryButton>
            <button type="button" onClick={() => void deleteAggregateGroup(activeJobGroup)} disabled={!canDeleteActiveGroup || activeGroupOperationBlocked} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {pendingActiveGroupOperation === "delete" ? "正在删除…" : "删除整组"}</button>
          </>}
        </>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel collapsible className="mb-4" title="筛选任务">
        <div className="grid gap-4">
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">任务状态</p>
            <div className="flex flex-wrap gap-2">
              {jobStatusFilterOptions.map((option) => (
                <FilterChip key={option.value} active={statusFilter === option.value} onClick={() => { setJobPageOffset(0); setStatusFilter(option.value); }}>
                  {option.label}
                </FilterChip>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">任务类型</p>
            <div className="flex flex-wrap gap-2">
              {jobTypeFilterOptions.map((option) => (
                <FilterChip key={option.value} active={jobTypeFilter === option.value} onClick={() => { setJobPageOffset(0); setJobTypeFilter(option.value); }}>
                  {option.label}
                </FilterChip>
              ))}
            </div>
          </div>
        </div>
      </Panel>
      {!activeJob ? <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? (statusFilter === "all" && jobTypeFilter === "all" ? "还没有后台任务" : "当前筛选条件下没有任务")}</div></Panel> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Panel className="p-4 sm:p-4 xl:h-[calc(100vh-14rem)] xl:min-h-[560px] xl:max-h-[720px] xl:overflow-y-auto" title="任务详情" description={`${activeJob.serviceName} · ${getBackgroundJobLabel(activeJob)}${admin ? ` · ${activeJob.ownerUsername}` : ""} · 任务 ${activeJob.id.slice(0, 8)}`}>
            <div className="rounded-xl border border-primary/25 bg-primary/8 p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><div><p className="text-[11px] text-muted-foreground">当前阶段</p><p className="font-display mt-0.5 text-xl font-semibold">{getJobStageLabel(activeJob.stage)}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{getJobDurationLabel(activeJob.status)}：{formatJobDuration(activeJob.elapsedMs)}</p></div><StatusPill tone={getJobTone(activeJob.status)}>{getJobStatusLabel(activeJob)}</StatusPill></div>
              <div className="mt-3"><ProgressMeter value={activeJob.status === "completed" ? 1 : activeJob.processedCount} total={activeJob.status === "completed" ? 1 : activeJob.totalCount} /></div>
              {activeJob.status === "queued" && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5">
                <p className="text-xs font-medium">{getQueuedJobWaitSummary(activeJob)}</p>
                {activeJob.waitingForJobs.length > 0 && <ul className="mt-2 space-y-1.5">
                  {activeJob.waitingForJobs.map((target) => <li key={`${target.jobType}:${target.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate" title={`${target.serviceName} · ${target.id}`}>{target.serviceName} · <span className="font-mono">{target.id}</span>{admin ? ` · ${target.ownerUsername}` : ""}</span>
                    <span>{jobStatusLabels[target.status]}</span>
                  </li>)}
                </ul>}
              </div>}
              <div className="mt-3 min-w-0 border-t border-border/70 pt-3">
                <p className="text-[11px] text-muted-foreground">{activeJob.jobType === "media_probe" ? "当前分析文件" : activeJobIsAiSupplement ? "当前处理内容" : "当前扫描路径"}</p>
                <p className="mt-1 truncate font-mono text-xs" title={activeJob.currentPath ?? undefined}>{activeJob.currentPath || (activeJob.jobType === "media_probe" ? "等待领取视频文件" : activeJobIsAiSupplement ? "准备读取媒体库未匹配内容" : "准备读取扫描目录")}</p>
                {activeJob.jobType === "scan" && activeJob.resumeSupported && <p className="mt-2 text-[11px] text-muted-foreground">可恢复检查点：{formatCheckpointTime(activeJob.checkpointUpdatedAt)}</p>}
              </div>
              {activeJob.status === "retry_waiting" && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"><p className="text-sm font-medium">{activeJob.jobType === "media_probe" ? activeJob.errorCode === "provider_authentication_failed" ? "Provider 登录已失效，等待 APP 同步有效登录信息" : "上游地址或文件读取暂时失败，任务会自动重试" : "TMDB 暂时不可用，任务会自动恢复"}</p><p className="mt-1 text-[11px] text-muted-foreground">{activeJob.jobType === "media_probe" && activeJob.errorCode === "provider_authentication_failed" ? "同步成功后后台任务会自动继续" : <>预计恢复时间：{formatCheckpointTime(activeJob.nextRetryAt)}{activeJob.jobType === "scan" ? ` · 已等待 ${activeJob.retryCount.toLocaleString()} 次` : ""}</>}</p></div>}
              {activeJob.jobType === "media_probe" ? (
                <div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px] text-muted-foreground">
                  <span>总文件 {activeJob.totalCount?.toLocaleString() ?? "0"}</span>
                  <span>已处理 {activeJob.processedCount.toLocaleString()}</span>
                  <span>失败 {activeJob.errorCount.toLocaleString()}</span>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-[11px] text-muted-foreground sm:grid-cols-5">
                  <span title={activeJobIsAiSupplement ? "当前任务尚未完成 AI 补充处理的电影或节目数量" : "扫描路径中识别出的可处理媒体文件数量"}>{activeJobIsAiSupplement ? "待补充" : getScannedMediaLabel(activeJob.dataType)} {(activeJobIsAiSupplement ? getAiSupplementPendingCount(activeJob) : getScannedMediaCount(activeJob)).toLocaleString()}</span>
                  <span title={activeJobIsAiSupplement ? "已经完成 AI 补充处理的电影或节目数量" : getProcessedMediaDescription(activeJob.dataType)}>{activeJobIsAiSupplement ? "已处理" : getProcessedMediaLabel(activeJob.dataType)} {activeJob.processedCount.toLocaleString()}</span>
                  <span title={getMatchedMediaDescription(activeJob.dataType, true)}>已匹配 {formatOptionalCount(activeJob.matchedCount)}</span>
                  <span title={getMatchedMediaDescription(activeJob.dataType, false)}>未匹配 {formatOptionalCount(activeJob.unmatchedCount)}</span>
                  <span title="完整电影或节目处理失败的数量">错误 {activeJob.errorCount.toLocaleString()}</span>
                </div>
              )}
              <div className="mt-3 border-t border-border/70 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">{activeParentJobId ? `当前来源任务 · ${activeJob.serviceName}` : "当前任务操作"}</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <SecondaryButton onClick={() => void pauseJob(activeJob)} disabled={!canPauseActiveJob || activeJobOperationBlocked}><Pause className="size-4" /> {pendingActiveJobOperation === "pause" || activeJob.controlAction === "pause" ? "暂停处理中…" : "暂停当前"}</SecondaryButton>
                    <SecondaryButton onClick={() => void resumeJob(activeJob)} disabled={!canResumeActiveJob || activeJobOperationBlocked}><Play className="size-4" /> {pendingActiveJobOperation === "resume" ? "正在继续…" : "继续当前"}</SecondaryButton>
                    <SecondaryButton onClick={() => void cancelJob(activeJob)} disabled={!canCancelActiveJob || activeJobOperationBlocked}><Square className="size-4" /> {pendingActiveJobOperation === "cancel" || activeJob.controlAction === "cancel" ? "取消处理中…" : "取消当前"}</SecondaryButton>
                    <PrimaryButton onClick={() => void retryJob(activeJob)} disabled={!canRetryActiveJob || activeJobOperationBlocked}><RotateCcw className="size-4" /> {pendingActiveJobOperation === "retry" ? "正在重试…" : activeJobIsAiSupplement ? "重试AI补充" : "重试当前"}</PrimaryButton>
                    <button type="button" onClick={() => void deleteJob(activeJob)} disabled={!canDeleteActiveJob || activeJobOperationBlocked} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {pendingActiveJobOperation === "delete" ? "正在删除…" : "删除当前"}</button>
                  </div>
                </div>
              </div>
              {activeJob.jobType === "scan" && <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border/70 pt-3">
                <SecondaryButton onClick={() => void openAiSupplementDialog()}>
                  <Sparkles className="size-4" /> AI补充详情
                </SecondaryButton>
                <SecondaryButton
                  onClick={() => void downloadSelectedFailureReport()}
                  disabled={!canDownloadFailureReport || (failureReportState?.jobId === activeJob.id && failureReportState.downloading)}
                >
                  <Download className="size-4" /> {failureReportState?.jobId === activeJob.id && failureReportState.downloading
                    ? "正在下载…"
                    : activeJobIsAiSupplement ? "下载AI补充失败报告" : "下载失败报告"}
                </SecondaryButton>
              </div>}
              {activeJob.jobType === "scan" && failureReportState?.jobId === activeJob.id && (
                <p className="mt-2 text-right text-xs text-muted-foreground">{failureReportState.message}</p>
              )}
            </div>
            {activeJob.dataType === "music" && <MusicScanStages jobId={activeJob.id} admin={admin} stages={activeJob.snapshot.musicStages} retryEnabled={canRetryActiveJob && !activeJobOperationBlocked} onRetry={(stage) => void retryJob(activeJob, stage)} />}
            <h3 className="mt-4 mb-2 text-sm font-semibold">配置快照（只读）</h3>
            <div className="rounded-xl border border-border bg-secondary/40 p-3">
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {snapshotFields.map((field) => <div key={field.label}><dt className="text-[10px] text-muted-foreground">{field.label}</dt><dd className="mt-0.5 break-all text-xs">{field.value}</dd></div>)}
              </dl>
              {activeJob.jobType === "scan" && <div className="mt-4 border-t border-border pt-4">
                <p className="text-[11px] text-muted-foreground">元数据插件</p>
                {pluginSnapshots.length === 0 ? <p className="mt-2 text-sm">未使用插件</p> : <ul className="mt-2 space-y-2">{pluginSnapshots.map((plugin) => <li key={`${plugin.pluginId}@${plugin.version}`} className="rounded-lg border border-border bg-background/35 px-3 py-2"><p className="text-sm">{plugin.pluginId} · {plugin.version}</p><p className="mt-1 text-[11px] text-muted-foreground">配置 {plugin.configurationRevision}{plugin.sha256 ? ` · SHA256 ${plugin.sha256.slice(0, 12)}` : ""}</p></li>)}</ul>}
              </div>}
            </div>
            {activeJob.jobType === "media_probe" && activeJob.errorCount > 0 && (
              <div className="mt-4 rounded-xl border border-warning/30 bg-warning/8 p-4">
                <h3 className="text-sm font-semibold">失败文件</h3>
                {mediaProbeFailures.length > 0 ? <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">{mediaProbeFailures.map((failure) => (
                  <li key={failure.sourceFileId} className="rounded-lg border border-border bg-background/35 px-3 py-2">
                    <p className="truncate text-xs" title={failure.fileName}>{failure.fileName}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">{failure.errorCode} · {failure.errorMessage}</p>
                  </li>
                ))}</ul> : <p className="mt-2 text-xs text-muted-foreground">{mediaProbeFailuresLoaded ? "没有需要逐文件展示的失败记录" : "正在读取失败文件…"}</p>}
              </div>
            )}
            {activeJob.status !== "retry_waiting" && (activeJob.errorCode || activeJob.errorMessage) && <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-4"><p className="font-mono text-xs text-destructive">{activeJob.errorCode}</p><p className="mt-2 text-sm">{activeJob.errorMessage}</p></div>}
          </Panel>
          <Panel
            className="overflow-hidden p-4 sm:p-4 xl:flex xl:h-[calc(100vh-14rem)] xl:min-h-[560px] xl:max-h-[720px] xl:flex-col"
            title="任务列表"
            description={`当前页 ${jobGroups.length} 组 · ${jobs.length} 个底层任务 · 共 ${jobTotal} 组 · 第 ${currentJobPage}/${jobPageCount} 页`}
            action={<button type="button" title="清除已完成和失败的任务" onClick={() => void clearCompletedJobs()} disabled={clearingCompletedJobs} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /> {clearingCompletedJobs ? "正在清除…" : "清除已完成和失败"}</button>}
          >
            <ul className="grid max-h-[560px] grid-cols-1 content-start gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 xl:min-h-0 xl:flex-1 xl:max-h-none">
              {jobGroups.map((group) => {
                if (group.parentJobId) {
                  const firstSourceJob = group.jobs[0];
                  if (!firstSourceJob) return null;
                  const pendingGroupOperation = pendingJobOperations[group.parentJobId];
                  const groupOperationBlocked = Boolean(pendingGroupOperation || group.jobs.some((job) => job.controlAction !== "none"));
                  const groupStatus = getAggregateGroupStatus(group.jobs);
                  const groupSelected = group.jobs.some((job) => job.id === activeJob?.id);
                  const selectedSourceJob = group.jobs.find((job) => job.id === activeJob?.id) ?? firstSourceJob;
                  const groupProcessedCount = group.jobs.reduce((count, job) => count + job.processedCount, 0);
                  const groupErrorCount = group.jobs.reduce((count, job) => count + job.errorCount, 0);
                  return <li key={group.key} className="sm:col-span-2">
                    <article className={`overflow-hidden rounded-xl border bg-secondary/40 transition-colors ${groupSelected ? "border-foreground/45" : "border-border hover:border-foreground/25"}`}>
                      <button type="button" aria-pressed={groupSelected} onClick={() => setSelectedJobId(selectedSourceJob.id)} className="w-full px-3 py-2.5 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <Layers3 className="size-4 shrink-0 text-muted-foreground" />
                          <p className="truncate text-sm font-semibold">云聚合{firstSourceJob.scanMode === "full" ? "全量" : "增量"}扫描</p>
                          <span role="status" aria-label={jobStatusLabels[groupStatus]} title={jobStatusLabels[groupStatus]} className={`size-2 shrink-0 rounded-full ${getJobStatusDotClass(groupStatus)}`} />
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{group.jobs.length} 个来源</span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">已处理 {groupProcessedCount.toLocaleString()} · 错误 {groupErrorCount.toLocaleString()} · 父任务 {group.parentJobId.slice(0, 8)}</p>
                      </button>
                      <div className="grid gap-1.5 border-t border-border/70 p-2 sm:grid-cols-2">
                        {group.jobs.map((job) => {
                          const sourceSelected = activeJob?.id === job.id;
                          return <button key={job.id} type="button" aria-pressed={sourceSelected} onClick={() => setSelectedJobId(job.id)} className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${sourceSelected ? "border-foreground/40 bg-background/70" : "border-border/70 bg-background/35 hover:border-foreground/25"}`}>
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={`size-2 shrink-0 rounded-full ${getJobStatusDotClass(job.status)}`} />
                              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={job.serviceName}>{job.serviceName}</span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{getJobStatusLabel(job)}</span>
                            </div>
                            <p className="mt-1 truncate text-[10px] text-muted-foreground">{getJobStageLabel(job.stage)} · 已处理 {job.processedCount.toLocaleString()}{job.errorCount > 0 ? ` · 错误 ${job.errorCount.toLocaleString()}` : ""}</p>
                          </button>;
                        })}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
                        <span className="text-[10px] text-muted-foreground">整组操作</span>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button type="button" onClick={() => void controlAggregateGroup(group, "pause")} disabled={!group.jobs.some(canPauseJob) || groupOperationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Pause className="size-3.5" />{pendingGroupOperation === "pause" ? "暂停处理中…" : "暂停全部"}</button>
                          <button type="button" onClick={() => void controlAggregateGroup(group, "resume")} disabled={!group.jobs.some(canResumeJob) || groupOperationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Play className="size-3.5" />{pendingGroupOperation === "resume" ? "正在继续…" : "继续全部"}</button>
                          <button type="button" onClick={() => void controlAggregateGroup(group, "cancel")} disabled={!group.jobs.some(canCancelJob) || groupOperationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Square className="size-3.5" />{pendingGroupOperation === "cancel" ? "取消处理中…" : "取消全部"}</button>
                          <button type="button" onClick={() => void deleteAggregateGroup(group)} disabled={!group.jobs.every(canDeleteJob) || groupOperationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" />{pendingGroupOperation === "delete" ? "正在删除…" : "删除整组"}</button>
                        </div>
                      </div>
                    </article>
                  </li>;
                }
                const job = group.jobs[0];
                if (!job) return null;
                const selected = activeJob?.id === job.id;
                const pendingOperation = pendingJobOperations[job.id];
                const operationBlocked = Boolean(pendingOperation || job.controlAction !== "none");
                const hasFooterOperation = canPauseJob(job) || canResumeJob(job) || canCancelJob(job) || canRetryJob(job);
                return <li key={group.key}>
                  <article className={`relative overflow-hidden rounded-xl border bg-secondary/40 transition-colors ${selected ? "border-foreground/45" : "border-border hover:border-foreground/25"}`}>
                    <button type="button" aria-pressed={selected} onClick={() => setSelectedJobId(job.id)} className={`w-full px-3 py-2.5 text-left ${canDeleteJob(job) ? "pr-11" : ""}`}>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-semibold" title={job.serviceName}>{job.serviceName}</p>
                          <span role="status" aria-label={getJobStatusLabel(job)} title={getJobStatusLabel(job)} className={`size-2 shrink-0 rounded-full ${getJobStatusDotClass(job.status)}`} />
                        </div>
                        <div className="min-w-0">
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{getBackgroundJobLabel(job)} · {getJobStageLabel(job.stage)}{admin ? ` · ${job.ownerUsername}` : ""}</p>
                          {job.status === "queued" && <p className="mt-1 truncate text-[11px] text-warning" title={getQueuedJobWaitSummary(job)}>{getQueuedJobWaitSummary(job)}</p>}
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">{getJobDurationLabel(job.status)} {formatJobDuration(job.elapsedMs)}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">开始时间 {formatJobDateTime(job.startedAt)}</p>
                        </div>
                      </div>
                      <div className="mt-1.5"><ProgressMeter value={job.status === "completed" ? 1 : job.processedCount} total={job.status === "completed" ? 1 : job.totalCount} /></div>
                    </button>
                    {canDeleteJob(job) && <button type="button" aria-label={`删除 ${job.serviceName} 的任务`} title="删除任务" onClick={() => { setSelectedJobId(job.id); void deleteJob(job); }} disabled={operationBlocked} className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-md text-destructive transition-colors hover:bg-destructive/12 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /></button>}
                    {hasFooterOperation && <div className="flex flex-wrap justify-end gap-1.5 border-t border-border/70 px-3 py-2">
                      {canPauseJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void pauseJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Pause className="size-3.5" />{pendingOperation === "pause" || job.controlAction === "pause" ? "暂停处理中…" : "暂停"}</button>}
                      {canResumeJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void resumeJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Play className="size-3.5" />{pendingOperation === "resume" ? "正在继续…" : "继续"}</button>}
                      {canCancelJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void cancelJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Square className="size-3.5" />{pendingOperation === "cancel" || job.controlAction === "cancel" ? "终止处理中…" : "终止"}</button>}
                      {canRetryJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void retryJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw className="size-3.5" />{pendingOperation === "retry" ? "正在重试…" : job.snapshot.taskPurpose === "ai_supplement_unmatched" ? "重试AI补充" : "重试"}</button>}
                    </div>}
                  </article>
                </li>;
              })}
            </ul>
            <div className="mt-3 flex items-center justify-center gap-3 border-t border-border/70 pt-3">
              <button type="button" disabled={jobPageOffset <= 0 || resource.loading} onClick={() => setJobPageOffset(Math.max(0, jobPageOffset - JOB_LIST_PAGE_SIZE))} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
              <span className="text-xs text-muted-foreground">{currentJobPage} / {jobPageCount}</span>
              <button type="button" disabled={jobPageOffset + JOB_LIST_PAGE_SIZE >= jobTotal || resource.loading} onClick={() => setJobPageOffset(jobPageOffset + JOB_LIST_PAGE_SIZE)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
            </div>
          </Panel>
        </div>
      )}
      <AiSupplementDialog state={{
        open: aiSupplementDialogOpen,
        loading: aiSupplementLoading,
        error: aiSupplementError,
        jobId: aiSupplementDialogJobId,
        result: aiSupplementResult,
        triggering: aiSupplementTriggering,
        triggerError: aiSupplementTriggerError,
        onTrigger: () => void triggerManualAiSupplement(),
        onClose: closeAiSupplementDialog,
      }} />
    </>
  );
}

export function UserJobsPage() { return <JobsView admin={false} />; }
export function AdminJobsPage() { return <JobsView admin />; }

/** 按服务选择独立媒体库，不把不同服务的条目合并到同一个海报墙。 */
function CatalogServiceSelector({ admin }: { admin: boolean }) {
  const [filters, setFilters] = useState<ServiceListFilters>({});
  const resource = useApiResource(
    () => listLibraries(admin, admin ? filters : {}),
    [admin, filters.search, filters.userId, filters.providerType, filters.dataType, filters.status],
  );
  const filterOptions = useApiResource(async () => {
    if (!admin) return { users: [], providers: [] };
    const [users, providers] = await Promise.all([listAdminUsers(), listProviders()]);
    return { users: users.items, providers };
  }, [admin]);
  const libraries = resource.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={admin ? "媒体库管理" : "我的媒体库"}
        actions={(
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新</SecondaryButton>
            {!admin && <Link to="/app/libraries/new"><PrimaryButton><Plus className="size-4" /> 创建媒体库</PrimaryButton></Link>}
          </div>
        )}
      />
      {admin && <AdminServiceFilters value={filters} users={filterOptions.data?.users ?? []} providers={filterOptions.data?.providers ?? []} resultCount={resource.data?.total ?? 0} onChange={setFilters} />}
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {libraries.map((library) => (
          <article key={library.id} className="surface p-4">
            <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-xs font-semibold" style={{ backgroundImage: "var(--gradient-surface)" }}>
                  {library.libraryKind === "content_source_audiobook" ? <BookOpen className="size-5 text-muted-foreground" /> : library.libraryKind === "content_source_music" ? <Music2 className="size-5 text-muted-foreground" /> : library.libraryKind === "content_source_video" ? <Images className="size-5 text-muted-foreground" /> : <ProviderSelectionIcon providerType={library.libraryKind === "cloud_aggregate_video" ? "aggregate" : library.providerType} />}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{library.displayName}</h2>
                  <p className="truncate text-[11px] text-muted-foreground">{library.libraryKind === "content_source_audiobook" ? `在线听书源 · ${library.sourceServiceName}` : library.libraryKind === "content_source_music" ? `在线音乐源 · ${library.sourceServiceName}` : library.libraryKind === "content_source_video" ? `在线内容源 · ${library.sourceServiceName}` : library.libraryKind === "cloud_aggregate_video" ? `云聚合视频库 · ${library.sourceCount} 个来源` : `${library.sourceServiceName} · ${library.providerType}`}{admin ? ` · ${library.ownerUsername}` : ""}</p>
                </div>
              </div>
              <span className={`mt-1 size-2.5 rounded-full ${library.status === "active" && library.sourceConnectionStatus === "valid" ? "bg-success" : "bg-warning"}`} title={library.status === "active" ? "媒体库已启用" : "媒体库已停用"} />
            </header>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <StatusPill>{catalogDataTypeLabels[library.dataType] ?? library.dataType}</StatusPill>
              <span>条目 {library.itemCount.toLocaleString()}</span>
              <span>版本 v{library.catalogVersion}</span>
              {library.dataType === "music" ? <span>Navidrome {library.navidromeEnabled ? "已启用" : "未启用"}</span> : library.dataType === "audiobook" ? <span>ABS {library.absEnabled ? "已启用" : "未启用"}</span> : <span>Jellyfin {library.jellyfinEnabled ? "已启用" : "未启用"}</span>}
            </div>
            <footer className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
              <Link to={admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog"} params={{ serviceId: library.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Images className="size-3.5" /> 海报</Link>
              <Link to={admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings"} params={{ serviceId: library.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Settings2 className="size-3.5" /> 设置</Link>
            </footer>
          </article>
        ))}
      </div>
      {!resource.loading && libraries.length === 0 && <Panel><p className="py-12 text-center text-sm text-muted-foreground">还没有媒体库</p></Panel>}
    </>
  );
}

export function UserCatalogPage() { return <CatalogServiceSelector admin={false} />; }
export function AdminCatalogPage() { return <CatalogServiceSelector admin />; }
