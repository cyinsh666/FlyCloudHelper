import { Check, ChevronLeft, ChevronRight, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import type { ProviderDirectory, ProviderDirectoryListing } from "@/lib/api";

export interface CloudAggregatePathSource {
  id: string;
  label: string;
  directories: ProviderDirectory[];
}

interface CloudAggregatePathPickerProps {
  label: string;
  sources: CloudAggregatePathSource[];
  summaryItems: Array<{ key: string; sourceLabel: string; displayPath: string }>;
  browseDirectories: (sourceId: string, parent?: ProviderDirectory) => Promise<ProviderDirectoryListing>;
  onConfirm: (directoriesBySource: Record<string, ProviderDirectory[]>) => Promise<void>;
  disabled?: boolean;
}

/** 为同一来源下的目录生成稳定选择键。 */
function getDirectoryKey(directory: Pick<ProviderDirectory, "driveId" | "resourceId">): string {
  return `${directory.driveId ?? ""}:${directory.resourceId}`;
}

/** 从全部来源的当前配置构建本次 Dialog 独立草稿，切换来源时不丢失其他来源选择。 */
function buildDraftValues(sources: CloudAggregatePathSource[]): Record<string, ProviderDirectory[]> {
  return Object.fromEntries(sources.map((source) => [source.id, [...source.directories]]));
}

/** 云聚合路径选择器；一次打开可以完成多个正常网盘来源的目录选择。 */
export function CloudAggregatePathPicker({
  label,
  sources,
  summaryItems,
  browseDirectories,
  onConfirm,
  disabled = false,
}: CloudAggregatePathPickerProps) {
  const [open, setOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [draftValues, setDraftValues] = useState<Record<string, ProviderDirectory[]>>({});
  const [listing, setListing] = useState<ProviderDirectoryListing | null>(null);
  const [history, setHistory] = useState<ProviderDirectory[]>([]);
  const [currentParent, setCurrentParent] = useState<ProviderDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // 关键变量：请求序号用于丢弃切换来源或目录后晚返回的旧请求。
  const requestSequence = useRef(0);
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const currentDraft = selectedSource ? draftValues[selectedSource.id] ?? [] : [];
  const selectedKeys = new Set(currentDraft.map(getDirectoryKey));
  // 关键变量：Dialog 已选列表汇总所有正常来源的草稿，而不是只展示当前来源。
  const allSelectedDirectories = sources.flatMap((source) => (draftValues[source.id] ?? []).map((directory) => ({
    sourceId: source.id,
    sourceLabel: source.label,
    directory,
  })));

  /** Dialog 打开时锁定页面滚动，并支持按 Esc 关闭。 */
  useEffect(() => {
    if (!open) return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  /** 读取指定来源的根目录或某个目录的直接子目录。 */
  async function loadDirectory(sourceId: string, parent?: ProviderDirectory): Promise<void> {
    if (!sourceId) return;
    const currentSequence = requestSequence.current + 1;
    requestSequence.current = currentSequence;
    setCurrentParent(parent ?? null);
    setLoading(true);
    setError(null);
    try {
      const result = await browseDirectories(sourceId, parent);
      if (requestSequence.current !== currentSequence) return;
      const currentDirectoryKey = getDirectoryKey(result.current);
      const childDirectories = result.items.filter((directory) => getDirectoryKey(directory) !== currentDirectoryKey);
      if (childDirectories.length !== result.items.length) {
        console.warn("codex-path-picker-dialog", {
          事件: "过滤聚合目录列表中的当前路径",
          来源ID: sourceId,
          当前路径: result.current.displayPath,
          过滤数量: result.items.length - childDirectories.length,
        });
      }
      setListing({ ...result, items: childDirectories });
    } catch (loadError) {
      if (requestSequence.current !== currentSequence) return;
      const errorMessage = loadError instanceof Error ? loadError.message : "读取网盘目录失败";
      console.warn("codex-path-picker-dialog", {
        事件: "读取云聚合来源目录失败",
        来源ID: sourceId,
        错误信息: errorMessage,
      });
      setError(errorMessage);
    } finally {
      if (requestSequence.current === currentSequence) setLoading(false);
    }
  }

  /** 打开选择器时复制所有来源的已保存路径，之后只修改本次临时草稿。 */
  function openPicker(): void {
    const firstSourceId = sources[0]?.id ?? "";
    setDraftValues(buildDraftValues(sources));
    setSelectedSourceId(firstSourceId);
    setConfirmError(null);
    setHistory([]);
    setListing(null);
    setOpen(true);
    void loadDirectory(firstSourceId);
  }

  /** 切换网盘来源，只切换浏览上下文，不覆盖其他来源的路径草稿。 */
  function changeSource(sourceId: string): void {
    setSelectedSourceId(sourceId);
    setHistory([]);
    setListing(null);
    setConfirmError(null);
    console.info("codex-path-picker-dialog", {
      事件: "切换云聚合路径来源",
      来源ID: sourceId,
      已选来源数量: Object.values(draftValues).filter((directories) => directories.length > 0).length,
      已选目录总数: Object.values(draftValues).reduce((total, directories) => total + directories.length, 0),
    });
    void loadDirectory(sourceId);
  }

  /** 进入当前来源下的直接子目录。 */
  function enterDirectory(directory: ProviderDirectory): void {
    if (!selectedSourceId) return;
    if (listing) setHistory((current) => [...current, listing.current]);
    void loadDirectory(selectedSourceId, directory);
  }

  /** 返回当前来源的上一层目录。 */
  function returnToParent(): void {
    if (!selectedSourceId || history.length === 0) return;
    const parent = history[history.length - 1];
    setHistory((current) => current.slice(0, -1));
    void loadDirectory(selectedSourceId, parent);
  }

  /** 把目录加入当前来源的草稿，不影响其他来源已经选择的目录。 */
  function selectDirectory(directory: ProviderDirectory): void {
    if (!selectedSource || selectedKeys.has(getDirectoryKey(directory))) return;
    console.info("codex-path-picker-dialog", {
      事件: "选择云聚合扫描目录",
      来源ID: selectedSource.id,
      来源名称: selectedSource.label,
      目录路径: directory.displayPath,
      来源选择前数量: currentDraft.length,
      来源选择后数量: currentDraft.length + 1,
    });
    setDraftValues((current) => ({
      ...current,
      [selectedSource.id]: [...(current[selectedSource.id] ?? []), directory],
    }));
  }

  /** 从指定来源的草稿中移除目录。 */
  function removeDraftDirectory(sourceId: string, directory: ProviderDirectory): void {
    const removedKey = getDirectoryKey(directory);
    setDraftValues((current) => ({
      ...current,
      [sourceId]: (current[sourceId] ?? []).filter((item) => getDirectoryKey(item) !== removedKey),
    }));
    console.info("codex-path-picker-dialog", {
      事件: "移除云聚合已选目录",
      来源ID: sourceId,
      目录路径: directory.displayPath,
    });
  }

  /** 一次保存全部正常来源的路径草稿，全部请求完成后再关闭 Dialog。 */
  async function confirmSelection(): Promise<void> {
    setConfirming(true);
    setConfirmError(null);
    try {
      await onConfirm(draftValues);
      setOpen(false);
    } catch (confirmFailure) {
      const errorMessage = confirmFailure instanceof Error ? confirmFailure.message : "扫描路径保存失败";
      console.warn("codex-path-picker-dialog", {
        事件: "批量保存云聚合扫描路径失败",
        路径类型: label,
        来源数量: sources.length,
        已选目录总数: allSelectedDirectories.length,
        错误信息: errorMessage,
      });
      setConfirmError(errorMessage);
    } finally {
      setConfirming(false);
    }
  }

  return <div className="rounded-xl border border-border bg-secondary/30 p-4">
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-sm font-medium">{label}</p><p className="mt-1 text-[11px] text-muted-foreground">已选择 {summaryItems.length} 个目录</p></div>
      <SecondaryButton onClick={openPicker} disabled={disabled}><FolderOpen className="size-4" /> 选择目录</SecondaryButton>
    </div>
    {summaryItems.length === 0 ? <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">尚未选择目录，本模式扫描不会包含这些来源</div> : <ul className="mt-4 space-y-2">
      {summaryItems.map((item) => <li key={item.key} className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs" title={`${item.sourceLabel}：${item.displayPath}`}>{item.sourceLabel}：{item.displayPath}</span>
      </li>)}
    </ul>}

    {open && createPortal(<div className="fixed inset-0 z-[1000] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${label}路径选择`}>
      <div className="surface flex h-[86vh] w-full max-w-4xl flex-col overflow-hidden p-0">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0"><h3 className="text-base font-semibold">选择{label}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{selectedSource?.label ?? "无可用来源"} · {listing?.current.displayPath ?? "正在读取根目录…"}</p></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭路径选择" className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </header>

        <div className="border-b border-border px-5 py-3">
          <label className="block"><span className="text-xs text-muted-foreground">网盘来源</span><select value={selectedSourceId} onChange={(event) => changeSource(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm">{sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
        </div>

        <div className="flex h-44 shrink-0 flex-col border-b border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">已选目录 · {allSelectedDirectories.length}</p>
          {allSelectedDirectories.length === 0 ? <p className="mt-2 grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed border-border px-3 text-center text-xs text-muted-foreground">尚未选择目录；未选择的来源不会参与本模式扫描</p> : <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {allSelectedDirectories.map((item) => <li key={`${item.sourceId}:${getDirectoryKey(item.directory)}`} className="flex items-center gap-2 rounded-lg border border-border bg-secondary/35 px-3 py-2">
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs" title={`${item.sourceLabel}：${item.directory.displayPath}`}>{item.sourceLabel}：{item.directory.displayPath}</span>
              <button type="button" onClick={() => removeDraftDirectory(item.sourceId, item.directory)} aria-label={`删除已选路径 ${item.sourceLabel} ${item.directory.displayPath}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="size-3.5" /></button>
            </li>)}
          </ul>}
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <SecondaryButton onClick={returnToParent} disabled={history.length === 0 || loading}><ChevronLeft className="size-4" /> 上一级</SecondaryButton>
          <PrimaryButton onClick={() => listing && selectDirectory(listing.current)} disabled={!listing || loading || (listing ? selectedKeys.has(getDirectoryKey(listing.current)) : true)}><Check className="size-4" /> 选择当前目录</PrimaryButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
          {loading && <div className="grid min-h-52 place-items-center text-sm text-muted-foreground"><span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> 正在读取网盘目录…</span></div>}
          {!loading && error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"><p>{error}</p><button type="button" onClick={() => void loadDirectory(selectedSourceId, currentParent ?? undefined)} className="mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-xs">重新读取</button></div>}
          {!loading && !error && listing?.items.length === 0 && <div className="grid min-h-52 place-items-center text-sm text-muted-foreground">当前目录没有子目录，可以直接选择当前目录。</div>}
          {!loading && !error && listing && listing.items.length > 0 && <ul className="space-y-2">{listing.items.map((directory) => {
            const selected = selectedKeys.has(getDirectoryKey(directory));
            return <li key={getDirectoryKey(directory)} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-border bg-secondary/35 p-2">
              <button type="button" onClick={() => enterDirectory(directory)} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-secondary"><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm">{directory.name}</span><span className="block truncate text-[10px] text-muted-foreground">{directory.displayPath}</span></span></button>
              <button type="button" onClick={() => selectDirectory(directory)} disabled={selected} className="w-16 rounded-md border border-border px-2 py-2 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45">{selected ? "已选择" : "选择"}</button>
              <button type="button" onClick={() => enterDirectory(directory)} aria-label={`进入 ${directory.name}`} className="grid size-9 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"><ChevronRight className="size-4" /></button>
            </li>;
          })}</ul>}
        </div>

        <footer className="border-t border-border px-5 py-4">
          {confirmError && <p className="mb-3 text-xs text-destructive">{confirmError}</p>}
          <div className="flex items-center justify-between gap-4"><SecondaryButton onClick={() => setOpen(false)} disabled={confirming}>取消</SecondaryButton><PrimaryButton onClick={() => void confirmSelection()} disabled={confirming}>{confirming ? "正在保存全部来源…" : "确定"}</PrimaryButton></div>
        </footer>
      </div>
    </div>, document.body)}
  </div>;
}
