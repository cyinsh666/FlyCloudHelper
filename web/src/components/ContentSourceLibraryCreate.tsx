import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import {
  createContentSourcePluginLibrary,
  listContentSourcePluginCategories,
  listContentSourcePlugins,
  type ContentSourceCategory,
  type ContentSourcePlugin,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";
import { readContentMusicIds } from "@/lib/content-music-input";

/** 新建库的默认名称跟随清单媒体类型，未声明类型的旧插件保持原行为。 */
function initialLibraryName(plugin: ContentSourcePlugin): string {
  if (plugin.adapter === "python_live") return "直播媒体库";
  if (plugin.mediaType === "audiobook") return "在线听书库";
  return plugin.adapter === "netease_http" ? "网易云音乐库" : "在线影视库";
}

/** 选择已启用插件、分类和名称创建在线库，分类预览不新增内容源记录。 */
export function ContentSourceLibraryCreate({ liveOnly = false }: { liveOnly?: boolean }) {
  const navigate = useNavigate();
  const resource = useApiResource(async () => {
    const plugins = await listContentSourcePlugins();
    // 关键变量：脚本源复用插件选择和分类预览，影视与听书仍由清单区分。
    return plugins.items.filter((plugin) => plugin.status === "enabled"
      && (liveOnly ? plugin.adapter === "python_live" : plugin.adapter !== "python_live")
      && (plugin.adapter === "python_live" || plugin.adapter === "cms_json" || plugin.adapter === "python_spider" || plugin.adapter === "catvod_js" || plugin.adapter === "netease_http"));
  }, [liveOnly]);
  const [pluginKey, setPluginKey] = useState("");
  const [displayName, setDisplayName] = useState("在线影视库");
  const [categories, setCategories] = useState<ContentSourceCategory[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  // 关键变量：音乐库默认自动发现内容，数字 ID 仅用于添加用户指定的补充目录。
  const [albumIdsText, setAlbumIdsText] = useState("");
  const [playlistIdsText, setPlaylistIdsText] = useState("");
  // 关键变量：弹窗草稿与已应用配置分开，取消编辑后不影响创建请求。
  const [showMusicConfiguration, setShowMusicConfiguration] = useState(false);
  const [draftAlbumIdsText, setDraftAlbumIdsText] = useState("");
  const [draftPlaylistIdsText, setDraftPlaylistIdsText] = useState("");
  const [musicConfigurationError, setMusicConfigurationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：读取分类与建库共用操作锁，避免状态更新前重复提交。
  const busyRef = useRef(false);
  const plugins = resource.data ?? [];
  const plugin = plugins.find((entry) => `${entry.pluginId}@${entry.version}` === pluginKey);
  // 关键变量：音乐源使用自动发现目录，不经过视频分类接口。
  const isLiveSource = plugin?.adapter === "python_live";
  const isMusicSource = plugin?.adapter === "netease_http";
  const isAudiobookSource = plugin?.mediaType === "audiobook";
  // 关键变量：只展示叶分类，避免选择一个父分类后导入全部内容。
  const leafCategories = categories.filter((entry) => entry.isAll || !categories.some((child) => child.parentId === entry.id));

  useEffect(() => {
    if (plugins.length > 0 && !pluginKey) {
      const first = plugins[0]!;
      setPluginKey(`${first.pluginId}@${first.version}`);
      setDisplayName(initialLibraryName(first));
    }
  }, [pluginKey, plugins]);

  /** 更换插件时丢弃旧分类，保证分类选择和建库请求始终属于当前插件。 */
  function selectPlugin(key: string): void {
    if (busyRef.current) return;
    setPluginKey(key);
    setCategories([]);
    setCategoryIds([]);
    setShowMusicConfiguration(false);
    setMessage(null);
    const selectedPlugin = plugins.find((entry) => `${entry.pluginId}@${entry.version}` === key);
    setDisplayName(selectedPlugin ? initialLibraryName(selectedPlugin) : "在线影视库");
  }

  /** 预览当前影视或听书插件的分类，不在读取或取消时新增源记录。 */
  async function readCategories(): Promise<void> {
    if (!plugin || isMusicSource || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("正在读取内容源分类…");
    try {
      const result = await listContentSourcePluginCategories(plugin);
      setCategories(result.items);
      setCategoryIds([]);
      setMessage(result.items.length > 0 ? "请选择要导入的分类，直播源选择频道，点播及听书源首次同步每分类一页摘要。" : "当前源没有返回可选分类。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容源读取失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 切换当前源返回的分类，不默认选中任何分类。 */
  function toggleCategory(id: string): void {
    setCategoryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  /** 全选当前可用叶分类，或清空用户的选择。 */
  function selectAllCategories(selected: boolean): void {
    setCategoryIds(selected ? leafCategories.map((category) => category.id) : []);
  }

  /** 打开可选补充目录弹窗，关闭时不应用未确认的 ID 草稿。 */
  function openMusicConfiguration(): void {
    if (busyRef.current) return;
    setDraftAlbumIdsText(albumIdsText);
    setDraftPlaylistIdsText(playlistIdsText);
    setMusicConfigurationError(null);
    setShowMusicConfiguration(true);
  }

  /** 关闭可选配置弹窗，音乐库仍可按默认发现目录直接创建。 */
  function closeMusicConfiguration(): void {
    if (!busyRef.current) setShowMusicConfiguration(false);
  }

  /** 校验并应用可选专辑、歌单 ID，不在弹窗中创建媒体库。 */
  function applyMusicConfiguration(): void {
    if (busyRef.current) return;
    try {
      const albumIds = readContentMusicIds(draftAlbumIdsText, "专辑");
      const playlistIds = readContentMusicIds(draftPlaylistIdsText, "歌单");
      setAlbumIdsText(albumIds.join("\n"));
      setPlaylistIdsText(playlistIds.join("\n"));
      setShowMusicConfiguration(false);
    } catch (error) {
      setMusicConfigurationError(error instanceof Error ? error.message : "补充目录格式无效");
    }
  }

  /** 创建成功后直接进入当前媒体库设置，用替换历史记录避免回退后重复提交。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!plugin || busyRef.current || showMusicConfiguration) return;
    if (!displayName.trim() || (!isMusicSource && categoryIds.length === 0)) {
      setMessage(isMusicSource ? "请填写媒体库名称" : "请填写媒体库名称，并至少选择一个分类");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(isLiveSource ? "正在创建直播媒体库…" : "正在创建媒体库并启动目录同步…");
    try {
      // 关键变量：影视及听书库不传首次页数，沿用服务端每分类一页摘要的默认同步。
      const input = isMusicSource
        ? { displayName: displayName.trim(), albumIds: readContentMusicIds(albumIdsText, "专辑"), playlistIds: readContentMusicIds(playlistIdsText, "歌单") }
        : { displayName: displayName.trim(), categoryIds };
      const result = await createContentSourcePluginLibrary(plugin, input);
      await navigate({ to: "/app/libraries/$serviceId/settings", params: { serviceId: result.libraryId }, replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "在线媒体库创建失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!resource.data) return resource.error
    ? <div><p role="alert" className="text-sm text-destructive">{resource.error}</p><div className="mt-3"><SecondaryButton onClick={() => void resource.refresh()}>重新读取</SecondaryButton></div></div>
    : <div aria-label="内容源加载中" className="animate-pulse space-y-3"><div className="h-4 w-40 rounded bg-muted" /><div className="h-9 rounded bg-muted" /><div className="h-9 rounded bg-muted" /></div>;
  if (plugins.length === 0) return <p className="text-sm text-muted-foreground">暂无已启用的内容源插件，请管理员在“插件管理 → 导入插件”中导入并启用插件。</p>;

  return <form onSubmit={(event) => void submit(event)} className="grid gap-3">
    <p className="text-xs text-muted-foreground">内容源在插件管理页导入并启用，这里选择插件创建媒体库。</p>
    <fieldset disabled={busy}>
      <legend className="text-xs text-muted-foreground">内容源插件</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{plugins.map((entry) => {
        const key = `${entry.pluginId}@${entry.version}`;
        return <button key={key} type="button" aria-pressed={pluginKey === key} onClick={() => selectPlugin(key)} title={entry.displayName} className={`flex min-w-0 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-left disabled:opacity-60 ${pluginKey === key ? "border-foreground" : "border-border"}`}><span className="min-w-0 truncate text-sm">{entry.displayName}</span>{entry.mediaType === "audiobook" && <span className="shrink-0 text-xs text-muted-foreground">听书</span>}<span className="shrink-0 text-xs text-muted-foreground">{entry.version}</span></button>;
      })}</div>
    </fieldset>
    <label><span className="text-xs text-muted-foreground">媒体库名称</span><input disabled={busy} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" /></label>
    {!isMusicSource && <div className="flex flex-wrap gap-2 [&_button]:px-3 [&_button]:py-1.5"><SecondaryButton disabled={busy || !plugin} onClick={() => void readCategories()}>{busy && categories.length === 0 ? "正在读取…" : categories.length > 0 ? "重新读取分类" : "读取分类"}</SecondaryButton></div>}
    {leafCategories.length > 0 && <fieldset disabled={busy}><legend className="text-xs text-muted-foreground">{isLiveSource ? "直播频道" : "导入分类"}（已选 {categoryIds.length} 个）</legend><div className="mt-1.5 flex flex-wrap gap-2 [&_button]:px-3 [&_button]:py-1.5"><SecondaryButton disabled={busy} onClick={() => selectAllCategories(true)}>全选</SecondaryButton><SecondaryButton disabled={busy} onClick={() => selectAllCategories(false)}>取消全选</SecondaryButton></div><div className="mt-2 flex flex-wrap gap-1.5">{leafCategories.map((category) => <button key={category.id} type="button" aria-pressed={categoryIds.includes(category.id)} onClick={() => toggleCategory(category.id)} className={`rounded-lg border px-3 py-1.5 text-left text-sm ${categoryIds.includes(category.id) ? "border-foreground" : "border-border"}`}>{category.name}</button>)}</div></fieldset>}
    {isAudiobookSource && <p className="text-xs text-muted-foreground">列表同步书籍摘要，打开书籍详情和播放时再读取章节与音频资料。</p>}
    {isMusicSource && <div className="grid gap-2 rounded-lg border border-border p-3">
      <div><p className="text-sm">自动发现音乐目录</p><p className="mt-1 text-xs text-muted-foreground">客户端浏览时自动加载推荐歌单、排行榜和新专辑，无需填写专辑或歌单 ID。</p></div>
      <div className="flex flex-wrap items-center justify-between gap-2 [&_button]:px-3 [&_button]:py-1.5"><p className="text-xs text-muted-foreground">{albumIdsText || playlistIdsText ? "已添加自选补充目录" : "也可按需添加自选专辑和歌单"}</p><SecondaryButton disabled={busy} onClick={openMusicConfiguration}>高级配置（可选）</SecondaryButton></div>
    </div>}
    <div className="[&_button]:px-3 [&_button]:py-2"><PrimaryButton type="submit" disabled={busy || showMusicConfiguration || !plugin || (!isMusicSource && categoryIds.length === 0) || !displayName.trim()}>{busy ? "正在处理…" : isLiveSource ? "创建直播媒体库" : isMusicSource ? "创建在线音乐库" : isAudiobookSource ? "创建在线听书库" : "创建在线媒体库"}</PrimaryButton></div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {showMusicConfiguration && <ContentSourceSettingsDialog state={{ title: "补充音乐目录（可选）", description: "自动发现推荐歌单、排行榜和新专辑，无需填写以下内容。", busy, onClose: closeMusicConfiguration, children: <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2"><label><span className="text-xs text-muted-foreground">补充专辑 ID（可选）</span><textarea disabled={busy} value={draftAlbumIdsText} onChange={(event) => setDraftAlbumIdsText(event.target.value)} rows={4} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" /></label><label><span className="text-xs text-muted-foreground">补充歌单 ID（可选）</span><textarea disabled={busy} value={draftPlaylistIdsText} onChange={(event) => setDraftPlaylistIdsText(event.target.value)} rows={4} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" /></label></div>
      <p className="text-xs text-muted-foreground">用于加入指定的网易公开专辑或歌单。填写数字 ID，多个 ID 使用逗号、空格或换行分隔，也可全部留空。</p>
      {musicConfigurationError && <p role="alert" className="text-xs text-destructive">{musicConfigurationError}</p>}
      <div className="flex justify-end"><PrimaryButton disabled={busy} onClick={applyMusicConfiguration}>应用补充目录</PrimaryButton></div>
    </div> }} />}
  </form>;
}
