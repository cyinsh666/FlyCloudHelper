import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getContentAudiobookLibrary,
  listContentAudiobookCategories,
  syncContentAudiobookLibrary,
  updateContentAudiobookLibrary,
} from "@/lib/content-audiobook-api";
import { updateContentSourceStatus, type ContentSourceCategory } from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

const syncStatusLabels = { idle: "待同步", queued: "等待同步", running: "同步中", completed: "同步完成", failed: "同步失败" } as const;

/** 在线听书来源独立管理摘要同步与分类，不呈现物理文件扫描选项。 */
export function ContentAudiobookLibraryPanel({ state }: { state: {
  libraryId: string; admin: boolean; onChanged: () => Promise<void>;
} }) {
  const { libraryId, admin, onChanged } = state;
  const resource = useApiResource(() => getContentAudiobookLibrary(libraryId, admin), [libraryId, admin]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editingCategories, setEditingCategories] = useState(false);
  const [categories, setCategories] = useState<ContentSourceCategory[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState(1);
  // 关键变量：同步、分类保存和来源启停共用即时锁，避免重复提交或相互覆盖。
  const busyRef = useRef(false);
  const previousSyncStatus = useRef<string | null>(null);
  const data = resource.data;
  const running = data?.sync.status === "queued" || data?.sync.status === "running";
  const sourceEnabled = data?.source.status === "active" && data.source.pluginStatus === "enabled";
  const leafCategories = categories.filter((entry) => !categories.some((child) => child.parentId === entry.id));

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void resource.refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [running, resource.refresh]);

  useEffect(() => {
    if (!data) return;
    const previous = previousSyncStatus.current;
    if ((previous === null || previous === "queued" || previous === "running")
      && (data.sync.status === "completed" || data.sync.status === "failed")) void onChanged();
    previousSyncStatus.current = data.sync.status;
  }, [data?.sync.status, onChanged]);

  /** 打开分类草稿，取消时不改变已保存的目录范围。 */
  function openCategories(): void {
    if (!data || busyRef.current || running) return;
    setCategories(data.configuration.categories ?? []);
    setCategoryIds([...data.configuration.categoryIds]);
    setMessage(null);
    setEditingCategories(true);
  }

  /** 进行中的分类请求保留弹窗，其余关闭动作只丢弃草稿。 */
  function closeCategories(): void {
    if (!busyRef.current) setEditingCategories(false);
  }

  /** 用户主动刷新可选分类，同时去掉已经不在返回列表中的草稿选择。 */
  async function refreshCategories(): Promise<void> {
    if (busyRef.current || !editingCategories) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await listContentAudiobookCategories(libraryId, admin);
      setCategories(result.items);
      const available = new Set(result.items.map((category) => category.id));
      setCategoryIds((current) => current.filter((id) => available.has(id)));
      setMessage(result.items.length ? "已更新可选分类，请确认后保存。" : "当前听书源没有返回分类。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "听书分类读取失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 保存明确选择的听书分类，不同时启动摘要同步。 */
  async function saveCategories(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyRef.current || running || !categoryIds.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateContentAudiobookLibrary(libraryId, categoryIds, admin);
      await resource.refresh();
      await onChanged();
      setEditingCategories(false);
      setMessage("分类已保存，可同步最新书籍摘要。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "听书分类保存失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 同步最新第一页或继续分页，未完成批次由服务端保留范围并重试。 */
  async function startSync(mode: "next" | "latest" | "refresh"): Promise<void> {
    if (!data || busyRef.current || running || !sourceEnabled || editingCategories) return;
    if (mode !== "latest" && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20)) {
      setMessage("每个分类的同步页数须为 1 至 20。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await syncContentAudiobookLibrary(libraryId,
        mode === "latest" || (mode === "next" && data.sync.pendingBatch) ? { mode } : { mode, pageCount }, admin);
      await resource.refresh();
      await onChanged();
      setMessage("书籍摘要同步已启动，状态会自动刷新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "听书目录同步失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 仅启停当前库的来源实例，源插件及已保存目录继续保留。 */
  async function toggleSource(): Promise<void> {
    if (!data || busyRef.current || running || editingCategories) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const status = data.source.status === "active" ? "disabled" : "active";
      await updateContentSourceStatus(data.source.id, status, admin);
      await resource.refresh();
      await onChanged();
      setMessage(status === "active" ? "听书来源已启用。" : "听书来源已停用，目录和收听记录保留。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "听书来源状态保存失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <Panel title="在线听书源" className="mb-3 p-4 sm:p-4" action={<SecondaryButton disabled={resource.loading || busy || editingCategories} onClick={() => void resource.refresh()}>刷新状态</SecondaryButton>}>
    {!data && !resource.error && <div aria-label="听书来源加载中" className="animate-pulse space-y-3"><div className="h-5 w-40 rounded bg-muted" /><div className="h-12 rounded bg-muted" /><div className="h-8 w-32 rounded bg-muted" /></div>}
    {resource.error && <p role="alert" className="mb-3 text-xs text-destructive">{resource.error}</p>}
    {data && <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-words text-sm">{data.source.displayName}</p><div className="flex items-center gap-2"><StatusPill tone={sourceEnabled ? "success" : "neutral"}>{sourceEnabled ? "来源已启用" : data.source.status === "disabled" ? "来源已停用" : "插件未启用"}</StatusPill><SecondaryButton disabled={busy || running || editingCategories} onClick={() => void toggleSource()}>{data.source.status === "active" ? "停用来源" : "启用来源"}</SecondaryButton></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>已选 {data.configuration.categoryIds.length} 个分类 · {syncStatusLabels[data.sync.status]} · 已处理 {data.sync.processedCount} 本</span><SecondaryButton disabled={busy || running || !sourceEnabled} onClick={openCategories}>设置分类</SecondaryButton></div>
      <p className="text-xs text-muted-foreground">列表同步书籍摘要，打开书籍详情和播放时按需读取章节与音频资料。</p>
      {data.sync.lastError && <p role="alert" className="break-words text-xs text-destructive">{data.sync.lastError}</p>}
      <div className="flex flex-wrap items-center gap-2 [&_button]:px-3 [&_button]:py-1.5">
        <PrimaryButton disabled={busy || running || !sourceEnabled || editingCategories} onClick={() => void startSync("latest")}>同步最新</PrimaryButton>
        <SecondaryButton disabled={busy || running || !sourceEnabled || editingCategories} onClick={() => void startSync("next")}>{data.sync.pendingBatch ? "重试未完成同步" : "加载更多摘要"}</SecondaryButton>
        <SecondaryButton disabled={busy || running || !sourceEnabled || editingCategories} onClick={() => void startSync("refresh")}>重新同步</SecondaryButton>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">每分类页数<input type="number" min={1} max={20} value={pageCount} disabled={busy || running || editingCategories} onChange={(event) => setPageCount(Number(event.target.value))} className="w-16 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" /></label>
      </div>
      {data.sync.finishedAt && <p className="text-xs text-muted-foreground">最近同步：{new Date(data.sync.finishedAt).toLocaleString("zh-CN")}</p>}
    </div>}
    {message && !editingCategories && <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p>}
    {editingCategories && <ContentSourceSettingsDialog state={{ title: "听书分类", busy, onClose: closeCategories, children: <form onSubmit={(event) => void saveCategories(event)} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2"><p className="mr-auto text-xs text-muted-foreground">已选 {categoryIds.length} 个分类</p><SecondaryButton disabled={busy} onClick={() => void refreshCategories()}>重新读取</SecondaryButton><SecondaryButton disabled={busy || !leafCategories.length} onClick={() => setCategoryIds(leafCategories.map((category) => category.id))}>全选</SecondaryButton><SecondaryButton disabled={busy} onClick={() => setCategoryIds([])}>清空选择</SecondaryButton></div>
      {busy && !leafCategories.length ? <div aria-label="听书分类加载中" className="flex animate-pulse flex-wrap gap-2">{[0, 1, 2, 3].map((index) => <div key={index} className="h-8 w-20 rounded-lg bg-muted" />)}</div> : <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">{leafCategories.map((category) => <button key={category.id} type="button" disabled={busy} aria-pressed={categoryIds.includes(category.id)} onClick={() => setCategoryIds((current) => current.includes(category.id) ? current.filter((id) => id !== category.id) : [...current, category.id])} className={`rounded-lg border px-3 py-1.5 text-sm ${categoryIds.includes(category.id) ? "border-foreground" : "border-border"}`}>{category.name}</button>)}</div>}
      {!busy && !leafCategories.length && <p className="text-xs text-muted-foreground">没有已缓存的可选分类，请点击“重新读取”。</p>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      <div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={closeCategories}>取消</SecondaryButton><PrimaryButton type="submit" disabled={busy || running || !categoryIds.length}>{busy ? "正在处理…" : "保存分类"}</PrimaryButton></div>
    </form> }} />}
  </Panel>;
}
