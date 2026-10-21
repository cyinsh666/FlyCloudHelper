import { Link } from "@tanstack/react-router";
import { LibraryBig, Trash2 } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentAudiobookLibraryPanel } from "@/components/ContentAudiobookLibraryPanel";
import { ContentSourceLibraryNameEditor } from "@/components/ContentSourceLibraryNameEditor";
import { Panel } from "@/components/ui-kit";
import { LibraryAudiobookProtocols } from "@/components/LibraryAudiobookProtocols";
import type { MediaLibrary } from "@/lib/api";

/** 来源配置与 ABS 设置分开读取，在线书库不进入网盘路径和物理扫描流程。 */
export function LibraryContentAudiobookSettingsPage({ state }: { state: {
  library: MediaLibrary; admin: boolean; loading: boolean; clearingCatalog: boolean;
  message: string | null; onRefresh: () => Promise<void>; onClear: () => Promise<void>; onDelete: () => Promise<void>;
} }) {
  const { library, admin } = state;
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";
  const catalogPath = admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog";

  return <>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <ContentSourceLibraryNameEditor state={{ libraryId: library.id, displayName: library.displayName, admin, loading: state.loading, onSaved: state.onRefresh }} />
      <div className="flex flex-wrap gap-2"><Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link><Link to={catalogPath} params={{ serviceId: library.id }}><PrimaryButton><LibraryBig className="size-4" />书库</PrimaryButton></Link></div>
    </div>
    {state.message && <Panel className="mb-3 p-3 sm:p-3"><p role="status" className="text-sm text-muted-foreground">{state.message}</p></Panel>}
    <div className="mb-3 grid gap-3 sm:grid-cols-3">
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">书籍摘要</span><span className="float-right text-sm">{library.itemCount.toLocaleString()}</span></Panel>
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">目录版本</span><span className="float-right text-sm">v{library.catalogVersion}</span></Panel>
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">来源类型</span><span className="float-right text-sm">在线听书源</span></Panel>
    </div>
    <ContentAudiobookLibraryPanel state={{ libraryId: library.id, admin, onChanged: state.onRefresh }} />
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(240px,1fr)]">
      <LibraryAudiobookProtocols state={{ library, admin }} />
      <Panel title="危险操作" description="清空在线目录或删除当前听书库。" className="p-4 sm:p-4">
        <div className="grid gap-2">
          <button type="button" disabled={state.clearingCatalog} onClick={() => void state.onClear()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-40"><Trash2 className="size-4" />{state.clearingCatalog ? "正在清空…" : "清空媒体库"}</button>
          <button type="button" disabled={state.clearingCatalog} onClick={() => void state.onDelete()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-40"><Trash2 className="size-4" />删除媒体库</button>
        </div>
      </Panel>
    </div>
  </>;
}
