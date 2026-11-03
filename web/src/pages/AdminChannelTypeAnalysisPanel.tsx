import { useEffect, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { getAdminChannelTypeAnalysis, startAdminChannelTypeAnalysis } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

// 关键变量：频道分析和个人订阅设置使用相同的网盘类型编码。
const cloudLabels: Record<string, string> = { guangya: "光鸭", quark: "夸克", aliyun: "阿里云盘",
  baidu: "百度网盘", "115": "115", "123": "123", tianyi: "天翼云盘", mobile: "移动云盘",
  uc: "UC", xunlei: "迅雷", pikpak: "PikPak" };

/** 显示管理员手动频道类型分析入口、进度和已保存的结果。 */
export function AdminChannelTypeAnalysisPanel() {
  const resource = useApiResource(() => getAdminChannelTypeAnalysis(), []);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = resource.data?.status.running ?? false;

  /** 手动分析期间定时读取进度，离开功能标签后自动停止。 */
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => void resource.refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [running, resource.refresh]);

  /** 只触发一次后台分析，页面随后从只读状态接口获取完成进度。 */
  async function analyzeNow(): Promise<void> {
    if (starting || running) return;
    setStarting(true);
    setError(null);
    try { await startAdminChannelTypeAnalysis(); await resource.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "启动频道分析失败"); }
    finally { setStarting(false); }
  }

  const data = resource.data;
  const status = data?.status;
  const cached = data?.cache.items ?? [];
  // 关键变量：一个频道可分享多种网盘，类型统计按频道去重后分别计入各网盘。
  const typeCounts = new Map<string, number>();
  for (const item of cached) {
    for (const type of item.observedTypes) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const progress = status?.total ? Math.round(status.completed / status.total * 100) : 0;

  return <Panel title="分析频道资源类型" description="检查已启用 TG 频道最近三页消息中的网盘分享链接，结果写入 data 缓存，供个人设置批量选择相关频道。">
    {resource.loading && !data && <div className="h-20 animate-pulse rounded-lg bg-secondary" aria-label="频道分析状态加载中" />}
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {data && <>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={() => void analyzeNow()} disabled={starting || running || data.totalChannels === 0}>
          {starting ? "启动中…" : running ? "分析中…" : "立即分析频道资源类型"}
        </PrimaryButton>
        <SecondaryButton onClick={() => void resource.refresh()}>刷新结果</SecondaryButton>
        <span className="text-xs text-muted-foreground">已启用 {data.totalChannels} 个频道 · 缓存已有 {cached.length} 个频道</span>
      </div>
      <div className="mt-4 space-y-1 text-xs text-muted-foreground">
        <p>定时分析：{data.automaticEnabled ? "已开启" : "当前环境未开启，可手动分析"}</p>
        <p>缓存更新时间：{data.cache.updatedAt ? new Date(data.cache.updatedAt).toLocaleString("zh-CN") : "尚未生成"}</p>
        {status?.startedAt && <p>本次分析：{status.running ? "进行中" : "已结束"} · 已处理 {status.completed}/{status.total}
          · 成功 {status.succeeded} · 失败 {status.failed}</p>}
      </div>
      {status?.running && <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar"
        aria-valuenow={status.completed} aria-valuemin={0} aria-valuemax={status.total || 1}>
        <div className="h-full rounded-full bg-foreground/70 transition-[width]" style={{ width: `${progress}%` }} />
      </div>}
      {status?.error && <p role="alert" className="mt-3 text-sm text-destructive">{status.error}</p>}
      {typeCounts.size > 0 && <div className="mt-5 flex flex-wrap gap-2">
        {[...typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => <span key={type}
          className="rounded-lg border border-border bg-secondary/30 px-2.5 py-1.5 text-xs">
          {cloudLabels[type] ?? type} · {count} 个频道
        </span>)}
      </div>}
      {cached.length > 0 && <div className="mt-5 max-h-80 space-y-1 overflow-y-auto border-t border-border pt-3">
        {cached.map((item) => <div key={item.channel} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1 text-xs">
          <span className="font-medium">@{item.channel}</span>
          <span className={item.error ? "text-destructive" : "text-muted-foreground"}>{item.error
            ? `分析失败：${item.error}` : item.observedTypes.length
              ? item.observedTypes.map((type) => cloudLabels[type] ?? type).join("、") : "未发现网盘链接"}</span>
        </div>)}
      </div>}
    </>}
  </Panel>;
}
