import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { AdminServiceFilters } from "@/components/AdminServiceFilters";
import { GuangyaAuthorizationPanel } from "@/components/GuangyaAuthorizationPanel";
import { CloudAuthorizationPanel } from "@/components/CloudAuthorizationPanel";
import { BaiduWebLoginPanel } from "@/components/BaiduWebLoginPanel";
import { ProviderConnectionGuide } from "@/components/ProviderConnectionGuide";
import { getProviderSelectionDescription, ProviderSelectionIcon, SelectableServiceOption } from "@/components/ServiceCreateSelection";
import { ServiceConnectionAlert, ServiceStateDot, ServiceStatePill, getServiceConnectionIssue } from "@/components/ServiceConnectionStatus";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  ApiClientError,
  createService,
  deleteCloudService,
  getService,
  listAdminUsers,
  listProviders,
  listServices,
  reconnectServiceConnection,
  updateServiceConnection,
  type CloudService,
  type CloudAuthorizationStatus,
  type CreateCloudServiceInput,
  type GuangyaAuthorizationStatus,
  type ProviderDescriptor,
  type ServiceListFilters,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

const guangyaLoginModeLabels: Record<"official_api" | "web_qr" | "web_sms", string> = {
  official_api: "官方光鸭",
  web_qr: "三方光鸭（扫码登录）",
  web_sms: "三方光鸭（验证码登录）",
};

/** 根据 Provider 和授权方式返回服务列表使用的中文名称。 */
function getServiceProviderLabel(service: CloudService): string {
  if (service.providerType !== "guangya") return service.providerType;
  if (service.connectionAuthMode === "official_api") return "官方光鸭";
  if (service.connectionAuthMode === "web_qr" || service.connectionAuthMode === "web_sms") return "三方光鸭";
  return "光鸭";
}

