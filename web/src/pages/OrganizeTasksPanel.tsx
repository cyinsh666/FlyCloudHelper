import { FolderOutput, Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import { controlServiceOrganizeJob, getServiceOrganizeTaskStats, listOrganizeTasks, type OrganizeTaskSummary } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

const PAGE_SIZE = 8;

/** 整理任务状态及识别阶段使用独立文案，不复用媒体库扫描阶段。 */
function taskStatus(task: OrganizeTaskSummary): { label: string; tone: StatusTone } {
  if (task.status === "preparing") return { label: "识别中", tone: "primary" };
  if (task.status === "queued") return { label: "排队中", tone: "warning" };
  if (task.status === "running") return { label: "整理中", tone: "primary" };
  if (task.status === "paused") return { label: "已暂停", tone: "warning" };
  if (task.status === "completed") return { label: "已完成", tone: "success" };
  if (task.status === "failed") return { label: "失败", tone: "danger" };
  return { label: "已取消", tone: "neutral" };
}

/** 已处理包含失败项，避免任务完成后进度条停在不足 100%。 */
function taskPercent(task: OrganizeTaskSummary): string {
  if (task.totalCount === null) return "识别中";
  if (task.totalCount === 0) return task.status === "completed" ? "100%" : "0%";
  return `${Math.min(100, Math.round((task.completedCount + task.failedCount) / task.totalCount * 100))}%`;
}

/** 本次任务只展示数量汇总，执行进度由任务列表的实时摘要提供。 */
function OrganizeTaskStatsPanel({ task, admin }: { task: OrganizeTaskSummary; admin: boolean }) {
  const resource = useApiResource(() => getServiceOrganizeTaskStats(task.serviceId, task.id,
    task.status === "preparing", admin), [task.serviceId, task.id, task.status === "preparing", admin]);
  // 关键变量：预览跳过项不进入执行任务，剩余数只按可整理条目计算。
  const remainingCount = task.totalCount === null ? null
    : Math.max(0, task.totalCount - task.completedCount - task.failedCount);
  const counts = resource.data ? [
    { label: "扫描目录", value: resource.data.directoryCount },
    { label: "识别条目", value: resource.data.itemCount },
    { label: "可整理", value: resource.data.readyCount },
    { label: "预览跳过", value: resource.data.skippedCount },
    { label: "预计覆盖", value: resource.data.overwriteCount },
    { label: "已完成", value: task.completedCount },
    { label: "失败", value: task.failedCount },
    { label: "剩余", value: remainingCount },
  ] : [];
  return <div className="rounded-xl border border-border bg-secondary/20 p-3">
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium">本次整理统计</p>
      <button type="button" onClick={() => void resource.refresh()} disabled={resource.loading}
        className="text-xs text-muted-foreground underline disabled:opacity-50">刷新统计</button>
    </div>
    {resource.error && <p role="alert" className="mt-2 text-xs text-destructive">{resource.error}</p>}
    {resource.loading && !resource.data && <div aria-label="整理统计加载中" className="mt-3 h-20 animate-pulse rounded bg-muted" />}
    {resource.data && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {counts.map((count) => <div key={count.label} className="rounded-lg border border-border bg-background/40 p-2.5">
        <p className="text-xs text-muted-foreground">{count.label}</p>
        <p className="mt-1 text-lg font-semibold">{count.value === null ? "识别中" : count.value.toLocaleString()}</p>
      </div>)}
    </div>}
  </div>;
}

/** 与扫描记录共用任务列表时展示整理任务的操作和进度。 */
export function OrganizeTaskDetail({ task, admin, onRefresh }: {
  task: OrganizeTaskSummary; admin: boolean; onRefresh: () => Promise<unknown>;
}) {
  const [operation, setOperation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  /** 整理任务控制完成后刷新同一个任务列表。 */
  async function control(action: "pause" | "resume" | "cancel"): Promise<void> {
    if (operation) return;
    setOperation(action);
    setMessage(null);
    try {
      await controlServiceOrganizeJob(task.serviceId, task.id, action, admin);
      await onRefresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作整理任务失败"); }
    finally { setOperation(null); }
  }

  return <Panel className="p-4 sm:p-4 xl:h-[calc(100vh-14rem)] xl:min-h-[560px] xl:max-h-[720px] xl:overflow-y-auto"
    title="任务详情" description={`${task.serviceName} · 影片整理 · 任务 ${task.id.slice(0, 8)}`}>
    <div className="rounded-xl border border-primary/25 bg-primary/8 p-4">
      <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><FolderOutput className="size-4" /><p className="font-medium">影片整理</p></div>
        <StatusPill tone={taskStatus(task).tone}>{taskStatus(task).label}</StatusPill></div>
      <p className="mt-3 text-sm">{task.totalCount === null ? "正在扫描与识别来源文件" :
        task.totalCount === 0 && task.status === "completed" ? "本次没有可整理的内容" :
          `已完成 ${task.completedCount} · 失败 ${task.failedCount} · 总计 ${task.totalCount} · ${taskPercent(task)}`}</p>
      {task.totalCount !== 0 && <div className="mt-3"><ProgressMeter value={task.completedCount + task.failedCount} total={task.totalCount} /></div>}
      {task.error && <p role="alert" className="mt-3 text-sm text-destructive">{task.error}</p>}
      {message && <p role="alert" className="mt-3 text-sm text-destructive">{message}</p>}
      {task.status === "failed" && task.nextRetryAt &&
        <p className="mt-2 text-xs text-muted-foreground">临时故障将在 {new Date(task.nextRetryAt).toLocaleString("zh-CN")} 自动继续（第 {(task.autoRetryCount ?? 0) + 1}/3 次）</p>}
      {task.status === "failed" && !task.nextRetryAt && task.autoRetryCount === 3 &&
        <p className="mt-2 text-xs text-muted-foreground">已自动继续 3 次，请检查失败原因后手动继续或取消。</p>}
      <p className="mt-3 text-xs text-muted-foreground">创建时间：{new Date(task.createdAt).toLocaleString("zh-CN")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <SecondaryButton aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
          {detailsOpen ? "收起整理详情" : "查看整理详情"}
        </SecondaryButton>
        {["queued", "running"].includes(task.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control("pause")}><Pause className="size-4" />暂停</SecondaryButton>}
        {["paused", "failed"].includes(task.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control("resume")}><Play className="size-4" />继续</SecondaryButton>}
        {["queued", "running", "paused", "failed"].includes(task.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control("cancel")}><Square className="size-4" />取消</SecondaryButton>}
      </div>
    </div>
    {detailsOpen && <div className="mt-4"><OrganizeTaskStatsPanel key={task.id} task={task} admin={admin} /></div>}
  </Panel>;
}

/** 整理任务在扫描记录旁使用相同尺寸的列表卡片。 */
export function OrganizeTaskListCard({ task, selected, onSelect }: {
  task: OrganizeTaskSummary; selected: boolean; onSelect: () => void;
}) {
  return <li><button type="button" aria-pressed={selected} onClick={onSelect}
    className={`w-full rounded-xl border bg-secondary/40 px-3 py-2.5 text-left ${selected ? "border-foreground/45" : "border-border hover:border-foreground/25"}`}>
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{task.serviceName}</span>
      <StatusPill tone={taskStatus(task).tone}>{taskStatus(task).label}</StatusPill></div>
    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">影片整理 · {task.totalCount === null ? "识别来源文件" :
      task.totalCount === 0 && task.status === "completed" ? "本次没有可整理的内容" :
        `已处理 ${task.completedCount + task.failedCount}/${task.totalCount} · ${taskPercent(task)}`}</p>
    <p className="mt-1 text-[11px] text-muted-foreground">创建时间 {new Date(task.createdAt).toLocaleString("zh-CN")}</p>
    {task.totalCount !== 0 && <div className="mt-1.5"><ProgressMeter value={task.completedCount + task.failedCount} total={task.totalCount} /></div>}
  </button></li>;
}

/** 后台任务页中的服务级影片整理列表与进度；不读取文件级任务流水。 */
export function OrganizeTasksPanel({ admin, statusFilter }: { admin: boolean; statusFilter: string }) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [detailsTaskId, setDetailsTaskId] = useState<string | null>(null);
  const resource = useApiResource(() => listOrganizeTasks(admin, {
    status: statusFilter, limit: PAGE_SIZE, offset,
  }), [admin, statusFilter, offset]);
  const items = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  /** 页面可见时读取当前执行数量，离开页面后停止轮询。 */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void resource.refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [resource.refresh]);

  /** 切换筛选时从第一页展示，避免沿用旧页码出现空列表。 */
  useEffect(() => { setOffset(0); setSelectedId(null); }, [admin, statusFilter]);

  /** 历史任务被删除或筛选结果减少时返回最后一个有效页。 */
  useEffect(() => {
    if (offset < total) return;
    setOffset(Math.max(0, (Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE));
  }, [offset, total]);

  /** 复用整理页已有的暂停、继续和取消接口。 */
  async function control(task: OrganizeTaskSummary, action: "pause" | "resume" | "cancel"): Promise<void> {
    if (operation) return;
    setOperation(action);
    setMessage(null);
    try {
      await controlServiceOrganizeJob(task.serviceId, task.id, action, admin);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作整理任务失败"); }
    finally { setOperation(null); }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  return <Panel title="影片整理任务" description="识别阶段显示进行中状态；执行阶段按已处理条目和总条目计算进度。">
    {message && <p role="alert" className="mb-3 text-sm text-destructive">{message}</p>}
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    {resource.loading && !resource.data ? <div aria-label="整理任务加载中" className="animate-pulse space-y-3">
      <div className="h-16 rounded-lg bg-muted" /><div className="h-16 rounded-lg bg-muted" />
    </div> : items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">当前筛选条件下没有影片整理任务</p> :
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ul className="space-y-2">
          {items.map((task) => {
            const status = taskStatus(task);
            return <li key={task.id}>
              <button type="button" aria-pressed={selected?.id === task.id} onClick={() => setSelectedId(task.id)}
                className={`w-full rounded-xl border bg-secondary/40 p-3 text-left ${selected?.id === task.id ? "border-foreground/45" : "border-border hover:border-foreground/25"}`}>
                <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-medium">{task.serviceName}</span>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill></div>
                <p className="mt-1 text-xs text-muted-foreground">影片整理 · {task.totalCount === null ? "正在识别来源文件" :
                  task.totalCount === 0 && task.status === "completed" ? "本次没有可整理的内容" :
                    `已处理 ${task.completedCount + task.failedCount}/${task.totalCount} · ${taskPercent(task)}`}</p>
                {task.totalCount !== 0 && <div className="mt-2"><ProgressMeter value={task.completedCount + task.failedCount} total={task.totalCount} /></div>}
              </button>
            </li>;
          })}
        </ul>
        {selected && <div className="rounded-xl border border-border bg-secondary/30 p-4">
          <div className="flex items-center gap-2"><FolderOutput className="size-4" /><p className="font-medium">{selected.serviceName} · 影片整理</p></div>
          <p className="mt-2 text-sm">状态：{taskStatus(selected).label}</p>
          <p className="mt-1 text-sm">{selected.totalCount === null ? "正在扫描与识别，完成后显示文件总数" :
            selected.totalCount === 0 && selected.status === "completed" ? "本次没有可整理的内容" :
              `已完成 ${selected.completedCount} · 失败 ${selected.failedCount} · 总计 ${selected.totalCount} · ${taskPercent(selected)}`}</p>
          {selected.totalCount !== 0 && <div className="mt-3"><ProgressMeter value={selected.completedCount + selected.failedCount} total={selected.totalCount} /></div>}
          {selected.error && <p role="alert" className="mt-3 text-sm text-destructive">{selected.error}</p>}
          {selected.status === "failed" && selected.nextRetryAt &&
            <p className="mt-2 text-xs text-muted-foreground">临时故障将在 {new Date(selected.nextRetryAt).toLocaleString("zh-CN")} 自动继续（第 {(selected.autoRetryCount ?? 0) + 1}/3 次）</p>}
          {selected.status === "failed" && !selected.nextRetryAt && selected.autoRetryCount === 3 &&
            <p className="mt-2 text-xs text-muted-foreground">已自动继续 3 次，请检查失败原因后手动继续或取消。</p>}
          <p className="mt-3 text-xs text-muted-foreground">创建时间：{new Date(selected.createdAt).toLocaleString("zh-CN")}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <SecondaryButton aria-expanded={detailsTaskId === selected.id}
              onClick={() => setDetailsTaskId((id) => id === selected.id ? null : selected.id)}>
              {detailsTaskId === selected.id ? "收起整理详情" : "查看整理详情"}
            </SecondaryButton>
            {["queued", "running"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "pause")}><Pause className="size-4" />暂停</SecondaryButton>}
            {["paused", "failed"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "resume")}><Play className="size-4" />继续</SecondaryButton>}
            {["queued", "running", "paused", "failed"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "cancel")}><Square className="size-4" />取消</SecondaryButton>}
          </div>
          {detailsTaskId === selected.id && <div className="mt-4"><OrganizeTaskStatsPanel key={selected.id}
            task={selected} admin={admin} /></div>}
        </div>}
      </div>}
    {total > PAGE_SIZE && <div className="mt-4 flex items-center justify-center gap-3 border-t border-border/70 pt-3">
      <SecondaryButton disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</SecondaryButton>
      <span className="text-xs text-muted-foreground">{currentPage} / {pageCount}</span>
      <SecondaryButton disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</SecondaryButton>
    </div>}
  </Panel>;
}
