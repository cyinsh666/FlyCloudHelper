export type UserRole = "user" | "super_admin";
export type UserStatus = "active" | "disabled" | "pending_delete";
export type NotificationCategory = "task" | "security" | "system";
export type NotificationTone = "info" | "success" | "warning" | "danger";
export type ServiceStatus = "active" | "scanning" | "reauthorization_required" | "disabled";
export type ScanScheduleType = "interval" | "daily" | "weekly" | "monthly";
export type JobStatus = "queued" | "running" | "retry_waiting" | "paused" | "completed" | "failed" | "cancelled";
export type BackgroundJobType = "scan" | "media_probe";
export type JobStage = "queued" | "enumerating" | "classifying" | "scraping" | "persisting" | "probing" | "completed";
export type MediaType = "video" | "music" | "audiobook";
export type MediaLibraryKind = "legacy_single_source" | "cloud_aggregate_video" | "content_source_video" | "content_source_music";
/** 文件浏览启动的精确视频扫描范围，跟随任务快照持久化并用于重试。 */
export interface TargetedVideoScanScope {
  kind: "folder" | "video";
  resourceId: string;
  parentResourceId: string;
  displayPath: string;
  parentDisplayPath: string;
  driveId?: string;
}
export type LibrarySourceMode = "linked_service" | "owned_copy" | "content_source";
export type LibrarySourceStatus = "active" | "disabled" | "reauthorization_required" | "copy_failed" | "deleted";
export type VideoRegionGroup = "chinese" | "japan_korea" | "europe_america" | "other";
export type CatalogSort =
  | "created_desc"
  | "created_asc"
  | "updated_desc"
  | "updated_asc"
  | "year_desc"
  | "year_asc"
  | "premiere_date_desc"
  | "premiere_date_asc"
  | "title_asc"
  | "title_desc";
export type MatchState = "matched" | "needs_review" | "unmatched" | "processing";


