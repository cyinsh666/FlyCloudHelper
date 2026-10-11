import { useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  importContentSourcePlugin,
  listContentSourcePlugins,
  uninstallContentSourcePlugin,
  updateContentSourcePlugin,
  type ContentSourcePlugin,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

const pluginStatusLabels = { enabled: "已启用", disabled: "已停用", imported: "待启用", uninstalled: "已卸载" } as const;

/** 独立管理内容源插件，现有元数据插件仍使用原来的安装入口。 */
export function AdminContentSourcePluginsPanel() {
  const resource = useApiResource(() => listContentSourcePlugins(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // 关键变量：导入与启停串行执行，避免同一插件状态相互覆盖。
  const pendingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /** 导入单个 JSON 源插件，结构及能力由服务端检验。 */
  async function importManifest(file: File | undefined): Promise<void> {
    if (!file || pendingRef.current) return;
    pendingRef.current = true;
    setPending("import");
    setMessage("正在导入内容源插件…");
    try {
      const plugin = await importContentSourcePlugin(file);
      setMessage(`${plugin.displayName} ${plugin.version} 已导入，请启用后创建在线媒体库。`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof SyntaxError ? "文件不是有效的 JSON 插件清单" : error instanceof Error ? error.message : "内容源插件导入失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  /** 启停独立插件；停用时保留媒体库和播放记录。 */
  async function togglePlugin(plugin: ContentSourcePlugin): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(`${plugin.pluginId}@${plugin.version}`);
    try {
      const enabled = plugin.status !== "enabled";
      await updateContentSourcePlugin(plugin, enabled);
      setMessage(`${plugin.displayName} 已${enabled ? "启用" : "停用"}。已有媒体库和播放记录保留。`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容源插件状态修改失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  /** 卸载前说明保留的数据和受影响的同步、播放能力。 */
  async function uninstallPlugin(plugin: ContentSourcePlugin): Promise<void> {
    if (pendingRef.current || !window.confirm(`卸载“${plugin.displayName} ${plugin.version}”后，依赖它的在线库将停止同步和播放；已有目录及播放记录保留。确定卸载吗？`)) return;
    pendingRef.current = true;
    setPending(`${plugin.pluginId}@${plugin.version}`);
    try {
      await uninstallContentSourcePlugin(plugin);
      setMessage(`${plugin.displayName} 已卸载，已有目录和播放记录保留。`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容源插件卸载失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  return <Panel title="内容源插件" description="每个具体源作为独立插件安装和启停，用户据此创建独立在线媒体库。" className="mb-5" action={<div className="flex flex-wrap gap-2"><SecondaryButton disabled={pending !== null} onClick={() => fileInput.current?.click()}>导入源插件</SecondaryButton><SecondaryButton disabled={resource.loading} onClick={() => void resource.refresh()}>刷新</SecondaryButton><input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => void importManifest(event.target.files?.[0])} /></div>}>
    {resource.loading && !resource.data && <div aria-label="内容源插件加载中" className="grid animate-pulse gap-3 lg:grid-cols-2">{[0, 1].map((index) => <div key={index} className="rounded-xl border border-border p-4"><div className="h-5 w-40 rounded bg-muted" /><div className="mt-3 h-4 rounded bg-muted" /><div className="mt-4 h-8 w-24 rounded bg-muted" /></div>)}</div>}
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    <div className="grid gap-3 lg:grid-cols-2">{resource.data?.items.map((plugin) => <article key={`${plugin.pluginId}@${plugin.version}`} className="rounded-xl border border-border p-4"><header className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm">{plugin.displayName}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{plugin.pluginId} · {plugin.version}</p></div><StatusPill>{pluginStatusLabels[plugin.status]}</StatusPill></header><p className="mt-3 text-xs text-muted-foreground">{plugin.description}</p><div className="mt-4 flex flex-wrap gap-2"><SecondaryButton disabled={pending !== null} onClick={() => void togglePlugin(plugin)}>{pending === `${plugin.pluginId}@${plugin.version}` ? "正在处理…" : plugin.status === "enabled" ? "停用" : plugin.status === "uninstalled" ? "重新安装并启用" : "启用"}</SecondaryButton>{plugin.status !== "uninstalled" && <SecondaryButton disabled={pending !== null} onClick={() => void uninstallPlugin(plugin)}>卸载</SecondaryButton>}</div></article>)}</div>
    {resource.data?.items.length === 0 && <p className="text-sm text-muted-foreground">没有可用的内容源插件，请导入一个源插件清单。</p>}
    <p className="mt-4 text-xs text-muted-foreground">停用和卸载不会自动删除媒体库。恢复启用后可继续使用原目录和播放记录。</p>
    {message && <p role="status" className="mt-3 text-sm text-muted-foreground">{message}</p>}
  </Panel>;
}
