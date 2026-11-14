import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { ProviderSelectionIcon } from "@/components/ServiceCreateSelection";
import { Panel } from "@/components/ui-kit";
import { getCurrentUser, getSubscriptionChannels, saveServiceSubscriptionChannels,
  type ChannelCloudTypes, type ServiceSubscriptionChannels } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { TelegramBindingPanel } from "@/pages/TelegramBotPanels";

/** 个人设置中的账号信息；本轮只展示当前登录账号。 */
function AccountSettingsTab() {
  const resource = useApiResource(() => getCurrentUser(), []);
  return <Panel title="当前账号" description="当前登录云助手的个人账号。">
    {resource.loading && <div className="h-16 animate-pulse rounded-lg bg-secondary" aria-label="账号加载中" />}
    {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
    {resource.data && <div className="grid gap-2 text-sm sm:grid-cols-2">
      <p>用户名：{resource.data.username}</p>
      <p>身份：{resource.data.role === "super_admin" ? "超级管理员" : "普通用户"}</p>
    </div>}
  </Panel>;
}

/** 单个网盘服务的频道选择，切换服务时不改动其他服务的配置。 */
function ServiceChannelsEditor({ service, channels, channelTypes, scanEnabled, onSaved }: {
  service: ServiceSubscriptionChannels; channels: string[]; channelTypes: ChannelCloudTypes[]; scanEnabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>(service.channelKeys);
  const [filter, setFilter] = useState("");
  // 关键变量：切换到一个网盘时频道列表默认收起，避免长列表占满设置页。
  const [channelsExpanded, setChannelsExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 只更改当前网盘服务的本地选择，保存时再提交。 */
  function toggleChannel(key: string): void {
    setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
    setMessage(null);
  }

  /** 将缓存中发现当前网盘链接的频道加入本地选择，保留手动勾选的频道。 */
  function selectRelatedChannels(): void {
    setSelected((current) => [...new Set([...current, ...relatedChannels])]);
    setMessage(`已选中 ${relatedChannels.length} 个相关频道，请点击保存关注频道`);
  }

  /** 清空当前网盘的频道选择，保存前不修改服务端配置。 */
  function clearChannels(): void {
    setSelected([]);
    setMessage("已清空频道选择，请点击保存关注频道");
  }

  /** 选中当前网盘可选的全部已启用频道，保存前不修改服务端配置。 */
  function selectAllChannels(): void {
    setSelected([...channels]);
    setMessage(`已选中全部 ${channels.length} 个频道，请点击保存关注频道`);
  }

  /** 展开或收起当前网盘的频道列表，不改变已经勾选的频道。 */
  function toggleChannelList(): void { setChannelsExpanded((current) => !current); }

  /** 服务端再次校验频道是否仍在系统频道列表中且已启用。 */
  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setSelected(await saveServiceSubscriptionChannels(service.serviceId, selected));
      await onSaved();
      setMessage("关注频道已保存");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存关注频道失败");
    } finally { setSaving(false); }
  }

  // 关键变量：缓存是近期样本，历史发现的类型单独标注，避免给用户确定性过高的判断。
  const typesByChannel = new Map(channelTypes.map((item) => [item.channel, item]));
  // 关键变量：网盘服务类型与频道分享链接类型使用不同标识，需要在展示时对应起来。
  const cloudTypeByProvider: Record<string, string> = { guangya: "guangya", quark: "quark",
    baidupan: "baidu", aliyundrive: "aliyun", cloud115: "115", cloud123: "123",
    cloud139: "mobile", cloud189: "tianyi" };
  const serviceCloudType = cloudTypeByProvider[service.providerType];
  // 关键变量：频道类型只用于批量勾选，不限制手动可选范围。
  const relatedChannels = channels.filter((key) => Boolean(serviceCloudType
    && typesByChannel.get(key)?.observedTypes.includes(serviceCloudType)));
  const visibleChannels = channels.filter((key) => key.toLowerCase().includes(filter.trim().toLowerCase()));
  const checkedCount = channelTypes.filter((item) => item.checkedAt).length;
  const cloudLabels: Record<string, string> = { guangya: "光鸭", quark: "夸克", aliyun: "阿里", baidu: "百度",
    "115": "115", "123": "123", tianyi: "天翼", mobile: "移动", uc: "UC", xunlei: "迅雷", pikpak: "PikPak" };
  /** 用中文网盘名展示近期检测到的分享数量和历史类型。 */
  function channelTypeText(key: string): string {
    const item = typesByChannel.get(key);
    if (!item) return "待检测网盘类型";
    const recent = Object.entries(item.recentCounts).filter((entry) => entry[1] > 0)
      .map(([type, count]) => `${cloudLabels[type] ?? type} ${count}`).join(" · ");
    const historical = item.observedTypes.filter((type) => !item.recentCounts[type]);
    if (recent) {
      const summary = historical.length ? `${recent} · 曾发现 ${historical.map((type) => cloudLabels[type] ?? type).join("、")}` : recent;
      return item.error ? `${summary} · 本次检测失败` : summary;
    }
    if (historical.length) {
      const summary = `近 ${item.sampledMessages} 条未发现 · 曾发现 ${historical.map((type) => cloudLabels[type] ?? type).join("、")}`;
      return item.error ? `${summary} · 本次检测失败` : summary;
    }
    return item.error ? "检测失败，等待重试" : item.checkedAt ? `近 ${item.sampledMessages} 条未发现网盘链接` : "待检测网盘类型";
  }
  return <Panel title={`${service.serviceName} · 关注频道`}
    description="可从全部已启用频道中手动选择；也可按频道类型检测结果批量选中当前网盘相关频道。">
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
    {channels.length === 0 ? <p className="text-sm text-muted-foreground">暂无已启用的 TG 频道，请联系管理员在系统设置中配置。</p> : <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={toggleChannelList} aria-expanded={channelsExpanded}
          aria-controls={`channel-list-${service.serviceId}`}
          className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground hover:bg-secondary">
          {channelsExpanded ? "收起频道列表" : "展开频道列表"}
        </button>
        <button type="button" onClick={clearChannels} disabled={saving || selected.length === 0}
          className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">
          清空
        </button>
        <button type="button" onClick={selectAllChannels} disabled={saving || selected.length === channels.length}
          className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">
          全选
        </button>
        <button type="button" onClick={selectRelatedChannels} disabled={saving || relatedChannels.length === 0}
          className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">
          一键选中相关频道（{relatedChannels.length}）
        </button>
        <span className="text-xs text-muted-foreground">已选 {selected.length} / {channels.length}</span>
      </div>
      <div id={`channel-list-${service.serviceId}`} hidden={!channelsExpanded}>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选已有频道"
          aria-label="筛选已有频道" className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        <div className="grid max-h-96 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
        {visibleChannels.map((key) => {
          const typeInfo = typesByChannel.get(key);
          const typeText = channelTypeText(key);
          const typeTooltip = typeInfo?.checkedAt
            ? `${typeText}；扫描于 ${new Date(typeInfo.checkedAt).toLocaleString("zh-CN")}` : typeText;
          return <label key={key} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-sm">
            <input type="checkbox" checked={selected.includes(key)} disabled={saving} onChange={() => toggleChannel(key)} />
            <span className="min-w-0"><span className="block truncate" title={`@${key}`}>@{key}</span>
              <span className="block truncate text-[11px] text-muted-foreground" title={typeTooltip}>{typeText}</span></span>
          </label>;
        })}
        </div>
        {visibleChannels.length === 0 && <p className="py-4 text-sm text-muted-foreground">没有匹配的频道</p>}
      </div>
      {relatedChannels.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{!serviceCloudType
        ? "当前网盘类型没有可匹配的分享链接类型，可以手动选择频道。"
        : scanEnabled
          ? `已检测 ${checkedCount} / ${channels.length} 个频道，暂未发现相关频道；可以先手动选择。`
          : "当前环境未开启频道类型定时巡检，可以手动选择频道。"}</p>}
      <div className="mt-4"><PrimaryButton disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存关注频道"}</PrimaryButton></div>
    </>}
  </Panel>;
}

/** 个人设置中的订阅标签，网盘和 TG 频道都读取已有配置。 */
function SubscriptionSettingsTab() {
  const resource = useApiResource(() => getSubscriptionChannels(), []);
  const [serviceId, setServiceId] = useState("");
  // 关键变量：首次加载才自动选择第一个服务，刷新列表时保留仍存在的当前服务。
  useEffect(() => {
    const services = resource.data?.services ?? [];
    if (services.length && !services.some((service) => service.serviceId === serviceId)) setServiceId(services[0]!.serviceId);
  }, [resource.data, serviceId]);
  const current = resource.data?.services.find((service) => service.serviceId === serviceId);
  return <>
    <Panel title="网盘关注频道" description="从系统设置中已有且启用的 TG 频道，为每个网盘服务选择关注范围。" className="mb-4">
      {resource.loading && !resource.data && <div className="space-y-2" aria-label="订阅设置加载中"><div className="h-10 animate-pulse rounded-lg bg-secondary" /><div className="h-10 animate-pulse rounded-lg bg-secondary" /></div>}
      {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
      {resource.data && resource.data.services.length === 0 && <p className="text-sm text-muted-foreground">还没有网盘服务，请先创建服务。</p>}
      {resource.data && resource.data.services.length > 0 && <div role="tablist" aria-label="选择网盘服务"
        className="flex flex-wrap gap-2">
        {resource.data.services.map((service) => {
          const selected = service.serviceId === serviceId;
          return <button key={service.serviceId} type="button" role="tab" aria-selected={selected}
            onClick={() => setServiceId(service.serviceId)} title={service.serviceName}
            className={`flex min-w-40 max-w-56 shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${selected
              ? "border-foreground/70 bg-secondary/70"
              : "border-border bg-background/40 hover:bg-secondary/45"}`}>
            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary/50">
              <ProviderSelectionIcon providerType={service.providerType} />
            </span>
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{service.serviceName}</span>
              <span className="block truncate text-xs text-muted-foreground">{service.providerType}</span></span>
          </button>;
        })}
      </div>}
    </Panel>
    {current && <ServiceChannelsEditor key={current.serviceId} service={current}
      channels={resource.data?.channels ?? []} channelTypes={resource.data?.channelTypes?.items ?? []}
      scanEnabled={resource.data?.channelTypes?.enabled ?? false}
      onSaved={resource.refresh} />}
  </>;
}

/** 个人设置共用页面；订阅标签只管理网盘关注的频道。 */
export function PersonalSettingsPage({ tab }: { tab: "account" | "subscription" }) {
  return <>
    <PageHeader title="个人设置" />
    <div role="tablist" aria-label="个人设置分类" className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
      <Link to="/app/settings" role="tab" aria-selected={tab === "account"}
        className={`rounded-lg border px-4 py-2 text-sm ${tab === "account" ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50"}`}>账号</Link>
      <Link to="/app/settings/subscriptions" role="tab" aria-selected={tab === "subscription"}
        className={`rounded-lg border px-4 py-2 text-sm ${tab === "subscription" ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50"}`}>订阅</Link>
    </div>
    {tab === "account" ? <><AccountSettingsTab /><TelegramBindingPanel /></> : <SubscriptionSettingsTab />}
  </>;
}
