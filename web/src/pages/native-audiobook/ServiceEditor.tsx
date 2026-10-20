import { useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import type { MediaLibrary } from "@/lib/api";
import { listNativeLibraryChoices, saveNativeAudiobookService, type NativeAudiobookService } from "@/lib/native-audiobook-api";
import { NativePager, NativeSkeleton, NativeToggle, useNativeResource } from "./components";

/** 原生入口创建和编辑使用同一份有界实际库选择器。 */
function LibraryPicker({ state }: { state: { admin: boolean; ownerUserId?: string; selected: string[]; busy: boolean; onToggle: (library: MediaLibrary) => void; onClear: () => void } }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const resource = useNativeResource(() => listNativeLibraryChoices(state.admin, offset, appliedSearch, state.ownerUserId), [state.admin, offset, appliedSearch, state.ownerUserId]);
  /** 搜索只读取匹配的当前页，不能把全部媒体库下载后筛选。 */
  function applySearch(event: { preventDefault: () => void }): void { event.preventDefault(); if (resource.loading) return; setOffset(0); setAppliedSearch(search.trim()); }
  return <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-sm">关联听书库 · 已选 {state.selected.length}/100</legend><div className="flex gap-2"><input className="input min-w-0 flex-1" aria-label="查找听书库" placeholder="按名称查找听书库" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applySearch(event); }} /><SecondaryButton disabled={resource.loading || state.busy} onClick={(event) => applySearch(event)}>查找</SecondaryButton></div>
    {!resource.data && resource.loading && <div className="mt-2"><NativeSkeleton /></div>}{resource.error && <p role="alert" className="mt-2 text-xs text-destructive">{resource.error}</p>}
    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">{resource.data?.items.map((library) => <label key={library.id} className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${state.selected.includes(library.id) ? "border-foreground/60 bg-secondary/60" : "border-border"}`}><input type="checkbox" disabled={state.busy || resource.loading} checked={state.selected.includes(library.id)} onChange={() => state.onToggle(library)} /><span className="min-w-0"><span className="block truncate">{library.displayName}</span>{state.admin && <span className="block truncate text-[11px] text-muted-foreground">{library.ownerUsername}</span>}</span></label>)}</div>
    {resource.data?.items.length === 0 && <p className="py-3 text-xs text-muted-foreground">没有匹配的听书库。</p>}
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><button type="button" disabled={state.busy || !state.selected.length} className="text-xs text-muted-foreground underline disabled:opacity-40" onClick={state.onClear}>清除已选库，重新选择</button><span className="text-[11px] text-muted-foreground">调整后需点击保存生效</span></div><NativePager state={{ page: offset / 20 + 1, loading: resource.loading || state.busy, hasNext: offset + 20 < (resource.data?.total ?? 0), onPrevious: () => setOffset((value) => Math.max(0, value - 20)), onNext: () => setOffset((value) => value + 20) }} />
  </fieldset>;
}

/** 协议入口单独配置，不触发媒体库新建、源导入或 ABS 修改。 */
export function NativeServiceEditor({ state }: { state: { service: NativeAudiobookService | null; initialLibrary?: MediaLibrary; admin: boolean; onSaved: (service: NativeAudiobookService) => void; onCancel: () => void } }) {
  const [name, setName] = useState(state.service?.Name ?? (state.initialLibrary ? `${state.initialLibrary.displayName}听书` : "我的听书服务"));
  const [mode, setMode] = useState<NativeAudiobookService["Mode"]>(state.service?.Mode ?? (state.initialLibrary ? "SingleLibrary" : "MultiLibrary"));
  const [suffix, setSuffix] = useState(state.service?.PathSuffix ?? state.initialLibrary?.id ?? "mybooks");
  const [ids, setIds] = useState(state.service?.LibraryIds ?? (state.initialLibrary ? [state.initialLibrary.id] : []));
  const [owner, setOwner] = useState<string | undefined>(state.service?.OwnerUserId ?? state.initialLibrary?.userId);
  const [enabled, setEnabled] = useState(state.service?.Enabled ?? false);
  const [relay, setRelay] = useState(state.service?.RelayPlaybackEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：立即锁定保存，避免重绘前多次创建同一入口。
  const lock = useRef(false);

  /** 选择实际库时保留单库模式限制，多库仍属于同一云助手用户。 */
  function toggleLibrary(library: MediaLibrary): void {
    if (lock.current) return;
    if (ids.includes(library.id)) {
      const next = ids.filter((id) => id !== library.id); setIds(next);
      if (!next.length && !state.service) setOwner(undefined);
    } else {
      if (owner && owner !== library.userId) { setError("同一入口的听书库必须属于同一用户"); return; }
      if (ids.length >= 100) { setError("一个入口最多关联 100 个听书库"); return; }
      setOwner(library.userId); setIds(mode === "SingleLibrary" ? [library.id] : [...ids, library.id]);
    }
  }

  /** 保存独立协议配置，移除关联只清理其原生访问授权。 */
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault(); if (lock.current) return;
    if (!ids.length || mode === "SingleLibrary" && ids.length !== 1) { setError("请选择与入口模式一致的听书库"); return; }
    if (state.service?.LibraryIds.some((id) => !ids.includes(id)) && !window.confirm("移除关联后，原生账号将失去这些库的访问授权；以后重新关联需要重新授权。实际媒体库和 ABS 配置会保留。继续保存？")) return;
    if (state.service?.Enabled && !enabled && !window.confirm("关闭入口会撤销现有设备登录，重新开启后需要重新登录。继续？")) return;
    lock.current = true; setBusy(true); setError(null);
    try { state.onSaved(await saveNativeAudiobookService(state.service?.ServiceId ?? null, { Name: name.trim(), Mode: mode, PathSuffix: suffix.trim(), LibraryIds: ids, Enabled: enabled, RelayPlaybackEnabled: relay })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "入口保存失败"); }
    finally { lock.current = false; setBusy(false); }
  }

  return <Panel title={state.service ? "原生听书设置" : "新建听书入口"} description="一个入口使用独立账号；多库入口共用地址，并按账号授权。" className="mb-3 p-4 sm:p-4">
    <form onSubmit={(event) => void save(event)} className="space-y-3">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-3 md:grid-cols-2"><label className="text-xs text-muted-foreground">服务名称<input required maxLength={128} className="input mt-1" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label><label className="text-xs text-muted-foreground">入口模式<select className="input mt-1" value={mode} disabled={busy} onChange={(event) => { const next = event.target.value as NativeAudiobookService["Mode"]; setMode(next); if (next === "SingleLibrary") setIds((value) => value.slice(0, 1)); }}><option value="SingleLibrary">单库独立入口</option><option value="MultiLibrary">多库统一入口</option></select></label></div>
      <div className="grid gap-2 md:grid-cols-2"><NativeToggle state={{ label: "启用原生听书", description: "关闭后保留账号和收听数据", checked: enabled, disabled: busy, onChange: setEnabled }} /><NativeToggle state={{ label: "中转播放", description: "关闭后优先直连；来源需要额外请求头时仍需中转", checked: relay, disabled: busy, onChange: setRelay }} /></div>
      <label className="block text-xs text-muted-foreground">服务地址<div className="mt-1 flex items-center gap-2"><span className="font-mono text-xs">/a/</span><input required maxLength={64} pattern="[\p{L}\p{N}_\-]+" className="input flex-1" value={suffix} disabled={busy} onChange={(event) => setSuffix(event.target.value)} /></div></label>
      <LibraryPicker key={owner ?? "all"} state={{ admin: state.admin, ownerUserId: owner, selected: ids, busy, onToggle: toggleLibrary, onClear: () => { setIds([]); if (!state.service) setOwner(undefined); } }} />
      <p className="text-xs text-muted-foreground">新增关联不会自动扩大已有账号授权。使用支持 FlyAudioBook 原生协议的客户端连接。</p>
      <div className="flex flex-wrap gap-2"><PrimaryButton type="submit" disabled={busy}>{busy ? "正在保存…" : state.service ? "保存设置" : "创建入口"}</PrimaryButton><SecondaryButton disabled={busy} onClick={state.onCancel}>取消</SecondaryButton></div>
    </form>
  </Panel>;
}
