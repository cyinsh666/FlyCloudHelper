import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ExternalLink, LoaderCircle, Search } from "lucide-react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { RecommendationMovieCard, RecommendationMovieSkeleton, recommendationCardGridStyle } from "@/components/RecommendationCards";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getOfflineTransferStatus, getRecommendationDetail, getResourceSearchTargets, getResourceTransferStatus, offlineTransferResource,
  searchResources, transferResource,
  type RecommendationDetail, type ResourceSearchItem, type ResourceSearchTarget,
} from "@/lib/api";

// 关键变量：使用「新片与追剧」里的同一个榜单和缓存。
const weeklyUpdatesBlockId = "tmdb-tv-next-seven-days";

// 关键变量：标签与搜索引擎识别的网盘类型保持一致，切换标签只筛选当前结果。
const cloudTabs = [
  { id: "all", label: "全部" }, { id: "quark", label: "夸克" }, { id: "uc", label: "UC" },
  { id: "baidu", label: "百度" }, { id: "aliyun", label: "阿里云盘" }, { id: "guangya", label: "光鸭" },
  { id: "xunlei", label: "迅雷" }, { id: "tianyi", label: "天翼" }, { id: "115", label: "115" },
  { id: "123", label: "123" }, { id: "mobile", label: "移动云盘" }, { id: "pikpak", label: "PikPak" },
  { id: "magnet", label: "磁力" },
] as const;

/** 来源筛选将所有 Telegram 频道合并，公开站点仍按站点名称分别展示。 */
function sourceFilterId(item: ResourceSearchItem): string {
  return item.sourceKind === "telegram" ? "telegram" : `${item.sourceKind}:${item.sourceName}`;
}

/** 将可转存网盘类型转换为页面统一使用的名称。 */
function transferProviderName(providerType: string): string {
  return providerType === "quark" ? "夸克" : "光鸭";
}

/** 独立搜索页空闲时展示未来七天排期，点击作品后直接查找资源。 */
function WeeklyUpdates({ admin, onSearch }: { admin: boolean; onSearch: (title: string) => void }) {
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 直接读取榜单快照，发起搜索后丢弃未完成的排期响应。 */
  useEffect(() => {
    let active = true;
    setError(null);
    void getRecommendationDetail(weeklyUpdatesBlockId, page, admin).then((next) => {
      if (active) setDetail(next);
    }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : "读取更新榜单失败");
    });
    return () => { active = false; };
  }, [admin, page]);

  const visible = detail?.pagination.page === page ? detail : null;
  return <Panel className="mt-5" title={detail?.title ?? "未来 7 天更新"} description={detail?.description ?? undefined}>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p>
      : !visible ? <RecommendationMovieSkeleton count={6} />
      : visible.items.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">
        {visible.lastUpdated ? "未来 7 天暂无符合条件的剧集" : "更新榜单尚未同步"}
      </p> : <div className="grid gap-3" style={recommendationCardGridStyle}>
        {visible.items.map((item) => <RecommendationMovieCard key={item.rank} item={item} onOpen={() => onSearch(item.title)} />)}
      </div>}
    {detail && detail.pagination.totalPages > 1 && <div className="mt-4 flex items-center justify-center gap-2">
      <SecondaryButton disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</SecondaryButton>
      <span className="text-xs text-muted-foreground">{page} / {detail.pagination.totalPages}</span>
      <SecondaryButton disabled={page >= detail.pagination.totalPages} onClick={() => setPage(page + 1)}>下一页</SecondaryButton>
    </div>}
  </Panel>;
}

