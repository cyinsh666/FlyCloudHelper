import { useEffect, useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { ContentSourceLibraryCategoriesEditor } from "@/components/ContentSourceLibraryCategoriesEditor";
import { getContentSourceLibrary, syncContentSourceLibrary, updateContentSourceStatus } from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

const syncStatusLabels = {
  idle: "待同步",
  queued: "等待同步",
  running: "同步中",
  completed: "同步完成",
  failed: "同步失败",
} as const;

/** 在线库管理面板，说明动态分类浏览并保留手动批次同步入口。 */
export function ContentSourceLibraryPanel({ libraryId, admin, onChanged }: {
  libraryId: string; admin: boolean; onChanged: () => Promise<void>;
}) {
  const resource = useApiResource(() => getContentSourceLibrary(libraryId, admin), [libraryId, admin]);
  const [pageCount, setPageCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [updatingSource, setUpdatingSource] = useState(false);
  const [editingCategories, setEditingCategories] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：防止同步按钮在 React 重绘前重复提交。
  const submittingRef = useRef(false);
  const previousStatus = useRef<string | null>(null);
  const data = resource.data;
  // 关键变量：有未完成批次时重试原范围，不能按新的页数扩大入库范围。
  const pendingBatch = data?.sync.pendingBatch;
  const running = data?.sync.status === "queued" || data?.sync.status === "running";
  const sourceEnabled = data?.source.status === "active" && data.source.pluginStatus === "enabled";

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
    }
    previousStatus.current = current;
  }, [data?.sync.status, onChanged]);

  /** 重试未完成批次或读取下一批分页，刷新已有内容时不修改原批次范围。 */
  async function continueSync(mode: "next" | "refresh"): Promise<void> {
    if (submittingRef.current || running || !sourceEnabled || editingCategories) return;
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动同步失败");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** 单独启停当前库的源配置，管理员使用其实际所有者对应的管理接口。 */
  async function toggleSource(): Promise<void> {
    if (!data || submittingRef.current || running || editingCategories) return;
    submittingRef.current = true;
    setUpdatingSource(true);
    try {
      const status = data.source.status === "active" ? "disabled" : "active";
      await updateContentSourceStatus(data.source.id, status, admin);
      await resource.refresh();
      await onChanged();
      setMessage(status === "active" ? "内容源配置已启用" : "内容源配置已停用，目录和播放记录保留");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容源配置状态修改失败");
    } finally {
      submittingRef.current = false;
      setUpdatingSource(false);
    }
  }

  /** 打开分类草稿，读取新分类前再次检查同步和源的可用状态。 */
  function beginEditCategories(): void {
    if (submittingRef.current || resource.loading || running || !sourceEnabled) return;
    setEditingCategories(true);
  }

  /** 分类读取与保存复用同步提交锁，避免和启停、同步请求相互覆盖。 */
  function beginCategoriesOperation(): boolean {
    if (submittingRef.current || running || !sourceEnabled) return false;
    submittingRef.current = true;
    return true;
  }

  /** 分类操作结束后释放共享提交锁。 */
  function endCategoriesOperation(): void {
    submittingRef.current = false;
  }

  /** 分类保存后刷新状态和库摘要，客户端按新的分类选择动态浏览。 */
  async function finishCategoriesSave(): Promise<void> {
    await resource.refresh();
    await onChanged();
    setEditingCategories(false);
    setMessage("分类已保存，客户端可按新选择浏览，原有媒体与观看记录保留。");
  }

  /** 关闭分类编辑，仅丢弃尚未保存的选择草稿。 */
  function cancelCategoriesEdit(): void {
    setEditingCategories(false);
  }

  return <Panel title="在线内容源" description="Jellyfin／Emby 浏览已选分类时按需读取源站，播放方式在各协议配置中设置。" className="mb-4" action={<SecondaryButton disabled={resource.loading || editingCategories} onClick={() => void resource.refresh()}>刷新状态</SecondaryButton>}>
    {!data && !resource.error && <div aria-label="内容源配置加载中" className="animate-pulse space-y-3"><div className="h-5 w-48 rounded bg-muted" /><div className="h-14 rounded bg-muted" /><div className="h-9 w-32 rounded bg-muted" /></div>}
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    {data && <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm">{data.source.displayName}</p><p className="mt-1 text-xs text-muted-foreground">{data.source.pluginId} · {data.source.pluginVersion}</p></div><div className="flex items-center gap-2"><StatusPill>{sourceEnabled ? "内容源可用" : "内容源已停用"}</StatusPill><SecondaryButton disabled={updatingSource || submitting || running || editingCategories} onClick={() => void toggleSource()}>{updatingSource ? "正在保存…" : data.source.status === "active" ? "停用此配置" : "启用此配置"}</SecondaryButton></div></div>
      {!sourceEnabled && <p className="rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">源插件或配置实例已停用，已有目录和播放记录保留。恢复启用后可继续动态浏览、同步和播放。</p>}
      <p className="rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">客户端进入源分类并加载下一页时，云助手会按需读取并缓存目录，无需先手动同步全部内容。目录数量随加载更新；动态分类列表按源站顺序返回。</p>
      <div className="rounded-xl border border-border bg-secondary/20 p-3"><div className="flex flex-wrap items-center gap-3"><StatusPill>{syncStatusLabels[data.sync.status]}</StatusPill><span className="text-xs text-muted-foreground">本轮已处理 {data.sync.processedCount} 个条目</span></div><p className="mt-2 text-xs text-muted-foreground">已选分类：{data.configuration.categoryIds.map((id) => data.configuration.categories?.find((category) => category.id === id)?.name ?? id).join("、")}</p><p className="mt-1 text-xs text-muted-foreground">{pendingBatch ? "本批次各分类进度" : "下一批起始页"}：{data.configuration.categoryIds.map((id) => `${data.configuration.categories?.find((category) => category.id === id)?.name ?? id} → ${pendingBatch?.completedCategoryIds.includes(id) ? "本批次已完成" : `第 ${data.sync.nextPageByCategory[id] ?? 1} 页`}`).join("；")}</p>{data.sync.lastError && <p role="alert" className="mt-2 text-xs text-destructive">{data.sync.lastError}</p>}</div>
      {editingCategories ? <ContentSourceLibraryCategoriesEditor key={libraryId} state={{
        libraryId, admin,
        selectedIds: data.configuration.categoryIds,
        selectedCategories: data.configuration.categories ?? [],
        disabled: running || !sourceEnabled,
        pendingBatch: Boolean(pendingBatch),
        beginOperation: beginCategoriesOperation,
        endOperation: endCategoriesOperation,
        onSaved: finishCategoriesSave,
        onCancel: cancelCategoriesEdit,
      }} /> : <div><SecondaryButton disabled={resource.loading || updatingSource || submitting || running || !sourceEnabled} onClick={beginEditCategories}>修改分类</SecondaryButton>{running && <p className="mt-2 text-xs text-muted-foreground">同步运行中，完成后可修改分类。</p>}{!sourceEnabled && <p className="mt-2 text-xs text-muted-foreground">启用内容源和插件后可修改分类。</p>}</div>}
      <div className="flex flex-wrap items-end gap-3"><label><span className="text-xs text-muted-foreground">{pendingBatch ? "原批次页数（每个分类）" : "下一批页数（每个分类）"}</span><input type="number" min={1} max={20} step={1} disabled={updatingSource || submitting || running || editingCategories || Boolean(pendingBatch)} value={pendingBatch?.pageCount ?? pageCount} onChange={(event) => setPageCount(Number(event.target.value))} className="mt-2 block w-44 rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label><SecondaryButton disabled={updatingSource || submitting || running || editingCategories || !sourceEnabled} onClick={() => void continueSync("next")}>{submitting ? "正在启动…" : running ? "正在同步…" : pendingBatch ? "重试未完成批次" : "继续同步下一批"}</SecondaryButton><SecondaryButton disabled={updatingSource || submitting || running || editingCategories || !sourceEnabled} onClick={() => void continueSync("refresh")}>刷新已入库内容</SecondaryButton></div>
      {editingCategories && <p className="text-xs text-muted-foreground">请先保存或取消分类修改，再启动同步或启停内容源。</p>}
      {pendingBatch && <p className="text-xs text-muted-foreground">原批次尚未完成，重试会沿用每个分类 {pendingBatch.pageCount} 页的原范围，跳过本批次已完成的分类。页数暂不可修改；完成后可继续导入下一批。</p>}
      <p className="text-xs text-muted-foreground">刷新已入库内容会更新影片详情与节目新集，不会扩大入库范围。</p>
      <p className="text-xs text-muted-foreground">手动同步下一批仍按整页导入，与客户端动态浏览分别记录进度，已有条目保留原 ID。电影天堂和虎牙支持客户端实时搜索当前已选分类，无需先同步；带收藏、已看等筛选的搜索使用当前已缓存或同步的目录。</p>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </div>}
  </Panel>;
}
