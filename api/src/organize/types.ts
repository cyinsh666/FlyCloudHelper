/** 服务级影片整理的公共任务模型，不依赖媒体库或具体网盘接口。 */
export type OrganizeMode = "move" | "copy";

export interface OrganizeDirectory {
  resourceId: string;
  displayPath: string;
}

export interface OrganizePlanItem {
  /** 未识别项可整夹转移；旧预览没有该字段时仍按普通文件处理。 */
  isDirectory?: boolean;
  /** 整夹预览时的完整子项签名，执行前复查目录内容没有变化。 */
  containedEntries?: string[];
  /** 未识别项始终移动，普通整理仍遵循计划的复制或移动模式。 */
  action?: "organize" | "unrecognized";
  sourceId: string;
  parentId: string;
  sourcePath: string;
  sourceName: string;
  size: number;
  modifiedAt: string | null;
  targetParts: string[];
  targetName: string;
  category: string;
  tmdbId: number | null;
  /** 预览时目标已存在同名文件；执行时仍须重新核验。 */
  willOverwrite: boolean;
  status: "ready" | "skipped";
  reason: string | null;
}

export interface OrganizePlan {
  id: string;
  userId: string;
  serviceId: string;
  credentialRevision: number;
  mode: OrganizeMode;
  sourceDirectories: OrganizeDirectory[];
  targetDirectory: OrganizeDirectory;
  /** 可选的未识别目录与 AI 模型保存在预览快照中，旧计划默认关闭。 */
  unrecognizedTransferEnabled?: boolean;
  unrecognizedDirectory?: OrganizeDirectory | null;
  aiAssistEnabled?: boolean;
  aiModelId?: string | null;
  /** 模型请求失败时仍继续规则结果和未识别转移，供页面提示。 */
  aiFailureCount?: number;
  scannedDirectories: OrganizeDirectory[];
  status: "preparing" | "ready" | "failed";
  error: string | null;
  items: OrganizePlanItem[];
  createdAt: string;
  updatedAt: string;
}

/** 每个文件或未识别文件夹的持久阶段用于从上游任务成功、进程退出或网络错误中恢复。 */
export interface OrganizeJobItem {
  index: number;
  stage: "pending" | "staged" | "backed_up" | "placed" | "renamed" | "completed" | "failed";
  sourceId: string;
  /** 暂存请求已发出；没有确认结果时禁止再次复制同一来源。 */
  stageRequested: boolean;
  stagedId: string | null;
  replacedId: string | null;
  targetParentId: string | null;
  stageParentId: string | null;
  backupParentId: string | null;
  /** 已提交给网盘、尚未确认完成的异步写任务。 */
  pendingTaskId: string | null;
  /** 光鸭按 LitePan 执行链路直接提交到目标；旧任务没有该字段，继续走原流程。 */
  directOperation?: "move" | "copy";
  /** 同一次远端批量操作的文件共用标识，暂停时也要完成这一组的改名。 */
  directBatchId?: string;
  /** 删除旧目标、提交传输、改名三个阶段可在进程重启后继续。 */
  directPhase?: "delete" | "transfer" | "rename";
  /** 异步任务明确失败后最多逐项重试一次。 */
  directRetryCount?: number;
  /** 只有上游明确报告删除失败时才允许重试，避免网络未知状态下重复删除。 */
  directDeleteFailed?: boolean;
  error: string | null;
}

export interface OrganizeJob {
  id: string;
  planId: string;
  serviceId: string;
  userId: string;
  credentialRevision: number;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  workDirectoryId: string | null;
  stageDirectoryId: string | null;
  backupDirectoryId: string | null;
  items: OrganizeJobItem[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 后台任务页使用的精简整理任务，不传文件级流水和网盘凭据。 */
export interface OrganizeTaskSummary {
  id: string;
  serviceId: string;
  status: "preparing" | OrganizeJob["status"];
  completedCount: number;
  failedCount: number;
  totalCount: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
