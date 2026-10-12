import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getContentMusicLibrary,
  syncContentMusicLibrary,
  updateContentMusicLibrary,
  updateContentSourceStatus,
  type ContentSourcePlaybackMode,
} from "@/lib/content-source-api";
import { readContentMusicIds } from "@/lib/content-music-input";
import { useApiResource } from "@/lib/use-api-resource";

const syncStatusLabels = { idle: "待同步", queued: "等待同步", running: "同步中", completed: "同步完成", failed: "同步失败" } as const;
const playbackModeLabels = { auto: "自动", direct: "直连", relay: "中转" } as const;

/** 音乐源主页面展示自动发现摘要，可选补充目录和同步详情在弹窗中编辑。 */
export function ContentMusicLibraryPanel({ state }: { state: {
  libraryId: string; admin: boolean; onChanged: () => Promise<void>;
} }) {
  const { libraryId, admin, onChanged } = state;
  const resource = useApiResource(() => getContentMusicLibrary(libraryId, admin), [libraryId, admin]);
  const [dialog, setDialog] = useState<"configuration" | "sync" | null>(null);
  const [albumIdsText, setAlbumIdsText] = useState("");
  const [playlistIdsText, setPlaylistIdsText] = useState("");
  const [playbackMode, setPlaybackMode] = useState<ContentSourcePlaybackMode>("auto");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：同步占用操作锁，避免状态更新前重复发起同步或保存。
  const busyRef = useRef(false);
  const previousSyncStatus = useRef<string | null>(null);
  const data = resource.data;
  const running = data?.sync.status === "running" || data?.sync.status === "queued";
  const enabled = data?.source.status === "active" && data.source.pluginStatus === "enabled";

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void resource.refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [running, resource.refresh]);

  useEffect(() => {
    if (!data) return;
    if ((previousSyncStatus.current === null || ["queued", "running"].includes(previousSyncStatus.current))
      && ["completed", "failed"].includes(data.sync.status)) void onChanged();
    previousSyncStatus.current = data.sync.status;
  }, [data?.sync.status, onChanged]);

  /** 每次打开设置都读取最新配置，关闭时不保留未保存草稿。 */
  function openDialog(nextDialog: "configuration" | "sync"): void {
    if (!data || busyRef.current || dialog !== null) return;
    setAlbumIdsText(data.configuration.albumIds.join("\n"));
    setPlaylistIdsText(data.configuration.playlistIds.join("\n"));
    setPlaybackMode(data.configuration.playbackMode);
    setMessage(null);
    setDialog(nextDialog);
  }

  /** 操作结束前保留弹窗，避免请求进行中丢失结果。 */
  function closeDialog(): void {
    if (!busyRef.current) setDialog(null);
  }

  /** 保存可选补充目录和传输方式，不影响默认发现入口。 */
  async function saveConfiguration(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!data || busyRef.current || running) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateContentMusicLibrary(libraryId, {
        albumIds: readContentMusicIds(albumIdsText, "专辑"),
        playlistIds: readContentMusicIds(playlistIdsText, "歌单"),
        playbackMode,
      }, admin);
      await resource.refresh();
      await onChanged();
      setDialog(null);
      setMessage("音乐源配置已保存，自动发现目录继续可用，可手动同步补充目录");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "音乐源配置保存失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 更新发现目录和已保存的可选补充目录，用户记录沿用原条目。 */
  async function startSync(): Promise<void> {
    if (!data || busyRef.current || running || !enabled) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await syncContentMusicLibrary(libraryId, admin);
      await resource.refresh();
      await onChanged();
      setMessage("同步已启动，状态会自动刷新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "音乐目录同步失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 独立启停音乐源实例，目录、收藏和播放记录继续保留。 */
  async function toggleSource(): Promise<void> {
    if (!data || busyRef.current || running || dialog !== null) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateContentSourceStatus(data.source.id, data.source.status === "active" ? "disabled" : "active", admin);
      await resource.refresh();
      await onChanged();
      setMessage(data.source.status === "active" ? "音乐源配置已停用" : "音乐源配置已启用");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "音乐源状态保存失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <Panel title="在线音乐源" className="mb-4 [&>header]:items-center" action={<SecondaryButton disabled={resource.loading || busy || dialog !== null} onClick={() => void resource.refresh()}>刷新状态</SecondaryButton>}>
    {!data && !resource.error && <div aria-label="音乐源配置加载中" className="animate-pulse space-y-3"><div className="h-5 w-48 rounded bg-muted" /><div className="h-14 rounded bg-muted" /><div className="h-9 w-32 rounded bg-muted" /></div>}
    {resource.error && <p role="alert" className="mb-3 text-xs text-destructive">{resource.error}</p>}
    {data && <div className="grid gap-3">
      <div className="grid min-h-12 min-w-0 grid-cols-1 items-center gap-x-4 gap-y-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[8rem_minmax(0,1fr)_auto]">
        <p className="min-w-0 break-words text-sm">{data.source.displayName}</p>
        <div className="min-w-0 sm:col-span-2 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1"><div className="flex flex-wrap items-center gap-3"><span className="break-all text-xs text-muted-foreground">{data.source.pluginId} · {data.source.pluginVersion}</span><StatusPill>{enabled ? "配置已启用" : "内容源已停用"}</StatusPill></div></div>
        <div className="flex justify-end sm:col-start-2 sm:row-start-1 lg:col-start-3"><SecondaryButton disabled={busy || running || dialog !== null} onClick={() => void toggleSource()}>{busy ? "正在处理…" : data.source.status === "active" ? "停用此配置" : "启用此配置"}</SecondaryButton></div>
      </div>
      <div className="grid min-h-12 min-w-0 grid-cols-1 items-center gap-x-4 gap-y-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[8rem_minmax(0,1fr)_auto]">
        <p className="text-sm">目录与播放</p>
        <div className="min-w-0 text-xs text-muted-foreground sm:col-span-2 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1"><p>自动发现推荐歌单、排行榜和新专辑 · {playbackModeLabels[data.configuration.playbackMode]}播放</p>{(data.configuration.albumIds.length > 0 || data.configuration.playlistIds.length > 0) && <p className="mt-1">补充目录：{data.configuration.albumIds.length} 个专辑 · {data.configuration.playlistIds.length} 个歌单</p>}</div>
        <div className="flex justify-end sm:col-start-2 sm:row-start-1 lg:col-start-3"><SecondaryButton disabled={busy || running || dialog !== null || resource.loading} onClick={() => openDialog("configuration")}>修改配置</SecondaryButton></div>
      </div>
      <div className="grid min-h-12 min-w-0 grid-cols-1 items-center gap-x-4 gap-y-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[8rem_minmax(0,1fr)_auto]">
        <p className="text-sm">手动同步</p>
        <div className="min-w-0 sm:col-span-2 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1"><div className="flex flex-wrap items-center gap-3"><StatusPill>{syncStatusLabels[data.sync.status]}</StatusPill><span className="text-xs text-muted-foreground">本轮处理 {data.sync.processedCount} 个条目</span></div>{data.sync.lastError && <p className="mt-1 text-xs text-destructive">同步失败，可查看详情</p>}</div>
        <div className="flex justify-end sm:col-start-2 sm:row-start-1 lg:col-start-3"><SecondaryButton disabled={busy || dialog !== null} onClick={() => openDialog("sync")}>手动同步 / 详情</SecondaryButton></div>
      </div>
      <p className="text-xs text-muted-foreground">通过 Navidrome 自动浏览推荐歌单、排行榜和新专辑，无需手填 ID；客户端搜索会实时查询网易云，播放时获取当前可用地址。</p>
      {dialog === "configuration" && <ContentSourceSettingsDialog state={{ title: "音乐源目录与播放配置", busy, onClose: closeDialog, children: <form onSubmit={(event) => void saveConfiguration(event)} className="grid gap-4">
        <p className="text-xs text-muted-foreground">推荐歌单、排行榜和新专辑由云助手自动发现。以下内容仅用于添加自选专辑或歌单，可全部留空。</p>
        <div className="grid gap-3 sm:grid-cols-2"><label><span className="text-xs text-muted-foreground">补充专辑 ID（可选）</span><textarea disabled={busy} rows={4} value={albumIdsText} onChange={(event) => setAlbumIdsText(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label><label><span className="text-xs text-muted-foreground">补充歌单 ID（可选）</span><textarea disabled={busy} rows={4} value={playlistIdsText} onChange={(event) => setPlaylistIdsText(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label></div>
        <p className="text-xs text-muted-foreground">填写数字 ID，多个 ID 使用逗号、空格或换行分隔。留空仍可自动浏览和实时搜索；修改补充目录会保留已有歌曲与用户记录。</p>
        <label><span className="text-xs text-muted-foreground">Navidrome 播放模式</span><select disabled={busy} value={playbackMode} onChange={(event) => setPlaybackMode(event.target.value as ContentSourcePlaybackMode)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm"><option value="auto">自动</option><option value="direct">直连</option><option value="relay">中转</option></select><span className="mt-2 block text-xs text-muted-foreground">自动模式优先直连，无法取得可用直连地址时由云助手中转；音频原样提供，不转码。</span></label>
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
        <div className="flex justify-end"><PrimaryButton disabled={busy || running} type="submit">{busy ? "正在保存…" : "保存配置"}</PrimaryButton></div>
      </form> }} />}
      {dialog === "sync" && <ContentSourceSettingsDialog state={{ title: "音乐目录同步详情", busy, onClose: closeDialog, children: <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3"><StatusPill>{syncStatusLabels[data.sync.status]}</StatusPill><span className="text-xs text-muted-foreground">本轮处理 {data.sync.processedCount} 个条目</span></div>
        <p className="text-xs text-muted-foreground">刷新推荐歌单、排行榜摘要和新专辑第一页，并同步补充目录中的 {data.configuration.albumIds.length} 个专辑和 {data.configuration.playlistIds.length} 个歌单。自动发现的歌单在客户端打开时加载歌曲，无需手填 ID。</p>
        {data.sync.finishedAt && <p className="text-xs text-muted-foreground">最近结束：{new Date(data.sync.finishedAt).toLocaleString("zh-CN")}</p>}
        {data.sync.lastError && <p role="alert" className="text-xs text-destructive">{data.sync.lastError}</p>}
        {!enabled && <p className="text-xs text-muted-foreground">请先启用内容源插件和配置实例。</p>}
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
        <div className="flex justify-end"><PrimaryButton disabled={busy || running || !enabled} onClick={() => void startSync()}>{busy || running ? "正在同步…" : "同步目录"}</PrimaryButton></div>
      </div> }} />}
      {message && dialog === null && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    </div>}
  </Panel>;
}
