import { useEffect, useState } from "react";
import { ArrowLeft, Film, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ResourceSearchPage } from "@/pages/ResourceSearchPage";
import { getRecommendationDetail, getRecommendationItemDetail, getRecommendationRelatedItems, listRecommendations, syncRecommendations,
  type RecommendationBlock, type RecommendationDetail, type RecommendationItem, type RecommendationItemDetail,
  type RecommendationRelatedItem } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

// 关键变量：优先保持与榜单上游相同的业务分组顺序，新增分组仍可自动显示。
const preferredGroups = ["短剧", "热门推荐", "今日热度", "高分经典", "动画追番", "华语与地区"];
// 关键变量：竖版海报至少占 9.5rem，容器宽度决定一行展示的列数。
const posterGridStyle = { gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr))" };

/** 海报缺失或图片加载失败时保持相同的竖版卡片尺寸。 */
function RecommendationPoster({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  /** 榜单刷新后更换了封面地址时允许重新加载，不沿用旧地址的错误状态。 */
  useEffect(() => { setFailed(false); }, [url]);
  return <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-secondary">
    {url && !failed ? <img src={url} alt={title} loading="lazy" onError={() => setFailed(true)}
      className="h-full w-full object-cover" />
      : <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground">
        <Film className="size-9 opacity-50" /><span className="line-clamp-3 text-xs">{title}</span>
      </div>}
  </div>;
}

/** 展示单个榜单入口，点击后读取本地快照中的分页条目。 */
function BlockCard({ block, onOpen }: { block: RecommendationBlock; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="surface min-w-0 p-2.5 text-left transition-colors hover:bg-secondary/50">
    <RecommendationPoster url={block.posterUrl} title={block.title} />
    <p className="mt-2 line-clamp-2 min-h-10 text-sm font-medium">{block.title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{block.itemCount.toLocaleString()} 部作品</p>
    {block.description && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{block.description}</p>}
  </button>;
}

/** 竖版电影或剧集卡片；点击后进入该榜单条目的 TMDB 详情。 */
function MovieCard({ item, onOpen }: { item: RecommendationItem; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="surface min-w-0 p-2.5 text-left transition-colors hover:bg-secondary/50">
    <div className="relative">
      <RecommendationPoster url={item.posterUrl} title={item.title} />
      <span className="absolute left-1.5 top-1.5 rounded-md bg-black/75 px-2 py-0.5 text-xs font-medium text-white">
        #{item.rank}
      </span>
    </div>
    <h3 className="mt-2 line-clamp-2 min-h-10 text-sm font-medium" title={item.title}>{item.title}</h3>
    <p className="mt-1 truncate text-[11px] text-muted-foreground">
      {item.releaseDate?.slice(0, 4) || "年份未知"}{item.rating !== null ? ` · 评分 ${item.rating.toFixed(1)}` : ""}
    </p>
    {item.overview && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground" title={item.overview}>{item.overview}</p>}
  </button>;
}

/** 展示优先来自 TMDB 的作品详情，短剧等无 ID 条目沿用榜单快照信息。 */
function MovieDetail({ detail, related, relatedLoading, relatedError, searchOpen, searchLoading, admin, onSearch, onSearchingChange }: {
  detail: RecommendationItemDetail; related: RecommendationRelatedItem[]; relatedLoading: boolean;
  relatedError: string | null; searchOpen: boolean; searchLoading: boolean; admin: boolean;
  onSearch: () => void; onSearchingChange: (searching: boolean) => void;
}) {
  const { item, tmdb } = detail;
  const poster = tmdb?.posterUrl ?? item.posterUrl;
  const title = tmdb?.title || item.title;
  const overview = tmdb?.overview || item.overview;
  const cast = tmdb?.people.filter((person) => person.type === "cast").slice(0, 8) ?? [];
  return <div className="space-y-5">
    <div className="surface grid gap-5 p-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:p-5">
      <div className="w-full max-w-[13rem]"><RecommendationPoster url={poster} title={title} /></div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{detail.block.title} · 第 {item.rank} 名</p>
        <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
        {tmdb?.originalTitle && tmdb.originalTitle !== title &&
          <p className="mt-1 text-sm text-muted-foreground">{tmdb.originalTitle}</p>}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {(tmdb?.releaseDate || item.releaseDate) && <span>上映：{tmdb?.releaseDate || item.releaseDate}</span>}
          {(tmdb?.rating ?? item.rating) !== null && <span>评分：{(tmdb?.rating ?? item.rating)!.toFixed(1)}</span>}
          {tmdb?.mediaType === "tv" && tmdb.episodeCount > 0 && <span>共 {tmdb.episodeCount} 集</span>}
        </div>
        {tmdb?.genres.length ? <p className="mt-3 text-sm text-muted-foreground">类型：{tmdb.genres.join(" / ")}</p> : null}
        {overview && <div className="mt-5"><h3 className="text-sm font-medium">剧情简介</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{overview}</p></div>}
        {cast.length > 0 && <div className="mt-5"><h3 className="text-sm font-medium">主演</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{cast.map((person) => person.name).join("、")}</p></div>}
        {detail.tmdbError && <p className="mt-5 text-xs text-muted-foreground">TMDB 详情：{detail.tmdbError}，当前展示榜单资料。</p>}
        <div className="mt-6 border-t border-border pt-4">
          <PrimaryButton type="button" onClick={onSearch}>
            {searchOpen && searchLoading ? <LoaderCircle className="size-4 animate-spin" />
              : searchOpen ? <ArrowLeft className="size-4" /> : <Search className="size-4" />}
            {searchOpen && searchLoading ? "加载中…" : searchOpen ? "查看关联推荐" : "资源搜索"}
          </PrimaryButton>
        </div>
      </div>
    </div>
    {searchOpen ? <ResourceSearchPage admin={admin} embedded initialKeyword={item.title}
      onSearchingChange={onSearchingChange} /> : <section aria-label="关联推荐影片">
      <h3 className="mb-3 text-lg font-semibold">关联推荐影片</h3>
      {relatedLoading ? <div className="grid gap-3" style={posterGridStyle}>
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="surface animate-pulse p-2.5">
          <div className="aspect-[2/3] rounded-lg bg-secondary" /><div className="mt-2 h-4 rounded bg-secondary" />
        </div>)}
      </div> : related.length > 0 ? <div className="grid gap-3" style={posterGridStyle}>
        {related.map((recommended) => <div key={`${recommended.mediaType}:${recommended.id}`} className="surface min-w-0 p-2.5">
          <RecommendationPoster url={recommended.posterUrl} title={recommended.title} />
          <p className="mt-2 line-clamp-2 min-h-10 text-sm font-medium" title={recommended.title}>{recommended.title}</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {recommended.releaseDate.slice(0, 4) || "年份未知"}{recommended.rating > 0 ? ` · 评分 ${recommended.rating.toFixed(1)}` : ""}
          </p>
        </div>)}
      </div> : <p className="surface p-4 text-sm text-muted-foreground">{relatedError || "暂无关联推荐影片"}</p>}
    </section>}
  </div>;
}

/** 个人与管理员共用的影视推荐页面，分组标签从已缓存榜单动态生成。 */
export function RecommendationsPage({ admin = false }: { admin?: boolean }) {
  const resource = useApiResource(() => listRecommendations(admin), [admin]);
  const [activeGroup, setActiveGroup] = useState("全部");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedItemRank, setSelectedItemRank] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [itemDetail, setItemDetail] = useState<RecommendationItemDetail | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [relatedResult, setRelatedResult] = useState<{ blockId: string; rank: number; items: RecommendationRelatedItem[] } | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  // 关键变量：搜索状态绑定榜单和名次，切换作品后不会显示上一部影片的搜索结果。
  const [searchSelection, setSearchSelection] = useState<{ blockId: string; rank: number } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [detailRefreshVersion, setDetailRefreshVersion] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  /** 只在选中榜单或页码变化时读取详情，避免旧请求覆盖当前页面。 */
  useEffect(() => {
    if (!selectedBlockId) return;
    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    void getRecommendationDetail(selectedBlockId, page, admin).then((value) => {
      if (active) setDetail(value);
    }).catch((error) => {
      if (active) setDetailError(error instanceof Error ? error.message : "读取榜单失败");
    }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedBlockId, page, admin, detailRefreshVersion]);

  /** 按服务端快照定位条目，再读取已配置 TMDB 的作品详情。 */
  useEffect(() => {
    if (!selectedBlockId || selectedItemRank === null) return;
    let active = true;
    setItemLoading(true);
    setItemError(null);
    void getRecommendationItemDetail(selectedBlockId, selectedItemRank, admin).then((value) => {
      if (active) setItemDetail(value);
    }).catch((error) => {
      if (active) setItemError(error instanceof Error ? error.message : "读取作品详情失败");
    }).finally(() => { if (active) setItemLoading(false); });
    return () => { active = false; };
  }, [selectedBlockId, selectedItemRank, admin, detailRefreshVersion]);

  /** 关联推荐独立加载；切换作品时丢弃上一个请求的响应。 */
  useEffect(() => {
    if (!selectedBlockId || selectedItemRank === null) return;
    let active = true;
    setRelatedResult(null);
    setRelatedLoading(true);
    setRelatedError(null);
    void getRecommendationRelatedItems(selectedBlockId, selectedItemRank, admin).then((items) => {
      if (active) setRelatedResult({ blockId: selectedBlockId, rank: selectedItemRank, items });
    }).catch((error) => {
      if (active) setRelatedError(error instanceof Error ? error.message : "关联推荐暂时无法读取");
    }).finally(() => { if (active) setRelatedLoading(false); });
    return () => { active = false; };
  }, [selectedBlockId, selectedItemRank, admin, detailRefreshVersion]);

  /** 在当前作品详情内切换资源搜索与关联推荐。 */
  function toggleItemSearch(blockId: string, rank: number): void {
    const searchAlreadyOpen = searchSelection?.blockId === blockId && searchSelection.rank === rank;
    setSearchLoading(!searchAlreadyOpen);
    setSearchSelection(searchAlreadyOpen ? null : { blockId, rank });
  }

  /** 点击页面刷新时真正同步榜单上游，成功后重读列表和当前详情。 */
  async function syncNow(): Promise<void> {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const result = await syncRecommendations(admin);
      await resource.refresh();
      if (selectedBlockId) setDetailRefreshVersion((current) => current + 1);
      setSyncMessage(`已同步 ${result.total} 个榜单`);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "榜单同步失败，已保留上一份缓存");
    } finally {
      setSyncing(false);
    }
  }

  const blocks = resource.data?.items ?? [];
  const groupCounts = new Map<string, number>();
  for (const block of blocks) groupCounts.set(block.group, (groupCounts.get(block.group) ?? 0) + 1);
  const groups = [...groupCounts.keys()].sort((left, right) => {
    const leftIndex = preferredGroups.indexOf(left);
    const rightIndex = preferredGroups.indexOf(right);
    return (leftIndex < 0 ? preferredGroups.length : leftIndex) - (rightIndex < 0 ? preferredGroups.length : rightIndex);
  });
  const visibleBlocks = activeGroup === "全部" ? blocks : blocks.filter((block) => block.group === activeGroup);
  // 关键变量：翻页时只展示当前榜单当前页的数据，不闪现上一个榜单的海报。
  const visibleDetail = detail?.id === selectedBlockId && detail.pagination.page === page ? detail : null;
  const selectedBlock = blocks.find((block) => block.id === selectedBlockId);
  const visibleItemDetail = itemDetail?.block.id === selectedBlockId && itemDetail.item.rank === selectedItemRank
    ? itemDetail : null;
  // 关键变量：只向当前作品传递关联推荐，避免切换榜单时闪现旧海报。
  const visibleRelatedItems = relatedResult?.blockId === selectedBlockId && relatedResult.rank === selectedItemRank
    ? relatedResult.items : [];
  const searchOpen = searchSelection?.blockId === selectedBlockId && searchSelection.rank === selectedItemRank;

  return <div>
    <PageHeader title="影视推荐" actions={<SecondaryButton type="button" disabled={syncing} onClick={() => void syncNow()}>
      <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "正在同步…" : "立即同步"}
    </SecondaryButton>} />
    <p className="mb-3 text-xs text-muted-foreground">云助手定时同步影视榜单，页面显示本地缓存。
      {resource.data?.updatedAt && ` 最近同步：${new Date(resource.data.updatedAt).toLocaleString("zh-CN")}`}</p>
    {syncMessage && <p role="status" className="mb-3 text-sm text-muted-foreground">{syncMessage}</p>}
    {syncError && <p role="alert" className="mb-3 text-sm text-destructive">{syncError}</p>}

    <div role="tablist" aria-label="榜单类型" className="mb-4 flex gap-2 overflow-x-auto border-b border-border pb-3">
      {["全部", ...groups].map((group) => <button key={group} type="button" role="tab" aria-selected={activeGroup === group}
        onClick={() => { setActiveGroup(group); setSelectedBlockId(null); setSelectedItemRank(null); setPage(1); }}
        className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition-colors ${activeGroup === group
          ? "border-border bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
        {group} <span className="text-xs text-muted-foreground">{group === "全部" ? blocks.length : groupCounts.get(group)}</span>
      </button>)}
    </div>

    {resource.error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {resource.error} <button type="button" className="underline" onClick={() => void resource.refresh()}>重试</button>
    </div>}

    {selectedBlockId && selectedItemRank !== null ? <>
      <div className="mb-4"><SecondaryButton type="button" onClick={() => setSelectedItemRank(null)}>
        <ArrowLeft className="size-4" /> 返回{selectedBlock?.title ?? "榜单"}
      </SecondaryButton></div>
      {itemError && <p role="alert" className="mb-3 text-sm text-destructive">{itemError}</p>}
      {itemLoading && !visibleItemDetail && <div className="surface animate-pulse p-5">
        <div className="h-56 w-40 rounded-lg bg-secondary" /><div className="mt-4 h-6 w-56 rounded bg-secondary" /></div>}
      {visibleItemDetail && <MovieDetail detail={visibleItemDetail} related={visibleRelatedItems}
        relatedLoading={relatedLoading} relatedError={relatedError} searchOpen={searchOpen} searchLoading={searchLoading} admin={admin}
        onSearchingChange={setSearchLoading}
        onSearch={() => toggleItemSearch(visibleItemDetail.block.id, visibleItemDetail.item.rank)} />}
    </> : selectedBlockId ? <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SecondaryButton type="button" onClick={() => { setSelectedBlockId(null); setSelectedItemRank(null); setPage(1); }}><ArrowLeft className="size-4" /> 返回榜单</SecondaryButton>
        <div><h2 className="text-lg font-semibold">{selectedBlock?.title ?? "榜单详情"}</h2>
          {selectedBlock?.description && <p className="text-xs text-muted-foreground">{selectedBlock.description}</p>}</div>
      </div>
      {detailError && <p role="alert" className="mb-3 text-sm text-destructive">{detailError}</p>}
      {detailLoading && !visibleDetail && <div className="grid gap-3" style={posterGridStyle}>
        {Array.from({ length: 12 }, (_, index) => <div key={index} className="surface animate-pulse p-2.5">
          <div className="aspect-[2/3] rounded-lg bg-secondary" /><div className="mt-2 h-4 rounded bg-secondary" /></div>)}
      </div>}
      {visibleDetail && <>
        <p className="mb-3 text-xs text-muted-foreground">共 {visibleDetail.pagination.totalItems} 部作品 · 第 {page} / {visibleDetail.pagination.totalPages} 页</p>
        <div className="grid gap-3" style={posterGridStyle}>{visibleDetail.items.map((item) =>
          <MovieCard key={`${item.rank}:${item.tmdbId ?? item.title}`} item={item} onOpen={() => setSelectedItemRank(item.rank)} />)}</div>
        <div className="mt-5 flex justify-center gap-2">
          <SecondaryButton type="button" disabled={page <= 1 || detailLoading} onClick={() => setPage((current) => current - 1)}>上一页</SecondaryButton>
          <SecondaryButton type="button" disabled={page >= visibleDetail.pagination.totalPages || detailLoading}
            onClick={() => setPage((current) => current + 1)}>下一页</SecondaryButton>
        </div>
      </>}
    </> : <>
      {!resource.data && !resource.error && <div className="grid gap-3" style={posterGridStyle}>
        {Array.from({ length: 12 }, (_, index) => <div key={index} className="surface animate-pulse p-2.5">
          <div className="aspect-[2/3] rounded-lg bg-secondary" /><div className="mt-2 h-4 rounded bg-secondary" /></div>)}
      </div>}
      {resource.data && <div className="grid gap-3" style={posterGridStyle}>
        {visibleBlocks.map((block) => <BlockCard key={block.id} block={block}
          onOpen={() => { setSelectedBlockId(block.id); setPage(1); }} />)}
      </div>}
      {resource.data && visibleBlocks.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">当前分类没有榜单</p>}
    </>}
  </div>;
}
