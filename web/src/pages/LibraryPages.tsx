import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, CalendarClock, Copy, Images, Pencil, Plus, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MediaCatalogView, type MediaCatalogQuery } from "@/components/MediaCatalogView";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { ServicePathPicker, toProviderDirectory } from "@/components/ServicePathPicker";
import {
  clearServiceCatalog,
  createScanJob,
  createServiceAccessAccount,
  deleteLibrary,
  deleteServiceAccessAccount,
  getLibrary,
  getServiceAccessSettings,
  listAdminServiceItems,
  listLibraryItems,
  revokeServiceAccessAccountSessions,
  type ServiceAccessAccount,
  updateServiceAccessAccount,
  updateServiceJellyfinSettings,
  updateServiceEmbySettings,
  updateServiceNavidromeSettings,
  updateLibraryPlaybackSettings,
  updateLibraryMetadataProfile,
  updateLibraryNotificationSettings,
  updateLibraryScanProfile,
  type ProviderDirectory,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

// 关键变量：单个媒体库海报墙每页读取 60 个顶层条目，避免一次加载完整目录。
const LIBRARY_CATALOG_PAGE_SIZE = 60;

/** 把媒体库扫描配置中的根目录转换为目录选择器数据。 */
function readLibraryScanRoots(profile: Record<string, unknown>, mode: "full" | "incremental"): ProviderDirectory[] {
  const value = mode === "full" ? profile.fullRoots : profile.incrementalRoots;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const root = entry as Record<string, unknown>;
    const displayPath = typeof root.displayPath === "string" ? root.displayPath : "";
    const resourceId = typeof root.resourceId === "string" ? root.resourceId : displayPath;
    if (!resourceId || !displayPath) return [];
    return [toProviderDirectory({
      resourceId,
      displayPath,
      ...(typeof root.driveId === "string" && root.driveId ? { driveId: root.driveId } : {}),
    })];
  });
}

/** 把目录选择结果保存为后端扫描配置使用的根目录结构。 */
function buildLibraryScanRoots(directories: ProviderDirectory[], dataType: "video" | "music" | "audiobook"): Record<string, unknown>[] {
  return directories.map((directory) => ({
    resourceId: directory.resourceId,
    displayPath: directory.displayPath,
    ...(directory.driveId ? { driveId: directory.driveId } : {}),
    mediaTypes: [dataType],
  }));
}

/** 复制媒体库协议地址，并兼容未开放 Clipboard API 的浏览器。 */
async function copyLibraryText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = value;
    temporaryInput.style.position = "fixed";
    temporaryInput.style.opacity = "0";
    document.body.appendChild(temporaryInput);
    temporaryInput.select();
    document.execCommand("copy");
    temporaryInput.remove();
  }
}

