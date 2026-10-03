import { useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import {
  applyLibraryBrowseRangeMatch, searchLibraryBrowseRangeMatch,
  type LibraryBrowseEntry, type LibraryBrowseUnmatchPreview,
  type ManualVideoMatchCandidate, type ManualVideoMatchType, type ProviderDirectory,
} from "@/lib/api";

/** 在固定预览范围内选择 TMDB 作品，提交时由服务端再次核对文件关联版本。 */
export function LibraryBrowseManualMatchDialog({ libraryId, sourceId, entry, parent, preview, admin, onClose, onApplied }: {
  libraryId: string; sourceId: string; entry: LibraryBrowseEntry; parent: ProviderDirectory | undefined;
  preview: LibraryBrowseUnmatchPreview; admin: boolean; onClose: () => void; onApplied: (fileCount: number) => void;
}) {
  const [query, setQuery] = useState(entry.name.replace(/\.[^.]+$/u, ""));
  const [year, setYear] = useState("");
  const [mediaType, setMediaType] = useState<ManualVideoMatchType>("movie");
  const [candidates, setCandidates] = useState<ManualVideoMatchCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = candidates.find((candidate) => candidate.id === selectedId);

  /** 按名称、年份和影视类型读取候选，切换搜索条件会清除旧选择。 */
  async function search(): Promise<void> {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSelectedId(null);
    try {
      const result = await searchLibraryBrowseRangeMatch(libraryId, sourceId, {
        query: query.trim(), mediaType, year: year ? Number(year) : null,
      }, admin);
      setCandidates(result);
      if (result.length === 0) setError("没有找到结果，请修改名称、年份或影视类型");
    } catch (searchError) {
      setCandidates([]);
      setError(searchError instanceof Error ? searchError.message : "搜索失败");
    } finally {
      setBusy(false);
    }
  }

  /** 将用户确认的所有视频文件绑定到一个作品，节目保留季集与多版本关系。 */
  async function apply(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyLibraryBrowseRangeMatch(libraryId, sourceId, entry, parent, preview.revision,
        { mediaType: selected.mediaType, tmdbId: selected.id }, admin);
      onApplied(result.fileCount);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "手动匹配保存失败，请重新预览范围");
    } finally {
      setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-[70] grid place-items-center p-4">
    <button type="button" aria-label="关闭手动匹配" onClick={onClose} className="absolute inset-0 bg-black/75" />
    <section role="dialog" aria-modal="true" aria-label="文件范围手动匹配" className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-background p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">手动匹配 · {entry.name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">已扫描视频 {preview.fileCount} 个，涉及原媒体条目 {preview.itemCount} 个。</p>
        {entry.isDirectory && <p className="mt-1 text-sm text-amber-500">此文件夹内的所有已扫描视频将绑定到同一个电影或节目。</p>}
      </div><button type="button" onClick={onClose} className="text-sm text-muted-foreground">关闭</button></div>
      <div className="mt-3 space-y-1 text-xs text-muted-foreground">{preview.examples.map((example) => <p key={example} className="truncate">{example}</p>)}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        <select aria-label="影视类型" value={mediaType} onChange={(event) => { setMediaType(event.target.value as ManualVideoMatchType); setCandidates([]); setSelectedId(null); }} className="rounded-lg border border-border bg-background px-2 py-2 text-sm"><option value="movie">电影</option><option value="tv">节目</option></select>
        <input aria-label="影视名称" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} className="min-w-36 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        <input aria-label="年份" value={year} onChange={(event) => setYear(event.target.value.replace(/\D/gu, "").slice(0, 4))} placeholder="年份" className="w-20 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        <SecondaryButton type="button" disabled={busy || !query.trim()} onClick={() => void search()}>搜索</SecondaryButton>
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 min-h-24 flex-1 space-y-2 overflow-y-auto">
        {candidates.map((candidate) => <button type="button" key={`${candidate.mediaType}-${candidate.id}`} onClick={() => setSelectedId(candidate.id)} className={`w-full rounded-lg border p-3 text-left ${selectedId === candidate.id ? "border-foreground bg-secondary" : "border-border"}`}>
          <span className="block text-sm font-medium">{candidate.title} {candidate.year ? `(${candidate.year})` : ""}</span>
          <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{candidate.overview || candidate.originalTitle}</span>
        </button>)}
      </div>
      <div className="mt-4 flex justify-end gap-2"><SecondaryButton type="button" onClick={onClose}>取消</SecondaryButton>
        <PrimaryButton type="button" disabled={!selected || busy} onClick={() => void apply()}>{busy ? "处理中…" : `确认匹配 ${preview.fileCount} 个视频`}</PrimaryButton></div>
    </section>
  </div>;
}
