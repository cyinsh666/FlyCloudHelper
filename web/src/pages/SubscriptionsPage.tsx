import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { ProviderSelectionIcon } from "@/components/ServiceCreateSelection";
import { Panel } from "@/components/ui-kit";
import { checkMovieSubscriptionNow, deleteMovieSubscription, getMovieSubscriptionActivity,
  getSubscriptionChannels, listMovieSubscriptions, type MovieSubscription,
  type MovieSubscriptionActivity, type ServiceSubscriptionChannels } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 把最近一次频道查找与转存状态转换成用户可读文字。 */
function activityLabel(item: MovieSubscriptionActivity): string {
  switch (item.status) {
    case "completed": return "已转存";
    case "failed": return "转存失败";
    case "needs_review": return "需要核实";
    case "skipped": return "已跳过";
    case "submitting": return "提交中";
    case "pending": return "等待网盘处理";
    default: return "网盘处理中";
  }
}

/** 单个网盘展示自己的已订阅影片、查找入口和最近处理记录。 */
function ServiceSubscriptions({ service, items, onRemoved }: {
  service: ServiceSubscriptionChannels; items: MovieSubscription[]; onRemoved: () => Promise<void>;
}) {
  const activity = useApiResource(() => getMovieSubscriptionActivity(service.serviceId), [service.serviceId]);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 关键变量：仅当前服务有未完成转存时轮询页面记录，隐藏标签页不发请求。
  const hasPendingTransfer = activity.data?.items.some((item) => item.status === "pending" || item.status === "running") ?? false;
  useEffect(() => {
    if (!hasPendingTransfer) return;
    /** 页面可见时更新待处理任务，不重新执行频道查找。 */
    function refreshVisible(): void {
      if (document.visibilityState === "visible") void activity.refresh();
    }
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [activity.refresh, hasPendingTransfer]);

  /** 只对当前服务执行一次订阅查找，完成后刷新当前服务的执行记录。 */
  async function checkNow(): Promise<void> {
    if (checking) return;
    setChecking(true);
    setError(null);
    try { await checkMovieSubscriptionNow(service.serviceId); await activity.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "订阅查找失败"); }
    finally { setChecking(false); }
  }

  /** 取消当前服务的一部影片订阅，不触碰网盘里已转存的文件。 */
  async function remove(item: MovieSubscription): Promise<void> {
    if (!window.confirm(`确定取消“${item.title}”在“${service.serviceName}”中的订阅吗？`)) return;
    const key = `${item.mediaType}:${item.tmdbId}`;
    setRemoving(key);
    setError(null);
    try { await deleteMovieSubscription(item); await onRemoved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "取消订阅失败"); }
    finally { setRemoving(null); }
  }

  return <Panel title={`${service.serviceName} · 已订阅 ${items.length} 部`} className="mb-4"
    action={<PrimaryButton onClick={() => void checkNow()} disabled={checking || items.length === 0 || service.channelKeys.length === 0}>
      {checking ? "查找中…" : "立即查找"}
    </PrimaryButton>}>
    <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary/50">
        <ProviderSelectionIcon providerType={service.providerType} />
      </span>
      <span>关注 {service.channelKeys.length} 个频道</span>
      <Link to="/app/settings/subscriptions" className="underline">设置关注频道</Link>
      {activity.data && <span>上次查找：{activity.data.lastRunAt
        ? new Date(activity.data.lastRunAt).toLocaleString("zh-CN") : "尚未查找"}</span>}
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {activity.error && <p role="alert" className="mb-3 text-sm text-destructive">{activity.error}</p>}
    {service.channelKeys.length === 0 && <p className="mb-3 text-sm text-muted-foreground">请先为这个网盘设置关注频道。</p>}
    {items.length === 0 && <p className="text-sm text-muted-foreground">这个网盘还没有订阅影片，可从 TMDB 作品详情页添加。</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => {
      const key = `${item.mediaType}:${item.tmdbId}`;
      return <div key={key} className="flex min-w-0 gap-3 rounded-lg border border-border bg-secondary/20 p-3">
        {item.posterUrl
          ? <img src={item.posterUrl} alt="" loading="lazy" className="h-20 w-14 shrink-0 rounded object-cover" />
          : <div className="grid h-20 w-14 shrink-0 place-items-center rounded bg-secondary text-[10px] text-muted-foreground">暂无海报</div>}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 break-words text-sm font-medium leading-5" title={item.title}>
            {item.title}{item.year ? ` (${item.year})` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{item.mediaType === "tv" ? "剧集" : "电影"} · TMDB {item.tmdbId}</p>
          <button type="button" onClick={() => void remove(item)} disabled={removing === key}
            className="mt-auto self-start rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50">
            {removing === key ? "移除中…" : "取消订阅"}
          </button>
        </div>
      </div>;
    })}</div>
    {activity.loading && !activity.data && <div className="mt-4 h-12 animate-pulse rounded-lg bg-secondary" aria-label="查找记录加载中" />}
    {activity.data && <div className="mt-5 border-t border-border pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>最近执行记录</span>
        <button type="button" onClick={() => void activity.refresh()} className="underline">刷新记录</button>
      </div>
      {activity.data.lastError && <p role="status" className="mb-2 text-xs text-destructive">{activity.data.lastError}</p>}
      {activity.data.items.length === 0 && <p className="text-xs text-muted-foreground">暂无执行记录。</p>}
      <div className="max-h-64 space-y-2 overflow-y-auto">{activity.data.items.map((item) => <div key={item.id}
        className="rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{item.title}</span>
          <span className="shrink-0 text-muted-foreground">{activityLabel(item)}</span></div>
        <p className="mt-1 text-muted-foreground">@{item.channel} · 消息 {item.messageId} · {new Date(item.updatedAt).toLocaleString("zh-CN")}</p>
        {item.reason && <p className="mt-1 text-muted-foreground">{item.reason}</p>}
      </div>)}</div>
    </div>}
  </Panel>;
}

/** 独立订阅页按网盘服务列出影片，并提供每个服务自己的立即查找入口。 */
export function SubscriptionsPage() {
  const resource = useApiResource(async () => {
    const [settings, subscriptions] = await Promise.all([getSubscriptionChannels(), listMovieSubscriptions()]);
    return { services: settings.services, subscriptions };
  }, []);
  // 关键变量：当前自动转存只支持光鸭和夸克，其他服务不能发起无效的订阅查找。
  const services = resource.data?.services.filter((service) => service.providerType === "guangya"
    || service.providerType === "quark") ?? [];
  return <>
    <PageHeader title="订阅" actions={<Link to="/app/settings/subscriptions"
      className="rounded-lg border border-border bg-secondary/50 px-4 py-2.5 text-sm text-foreground hover:bg-secondary">设置关注频道</Link>} />
    {resource.loading && !resource.data && <div className="space-y-3" aria-label="订阅加载中">
      <div className="h-36 animate-pulse rounded-xl bg-secondary" /><div className="h-36 animate-pulse rounded-xl bg-secondary" /></div>}
    {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
    {resource.data && services.length === 0 && <Panel title="暂无可订阅网盘服务">
      <p className="text-sm text-muted-foreground">当前支持光鸭和夸克网盘，可先创建对应服务。</p>
    </Panel>}
    {services.map((service) => <ServiceSubscriptions key={service.serviceId} service={service}
      items={resource.data?.subscriptions.filter((item) => item.serviceId === service.serviceId) ?? []}
      onRemoved={resource.refresh} />)}
  </>;
}
