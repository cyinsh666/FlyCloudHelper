import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { addMovieSubscription, getSubscriptionChannels, listMovieSubscriptions } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** TMDB 详情页只传身份，服务端重新读取 TMDB 资料后保存。 */
export function SubscribeMovieDialog({ item, onClose, onSubscribed }: {
  item: { tmdbId: number; mediaType: "movie" | "tv"; title: string };
  onClose: () => void;
  onSubscribed: (message: string) => void;
}) {
  const resource = useApiResource(async () => {
    const [settings, subscriptions] = await Promise.all([getSubscriptionChannels(), listMovieSubscriptions()]);
    return { settings, subscriptions };
  }, []);
  const [serviceId, setServiceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：首批只有光鸭和夸克具备分享转存能力，其他网盘不展示为自动订阅目标。
  const eligibleServices = resource.data?.settings.services.filter((service) =>
    service.providerType === "guangya" || service.providerType === "quark") ?? [];

  // 关键变量：第一次取到服务后再选择默认值，不能把尚未加载完成的空值提交。
  useEffect(() => {
    const services = eligibleServices;
    if (services.length && !services.some((service) => service.serviceId === serviceId)) setServiceId(services[0]!.serviceId);
  }, [resource.data, serviceId]);

  /** 对当前选择的网盘服务提交一次订阅，重复添加由服务端返回原记录。 */
  async function subscribe(): Promise<void> {
    if (!serviceId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await addMovieSubscription({ serviceId, mediaType: item.mediaType, tmdbId: item.tmdbId });
      onSubscribed(result.alreadySubscribed ? "这部影片已加入该网盘服务的订阅" : "已加入网盘服务订阅");
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "加入订阅失败");
    } finally { setSaving(false); }
  }

  const current = eligibleServices.find((service) => service.serviceId === serviceId);
  const subscribed = resource.data?.subscriptions.some((subscription) => subscription.serviceId === serviceId
    && subscription.tmdbId === item.tmdbId && subscription.mediaType === item.mediaType);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label={`订阅${item.title}`} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape" && !saving) onClose(); }}
      className="surface w-full max-w-lg p-5 shadow-2xl">
      <h2 className="text-lg font-semibold">加入订阅</h2>
      <p className="mt-1 text-sm text-muted-foreground">{item.title} · {item.mediaType === "tv" ? "剧集" : "电影"} · TMDB {item.tmdbId}</p>
      {resource.loading && !resource.data && <div className="mt-4 h-20 animate-pulse rounded-lg bg-secondary" aria-label="网盘服务加载中" />}
      {resource.error && <p role="alert" className="mt-4 text-sm text-destructive">{resource.error}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {resource.data && eligibleServices.length === 0 &&
        <p className="mt-4 text-sm text-muted-foreground">当前只支持订阅到光鸭或夸克网盘服务，请先创建对应服务。</p>}
      {resource.data && eligibleServices.length > 0 && <>
        <label className="mt-5 block text-sm"><span className="mb-2 block text-xs text-muted-foreground">选择网盘服务</span>
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)} disabled={saving}
            className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm">
            {eligibleServices.map((service) => <option key={service.serviceId} value={service.serviceId}>
              {service.serviceName} · {service.providerType} · 关注 {service.channelKeys.length} 个频道
            </option>)}
          </select>
        </label>
        {current && current.channelKeys.length === 0 && <p className="mt-2 text-xs text-muted-foreground">
          该服务还没有关注频道。可先加入订阅，再到 <Link to="/app/settings/subscriptions" className="underline" onClick={onClose}>个人设置 · 订阅</Link> 选择频道。
        </p>}
        {subscribed && <p className="mt-2 text-xs text-muted-foreground">该服务已经订阅这部影片。</p>}
        <p className="mt-2 text-xs text-muted-foreground">自动转存使用服务详情中的独立转存目录；默认每 10 分钟巡检一次新消息。</p>
      </>}
      <div className="mt-6 flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onClose} disabled={saving}>取消</SecondaryButton>
        <PrimaryButton type="button" onClick={() => void subscribe()} disabled={!serviceId || saving || subscribed}>
          {saving ? "加入中…" : subscribed ? "已订阅" : "确认订阅"}
        </PrimaryButton>
      </div>
    </div>
  </div>;
}
