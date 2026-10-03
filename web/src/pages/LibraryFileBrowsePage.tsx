import { Link } from "@tanstack/react-router";
import { ChevronRight, File, FileVideo, Folder, LayoutGrid, List, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader, SecondaryButton } from "@/components/ConsoleShell";
import { LibraryBrowseManualMatchDialog } from "@/components/LibraryBrowseManualMatchDialog";
import { Panel } from "@/components/ui-kit";
import {
  browseLibraryFiles, createLibraryTargetedScan, getLibrary, listLibraryBrowseSummaries,
  previewLibraryBrowseUnmatch, unmatchLibraryBrowseRange,
  type LibraryBrowseEntry, type LibraryBrowseSummary, type LibraryBrowseUnmatchPreview,
  type MediaLibrary, type ProviderDirectory,
} from "@/lib/api";

type BrowseSort = "name" | "modified" | "size";

/** 将网盘返回的字节数转换为文件列表中的简短文案。 */
function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 文件列表只根据真实扩展名判断视频菜单，不把目录名当成视频。 */
function isVideoFile(entry: LibraryBrowseEntry): boolean {
  return !entry.isDirectory && /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|mpg|mpeg|rmvb|webm|3gp|iso|strm)$/iu.test(entry.name);
}

/** 展示网盘实时条目与媒体库已保存的刮削状态。 */
export function LibraryFileBrowsePage({ libraryId, admin = false }: { libraryId: string; admin?: boolean }) {
  const [library, setLibrary] = useState<MediaLibrary | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [folders, setFolders] = useState<ProviderDirectory[]>([]);
  const [entries, setEntries] = useState<LibraryBrowseEntry[]>([]);
  const [summaries, setSummaries] = useState<Record<string, LibraryBrowseSummary>>({});
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [sort, setSort] = useState<BrowseSort>("name");
  const [descending, setDescending] = useState(false);
  const [view, setView] = useState<"list" | "grid">("list");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyResourceId, setBusyResourceId] = useState<string | null>(null);
  const [scanTaskId, setScanTaskId] = useState<string | null>(null);
  const [manualRange, setManualRange] = useState<{ entry: LibraryBrowseEntry; preview: LibraryBrowseUnmatchPreview } | null>(null);
  const [unmatch, setUnmatch] = useState<{ entry: LibraryBrowseEntry; preview: LibraryBrowseUnmatchPreview } | null>(null);

  useEffect(() => {
    let active = true;
    /** 进入文件浏览时读取当前媒体库和它的真实来源列表。 */
    async function loadLibrary(): Promise<void> {
      try {
        const result = await getLibrary(libraryId, admin);
        if (!active) return;
        setLibrary(result.library);
        setSourceId(result.library.sources[0]?.id ?? "");
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "媒体库读取失败");
      }
    }
    void loadLibrary();
    return () => { active = false; };
  }, [libraryId, admin]);

  const parent = folders[folders.length - 1];
  // 关键变量：旧来源或旧目录的分页请求完成时不能追加到当前文件列表。
  const browseKey = `${sourceId}\u0000${parent?.resourceId ?? ""}\u0000${parent?.driveId ?? ""}\u0000${sort}\u0000${descending}`;
  const latestBrowseKey = useRef(browseKey);
  latestBrowseKey.current = browseKey;
  const selectedSource = library?.sources.find((source) => source.id === sourceId);
  const sourceReady = selectedSource?.status === "active" && selectedSource.connectionStatus === "valid"
    && selectedSource.credentialConfigured && (selectedSource.serviceStatus === null
      || selectedSource.serviceStatus === "active" || selectedSource.serviceStatus === "scanning");

  useEffect(() => {
    if (!library || !sourceId || !sourceReady) { setEntries([]); setSummaries({}); setNextOffset(null); return; }
    // 关键变量：在异步请求开始前固定当前媒体库 ID，避免闭包中的可空状态影响类型检查。
    const activeLibraryId = library.id;
    let active = true;
    setLoading(true);
    setMessage(null);
    /** 目录切换或排序变化时从第一页重新读取网盘和媒体库摘要。 */
    async function loadFirstPage(): Promise<void> {
      try {
        const page = await browseLibraryFiles(activeLibraryId, sourceId, parent, sort, descending, 0, admin, reloadVersion > 0);
        if (!active) return;
        setEntries(page.items);
        setNextOffset(page.nextOffset);
        const rows = await listLibraryBrowseSummaries(activeLibraryId, sourceId, page.items, admin);
        if (active) setSummaries(Object.fromEntries(rows.map((row) => [row.resourceId, row])));
      } catch (error) {
        if (active) { setEntries([]); setSummaries({}); setMessage(error instanceof Error ? error.message : "文件浏览失败"); }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadFirstPage();
    return () => { active = false; };
  }, [library, sourceId, sourceReady, parent, sort, descending, admin, reloadVersion]);

  /** 追加当前目录下一页，摘要只查询新增的可见条目。 */
  async function loadMore(): Promise<void> {
    if (!library || !sourceId || nextOffset === null || loadingMore) return;
    const requestedBrowseKey = browseKey;
    setLoadingMore(true);
    try {
      const page = await browseLibraryFiles(library.id, sourceId, parent, sort, descending, nextOffset, admin);
      const rows = await listLibraryBrowseSummaries(library.id, sourceId, page.items, admin);
      if (latestBrowseKey.current !== requestedBrowseKey) return;
      setEntries((current) => [...current, ...page.items]);
      setSummaries((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.resourceId, row])) }));
      setNextOffset(page.nextOffset);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载更多文件失败");
    } finally {
      setLoadingMore(false);
    }
  }

  /** 切换聚合库来源时回到该来源根目录。 */
  function selectSource(nextSourceId: string): void {
    setSourceId(nextSourceId);
    setFolders([]);
    setEntries([]);
    setSummaries({});
    setNextOffset(null);
    setManualRange(null);
    setUnmatch(null);
  }

  /** 单击文件夹进入下一层；单击文件仅选中，不触发直接播放。 */
  function openEntry(entry: LibraryBrowseEntry): void {
    if (!entry.isDirectory) return;
    setFolders((current) => [...current, { name: entry.name, resourceId: entry.resourceId,
      displayPath: entry.displayPath, ...(entry.driveId ? { driveId: entry.driveId } : {}) }]);
  }

  /** 对当前网盘文件或目录建立后台扫描任务，任务进度由后台任务页展示。 */
  async function scanEntry(entry: LibraryBrowseEntry): Promise<void> {
    if (!library || !sourceId || busyResourceId) return;
    const scopeText = entry.isDirectory
      ? "将递归扫描此文件夹内的视频，不修改固定扫描路径，也不清理其他目录。"
      : "只会保存此视频文件，同目录其他文件仅用于辅助识别。";
    if (!window.confirm(`对“${entry.name}”开始定向扫描刮削？\n${scopeText}`)) return;
    setBusyResourceId(entry.resourceId);
    setScanTaskId(null);
    setMessage(null);
    try {
      const result = await createLibraryTargetedScan(library.id, sourceId, entry, parent, admin);
      setScanTaskId(result.job.id);
      setMessage(`已为“${entry.name}”创建定向扫描任务，可在后台任务查看进度。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "定向扫描创建失败");
    } finally {
      setBusyResourceId(null);
    }
  }

  /** 预览已有文件关联后，对单文件或文件夹打开范围手动匹配窗口。 */
  async function previewManualMatch(entry: LibraryBrowseEntry): Promise<void> {
    if (!library || !sourceId || busyResourceId) return;
    setBusyResourceId(entry.resourceId);
    setScanTaskId(null);
    setMessage(null);
    try {
      const preview = await previewLibraryBrowseUnmatch(library.id, sourceId, entry, parent, admin);
      if (preview.fileCount === 0) setMessage("当前范围没有已扫描视频，请先定向扫描。");
      else setManualRange({ entry, preview });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "手动匹配范围预览失败");
    } finally {
      setBusyResourceId(null);
    }
  }

  /** 读取解除范围，确认前展示将受影响的源文件与影视条目数量。 */
  async function previewUnmatch(entry: LibraryBrowseEntry): Promise<void> {
    if (!library || !sourceId || busyResourceId) return;
    setBusyResourceId(entry.resourceId);
    setScanTaskId(null);
    setMessage(null);
    try {
      const preview = await previewLibraryBrowseUnmatch(library.id, sourceId, entry, parent, admin);
      if (preview.fileCount === 0) setMessage("当前范围没有已扫描的视频关联。");
      else setUnmatch({ entry, preview });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解除范围预览失败");
    } finally {
      setBusyResourceId(null);
    }
  }

  /** 按预览版本解除当前来源的文件关联，避免影响其他来源或未预览的新文件。 */
  async function confirmUnmatch(): Promise<void> {
    if (!library || !sourceId || !unmatch || busyResourceId) return;
    setBusyResourceId(unmatch.entry.resourceId);
    setMessage(null);
    try {
      const result = await unmatchLibraryBrowseRange(library.id, sourceId, unmatch.entry, parent, unmatch.preview.revision, admin);
      setUnmatch(null);
      setReloadVersion((value) => value + 1);
      setMessage(`已解除 ${result.fileCount} 个文件的刮削关联，移除 ${result.removedItemCount} 个无文件条目；网盘文件与扫描路径保持不变。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解除刮削失败，请重新预览");
      setUnmatch(null);
    } finally {
      setBusyResourceId(null);
    }
  }

  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";
  const catalogPath = admin ? `/admin/libraries/${libraryId}/catalog` : `/app/libraries/${libraryId}/catalog`;
  if (!library) return <Panel><p className="py-12 text-center text-sm text-muted-foreground">{message ?? "正在读取媒体库…"}</p></Panel>;
  if (library.dataType !== "video") return <Panel><p className="py-12 text-center text-sm text-muted-foreground">文件浏览当前只支持视频媒体库</p></Panel>;

  return <>
    <PageHeader title={`${library.displayName} · 文件浏览`} actions={<Link to={settingsPath} params={{ serviceId: libraryId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>} />
    <Panel className="mb-4">
      <div className="flex flex-wrap gap-2">
        {library.sources.map((source) => <button key={source.id} type="button" onClick={() => selectSource(source.id)}
          className={`rounded-lg border px-3 py-2 text-sm ${sourceId === source.id ? "border-foreground bg-secondary text-foreground" : "border-border text-muted-foreground"}`}>
          {source.displayName}<span className="ml-2 text-xs opacity-70">{source.providerType}</span>
        </button>)}
      </div>
      {library.sources.length === 0 && <p className="mt-3 text-sm text-muted-foreground">此媒体库还没有网盘来源，请先在媒体库设置中添加来源。</p>}
      {!sourceReady && <p className="mt-3 text-sm text-destructive">当前来源未启用或登录已失效，请先重新登录。
        {selectedSource?.serviceId && <Link to={admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection"} params={{ serviceId: selectedSource.serviceId }} className="ml-2 underline">打开网盘连接</Link>}
        {!selectedSource?.serviceId && <Link to={settingsPath} params={{ serviceId: libraryId }} className="ml-2 underline">管理媒体库来源</Link>}
      </p>}
    </Panel>
    {sourceReady && <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => setFolders([])} className="rounded px-2 py-1 hover:bg-secondary">根目录</button>
          {folders.map((folder, index) => <span key={`${folder.resourceId}-${index}`} className="flex items-center gap-1"><ChevronRight className="size-4 text-muted-foreground" /><button type="button" onClick={() => setFolders(folders.slice(0, index + 1))} className="max-w-40 truncate rounded px-2 py-1 hover:bg-secondary">{folder.name}</button></span>)}
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="排序字段" value={sort} onChange={(event) => setSort(event.target.value as BrowseSort)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"><option value="name">名称</option><option value="modified">修改时间</option><option value="size">大小</option></select>
          <button type="button" onClick={() => setDescending((value) => !value)} className="rounded-lg border border-border px-2 py-1.5 text-xs">{descending ? "降序" : "升序"}</button>
          <button type="button" aria-label="列表视图" onClick={() => setView("list")} className={`rounded-lg border px-2 py-1.5 ${view === "list" ? "border-foreground" : "border-border"}`}><List className="size-4" /></button>
          <button type="button" aria-label="网格视图" onClick={() => setView("grid")} className={`rounded-lg border px-2 py-1.5 ${view === "grid" ? "border-foreground" : "border-border"}`}><LayoutGrid className="size-4" /></button>
          <button type="button" aria-label="刷新文件" onClick={() => setReloadVersion((value) => value + 1)} className="rounded-lg border border-border px-2 py-1.5"><RefreshCw className="size-4" /></button>
        </div>
      </div>
      {message && <p className="mt-3 text-sm text-muted-foreground">{message}{scanTaskId && <Link to={admin ? "/admin/jobs" : "/app/jobs"} className="ml-2 underline">查看后台任务</Link>}</p>}
      {loading ? <p className="py-12 text-center text-sm text-muted-foreground">正在读取网盘文件…</p> : entries.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">当前目录没有文件</p> :
        <div className={view === "grid" ? "mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4" : "mt-3 space-y-1"}>
          {entries.map((entry) => {
            const summary = summaries[entry.resourceId];
            const Icon = entry.isDirectory ? Folder : isVideoFile(entry) ? FileVideo : File;
            return <div key={`${entry.resourceId}-${entry.displayPath}`} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3">
              <button type="button" onClick={() => openEntry(entry)} className="flex min-w-0 flex-1 items-center gap-3 text-left" disabled={!entry.isDirectory}>
                {summary?.posterUrl ? <img src={summary.posterUrl} alt="" className="h-10 w-7 shrink-0 rounded object-cover" />
                  : <Icon className="size-5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{entry.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{entry.isDirectory ? "文件夹" : formatFileSize(entry.size)} · {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString("zh-CN") : "修改时间未知"}</span>{summary && summary.itemCount > 0 && <span className="mt-1 block truncate text-xs text-muted-foreground">{summary.itemCount === 1 ? `${summary.title ?? "已扫描"} · ${summary.matchState === "matched" ? "已匹配" : "未匹配"}${summary.manualMatched ? " · 手动" : ""}` : `${summary.itemCount} 个媒体条目`}</span>}</span>
              </button>
              {summary?.itemId && <a href={`${catalogPath}?itemId=${encodeURIComponent(summary.itemId)}`} className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary">查看详情</a>}
              {(entry.isDirectory || isVideoFile(entry)) && <div className="flex shrink-0 flex-wrap justify-end gap-1">
                <button type="button" disabled={busyResourceId !== null} onClick={() => void scanEntry(entry)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50">扫描刮削</button>
                {summary && summary.linkedFileCount > 0 && <button type="button" disabled={busyResourceId !== null} onClick={() => void previewManualMatch(entry)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50">手动匹配</button>}
                {summary && summary.linkedFileCount > 0 && <button type="button" disabled={busyResourceId !== null} onClick={() => void previewUnmatch(entry)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50">解除刮削</button>}
              </div>}
            </div>;
          })}
        </div>}
      {nextOffset !== null && <div className="mt-4 text-center"><SecondaryButton type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多"}</SecondaryButton></div>}
    </Panel>}
    {manualRange && <LibraryBrowseManualMatchDialog libraryId={libraryId} sourceId={sourceId}
      entry={manualRange.entry} parent={parent} preview={manualRange.preview} admin={admin}
      onClose={() => setManualRange(null)}
      onApplied={(fileCount) => { setManualRange(null); setReloadVersion((value) => value + 1);
        setMessage(`已手动匹配 ${fileCount} 个视频文件。`); }} />}
    {unmatch && <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <button type="button" aria-label="关闭解除刮削确认" onClick={() => setUnmatch(null)} className="absolute inset-0 bg-black/75" />
      <div role="dialog" aria-modal="true" aria-label="确认解除刮削" className="relative w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">解除刮削 · {unmatch.entry.name}</h2>
        <p className="mt-3 text-sm">将解除 {unmatch.preview.fileCount} 个视频文件与 {unmatch.preview.itemCount} 个媒体条目的关联。网盘文件和扫描路径不会删除。</p>
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">{unmatch.preview.examples.map((example) => <p key={example} className="truncate">{example}</p>)}</div>
        <div className="mt-5 flex justify-end gap-2"><SecondaryButton type="button" onClick={() => setUnmatch(null)}>取消</SecondaryButton>
          <button type="button" disabled={busyResourceId !== null} onClick={() => void confirmUnmatch()} className="rounded-lg bg-destructive px-4 py-2 text-sm text-destructive-foreground disabled:opacity-50">确认解除</button></div>
      </div>
    </div>}
  </>;
}
