import { Link } from "@tanstack/react-router";
import { Copy, LibraryBig, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentAudiobookLibraryPanel } from "@/components/ContentAudiobookLibraryPanel";
import { ContentSourceLibraryNameEditor } from "@/components/ContentSourceLibraryNameEditor";
import { Panel, StatusPill } from "@/components/ui-kit";
import type { MediaLibrary } from "@/lib/api";
import { getAbsSettings, resolveAbsAddress } from "@/lib/abs-api";
import { useApiResource } from "@/lib/use-api-resource";

/** 来源配置与 ABS 设置分开读取，在线书库不进入网盘路径和物理扫描流程。 */
export function LibraryContentAudiobookSettingsPage({ state }: { state: {
  library: MediaLibrary; admin: boolean; loading: boolean; clearingCatalog: boolean;
  message: string | null; onRefresh: () => Promise<void>; onClear: () => Promise<void>; onDelete: () => Promise<void>;
} }) {
  const { library, admin } = state;
  const abs = useApiResource(() => getAbsSettings(library.id, admin), [library.id, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";
  const catalogPath = admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog";
  const absPath = admin ? "/admin/libraries/$serviceId/abs" : "/app/libraries/$serviceId/abs";

  /** 用户主动复制客户端连接地址，普通 HTTP 页面沿用文本控件回退。 */
  async function copyAddress(): Promise<void> {
    if (!abs.data) return;
    const address = resolveAbsAddress(abs.data);
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(address);
      else {
        const input = document.createElement("textarea");
        input.value = address;
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("请手动复制地址");
      }
      setMessage("ABS 服务地址已复制。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复制失败，请手动复制。");
    }
  }

  return <>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <ContentSourceLibraryNameEditor state={{ libraryId: library.id, displayName: library.displayName, admin, loading: state.loading, onSaved: state.onRefresh }} />
      <div className="flex flex-wrap gap-2"><Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link><Link to={catalogPath} params={{ serviceId: library.id }}><PrimaryButton><LibraryBig className="size-4" />书库</PrimaryButton></Link></div>
    </div>
    {(state.message || message) && <Panel className="mb-3 p-3 sm:p-3"><p role="status" className="text-sm text-muted-foreground">{state.message || message}</p></Panel>}
    <div className="mb-3 grid gap-3 sm:grid-cols-3">
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">书籍摘要</span><span className="float-right text-sm">{library.itemCount.toLocaleString()}</span></Panel>
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">目录版本</span><span className="float-right text-sm">v{library.catalogVersion}</span></Panel>
      <Panel className="p-3 sm:p-3"><span className="text-xs text-muted-foreground">来源类型</span><span className="float-right text-sm">在线听书源</span></Panel>
    </div>
    <ContentAudiobookLibraryPanel state={{ libraryId: library.id, admin, onChanged: state.onRefresh }} />
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title="Audiobookshelf（ABS）" className="p-4 sm:p-4">
        {!abs.data && !abs.error && <div aria-label="ABS 配置加载中" className="animate-pulse space-y-3"><div className="h-5 w-24 rounded bg-muted" /><div className="h-9 rounded bg-muted" /></div>}
        {abs.error && <p role="alert" className="text-xs text-destructive">{abs.error}</p>}
        {abs.data && <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill tone={abs.data.enabled ? "success" : "neutral"}>{abs.data.enabled ? "已启用" : "未启用"}</StatusPill><Link to={absPath} params={{ serviceId: library.id }}><SecondaryButton><Settings2 className="size-4" />账号与协议设置</SecondaryButton></Link></div>
          <p className="break-all font-mono text-xs text-muted-foreground">{resolveAbsAddress(abs.data)}</p>
          <div><SecondaryButton onClick={() => void copyAddress()}><Copy className="size-4" />复制服务地址</SecondaryButton></div>
          <p className="text-xs text-muted-foreground">创建书库后，可在协议设置中添加账号并开启 ABS，使用有声书客户端收听。</p>
        </div>}
      </Panel>
      <Panel title="危险操作" description="清空在线目录或删除当前听书库。" className="p-4 sm:p-4">
        <div className="grid gap-2">
          <button type="button" disabled={state.clearingCatalog} onClick={() => void state.onClear()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-40"><Trash2 className="size-4" />{state.clearingCatalog ? "正在清空…" : "清空媒体库"}</button>
          <button type="button" disabled={state.clearingCatalog} onClick={() => void state.onDelete()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-40"><Trash2 className="size-4" />删除媒体库</button>
        </div>
      </Panel>
    </div>
  </>;
}
