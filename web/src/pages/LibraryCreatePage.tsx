import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { createLibrary, getService, listServices, type MediaType } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 创建媒体库页；从服务进入时锁定来源，从媒体库管理进入时允许选择空闲服务。 */
export function LibraryCreatePage({ serviceId = "" }: { serviceId?: string }) {
  const navigate = useNavigate();
  const services = useApiResource(async () => {
    if (serviceId) return [await getService(serviceId)];
    const result = await listServices(false);
    return result.items.filter((service) => service.canCreateLibrary);
  }, [serviceId]);
  const [selectedServiceId, setSelectedServiceId] = useState(serviceId);
  const [displayName, setDisplayName] = useState("");
  const [dataType, setDataType] = useState<MediaType>("video");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const firstService = services.data?.find((service) => service.id === serviceId) ?? services.data?.[0];
    if (!firstService) return;
    if (!selectedServiceId) setSelectedServiceId(firstService.id);
    if (!displayName) setDisplayName(firstService.displayName);
  }, [displayName, selectedServiceId, serviceId, services.data]);

  /** 切换来源服务，并在名称尚未填写时带入服务名称。 */
  function selectSource(nextServiceId: string): void {
    setSelectedServiceId(nextServiceId);
    const selected = services.data?.find((service) => service.id === nextServiceId);
    if (selected && !displayName.trim()) setDisplayName(selected.displayName);
  }

  /** 提交服务与媒体库解耦后的首版媒体库配置。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedServiceId) {
      setMessage("请选择来源网盘服务");
      return;
    }
    setMessage("正在创建媒体库…");
    try {
      const result = await createLibrary({
        sourceServiceId: selectedServiceId,
        displayName: displayName.trim(),
        dataType,
        scan: { fullRoots: [], incrementalRoots: [], mediaTypes: [dataType], removedRootPolicy: "protect", scanDirectoryConcurrency: dataType === "music" ? 4 : 8, ...(dataType === "music" ? { musicFileConcurrency: 4 } : {}), scrapeTaskConcurrency: dataType === "music" ? 2 : 4 },
        metadata: dataType === "music" ? { profiles: { music: { providerId: "auto", aggregateMode: "fast", requiredFields: { artist: true, album: true, cover: true, lyrics: false } } } } : { profiles: { video: { providerId: "builtin.tmdb", language: "zh-CN", region: "CN", useNfo: true, syncDetails: false, analyzeMediaSpecs: false, aiCleaning: { enabled: false, modelId: "", triggerMode: "weak_or_unmatched", minConfidence: 0.75 } } } },
      });
      await navigate({ to: "/app/libraries/$serviceId/settings", params: { serviceId: result.library.id } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "媒体库创建失败");
    }
  }

  if (!services.data) return <Panel><p className="py-12 text-center text-sm text-muted-foreground">{services.error ?? "正在读取来源服务…"}</p></Panel>;
  return <><PageHeader title="创建媒体库" /><Panel><form onSubmit={(event) => void submit(event)} className="grid gap-5"><label><span className="text-xs text-muted-foreground">来源服务</span><select disabled={Boolean(serviceId)} value={selectedServiceId} onChange={(event) => selectSource(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">请选择网盘服务</option>{services.data.map((service) => <option key={service.id} value={service.id}>{service.displayName} · {service.providerType}</option>)}</select></label><label><span className="text-xs text-muted-foreground">媒体库名称</span><input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label><fieldset><legend className="text-xs text-muted-foreground">媒体库类型</legend><div className="mt-2 flex gap-2">{(["video", "music"] as MediaType[]).map((type) => <button key={type} type="button" onClick={() => setDataType(type)} className={`rounded-lg border px-4 py-2 text-sm ${dataType === type ? "border-foreground/50" : "border-border"}`}>{type === "video" ? "影视" : "音乐"}</button>)}</div></fieldset><p className="text-xs text-muted-foreground">创建后在媒体库设置中选择扫描路径、配置元数据、定时任务、通知和对外协议。有声书保留数据类型，当前版本暂不开放创建。</p><div><PrimaryButton type="submit" disabled={!selectedServiceId}>创建媒体库</PrimaryButton></div>{message && <p className="text-sm text-muted-foreground">{message}</p>}</form></Panel></>;
}
