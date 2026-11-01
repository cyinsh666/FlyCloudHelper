import { Link } from "@tanstack/react-router";
import { FolderOutput, Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import { controlServiceOrganizeJob, listOrganizeTasks, type OrganizeTaskSummary } from "@/lib/api";
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

/** 后台任务页中的服务级影片整理列表与进度；不读取文件级任务流水。 */
export function OrganizeTasksPanel({ admin, statusFilter }: { admin: boolean; statusFilter: string }) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
  const detailPath = admin ? "/admin/services/$serviceId/organize" : "/app/services/$serviceId/organize";
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
                <p className="mt-1 text-xs text-muted-foreground">影片整理 · {task.totalCount === null ? "正在识别来源文件" : `已处理 ${task.completedCount + task.failedCount}/${task.totalCount}`} · {taskPercent(task)}</p>
                <div className="mt-2"><ProgressMeter value={task.completedCount + task.failedCount} total={task.totalCount} /></div>
              </button>
            </li>;
          })}
        </ul>
        {selected && <div className="rounded-xl border border-border bg-secondary/30 p-4">
          <div className="flex items-center gap-2"><FolderOutput className="size-4" /><p className="font-medium">{selected.serviceName} · 影片整理</p></div>
          <p className="mt-2 text-sm">状态：{taskStatus(selected).label}</p>
          <p className="mt-1 text-sm">{selected.totalCount === null ? "正在扫描与识别，完成后显示文件总数" :
            `已完成 ${selected.completedCount} · 失败 ${selected.failedCount} · 总计 ${selected.totalCount} · ${taskPercent(selected)}`}</p>
          <div className="mt-3"><ProgressMeter value={selected.completedCount + selected.failedCount} total={selected.totalCount} /></div>
          {selected.error && <p role="alert" className="mt-3 text-sm text-destructive">{selected.error}</p>}
          <p className="mt-3 text-xs text-muted-foreground">创建时间：{new Date(selected.createdAt).toLocaleString("zh-CN")}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to={detailPath} params={{ serviceId: selected.serviceId }}><SecondaryButton>查看整理详情</SecondaryButton></Link>
            {["queued", "running"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "pause")}><Pause className="size-4" />暂停</SecondaryButton>}
            {["paused", "failed"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "resume")}><Play className="size-4" />继续</SecondaryButton>}
            {["queued", "running", "paused", "failed"].includes(selected.status) && <SecondaryButton disabled={Boolean(operation)} onClick={() => void control(selected, "cancel")}><Square className="size-4" />取消</SecondaryButton>}
          </div>
        </div>}
      </div>}
    {total > PAGE_SIZE && <div className="mt-4 flex items-center justify-center gap-3 border-t border-border/70 pt-3">
      <SecondaryButton disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</SecondaryButton>
      <span className="text-xs text-muted-foreground">{currentPage} / {pageCount}</span>
      <SecondaryButton disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</SecondaryButton>
    </div>}
  </Panel>;
}