/** 集中管理单个媒体库的 APP 播放、协议入口和数据清理。 */
export function LibrarySettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const navigate = useNavigate();
  const resource = useApiResource(async () => {
    const [libraryResult, settings] = await Promise.all([
      getLibrary(serviceId, admin),
      getServiceAccessSettings(serviceId, admin),
    ]);
    return {
      service: { ...libraryResult.library, libraryId: libraryResult.library.id },
      scanProfile: libraryResult.scanProfile,
      metadataProfile: libraryResult.metadataProfile,
      settings,
    };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [updatingJellyfin, setUpdatingJellyfin] = useState(false);
  const [updatingEmby, setUpdatingEmby] = useState(false);
  const [updatingNavidrome, setUpdatingNavidrome] = useState(false);
  const [clearingCatalog, setClearingCatalog] = useState(false);
  const [creatingScanMode, setCreatingScanMode] = useState<"full" | "incremental" | null>(null);
  const [updatingNotification, setUpdatingNotification] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [unlinkingService, setUnlinkingService] = useState(false);
  const [metadataProvider, setMetadataProvider] = useState("builtin.tmdb");
  const [metadataLanguage, setMetadataLanguage] = useState("zh-CN");
  const [metadataRegion, setMetadataRegion] = useState("CN");
  const [useNfo, setUseNfo] = useState(true);
  const [syncDetails, setSyncDetails] = useState(false);
  const [analyzeMediaSpecs, setAnalyzeMediaSpecs] = useState(false);
  const [musicAggregateMode, setMusicAggregateMode] = useState<"fast" | "complete">("fast");
  const [syncLyrics, setSyncLyrics] = useState(false);
  // 关键变量：同步占用清空操作，避免按钮状态刷新前重复提交。
  const clearingCatalogRef = useRef(false);
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const scanProfile = resource.data?.scanProfile ?? {};
  const metadataProfile = resource.data?.metadataProfile ?? {};
  const catalogPath = admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog";
  const jellyfinPath = admin ? "/admin/libraries/$serviceId/jellyfin" : "/app/libraries/$serviceId/jellyfin";
  const embyPath = admin ? "/admin/libraries/$serviceId/emby" : "/app/libraries/$serviceId/emby";
  const schedulePath = admin ? "/admin/libraries/$serviceId/scan-schedules" : "/app/libraries/$serviceId/scan-schedules";
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";

  useEffect(() => {
    const profiles = metadataProfile.profiles && typeof metadataProfile.profiles === "object" && !Array.isArray(metadataProfile.profiles)
      ? metadataProfile.profiles as Record<string, unknown>
      : {};
    const profileKey = service?.dataType === "music" ? "music" : "video";
    const selected = profiles[profileKey] && typeof profiles[profileKey] === "object" && !Array.isArray(profiles[profileKey])
      ? profiles[profileKey] as Record<string, unknown>
      : {};
    if (typeof selected.providerId === "string") setMetadataProvider(selected.providerId);
    if (typeof selected.language === "string") setMetadataLanguage(selected.language);
    if (typeof selected.region === "string") setMetadataRegion(selected.region);
    setUseNfo(selected.useNfo !== false);
    setSyncDetails(selected.syncDetails === true);
    setAnalyzeMediaSpecs(selected.analyzeMediaSpecs === true);
    setMusicAggregateMode(selected.aggregateMode === "complete" ? "complete" : "fast");
    const requiredFields = selected.requiredFields && typeof selected.requiredFields === "object" && !Array.isArray(selected.requiredFields)
      ? selected.requiredFields as Record<string, unknown>
      : {};
    setSyncLyrics(requiredFields.lyrics === true);
  }, [metadataProfile, service?.dataType]);

  /** 保存全量或增量扫描路径，同时保留并发等其他扫描配置。 */
  async function saveScanRoots(mode: "full" | "incremental", directories: ProviderDirectory[]): Promise<void> {
    if (!service) return;
    const roots = buildLibraryScanRoots(directories, service.dataType);
    await updateLibraryScanProfile(serviceId, {
      ...scanProfile,
      ...(mode === "full" ? { fullRoots: roots } : { incrementalRoots: roots }),
    }, admin, "paths");
    setMessage(`${mode === "full" ? "全量" : "增量"}扫描路径已保存`);
    await resource.refresh();
  }

  /** 手动创建当前媒体库的扫描刮削任务。 */
  async function triggerScan(mode: "full" | "incremental"): Promise<void> {
    if (creatingScanMode !== null) return;
    setCreatingScanMode(mode);
    try {
      const job = await createScanJob(serviceId, mode, admin);
      setMessage(`${mode === "full" ? "全量" : "增量"}扫描任务已创建：${job.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描任务创建失败");
    } finally {
      setCreatingScanMode(null);
    }
  }

  /** 保存媒体库元数据来源和常用刮削选项。 */
  async function saveMetadataSettings(): Promise<void> {
    if (!service || savingMetadata) return;
    setSavingMetadata(true);
    try {
      const profiles = metadataProfile.profiles && typeof metadataProfile.profiles === "object" && !Array.isArray(metadataProfile.profiles)
        ? metadataProfile.profiles as Record<string, unknown>
        : {};
      const profileKey = service.dataType === "music" ? "music" : "video";
      const currentProfile = profiles[profileKey] && typeof profiles[profileKey] === "object" && !Array.isArray(profiles[profileKey])
        ? profiles[profileKey] as Record<string, unknown>
        : {};
      const currentRequiredFields = currentProfile.requiredFields && typeof currentProfile.requiredFields === "object" && !Array.isArray(currentProfile.requiredFields)
        ? currentProfile.requiredFields as Record<string, unknown>
        : {};
      const profile = service.dataType === "music"
        ? {
          ...currentProfile,
          providerId: metadataProvider,
          aggregateMode: musicAggregateMode,
          requiredFields: { ...currentRequiredFields, artist: true, album: true, cover: true, lyrics: syncLyrics },
        }
        : {
          ...currentProfile,
          providerId: metadataProvider,
          language: metadataLanguage,
          region: metadataRegion,
          useNfo,
          syncDetails,
          analyzeMediaSpecs,
        };
      await updateLibraryMetadataProfile(serviceId, {
        ...metadataProfile,
        profiles: { ...profiles, [profileKey]: profile },
      }, admin);
      setMessage("元数据配置已保存");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "元数据配置保存失败");
    } finally {
      setSavingMetadata(false);
    }
  }

  /** 切换当前媒体库后台任务完成通知。 */
  async function toggleNotification(): Promise<void> {
    if (!service || updatingNotification) return;
    setUpdatingNotification(true);
    try {
      await updateLibraryNotificationSettings(serviceId, !service.notificationEnabled, admin);
      setMessage(`任务完成通知已${service.notificationEnabled ? "关闭" : "启用"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务完成通知设置失败");
    } finally {
      setUpdatingNotification(false);
    }
  }

  /** 立即保存当前媒体库的 Jellyfin 协议开关。 */
  async function toggleJellyfin(): Promise<void> {
    if (!settings || updatingJellyfin) return;
    setUpdatingJellyfin(true);
    try {
      await updateServiceJellyfinSettings(serviceId, { jellyfinEnabled: !settings.jellyfinEnabled }, admin);
      setMessage(settings.jellyfinEnabled ? "Jellyfin 协议已关闭" : "Jellyfin 协议已启用");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 设置保存失败");
    } finally {
      setUpdatingJellyfin(false);
    }
  }

  /** 立即保存当前媒体库的独立 Emby 协议总开关。 */
  async function toggleEmby(): Promise<void> {
    if (!settings || updatingEmby) return;
    setUpdatingEmby(true);
    try {
      await updateServiceEmbySettings(serviceId, { embyEnabled: !settings.embyEnabled }, admin);
      setMessage(settings.embyEnabled ? "Emby 协议已关闭" : "Emby 协议已启用");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Emby 设置保存失败");
    } finally {
      setUpdatingEmby(false);
    }
  }

  /** 立即保存音乐媒体库的 Navidrome/Subsonic 协议开关。 */
  async function toggleNavidrome(): Promise<void> {
    if (!settings || updatingNavidrome || !settings.navidromeSupported) return;
    const nextEnabled = !settings.navidromeEnabled;
    setUpdatingNavidrome(true);
    try {
      await updateServiceNavidromeSettings(serviceId, { navidromeEnabled: nextEnabled }, admin);
      setMessage(`Navidrome 协议已${nextEnabled ? "启用" : "关闭"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Navidrome 设置保存失败");
    } finally {
      setUpdatingNavidrome(false);
    }
  }

  /** 二次确认后清空媒体库中的扫描和刮削结果。 */
  async function clearCatalog(): Promise<void> {
    if (!service || clearingCatalogRef.current) return;
    if (!window.confirm(`确定清空“${service.displayName}”媒体库的全部内容吗？媒体条目、文件索引和目录版本将被清空，服务连接与扫描配置会保留。`)) return;
    clearingCatalogRef.current = true;
    setClearingCatalog(true);
    setMessage("正在清空当前媒体库…");
    try {
      await clearServiceCatalog(serviceId, admin);
      setMessage("媒体库已清空");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清空媒体库失败");
    } finally {
      clearingCatalogRef.current = false;
      setClearingCatalog(false);
    }
  }

  /** 删除媒体库并返回媒体库列表，来源网盘服务继续保留。 */
  async function deleteCurrentLibrary(): Promise<void> {
    if (!service || !window.confirm(`确定删除“${service.displayName}”媒体库吗？扫描结果、任务配置和协议账号会被删除，来源网盘服务会保留。`)) return;
    try {
      await deleteLibrary(serviceId, admin);
      await navigate({ to: librariesPath, replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "媒体库删除失败");
    }
  }

  /** 取消当前唯一来源时同步删除媒体库，避免留下无法扫描和播放的空媒体库。 */
  async function unlinkLastService(): Promise<void> {
    if (!service || unlinkingService) return;
    const confirmed = window.confirm(
      `“${service.sourceServiceName}”是“${service.displayName}”的最后一个关联服务。取消关联将同时删除该媒体库及扫描结果、任务配置和协议账号，网盘服务本身会保留。确定继续吗？`,
    );
    if (!confirmed) return;
    setUnlinkingService(true);
    console.info("codex-media-library-source-unlink", {
      事件: "取消最后一个关联服务并删除媒体库",
      媒体库ID: serviceId,
      服务ID: service.sourceServiceId,
    });
    try {
      await deleteLibrary(serviceId, admin);
      console.info("codex-media-library-source-unlink", {
        事件: "取消关联完成，媒体库已删除",
        媒体库ID: serviceId,
        服务ID: service.sourceServiceId,
      });
      await navigate({ to: librariesPath, replace: true });
    } catch (error) {
      console.warn("codex-media-library-source-unlink", {
        事件: "取消关联失败",
        媒体库ID: serviceId,
        服务ID: service.sourceServiceId,
        错误: error instanceof Error ? error.message : String(error),
      });
      setMessage(error instanceof Error ? error.message : "取消关联失败");
      setUnlinkingService(false);
    }
  }

  if (!service || !settings) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取媒体库设置…"}</div></Panel>;
  }
  // 关键变量：音乐库展示 Navidrome 状态，视频库展示 Jellyfin 状态。
  const libraryProtocolName = settings.navidromeSupported ? "Navidrome" : "Jellyfin";
  const libraryProtocolEnabled = settings.navidromeSupported
    ? settings.navidromeEnabled
    : settings.jellyfinEnabled;

  return (
    <>
      <PageHeader
        title={`${service.displayName} · 媒体库设置`}
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link>
            <Link to={schedulePath} params={{ serviceId }}><SecondaryButton><CalendarClock className="size-4" /> 定时任务</SecondaryButton></Link>
            <Link to={catalogPath} params={{ serviceId }}><PrimaryButton><Images className="size-4" /> 海报墙</PrimaryButton></Link>
          </div>
        )}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel title="关联服务" description="当前媒体库使用这个网盘服务的登录凭据读取和扫描文件。" className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{service.sourceServiceName}</p>
            <p className="mt-1 text-xs text-muted-foreground">{service.providerType} · {service.sourceConnectionStatus === "valid" ? "连接正常" : "需要重新登录"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to={admin ? "/admin/services/$serviceId" : "/app/services/$serviceId"} params={{ serviceId: service.sourceServiceId }}><SecondaryButton>查看服务</SecondaryButton></Link>
            <button type="button" onClick={() => void unlinkLastService()} disabled={unlinkingService} className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40">{unlinkingService ? "取消中…" : "取消关联"}</button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">当前只有这一个关联服务；取消关联会同时删除媒体库，网盘服务仍然保留。</p>
      </Panel>
      <div className={`grid gap-3 sm:grid-cols-3 ${settings.navidromeSupported ? "" : "xl:grid-cols-4"}`}>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3">
          <span className="text-xs text-muted-foreground">媒体条目</span>
          <span className="text-lg font-semibold">{service.itemCount.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3">
          <span className="text-xs text-muted-foreground">目录版本</span>
          <span className="text-lg font-semibold">v{service.catalogVersion}</span>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3">
          <span className="text-xs text-muted-foreground">{libraryProtocolName}</span>
          <span className="text-sm font-semibold">{libraryProtocolEnabled ? "已启用" : "未启用"}</span>
        </div>
        {!settings.navidromeSupported && <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-4 py-3">
          <span className="text-xs text-muted-foreground">Emby</span>
          <span className="text-sm font-semibold">{settings.embyEnabled ? "已启用" : "未启用"}</span>
        </div>}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="扫描路径" description="全量与增量路径分别保存到媒体库，网盘服务只提供登录凭据。">
          <div className="grid gap-3">
            <ServicePathPicker serviceId={service.sourceServiceId} admin={admin} label="全量扫描目录" value={readLibraryScanRoots(scanProfile, "full")} onConfirm={(directories) => saveScanRoots("full", directories)} />
            <ServicePathPicker serviceId={service.sourceServiceId} admin={admin} label="增量扫描目录" value={readLibraryScanRoots(scanProfile, "incremental")} onConfirm={(directories) => saveScanRoots("incremental", directories)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <SecondaryButton disabled={creatingScanMode !== null || readLibraryScanRoots(scanProfile, "full").length === 0} onClick={() => void triggerScan("full")}><ScanLine className="size-4" /> {creatingScanMode === "full" ? "创建中…" : "全量扫描"}</SecondaryButton>
            <PrimaryButton disabled={creatingScanMode !== null || readLibraryScanRoots(scanProfile, "incremental").length === 0} onClick={() => void triggerScan("incremental")}><ScanLine className="size-4" /> {creatingScanMode === "incremental" ? "创建中…" : "增量扫描"}</PrimaryButton>
          </div>
        </Panel>
        <Panel title="元数据" description={service.dataType === "music" ? "配置音乐平台聚合与歌词补全。" : "配置影视刮削来源、语言和扫描增强。"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="text-xs text-muted-foreground">元数据来源</span><select value={metadataProvider} onChange={(event) => setMetadataProvider(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm">{service.dataType === "music" ? <><option value="auto">多平台自动补全</option><option value="musicbrainz">MusicBrainz</option><option value="netease">网易云音乐</option><option value="qmusic">QQ音乐</option><option value="kugou">酷狗音乐</option><option value="migu">咪咕音乐</option><option value="kuwo">酷我音乐</option></> : <><option value="builtin.tmdb">TMDB 在线刮削</option><option value="local">仅本地 NFO 和文件名</option></>}</select></label>
            {service.dataType === "music" ? <label><span className="text-xs text-muted-foreground">聚合方式</span><select value={musicAggregateMode} onChange={(event) => setMusicAggregateMode(event.target.value as "fast" | "complete")} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm"><option value="fast">最快命中</option><option value="complete">完整聚合</option></select></label> : <><label><span className="text-xs text-muted-foreground">语言</span><select value={metadataLanguage} onChange={(event) => setMetadataLanguage(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm"><option value="zh-CN">简体中文</option><option value="zh-TW">繁体中文</option><option value="en-US">英语</option><option value="ja-JP">日语</option><option value="ko-KR">韩语</option></select></label><label><span className="text-xs text-muted-foreground">地区</span><select value={metadataRegion} onChange={(event) => setMetadataRegion(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm"><option value="CN">中国大陆</option><option value="HK">中国香港</option><option value="TW">中国台湾</option><option value="US">美国</option><option value="JP">日本</option><option value="KR">韩国</option></select></label></>}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
            {service.dataType === "music" ? <label className="inline-flex items-center gap-2"><input type="checkbox" checked={syncLyrics} onChange={(event) => setSyncLyrics(event.target.checked)} /> 补全歌词</label> : <><label className="inline-flex items-center gap-2"><input type="checkbox" checked={useNfo} onChange={(event) => setUseNfo(event.target.checked)} /> 优先本地 NFO</label><label className="inline-flex items-center gap-2"><input type="checkbox" checked={syncDetails} onChange={(event) => setSyncDetails(event.target.checked)} /> 同步详情</label><label className="inline-flex items-center gap-2"><input type="checkbox" checked={analyzeMediaSpecs} onChange={(event) => setAnalyzeMediaSpecs(event.target.checked)} /> 分析视频规格</label></>}
          </div>
          <div className="mt-4"><PrimaryButton disabled={savingMetadata} onClick={() => void saveMetadataSettings()}>{savingMetadata ? "正在保存…" : "保存元数据配置"}</PrimaryButton></div>
        </Panel>
      </div>
      <Panel title="任务通知" className="mt-4">
        <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><Bell className="size-5 text-muted-foreground" /><div><p className="text-sm font-medium">后台任务完成通知</p><p className="mt-1 text-xs text-muted-foreground">通知渠道由云助手系统设置统一管理。</p></div></div><button type="button" role="switch" aria-checked={service.notificationEnabled} disabled={updatingNotification} onClick={() => void toggleNotification()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${service.notificationEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${service.notificationEnabled ? "translate-x-5" : "translate-x-0"}`} /></button></div>
      </Panel>
      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(240px,1fr)]">
        <Panel title="播放与协议" description={settings.navidromeSupported ? "管理 Navidrome 客户端访问。" : "管理 Jellyfin、Emby 客户端访问。"}>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {!settings.navidromeSupported && <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Jellyfin 协议</p>
                <p className="mt-0.5 text-xs text-muted-foreground">关闭时撤销现有会话，保留播放记录。</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Link to={jellyfinPath} params={{ serviceId }}><SecondaryButton><Settings2 className="size-4" /> 配置</SecondaryButton></Link>
                <button type="button" role="switch" aria-checked={settings.jellyfinEnabled} aria-label="启用 Jellyfin 协议" disabled={updatingJellyfin} onClick={() => void toggleJellyfin()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            </div>}
            {!settings.navidromeSupported && <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Emby 协议</p>
                <p className="mt-0.5 text-xs text-muted-foreground">使用独立账号、会话、收藏和观看记录。</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Link to={embyPath} params={{ serviceId }}><SecondaryButton><Settings2 className="size-4" /> 配置</SecondaryButton></Link>
                <button type="button" role="switch" aria-checked={settings.embyEnabled} aria-label="启用 Emby 协议" disabled={updatingEmby} onClick={() => void toggleEmby()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.embyEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.embyEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            </div>}
            {settings.navidromeSupported && <div className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Navidrome 协议</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">提供兼容 Subsonic 的浏览、搜索、封面和原音频播放接口。</p>
                </div>
                <button type="button" role="switch" aria-checked={settings.navidromeEnabled} aria-label="启用 Navidrome 协议" disabled={updatingNavidrome} onClick={() => void toggleNavidrome()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.navidromeEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.navidromeEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs">{settings.navidromeUrl ?? `云助手 API 地址${settings.navidromePath}`}</p>
                  <p className="mt-1 text-xs text-muted-foreground">账号：<span className="font-mono text-foreground">{settings.account.username}</span> · 原音频透传，不转码</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <SecondaryButton type="button" onClick={() => void copyLibraryText(settings.navidromeUrl ?? settings.navidromePath).then(() => setMessage(settings.navidromeUrl ? "Navidrome 服务地址已复制" : "Navidrome 服务路径已复制"))}><Copy className="size-4" /> 复制</SecondaryButton>
                  <Link to={jellyfinPath} params={{ serviceId }}><SecondaryButton><Settings2 className="size-4" /> 账号与地址</SecondaryButton></Link>
                </div>
              </div>
            </div>}
          </div>
        </Panel>
        <Panel title="危险操作" description="清空媒体条目、文件索引和目录版本。" className="self-start">
          <button type="button" onClick={() => void clearCatalog()} disabled={clearingCatalog} className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {clearingCatalog ? "正在清空…" : "清空媒体库"}</button>
          <button type="button" onClick={() => void deleteCurrentLibrary()} className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-destructive/50 px-4 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"><Trash2 className="size-4" /> 删除媒体库</button>
        </Panel>
      </div>
    </>
  );
}

export function UserLibrarySettingsPage({ serviceId }: { serviceId: string }) { return <LibrarySettingsPage serviceId={serviceId} />; }
export function AdminLibrarySettingsPage({ serviceId }: { serviceId: string }) { return <LibrarySettingsPage serviceId={serviceId} admin />; }

/** 集中管理单个媒体库的 Jellyfin 中转、地区分组、地址和访问账号。 */
export function LibraryJellyfinSettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(async () => {
    const [service, settings] = await Promise.all([
      getLibrary(serviceId, admin).then((result) => ({ ...result.library, libraryId: result.library.id })),
      getServiceAccessSettings(serviceId, admin),
    ]);
    return { service, settings };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [updatingPlayback, setUpdatingPlayback] = useState(false);
  const [updatingDownload, setUpdatingDownload] = useState(false);
  const [updatingRegionLibraries, setUpdatingRegionLibraries] = useState(false);
  const [savingJellyfinPath, setSavingJellyfinPath] = useState(false);
  const [jellyfinPathSuffix, setJellyfinPathSuffix] = useState("");
  const [savingNavidromePath, setSavingNavidromePath] = useState(false);
  const [navidromePathSuffix, setNavidromePathSuffix] = useState("");
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [newAccountUsername, setNewAccountUsername] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingAccountUsername, setEditingAccountUsername] = useState("");
  const [editingAccountPassword, setEditingAccountPassword] = useState("");
  const [pendingAccountAction, setPendingAccountAction] = useState<string | null>(null);
  // 关键变量：账号操作同步写入引用，拦截 React 更新按钮状态之前的重复提交。
  const pendingAccountActionRef = useRef<string | null>(null);
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";

  useEffect(() => {
    if (settings?.jellyfinPathSuffix) setJellyfinPathSuffix(settings.jellyfinPathSuffix);
  }, [settings?.jellyfinPathSuffix]);

  useEffect(() => {
    if (settings?.navidromePathSuffix) setNavidromePathSuffix(settings.navidromePathSuffix);
  }, [settings?.navidromePathSuffix]);

  /** 保存音乐库独立的 Navidrome 传输方式，不影响视频协议。 */
  async function toggleNavidromeRelayPlayback(): Promise<void> {
    if (!settings || updatingPlayback) return;
    const nextEnabled = !(settings.navidromeRelayPlaybackEnabled ?? true);
    setUpdatingPlayback(true);
    try {
      await updateServiceNavidromeSettings(serviceId, { navidromeRelayPlaybackEnabled: nextEnabled }, admin);
      setMessage(nextEnabled ? "Navidrome 已切换为中转" : "Navidrome 已切换为直连优先，不满足直连条件时回退中转");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Navidrome 播放方式保存失败");
    } finally {
      setUpdatingPlayback(false);
    }
  }

  /** 保存 Jellyfin 专用中转播放开关。 */
  async function toggleJellyfinRelayPlayback(): Promise<void> {
    if (!settings || updatingPlayback) return;
    const nextEnabled = !settings.jellyfinRelayPlaybackEnabled;
    setUpdatingPlayback(true);
    try {
      await updateLibraryPlaybackSettings(serviceId, { jellyfinRelayPlaybackEnabled: nextEnabled }, admin);
      setMessage(`Jellyfin 中转播放已${nextEnabled ? "启用" : "关闭"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 中转播放设置保存失败");
    } finally {
      setUpdatingPlayback(false);
    }
  }

  /** 保存 Jellyfin 客户端影片下载权限。 */
  async function toggleJellyfinDownload(): Promise<void> {
    if (!settings || updatingDownload) return;
    const nextEnabled = !settings.jellyfinDownloadEnabled;
    setUpdatingDownload(true);
    try {
      await updateServiceJellyfinSettings(serviceId, { jellyfinDownloadEnabled: nextEnabled }, admin);
      setMessage(`Jellyfin 影片下载已${nextEnabled ? "允许" : "禁止"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 下载权限保存失败");
    } finally {
      setUpdatingDownload(false);
    }
  }

  /** 保存 Jellyfin 节目地区媒体库开关。 */
  async function toggleRegionLibraries(): Promise<void> {
    if (!settings || updatingRegionLibraries) return;
    const nextEnabled = !settings.jellyfinRegionLibrariesEnabled;
    setUpdatingRegionLibraries(true);
    try {
      await updateServiceJellyfinSettings(serviceId, { jellyfinRegionLibrariesEnabled: nextEnabled }, admin);
      setMessage(nextEnabled ? "Jellyfin 节目地区分组已启用" : "Jellyfin 节目地区分组已关闭");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 节目地区分组设置保存失败");
    } finally {
      setUpdatingRegionLibraries(false);
    }
  }

  /** 校验并保存固定 /j/ 前缀后的单层 Jellyfin 地址后缀。 */
  async function saveJellyfinPath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings || savingJellyfinPath) return;
    const pathSuffix = jellyfinPathSuffix.trim();
    if (pathSuffix.length === 0 || Array.from(pathSuffix).length > 64) {
      setMessage("Jellyfin 地址后缀长度必须为 1 至 64 个字符");
      return;
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(pathSuffix)) {
      setMessage("Jellyfin 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
      return;
    }
    if (pathSuffix === settings.jellyfinPathSuffix) {
      setMessage("Jellyfin 服务地址没有修改");
      return;
    }
    setSavingJellyfinPath(true);
    try {
      const nextSettings = await updateServiceJellyfinSettings(serviceId, { jellyfinPathSuffix: pathSuffix }, admin);
      setJellyfinPathSuffix(nextSettings.jellyfinPathSuffix);
      setMessage("Jellyfin 服务地址已保存");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 服务地址保存失败");
    } finally {
      setSavingJellyfinPath(false);
    }
  }

  /** 校验并保存固定 /n/ 前缀后的单层 Navidrome 地址后缀。 */
  async function saveNavidromePath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings || savingNavidromePath) return;
    const pathSuffix = navidromePathSuffix.trim();
    if (pathSuffix.length === 0 || Array.from(pathSuffix).length > 64) {
      setMessage("Navidrome 地址后缀长度必须为 1 至 64 个字符");
      return;
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(pathSuffix)) {
      setMessage("Navidrome 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
      return;
    }
    if (pathSuffix === settings.navidromePathSuffix) {
      setMessage("Navidrome 服务地址没有修改");
      return;
    }
    setSavingNavidromePath(true);
    try {
      const nextSettings = await updateServiceNavidromeSettings(serviceId, { navidromePathSuffix: pathSuffix }, admin);
      setNavidromePathSuffix(nextSettings.navidromePathSuffix);
      setMessage("Navidrome 服务地址已保存");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Navidrome 服务地址保存失败");
    } finally {
      setSavingNavidromePath(false);
    }
  }

  /** 占用全页账号操作槽，避免多个账号操作和刷新互相覆盖。 */
  function beginAccountAction(action: string): boolean {
    if (pendingAccountActionRef.current) return false;
    pendingAccountActionRef.current = action;
    setPendingAccountAction(action);
    return true;
  }

  /** 释放账号操作槽。 */
  function finishAccountAction(): void {
    pendingAccountActionRef.current = null;
    setPendingAccountAction(null);
  }

  /** 创建共享当前协议地址、但用户数据彼此隔离的新登录账号。 */
  async function createAccessAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings || !beginAccountAction("create")) return;
    try {
      await createServiceAccessAccount(serviceId, {
        username: newAccountUsername,
        password: newAccountPassword,
      }, admin);
      setNewAccountUsername("");
      setNewAccountPassword("");
      setShowCreateAccount(false);
      setMessage("协议访问账号已创建，可使用同一个服务地址登录");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建协议访问账号失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 打开指定账号的用户名和密码编辑区。 */
  function beginEditAccount(account: ServiceAccessAccount): void {
    setEditingAccountId(account.id);
    setEditingAccountUsername(account.username);
    setEditingAccountPassword("");
  }

  /** 保存指定协议账号的用户名和可选新密码。 */
  async function saveAccessAccount(event: FormEvent<HTMLFormElement>, account: ServiceAccessAccount): Promise<void> {
    event.preventDefault();
    if (!settings || !beginAccountAction(`save:${account.id}`)) return;
    const input: { username?: string; password?: string } = {};
    if (editingAccountUsername !== account.username) input.username = editingAccountUsername;
    // 关键变量：编辑时密码留空表示不修改，避免仅改用户名时意外清空现有密码。
    if (editingAccountPassword.length > 0) input.password = editingAccountPassword;
    if (input.username === undefined && input.password === undefined) {
      setMessage("访问用户名和密码均未修改");
      finishAccountAction();
      return;
    }
    try {
      await updateServiceAccessAccount(serviceId, account.id, input, admin);
      setEditingAccountId(null);
      setEditingAccountPassword("");
      setMessage(`账号“${editingAccountUsername}”已保存，原登录会话已撤销`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "协议访问凭据保存失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 将指定账号改为免密码登录，同时撤销其旧会话。 */
  async function clearAccessAccountPassword(account: ServiceAccessAccount): Promise<void> {
    if (!account.hasPassword || !window.confirm(`确定把账号“${account.username}”改为免密码登录吗？`)) return;
    if (!beginAccountAction(`passwordless:${account.id}`)) return;
    try {
      await updateServiceAccessAccount(serviceId, account.id, { password: "" }, admin);
      setMessage(`账号“${account.username}”已改为免密码登录`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换免密码登录失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 启用或停用指定账号，停用前需要二次确认。 */
  async function toggleAccessAccountStatus(account: ServiceAccessAccount): Promise<void> {
    const nextStatus = account.status === "active" ? "disabled" : "active";
    if (nextStatus === "disabled" && !window.confirm(`确定停用账号“${account.username}”吗？该账号现有协议会话会被撤销。`)) return;
    if (!beginAccountAction(`status:${account.id}`)) return;
    try {
      await updateServiceAccessAccount(serviceId, account.id, { status: nextStatus }, admin);
      setMessage(`账号“${account.username}”已${nextStatus === "active" ? "启用" : "停用"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改协议账号状态失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 二次确认后只撤销指定账号的协议会话。 */
  async function revokeAccessAccountSessions(account: ServiceAccessAccount): Promise<void> {
    if (!window.confirm(`确定撤销账号“${account.username}”的全部协议会话吗？观看记录不会删除。`)) return;
    if (!beginAccountAction(`sessions:${account.id}`)) return;
    try {
      const result = await revokeServiceAccessAccountSessions(serviceId, account.id, admin);
      setMessage(`账号“${account.username}”已撤销 ${result.revokedCount} 个会话`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "协议会话撤销失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 二次确认后删除账号及其独立观看记录。 */
  async function deleteAccessAccount(account: ServiceAccessAccount): Promise<void> {
    if (!window.confirm(`确定删除账号“${account.username}”吗？该账号的会话、观看进度和播放历史都会删除，此操作无法撤销。`)) return;
    if (!beginAccountAction(`delete:${account.id}`)) return;
    try {
      await deleteServiceAccessAccount(serviceId, account.id, admin);
      if (editingAccountId === account.id) setEditingAccountId(null);
      setMessage(`账号“${account.username}”及其独立观看记录已删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除协议账号失败");
    } finally {
      finishAccountAction();
    }
  }

  if (!service || !settings) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取协议访问配置…"}</div></Panel>;
  }
  const jellyfinAddress = settings.jellyfinUrl ?? `云助手 API 地址${settings.jellyfinPath}`;
  // 关键变量：旧服务响应没有 accounts 时仍把历史单账号作为列表中的第一个账号显示。
  const accessAccounts = settings.accounts?.length > 0 ? settings.accounts : [settings.account];
  const activeAccountCount = accessAccounts.filter((account) => account.status === "active").length;
  return (
    <>
      <PageHeader title={`${service.displayName} · ${settings.navidromeSupported ? "协议访问账号" : "Jellyfin 配置"}`} actions={<Link to={settingsPath} params={{ serviceId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>} />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      {!settings.navidromeSupported && <><Panel title="播放设置" description="仅影响通过 Jellyfin 协议播放，和 APP 专用播放设置互不影响。">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Jellyfin 中转播放</p>
              <p className="mt-1 text-xs text-muted-foreground">开启后使用 FlyCloudHelper 标准视频入口中转，兼容不能携带网盘请求头的第三方播放器；关闭后优先跳转网盘原始地址。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinRelayPlaybackEnabled} aria-label="启用 Jellyfin 中转播放" disabled={(!settings.relayPlaybackSupported && !settings.jellyfinRelayPlaybackEnabled) || updatingPlayback} onClick={() => void toggleJellyfinRelayPlayback()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinRelayPlaybackEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinRelayPlaybackEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
        {!settings.relayPlaybackSupported && <p className="mt-3 text-xs text-muted-foreground">当前网盘类型暂不支持中转播放。</p>}
      </Panel>
      <Panel title="下载设置" description="控制 Jellyfin 客户端是否可以下载媒体库中的原始影片文件。" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">允许下载影片</p>
              <p className="mt-1 text-xs text-muted-foreground">默认开启；下载由云助手传输原始文件，不转码，也不受 Jellyfin 播放中转开关影响。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinDownloadEnabled} aria-label="允许 Jellyfin 下载影片" disabled={updatingDownload} onClick={() => void toggleJellyfinDownload()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinDownloadEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinDownloadEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
      </Panel>
      <Panel title="媒体库分类" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">节目按地区分组</p>
              <p className="mt-1 text-xs text-muted-foreground">关闭时返回“电影、节目”；开启后节目拆分为“华语、日韩、欧美、其他”，电影不拆分。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinRegionLibrariesEnabled} aria-label="启用 Jellyfin 节目地区分组" disabled={updatingRegionLibraries} onClick={() => void toggleRegionLibraries()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinRegionLibrariesEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinRegionLibrariesEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">已有节目没有地区数据时归入“其他节目”；后续正常扫描会按刮削结果更新，不增加单独的地区补全任务。</p>
      </Panel>
      <Panel title="服务地址" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <form onSubmit={(event) => void saveJellyfinPath(event)}>
            <p className="text-xs text-muted-foreground">Jellyfin 服务地址</p>
            <div className="mt-2 flex flex-col gap-2 md:flex-row">
              <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-background/50">
                <span className="flex shrink-0 items-center border-r border-border bg-secondary/60 px-3 font-mono text-sm text-muted-foreground">/j/</span>
                <input value={jellyfinPathSuffix} maxLength={64} onChange={(event) => setJellyfinPathSuffix(event.target.value)} aria-label="Jellyfin 地址后缀" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm outline-none" />
              </div>
              <PrimaryButton type="submit" disabled={savingJellyfinPath}><Settings2 className="size-4" /> {savingJellyfinPath ? "正在保存…" : "保存地址"}</PrimaryButton>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">固定前缀不可修改；后缀在全部媒体库中不能重复，只支持文字、数字、短横线或下划线，不能包含多级路径。</p>
          </form>
          <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
            <p className="min-w-0 break-all font-mono text-xs">{jellyfinAddress}</p>
            <SecondaryButton type="button" onClick={() => void copyLibraryText(settings.jellyfinUrl ?? settings.jellyfinPath).then(() => setMessage(settings.jellyfinUrl ? "Jellyfin 服务地址已复制" : "Jellyfin 服务路径已复制"))}><Copy className="size-4" /> 复制</SecondaryButton>
          </div>
        </div>
      </Panel></>}
      {settings.navidromeSupported && (
        <Panel title="播放设置" description="控制 Navidrome 音乐播放和下载的传输方式，不转码。" className="mb-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-secondary/35 p-4">
            <div>
              <p className="text-sm font-medium">Navidrome 中转播放</p>
              <p className="mt-1 text-xs text-muted-foreground">开启后由云助手转发音频；关闭后优先直连网盘，需认证请求头或无法生成直链时回退中转。客户端直连后若无法播放，可重新开启中转。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.navidromeRelayPlaybackEnabled ?? true} aria-label="启用 Navidrome 中转播放" disabled={updatingPlayback} onClick={() => void toggleNavidromeRelayPlayback()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${(settings.navidromeRelayPlaybackEnabled ?? true) ? "border-foreground bg-foreground" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform ${(settings.navidromeRelayPlaybackEnabled ?? true) ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </Panel>
      )}
      {settings.navidromeSupported && (
        <Panel title="服务地址" description="客户端填写完整地址，固定 /n/ 前缀不可修改。">
          <div className="rounded-xl border border-border bg-secondary/35 p-4">
            <form onSubmit={(event) => void saveNavidromePath(event)}>
              <p className="text-xs text-muted-foreground">Navidrome API 地址</p>
              <div className="mt-2 flex flex-col gap-2 md:flex-row">
                <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-background/50">
                  <span className="flex shrink-0 items-center border-r border-border bg-secondary/60 px-3 font-mono text-sm text-muted-foreground">/n/</span>
                  <input value={navidromePathSuffix} maxLength={64} onChange={(event) => setNavidromePathSuffix(event.target.value)} aria-label="Navidrome 地址后缀" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm outline-none" />
                </div>
                <PrimaryButton type="submit" disabled={savingNavidromePath}><Settings2 className="size-4" /> {savingNavidromePath ? "正在保存…" : "保存地址"}</PrimaryButton>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">后缀在全部媒体库中不能重复，只支持文字、数字、短横线或下划线，不能包含多级路径。</p>
            </form>
            <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
              <p className="min-w-0 break-all font-mono text-xs">{settings.navidromeUrl ?? `云助手 API 地址${settings.navidromePath}`}</p>
              <SecondaryButton type="button" onClick={() => void copyLibraryText(settings.navidromeUrl ?? settings.navidromePath).then(() => setMessage(settings.navidromeUrl ? "Navidrome 服务地址已复制" : "Navidrome 服务路径已复制"))}><Copy className="size-4" /> 复制</SecondaryButton>
            </div>
          </div>
        </Panel>
      )}
      <Panel
        title={settings.navidromeSupported ? "Navidrome 访问账号" : "Jellyfin 账号"}
        description={`共 ${accessAccounts.length} 个账号，共享同一个服务地址；每个账号的播放记录、收藏和其他个人数据独立保存。`}
        className="mt-4"
        action={<SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setShowCreateAccount((value) => !value)}><Plus className="size-4" /> 添加账号</SecondaryButton>}
      >
        {showCreateAccount && (
          <form onSubmit={(event) => void createAccessAccount(event)} className="mb-4 grid gap-3 rounded-xl border border-border bg-secondary/35 p-4 md:grid-cols-2">
            <label><span className="text-xs text-muted-foreground">新账号用户名</span><input value={newAccountUsername} required minLength={4} maxLength={255} onChange={(event) => setNewAccountUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <label><span className="text-xs text-muted-foreground">登录密码（可选）</span><input value={newAccountPassword} type="password" autoComplete="new-password" placeholder="留空则无需密码" onChange={(event) => setNewAccountPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <PrimaryButton type="submit" disabled={pendingAccountAction !== null}><Plus className="size-4" /> {pendingAccountAction === "create" ? "正在创建…" : "创建账号"}</PrimaryButton>
              <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setShowCreateAccount(false)}>取消</SecondaryButton>
            </div>
          </form>
        )}
        <div className="space-y-3">
          {accessAccounts.map((account, index) => {
            const editing = editingAccountId === account.id;
            const accountPending = pendingAccountAction?.endsWith(account.id) ?? false;
            return (
              <article key={account.id} className="rounded-xl border border-border bg-secondary/35 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{account.username}</p>
                      <StatusPill tone={account.status === "active" ? "success" : "neutral"}>{account.status === "active" ? "已启用" : "已停用"}</StatusPill>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{index === 0 ? "第一个账号 · " : ""}{account.hasPassword ? "需要密码" : "免密码"} · 凭据 r{account.credentialRevision}</p>
                    {settings.navidromeSupported && account.hasPassword && account.subsonicTokenAuthReady === false && (
                      <p className="mt-2 text-xs text-amber-600">该账号来自旧版本，请编辑并重新设置一次密码后再用于 Navidrome 客户端登录。</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => beginEditAccount(account)}><Pencil className="size-4" /> 编辑</SecondaryButton>
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => void revokeAccessAccountSessions(account)}>撤销会话</SecondaryButton>
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null || (account.status === "active" && activeAccountCount <= 1)} onClick={() => void toggleAccessAccountStatus(account)}>{account.status === "active" ? "停用" : "启用"}</SecondaryButton>
                    <button type="button" disabled={pendingAccountAction !== null || accessAccounts.length <= 1} onClick={() => void deleteAccessAccount(account)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /> {accountPending && pendingAccountAction?.startsWith("delete:") ? "正在删除…" : "删除"}</button>
                  </div>
                </div>
                {editing && (
                  <form onSubmit={(event) => void saveAccessAccount(event, account)} className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2">
                    <label><span className="text-xs text-muted-foreground">访问用户名</span><input value={editingAccountUsername} required minLength={4} maxLength={255} onChange={(event) => setEditingAccountUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
                    <label><span className="text-xs text-muted-foreground">新密码</span><input value={editingAccountPassword} type="password" autoComplete="new-password" placeholder="留空表示不修改" onChange={(event) => setEditingAccountPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
                    <div className="flex flex-wrap gap-2 md:col-span-2">
                      <PrimaryButton type="submit" disabled={pendingAccountAction !== null}><Settings2 className="size-4" /> {accountPending && pendingAccountAction?.startsWith("save:") ? "正在保存…" : "保存账号"}</PrimaryButton>
                      {account.hasPassword && <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => void clearAccessAccountPassword(account)}>改为免密码</SecondaryButton>}
                      <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setEditingAccountId(null)}>取消</SecondaryButton>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      </Panel>
    </>
  );
}

export function UserLibraryJellyfinSettingsPage({ serviceId }: { serviceId: string }) { return <LibraryJellyfinSettingsPage serviceId={serviceId} />; }
export function AdminLibraryJellyfinSettingsPage({ serviceId }: { serviceId: string }) { return <LibraryJellyfinSettingsPage serviceId={serviceId} admin />; }

/** 展示固定单一媒体库作用域的海报墙。 */
export function LibraryCatalogPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const [catalogQuery, setCatalogQuery] = useState<MediaCatalogQuery>({
    search: "",
    mediaType: "all",
    videoItemType: "all",
    musicItemType: "all",
    matchState: "matched",
    sort: "created_desc",
  });
  const [pageOffset, setPageOffset] = useState(0);
  const resource = useApiResource(async () => {
    const service = await getLibrary(serviceId, admin).then((result) => ({ ...result.library, libraryId: result.library.id }));
    const selectedItemType = catalogQuery.musicItemType !== "all"
      ? catalogQuery.musicItemType
      : catalogQuery.videoItemType === "all" ? undefined : catalogQuery.videoItemType;
    const options = {
      search: catalogQuery.search || undefined,
      mediaType: catalogQuery.mediaType === "all" ? service.dataType : catalogQuery.mediaType,
      // 音乐库“全部”默认只展示专辑，歌曲和艺术家必须从独立分类进入。
      itemType: selectedItemType ?? (service.dataType === "music" ? "music.album" : undefined),
      matchState: catalogQuery.matchState === "all" ? undefined : catalogQuery.matchState,
      sort: catalogQuery.sort,
      limit: LIBRARY_CATALOG_PAGE_SIZE,
      offset: pageOffset,
    };
    const catalog = admin
      ? await listAdminServiceItems(service.sourceServiceId, options)
      : await listLibraryItems(service.id, options);
    return { service, catalog };
  }, [serviceId, admin, catalogQuery.search, catalogQuery.mediaType, catalogQuery.videoItemType, catalogQuery.musicItemType, catalogQuery.matchState, catalogQuery.sort, pageOffset]);

  /** 筛选变化后回到第一页，相同筛选不触发重复请求。 */
  const updateCatalogQuery = useCallback((nextQuery: MediaCatalogQuery): void => {
    setCatalogQuery((currentQuery) => {
      const unchanged = currentQuery.search === nextQuery.search
        && currentQuery.mediaType === nextQuery.mediaType
        && currentQuery.videoItemType === nextQuery.videoItemType
        && currentQuery.musicItemType === nextQuery.musicItemType
        && currentQuery.matchState === nextQuery.matchState
        && currentQuery.sort === nextQuery.sort;
      return unchanged ? currentQuery : nextQuery;
    });
    setPageOffset(0);
  }, []);

  if (!resource.data) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取媒体库海报墙…"}</div></Panel>;
  }
  const { service, catalog } = resource.data;
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";
  return (
    <>
      <PageHeader title={`${service.displayName} · 海报墙`} actions={<div className="flex flex-wrap gap-2"><Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link><Link to={settingsPath} params={{ serviceId }}><SecondaryButton>媒体库设置</SecondaryButton></Link></div>} />
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <MediaCatalogView contextDescription={`${admin ? `用户 ${service.ownerUsername} · ` : ""}${service.displayName} · ${service.libraryId}`} items={catalog.items} total={catalog.total} catalogVersion={service.catalogVersion} fixedService showOwner={admin} admin={admin} loading={resource.loading} onRefresh={() => void resource.refresh()} serverFiltered pageOffset={pageOffset} pageLimit={LIBRARY_CATALOG_PAGE_SIZE} onQueryChange={updateCatalogQuery} onPageChange={setPageOffset} />
    </>
  );
}

export function UserLibraryCatalogPage({ serviceId }: { serviceId: string }) { return <LibraryCatalogPage serviceId={serviceId} />; }
export function AdminLibraryCatalogPage({ serviceId }: { serviceId: string }) { return <LibraryCatalogPage serviceId={serviceId} admin />; }
