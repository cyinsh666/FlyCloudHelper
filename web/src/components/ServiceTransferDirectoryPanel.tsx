import { useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { ServicePathPicker, toProviderDirectory } from "@/components/ServicePathPicker";
import { Panel } from "@/components/ui-kit";
import { getServiceTransferDirectory, saveServiceTransferDirectory, getSubscriptionTransferSettings,
  saveSubscriptionTransferSettings, type ProviderDirectory } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 网盘服务独立的分享转存落点，手动与后续自动转存共同读取。 */
export function ServiceTransferDirectoryPanel({ serviceId, admin }: { serviceId: string; admin: boolean }) {
  const resource = useApiResource(() => getServiceTransferDirectory(serviceId, admin), [serviceId, admin]);
  const settings = useApiResource(() => getSubscriptionTransferSettings(serviceId, admin), [serviceId, admin]);
  // 关键变量：只在当前服务面板保存开关结果，不触发其他页面刷新。
  const [savedSetting, setSavedSetting] = useState<{ serviceId: string; replaceName: boolean } | null>(null);
  const [savingSetting, setSavingSetting] = useState(false);
  const replaceName = savedSetting?.serviceId === serviceId ? savedSetting.replaceName : settings.data?.replaceName ?? false;
  // 关键变量：保存后立即展示新目录；初次加载或服务切换时仍以服务端数据为准。
  const [saved, setSaved] = useState<ProviderDirectory | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const directory = saved === undefined ? resource.data : saved;

  /** 开关独立保存，只刷新当前面板状态。 */
  async function changeReplaceName(enabled: boolean): Promise<void> {
    setSavingSetting(true);
    setError(null);
    try {
      const next = await saveSubscriptionTransferSettings(serviceId, enabled, admin);
      setSavedSetting({ serviceId, replaceName: next.replaceName });
      setMessage("订阅转存设置已保存，仅影响后续提交的任务");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存订阅转存设置失败"); }
    finally { setSavingSetting(false); }
  }

  /** 路径选择器每次只允许保留一个目录，保存时由服务端复查网盘目录。 */
  async function save(directories: ProviderDirectory[]): Promise<void> {
    const selected = directories[0];
    if (!selected) throw new Error("请选择一个转存目录");
    setSaving(true);
    setError(null);
    try {
      const next = await saveServiceTransferDirectory(serviceId, selected, admin);
      setSaved(next ? toProviderDirectory(next) : null);
      setMessage("转存目录已保存");
    } catch (failure) {
      const text = failure instanceof Error ? failure.message : "保存转存目录失败";
      setError(text);
      throw failure;
    } finally { setSaving(false); }
  }

  /** 清空当前服务的转存目录，后续转存须重新选择落点。 */
  async function clear(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveServiceTransferDirectory(serviceId, null, admin);
      setSaved(null);
      setMessage("转存目录已清空");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "清空转存目录失败"); }
    finally { setSaving(false); }
  }

  return <Panel title="转存目录" description="手动转存使用此目录，后续订阅自动转存也将使用同一目录；与影片整理的来源、目标目录分别配置。" className="mt-4">
    {resource.loading && saved === undefined && <div className="h-24 animate-pulse rounded-lg bg-secondary" aria-label="转存目录加载中" />}
    {(resource.error || error) && <p role="alert" className="mb-3 text-sm text-destructive">{error || resource.error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
    {(saved !== undefined || !resource.loading) && <>
      <ServicePathPicker serviceId={serviceId} admin={admin} label="转存目录" maxSelection={1}
        value={directory ? [toProviderDirectory(directory)] : []} onConfirm={save} />
      {directory && <div className="mt-3"><SecondaryButton disabled={saving} onClick={() => void clear()}>清空转存目录</SecondaryButton></div>}
      {settings.loading ? <div className="mt-4 h-16 animate-pulse rounded-lg bg-secondary" aria-label="订阅转存设置加载中" />
        : settings.error ? <p role="alert" className="mt-4 text-sm text-destructive">{settings.error}</p>
        : settings.data?.supported && <div className="mt-4 flex items-start justify-between gap-4 rounded-lg border p-4">
          <span><span className="text-sm font-medium">订阅转存使用片名替换</span>
            <span className="mt-1 block text-xs text-muted-foreground">将订阅自动转存的根目录名称替换为标准影片名称，格式为“影片名(年份)&#123;tmdbid&#125;”。</span></span>
          <button type="button" role="switch" aria-label="订阅转存使用片名替换" aria-checked={replaceName}
            disabled={savingSetting} onClick={() => void changeReplaceName(!replaceName)}
            className={`relative h-7 w-12 shrink-0 rounded-full border border-border transition-colors disabled:opacity-40 ${replaceName ? "bg-foreground" : "bg-secondary"}`}>
            <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-background transition-transform ${replaceName ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>}
    </>}
  </Panel>;
}
