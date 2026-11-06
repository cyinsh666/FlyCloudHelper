import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { getResourceSearchSources, saveResourceSearchSources, type ResourceSearchSource } from "@/lib/api";

// 关键变量：这些公开站点由服务端代码适配，页面只负责启用或停用。
const publicSiteLabels: Record<string, string> = {
  pansearch: "PanSearch", quarkres: "热门夸克资源", quark4k: "Quark4K", haitunsou: "海豚搜",
  kdocs_guangya_didida: "光鸭滴滴嗒", kdocs_mobile_didida: "移动滴滴嗒",
  clmao: "磁力猫",
};

/** 系统设置中的公开 Telegram 搜索频道管理。 */
export function AdminTelegramSearchSourcesPanel() {
  const [sources, setSources] = useState<ResourceSearchSource[]>([]);
  const [channelName, setChannelName] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 进入数据源标签时读取全局频道与公开站点配置。 */
  useEffect(() => {
    let alive = true;
    void getResourceSearchSources(true).then((items) => {
      if (alive) setSources(items);
    }).catch((failure) => {
      if (alive) setError(failure instanceof Error ? failure.message : "读取搜索来源失败");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  /** 更新当前频道的名称或启用状态。 */
  function updateSource(index: number, update: Partial<ResourceSearchSource>): void {
    setSources((current) => current.map((item, position) => position === index ? { ...item, ...update } : item));
    setMessage(null);
  }

  /** 将新的公开频道加入待保存列表。 */
  function addSource(): void {
    const key = channelName.trim().replace(/^@/u, "");
    if (!/^[A-Za-z0-9_]{5,32}$/u.test(key)) {
      setError("频道名称应为 5～32 位字母、数字或下划线");
      return;
    }
    if (sources.some((item) => item.kind === "telegram" && item.key.toLowerCase() === key.toLowerCase())) {
      setError("该频道已经存在");
      return;
    }
    setSources((current) => [...current, { kind: "telegram", key, enabled: true }]);
    setChannelName("");
    setMessage(null);
    setError(null);
  }


  /** 保存完整全局配置，搜索请求从下一次开始读取新频道列表。 */
  async function saveSources(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const normalized = sources.map((item) => item.kind === "telegram"
        ? { ...item, key: item.key.trim().replace(/^@/u, "") } : item);
      setSources(await saveResourceSearchSources(normalized, true));
      setMessage("搜索来源已保存，之后的搜索立即使用新配置");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存搜索来源失败"); }
    finally { setSaving(false); }
  }

  // 关键变量：只在 Telegram 区域展示频道；其他代码适配器的来源仍保留在完整配置中。
  const channels = sources.map((source, index) => ({ source, index })).filter(({ source }) => source.kind === "telegram");
  const publicSites = sources.map((source, index) => ({ source, index })).filter(({ source }) => source.kind === "public_site");

  return (
    <>
    <Panel title="Telegram 搜索频道" description="预置频道可修改、删除或停用，也可以添加公开频道；配置对所有用户生效。" className="mt-4">
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
      {loading ? <div className="space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-10 animate-pulse rounded-lg bg-secondary" />)}</div> : <>
        <div className="mb-3 flex flex-wrap gap-2">
          <input value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="频道名称，例如 @example_channel"
            aria-label="新增频道名称" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <SecondaryButton onClick={addSource}><Plus className="size-4" /> 新增</SecondaryButton>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选频道" aria-label="筛选频道"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <span className="text-xs text-muted-foreground">共 {channels.length} 个，启用 {channels.filter(({ source }) => source.enabled).length} 个</span>
        </div>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {channels.filter(({ source }) => source.key.toLowerCase().includes(filter.toLowerCase()))
            .map(({ source, index }) => <div key={index} className="flex items-center gap-2">
              <input type="checkbox" checked={source.enabled} onChange={(event) => updateSource(index, { enabled: event.target.checked })}
                aria-label={`启用 ${source.key}`} />
              <input value={source.key} onChange={(event) => updateSource(index, { key: event.target.value })}
                aria-label={`频道 ${index + 1}`} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
              <button type="button" onClick={() => { setSources((current) => current.filter((_item, position) => position !== index)); setMessage(null); }}
                aria-label={`删除 ${source.key}`} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"><Trash2 className="size-4" /></button>
            </div>)}
        </div>
        <div className="mt-4"><PrimaryButton onClick={() => void saveSources()} disabled={saving}>{saving ? "保存中…" : "保存频道配置"}</PrimaryButton></div>
      </>}
    </Panel>
    <Panel title="公开搜索站" description="站点由云助手内部适配器直接搜索，无需登录；可以按站点启停，配置对所有用户生效。" className="mt-4">
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
      {loading ? <div className="h-20 animate-pulse rounded-lg bg-secondary" /> : <>
        <div className="grid gap-2 sm:grid-cols-2">
          {publicSites.map(({ source, index }) => <label key={source.key} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
            <input type="checkbox" checked={source.enabled} onChange={(event) => updateSource(index, { enabled: event.target.checked })} />
            <span>{publicSiteLabels[source.key] ?? source.key}</span>
          </label>)}
        </div>
        <div className="mt-4"><PrimaryButton onClick={() => void saveSources()} disabled={saving}>{saving ? "保存中…" : "保存搜索来源"}</PrimaryButton></div>
      </>}
    </Panel>
    </>
  );
}