/** 用户和管理员共用的资源搜索内容，也可嵌入影片详情并自动搜索片名。 */
export function ResourceSearchPage({ admin = false, embedded = false, initialKeyword = "", onSearchingChange }: {
  admin?: boolean; embedded?: boolean; initialKeyword?: string; onSearchingChange?: (searching: boolean) => void;
}) {
  const routeKeyword = useRouterState({ select: (state) => {
    const value = state.location.search.keyword;
    return typeof value === "string" ? value.trim().slice(0, 100) : "";
  } });
  // 关键变量：嵌入详情时优先使用作品片名，独立页面继续读取路由中的搜索词。
  const autoKeyword = embedded ? initialKeyword.trim().slice(0, 100) : routeKeyword;
  // 关键变量：输入法组合输入期间不提交搜索，输入值交给原生输入框维护。
  const composingRef = useRef(false);
  const keywordInputRef = useRef<HTMLInputElement>(null);
  const searchedRouteKeywordRef = useRef<string | null>(null);
  // 关键变量：自动搜索与手动搜索可能相继发起，只展示最后一次请求的结果。
  const searchRequestRef = useRef<AbortController | null>(null);
  // 关键变量：组件卸载后不再把旧搜索状态回传给影片详情。
  const mountedRef = useRef(false);
  const [targets, setTargets] = useState<ResourceSearchTarget[]>([]);
  const [results, setResults] = useState<ResourceSearchItem[]>([]);
  const [activeCloudType, setActiveCloudType] = useState<string>("all");
  const [activeSource, setActiveSource] = useState<string>("all");
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<ResourceSearchItem | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [task, setTask] = useState<{ serviceId: string; taskId: string; providerType: string;
    mode: "share" | "offline"; status: string; progress: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<{ completed: number; total: number } | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** 标记组件是否仍在页面上，开发模式重复执行副作用时保留首次搜索请求。 */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 开发模式会同步重跑 effect；仅在页面真正离开后取消请求。
      queueMicrotask(() => { if (!mountedRef.current) searchRequestRef.current?.abort(); });
    };
  }, []);

  /** 页面初次加载时读取可转存服务，搜索频道由系统设置统一维护。 */
  useEffect(() => {
    let alive = true;
    void getResourceSearchTargets(admin).then((nextTargets) => {
      if (alive) setTargets(nextTargets);
    }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "读取转存服务失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [admin]);

  /** 转存提交成功后轮询同一任务，避免重复提交分享。 */
  useEffect(() => {
    if (!task || task.status === "completed" || task.status === "partial" || task.status === "failed") return undefined;
    let alive = true;
    const timer = window.setInterval(() => {
      void (task.mode === "offline" ? getOfflineTransferStatus(task.serviceId, task.taskId, admin)
        : getResourceTransferStatus(task.serviceId, task.taskId, admin))
        .then((result) => {
          if (!alive) return;
          setTask((current) => current?.taskId === task.taskId ? { ...current, status: result.status,
            progress: "progress" in result ? result.progress : current.progress } : current);
          if (result.status === "completed") setMessage(task.mode === "offline" ? "光鸭离线任务已完成" : `${transferProviderName(task.providerType)}转存已完成`);
          if (result.status === "partial") setMessage("光鸭离线任务部分完成，请检查目标目录和光鸭任务列表");
          if (result.status === "failed") setError(task.mode === "offline" ? "光鸭离线任务失败，请检查磁力资源和光鸭任务列表"
            : `${transferProviderName(task.providerType)}转存任务失败，请检查分享链接和目标目录`);
        })
        .catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : "查询转存状态失败"); });
    }, task.mode === "offline" ? 30_000 : 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [task?.serviceId, task?.taskId, task?.status, task?.mode, admin]);

  /** 从已启用来源搜索关键词，自动跳转与手动提交共用同一段状态更新。 */
  async function searchKeyword(keyword: string): Promise<void> {
    if (!keyword) return;
    searchRequestRef.current?.abort();
    const request = new AbortController();
    searchRequestRef.current = request;
    /** 离开详情或提交新关键词后，旧请求不能覆盖当前结果。 */
    function isCurrent(): boolean {
      return mountedRef.current && searchRequestRef.current === request;
    }
    setHasSearched(true);
    setSearching(true);
    setSearchProgress(null);
    onSearchingChange?.(true);
    setError(null);
    setMessage(null);
    setResults([]);
    setSourceErrors([]);
    setActiveCloudType("all");
    setActiveSource("all");
    // 关键变量：结束帧可能与最后一次进度相同，复用当前列表和错误状态。
    let lastItems = "[]";
    let lastErrors = "[]";
    /** 只有可见数据变化才替换对应状态。 */
    function showResults(items: ResourceSearchItem[], errors: string[]): void {
      const itemsKey = JSON.stringify(items);
      if (itemsKey !== lastItems) {
        lastItems = itemsKey;
        setResults(items);
      }
      const errorsKey = JSON.stringify(errors);
      if (errorsKey !== lastErrors) {
        lastErrors = errorsKey;
        setSourceErrors(errors);
      }
    }
    try {
      const found = await searchResources(keyword, admin, (progress) => {
        if (!isCurrent()) return;
        showResults(progress.items, progress.errors);
        setSearchProgress({ completed: progress.completed, total: progress.total });
      }, request.signal);
      if (!isCurrent()) return;
      showResults(found.items, found.errors);
    } catch (failure) {
      if (isCurrent() && !request.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "搜索失败");
      }
    } finally {
      if (isCurrent()) {
        setSearching(false);
        onSearchingChange?.(false);
      }
    }
  }

  /** 用户提交关键词后搜索网盘分享，不打断中文输入法组合输入。 */
  async function runSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (composingRef.current) return;
    const keyword = String(new FormData(event.currentTarget).get("keyword") ?? "").trim();
    await searchKeyword(keyword);
  }

  /** 用路由或详情传入的片名填充原生输入框，并自动执行一次资源搜索。 */
  useEffect(() => {
    if (!autoKeyword && searchedRouteKeywordRef.current) {
      searchedRouteKeywordRef.current = null;
      searchRequestRef.current?.abort();
      searchRequestRef.current = null;
      if (keywordInputRef.current) keywordInputRef.current.value = "";
      setHasSearched(false);
      setSearching(false);
      setResults([]);
      setSourceErrors([]);
      setError(null);
      onSearchingChange?.(false);
      return;
    }
    if (!autoKeyword || searchedRouteKeywordRef.current === `${admin}:${autoKeyword}`) return;
    searchedRouteKeywordRef.current = `${admin}:${autoKeyword}`;
    if (keywordInputRef.current) keywordInputRef.current.value = autoKeyword;
    void searchKeyword(autoKeyword);
  }, [autoKeyword, admin]);

  /** 从更新榜单选片后填入同一个搜索框，并使用原有分批搜索流程。 */
  function searchRecommendedTitle(title: string): void {
    if (keywordInputRef.current) keywordInputRef.current.value = title;
    void searchKeyword(title.trim().slice(0, 100));
  }

  /** 打开转存选择并刷新服务目录，避免使用进入页面时的旧配置。 */
  async function openTransfer(item: ResourceSearchItem): Promise<void> {
    setError(null);
    try {
      const nextTargets = await getResourceSearchTargets(admin);
      setTargets(nextTargets);
      setSelected(item);
      const providerType = item.cloudType === "magnet" ? "guangya" : item.cloudType;
      const first = nextTargets.find((target) => target.providerType === providerType && target.directory);
      setServiceId(first?.serviceId ?? "");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取转存服务失败"); }
  }

  /** 切换服务时按服务级独立转存目录决定是否允许提交。 */
  function selectService(nextServiceId: string): void {
    setServiceId(nextServiceId);
  }

  /** 提交一次网盘远端转存，返回任务编号后关闭选择框。 */
  async function submitTransfer(): Promise<void> {
    if (!selected || !serviceId || !selectedTarget?.directory || transferring) return;
    setTransferring(true);
    setError(null);
    try {
      const offline = selected.cloudType === "magnet";
      const submitted = offline
        ? await offlineTransferResource({ magnetUrl: selected.shareUrl, serviceId }, admin)
        : await transferResource({ shareUrl: selected.shareUrl, password: selected.password, serviceId }, admin);
      setTask({ serviceId, taskId: submitted.taskId, providerType: offline ? "guangya" : selected.cloudType,
        mode: offline ? "offline" : "share", status: "pending", progress: 0 });
      setMessage(offline ? "磁力已提交到光鸭，正在等待云添加完成"
        : `已提交 ${submitted.fileCount} 个文件或文件夹，正在等待${transferProviderName(selected.cloudType)}完成转存`);
      setSelected(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "提交转存失败，请检查目标目录再决定是否重试"); }
    finally { setTransferring(false); }
  }

  const selectedTarget = targets.find((target) => target.serviceId === serviceId);
  // 关键变量：网盘标签只保留本次搜索实际命中的类型，未知的新网盘类型也能出现。
  const cloudCounts = new Map<string, number>();
  for (const item of results) cloudCounts.set(item.cloudType, (cloudCounts.get(item.cloudType) ?? 0) + 1);
  const visibleCloudTabs: Array<{ id: string; label: string }> = cloudTabs.filter((tab) => tab.id === "all" || cloudCounts.has(tab.id));
  for (const cloudType of cloudCounts.keys()) {
    if (!visibleCloudTabs.some((tab) => tab.id === cloudType)) visibleCloudTabs.push({ id: cloudType, label: cloudType });
  }
  // 关键变量：第二级来源只统计当前网盘下实际出现的结果。
  const cloudResults = activeCloudType === "all" ? results : results.filter((item) => item.cloudType === activeCloudType);
  const sourceCounts = new Map<string, { label: string; count: number }>();
  for (const item of cloudResults) {
    const sourceId = sourceFilterId(item);
    const label = item.sourceKind === "telegram" ? "Telegram"
      : item.sourceKind === "public_site" ? `站点:${item.sourceName}` : item.source;
    const previous = sourceCounts.get(sourceId);
    sourceCounts.set(sourceId, { label, count: (previous?.count ?? 0) + 1 });
  }
  const visibleResults = activeSource === "all" ? cloudResults
    : cloudResults.filter((item) => sourceFilterId(item) === activeSource);

  return (
    <div>
      {!embedded && <PageHeader title="搜索引擎" />}
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {message && <div role="status" className="mb-4 rounded-lg border border-border bg-secondary/50 p-3 text-sm">{message}</div>}
      {task && <div className="mb-4 rounded-lg border border-border bg-secondary/50 p-3 text-sm">
        {task.mode === "offline" ? "光鸭离线任务" : `${transferProviderName(task.providerType)}转存任务`}：
        {task.status === "completed" ? "已完成" : task.status === "partial" ? "部分完成" : task.status === "failed" ? "失败" : "处理中"}
        {task.mode === "offline" && task.status === "running" ? ` ${task.progress}%` : ""}（{task.taskId}）
      </div>}

      {(!embedded || results.length > 0) && <Panel title={embedded ? undefined : "搜索网盘资源"}
        description={embedded ? undefined : "从已启用的 Telegram 频道和公开站点查找分享与磁力；磁力可离线到光鸭。"}>
        {!embedded && <form onSubmit={(event) => void runSearch(event)} className="flex flex-col gap-3 sm:flex-row">
          <input ref={keywordInputRef} name="keyword" maxLength={100} required
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder="输入影片名称" aria-label="影片名称"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2.5 text-sm" />
          <PrimaryButton type="submit">
            {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}搜索
          </PrimaryButton>
        </form>}
        {results.length > 0 && <div role="tablist" aria-label="网盘筛选"
          className={embedded ? "flex gap-2 overflow-x-auto" : "mt-4 flex gap-2 overflow-x-auto border-t border-border pt-4"}>
          {visibleCloudTabs.map((tab) => {
            const count = tab.id === "all" ? results.length : cloudCounts.get(tab.id) ?? 0;
            return <button key={tab.id} type="button" role="tab" aria-selected={activeCloudType === tab.id}
              onClick={() => { setActiveCloudType(tab.id); setActiveSource("all"); }}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition-colors ${activeCloudType === tab.id
                ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
              {tab.label} <span className="text-xs text-muted-foreground">{count}</span>
            </button>;
          })}
        </div>}
        {results.length > 0 && <div role="tablist" aria-label="来源筛选" className="mt-3 flex gap-2 overflow-x-auto border-t border-border pt-3">
          <button type="button" role="tab" aria-selected={activeSource === "all"} onClick={() => setActiveSource("all")}
            className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition-colors ${activeSource === "all"
              ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
            全部来源 <span className="text-xs text-muted-foreground">{cloudResults.length}</span>
          </button>
          {[...sourceCounts].map(([sourceId, source]) => <button key={sourceId} type="button" role="tab"
            aria-selected={activeSource === sourceId} onClick={() => setActiveSource(sourceId)}
            className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition-colors ${activeSource === sourceId
              ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
            {source.label} <span className="text-xs text-muted-foreground">{source.count}</span>
          </button>)}
        </div>}
      </Panel>}
      {searching && <p role="status" className="mt-3 text-sm text-muted-foreground">
        {searchProgress ? `已查找 ${searchProgress.completed} / ${searchProgress.total} 个来源 · 已找到 ${results.length} 条资源`
          : "正在查找资源…"}
      </p>}

      {!embedded && !autoKeyword && !hasSearched && <WeeklyUpdates admin={admin} onSearch={searchRecommendedTitle} />}

      {/* 关键变量：结果卡片按容器宽度自动换列，窄屏仍保持单列。 */}
      {(hasSearched || embedded) && <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))" }}>
        {visibleResults.map((item) => <Panel key={`${item.cloudType}:${item.shareUrl}`} className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{item.title}</h2><StatusPill>{cloudTabs.find((tab) => tab.id === item.cloudType)?.label ?? item.cloudType}</StatusPill></div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusPill>{item.sourceKind === "telegram" ? `tg:${item.sourceName}`
                  : item.sourceKind === "public_site" ? `站点:${item.sourceName}` : item.source}</StatusPill>
                {item.postedAt && <span>· {new Date(item.postedAt).toLocaleString("zh-CN")}</span>}
              </div>
              {item.cloudType === "magnet"
                ? <p className="mt-2 break-all text-xs text-muted-foreground" title={item.shareUrl}>
                  {item.shareUrl.length > 180 ? `${item.shareUrl.slice(0, 180)}…` : item.shareUrl}</p>
                : <a href={item.shareUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-sm text-primary-soft">
                  {item.shareUrl}<ExternalLink className="size-3 shrink-0" />
                </a>}
              {item.password && <p className="mt-1 text-xs text-muted-foreground">提取码：{item.password}</p>}
            </div>
            {(item.cloudType === "guangya" || item.cloudType === "quark" || item.cloudType === "magnet")
              && <SecondaryButton onClick={() => void openTransfer(item)} disabled={loading}>
                {item.cloudType === "magnet" ? "离线到光鸭" : "转存"}</SecondaryButton>}
          </div>
        </Panel>)}
        {!searching && visibleResults.length === 0 && !loading && <p className="col-span-full py-5 text-center text-sm text-muted-foreground">{results.length > 0 ? "当前筛选暂无搜索结果" : "暂无搜索结果"}</p>}
        {sourceErrors.length > 0 && <details className="col-span-full rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{sourceErrors.length} 个来源搜索失败，点击查看具体来源；{admin ? "可在系统设置的数据源分类中调整" : "请联系管理员检查数据源配置"}。</summary>
          <ul className="mt-2 space-y-1 pl-4">{sourceErrors.map((sourceError, index) => <li key={`${sourceError}:${index}`} className="list-disc">{sourceError}</li>)}</ul>
        </details>}
      </div>}

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onClick={() => setSelected(null)}>
        <div role="dialog" aria-modal="true" aria-label={`选择${transferProviderName(selected.cloudType)}转存位置`} onClick={(event) => event.stopPropagation()}
          className="surface w-full max-w-lg space-y-4 p-5">
          <h2 className="text-lg font-semibold">{selected.cloudType === "magnet" ? "离线到光鸭服务" : `转存到${transferProviderName(selected.cloudType)}服务`}</h2>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}
          <p className="truncate text-sm text-muted-foreground">{selected.title}</p>
          <label className="block space-y-1 text-sm">已有{transferProviderName(selected.cloudType)}服务
            <select value={serviceId} onChange={(event) => selectService(event.target.value)} className="w-full rounded-lg border border-border bg-background p-2.5">
              <option value="">请选择服务</option>
              {targets.filter((target) => target.providerType === (selected.cloudType === "magnet" ? "guangya" : selected.cloudType)).map((target) => <option key={target.serviceId} value={target.serviceId} disabled={!target.directory}>
                {target.serviceName}{target.reason ? `（${target.reason}）` : ""}
              </option>)}
            </select>
          </label>
          {selectedTarget?.directory && <p className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
            转存目录：{selectedTarget.directory.displayPath}
          </p>}
          {!targets.some((target) => target.providerType === (selected.cloudType === "magnet" ? "guangya" : selected.cloudType) && target.directory)
            && <p className="text-sm text-muted-foreground">没有可用的{transferProviderName(selected.cloudType)}服务；请先在网盘服务详情中设置独立转存目录。</p>}
          <div className="flex justify-end gap-2"><SecondaryButton onClick={() => setSelected(null)}>取消</SecondaryButton>
            <PrimaryButton onClick={() => void submitTransfer()} disabled={!serviceId || !selectedTarget?.directory || transferring}>
              {transferring ? "提交中…" : selected.cloudType === "magnet" ? "确认离线" : "确认转存"}
            </PrimaryButton></div>
        </div>
      </div>}
    </div>
  );
}
