import { RefreshCw, Upload } from "lucide-react";
import { useCallback, useRef, useState, type MouseEvent, type SyntheticEvent } from "react";
import { PageHeader, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { StatusPill } from "@/components/ui-kit";
import { importPlugin, listPlugins, updatePluginStatus, type PluginVersion } from "@/lib/api";
import {
  importContentSourcePlugin,
  importPythonContentSourcePlugin,
  listContentSourcePlugins,
  uninstallContentSourcePlugin,
  updateContentSourcePlugin,
  type ContentSourcePlugin,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

const pluginStatusLabels = { enabled: "已启用", disabled: "已停用", imported: "待启用", uninstalled: "已卸载" } as const;

/** 列表内部保留接口来源，页面统一展示，不要求用户选择插件分类。 */
type PluginEntry = { kind: "source"; plugin: ContentSourcePlugin } | { kind: "metadata"; plugin: PluginVersion };

/** 为相同 ID 和版本的不同接口记录保留独立操作目标。 */
function getPluginKey(entry: PluginEntry): string {
  return `${entry.kind}:${entry.plugin.pluginId}@${entry.plugin.version}`;
}

/** 在详情中说明内容源对外提供的协议能力。 */
function describeSourceCapabilities(adapter: string): string {
  if (adapter === "netease_http") return "网易云音乐 · Navidrome";
  if (adapter === "cms_json") return "影视内容 · Jellyfin / Emby";
  if (adapter === "python_spider") return "影视内容 · Jellyfin / Emby";
  return adapter;
}

/** 只读取清单中的文字说明，不展示请求模板或敏感配置。 */
function getPluginDescription(entry: PluginEntry): string {
  if (entry.kind === "source") return entry.plugin.description || "暂无说明";
  const description = entry.plugin.manifest.description;
  return typeof description === "string" && description ? description : "暂无说明";
}

/** 将元数据插件声明的媒体类型转换为详情中的可读文本。 */
function describeMetadataCapabilities(plugin: PluginVersion): string {
  const mediaTypes = plugin.manifest.mediaTypes;
  if (!Array.isArray(mediaTypes)) return "媒体元数据";
  const labels: Record<string, string> = { video: "视频", music: "音乐", audiobook: "有声书" };
  const names = mediaTypes.filter((item): item is string => typeof item === "string").map((item) => labels[item] ?? item);
  return names.length > 0 ? names.join("、") : "媒体元数据";
}

/** 以可换行的字段展示插件详情，长 ID 和摘要不撑大弹窗。 */
function PluginDetailField({ label, value }: { label: string; value: string | number }) {
  return <div className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="min-w-0 break-all text-sm">{value}</dd></div>;
}

/** 统一插件导入与列表，具体类型由文件扩展名和既有服务端校验共同识别。 */
export function AdminPluginsPanel() {
  const sources = useApiResource(() => listContentSourcePlugins(), []);
  const metadata = useApiResource(() => listPlugins(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 关键变量：导入、启停和卸载共用操作锁，避免同一版本状态互相覆盖。
  const pendingRef = useRef(false);
  // 关键变量：合并展示但保留接口来源，详情始终读取刷新后的记录。
  const entries: PluginEntry[] = [
    ...(sources.data?.items ?? []).map((plugin): PluginEntry => ({ kind: "source", plugin })),
    ...(metadata.data?.items ?? []).map((plugin): PluginEntry => ({ kind: "metadata", plugin })),
  ];
  entries.sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName, "zh-CN"));
  const selectedEntry = entries.find((entry) => getPluginKey(entry) === selectedKey);
  const loading = sources.loading || metadata.loading;
  const initialLoading = (sources.loading && !sources.data) || (metadata.loading && !metadata.data);

  /** 并行刷新两套既有接口，单个接口报错不隐藏另一个接口的插件。 */
  async function refreshPlugins(): Promise<void> {
    await Promise.all([sources.refresh(), metadata.refresh()]);
  }

  /** 由原生文件控件直接接收点击，重新选择同一文件也能产生选择事件。 */
  function openPluginPicker(event: MouseEvent<HTMLInputElement>): void {
    event.currentTarget.value = "";
    setMessage("请选择插件文件，确认选择后将自动导入。");
  }

  /** 同步取出文件并清理控件；input/change 共用操作锁，只执行一次上传。 */
  function handlePluginFileSelection(event: SyntheticEvent<HTMLInputElement>): void {
    if (pendingRef.current) return;
    const file = event.currentTarget.files?.[0]; // 关键变量：先保留 File，不在异步流程中读取事件对象。
    if (!file) {
      setMessage("没有读取到插件文件，请重新选择。");
      return;
    }
    event.currentTarget.value = "";
    void selectPlugin(file);
  }

  /** 原生 cancel 事件绑定到实际控件，React 当前输入类型没有 onCancel 属性。 */
  const bindPluginPicker = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    /** 取消选择时明确显示结果，不让页面保持没有反馈的状态。 */
    const cancelSelection = (): void => {
      if (pendingRef.current) return;
      setMessage("未选择插件文件。");
    };
    input.addEventListener("cancel", cancelSelection);
    return () => input.removeEventListener("cancel", cancelSelection);
  }, []);

  /** 选择完成后按扩展名分发，文件选择框不限制系统识别的文件类型。 */
  async function selectPlugin(file: File | undefined): Promise<void> {
    if (!file || pendingRef.current) return;
    pendingRef.current = true;
    setPending("import");
    setMessage("正在导入插件…");
    try {
      // 关键变量：只依据实际文件名分发，避免 macOS 对 JSON 的 UTI 识别影响选择。
      const fileName = file.name.toLowerCase();
      if (fileName.endsWith(".json")) {
        const plugin = await importContentSourcePlugin(file);
        setMessage(`${plugin.displayName} ${plugin.version} 已导入，请启用后创建在线媒体库。`);
      } else if (fileName.endsWith(".py")) {
        const plugin = await importPythonContentSourcePlugin(file);
        setMessage(plugin.status === "enabled"
          ? `${plugin.displayName} ${plugin.version} 已安装并启用，可以创建在线媒体库。`
          : `${plugin.displayName} ${plugin.version} 已导入，请启用后创建在线媒体库。`);
      } else if (fileName.endsWith(".flymby-plugin")) {
        const plugin = await importPlugin(file);
        setMessage(`${plugin.displayName} ${plugin.version} 导入成功，请启用后使用。`);
      } else {
        throw new Error("请选择 .json、.py 或 .flymby-plugin 插件文件，系统会自动识别插件类型。");
      }
      await refreshPlugins();
    } catch (error) {
      setMessage(error instanceof SyntaxError ? "文件不是有效的 JSON 插件清单" : error instanceof Error ? error.message : "插件导入失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  /** 根据记录来源调用原来的启停接口，恢复卸载内容源仍走原启用流程。 */
  async function togglePlugin(entry: PluginEntry): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(getPluginKey(entry));
    try {
      const enabled = entry.plugin.status !== "enabled";
      if (entry.kind === "source") await updateContentSourcePlugin(entry.plugin, enabled);
      else await updatePluginStatus(entry.plugin, enabled);
      setMessage(`${entry.plugin.displayName} 已${enabled ? "启用" : "停用"}。`);
      await refreshPlugins();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "插件状态修改失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  /** 保留内容源原有卸载确认，既有目录和播放记录由服务端保留。 */
  async function uninstallPlugin(entry: PluginEntry): Promise<void> {
    if (entry.kind !== "source" || pendingRef.current) return;
    const plugin = entry.plugin;
    if (!window.confirm(`卸载“${plugin.displayName} ${plugin.version}”后，依赖它的在线库将停止同步和播放；已有目录及播放记录保留。确定卸载吗？`)) return;
    pendingRef.current = true;
    setPending(getPluginKey(entry));
    try {
      await uninstallContentSourcePlugin(plugin);
      setMessage(`${plugin.displayName} 已卸载，已有目录和播放记录保留。`);
      await refreshPlugins();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "插件卸载失败");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  return <>
    <PageHeader title="插件管理" actions={<>
      <span className="relative inline-flex rounded-lg focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-border">
        <SecondaryButton disabled={loading || pending !== null} tabIndex={-1} aria-hidden="true"><Upload aria-hidden="true" className="size-4" />{pending === "import" ? "正在导入…" : "导入插件"}</SecondaryButton>
        <input ref={bindPluginPicker} type="file" aria-label="导入插件" disabled={loading || pending !== null} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" onClick={openPluginPicker} onInput={handlePluginFileSelection} onChange={handlePluginFileSelection} />
      </span>
      <SecondaryButton disabled={loading || pending !== null} onClick={() => void refreshPlugins()}><RefreshCw aria-hidden="true" className="size-4" />刷新</SecondaryButton>
    </>} />
    <p className="mb-4 text-xs text-muted-foreground">选择插件文件即可导入，系统自动识别类型。</p>
    {sources.error && <p role="alert" className="mb-3 text-sm text-destructive">插件加载失败：{sources.error}</p>}
    {metadata.error && <p role="alert" className="mb-3 text-sm text-destructive">插件加载失败：{metadata.error}</p>}
    {message && <p role="status" className="mb-4 text-sm text-muted-foreground">{message}</p>}
    <div className="grid gap-3 lg:grid-cols-2">
      {initialLoading && [0, 1].map((index) => <div key={`loading-${index}`} aria-label="插件加载中" className="surface animate-pulse p-4"><div className="h-5 w-36 rounded bg-muted" /><div className="mt-4 h-8 w-40 rounded bg-muted" /></div>)}
      {entries.map((entry) => <article key={getPluginKey(entry)} className="surface p-4">
        <header className="flex items-center justify-between gap-3"><h2 className="min-w-0 truncate text-sm font-medium" title={entry.plugin.displayName}>{entry.plugin.displayName}</h2><StatusPill tone={entry.plugin.status === "enabled" ? "success" : "neutral"}>{pluginStatusLabels[entry.plugin.status]}</StatusPill></header>
        <footer className="mt-4 flex flex-wrap gap-2">
          <SecondaryButton disabled={pending !== null} onClick={() => void togglePlugin(entry)}>{pending === getPluginKey(entry) ? "正在处理…" : entry.plugin.status === "enabled" ? "停用" : entry.plugin.status === "uninstalled" ? "重新安装并启用" : "启用"}</SecondaryButton>
          <SecondaryButton onClick={() => setSelectedKey(getPluginKey(entry))}>详情</SecondaryButton>
          {entry.kind === "source" && entry.plugin.status !== "uninstalled" && <SecondaryButton disabled={pending !== null} onClick={() => void uninstallPlugin(entry)}>卸载</SecondaryButton>}
        </footer>
      </article>)}
    </div>
    {!loading && !sources.error && !metadata.error && entries.length === 0 && <p className="text-sm text-muted-foreground">暂无插件，请点击“导入插件”添加。</p>}
    {selectedEntry && <ContentSourceSettingsDialog state={{ title: "插件详情", busy: false, onClose: () => setSelectedKey(null), children: <dl className="space-y-4">
      <PluginDetailField label="名称" value={selectedEntry.plugin.displayName} />
      <PluginDetailField label="状态" value={pluginStatusLabels[selectedEntry.plugin.status]} />
      <PluginDetailField label="版本" value={selectedEntry.plugin.version} />
      <PluginDetailField label="插件 ID" value={selectedEntry.plugin.pluginId} />
      <PluginDetailField label="说明" value={getPluginDescription(selectedEntry)} />
      <PluginDetailField label="能力" value={selectedEntry.kind === "source" ? describeSourceCapabilities(selectedEntry.plugin.adapter) : describeMetadataCapabilities(selectedEntry.plugin)} />
      {selectedEntry.kind === "source" ? <>
        <PluginDetailField label="适配器" value={selectedEntry.plugin.adapter === "python_spider" ? "Python Spider" : selectedEntry.plugin.adapter} />
        <p className="text-xs text-muted-foreground">停用和卸载不会自动删除媒体库。恢复启用后可继续使用原目录和播放记录。</p>
      </> : <>
        <PluginDetailField label="配置修订" value={`r${selectedEntry.plugin.configurationRevision}`} />
        <PluginDetailField label="SHA256" value={selectedEntry.plugin.sha256} />
      </>}
    </dl> }} />}
  </>;
}
