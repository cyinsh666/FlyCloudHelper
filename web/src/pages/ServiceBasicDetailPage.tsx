import { Link } from "@tanstack/react-router";
import { Database, FolderOutput, KeyRound, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { ServiceProfileEditDialog } from "@/components/ServiceProfileEditDialog";
import { getService, getServiceOrganizeCapabilities, type ServiceDetail } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 展示网盘服务基础信息、登录状态和重新登录入口。 */
export function ServiceBasicDetailPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  // 关键变量：直接使用保存接口返回的新资料，标题和描述立即刷新。
  const [savedService, setSavedService] = useState<ServiceDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [organizeSupported, setOrganizeSupported] = useState(false);
  useEffect(() => {
    setSavedService(null);
    setEditing(false);
    setOrganizeSupported(false);
  }, [serviceId, admin]);
  /** 入口以当前 Provider 和当前登录凭据的真实写能力为准。 */
  useEffect(() => {
    let alive = true;
    void getServiceOrganizeCapabilities(serviceId, admin).then((result) => {
      if (alive) setOrganizeSupported(result.supported);
    }).catch(() => { if (alive) setOrganizeSupported(false); });
    return () => { alive = false; };
  }, [serviceId, admin, resource.data?.credentialRevision]);
  const service = savedService ?? resource.data;
  /** 关闭资料弹窗，草稿随弹窗销毁。 */
  const closeEditor = useCallback(() => setEditing(false), []);
  /** 将保存成功的资料显示到标题区域。 */
  function handleSaved(updated: ServiceDetail): void {
    setSavedService(updated);
    setEditing(false);
  }
  if (!service && resource.error) return <Panel><p role="alert" className="py-12 text-center text-sm text-destructive">{resource.error}</p></Panel>;
  if (!service) return <div aria-label="服务详情加载中" className="animate-pulse space-y-4"><div className="h-7 w-48 rounded bg-muted" /><div className="h-4 w-72 max-w-full rounded bg-muted" /><div className="grid gap-4 lg:grid-cols-2">{[0, 1].map((index) => <Panel key={index}><div className="h-40 rounded bg-muted" /></Panel>)}</div></div>;
  const servicesPath = admin ? "/admin/services" : "/app/services";
  const connectionPath = admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection";
  const organizePath = admin ? "/admin/services/$serviceId/organize" : "/app/services/$serviceId/organize";
  return <>
    <header className="mb-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">{service.displayName}</h1><button type="button" aria-label="编辑服务名称和描述" title="编辑服务" onClick={() => setEditing(true)} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"><Pencil className="size-4" /></button></div>
        {service.description && <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">{service.description}</p>}
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end"><Link to={servicesPath}><SecondaryButton>返回服务</SecondaryButton></Link>{organizeSupported && <Link to={organizePath} params={{ serviceId: service.id }}><SecondaryButton><FolderOutput className="size-4" /> 影片整理</SecondaryButton></Link>}{service.canCreateLibrary && !admin && <Link to="/app/libraries/new/$serviceId" params={{ serviceId: service.id }}><PrimaryButton><Plus className="size-4" /> 创建媒体库</PrimaryButton></Link>}</div>
    </header>
    {editing && <ServiceProfileEditDialog service={service} admin={admin} onClose={closeEditor} onSaved={handleSaved} />}
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="基础信息">
        <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">网盘类型</dt><dd>{service.providerType}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">所属用户</dt><dd>{service.ownerUsername}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">服务状态</dt><dd>{service.status === "active" ? "已启用" : "已停用"}</dd></div></dl>
        {service.providerType === "baidupan" && <p className="mt-4 text-xs text-muted-foreground">Jellyfin 关闭中转后，百度直链服务仅 Flymby 可用；其他播放器请开启中转播放。</p>}
      </Panel>
      <Panel title="登录凭据" description="服务只保存网盘登录信息；扫描、元数据和协议设置由媒体库管理。">
        <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><KeyRound className="size-5 text-muted-foreground" /><div><p className="text-sm font-medium">{service.connectionStatus === "valid" ? "登录有效" : "需要重新登录"}</p><p className="mt-1 text-xs text-muted-foreground">凭据修订 r{service.credentialRevision}</p></div></div><Link to={connectionPath} params={{ serviceId: service.id }}><SecondaryButton>重新登录</SecondaryButton></Link></div>
      </Panel>
    </div>
    {service.canCreateLibrary && <Panel className="mt-4"><div className="flex items-center gap-3"><Database className="size-5 text-muted-foreground" /><p className="text-sm text-muted-foreground">当前服务尚未创建旧单媒体库，可继续创建；加入云聚合库不会占用这个入口。</p></div></Panel>}
  </>;
}

/** 普通用户的服务详情入口。 */
export function UserServiceBasicDetailPage({ serviceId }: { serviceId: string }) { return <ServiceBasicDetailPage serviceId={serviceId} />; }
/** 管理员的服务详情入口。 */
export function AdminServiceBasicDetailPage({ serviceId }: { serviceId: string }) { return <ServiceBasicDetailPage serviceId={serviceId} admin />; }