/** 渲染单个云端服务卡片。 */
function ServiceCard({ service, admin, onChanged }: { service: CloudService; admin: boolean; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 关键变量：同步阻止连续点击在状态刷新前重复发送删除请求。
  const deletingRef = useRef(false);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";

  /** 二次确认后从服务卡片删除服务，并同步刷新服务列表。 */
  async function deleteCardService(): Promise<void> {
    if (!service.canDeleteService) {
      setMessage("请先解除该服务与所有媒体库的关联，再删除服务");
      return;
    }
    if (deletingRef.current) {
      console.warn("codex-flycloud-helper-service-delete", {
        事件: "服务卡片拦截重复删除请求",
        服务ID: service.id,
      });
      return;
    }
    const confirmed = window.confirm(
      `确定删除“${service.displayName}”吗？删除后服务基础信息和登录凭据将彻底删除，无法恢复。`,
    );
    if (!confirmed) return;

    deletingRef.current = true;
    setDeleting(true);
    setMessage("正在删除服务…");
    console.info("codex-flycloud-helper-service-delete", {
      事件: "服务卡片开始删除服务",
      服务ID: service.id,
      服务名称: service.displayName,
      操作入口: admin ? "管理员服务卡片" : "用户服务卡片",
    });
    try {
      await deleteCloudService(service.id, admin);
      console.info("codex-flycloud-helper-service-delete", {
        事件: "服务卡片删除服务成功",
        服务ID: service.id,
        操作入口: admin ? "管理员服务卡片" : "用户服务卡片",
      });
      await onChanged();
    } catch (error) {
      const errorMessage = error instanceof ApiClientError && error.code === "service_has_active_job"
        ? "服务仍有未结束的后台任务，请先终止任务后再删除"
        : error instanceof Error ? error.message : "删除服务失败";
      console.warn("codex-flycloud-helper-service-delete", {
        事件: "服务卡片删除服务失败",
        服务ID: service.id,
        错误码: error instanceof ApiClientError ? error.code : "service_delete_failed",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  return (
    <article className="surface p-4">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-xs font-semibold" style={{ backgroundImage: "var(--gradient-surface)" }}>
            <ProviderSelectionIcon providerType={service.providerType} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{service.displayName}</h2>
            {service.description && <p className="mt-1 line-clamp-2 whitespace-pre-line break-words text-xs text-muted-foreground">{service.description}</p>}
            <p className="truncate text-[11px] text-muted-foreground">{getServiceProviderLabel(service)}{admin ? ` · ${service.ownerUsername}` : ""}</p>
          </div>
        </div>
        <ServiceStateDot service={service} />
      </header>
      <ServiceConnectionAlert service={service} admin={admin} />

      <div className="mt-3 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>连接 r{service.credentialRevision}</span>
          <span>{service.connectionStatus === "valid" ? "登录有效" : "需要重新登录"}</span>
        </div>
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
        <Link to={detailPath} params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Settings2 className="size-3.5" /> 配置</Link>
        {service.canCreateLibrary && !admin && <Link to="/app/libraries/new/$serviceId" params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-xs text-primary-soft"><Plus className="size-3.5" /> 创建媒体库</Link>}
        <button type="button" aria-label={deleting ? `正在删除${service.displayName}` : `删除${service.displayName}`} title={!service.canDeleteService ? "已关联媒体库，请先解除全部关联" : deleting ? "正在删除…" : "删除服务"} onClick={() => void deleteCardService()} disabled={deleting || !service.canDeleteService} className="ml-auto grid size-8 cursor-pointer place-items-center rounded-lg border border-destructive/50 bg-destructive/10 text-destructive transition-colors enabled:hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-50">
          <Trash2 className="size-3.5" />
        </button>
      </footer>
      {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </article>
  );
}

/** 渲染用户或管理员作用域的服务列表。 */
function ServicesListPage({ admin }: { admin: boolean }) {
  const [filters, setFilters] = useState<ServiceListFilters>({});
  const resource = useApiResource(
    () => listServices(admin, admin ? filters : {}),
    [admin, filters.search, filters.userId, filters.providerType, filters.dataType, filters.status],
  );
  const filterOptions = useApiResource(async () => {
    if (!admin) return { users: [], providers: [] };
    const [users, providers] = await Promise.all([listAdminUsers(), listProviders()]);
    return { users: users.items, providers };
  }, [admin]);
  return (
    <>
      <PageHeader
        title={admin ? "全部服务" : "我的服务"}
        actions={!admin && <Link to="/app/services/new"><PrimaryButton><Plus className="size-4" /> 创建云端服务</PrimaryButton></Link>}
      />
      {admin && <AdminServiceFilters value={filters} users={filterOptions.data?.users ?? []} providers={filterOptions.data?.providers ?? []} resultCount={resource.data?.total ?? 0} onChange={setFilters} />}
      {resource.error && <Panel><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {resource.loading && !resource.data && Array.from({ length: 4 }, (_, index) => <div key={index} className="surface animate-pulse space-y-3 p-4" aria-label="服务加载中"><div className="h-5 w-2/3 rounded bg-muted" /><div className="h-4 w-full rounded bg-muted" /><div className="h-8 w-full rounded bg-muted" /></div>)}
        {resource.data?.items.map((service) => <ServiceCard key={service.id} service={service} admin={admin} onChanged={async () => { await resource.refresh(); }} />)}
      </div>
      {!resource.loading && resource.data?.items.length === 0 && <Panel><p className="py-10 text-center text-sm text-muted-foreground">还没有云端服务</p></Panel>}
    </>
  );
}

export function UserServicesPage() { return <ServicesListPage admin={false} />; }
export function AdminServicesPage() { return <ServicesListPage admin />; }

/** 在个人模式创建当前账户的云端服务，字段由 Provider 描述动态生成。 */
export function ServiceCreatePage() {
  const navigate = useNavigate();
  const providers = useApiResource(() => listProviders(), []);
  const [providerType, setProviderType] = useState("");
  const [guangyaAuthorization, setGuangyaAuthorization] = useState<GuangyaAuthorizationStatus | null>(null);
  const [cloudAuthorization, setCloudAuthorization] = useState<CloudAuthorizationStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectedProvider: ProviderDescriptor | undefined = providers.data?.find((item) => item.type === providerType) ?? providers.data?.[0];

  /** 收集动态连接字段，只验证连接并创建尚未配置扫描路径的服务。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedType = selectedProvider?.type ?? "";
    const descriptor = providers.data?.find((item) => item.type === selectedType);
    if (!descriptor) {
      setMessage("请选择 Provider 类型");
      return;
    }
    const connection: Record<string, string> = {};
    if (descriptor.authenticationMode === "web_qr") {
      if (guangyaAuthorization?.status !== "authorized") {
        setMessage("请先完成三方光鸭扫码或验证码登录，再创建服务");
        return;
      }
      connection.authorizationSessionId = guangyaAuthorization.authorizationSessionId;
    } else if (descriptor.authenticationMode === "authorization_session") {
      if (cloudAuthorization?.state !== "authorized") {
        setMessage(`请先完成${descriptor.displayName}扫码登录，再创建服务`);
        return;
      }
      connection.authorizationSessionId = cloudAuthorization.authorizationSessionId;
    } else {
      descriptor.connectionFields.forEach((field) => {
        const value = String(form.get(`connection.${field.name}`) ?? "").trim();
        if (value) connection[field.name] = value;
      });
    }
    const input: CreateCloudServiceInput = {
      displayName: String(form.get("displayName") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      provider: { type: selectedType, connection },
    };
    setMessage("正在验证连接并创建服务，不会自动开始扫描…");
    try {
      const creation = await createService(input);
      await navigate({ to: "/app/services/$serviceId", params: { serviceId: creation.service.id } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务创建失败");
    }
  }

  /** 切换 Provider 时清空上一种网盘的临时授权状态。 */
  function selectProvider(nextProviderType: string): void {
    if (nextProviderType === selectedProvider?.type) return;
    setProviderType(nextProviderType);
    setGuangyaAuthorization(null);
    setCloudAuthorization(null);
  }

  return (
    <>
      <PageHeader title="创建云端服务" />
      <Panel>
        <form onSubmit={(event) => void submit(event)} className="grid gap-5 lg:grid-cols-2">
          <label className="block"><span className="text-xs text-muted-foreground">服务名称</span><input name="displayName" required maxLength={100} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <label className="block lg:col-span-2"><span className="text-xs text-muted-foreground">服务描述（选填）</span><textarea name="description" rows={2} maxLength={500} placeholder="填写服务用途或备注" className="mt-2 w-full resize-y rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <fieldset className="lg:col-span-2 pb-3">
            <legend className="mb-3 text-xs text-muted-foreground">Provider 类型</legend>
            <div role="radiogroup" aria-label="Provider 类型" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {providers.loading && <p className="text-sm text-muted-foreground sm:col-span-2 xl:col-span-4">正在读取 Provider…</p>}
              {providers.data?.map((provider) => (
                <SelectableServiceOption
                  key={provider.type}
                  title={provider.displayName}
                  description={getProviderSelectionDescription(provider)}
                  icon={<ProviderSelectionIcon providerType={provider.type} />}
                  selected={selectedProvider?.type === provider.type}
                  onSelect={() => selectProvider(provider.type)}
                />
              ))}
            </div>
          </fieldset>
          {selectedProvider?.authenticationMode === "web_qr"
            ? <GuangyaAuthorizationPanel admin={false} resetKey={selectedProvider.type} onAuthorizationChange={setGuangyaAuthorization} />
            : selectedProvider?.authenticationMode === "authorization_session"
              ? <CloudAuthorizationPanel descriptor={selectedProvider} admin={false} resetKey={selectedProvider.type} onAuthorizationChange={setCloudAuthorization} />
            : selectedProvider?.connectionFields.map((field) => <label key={field.name} className="block"><span className="text-xs text-muted-foreground">{field.label}</span><input name={`connection.${field.name}`} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
          {selectedProvider && <ProviderConnectionGuide providerType={selectedProvider.type} />}
          <div className="lg:col-span-2 flex items-center justify-between gap-4"><p className="text-xs text-muted-foreground">创建后仅保存网盘基础信息和登录凭据，可从服务卡片快速创建媒体库。</p><PrimaryButton type="submit" disabled={(selectedProvider?.authenticationMode === "web_qr" && guangyaAuthorization?.status !== "authorized") || (selectedProvider?.authenticationMode === "authorization_session" && cloudAuthorization?.state !== "authorized")}>验证连接并创建服务</PrimaryButton></div>
          {message && <p className="lg:col-span-2 text-sm text-muted-foreground">{message}</p>}
        </form>
      </Panel>
    </>
  );
}

/** 独立管理服务连接，避免完整认证表单长期占用服务详情页面。 */
export function ServiceConnectionPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const providers = useApiResource(() => listProviders(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  const service = resource.data;
  const providerDescriptor = providers.data?.find((item) => item.type === service?.providerType);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";

  /** 使用完整新凭据替换当前连接。 */
  async function saveConnection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!service || !providerDescriptor) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const connection: Record<string, string> = {};
    providerDescriptor.connectionFields.forEach((field) => {
      const value = String(form.get(field.name) ?? "").trim();
      if (value) connection[field.name] = value;
    });
    setMessage("正在验证并替换连接…");
    try {
      await updateServiceConnection(serviceId, connection, admin);
      setMessage("连接验证通过并已保存");
      formElement.reset();
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "连接保存失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页替换服务连接失败",
        服务ID: serviceId,
        网盘类型: service.providerType,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 光鸭网页授权成功后，用一次性授权会话替换当前服务连接。 */
  async function saveGuangyaConnection(authorization: GuangyaAuthorizationStatus | null): Promise<void> {
    if (!service || authorization?.status !== "authorized") return;
    const loginMethod = authorization.authMethod === "sms" ? "验证码登录" : "扫码登录";
    setMessage(`三方光鸭${loginMethod}成功，正在验证并保存连接…`);
    try {
      await updateServiceConnection(serviceId, {
        authorizationSessionId: authorization.authorizationSessionId,
      }, admin);
      setMessage("三方光鸭连接已更新，后续访问令牌将由服务端自动刷新");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "光鸭连接保存失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页保存光鸭连接失败",
        服务ID: serviceId,
        登录方式: loginMethod,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 新网盘扫码成功后，用一次性授权会话替换当前服务连接。 */
  async function saveCloudConnection(authorization: CloudAuthorizationStatus | null): Promise<void> {
    if (!service || authorization?.state !== "authorized") return;
    setMessage(`${providerDescriptor?.displayName || "网盘"}授权成功，正在验证账号并保存连接…`);
    try {
      await updateServiceConnection(serviceId, { authorizationSessionId: authorization.authorizationSessionId }, admin);
      setMessage("连接已更新，后续刷新将由 Fly云助手内部处理");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "网盘连接保存失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页保存新增网盘连接失败", 服务ID: serviceId,
        网盘类型: service.providerType, 错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 使用服务端当前保存的配置重新验证连接，并拦截重复点击。 */
  async function reconnectCurrentConnection(): Promise<void> {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    setMessage("正在使用当前配置重新连接网盘服务…");
    try {
      await reconnectServiceConnection(serviceId, admin);
      setMessage("当前配置验证成功，服务连接已恢复");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "使用当前配置重连失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页使用当前配置重连失败",
        服务ID: serviceId,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  }

  if (!service) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取连接信息…"}</div></Panel>;
  }

  return (
    <>
      <PageHeader
        title={`${service.displayName} · 连接管理`}
        actions={<Link to={detailPath} params={{ serviceId }} className="inline-flex rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground">返回服务详情</Link>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="当前连接">
          <ServiceConnectionAlert service={service} admin={admin} showLogin={false} />
          <div className="flex flex-wrap items-center gap-2">
            <ServiceStatePill service={service} />
            <StatusPill>{service.connectionAuthMode ? guangyaLoginModeLabels[service.connectionAuthMode] : service.credentialConfigured ? "凭据已配置" : "凭据未配置"}</StatusPill>
            <StatusPill>连接 r{service.credentialRevision}</StatusPill>
          </div>
          <div className="mt-4">
            <SecondaryButton disabled={reconnecting} onClick={() => void reconnectCurrentConnection()}>
              <RefreshCw className={`size-4 ${reconnecting ? "animate-spin" : ""}`} />
              {reconnecting ? "正在重连…" : "使用当前配置重连"}
            </SecondaryButton>
          </div>
        </Panel>
        <Panel title="替换连接" description={providerDescriptor?.authenticationMode === "web_qr" ? "三方光鸭可使用扫码或验证码重新登录；官方光鸭由 Flymby APP 同步。" : providerDescriptor?.authenticationMode === "authorization_session" ? "重新扫码后会先核对账号；与原服务账号不一致时不会覆盖。" : "Secret 不回显，保存时必须提交一套完整新连接。"}>
          {providers.loading && <p className="text-sm text-muted-foreground">正在读取网盘连接配置…</p>}
          {providerDescriptor?.authenticationMode === "web_qr" ? (
            <>
              <GuangyaAuthorizationPanel admin={admin} targetUserId={admin ? service.userId : undefined} resetKey={`${service.id}:${service.credentialRevision}`} initialLoginMode={service.connectionAuthMode ?? "web_qr"} onAuthorizationChange={(authorization) => void saveGuangyaConnection(authorization)} />
              <ProviderConnectionGuide providerType={providerDescriptor.type} mode="replace" />
            </>
          ) : providerDescriptor?.authenticationMode === "authorization_session" ? (
            <>
              <CloudAuthorizationPanel descriptor={providerDescriptor} admin={admin} targetUserId={admin ? service.userId : undefined} resetKey={`${service.id}:${service.credentialRevision}`} onAuthorizationChange={(authorization) => void saveCloudConnection(authorization)} />
              <ProviderConnectionGuide providerType={providerDescriptor.type} mode="replace" />
            </>
          ) : providerDescriptor ? (
            <form onSubmit={(event) => void saveConnection(event)} className="grid gap-3">
              {providerDescriptor.connectionFields.map((field) => <label key={field.name}><span className="text-xs text-muted-foreground">{field.label}</span><input name={field.name} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
              <ProviderConnectionGuide providerType={providerDescriptor.type} mode="replace" />
              <PrimaryButton type="submit">验证并保存连接</PrimaryButton>
            </form>
          ) : !providers.loading && <p className="text-sm text-destructive">当前网盘类型缺少连接描述</p>}
        </Panel>
      </div>
      {service.providerType === "baidupan" && <div className="mt-4"><BaiduWebLoginPanel serviceId={service.id} admin={admin} /></div>}
    </>
  );
}

/** 个人模式下的云端服务连接配置入口。 */
export function UserServiceConnectionPage({ serviceId }: { serviceId: string }) { return <ServiceConnectionPage serviceId={serviceId} />; }
export function AdminServiceConnectionPage({ serviceId }: { serviceId: string }) { return <ServiceConnectionPage serviceId={serviceId} admin />; }
