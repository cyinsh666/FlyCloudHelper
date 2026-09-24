import { CloudAggregatePathPicker, type CloudAggregatePathSource } from "@/components/CloudAggregatePathPicker";
import { toProviderDirectory } from "@/components/ServicePathPicker";
import { Panel } from "@/components/ui-kit";
import {
  browseLibrarySourceDirectories,
  updateLibrarySourceScanProfile,
  type LibrarySource,
  type MediaLibrary,
  type ProviderDirectory,
} from "@/lib/api";

interface CloudAggregateScanPathsPanelProps {
  library: MediaLibrary;
  admin: boolean;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
}

/** 读取来源扫描配置；尚未保存时使用云聚合视频库默认值。 */
function readSourceScanProfile(source: LibrarySource): Record<string, unknown> {
  const scan = source.configuration.scan;
  if (scan && typeof scan === "object" && !Array.isArray(scan)) return scan as Record<string, unknown>;
  return {
    fullRoots: [], incrementalRoots: [], mediaTypes: ["video"], removedRootPolicy: "protect",
    scanDirectoryConcurrency: 8, scrapeTaskConcurrency: 4,
  };
}

/** 把来源扫描根转换为目录选择器数据。 */
function readSourceRoots(source: LibrarySource, mode: "full" | "incremental"): ProviderDirectory[] {
  const profile = readSourceScanProfile(source);
  const roots = mode === "full" ? profile.fullRoots : profile.incrementalRoots;
  if (!Array.isArray(roots)) return [];
  return roots.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const root = value as Record<string, unknown>;
    if (typeof root.resourceId !== "string" || typeof root.displayPath !== "string") return [];
    return [toProviderDirectory({
      resourceId: root.resourceId,
      displayPath: root.displayPath,
      ...(typeof root.driveId === "string" && root.driveId ? { driveId: root.driveId } : {}),
    })];
  });
}

/** 把目录选择结果转换为来源扫描配置。 */
function buildSourceRoots(directories: ProviderDirectory[]): Record<string, unknown>[] {
  return directories.map((directory) => ({
    resourceId: directory.resourceId,
    displayPath: directory.displayPath,
    ...(directory.driveId ? { driveId: directory.driveId } : {}),
    mediaTypes: ["video"],
  }));
}

interface SourcePathSummaryItem {
  key: string;
  sourceLabel: string;
  displayPath: string;
}

/** 汇总一个扫描模式下全部网盘来源及其具体路径。 */
function buildPathSummaryItems(sources: LibrarySource[], mode: "full" | "incremental"): SourcePathSummaryItem[] {
  return sources.flatMap((source) => readSourceRoots(source, mode).map((directory) => ({
    key: `${source.id}:${directory.driveId ?? ""}:${directory.resourceId}`,
    sourceLabel: `${source.displayName} · ${source.providerType}`,
    displayPath: directory.displayPath,
  })));
}

