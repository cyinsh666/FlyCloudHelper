import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import type { RecommendationItem } from "@/lib/api";

// 关键变量：横向卡片给封面和文字留出空间，窄屏自动使用一列。
export const recommendationCardGridStyle = { gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 19rem), 1fr))" };

/** 海报缺失或加载失败时保留原有比例。 */
export function RecommendationPoster({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  return <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-secondary">
    {url && !failed ? <img src={url} alt={title} loading="lazy" onError={() => setFailed(true)}
      className="h-full w-full object-cover" />
      : <div className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center text-muted-foreground">
        <Film className="size-7 opacity-50" /><span className="line-clamp-3 text-xs">{title}</span>
      </div>}
  </div>;
}

/** 作品榜单卡片，左边显示海报，右边显示文字信息。 */
export function RecommendationMovieCard({ item, onOpen }: { item: RecommendationItem; onOpen: () => void }) {
  return <button type="button" onClick={onOpen}
    className="surface flex min-w-0 items-start gap-3 p-2.5 text-left transition-colors hover:bg-secondary/50">
    <div className="relative w-[4.5rem] shrink-0 sm:w-20">
      <RecommendationPoster url={item.posterUrl} title={item.title} />
      <span className="absolute top-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white">#{item.rank}</span>
    </div>
    <div className="min-w-0 flex-1 py-1">
      <h3 className="line-clamp-2 text-sm font-medium" title={item.title}>{item.title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {item.scheduleDate ? `${item.mediaType === "tv" ? "下一集" : "上映"} ${item.scheduleDate}`
          : item.releaseDate?.slice(0, 4) || "年份未知"}{item.rating !== null ? ` · 评分 ${item.rating.toFixed(1)}` : ""}
      </p>
      {item.overview && <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground" title={item.overview}>{item.overview}</p>}
    </div>
  </button>;
}

/** 加载时复用横向卡片列宽和海报比例。 */
export function RecommendationMovieSkeleton({ count }: { count: number }) {
  return <div aria-hidden="true" className="grid gap-3" style={recommendationCardGridStyle}>
    {Array.from({ length: count }, (_, index) => <div key={index} className="surface flex animate-pulse gap-3 p-2.5">
      <div className="aspect-[2/3] w-[4.5rem] shrink-0 rounded-lg bg-secondary sm:w-20" />
      <div className="min-w-0 flex-1 space-y-2 pt-2"><div className="h-4 w-3/4 rounded bg-secondary" />
        <div className="h-3 w-1/2 rounded bg-secondary" /><div className="h-3 w-5/6 rounded bg-secondary" /></div>
    </div>)}
  </div>;
}
