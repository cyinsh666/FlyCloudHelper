import { Link } from "@tanstack/react-router";
import { FolderOutput, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ServicePathPicker } from "@/components/ServicePathPicker";
import { Panel } from "@/components/ui-kit";
import {
  controlServiceOrganizeJob, createServiceOrganizeJob, createServiceOrganizePlan,
  getServiceOrganizeAiModels, getServiceOrganizeCapabilities, getServiceOrganizeJob, getServiceOrganizePlan,
  getServiceOrganizeSchedule, listServiceOrganizeJobs, type OrganizeJob, type OrganizePlan,
  type OrganizeSchedule, type ProviderDirectory, type AvailableAiModel,
} from "@/lib/api";
import { ServiceOrganizeSchedule } from "./ServiceOrganizeSchedule";

/** 网盘服务下的独立影片整理页面；只读预览完成后才允许发起远端写操作。 */
export function ServiceOrganizePage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const [capability, setCapability] = useState<{ supported: boolean; reason: string | null } | null>(null);
  const [sources, setSources] = useState<ProviderDirectory[]>([]);
  const [targets, setTargets] = useState<ProviderDirectory[]>([]);
  const [mode, setMode] = useState<"move" | "copy">("move");
  const [unrecognizedTransferEnabled, setUnrecognizedTransferEnabled] = useState(false);
  const [unrecognizedDirectories, setUnrecognizedDirectories] = useState<ProviderDirectory[]>([]);
  const [aiAssistEnabled, setAiAssistEnabled] = useState(false);
  const [aiModelId, setAiModelId] = useState("");
  const [aiModels, setAiModels] = useState<AvailableAiModel[]>([]);
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [job, setJob] = useState<OrganizeJob | null>(null);
  const [schedule, setSchedule] = useState<OrganizeSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 首次进入时读取能力和最近任务，重启或刷新后可以继续查看执行状态。 */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all([getServiceOrganizeCapabilities(serviceId, admin), listServiceOrganizeJobs(serviceId, admin),
      getServiceOrganizeSchedule(serviceId, admin), getServiceOrganizeAiModels(serviceId, admin)])
      .then(([result, jobs, savedSchedule, models]) => {
        if (!alive) return;
        setCapability(result);
        setJob(jobs.items.find((item) => ["queued", "running", "paused"].includes(item.status)) ?? jobs.items[0] ?? null);
        setSchedule(savedSchedule);
        setSources(savedSchedule.sources);
        setTargets(savedSchedule.target ? [savedSchedule.target] : []);
        setMode(savedSchedule.mode);
        setUnrecognizedTransferEnabled(savedSchedule.unrecognizedTransferEnabled === true);
        setUnrecognizedDirectories(savedSchedule.unrecognizedDirectory ? [savedSchedule.unrecognizedDirectory] : []);
        setAiAssistEnabled(savedSchedule.aiAssistEnabled === true);
        setAiModelId(savedSchedule.aiModelId ?? "");
        setAiModels(models.items);
      }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "读取整理服务失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [serviceId, admin]);

  /** 自动任务在后台创建，页面显示时定期读取最近任务和下一次执行时间。 */
  useEffect(() => {
    if (!schedule?.enabled && !schedule?.pendingPlanId) return undefined;
    let alive = true;
    const timer = window.setInterval(() => {
      void Promise.all([getServiceOrganizeSchedule(serviceId, admin), listServiceOrganizeJobs(serviceId, admin)])
        .then(([nextSchedule, jobs]) => {
          if (!alive) return;
          setSchedule(nextSchedule);
          const latest = jobs.items.find((item) => ["queued", "running", "paused"].includes(item.status)) ?? jobs.items[0];
          if (latest) setJob(latest);
        }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "刷新定时任务失败"); });
    }, schedule.pendingPlanId ? 2500 : 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [serviceId, admin, schedule?.enabled, schedule?.pendingPlanId]);

  /** 仅在后台预览仍运行时轮询；离开页面后立即停止。 */
  useEffect(() => {
    if (!plan || plan.status !== "preparing") return undefined;
    let alive = true;
    const timer = window.setInterval(() => {
      void getServiceOrganizePlan(serviceId, plan.id, admin).then((next) => {
        if (alive) setPlan(next);
      }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "刷新预览失败"); });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [serviceId, admin, plan?.id, plan?.status]);

  /** 运行任务的进度和暂停状态使用同一份服务端持久任务。 */
  useEffect(() => {
    if (!job || !["queued", "running", "paused", "cancelled"].includes(job.status)) return undefined;
    let alive = true;
    const timer = window.setInterval(() => {
      void getServiceOrganizeJob(serviceId, job.id, admin).then((next) => {
        if (alive) setJob(next);
      }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "刷新任务失败"); });
    }, ["paused", "cancelled"].includes(job.status) ? 10_000 : 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [serviceId, admin, job?.id, job?.status]);

  /** 目录或模式改变后旧预览不再可用于执行。 */
  function invalidatePlan(): void { setPlan(null); setError(null); }

  /** 检查目录后发起后台预览。 */
  async function preview(): Promise<void> {
    if (sources.length < 1 || targets.length !== 1) { setError("请选择来源目录和一个目标目录"); return; }
    if (unrecognizedTransferEnabled && unrecognizedDirectories.length !== 1) { setError("请选择一个未识别转移目录"); return; }
    if (aiAssistEnabled && !aiModelId) { setError("请选择 AI 模型"); return; }
    setBusy(true);
    setError(null);
    try { setPlan(await createServiceOrganizePlan(serviceId, { sources, target: targets[0]!, mode,
      unrecognizedTransferEnabled, unrecognizedDirectory: unrecognizedDirectories[0] ?? null,
      aiAssistEnabled, aiModelId: aiAssistEnabled ? aiModelId : null }, admin)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "创建预览失败"); }
    finally { setBusy(false); }
  }

  /** 预览已明确列出可整理与跳过项后启动执行。 */
  async function execute(): Promise<void> {
    if (!plan || plan.status !== "ready") return;
    setBusy(true);
    setError(null);
    try { setJob(await createServiceOrganizeJob(serviceId, plan.id, admin)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "启动整理失败"); }
    finally { setBusy(false); }
  }

  /** 用户展开预览时继续读取下一批文件，不重复读取已经展示的项目。 */
  async function loadMore(): Promise<void> {
    if (!plan || plan.nextOffset === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getServiceOrganizePlan(serviceId, plan.id, admin, plan.nextOffset);
      setPlan({ ...page, items: [...plan.items, ...page.items] });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取更多预览失败"); }
    finally { setLoadingMore(false); }
  }

  /** 在当前文件完成后切换任务控制状态。 */
  async function control(action: "pause" | "resume" | "cancel"): Promise<void> {
    if (!job) return;
    setBusy(true);
    setError(null);
    try { setJob(await controlServiceOrganizeJob(serviceId, job.id, action, admin)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "任务操作失败"); }
    finally { setBusy(false); }
  }

  // 关键变量：计划中的跳过项不会参与远端写任务，页面单独展示供用户核对。
  const readyCount = plan?.readyCount ?? 0;
  const overwriteCount = plan?.overwriteCount ?? 0;
  const completedCount = job?.completedCount ?? 0;
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";
  if (loading) return <div aria-label="影片整理加载中" className="animate-pulse space-y-4"><div className="h-8 w-48 rounded bg-muted" /><Panel><div className="h-40 rounded bg-muted" /></Panel></div>;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><FolderOutput className="size-5" />影片整理</h1><p className="mt-1 text-sm text-muted-foreground">从当前网盘服务选择来源和目标，预览确认后再整理。</p></div>
      <Link to={detailPath} params={{ serviceId }}><SecondaryButton>返回服务</SecondaryButton></Link>
    </header>
    {error && <Panel><p role="alert" className="text-sm text-destructive">{error}</p></Panel>}
    {!capability?.supported ? <Panel><p className="text-sm text-muted-foreground">{capability?.reason ?? "当前服务暂不支持影片整理"}</p></Panel> : <>
      <div className="grid gap-4 lg:grid-cols-2">
        <ServicePathPicker serviceId={serviceId} admin={admin} label="来源目录" value={sources} onConfirm={async (next) => {
          if (next.length < 1 || next.length > 20) throw new Error("请选择 1 至 20 个来源目录");
          setSources(next); invalidatePlan();
        }} />
        <ServicePathPicker serviceId={serviceId} admin={admin} label="目标目录" value={targets} onConfirm={async (next) => {
          if (next.length !== 1) throw new Error("目标只能选择一个目录");
          setTargets(next); invalidatePlan();
        }} />
      </div>
      <Panel title="整理方式" description="先用规则和 TMDB 识别；开启 AI 后只让未识别文件再识别一次。">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-2"><input type="radio" checked={mode === "move"} onChange={() => { setMode("move"); invalidatePlan(); }} />移动（默认）</label>
          <label className="flex cursor-pointer items-center gap-2"><input type="radio" checked={mode === "copy"} onChange={() => { setMode("copy"); invalidatePlan(); }} />复制</label>
          <PrimaryButton onClick={() => void preview()} disabled={busy || plan?.status === "preparing"}>生成识别预览</PrimaryButton>
        </div>
      </Panel>
      <Panel title="未识别内容" description="识别完成后可将仍未识别的内容移动到独立目录。纯未识别文件夹会整夹移动；混合文件夹只移动未识别视频并保留原目录层级。目标同名时跳过。">
        <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={unrecognizedTransferEnabled}
          onChange={(event) => { setUnrecognizedTransferEnabled(event.target.checked); invalidatePlan(); }} />未识别自动转移</label>
        {unrecognizedTransferEnabled && <div className="mt-3"><ServicePathPicker serviceId={serviceId} admin={admin} label="未识别转移目录"
          value={unrecognizedDirectories} onConfirm={async (next) => {
            if (next.length !== 1) throw new Error("未识别转移目录只能选择一个");
            setUnrecognizedDirectories(next); invalidatePlan();
          }} /></div>}
      </Panel>
      <Panel title="AI 辅助识别" description="只处理规则未能完整识别的内容；模型失败的条目继续按未识别处理，不影响已识别影片。">
        <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={aiAssistEnabled}
          onChange={(event) => { setAiAssistEnabled(event.target.checked); invalidatePlan(); }} />启用 AI 辅助识别</label>
        {aiAssistEnabled && <label className="mt-3 block text-xs text-muted-foreground">AI 模型
          <select className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" value={aiModelId}
            onChange={(event) => { setAiModelId(event.target.value); invalidatePlan(); }}>
            <option value="">请选择模型</option>
            {aiModels.map((model) => <option key={model.id} value={model.id}>
              {model.displayName}{model.available ? "" : "（尚未验证连接）"}</option>)}
          </select>
        </label>}
      </Panel>
      {schedule && <ServiceOrganizeSchedule key={serviceId} serviceId={serviceId} admin={admin} schedule={schedule}
        sources={sources} target={targets[0] ?? null} mode={mode}
        unrecognizedTransferEnabled={unrecognizedTransferEnabled} unrecognizedDirectory={unrecognizedDirectories[0] ?? null}
        aiAssistEnabled={aiAssistEnabled} aiModelId={aiModelId}
        activeJob={Boolean(job && ["queued", "running", "paused"].includes(job.status))} onSaved={setSchedule} />}
      {plan && <Panel title="识别预览">
        {plan.status === "preparing" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在扫描目录并匹配影片…</p>}
        {plan.status === "failed" && <p role="alert" className="text-sm text-destructive">{plan.error}</p>}
        {plan.status === "ready" && <>
          <p className="text-sm">已扫描 {plan.directoryCount} 个目录，{readyCount} 项可处理，{plan.itemCount - readyCount} 项跳过，{overwriteCount} 个整理目标将被覆盖。</p>
          {Boolean(plan.aiFailureCount) && <p className="mt-1 text-xs text-amber-600">{plan.aiFailureCount} 个条目的 AI 请求失败，已按未识别内容处理。</p>}
          <p className="mt-1 text-xs text-muted-foreground">普通整理遵循所选移动或复制模式；未识别项始终移动，目标同名时跳过。移动后仅删除已空的来源目录。</p>
          <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-border">
            {plan.items.map((item, index) => <div key={`${item.sourceId}-${index}`} className="border-b border-border px-3 py-2 text-xs last:border-b-0">
              <p className="break-all font-medium">{item.sourcePath}</p>
              <p className={item.status === "ready" ? "mt-1 break-all text-muted-foreground" : "mt-1 text-destructive"}>
                {item.status === "ready" ? `${item.action === "unrecognized" ? "未识别转移" : "整理"} → ${[...item.targetParts, item.targetName].join("/")}` : `跳过：${item.reason}`}
              </p>
            </div>)}
          </div>
          {plan.nextOffset !== null && <div className="mt-3"><SecondaryButton disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "读取中…" : "加载更多预览"}</SecondaryButton></div>}
          <div className="mt-4"><PrimaryButton onClick={() => void execute()} disabled={busy || readyCount === 0 || Boolean(job && ["queued", "running", "paused"].includes(job.status))}>开始整理</PrimaryButton></div>
        </>}
      </Panel>}
      {job && <Panel title="整理任务">
        <p className="text-sm">状态：{{ queued: "等待中", running: "整理中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" }[job.status]} · {job.status === "completed" && job.itemCount === 0 ? "本次没有可整理的内容" : `已完成 ${completedCount}/${job.itemCount}`}</p>
        {job.error && <p role="alert" className="mt-2 text-sm text-destructive">{job.error}</p>}
        {job.status === "failed" && job.nextRetryAt &&
          <p className="mt-2 text-xs text-muted-foreground">临时故障将在 {new Date(job.nextRetryAt).toLocaleString("zh-CN")} 自动继续（第 {(job.autoRetryCount ?? 0) + 1}/3 次）</p>}
        {job.status === "failed" && !job.nextRetryAt && job.autoRetryCount === 3 &&
          <p className="mt-2 text-xs text-muted-foreground">已自动继续 3 次，请检查失败原因后手动继续或取消。</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {["queued", "running"].includes(job.status) && <SecondaryButton disabled={busy} onClick={() => void control("pause")}>暂停</SecondaryButton>}
          {["paused", "failed"].includes(job.status) && <SecondaryButton disabled={busy} onClick={() => void control("resume")}>继续</SecondaryButton>}
          {["queued", "running", "paused", "failed"].includes(job.status) && <SecondaryButton disabled={busy} onClick={() => void control("cancel")}>取消</SecondaryButton>}
        </div>
      </Panel>}
    </>}
  </div>;
}
