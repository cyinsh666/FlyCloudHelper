import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FolderOutput, Plus, ScanLine, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { Panel, PosterCard, ProgressMeter, StatCard, StatusPill } from "@/components/ui-kit";
import {
  getOverview,
  getServiceOrganizeCapabilities,
  runServiceOrganizeNow,
  createScanJob,
  listJobs,
  listLibraryItems,
  listLibraries,
  listServices,
  type JobStatus,
  type CloudService,
  type MediaLibrary,
  type ServiceStatus,
} from "@/lib/api";
import { formatJobDateTime } from "@/lib/job-duration";
import { useApiResource } from "@/lib/use-api-resource";

const serviceStatusLabels: Record<ServiceStatus, string> = {
  active: "正常",
  scanning: "扫描中",
  disabled: "已停用",
  reauthorization_required: "需重新授权",
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

/** 概览服务卡片仅在网盘当前具备整理写能力时展示快捷入口。 */
function OverviewServiceCard({ service }: { service: CloudService }) {
  const [organizeSupported, setOrganizeSupported] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [organizeMessage, setOrganizeMessage] = useState<{ text: string; failed: boolean } | null>(null);
  // 关键变量：同步阻止重复点击触发两份整理预览。
  const organizingRef = useRef(false);

  /** 服务连接或凭据变化时重新读取实际整理能力。 */
  useEffect(() => {
    let alive = true;
    setOrganizeSupported(false);
    void getServiceOrganizeCapabilities(service.id).then((result) => {
      if (alive) setOrganizeSupported(result.supported);
    }).catch(() => { if (alive) setOrganizeSupported(false); });
    return () => { alive = false; };
  }, [service.id, service.status, service.connectionStatus, service.credentialRevision, service.connectionAuthMode]);

  /** 从概览服务卡片调用已保存配置的一次性整理任务。 */
  async function triggerOrganize(): Promise<void> {
    if (organizingRef.current) return;
    organizingRef.current = true;
    setOrganizing(true);
    setOrganizeMessage(null);
    try {
      await runServiceOrganizeNow(service.id);
      setOrganizeMessage({ text: "已开始识别来源文件，完成后自动整理", failed: false });
    } catch (error) {
      setOrganizeMessage({ text: error instanceof Error ? error.message : "启动整理失败", failed: true });
    } finally {
      organizingRef.current = false;
      setOrganizing(false);
    }
  }

  return <div className="rounded-xl border border-border bg-secondary/40 p-4">
    <div className="flex items-start justify-between gap-3">
      <p className="truncate text-sm font-medium">{service.displayName}</p>
      <StatusPill tone={service.status === "active" ? "success" : "warning"}>{serviceStatusLabels[service.status]}</StatusPill>
    </div>
    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{service.providerType} · {service.id}</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span>连接 r{service.credentialRevision}</span>
      <div className="flex flex-wrap items-center gap-3">
        {organizeSupported && <button type="button" onClick={() => void triggerOrganize()} disabled={organizing}
          className="inline-flex items-center gap-1 text-primary-soft disabled:cursor-not-allowed disabled:opacity-40">
          <FolderOutput className="size-3.5" />{organizing ? "启动中…" : "整理"}
        </button>}
        <Link to="/app/services/$serviceId" params={{ serviceId: service.id }} className="text-primary-soft">服务设置</Link>
      </div>
    </div>
    {organizeMessage && <p role={organizeMessage.failed ? "alert" : "status"}
      className={`mt-2 text-xs ${organizeMessage.failed ? "text-destructive" : "text-muted-foreground"}`}>
      {organizeMessage.text}
    </p>}
  </div>;
}

/** 概览媒体库卡片直接创建增量扫描，并保留服务端返回的错误提示。 */
function OverviewLibraryCard({ library }: { library: MediaLibrary }) {
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; failed: boolean } | null>(null);
  // 关键变量：请求发出时同步占位，防止重复点击。
  const creatingRef = useRef(false);
  const canScan = library.libraryKind === "legacy_single_source" || library.libraryKind === "cloud_aggregate_video";

  /** 使用媒体库设置页相同的增量扫描接口，路径和任务互斥交给服务端核验。 */
  async function triggerIncrementalScan(): Promise<void> {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setFeedback(null);
    try {
      const job = await createScanJob(library.id, "incremental");
      setFeedback({ message: `增量扫描任务已创建：${job.id}`, failed: false });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : "创建增量扫描任务失败", failed: true });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return <div className="rounded-xl border border-border bg-secondary/40 p-4">
    <div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-medium">{library.displayName}</p><StatusPill>{library.dataType === "music" ? "音乐" : "影视"}</StatusPill></div>
    {library.description && <p className="mt-1 truncate text-xs text-muted-foreground" title={library.description}>{library.description}</p>}
    <p className="mt-1 text-[11px] text-muted-foreground">来源：{library.sourceServiceName} · 条目 {library.itemCount.toLocaleString()}</p>
    {canScan && <div className="mt-3 flex justify-end border-t border-border/70 pt-3">
      <button type="button" onClick={() => void triggerIncrementalScan()} disabled={creating || library.status !== "active"}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">
        <ScanLine className="size-3.5" />{creating ? "创建中…" : "增量扫描"}
      </button>
    </div>}
    {feedback && <p role={feedback.failed ? "alert" : "status"} className={`mt-2 break-all text-xs ${feedback.failed ? "text-destructive" : "text-muted-foreground"}`}>{feedback.message}</p>}
  </div>;
}

