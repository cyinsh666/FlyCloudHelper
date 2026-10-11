import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import {
  createContentSource,
  createContentSourceLibrary,
  listContentSourceCategories,
  listContentSourcePlugins,
  listContentSources,
  type ContentSourceCategory,
  type ContentSourceInstance,
  type ContentSourceLibraryCreateResult,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

/** 分步骤创建独立在线源媒体库，分类读取失败时允许继续使用已创建的实例。 */
export function ContentSourceLibraryCreate() {
  const navigate = useNavigate();
  const resource = useApiResource(async () => {
    const [plugins, sources] = await Promise.all([listContentSourcePlugins(), listContentSources()]);
    return { plugins: plugins.items.filter((plugin) => plugin.status === "enabled"), sources: sources.items };
  }, []);
  const [pluginKey, setPluginKey] = useState("");
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [displayName, setDisplayName] = useState("在线影视库");
  const [source, setSource] = useState<ContentSourceInstance | null>(null);
  const [categories, setCategories] = useState<ContentSourceCategory[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<ContentSourceLibraryCreateResult | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  // 关键变量：立即占用提交，避免同一点击在状态更新前创建两个源实例。
  const busyRef = useRef(false);
  const plugins = resource.data?.plugins ?? [];
  const plugin = plugins.find((entry) => `${entry.pluginId}@${entry.version}` === pluginKey);
  const existingSources = resource.data?.sources.filter((entry) => (
    entry.libraryId === null && entry.status === "active" && entry.pluginStatus === "enabled"
      && plugin !== undefined && entry.pluginId === plugin.pluginId && entry.pluginVersion === plugin.version
  )) ?? [];
  // 关键变量：只展示叶分类，避免选择一个父分类后导入全部内容。
  const leafCategories = categories.filter((entry) => !categories.some((child) => child.parentId === entry.id));

  useEffect(() => {
    if (plugins.length > 0 && !pluginKey) {
      const first = plugins[0]!;
      setPluginKey(`${first.pluginId}@${first.version}`);
      setSourceName(first.displayName);
    }
  }, [pluginKey, plugins]);

  /** 更换插件时丢弃旧分类，保证创建请求始终属于当前选择的实例。 */
  function selectPlugin(key: string): void {
    setPluginKey(key);
    setSelectedInstanceId("");
    setSource(null);
    setCategories([]);
    setCategoryIds([]);
    setMessage(null);
    setSourceName(plugins.find((entry) => `${entry.pluginId}@${entry.version}` === key)?.displayName ?? "");
  }

  /** 更换未绑定的源实例后，需要重新读取该实例的分类。 */
  function selectInstance(id: string): void {
    setSelectedInstanceId(id);
    setSource(null);
    setCategories([]);
    setCategoryIds([]);
    setMessage(null);
  }

  /** 仅在用户点击后创建源实例并读取分类，避免页面打开时写入数据。 */
  async function readCategories(): Promise<void> {
    if (!plugin || busyRef.current) return;
    if (!selectedInstanceId && !sourceName.trim()) {
      setMessage("请填写内容源名称");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage("正在读取内容源分类…");
    try {
      const currentSource = source ?? (selectedInstanceId
        ? existingSources.find((entry) => entry.id === selectedInstanceId)
        : await createContentSource({ pluginId: plugin.pluginId, pluginVersion: plugin.version, displayName: sourceName.trim() }));
      if (!currentSource) throw new Error("所选内容源不可用，请重新选择");
      setSource(currentSource);
      const result = await listContentSourceCategories(currentSource.id);
      setCategories(result.items);
      setCategoryIds([]);
      setMessage(result.items.length > 0 ? "请选择要导入的分类，首轮仅同步少量内容。" : "当前源没有返回可选分类。");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "分类读取失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 切换明确的视频分类，不默认选中任何分类。 */
  function toggleCategory(id: string): void {
    setCategoryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  /** 全选当前可用视频叶分类，或清空用户的选择。 */
  function selectAllCategories(selected: boolean): void {
    setCategoryIds(selected ? leafCategories.map((category) => category.id) : []);
  }

  /** 创建媒体库后进入现有协议与同步设置页。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!source || busyRef.current) return;
    if (!displayName.trim() || categoryIds.length === 0) {
      setMessage("请填写媒体库名称，并至少选择一个分类");
      return;
    }
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 3) {
      setMessage("初次同步页数必须为 1 至 3");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage("正在创建媒体库并启动目录同步…");
    try {
      const result = await createContentSourceLibrary(source.id, { displayName: displayName.trim(), categoryIds, initialPageCount: pageCount });
      setCreated(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "在线媒体库创建失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (created) return <div className="grid gap-4">
    <p className="text-sm">媒体库已创建，正在后台同步首批样本：每个电影分类最多 3 部、节目分类最多 1 部。</p>
    <p className="text-xs text-muted-foreground">请保存初始协议账号和密码。离开页面后，可在 Jellyfin、Emby 配置中重新设置密码。</p>
    {([ ["Jellyfin", created.accessCredentials], ["Emby", created.embyAccessCredentials] ] as const).map(([protocol, credentials]) => credentials && <div key={protocol} className="rounded-xl border border-border p-4"><p className="text-sm">{protocol} 初始账号</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="text-xs text-muted-foreground">账号</span><input readOnly value={credentials.account.username} onFocus={(event) => event.currentTarget.select()} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label><label><span className="text-xs text-muted-foreground">初始密码</span><input type={showPasswords ? "text" : "password"} readOnly value={credentials.password} autoComplete="off" onFocus={(event) => event.currentTarget.select()} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label></div></div>)}
    <div className="flex flex-wrap gap-2"><SecondaryButton onClick={() => setShowPasswords((current) => !current)}>{showPasswords ? "隐藏密码" : "显示密码"}</SecondaryButton><PrimaryButton onClick={() => void navigate({ to: "/app/libraries/$serviceId/settings", params: { serviceId: created.libraryId } })}>进入媒体库设置</PrimaryButton></div>
  </div>;
  if (!resource.data) return resource.error
    ? <div><p role="alert" className="text-sm text-destructive">{resource.error}</p><div className="mt-3"><SecondaryButton onClick={() => void resource.refresh()}>重新读取</SecondaryButton></div></div>
    : <div aria-label="内容源加载中" className="animate-pulse space-y-4"><div className="h-5 w-40 rounded bg-muted" /><div className="h-12 rounded bg-muted" /><div className="h-12 rounded bg-muted" /></div>;
  if (plugins.length === 0) return <p className="text-sm text-muted-foreground">暂无已启用的内容源插件，请管理员在“插件管理 → 内容源插件”中导入并启用插件。</p>;

  return <form onSubmit={(event) => void submit(event)} className="grid gap-5">
    <p className="text-xs text-muted-foreground">每个内容源配置实例对应一个独立在线库，通过 Jellyfin、Emby 客户端访问。</p>
    <fieldset disabled={busy || source !== null}>
      <legend className="text-xs text-muted-foreground">内容源插件</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">{plugins.map((entry) => {
        const key = `${entry.pluginId}@${entry.version}`;
        return <button key={key} type="button" aria-pressed={pluginKey === key} onClick={() => selectPlugin(key)} className={`rounded-xl border p-4 text-left disabled:opacity-60 ${pluginKey === key ? "border-foreground" : "border-border"}`}><span className="block text-sm">{entry.displayName}</span><span className="mt-1 block text-xs text-muted-foreground">{entry.description} · {entry.version}</span></button>;
      })}</div>
    </fieldset>
    {existingSources.length > 0 && <label><span className="text-xs text-muted-foreground">源配置实例</span><select disabled={busy || source !== null} value={selectedInstanceId} onChange={(event) => selectInstance(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">新建一个源配置实例</option>{existingSources.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select></label>}
    {!selectedInstanceId && <label><span className="text-xs text-muted-foreground">内容源名称</span><input disabled={busy || source !== null} required value={sourceName} maxLength={100} onChange={(event) => setSourceName(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>}
    <div className="flex flex-wrap gap-2"><SecondaryButton disabled={busy} onClick={() => void readCategories()}>{busy && categories.length === 0 ? "正在读取…" : categories.length > 0 ? "重新读取分类" : "读取分类"}</SecondaryButton>{source && <SecondaryButton disabled={busy} onClick={() => selectPlugin(pluginKey)}>更换内容源</SecondaryButton>}</div>
    {leafCategories.length > 0 && <fieldset disabled={busy}><legend className="text-xs text-muted-foreground">导入分类（已选 {categoryIds.length} 个）</legend><div className="mt-2 flex flex-wrap gap-2"><SecondaryButton disabled={busy} onClick={() => selectAllCategories(true)}>全选</SecondaryButton><SecondaryButton disabled={busy} onClick={() => selectAllCategories(false)}>取消全选</SecondaryButton></div><div className="mt-3 grid gap-2 sm:grid-cols-3">{leafCategories.map((category) => <button key={category.id} type="button" aria-pressed={categoryIds.includes(category.id)} onClick={() => toggleCategory(category.id)} className={`rounded-lg border px-3 py-2.5 text-left text-sm ${categoryIds.includes(category.id) ? "border-foreground" : "border-border"}`}>{category.name}</button>)}</div></fieldset>}
    <label><span className="text-xs text-muted-foreground">媒体库名称</span><input disabled={busy} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
    <label><span className="text-xs text-muted-foreground">初次查找页数（每个分类）</span><input disabled={busy} type="number" min={1} max={3} step={1} value={pageCount} onChange={(event) => setPageCount(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /><span className="mt-2 block text-xs text-muted-foreground">默认从每类 1 页查找样本，最多查找 3 页。首批每个电影分类最多导入 3 部、节目分类最多 1 部；验证播放后，可在媒体库设置中继续导入。</span></label>
    <div><PrimaryButton type="submit" disabled={busy || !source || categoryIds.length === 0 || !displayName.trim()}>{busy && categories.length > 0 ? "正在处理…" : "创建在线媒体库"}</PrimaryButton></div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
  </form>;
}
