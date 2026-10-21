import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import type { MediaLibrary } from "@/lib/api";
import { getAbsSettings, updateAbsSettings } from "@/lib/abs-api";
import { getLibraryFlyAudiobookSettings, saveLibraryFlyAudiobookSettings } from "@/lib/native-audiobook-api";
import { NativeSkeleton, useNativeResource } from "@/pages/native-audiobook/components";

/** 听书协议入口沿用网盘媒体库的分行布局、配置按钮和即时开关。 */
export function LibraryAudiobookProtocols({ state }: { state: { library: MediaLibrary; admin: boolean } }) {
  const abs = useNativeResource(() => getAbsSettings(state.library.id, state.admin), [state.library.id, state.admin]);
  const native = useNativeResource(() => getLibraryFlyAudiobookSettings(state.library.id), [state.library.id]);
  const [action, setAction] = useState<"abs" | "flyaudiobook" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const service = native.data?.Service;
  const absPath = state.admin ? "/admin/libraries/$serviceId/abs" : "/app/libraries/$serviceId/abs";
  const nativePath = state.admin ? "/admin/libraries/$serviceId/flyaudiobook" : "/app/libraries/$serviceId/flyaudiobook";

  /** ABS 总开关只更新当前库，保留原有独立账号与收听资料。 */
  async function toggleAbs(): Promise<void> {
    if (lock.current || !abs.data) return;
    lock.current = true; setAction("abs"); setMessage(null);
    try {
      await updateAbsSettings(state.library.id, { enabled: !abs.data.enabled }, state.admin);
      await abs.refresh(); setMessage("ABS 设置已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "ABS 设置保存失败"); }
    finally { lock.current = false; setAction(null); }
  }

  /** 首次开启才建立单库协议配置，关闭撤销登录但保留账号与收听记录。 */
  async function toggleNative(): Promise<void> {
    if (lock.current || !native.data) return;
    if (service?.Enabled && !window.confirm("关闭 FlyAudioBook 会撤销设备登录，账号和收听记录保留。继续？")) return;
    lock.current = true; setAction("flyaudiobook"); setMessage(null);
    try {
      await saveLibraryFlyAudiobookSettings(state.library, service ?? null, { Enabled: !service?.Enabled });
      await native.refresh(); setMessage("FlyAudioBook 设置已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "FlyAudioBook 设置保存失败"); await native.refresh(); }
    finally { lock.current = false; setAction(null); }
  }

  return <Panel title="播放与协议" description="管理 ABS、FlyAudioBook 客户端访问。">
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p className="text-sm font-medium">ABS 协议</p><p className="mt-0.5 text-xs text-muted-foreground">使用真实章节时长构建全书时间轴。</p></div>
        <div className="flex shrink-0 items-center gap-3">
          <Link to={absPath} params={{ serviceId: state.library.id }}><SecondaryButton><Settings2 className="size-4" />配置</SecondaryButton></Link>
          <button type="button" role="switch" aria-checked={abs.data?.enabled ?? false} aria-label="启用 ABS 协议" disabled={action !== null || abs.loading || !abs.data} onClick={() => void toggleAbs()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${abs.data?.enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${abs.data?.enabled ? "translate-x-5" : "translate-x-0"}`} /></button>
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><p className="text-sm font-medium">FlyAudioBook 协议</p><p className="mt-0.5 text-xs text-muted-foreground">支持未知章节时长、分页目录和按章播放。</p></div>
        <div className="flex shrink-0 items-center gap-3">
          <Link to={nativePath} params={{ serviceId: state.library.id }}><SecondaryButton><Settings2 className="size-4" />配置</SecondaryButton></Link>
          <button type="button" role="switch" aria-checked={service?.Enabled ?? false} aria-label="启用 FlyAudioBook 协议" disabled={action !== null || native.loading || !native.data || service?.Deleting} onClick={() => void toggleNative()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${service?.Enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${service?.Enabled ? "translate-x-5" : "translate-x-0"}`} /></button>
        </div>
      </div>
    </div>
    {(!abs.data && abs.loading || !native.data && native.loading) && <div className="mt-3"><NativeSkeleton /></div>}
    {(abs.error || native.error) && <p role="alert" className="mt-3 text-xs text-destructive">{abs.error || native.error}</p>}
    {message && <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p>}
  </Panel>;
}