/** 普通用户个人概览页面。 */
export function OverviewPage() {
  const resource = useApiResource(async () => {
    const [overview, services, libraries, jobs] = await Promise.all([
      getOverview(),
      listServices(),
      listLibraries(),
      listJobs(),
    ]);
    const recentCatalogs = await Promise.all(libraries.items.slice(0, 4).map((library) => (
      listLibraryItems(library.id, { limit: 6 }).catch(() => ({ items: [], total: 0, catalogVersion: 0 }))
    )));
    return { overview, services: services.items, libraries: libraries.items, jobs: jobs.items, recentItems: recentCatalogs.flatMap((item) => item.items).slice(0, 6) };
  }, []);

  if (!resource.data) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取个人概览…"}</div></Panel>;
  }

  const { overview, services, libraries, jobs, recentItems } = resource.data;
  const abnormalServices = services.filter((service) => service.status !== "active" || service.connectionStatus !== "valid");

  return (
    <>
      <PageHeader
        title="个人概览"
        actions={
          <Link to="/app/services/new">
            <PrimaryButton><Plus className="size-4" /> 创建云端服务</PrimaryButton>
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="云端服务" value={String(overview.serviceCount)} hint={`${services.filter((item) => item.status === "active").length} 个连接正常`} tone="primary" />
        <StatCard label="媒体总数" value={overview.mediaCount.toLocaleString()} hint="当前账户全部媒体" tone="info" />
        <StatCard label="运行中任务" value={String(overview.activeJobCount)} hint={`失败 ${overview.failedJobCount}`} tone="warning" />
        <StatCard label="待确认条目" value={overview.needsReviewCount.toLocaleString()} hint="等待人工确认元数据" tone="muted" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="异常提醒" description="需要用户处理的服务和任务">
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/8 p-4">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm">{abnormalServices.length > 0 ? `${abnormalServices.length} 个服务需要处理` : "暂无本人服务异常"}</p>
              <p className="mt-1 text-xs text-muted-foreground">失败任务 {overview.failedJobCount} 个。</p>
            </div>
          </div>
        </Panel>

        <Panel
          title="最近任务"
          description="任务状态来自服务端，刷新页面可获取最新进度"
          className="xl:col-span-2"
          action={<Link to="/app/jobs" className="inline-flex items-center gap-1 text-xs text-primary-soft">全部任务 <ArrowUpRight className="size-3.5" /></Link>}
        >
          <ul className="divide-y divide-border">
            {jobs.slice(0, 3).map((job) => (
              <li key={job.id} className="py-3.5 first:pt-0 last:pb-0">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.serviceName}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{job.id} · {job.jobType === "media_probe" ? "视频规格分析" : `${job.scanMode === "full" ? "全量" : "增量"}扫描刮削`} · {job.stage}</p>
                  </div>
                  <StatusPill tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : job.status === "retry_waiting" || job.status === "paused" || job.status === "queued" ? "warning" : "primary"}>{job.status === "retry_waiting" && job.jobType === "media_probe" ? "等待重试" : jobStatusLabels[job.status]}</StatusPill>
                </div>
                <div className="mt-1.5 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                  <span>开始时间：{formatJobDateTime(job.startedAt)}</span>
                  <span>结束时间：{formatJobDateTime(job.finishedAt)}</span>
                </div>
                <div className="mt-2.5 flex items-center gap-3">
                  <ProgressMeter value={job.processedCount} total={job.totalCount} />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">已处理 {job.processedCount.toLocaleString()} 项</span>
                </div>
              </li>
            ))}
            {jobs.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">还没有后台任务</li>}
          </ul>
        </Panel>
      </div>

      <Panel title="我的服务" className="mt-4" action={<Link to="/app/services" className="inline-flex items-center gap-1 text-xs text-primary-soft">管理服务 <ArrowUpRight className="size-3.5" /></Link>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((service) => <OverviewServiceCard key={service.id} service={service} />)}
        </div>
      </Panel>

      <Panel title="我的媒体库" className="mt-4" action={<Link to="/app/catalog" className="inline-flex items-center gap-1 text-xs text-primary-soft">管理媒体库 <ArrowUpRight className="size-3.5" /></Link>}>
        <div className="grid gap-3 sm:grid-cols-2">{libraries.map((library) => <OverviewLibraryCard key={library.id} library={library} />)}</div>
      </Panel>

      <Panel title="最近入库" description="只展示服务端媒体目录，不提供播放与下载" className="mt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {recentItems.map((item) => <PosterCard key={item.id} item={item} />)}
          {recentItems.length === 0 && <p className="col-span-full py-8 text-center text-sm text-muted-foreground">完成扫描后，媒体会出现在这里。</p>}
        </div>
      </Panel>
    </>
  );
}
