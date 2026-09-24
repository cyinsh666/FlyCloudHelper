import { Link } from "@tanstack/react-router";
import { Database, KeyRound, Plus } from "lucide-react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { getService } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 展示网盘服务基础信息、登录状态和重新登录入口。 */
export function ServiceBasicDetailPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const service = resource.data;
  if (!service) return <Panel><p className="py-12 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取网盘服务…"}</p></Panel>;
  const servicesPath = admin ? "/admin/services" : "/app/services";
  const connectionPath = admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection";
  return <>
    <PageHeader title={service.displayName} actions={<div className="flex gap-2"><Link to={servicesPath}><SecondaryButton>返回服务</SecondaryButton></Link>{service.canCreateLibrary && !admin && <Link to="/app/libraries/new/$serviceId" params={{ serviceId: service.id }}><PrimaryButton><Plus className="size-4" /> 创建媒体库</PrimaryButton></Link>}</div>} />
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="基础信息">
        <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">网盘类型</dt><dd>{service.providerType}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">所属用户</dt><dd>{service.ownerUsername}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">服务状态</dt><dd>{service.status === "active" ? "已启用" : "已停用"}</dd></div></dl>
      </Panel>
      <Panel title="登录凭据" description="服务只保存网盘登录信息；扫描、元数据和协议设置由媒体库管理。">
        <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><KeyRound className="size-5 text-muted-foreground" /><div><p className="text-sm font-medium">{service.connectionStatus === "valid" ? "登录有效" : "需要重新登录"}</p><p className="mt-1 text-xs text-muted-foreground">凭据修订 r{service.credentialRevision}</p></div></div><Link to={connectionPath} params={{ serviceId: service.id }}><SecondaryButton>重新登录</SecondaryButton></Link></div>
      </Panel>
    </div>
    {service.canCreateLibrary && <Panel className="mt-4"><div className="flex items-center gap-3"><Database className="size-5 text-muted-foreground" /><p className="text-sm text-muted-foreground">当前服务尚未创建旧单媒体库，可继续创建；加入云聚合库不会占用这个入口。</p></div></Panel>}
  </>;
}

export function UserServiceBasicDetailPage({ serviceId }: { serviceId: string }) { return <ServiceBasicDetailPage serviceId={serviceId} />; }
export function AdminServiceBasicDetailPage({ serviceId }: { serviceId: string }) { return <ServiceBasicDetailPage serviceId={serviceId} admin />; }
