import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { getLibrary } from "@/lib/api";
import { deleteNativeAudiobookService, listNativeAudiobookServices, nativeAudiobookAddress, type NativeAudiobookService } from "@/lib/native-audiobook-api";
import { NativeAccountsPanel } from "./AccountsPanel";
import { copyNativeText, NativePager, NativeSkeleton, useNativeCursor, useNativeResource } from "./components";
import { NativeServiceEditor } from "./ServiceEditor";

/** 单库设置和统一听书服务管理复用本页面，不进入媒体库创建流程。 */
export function NativeAudiobookServicesPage({ libraryId, admin = false }: { libraryId?: string; admin?: boolean }) {
  const pager = useNativeCursor();
  const resource = useNativeResource(() => listNativeAudiobookServices(pager.cursor, libraryId), [pager.cursor, libraryId]);
  const library = useNativeResource(() => libraryId ? getLibrary(libraryId, admin).then((value) => value.library) : Promise.resolve(null), [libraryId, admin]);
  const [selected, setSelected] = useState<NativeAudiobookService | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";
  const listPath = admin ? "/admin/audiobook-services" : "/app/audiobook-services";

  /** 创建时只预选当前实际库，不复制源、实际库或账号。 */
  function beginCreate(): void { if (lock.current) return; setSelected(null); setCreating(true); setEditing(true); setMessage(null); }
  /** 当前入口配置保存后直接展示账号管理，刷新列表保留已有内容。 */
  function saved(service: NativeAudiobookService): void { setSelected(service); setCreating(false); setEditing(false); setMessage("听书入口已保存，可继续配置访问账号"); void resource.refresh(); }
  /** 管理当前入口的独立账号域，切换入口时清理明文密码展示状态。 */
  function select(service: NativeAudiobookService, edit = false): void { if (lock.current) return; setSelected(service); setCreating(false); setEditing(edit); setMessage(null); }
  /** 删除原生入口前说明影响范围，服务端保留实际媒体数据。 */
  async function remove(service: NativeAudiobookService): Promise<void> {
    if (lock.current || !window.confirm(`删除原生听书入口“${service.Name}”及其账号、设备登录和原生收听记录？已有媒体库、插件、ABS 和网盘数据会保留。`)) return;
    lock.current = true; setBusy(true); setMessage(null);
    try { await deleteNativeAudiobookService(service.ServiceId); if (selected?.ServiceId === service.ServiceId) { setSelected(null); setEditing(false); } await resource.refresh(); setMessage("原生听书入口已删除"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除入口失败"); }
    finally { lock.current = false; setBusy(false); }
  }
  /** 复制完整连接地址，优先使用云助手配置的公开入口。 */
  async function copy(service: NativeAudiobookService): Promise<void> {
    try { await copyNativeText(nativeAudiobookAddress(service)); setMessage("服务地址已复制"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "复制失败"); }
  }

  return <><PageHeader title={library.data ? `${library.data.displayName} · 原生听书` : "听书服务"} actions={<>
    {libraryId && <Link to={settingsPath} params={{ serviceId: libraryId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>}
    {libraryId && <Link to={listPath}><SecondaryButton>全部听书入口</SecondaryButton></Link>}
    <PrimaryButton disabled={busy || Boolean(libraryId && library.loading)} onClick={beginCreate}><Plus className="size-4" />{libraryId ? "新建听书入口" : "新建统一入口"}</PrimaryButton>
  </>} />
    {(message || library.error) && <Panel className="mb-3 p-3 sm:p-3"><p role="status" className="text-sm text-muted-foreground">{message || library.error}</p></Panel>}
    <Panel title={libraryId ? "关联的原生入口" : "原生听书入口"} description="独立入口与统一入口共用同一套管理方式，账号在各入口内独立。" className="mb-3 p-4 sm:p-4">
      {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}{!resource.data && resource.loading && <NativeSkeleton />}
      <div className="space-y-2">{resource.data?.Items.map((service) => <article key={service.ServiceId} className={`rounded-lg border p-3 ${selected?.ServiceId === service.ServiceId ? "border-foreground/60 bg-secondary/45" : "border-border bg-secondary/20"}`}><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{service.Name}</p><StatusPill tone={service.Enabled ? "success" : "neutral"}>{service.Deleting ? "删除中" : service.Enabled ? "已启用" : "未启用"}</StatusPill><span className="text-[11px] text-muted-foreground">{service.Mode === "SingleLibrary" ? "单库独立" : `多库统一 · ${service.LibraryIds.length} 个库`}</span></div><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{nativeAudiobookAddress(service)}</p></div><div className="flex flex-wrap gap-2"><SecondaryButton disabled={busy || service.Deleting} onClick={() => select(service)}><Settings2 className="size-3.5" />账号与设备</SecondaryButton><SecondaryButton disabled={busy || service.Deleting} onClick={() => select(service, true)}><Pencil className="size-3.5" />设置</SecondaryButton><SecondaryButton disabled={busy} onClick={() => void copy(service)}><Copy className="size-3.5" />复制地址</SecondaryButton><button type="button" disabled={busy} className="inline-flex items-center gap-1 px-2 text-sm text-destructive disabled:opacity-40" onClick={() => void remove(service)}><Trash2 className="size-3.5" />删除</button></div></div></article>)}</div>
      {resource.data?.Items.length === 0 && <p className="py-3 text-sm text-muted-foreground">当前页没有听书入口。新建后添加账号，再开启供客户端连接。</p>}
      <NativePager state={{ page: pager.page, loading: resource.loading || busy, hasNext: resource.data?.HasMore ?? false, onPrevious: pager.back, onNext: () => pager.next(resource.data?.NextCursor ?? null) }} />
    </Panel>
    {editing && <NativeServiceEditor key={creating ? `new:${libraryId ?? "all"}` : `${selected?.ServiceId}:${selected?.UpdatedAt}`} state={{ service: creating ? null : selected, initialLibrary: library.data ?? undefined, admin, onSaved: saved, onCancel: () => { setEditing(false); setCreating(false); } }} />}
    {selected && !creating && <NativeAccountsPanel key={selected.ServiceId} state={{ service: selected, admin }} />}
  </>;
}
