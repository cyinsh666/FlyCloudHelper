import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { ContentSourceLibraryNameEditor } from "@/components/ContentSourceLibraryNameEditor";
import { liveApi, type LiveLibraryState } from "@/lib/live-api";
import { type MediaLibrary } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 直播沿用媒体库详情样式；设置、频道及免账号订阅地址在同一页面展示。 */
export function LibraryLiveSettingsPage({ state }: { state: { library: MediaLibrary; admin: boolean; message: string | null; onDelete: () => Promise<void> } }) {
  const { library, admin } = state;
  const resource = useApiResource(() => liveApi<LiveLibraryState>(library.id, admin), [library.id, admin]);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"direct" | "relay">("relay");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [epgUrl, setEpgUrl] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const initialized = useRef("");
  const [message, setMessage] = useState<string | null>(null);
  const data = resource.data;

  // 关键变量：运行状态刷新不重置未保存的频道配置，避免一处操作导致整个表单刷新。
  useEffect(() => {
    if (!data || initialized.current === library.id) return;
    initialized.current = library.id;
    setEnabled(data.configuration.enabled); setMode(data.configuration.playbackMode);
    setChannelIds(data.configuration.channelIds); setEpgUrl(data.configuration.epgUrl);
  }, [data, library.id]);

  /** 同一页面只允许一次写入；失败保留草稿，并显示服务端原始提示。 */
  async function action(operation: () => Promise<unknown>, success: string): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(true); setMessage(null);
    try { await operation(); setMessage(success); await resource.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { busy.current = false; setPending(false); }
  }

  /** 保存时只提交直播配置，不触发影视扫描或来源内容同步。 */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await action(() => liveApi(library.id, admin, "", "PATCH", { enabled, playbackMode: mode, channelIds, epgUrl }), "直播配置已保存");
  }

  /** 用户确认后只重置当前库地址；已添加到播放器的旧地址需要替换。 */
  async function resetSubscription(): Promise<void> {
    if (busy.current || !window.confirm("重置 M3U 地址后，旧订阅及频道地址将失效，需要在播放器中重新添加。是否继续？")) return;
    await action(() => liveApi(library.id, admin, "/subscription/reset", "POST", {}), "M3U 地址已重置，请复制新地址并更新播放器中的订阅");
  }

  /** 删除沿用父页确认和导航，只占用当前页面操作锁，不在删除后再读取已不存在的库。 */
  async function deleteCurrent(): Promise<void> {
    if (busy.current) return;
    busy.current = true; setPending(true); setMessage(null);
    try { await state.onDelete(); }
    finally { busy.current = false; setPending(false); }
  }

  /** 频道选择只更新本地草稿，由保存按钮一次性提交。 */
  function toggleChannel(id: string): void { setChannelIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }

  if (!data) return <Panel>{resource.error ? <div><p role="alert" className="text-sm text-destructive">{resource.error}</p><SecondaryButton onClick={() => void resource.refresh()}>重新读取</SecondaryButton></div>
    : <div aria-label="直播设置加载中" className="animate-pulse space-y-3"><div className="h-7 w-48 rounded bg-muted" /><div className="h-28 rounded bg-muted" /><div className="h-48 rounded bg-muted" /></div>}</Panel>;
  const visibleChannels = data.channels.filter((channel) => `${channel.name} ${channel.group}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const inputClass = "mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm";
  return <div className="grid gap-4">
    <ContentSourceLibraryNameEditor state={{ libraryId: library.id, displayName: data.displayName, admin, loading: pending, onSaved: resource.refresh }} />
    {(message || state.message || resource.error) && <p role="status" className="text-sm text-muted-foreground">{message || state.message || resource.error}</p>}
    <Panel className="p-4"><form onSubmit={(event) => void save(event)} className="grid gap-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">直播订阅设置</h2><p className="mt-1 text-xs text-muted-foreground">来源：{data.source.displayName} · {data.source.pluginStatus === "enabled" ? "插件已启用" : "插件未启用"} · 服务{data.runtimeStatus === "running" ? "运行中" : data.runtimeStatus === "starting" ? "启动中" : "未运行"}</p></div><SecondaryButton disabled={pending} onClick={() => void resource.refresh()}>刷新状态</SecondaryButton></div>
      <div className="rounded-lg border border-border p-3"><label><span className="text-sm font-medium">M3U 订阅地址</span><input readOnly aria-label="M3U 订阅地址" value={data.subscriptionUrl} onFocus={(event) => event.target.select()} className={`${inputClass} font-mono text-xs`} /></label><div className="mt-2"><SecondaryButton disabled={pending} onClick={() => void resetSubscription()}>重置地址</SecondaryButton></div><p className="mt-2 text-xs text-muted-foreground">无需账号和密码，点击地址全选后复制到 IPTV 客户端。{data.configuration.enabled ? "订阅已开启，首次播放会自动启动服务。" : "请先开启订阅并保存设置。"} 持有地址即可访问；重置后旧地址失效，关闭订阅后停止提供内容。</p></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} />启用 M3U 直播订阅</label>
      <div className="grid gap-3 sm:grid-cols-2"><label><span className="text-xs text-muted-foreground">默认播放方式</span><select className={inputClass} value={mode} disabled={pending} onChange={(event) => setMode(event.target.value as "direct" | "relay")}><option value="relay">中转</option><option value="direct">直连</option></select></label>
        <label><span className="text-xs text-muted-foreground">EPG 节目单地址（可选）</span><input type="url" className={inputClass} value={epgUrl} list={`live-epg-${library.id}`} disabled={pending} onChange={(event) => setEpgUrl(event.target.value)} placeholder="留空不附带节目单" /><datalist id={`live-epg-${library.id}`}>{data.epgSuggestions.map((url) => <option key={url} value={url} />)}</datalist></label></div>
      <p className="text-xs text-muted-foreground">中转由云助手转发视频分片；直连由客户端访问源站。标记“需中转”的频道依赖设备签名，订阅中固定使用中转。其他频道的直连效果取决于源站和播放器。</p>
      <div className="flex flex-wrap items-center gap-2"><PrimaryButton type="submit" disabled={pending || !channelIds.length}>保存设置</PrimaryButton><SecondaryButton disabled={pending || !data.configuration.enabled} onClick={() => void action(() => liveApi(library.id, admin, "/start", "POST", {}), "直播服务已启动")}>启动服务</SecondaryButton></div>
      <p className="text-xs text-muted-foreground">保存并开启订阅后，首次播放也会自动启动来源服务。仅展示频道或获取订阅地址不会注册设备；设备状态独立保存，附加 Web WASM 引擎本轮未启用。</p>
      <fieldset disabled={pending} className="grid gap-2"><legend className="text-sm font-medium">订阅频道（已选 {channelIds.length} / {data.channels.length}）</legend><div className="flex flex-wrap items-center gap-2"><input className={`${inputClass} max-w-xs`} placeholder="搜索频道或分组" value={search} onChange={(event) => setSearch(event.target.value)} /><SecondaryButton onClick={() => setChannelIds(data.channels.map((channel) => channel.id))}>全选</SecondaryButton><SecondaryButton onClick={() => setChannelIds([])}>取消全选</SecondaryButton></div>
        {[...new Set(visibleChannels.map((channel) => channel.group))].map((group) => <div key={group}><p className="my-2 text-xs text-muted-foreground">{group}</p><div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{visibleChannels.filter((channel) => channel.group === group).map((channel) => <label key={channel.id} className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${channelIds.includes(channel.id) ? "border-foreground" : "border-border"}`}><input type="checkbox" checked={channelIds.includes(channel.id)} onChange={() => toggleChannel(channel.id)} /><span className="min-w-0 flex-1 truncate">{channel.name}</span><span className="shrink-0 text-xs text-muted-foreground">{channel.requiresRelay ? "需中转" : ""}{channel.catchup ? " 回看" : ""}</span></label>)}</div></div>)}
      </fieldset></form></Panel>
    <Panel className="p-4"><h2 className="text-sm font-medium">媒体库管理</h2><p className="my-2 text-xs text-muted-foreground">删除当前直播库会停止其来源进程，保留已安装插件和其他媒体库、网盘服务。</p><SecondaryButton disabled={pending} onClick={() => void deleteCurrent()}>删除媒体库</SecondaryButton></Panel>
  </div>;
}
