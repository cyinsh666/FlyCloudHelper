import { useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { ServicePathPicker, toProviderDirectory } from "@/components/ServicePathPicker";
import { Panel } from "@/components/ui-kit";
import { getServiceTransferDirectory, saveServiceTransferDirectory, type ProviderDirectory } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 网盘服务独立的分享转存落点，手动与后续自动转存共同读取。 */
export function ServiceTransferDirectoryPanel({ serviceId, admin }: { serviceId: string; admin: boolean }) {
  const resource = useApiResource(() => getServiceTransferDirectory(serviceId, admin), [serviceId, admin]);
  // 关键变量：保存后立即展示新目录；初次加载或服务切换时仍以服务端数据为准。
  const [saved, setSaved] = useState<ProviderDirectory | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const directory = saved === undefined ? resource.data : saved;

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
    </>}
  </Panel>;
}
