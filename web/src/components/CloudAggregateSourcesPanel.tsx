import { useState } from "react";
import { PrimaryButton } from "@/components/ConsoleShell";
import { ProviderSelectionIcon } from "@/components/ServiceCreateSelection";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  addLibrarySource,
  deleteLibrarySource,
  listServices,
  updateLibrarySource,
  type LibrarySource,
  type MediaLibrary,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

interface CloudAggregateSourcesPanelProps {
  library: MediaLibrary;
  admin: boolean;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
}

/** 以紧凑 Grid 管理云聚合库来源；连接状态和凭据由独立网盘服务统一提供。 */
export function CloudAggregateSourcesPanel({ library, admin, onChanged, onMessage }: CloudAggregateSourcesPanelProps) {
  const services = useApiResource(async () => admin ? [] : (await listServices(false)).items, [admin]);
  const [addingServiceId, setAddingServiceId] = useState("");
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const sourceIds = new Set(library.sources.flatMap((source) => {
    if (source.serviceId) return [source.serviceId];
    const legacyTemplateServiceId = source.configuration.templateServiceId;
    return typeof legacyTemplateServiceId === "string" && legacyTemplateServiceId ? [legacyTemplateServiceId] : [];
  }));
  // 关键变量：同一个网盘服务在当前聚合库只添加一次，但可以同时被旧单媒体库引用。
  const availableServices = (services.data ?? []).filter((service) => !sourceIds.has(service.id));

  /** 只有服务启用、凭据存在且连接有效时，来源才具备正常可用状态。 */
  function isSourceConnectionReady(source: LibrarySource): boolean {
    return source.connectionStatus === "valid"
      && source.credentialConfigured
      && (source.serviceStatus === null || source.serviceStatus === "active");
  }

  /** 将共享服务状态转换为来源卡片上的紧凑提示。 */
  function getSourceStateLabel(source: LibrarySource): string {
    if (source.serviceStatus === "scanning") return "扫描中";
    if (source.serviceStatus === "disabled") return "服务停用";
    if (!source.credentialConfigured || source.connectionStatus !== "valid") return "待授权";
    return source.status === "active" ? "已启用" : "已停用";
  }

  /** 说明当前来源为什么可用或不可用，避免把服务扫描误报成登录异常。 */
  function getSourceConnectionLabel(source: LibrarySource): string {
    if (source.serviceStatus === "scanning") return "服务正在扫描";
    if (source.serviceStatus === "disabled") return "服务已停用";
    if (!source.credentialConfigured) return "登录凭据缺失";
    if (source.connectionStatus !== "valid") return "需要重新登录";
    return "连接正常";
  }

  /** 将已有网盘服务加入聚合库，连接状态共享，扫描配置保持当前媒体库独立。 */
  async function addSource(): Promise<void> {
    if (!addingServiceId) return;
    setBusySourceId(addingServiceId);
    try {
      const source = await addLibrarySource(library.id, addingServiceId);
      onMessage(isSourceConnectionReady(source) ? "来源已添加，请配置扫描路径" : "来源已添加；请先到网盘服务中恢复连接");
      setAddingServiceId("");
      await onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "来源添加失败");
    } finally {
      setBusySourceId(null);
    }
  }

  /** 保存来源的启用状态。 */
  async function toggleSource(source: LibrarySource): Promise<void> {
    setBusySourceId(source.id);
    try {
      await updateLibrarySource(library.id, source.id, { status: source.status === "active" ? "disabled" : "active" });
      onMessage(source.status === "active" ? "来源已停用" : "来源已启用");
      await onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "来源状态保存失败");
    } finally {
      setBusySourceId(null);
    }
  }

  /** 保存当前媒体库内的来源名称，不回写原网盘服务。 */
  async function saveSourceName(source: LibrarySource, value: string): Promise<void> {
    const displayName = value.trim();
    if (!displayName || displayName === source.displayName) return;
    setBusySourceId(source.id);
    try {
      await updateLibrarySource(library.id, source.id, { displayName });
      onMessage("来源名称已保存，协议多版本会显示新名称");
      await onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "来源名称保存失败");
    } finally {
      setBusySourceId(null);
    }
  }

  /** 删除当前库的来源成员及其文件版本；影片仍有其他来源版本时继续保留。 */
  async function removeSource(source: LibrarySource): Promise<void> {
    if (!window.confirm(`确定删除来源“${source.displayName}”吗？该来源的文件版本和扫描记录会被删除，原网盘服务及其他来源不受影响。`)) return;
    setBusySourceId(source.id);
    try {
      await deleteLibrarySource(library.id, source.id);
      onMessage("来源已删除");
      await onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "来源删除失败");
    } finally {
      setBusySourceId(null);
    }
  }

  return <Panel title="网盘来源" description="来源连接与登录状态由网盘服务统一管理；这里只管理聚合库成员、名称和启停状态。" className="mb-4">
      {!admin && <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border bg-secondary/20 p-2.5 sm:flex-row">
        <select value={addingServiceId} onChange={(event) => setAddingServiceId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-input bg-background/50 px-3 py-2 text-sm"><option value="">从已有网盘服务添加来源</option>{availableServices.map((service) => <option key={service.id} value={service.id}>{service.displayName} · {service.providerType}</option>)}</select>
        <PrimaryButton type="button" disabled={!addingServiceId || busySourceId !== null} onClick={() => void addSource()}>添加来源</PrimaryButton>
      </div>}
      {admin && <p className="mb-3 text-xs text-muted-foreground">管理员页面只读展示来源；连接状态与对应网盘服务保持一致。</p>}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {library.sources.map((source) => <section key={source.id} className="min-w-0 rounded-lg border border-border bg-secondary/15 p-3">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-secondary/50">
                <ProviderSelectionIcon providerType={source.providerType} />
              </span>
              <input key={`${source.id}:${source.updatedAt}`} defaultValue={source.displayName} maxLength={100} disabled={admin || busySourceId !== null} onBlur={(event) => void saveSourceName(source, event.target.value)} aria-label="来源名称" className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium hover:border-border focus:border-input focus:outline-none disabled:opacity-100" />
            </div>
            <StatusPill>{getSourceStateLabel(source)}</StatusPill>
          </div>
          <p className="mt-1 truncate pl-11 pr-1.5 text-[11px] text-muted-foreground">{source.providerType} · {getSourceConnectionLabel(source)}</p>
          {!admin && <div className="mt-2 flex flex-wrap gap-1.5 pl-11 pr-1.5">
            <button type="button" disabled={busySourceId !== null || !isSourceConnectionReady(source)} onClick={() => void toggleSource(source)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">{source.status === "active" ? "停用" : "启用"}</button>
            <button type="button" disabled={busySourceId !== null} onClick={() => void removeSource(source)} className="rounded-md border border-destructive/50 px-2.5 py-1.5 text-xs text-destructive disabled:opacity-40">删除</button>
          </div>}
        </section>)}
        {library.sources.length === 0 && <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">当前是空的云聚合视频库，请先添加网盘来源。</div>}
      </div>
    </Panel>;
}
