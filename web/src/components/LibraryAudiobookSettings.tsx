import { Link } from "@tanstack/react-router";
import { CalendarClock, Copy, LibraryBig, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ServicePathPicker } from "@/components/ServicePathPicker";
import { Panel } from "@/components/ui-kit";
import { updateLibraryMetadataProfile, type MediaLibrary, type ProviderDirectory } from "@/lib/api";
import { getAbsSettings, resolveAbsAddress, updateAbsSettings } from "@/lib/abs-api";
import { useApiResource } from "@/lib/use-api-resource";

/** 复用媒体库现有扫描、通知和删除流程，有声书展示独立元数据与 ABS 协议。 */
interface AudiobookSettingsState {
  library: MediaLibrary;
  admin: boolean;
  metadataProfile: Record<string, unknown>;
  fullRoots: ProviderDirectory[];
  incrementalRoots: ProviderDirectory[];
  message: string | null;
  scanActionFeedback: { message: string; failed: boolean } | null;
  creatingScanMode: "full" | "incremental" | null;
  clearingCatalog: boolean;
  unlinkingService: boolean;
  updatingNotification: boolean;
  onRefresh: () => Promise<void>;
  onSaveRoots: (mode: "full" | "incremental", directories: ProviderDirectory[]) => Promise<void>;
  onScan: (mode: "full" | "incremental") => Promise<void>;
  onClear: () => Promise<void>;
  onDelete: () => Promise<void>;
  onUnlink: () => Promise<void>;
  onToggleNotification: () => Promise<void>;
}

/** 读取当前有声书的本地元数据配置，不把音乐或视频参数带入。 */
function readAudiobookProfile(metadata: Record<string, unknown>): Record<string, unknown> {
  const profiles = metadata.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return {};
  const audiobook = (profiles as Record<string, unknown>).audiobook;
  return audiobook && typeof audiobook === "object" && !Array.isArray(audiobook)
    ? (audiobook as Record<string, unknown>)
    : {};
}