/** 只读展示管理员看到的全部来源和路径。 */
function ScanPathSummary({ label, items }: { label: string; items: SourcePathSummaryItem[] }) {
  return <div className="rounded-xl border border-border bg-secondary/30 p-4">
    <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{label}</p><span className="text-[11px] text-muted-foreground">{items.length} 个目录</span></div>
    {items.length === 0 ? <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">尚未选择目录</p> : <ul className="mt-3 space-y-1.5">{items.map((item) => <li key={item.key} className="rounded-lg border border-border bg-background/40 px-3 py-2"><p className="truncate text-xs" title={`${item.sourceLabel}：${item.displayPath}`}>{item.sourceLabel}：{item.displayPath}</p></li>)}</ul>}
  </div>;
}

/** 统一展示扫描路径，并在目录 Dialog 内先选择网盘来源再浏览具体路径。 */
export function CloudAggregateScanPathsPanel({ library, admin, onChanged, onMessage }: CloudAggregateScanPathsPanelProps) {
  const availableSources = library.sources.filter((source) => source.status === "active"
    && source.connectionStatus === "valid"
    && source.credentialConfigured
    && (source.serviceStatus === null || source.serviceStatus === "active"));
  // 关键变量：两个 Dialog 都使用完整的正常来源列表，并分别维护全量、增量路径草稿。
  const fullPathSources: CloudAggregatePathSource[] = availableSources.map((source) => ({
    id: source.id,
    label: `${source.displayName} · ${source.providerType}`,
    directories: readSourceRoots(source, "full"),
  }));
  const incrementalPathSources: CloudAggregatePathSource[] = availableSources.map((source) => ({
    id: source.id,
    label: `${source.displayName} · ${source.providerType}`,
    directories: readSourceRoots(source, "incremental"),
  }));

  /** 一次确认依次保存全部正常来源的全量或增量路径，保留每个来源其他扫描配置。 */
  async function saveAllRoots(mode: "full" | "incremental", directoriesBySource: Record<string, ProviderDirectory[]>): Promise<void> {
    let savedSourceCount = 0;
    try {
      for (const source of availableSources) {
        const profile = readSourceScanProfile(source);
        const directories = directoriesBySource[source.id] ?? [];
        await updateLibrarySourceScanProfile(library.id, source.id, {
          ...profile,
          ...(mode === "full" ? { fullRoots: buildSourceRoots(directories) } : { incrementalRoots: buildSourceRoots(directories) }),
        });
        savedSourceCount += 1;
      }
      console.info("codex-path-picker-dialog", {
        事件: "批量保存云聚合扫描路径完成",
        媒体库ID: library.id,
        路径类型: mode,
        保存来源数量: savedSourceCount,
      });
      onMessage(`${mode === "full" ? "全量" : "增量"}扫描路径已保存，共 ${savedSourceCount} 个来源`);
      await onChanged();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "扫描路径保存失败";
      console.warn("codex-path-picker-dialog", {
        事件: "批量保存云聚合扫描路径中断",
        媒体库ID: library.id,
        路径类型: mode,
        已保存来源数量: savedSourceCount,
        来源总数: availableSources.length,
        错误信息: errorMessage,
      });
      if (savedSourceCount > 0) await onChanged();
      throw new Error(`${errorMessage}；已保存 ${savedSourceCount}/${availableSources.length} 个来源，请检查后重试`);
    }
  }

  const fullSummaryItems = buildPathSummaryItems(library.sources, "full");
  const incrementalSummaryItems = buildPathSummaryItems(library.sources, "incremental");

  return <Panel title="扫描路径" description="分别管理全量和增量目录；未配置当前模式目录的来源不会参与该模式扫描。" className="mb-4">
    {library.sources.length === 0 ? <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">请先添加网盘来源，再配置扫描路径。</div> : <>
      {!admin && availableSources.length === 0 && <p className="mb-3 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">当前没有状态正常的可选来源，请先在网盘服务中恢复连接并确认来源已启用。</p>}
      <div className="grid gap-3 xl:grid-cols-2">
        {admin ? <><ScanPathSummary label="全量扫描目录" items={fullSummaryItems} /><ScanPathSummary label="增量扫描目录" items={incrementalSummaryItems} /></> : <><CloudAggregatePathPicker label="全量扫描目录" sources={fullPathSources} summaryItems={fullSummaryItems} disabled={availableSources.length === 0} browseDirectories={(sourceId, parent) => browseLibrarySourceDirectories(library.id, sourceId, parent)} onConfirm={(directoriesBySource) => saveAllRoots("full", directoriesBySource)} /><CloudAggregatePathPicker label="增量扫描目录" sources={incrementalPathSources} summaryItems={incrementalSummaryItems} disabled={availableSources.length === 0} browseDirectories={(sourceId, parent) => browseLibrarySourceDirectories(library.id, sourceId, parent)} onConfirm={(directoriesBySource) => saveAllRoots("incremental", directoriesBySource)} /></>}
      </div>
    </>}
  </Panel>;
}
