import { useCallback, useEffect, useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { ContentSourceLibraryCategoriesEditor } from "@/components/ContentSourceLibraryCategoriesEditor";
import { ContentSourceAutoSyncSettings } from "@/components/ContentSourceAutoSyncSettings";
import { ContentSourceDiagnostics } from "@/components/ContentSourceDiagnostics";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { getContentSourceLibrary, syncContentSourceLibrary, updateContentSourceStatus } from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

const syncStatusLabels = {
  idle: "待同步",
  queued: "等待同步",
  running: "同步中",
  completed: "同步完成",
  failed: "同步失败",
} as const;

type ContentSourceDialog = "sync" | "categories" | "auto-sync" | "diagnostics";

/** 在线库主页面只展示摘要，详细同步、分类和设置一次打开一个弹窗。 */
export function ContentSourceLibraryPanel({ libraryId, admin, onChanged }: {
  libraryId: string; admin: boolean; onChanged: () => Promise<void>;
}) {
  const resource = useApiResource(() => getContentSourceLibrary(libraryId, admin), [libraryId, admin]);
  const [pageCount, setPageCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [updatingSource, setUpdatingSource] = useState(false);
  const [activeDialog, setActiveDialog] = useState<ContentSourceDialog | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  // 关键变量：仅手动刷新或操作完成时更新子面板，不随同步轮询重复读取。
  const [detailsRefreshVersion, setDetailsRefreshVersion] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 关键变量：防止同步按钮在 React 重绘前重复提交。
  const submittingRef = useRef(false);
  // 关键变量：同步拦截弹窗切换和关闭，不能等待 React 重绘才保护在途操作。
  const activeDialogRef = useRef<ContentSourceDialog | null>(null);
  const detailsBusyRef = useRef(false);
  const previousStatus = useRef<string | null>(null);
  const data = resource.data;
  // 关键变量：有未完成批次时重试原范围，不能按新的页数扩大入库范围。
  const pendingBatch = data?.sync.pendingBatch;
  const running = data?.sync.status === "queued" || data?.sync.status === "running";
  const sourceEnabled = data?.source.status === "active" && data.source.pluginStatus === "enabled";

  /** 子设置和分类读取、保存都同步登记忙状态，保护背景、Esc 和关闭按钮。 */
  const changeDetailsBusy = useCallback((busy: boolean): void => {
    detailsBusyRef.current = busy;
    setDetailsBusy(busy);
  }, []);

  /** 打开一个详情弹窗，后台同步运行不妨碍查看详情和其他设置。 */
  function openDialog(dialog: ContentSourceDialog): void {
    if (!data || submittingRef.current || detailsBusyRef.current || activeDialogRef.current !== null) return;
    if (dialog === "categories" && (resource.loading || running || !sourceEnabled)) return;
    activeDialogRef.current = dialog;
    setActiveDialog(dialog);
  }

  /** 关闭详情只丢弃未保存草稿，实际请求未结束时保持弹窗。 */
  const closeDialog = useCallback((): void => {
    if (submittingRef.current || detailsBusyRef.current) return;
    activeDialogRef.current = null;
    setActiveDialog(null);
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void resource.refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [running, resource.refresh]);

  useEffect(() => {
    if (!data) return;
    const current = data.sync.status;
    if ((previousStatus.current === null || ["queued", "running"].includes(previousStatus.current)) && ["completed", "failed"].includes(current)) {
      void onChanged();
      if (previousStatus.current !== null) setDetailsRefreshVersion((version) => version + 1);
    }
    previousStatus.current = current;
  }, [data?.sync.status, onChanged]);

  /** 重试未完成批次或读取下一批分页，刷新已有内容时不修改原批次范围。 */
  async function continueSync(mode: "next" | "refresh"): Promise<void> {
    if (submittingRef.current || detailsBusyRef.current || activeDialogRef.current !== "sync" || running || !sourceEnabled) return;
    if (mode === "next" && !pendingBatch && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20)) {
      setMessage("每个分类的同步页数必须为 1 至 20");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(mode === "next" && pendingBatch ? "正在重试未完成批次…" : "正在启动内容同步…");
    try {
      await syncContentSourceLibrary(libraryId, mode === "refresh" || pendingBatch ? { mode } : { mode, pageCount }, admin);
      await resource.refresh();
      setMessage("同步已启动，页面会自动刷新状态。");
      setNotice("同步已启动");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动同步失败");
      setNotice("启动同步失败，可在同步详情中查看原因");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** 单独启停当前库的源配置，管理员使用其实际所有者对应的管理接口。 */
  async function toggleSource(): Promise<void> {
    if (!data || submittingRef.current || detailsBusyRef.current || running || activeDialogRef.current !== null) return;
    submittingRef.current = true;
    setUpdatingSource(true);
    try {
      const status = data.source.status === "active" ? "disabled" : "active";
      await updateContentSourceStatus(data.source.id, status, admin);
      await resource.refresh();
      await onChanged();
      setDetailsRefreshVersion((version) => version + 1);
      setNotice(status === "active" ? "配置已启用" : "配置已停用，目录和播放记录保留");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容源配置状态修改失败");
      setNotice("配置状态修改失败，可在同步详情中查看原因");
    } finally {
      submittingRef.current = false;
      setUpdatingSource(false);
    }
  }

  /** 分类读取与保存复用同步提交锁，避免和启停、同步请求相互覆盖。 */
  function beginCategoriesOperation(): boolean {
    if (submittingRef.current || detailsBusyRef.current || resource.loading || activeDialogRef.current !== "categories" || running || !sourceEnabled) return false;
    submittingRef.current = true;
    changeDetailsBusy(true);
    return true;
  }

  /** 分类操作结束后释放共享提交锁。 */
  function endCategoriesOperation(): void {
    submittingRef.current = false;
    changeDetailsBusy(false);
  }

  /** 分类保存后刷新状态和库摘要，客户端按新的分类选择动态浏览。 */
  async function finishCategoriesSave(): Promise<void> {
    await resource.refresh();
    await onChanged();
    setDetailsRefreshVersion((version) => version + 1);
    // 保存完成后主动关闭；操作锁仍由编辑器 finally 无条件释放。
    activeDialogRef.current = null;
    setActiveDialog(null);
    setNotice("分类已保存");
  }

  /** 一并读取同步状态、自动计划和已有诊断记录，不主动请求源站。 */
  async function refreshStatus(): Promise<void> {
    if (resource.loading || submittingRef.current || detailsBusyRef.current || activeDialogRef.current !== null) return;
    await resource.refresh();
    setDetailsRefreshVersion((version) => version + 1);
  }

  return <Panel title="在线内容源" className="mb-4" action={<SecondaryButton disabled={resource.loading || updatingSource || submitting || detailsBusy || activeDialog !== null} onClick={() => void refreshStatus()}>刷新状态</SecondaryButton>}>
    {!data && !resource.error && <div aria-label="内容源配置加载中" className="animate-pulse space-y-3"><div className="h-5 w-48 rounded bg-muted" /><div className="h-14 rounded bg-muted" /><div className="h-9 w-32 rounded bg-muted" /></div>}
    {resource.error && <p role="alert" className="mb-3 text-xs text-destructive">内容源状态读取失败，请刷新重试。</p>}
    {data && <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm">{data.source.displayName}</p><p className="mt-1 text-xs text-muted-foreground">{data.source.pluginId} · {data.source.pluginVersion}</p></div><div className="flex items-center gap-2"><StatusPill>{sourceEnabled ? "配置已启用" : "内容源已停用"}</StatusPill><SecondaryButton disabled={updatingSource || submitting || running || detailsBusy || activeDialog !== null} onClick={() => void toggleSource()}>{updatingSource ? "正在保存…" : data.source.status === "active" ? "停用此配置" : "启用此配置"}</SecondaryButton></div></div>
      <div className="flex flex-wrap items-center gap-3"><StatusPill>{syncStatusLabels[data.sync.status]}</StatusPill><span className="text-xs text-muted-foreground">本轮处理 {data.sync.processedCount} 个条目 · 已选 {data.configuration.categoryIds.length} 个分类</span>{data.sync.lastError && <span className="text-xs text-destructive">同步失败，可查看详情</span>}</div>
      <div className="flex flex-wrap gap-2"><SecondaryButton disabled={updatingSource || submitting || detailsBusy || activeDialog !== null} onClick={() => openDialog("sync")}>手动同步 / 详情</SecondaryButton><SecondaryButton disabled={resource.loading || updatingSource || submitting || detailsBusy || activeDialog !== null || running || !sourceEnabled} onClick={() => openDialog("categories")}>修改分类</SecondaryButton></div>
      <ContentSourceAutoSyncSettings key={`${libraryId}:${admin}:auto-sync`} state={{ libraryId, admin, disabled: updatingSource || submitting || (activeDialog !== null && activeDialog !== "auto-sync"), refreshVersion: detailsRefreshVersion, open: activeDialog === "auto-sync", onOpen: () => openDialog("auto-sync"), onClose: closeDialog, onBusyChange: changeDetailsBusy }} />
      <ContentSourceDiagnostics key={`${libraryId}:${admin}:diagnostics`} state={{ libraryId, admin, disabled: updatingSource || submitting || (activeDialog !== null && activeDialog !== "diagnostics") || !sourceEnabled, refreshVersion: detailsRefreshVersion, open: activeDialog === "diagnostics", onOpen: () => openDialog("diagnostics"), onClose: closeDialog, onBusyChange: changeDetailsBusy }} />
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {activeDialog === "sync" && <ContentSourceSettingsDialog state={{ title: "手动同步与目录详情", busy: submitting, onClose: closeDialog, children: <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3"><StatusPill>{syncStatusLabels[data.sync.status]}</StatusPill><span className="text-xs text-muted-foreground">本轮已处理 {data.sync.processedCount} 个条目</span></div>
        {!sourceEnabled && <p className="text-xs text-muted-foreground">源插件或配置实例已停用，已有目录和播放记录保留；启用后可继续同步和播放。</p>}
        <div className="grid gap-2"><p className="text-xs text-muted-foreground">已选 {data.configuration.categoryIds.length} 个分类</p><div className="grid gap-2 sm:grid-cols-2">{data.configuration.categoryIds.map((id) => <div key={id} className="rounded-lg border border-border px-3 py-2.5"><p className="text-sm">{data.configuration.categories?.find((category) => category.id === id)?.name ?? id}</p><p className="mt-1 text-xs text-muted-foreground">{pendingBatch?.completedCategoryIds.includes(id) ? "本批次已完成" : `${pendingBatch ? "本批次进度" : "下一批起始"}：第 ${data.sync.nextPageByCategory[id] ?? 1} 页`}{pendingBatch?.endPageExclusiveByCategory[id] !== undefined && ` · 本批次至第 ${pendingBatch.endPageExclusiveByCategory[id]! - 1} 页`}</p></div>)}</div></div>
        {data.sync.lastError && <p role="alert" className="break-words text-xs text-destructive">{data.sync.lastError}</p>}
        {resource.error && <p role="alert" className="break-words text-xs text-destructive">{resource.error}</p>}
        <div className="flex flex-wrap items-end gap-3"><label><span className="text-xs text-muted-foreground">{pendingBatch ? "原批次页数（每个分类）" : "下一批页数（每个分类）"}</span><input type="number" min={1} max={20} step={1} disabled={updatingSource || submitting || running || Boolean(pendingBatch)} value={pendingBatch?.pageCount ?? pageCount} onChange={(event) => setPageCount(Number(event.target.value))} className="mt-2 block w-44 rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label><SecondaryButton disabled={updatingSource || submitting || running || !sourceEnabled} onClick={() => void continueSync("next")}>{submitting ? "正在启动…" : running ? "正在同步…" : pendingBatch ? "重试未完成批次" : "继续同步下一批"}</SecondaryButton><SecondaryButton disabled={updatingSource || submitting || running || !sourceEnabled} onClick={() => void continueSync("refresh")}>刷新已入库内容</SecondaryButton></div>
        {pendingBatch && <p className="text-xs text-muted-foreground">原批次尚未完成，重试沿用每个分类 {pendingBatch.pageCount} 页的原范围，跳过已完成的分类；完成后可继续导入下一批。</p>}
        <p className="text-xs text-muted-foreground">刷新已入库内容更新影片详情与节目新集，不扩大入库范围。手动同步下一批按整页导入，和客户端动态浏览分别记录进度，已有条目保留原 ID。</p>
        <p className="text-xs text-muted-foreground">客户端进入源分类时先返回第一页，云助手后台预取下一页，默认缓存当前页与下一页目录，缓存不含播放地址；后续分页优先复用缓存，失败可重试。目录数量随加载更新，列表按源站顺序返回。</p>
        <p className="text-xs text-muted-foreground">电影天堂和虎牙支持实时搜索当前已选分类，无需先同步；带收藏、已看等筛选的搜索使用当前已缓存或同步的目录。</p>
        {message && <p role="status" className="break-words text-xs text-muted-foreground">{message}</p>}
      </div> }} />}
      {activeDialog === "categories" && <ContentSourceSettingsDialog state={{ title: "修改导入分类", busy: detailsBusy, onClose: closeDialog, children: <ContentSourceLibraryCategoriesEditor key={`${libraryId}:${admin}`} state={{ libraryId, admin, selectedIds: data.configuration.categoryIds, selectedCategories: data.configuration.categories ?? [], disabled: running || !sourceEnabled, pendingBatch: Boolean(pendingBatch), beginOperation: beginCategoriesOperation, endOperation: endCategoriesOperation, onSaved: finishCategoriesSave, onCancel: closeDialog }} /> }} />}
    </div>}
  </Panel>;
}