/** 有声书库紧凑设置，扫描按书籍聚合，独立协议通过各自设置页管理。 */
export function LibraryAudiobookSettings({ state }: { state: AudiobookSettingsState }) {
  const { library, admin } = state;
  const abs = useApiResource(() => getAbsSettings(library.id, admin), [library.id, admin]);
  const [preferEmbeddedMetadata, setPreferEmbeddedMetadata] = useState(true);
  const [extractEmbeddedChapters, setExtractEmbeddedChapters] = useState(true);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savingProtocol, setSavingProtocol] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const catalogPath = admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog";
  const absPath = admin ? "/admin/libraries/$serviceId/abs" : "/app/libraries/$serviceId/abs";
  const schedulePath = admin
    ? "/admin/libraries/$serviceId/scan-schedules"
    : "/app/libraries/$serviceId/scan-schedules";
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";

  useEffect(() => {
    const profile = readAudiobookProfile(state.metadataProfile);
    setPreferEmbeddedMetadata(profile.preferEmbeddedMetadata !== false);
    setExtractEmbeddedChapters(profile.extractEmbeddedChapters !== false);
  }, [state.metadataProfile]);

  /** 只保存本地音频标签和内嵌章节设置，其他媒体配置保持原值。 */
  async function saveMetadata(): Promise<void> {
    if (savingMetadata) return;
    setSavingMetadata(true);
    try {
      const profiles =
        state.metadataProfile.profiles &&
        typeof state.metadataProfile.profiles === "object" &&
        !Array.isArray(state.metadataProfile.profiles)
          ? (state.metadataProfile.profiles as Record<string, unknown>)
          : {};
      await updateLibraryMetadataProfile(
        library.id,
        {
          ...state.metadataProfile,
          profiles: {
            ...profiles,
            audiobook: {
              ...readAudiobookProfile(state.metadataProfile),
              enabled: true,
              provider: "local",
              preferEmbeddedMetadata,
              extractEmbeddedChapters,
            },
          },
        },
        admin,
      );
      setMessage("有声书元数据配置已保存");
      await state.onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "元数据保存失败");
    } finally {
      setSavingMetadata(false);
    }
  }

  /** 切换 ABS 开关，只影响当前有声书库。 */
  async function toggleProtocol(): Promise<void> {
    if (!abs.data || savingProtocol) return;
    setSavingProtocol(true);
    try {
      await updateAbsSettings(library.id, { enabled: !abs.data.enabled }, admin);
      await abs.refresh();
      setMessage("ABS 协议开关已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ABS 设置保存失败");
    } finally {
      setSavingProtocol(false);
    }
  }

  /** 复制客户端填写的完整协议根地址。 */
  async function copyAddress(): Promise<void> {
    if (!abs.data) return;
    try {
      const address = resolveAbsAddress(abs.data);
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
      setMessage("ABS 服务地址已复制");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复制失败");
    }
  }

  return (
    <>
      <PageHeader
        title={`${library.displayName} · 有声书库设置`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to={librariesPath}>
              <SecondaryButton>返回媒体库</SecondaryButton>
            </Link>
            <Link to={schedulePath} params={{ serviceId: library.id }}>
              <SecondaryButton>
                <CalendarClock className="size-4" />
                定时任务
              </SecondaryButton>
            </Link>
            <Link to={admin ? "/admin/audiobook-services" : "/app/audiobook-services"} search={{ libraryId: library.id }}>
              <SecondaryButton><Settings2 className="size-4" />原生听书设置</SecondaryButton>
            </Link>
            <Link to={catalogPath} params={{ serviceId: library.id }}>
              <PrimaryButton>
                <LibraryBig className="size-4" />
                书库
              </PrimaryButton>
            </Link>
          </div>
        }
      />
      {(message || state.message) && (
        <Panel className="mb-3">
          <p role="status" className="text-sm text-muted-foreground">
            {message || state.message}
          </p>
        </Panel>
      )}
      <Panel title="关联服务" className="mb-3 p-4 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{library.sourceServiceName || "来源服务"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {library.providerType} ·{" "}
              {library.sourceConnectionStatus === "valid" ? "连接正常" : "需要重新登录"}
            </p>
          </div>
          <div className="flex gap-2">
            {library.sourceServiceId && (
              <Link
                to={admin ? "/admin/services/$serviceId" : "/app/services/$serviceId"}
                params={{ serviceId: library.sourceServiceId }}
              >
                <SecondaryButton>查看服务</SecondaryButton>
              </Link>
            )}
            <SecondaryButton disabled={state.unlinkingService} onClick={() => void state.onUnlink()}>
              取消关联
            </SecondaryButton>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          取消最后一个服务关联会同时删除当前媒体库，来源网盘服务继续保留。
        </p>
      </Panel>
      <div className="grid gap-3 sm:grid-cols-3">
        <Panel className="p-3 sm:p-3">
          <span className="text-xs text-muted-foreground">目录条目</span>
          <span className="float-right text-sm font-medium">{library.itemCount.toLocaleString()}</span>
        </Panel>
        <Panel className="p-3 sm:p-3">
          <span className="text-xs text-muted-foreground">目录版本</span>
          <span className="float-right text-sm font-medium">v{library.catalogVersion}</span>
        </Panel>
        <Panel className="p-3 sm:p-3">
          <span className="text-xs text-muted-foreground">ABS</span>
          <span className="float-right text-sm font-medium">
            {abs.loading ? "读取中" : abs.error ? "读取失败" : abs.data?.enabled ? "已启用" : "未启用"}
          </span>
        </Panel>
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Panel
          title="扫描路径"
          description="按书籍聚合章节文件；已有书库资料和当前收听记录保持独立。"
          className="p-4 sm:p-4"
        >
          <div className="grid gap-3">
            <ServicePathPicker
              serviceId={library.sourceServiceId}
              admin={admin}
              label="全量扫描目录"
              value={state.fullRoots}
              onConfirm={(directories) => state.onSaveRoots("full", directories)}
            />
            <ServicePathPicker
              serviceId={library.sourceServiceId}
              admin={admin}
              label="增量扫描目录"
              value={state.incrementalRoots}
              onConfirm={(directories) => state.onSaveRoots("incremental", directories)}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <SecondaryButton
              disabled={state.creatingScanMode !== null || state.fullRoots.length === 0}
              onClick={() => void state.onScan("full")}
            >
              <ScanLine className="size-4" />
              {state.creatingScanMode === "full" ? "创建中…" : "全量扫描"}
            </SecondaryButton>
            <PrimaryButton
              disabled={state.creatingScanMode !== null || state.incrementalRoots.length === 0}
              onClick={() => void state.onScan("incremental")}
            >
              <ScanLine className="size-4" />
              {state.creatingScanMode === "incremental" ? "创建中…" : "增量扫描"}
            </PrimaryButton>
          </div>
          {state.scanActionFeedback && (
            <p
              role="status"
              className={`mt-2 text-xs ${state.scanActionFeedback.failed ? "text-destructive" : "text-muted-foreground"}`}
            >
              {state.scanActionFeedback.message}
            </p>
          )}
        </Panel>
        <Panel
          title="元数据"
          description="使用文件名、目录和音频标签识别书籍、作者、演播者及章节。"
          className="p-4 sm:p-4"
        >
          <div className="grid gap-3 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={preferEmbeddedMetadata}
                onChange={(event) => setPreferEmbeddedMetadata(event.target.checked)}
                className="size-4 accent-foreground"
              />
              优先音频内嵌标签
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={extractEmbeddedChapters}
                onChange={(event) => setExtractEmbeddedChapters(event.target.checked)}
                className="size-4 accent-foreground"
              />
              读取音频内嵌章节
            </label>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            没有内嵌章节时按音轨生成章节，封面从音频内嵌图片读取。
          </p>
          <div className="mt-3">
            <SecondaryButton disabled={savingMetadata} onClick={() => void saveMetadata()}>
              {savingMetadata ? "正在保存…" : "保存元数据配置"}
            </SecondaryButton>
          </div>
        </Panel>
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(240px,1fr)]">
        <Panel
          title="播放与协议"
          description="有声书通过标准 Audiobookshelf 协议访问，使用原音频播放。"
          className="p-4 sm:p-4"
        >
          {abs.error ? (
            <p role="alert" className="text-sm text-destructive">
              {abs.error}
            </p>
          ) : !abs.data ? (
            <div aria-label="ABS 配置加载中" className="h-12 animate-pulse rounded bg-muted" />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">ABS 协议</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {resolveAbsAddress(abs.data)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {abs.data.accounts.length} 个独立账号 ·{" "}
                    {abs.data.relayPlaybackEnabled ? "中转播放" : "直连优先"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SecondaryButton onClick={() => void copyAddress()}>
                    <Copy className="size-4" />
                    复制
                  </SecondaryButton>
                  <Link to={absPath} params={{ serviceId: library.id }}>
                    <SecondaryButton>
                      <Settings2 className="size-4" />
                      账号与配置
                    </SecondaryButton>
                  </Link>
                  <label className="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={abs.data.enabled}
                      disabled={savingProtocol}
                      onChange={() => void toggleProtocol()}
                      className="size-4 accent-foreground"
                    />
                    启用
                  </label>
                </div>
              </div>
            </>
          )}
        </Panel>
        <Panel title="危险操作" description="清空或删除当前有声书库数据。" className="p-4 sm:p-4">
          <button
            type="button"
            disabled={state.clearingCatalog}
            onClick={() => void state.onClear()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive disabled:opacity-40"
          >
            <Trash2 className="size-4" />
            {state.clearingCatalog ? "正在清空…" : "清空媒体库"}
          </button>
          <button
            type="button"
            onClick={() => void state.onDelete()}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive"
          >
            <Trash2 className="size-4" />
            删除媒体库
          </button>
        </Panel>
      </div>
      <Panel title="任务通知" className="mt-3 p-4 sm:p-4">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>扫描任务完成通知</span>
          <input
            type="checkbox"
            checked={library.notificationEnabled}
            disabled={state.updatingNotification}
            onChange={() => void state.onToggleNotification()}
            className="size-4 accent-foreground"
          />
        </label>
      </Panel>
    </>
  );
}