export interface PublicUserRecord {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 控制台右上角展示的持久化通知。 */
export interface NotificationRecord {
  id: string;
  userId: string;
  category: NotificationCategory;
  tone: NotificationTone;
  title: string;
  message: string;
  actionPath: string | null;
  createdAt: string;
}

export interface AuthenticationRecord extends PublicUserRecord {
  passwordHash: string;
}

export interface SystemStateRecord {
  serviceInstanceId: string;
  setupRequired: boolean;
  credentialKeyBackupRequired: boolean;
  credentialKeySource: "file" | "environment" | "generated" | null;
  schemaVersion: number;
}

export interface CloudServiceRecord {
  id: string;
  userId: string;
  ownerUsername: string;
  displayName: string;
  /** 用户填写的服务描述，空字符串表示未填写。 */
  description: string;
  providerType: string;
  status: ServiceStatus;
  connectionStatus: string;
  credentialRevision: number;
  /** 未建立旧单媒体库来源时允许从服务详情打开快速创建入口。 */
  canCreateLibrary: boolean;
  /** 服务允许删除；删除时解除媒体库引用，有未结束任务时由接口拒绝。 */
  canDeleteService: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDetailRecord extends CloudServiceRecord {
  credentialConfigured: boolean;
}

/** 媒体库来源成员摘要；新来源引用统一网盘服务，owned_copy 只用于兼容遗留数据。 */
export interface LibrarySourceRecord {
  id: string;
  userId: string;
  libraryId: string;
  serviceId: string | null;
  sourceMode: LibrarySourceMode;
  displayName: string;
  providerType: string;
  serviceStatus: ServiceStatus | null;
  connectionStatus: string;
  credentialRevision: number;
  credentialConfigured: boolean;
  configuration: Record<string, unknown>;
  status: LibrarySourceStatus;
  sortOrder: number;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 媒体库及本次唯一来源服务的公开摘要。 */
export interface MediaLibraryRecord {
  id: string;
  userId: string;
  ownerUsername: string;
  displayName: string;
  dataType: MediaType;
  libraryKind: MediaLibraryKind;
  status: "active" | "disabled";
  sourceId: string;
  sourceServiceId: string;
  sourceServiceName: string;
  providerType: string;
  sourceConnectionStatus: string;
  sourceCount: number;
  sources: LibrarySourceRecord[];
  notificationEnabled: boolean;
  jellyfinEnabled: boolean;
  embyEnabled: boolean;
  navidromeEnabled: boolean;
  scanProfileRevision: number;
  metadataProfileRevision: number;
  catalogVersion: number;
  itemCount: number;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobWaitTargetRecord {
  id: string;
  jobType: BackgroundJobType;
  serviceId: string;
  serviceName: string;
  ownerUsername: string;
  status: JobStatus;
}

export interface ScanJobRecord {
  id: string;
  /** 后台任务类型；保留 ScanJobRecord 名称兼容现有 APP 和接口。 */
  jobType: BackgroundJobType;
  userId: string;
  serviceId: string;
  libraryId: string;
  librarySourceId: string;
  parentJobId: string | null;
  ownerUsername: string;
  serviceName: string;
  dataType: MediaType;
  requestId: string;
  clientDeviceId: string;
  scanMode: "incremental" | "full";
  status: JobStatus;
  stage: JobStage;
  processedCount: number;
  totalCount: number | null;
  discoveredCount: number;
  skippedCount: number;
  matchedCount: number | null;
  unmatchedCount: number | null;
  errorCount: number;
  currentPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** TMDB 临时不可用时，任务下一次自动恢复的时间。 */
  nextRetryAt: string | null;
  /** 当前任务已经进入延迟恢复状态的累计次数。 */
  retryCount: number;
  snapshot: Record<string, unknown>;
  controlAction: "none" | "pause" | "cancel";
  /** 最近一次可恢复安全检查点时间；终态任务清理后为空。 */
  checkpointUpdatedAt: string | null;
  /** 当前任务是否存在可供暂停/进程恢复使用的检查点。 */
  resumeSupported: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 任务真正处于扫描刮削运行状态的累计时长，不包含排队、暂停和延迟恢复等待。 */
  elapsedMs: number;
  /** 排队任务当前等待的原因；非排队任务始终为空。 */
  waitingReason: "scan_worker_capacity" | "scan_queue_order" | "service_scan_priority" | "media_probe_worker_capacity" | "worker_dispatch" | null;
  /** 当前权限范围内可以展示的阻塞任务。 */
  waitingForJobs: JobWaitTargetRecord[];
  /** 因账号隔离不能展示详情的阻塞任务数量。 */
  hiddenWaitingJobCount: number;
  /** 当前扫描任务之前尚未被领取的扫描任务数量。 */
  queueAheadCount: number;
  updatedAt: string;
}

export type LibraryScanJobStatus = "pending" | "running" | "paused" | "completed" | "completed_with_errors" | "partial_failed" | "failed" | "cancelled";

/** 一个媒体库扫描请求的父任务，负责并行来源子任务的控制和汇总。 */
export interface LibraryScanJobRecord {
  id: string;
  userId: string;
  libraryId: string;
  requestedByUserId: string;
  requestId: string;
  clientDeviceId: string;
  scanMode: "incremental" | "full";
  status: LibraryScanJobStatus;
  controlAction: "none" | "pause" | "cancel";
  sourceCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  cancelledSourceCount: number;
  processedCount: number;
  discoveredCount: number;
  errorCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  sourceJobs: ScanJobRecord[];
}

/** 媒体库级扫描或视频规格分析定时计划。 */
export interface ScanScheduleRecord {
  id: string;
  userId: string;
  libraryId: string;
  /** media_probe 表示独立 ffprobe 规格任务。 */
  scanMode: "incremental" | "full" | "media_probe";
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezoneOffsetMinutes: number;
  /** 是否启用每天重复的禁扫时间段。 */
  quietPeriodEnabled: boolean;
  /** 禁扫时间段开始时间，按计划保存的固定时区解释。 */
  quietStartTime: string | null;
  /** 禁扫时间段结束时间，允许小于开始时间以表示跨零点。 */
  quietEndTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 视频规格后台任务中的失败文件，只返回脱敏后的文件名和错误分类。 */
export interface MediaProbeFailureRecord {
  sourceFileId: string;
  fileName: string;
  errorCode: string;
  errorMessage: string;
}

export interface SourceFileRecord {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  /** 文件所属的稳定媒体库来源。 */
  librarySourceId: string;
  providerResourceId: string;
  parentResourceId: string | null;
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  /** 文件所属的稳定扫描根键，用于只对完整根执行缺失对账。 */
  scanRootKey: string;
  generationId: string;
  /** 最近一次成功生成当前媒体目录结果时使用的元数据配置修订。 */
  metadataProfileRevision: number;
  /** 规则、服务元数据配置、模型和提示词共同组成的有效识别修订。 */
  recognitionRevision: string;
  locator: Record<string, unknown>;
}

export interface MediaItemRecord {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  libraryKind: MediaLibraryKind;
  mediaType: MediaType;
  itemType: string;
  /** 节目的 Jellyfin 地区分组；电影和缺少地区数据的条目为 other。 */
  regionGroup: VideoRegionGroup;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  premiereDate: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  matchState: MatchState;
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
  fileCount: number;
  /** 当前条目及其直接子项已经完成的媒体规格汇总；尚未分析时为空。 */
  mediaProbeSummary: MediaProbeSummaryRecord | null;
  ownerUsername: string;
  serviceName: string;
  /** 当前条目及其直接子项实际关联的网盘来源名称，按媒体库来源顺序排列。 */
  sourceNames: string[];
  createdAt: string;
  updatedAt: string;
}

/** 海报墙和媒体详情使用的 ffprobe 汇总信息。 */
export interface MediaProbeSummaryRecord {
  analyzedFileCount: number;
  durationMs: number;
  container: string;
  bitRate: number;
  videoCodec: string;
  width: number;
  height: number;
  videoRange: string;
  videoRangeType: string;
  audioCodec: string;
  audioChannels: number;
  audioChannelLayout: string;
  audioStreamCount: number;
  subtitleStreamCount: number;
}

export interface JobEventRecord {
  sequence: number;
  userId: string;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PluginVersionRecord {
  pluginId: string;
  version: string;
  displayName: string;
  status: "imported" | "enabled" | "disabled";
  sha256: string;
  manifest: Record<string, unknown>;
  configurationRevision: number;
  configurationState: Record<string, boolean>;
  installedPath: string;
  createdAt: string;
  updatedAt: string;
}

export type AiModelProtocol = "openai_chat_completions";
export type AiModelStatus = "enabled" | "disabled";
export type AiModelCheckStatus = "unknown" | "available" | "unavailable";

/** 管理端可见的 AI 模型配置，不包含 API Key 原文。 */
export interface AiModelRecord {
  id: string;
  displayName: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  configurationRevision: number;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
  maxConcurrency: number;
  apiKeyConfigured: boolean;
  lastCheckStatus: AiModelCheckStatus;
  lastCheckErrorCode: string | null;
  lastCheckErrorMessage: string | null;
  lastCheckLatencyMs: number | null;
  lastCheckStructuredOutput: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单次模型可用性测试的脱敏结果。 */
export interface AiModelAvailabilityResult {
  available: boolean;
  structuredOutput: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export type AiCleaningTriggerMode = "weak_only" | "weak_or_unmatched";

/** 扫描任务冻结的 AI 模型与清洗策略，不包含地址或 API Key。 */
export interface AiModelTaskSnapshot {
  modelId: string;
  configurationRevision: number;
  promptVersion: string;
  triggerMode: AiCleaningTriggerMode;
  minConfidence: number;
  /** 手动补充时跳过持久化成功缓存，确保未识别内容重新请求模型。 */
  forceRefresh?: boolean;
}

export interface AuditRecord {
  id: string;
  operatorUserId: string | null;
  operatorUsername: string | null;
  operationType: string;
  targetType: string;
  targetId: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 安全解析数据库 JSON 字段，损坏值回退为空对象。 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 安全解析数据库 JSON 数组字段，损坏值回退为空数组。 */
export function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      : [];
  } catch {
    return [];
  }
}
