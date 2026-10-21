import { Link } from "@tanstack/react-router";
import { Copy, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { getLibrary } from "@/lib/api";
import { getLibraryFlyAudiobookSettings, nativeAudiobookAddress, saveLibraryFlyAudiobookSettings } from "@/lib/native-audiobook-api";
import { NativeAccountsPanel } from "./native-audiobook/AccountsPanel";
import { copyNativeText, NativeSkeleton, NativeToggle, useNativeResource } from "./native-audiobook/components";

/** 当前媒体库独立暴露 FlyAudioBook，沿用 ABS 的地址、开关和账号设置流程。 */
export function LibraryFlyAudiobookSettingsPage({ libraryId, admin = false }: { libraryId: string; admin?: boolean }) {
  const resource = useNativeResource(async () => {
    const [detail, settings] = await Promise.all([getLibrary(libraryId, admin), getLibraryFlyAudiobookSettings(libraryId)]);
    if (detail.library.dataType !== "audiobook") throw new Error("只有有声书媒体库提供 FlyAudioBook 设置");
    return { library: detail.library, service: settings.Service };
  }, [libraryId, admin]);
  const [suffix, setSuffix] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const service = resource.data?.service;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";

  // 关键变量：刷新后沿用当前库的实际地址和开关，不重置已有协议身份或账号。
  useEffect(() => {
    if (!resource.data) return;
    setSuffix(resource.data.service?.PathSuffix ?? resource.data.library.id);
  }, [service?.PathSuffix, resource.data?.library.id]);

  /** 与网盘协议配置相同，开关立即保存，未保存的地址草稿不随开关提交。 */
  async function saveSwitch(patch: { Enabled?: boolean; RelayPlaybackEnabled?: boolean }): Promise<void> {
    if (lock.current || !resource.data) return;
    if (service?.Enabled && patch.Enabled === false && !window.confirm("关闭 FlyAudioBook 会撤销设备登录，账号和收听记录保留。继续？")) return;
    lock.current = true; setBusy(true); setMessage(null);
    try {
      await saveLibraryFlyAudiobookSettings(resource.data.library, service ?? null, patch);
      await resource.refresh(); setMessage("FlyAudioBook 设置已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "FlyAudioBook 设置保存失败"); }
    finally { lock.current = false; setBusy(false); }
  }

  /** 保存固定单库协议，不展示入口模式、选库或独立服务创建表单。 */
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (lock.current || !resource.data) return;
    const pathSuffix = suffix.trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(pathSuffix)) { setMessage("地址后缀应为 1 到 64 个文字、数字、短横线或下划线"); return; }
    lock.current = true; setBusy(true); setMessage(null);
    try {
      await saveLibraryFlyAudiobookSettings(resource.data.library, service ?? null, { PathSuffix: pathSuffix });
      await resource.refresh(); setMessage("FlyAudioBook 设置已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "FlyAudioBook 设置保存失败"); }
    finally { lock.current = false; setBusy(false); }
  }

  /** 复制实际注册的服务地址，未保存时不显示可连接地址。 */
  async function copy(): Promise<void> {
    if (!service) return;
    try { await copyNativeText(nativeAudiobookAddress(service)); setMessage("FlyAudioBook 服务地址已复制"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "复制失败"); }
  }

  return <>
    <PageHeader title={`${resource.data?.library.displayName ?? "有声书媒体库"} · FlyAudioBook 配置`} actions={<Link to={settingsPath} params={{ serviceId: libraryId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>} />
    {(message || resource.error) && <Panel className="mb-4"><p role={resource.error ? "alert" : "status"} className={`text-sm ${resource.error ? "text-destructive" : "text-muted-foreground"}`}>{resource.error || message}</p></Panel>}
    {!resource.data && resource.loading && <NativeSkeleton />}
    {resource.data && <>
      <Panel title="FlyAudioBook 设置" description="协议播放和服务地址集中管理，使用独立账号访问当前媒体库。">
        <div className="grid gap-2 md:grid-cols-2">
          <NativeToggle state={{ label: "启用 FlyAudioBook", description: "关闭撤销登录，保留账号和收听记录", checked: service?.Enabled ?? false, disabled: busy || resource.loading || service?.Deleting, onChange: (value) => void saveSwitch({ Enabled: value }) }} />
          <NativeToggle state={{ label: "中转播放", description: "关闭后优先使用来源原始地址", checked: service?.RelayPlaybackEnabled ?? true, disabled: busy || resource.loading || service?.Deleting, onChange: (value) => void saveSwitch({ RelayPlaybackEnabled: value }) }} />
        </div>
        <div className="mt-3 grid gap-3 border-t border-border pt-3 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
          <form onSubmit={(event) => void save(event)} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-background/50"><span className="flex shrink-0 items-center border-r border-border bg-secondary/60 px-3 font-mono text-sm text-muted-foreground">/fab/</span><input aria-label="FlyAudioBook 地址后缀" required maxLength={64} value={suffix} disabled={busy || resource.loading || service?.Deleting} onChange={(event) => setSuffix(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm outline-none" /></div>
            <PrimaryButton type="submit" disabled={busy || resource.loading || service?.Deleting}><Settings2 className="size-4" />{busy ? "保存中…" : "保存地址"}</PrimaryButton>
          </form>
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-secondary/25 px-3 py-2"><p className="min-w-0 truncate font-mono text-xs" title={service ? nativeAudiobookAddress(service) : undefined}>{service ? nativeAudiobookAddress(service) : "保存后生成服务地址"}</p><SecondaryButton disabled={!service} onClick={() => void copy()}><Copy className="size-4" />复制</SecondaryButton></div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">一级路径固定为 /fab/；二级后缀可自定义，不支持多级路径。</p>
        <p className="mt-1 text-[11px] text-muted-foreground">支持未知章节时长，按章原样播放；来源需要额外请求头时使用中转。</p>
      </Panel>
      {service ? <NativeAccountsPanel key={service.ServiceId} state={{ service, admin }} /> : <Panel title="FlyAudioBook 访问账号" className="mt-4"><p className="text-sm text-muted-foreground">保存协议设置后即可添加当前媒体库的访问账号。</p></Panel>}
    </>}
  </>;
}
