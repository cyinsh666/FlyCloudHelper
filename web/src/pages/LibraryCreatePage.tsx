import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { ContentSourceLibraryCreate } from "@/components/ContentSourceLibraryCreate";
import { createLibrary, getService, listServices, type MediaType } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 创建媒体库页；从服务进入时锁定来源，从媒体库管理进入时允许选择空闲服务。 */
export function LibraryCreatePage({ serviceId = "" }: { serviceId?: string }) {
  const navigate = useNavigate();
  const services = useApiResource(async () => {
    if (serviceId) return [await getService(serviceId)];
    const result = await listServices(false);
    return result.items;
  }, [serviceId]);
  const [libraryKind, setLibraryKind] = useState<"legacy_single_source" | "cloud_aggregate_video" | "content_source_video">("cloud_aggregate_video");
  const [selectedServiceId, setSelectedServiceId] = useState(serviceId);
  const [selectedSourceServiceIds, setSelectedSourceServiceIds] = useState<string[]>(serviceId ? [serviceId] : []);
  const [displayName, setDisplayName] = useState("");
  const initializedNameForServiceId = useRef<string | null>(null); // 关键变量：每个创建入口只填一次默认名称，清空后不再回填。
  const [dataType, setDataType] = useState<MediaType>("video");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const firstService = services.data?.find((service) => service.id === serviceId) ?? services.data?.[0];
    if (serviceId) {
      if (!firstService) return;
      setLibraryKind("legacy_single_source");
      if (!selectedServiceId) setSelectedServiceId(firstService.id);
    }
    if (initializedNameForServiceId.current === serviceId) return;
    initializedNameForServiceId.current = serviceId;
    setDisplayName(serviceId ? firstService?.displayName ?? "" : "云聚合视频库");
  }, [selectedServiceId, serviceId, services.data]);

  /** 切换来源服务，保留用户当前填写或清空的媒体库名称。 */
  function selectSource(nextServiceId: string): void {
    setSelectedServiceId(nextServiceId);
  }

  /** 更新名称输入；清空后保持空值，等待用户重新填写。 */
  function changeDisplayName(value: string): void {
    if (!value.trim()) console.info("codex-flycloud-library-name 阶段=输入名称 结果=留空不自动补全");
    setDisplayName(value);
  }

  /** 切换云聚合库的初始来源；仅复制基础连接配置，不复用旧扫描和刮削数据。 */
  function toggleAggregateSource(sourceServiceId: string): void {
    setSelectedSourceServiceIds((current) => current.includes(sourceServiceId)
      ? current.filter((id) => id !== sourceServiceId)
      : [...current, sourceServiceId]);
  }

  /** 提交服务与媒体库解耦后的首版媒体库配置。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedDisplayName = displayName.trim(); // 关键变量：空格也不能作为媒体库名称提交。
    if (!trimmedDisplayName) {
      console.info("codex-flycloud-library-name 阶段=创建校验 结果=名称为空，禁止保存");
      setMessage("请填写媒体库名称");
      return;
    }
    if (libraryKind === "legacy_single_source" && !selectedServiceId) {
      setMessage("请选择来源网盘服务");
      return;
    }
    if (libraryKind === "cloud_aggregate_video") {
      console.info("codex-library-source-config", {
        阶段: "提交聚合媒体库创建",
        已选来源数量: selectedSourceServiceIds.length,
      });
    }
    setMessage("正在创建媒体库…");
    try {
      const metadata = dataType === "music"
        ? { profiles: { music: { providerId: "auto", aggregateMode: "fast", requiredFields: { artist: true, album: true, cover: true, lyrics: false } } } }
        : { profiles: { video: { providerId: "builtin.tmdb", language: "zh-CN", region: "CN", useNfo: true, syncDetails: false, analyzeMediaSpecs: false, aiCleaning: { enabled: false, modelId: "", triggerMode: "weak_or_unmatched", minConfidence: 0.75 } } } };
      const result = libraryKind === "cloud_aggregate_video"
        ? await createLibrary({
          libraryKind: "cloud_aggregate_video",
          displayName: trimmedDisplayName,
          dataType: "video",
          sourceServiceIds: selectedSourceServiceIds,
          metadata,
        })
        : await createLibrary({
          sourceServiceId: selectedServiceId,
          displayName: trimmedDisplayName,
          dataType,
          scan: { fullRoots: [], incrementalRoots: [], mediaTypes: [dataType], removedRootPolicy: "protect", scanDirectoryConcurrency: dataType === "music" ? 4 : 8, ...(dataType === "music" ? { musicFileConcurrency: 4 } : {}), scrapeTaskConcurrency: dataType === "music" ? 2 : 4 },
          metadata,
        });
      await navigate({ to: "/app/libraries/$serviceId/settings", params: { serviceId: result.library.id } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "媒体库创建失败");
    }
  }

  const modeSelection = !serviceId && <fieldset><legend className="text-xs text-muted-foreground">媒体库模式</legend><div className="mt-1.5 grid gap-2 sm:grid-cols-3">
    <button type="button" onClick={() => { setLibraryKind("cloud_aggregate_video"); setDataType("video"); }} className={`rounded-lg border px-3 py-2.5 text-left ${libraryKind === "cloud_aggregate_video" ? "border-foreground" : "border-border"}`}><span className="block text-sm font-medium">云聚合视频库</span><span className="mt-0.5 block text-xs text-muted-foreground">多个网盘来源，共用一个影视海报墙。</span></button>
    <button type="button" onClick={() => setLibraryKind("legacy_single_source")} className={`rounded-lg border px-3 py-2.5 text-left ${libraryKind === "legacy_single_source" ? "border-foreground" : "border-border"}`}><span className="block text-sm font-medium">旧单源媒体库</span><span className="mt-0.5 block text-xs text-muted-foreground">保留现有单个服务对应一个媒体库的模式。</span></button>
    <button type="button" onClick={() => { setLibraryKind("content_source_video"); setDataType("video"); }} className={`rounded-lg border px-3 py-2.5 text-left ${libraryKind === "content_source_video" ? "border-foreground" : "border-border"}`}><span className="block text-sm font-medium">在线内容源媒体库</span><span className="mt-0.5 block text-xs text-muted-foreground">选择独立的影视或音乐源插件，创建在线媒体库。</span></button>
  </div></fieldset>;
  const availableLegacyServices = services.data?.filter((service) => service.canCreateLibrary) ?? [];
  return <><PageHeader title="创建媒体库" /><Panel className="p-4 sm:p-4"><div className="grid gap-3">{modeSelection}
    {libraryKind === "content_source_video" ? <ContentSourceLibraryCreate /> : !services.data ? <div>{services.error ? <p role="alert" className="text-sm text-destructive">{services.error}</p> : <div aria-label="来源服务加载中" className="animate-pulse space-y-3"><div className="h-4 w-48 rounded bg-muted" /><div className="h-9 rounded bg-muted" /><div className="h-9 rounded bg-muted" /></div>}</div> : <form onSubmit={(event) => void submit(event)} className="grid gap-3">
    {libraryKind === "cloud_aggregate_video" ? <fieldset><legend className="text-xs text-muted-foreground">初始网盘来源（可稍后添加）</legend><div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {services.data.map((service) => <button key={service.id} type="button" onClick={() => toggleAggregateSource(service.id)} className={`min-w-0 rounded-lg border px-3 py-2 text-left ${selectedSourceServiceIds.includes(service.id) ? "border-foreground" : "border-border"}`}><span className="block truncate text-sm">{service.displayName}</span><span className="mt-0.5 block text-xs text-muted-foreground">{service.providerType} · {service.connectionStatus === "valid" ? "连接正常" : "需要重新登录"}</span></button>)}
      {services.data.length === 0 && <p className="text-xs text-muted-foreground">当前没有可添加的网盘服务，也可以先创建空的云聚合库。</p>}
    </div><p className="mt-1.5 text-xs text-muted-foreground">这里只建立当前媒体库与网盘服务的来源关系；连接状态和登录凭据由网盘服务统一管理，已有扫描、刮削和海报墙数据不会带入。</p></fieldset> : <label><span className="text-xs text-muted-foreground">来源服务</span><select disabled={Boolean(serviceId)} value={selectedServiceId} onChange={(event) => selectSource(event.target.value)} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm"><option value="">请选择网盘服务</option>{availableLegacyServices.map((service) => <option key={service.id} value={service.id}>{service.displayName} · {service.providerType}</option>)}</select></label>}
    <label><span className="text-xs text-muted-foreground">媒体库名称</span><input required value={displayName} onChange={(event) => changeDisplayName(event.target.value)} maxLength={100} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" /></label>
    {libraryKind === "legacy_single_source" && <fieldset><legend className="text-xs text-muted-foreground">媒体库类型</legend><div className="mt-1.5 flex gap-2">{(["video", "music"] as MediaType[]).map((type) => <button key={type} type="button" onClick={() => setDataType(type)} className={`rounded-lg border px-3 py-1.5 text-sm ${dataType === type ? "border-foreground" : "border-border"}`}>{type === "video" ? "影视" : "音乐"}</button>)}</div></fieldset>}
    <p className="text-xs text-muted-foreground">创建后在媒体库设置中配置每个来源自己的扫描路径，再统一管理元数据、通知和对外访问。</p><div className="[&_button]:px-3 [&_button]:py-2"><PrimaryButton type="submit" disabled={!displayName.trim() || (libraryKind === "legacy_single_source" && !selectedServiceId)}>创建媒体库</PrimaryButton></div>{message && <p className="text-sm text-muted-foreground">{message}</p>}
  </form>}</div></Panel></>;
}
