import { listJobs, listOrganizeTasks, type JobStatus, type OrganizeTaskSummary, type ScanJob } from "@/lib/api";

/** 任务列表按两种来源各自取足当前页之前的记录，再由页面统一按时间排序。 */
export async function loadJobRecordPrefix(input: {
  admin: boolean;
  status: string;
  jobType: "all" | "scan" | "media_probe" | "organize";
  count: number;
}): Promise<{ scanItems: ScanJob[]; scanTotal: number; organizeItems: OrganizeTaskSummary[]; organizeTotal: number }> {
  const scanItems: ScanJob[] = [];
  const organizeItems: OrganizeTaskSummary[] = [];
  let scanTotal = 0;
  let organizeTotal = 0;
  /** 分页读取扫描记录；聚合组由服务端保持完整。 */
  async function loadScanItems(): Promise<void> {
    if (input.jobType === "organize") return;
    // 关键变量：扫描接口以云聚合父任务为分页单位，返回的 items 可包含整组子任务。
    let scanGroupOffset = 0;
    while (scanGroupOffset < input.count) {
      const limit = Math.min(100, input.count - scanGroupOffset);
      const page = await listJobs(input.admin, {
        status: input.status === "all" ? undefined : input.status as JobStatus | "active",
        jobType: input.jobType === "all" ? undefined : input.jobType,
        groupParentJobs: true, limit, offset: scanGroupOffset,
      });
      scanItems.push(...page.items);
      scanTotal = page.total;
      scanGroupOffset += limit;
      if (scanGroupOffset >= scanTotal) break;
    }
  }
  /** 分页读取整理记录；状态不适用时直接返回空集合。 */
  async function loadOrganizeItems(): Promise<void> {
    if (input.jobType !== "all" && input.jobType !== "organize") return;
    // 整理任务没有等待 TMDB 恢复状态，筛选该状态时不向整理接口发无效请求。
    if (input.status !== "retry_waiting") {
      let offset = 0;
      while (offset < input.count) {
        const limit = Math.min(100, input.count - offset);
        const page = await listOrganizeTasks(input.admin, { status: input.status, limit, offset });
        organizeItems.push(...page.items);
        organizeTotal = page.total;
        offset += limit;
        if (offset >= organizeTotal) break;
      }
    }
  }
  await Promise.all([loadScanItems(), loadOrganizeItems()]);
  return { scanItems, scanTotal, organizeItems, organizeTotal };
}
