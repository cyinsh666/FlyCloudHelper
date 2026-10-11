import { useEffect, useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { StatusPill } from "@/components/ui-kit";
import {
  checkContentSourceDiagnostics,
  getContentSourceDiagnostics,
  type ContentSourceDiagnosticsResult,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

interface DiagnosticsState {
  libraryId: string;
  admin: boolean;
  disabled: boolean;
  refreshVersion: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}

/** 展示最近检测时间，未检测时不推断源站可用。 */
function diagnosticTime(value: string | null): string {
  if (!value) return "尚未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN", { hour12: false });
}

/** 以毫秒或秒展示服务器测得的请求耗时。 */
function diagnosticElapsed(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
}

/** 标准 ticks 换算为样本时长；没有测得时长时明确标示。 */
function diagnosticDuration(ticks: number | null): string {
  if (ticks === null || ticks <= 0) return "未测得";
  const seconds = Math.floor(ticks / 10_000_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

/** 展示安全诊断摘要，检测和线路抽查均由用户主动触发。 */
export function ContentSourceDiagnostics({ state }: { state: DiagnosticsState }) {
  // 关键变量：诊断前后推进版本，已开始的旧 GET 不能覆盖本次检测结果。
  const requestVersionRef = useRef(0);
  const readErrorVersionRef = useRef(0);
  const resource = useApiResource(async () => {
    const version = requestVersionRef.current;
    try {
      return { result: await getContentSourceDiagnostics(state.libraryId, state.admin), version };
    } catch (readError) {
      readErrorVersionRef.current = version;
      throw readError;
    }
  }, [state.libraryId, state.admin, state.refreshVersion]);
  const [confirmed, setConfirmed] = useState<ContentSourceDiagnosticsResult | null>(null);
  const [checking, setChecking] = useState<"catalog" | "playback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：阻止重复诊断与两种检测同时执行。
  const submittingRef = useRef(false);
  const result = confirmed ?? (resource.data?.version === requestVersionRef.current ? resource.data.result : null);
  const readError = readErrorVersionRef.current === requestVersionRef.current ? resource.error : null;

  useEffect(() => {
    if (resource.data && resource.data.version === requestVersionRef.current && !submittingRef.current) setConfirmed(resource.data.result);
  }, [resource.data]);

  /** 打开历史记录，不触发源站检测，停用源也可查看已有结果。 */
  function openDiagnostics(): void {
    if (submittingRef.current) return;
    setError(null);
    state.onOpen();
  }

  /** 检测标记在请求前同步更新，防止状态刷新前关闭弹窗。 */
  function closeDiagnostics(): void {
    if (submittingRef.current) return;
    setError(null);
    state.onClose();
  }

  /** 刷新服务器已保存的记录，仅调用 GET，不开始新的抽查。 */
  function reloadHistory(): void {
    if (submittingRef.current || resource.loading) return;
    void resource.refresh();
  }

  /** 分别检测分类接口或抽查已有目录中的少量独立线路。 */
  async function checkSource(checkPlayback: boolean): Promise<void> {
    if (submittingRef.current || resource.loading || state.disabled) return;
    submittingRef.current = true;
    state.onBusyChange(true);
    requestVersionRef.current += 1;
    setChecking(checkPlayback ? "playback" : "catalog");
    setError(null);
    try {
      const checked = await checkContentSourceDiagnostics(state.libraryId, checkPlayback, state.admin);
      requestVersionRef.current += 1;
      setConfirmed(checked);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "内容源检测失败，请重试");
    } finally {
      submittingRef.current = false;
      setChecking(null);
      state.onBusyChange(false);
    }
  }

  return <>
    <section aria-label="内容源诊断" className="grid min-h-12 min-w-0 grid-cols-1 items-center gap-x-4 gap-y-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[8rem_minmax(0,1fr)_auto]">
      <p className="min-w-0 text-sm">源站与线路诊断</p>
      <div className="min-w-0 sm:col-span-2 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
        {result && <p className="break-words text-xs text-muted-foreground">{result.catalog.status === "unknown" ? "尚未检测" : `分类接口${result.catalog.status === "ok" ? "通过" : "失败"} · ${diagnosticTime(result.checkedAt)}`}</p>}
        {!result && !readError && <div aria-label="内容源诊断加载中" className="h-4 w-48 animate-pulse rounded bg-muted" />}
        {readError && <p role="alert" className="mt-1 text-xs text-destructive">读取失败，可查看详情重试</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 sm:col-start-2 sm:row-start-1 lg:col-start-3">
        {readError && <SecondaryButton disabled={resource.loading || checking !== null} onClick={reloadHistory}>重试</SecondaryButton>}
        <SecondaryButton disabled={checking !== null} onClick={openDiagnostics}>查看</SecondaryButton>
      </div>
    </section>
    {state.open && <ContentSourceSettingsDialog state={{
      title: "源站与线路诊断",
      description: "查看历史结果，或手动检测源站与已有线路样本。",
      busy: checking !== null,
      onClose: closeDiagnostics,
      children: <div className="min-w-0 max-w-full space-y-4">
        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={resource.loading || checking !== null || state.disabled} onClick={() => void checkSource(false)}>{checking === "catalog" ? "正在检测…" : "检测源站"}</SecondaryButton>
          <SecondaryButton disabled={resource.loading || checking !== null || state.disabled} onClick={() => void checkSource(true)}>{checking === "playback" ? "正在抽查…" : "抽查线路"}</SecondaryButton>
          <SecondaryButton disabled={resource.loading || checking !== null} onClick={reloadHistory}>{resource.loading ? "正在读取…" : "刷新历史"}</SecondaryButton>
        </div>
        <p className="text-xs text-muted-foreground">检测源站读取分类接口；抽查线路最多检查 3 个独立线路样本。分类接口通过不代表播放通过，样本通过也不代表全部影片、分集或客户端网络都可播放。</p>
        {!result && !readError && <div aria-label="内容源诊断加载中" className="animate-pulse space-y-2"><div className="h-5 w-52 rounded bg-muted" /><div className="h-12 rounded bg-muted" /><div className="h-12 rounded bg-muted" /></div>}
        {readError && <p role="alert" className="break-words text-xs text-destructive">{readError}</p>}
        {result && <div className="grid min-w-0 gap-4">
          <p className="text-xs text-muted-foreground">最近检测：{diagnosticTime(result.checkedAt)}</p>
          <div className="border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-3"><span className="text-xs">源站分类接口</span><StatusPill>{result.catalog.status === "ok" ? "检测通过" : result.catalog.status === "failed" ? "检测失败" : "尚未检测"}</StatusPill><span className="text-xs text-muted-foreground">分类数：{result.catalog.categoryCount ?? "—"} · 耗时：{diagnosticElapsed(result.catalog.elapsedMs)}</span></div>
            {result.catalog.error && <p className="mt-2 break-words text-xs text-destructive">{result.catalog.error}</p>}
          </div>
          {result.lines.length > 0 ? <div className="min-w-0 max-w-full overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><caption className="px-3 py-2.5 text-left text-muted-foreground">线路抽查结果，仅代表本次样本</caption><thead className="border-y border-border"><tr><th scope="col" className="px-3 py-2 font-medium">影片 / 分集</th><th scope="col" className="px-3 py-2 font-medium">线路 / 格式</th><th scope="col" className="px-3 py-2 font-medium">结果</th><th scope="col" className="px-3 py-2 font-medium">耗时 / 时长</th></tr></thead><tbody>{result.lines.map((line, index) => <tr key={`${line.sourceId}:${index}`} className="border-b border-border last:border-b-0"><td className="max-w-64 px-3 py-2.5 align-top"><p className="break-words">{line.title || "未命名影片"}</p>{line.episodeName && <p className="mt-1 break-words text-muted-foreground">{line.episodeName}</p>}</td><td className="px-3 py-2.5 align-top"><p className="break-words">{line.lineName || "未命名线路"}</p><p className="mt-1 text-muted-foreground">{line.container || "未识别"}</p></td><td className="max-w-80 px-3 py-2.5 align-top"><StatusPill>{line.status === "ok" ? "样本通过" : "样本失败"}</StatusPill>{line.error && <p className="mt-2 break-words text-destructive">{line.error}</p>}</td><td className="px-3 py-2.5 align-top"><p>{diagnosticElapsed(line.elapsedMs)}</p><p className="mt-1 text-muted-foreground">{diagnosticDuration(line.runTimeTicks)}</p></td></tr>)}</tbody></table></div> : <p className="text-xs text-muted-foreground">暂无线路抽查结果；先导入内容，再点击“抽查线路”。</p>}
          <div className="border-t border-border pt-3"><p className="text-xs">最近播放失败</p>{result.lastPlaybackFailure ? <div className="mt-2 grid gap-1 text-xs text-muted-foreground"><p className="break-words">{diagnosticTime(result.lastPlaybackFailure.at)} · {result.lastPlaybackFailure.protocol === "jellyfin" ? "Jellyfin" : "Emby"} · {result.lastPlaybackFailure.stage === "resolve" ? "解析播放来源" : "中转取流"}{result.lastPlaybackFailure.upstreamStatus !== null && ` · 源站 HTTP ${result.lastPlaybackFailure.upstreamStatus}`}</p><p className="break-words text-destructive">{result.lastPlaybackFailure.message}</p></div> : <p className="mt-2 text-xs text-muted-foreground">暂无服务器记录的播放失败；直连跳转后的客户端失败可能不会上报云助手。</p>}</div>
        </div>}
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      </div>,
    }} />}
  </>;
}
