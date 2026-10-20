import { useCallback, useEffect, useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import type { ApiResourceState } from "@/lib/use-api-resource";

/** 本页切换游标或库范围时按请求代次接收结果，旧响应不能覆盖新范围。 */
export function useNativeResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[]): ApiResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  /** 保存之后重新请求，不能把保存前仍在执行的请求作为最新结果。 */
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current; setLoading(true); setError(null);
    try { const value = await loader(); if (generation.current === current) setData(value); }
    catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : "请求失败"); }
    finally { if (generation.current === current) setLoading(false); }
  }, dependencies);
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]);
  return { data, loading, error, refresh };
}

/** 原生听书页专用分页状态，上一页只保存已取得的有限游标。 */
export function useNativeCursor() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  /** 向下一页推进，保留当前页定位供返回。 */
  function next(value: string | null): void { if (value) { setPrevious((items) => [...items, cursor]); setCursor(value); } }
  /** 返回已访问的上一页，不在浏览器展开全部账号。 */
  function back(): void { if (previous.length) { setCursor(previous.at(-1) ?? null); setPrevious((items) => items.slice(0, -1)); } }
  /** 新建或删除后回到第一页，避免停在已不存在的尾页。 */
  function reset(): void { setCursor(null); setPrevious([]); }
  return { cursor, page: previous.length + 1, next, back, reset };
}

/** 分页控件保持紧凑，未知总数不显示虚假的页数。 */
export function NativePager({ state }: { state: { page: number; hasNext: boolean; loading: boolean; onPrevious: () => void; onNext: () => void } }) {
  return <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><span className="mr-1 text-xs text-muted-foreground">第 {state.page} 页</span><SecondaryButton disabled={state.loading || state.page <= 1} onClick={state.onPrevious}>上一页</SecondaryButton><SecondaryButton disabled={state.loading || !state.hasNext} onClick={state.onNext}>下一页</SecondaryButton></div>;
}

/** 配置页开关沿用协议设置中的滑动样式。 */
export function NativeToggle({ state }: { state: { label: string; description?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void } }) {
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/35 px-3 py-2.5"><div className="min-w-0"><p className="text-sm font-medium">{state.label}</p>{state.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{state.description}</p>}</div><button type="button" role="switch" aria-label={state.label} aria-checked={state.checked} disabled={state.disabled} onClick={() => state.onChange(!state.checked)} className={`relative h-7 w-12 shrink-0 rounded-full border disabled:opacity-40 ${state.checked ? "border-primary bg-primary" : "border-border bg-secondary"}`}><span className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform ${state.checked ? "translate-x-5" : ""}`} /></button></div>;
}

/** 初始加载使用骨架，不在旧数据刷新时清空整个面板。 */
export function NativeSkeleton() { return <div aria-label="听书配置加载中" className="animate-pulse space-y-2">{[0, 1, 2].map((item) => <div key={item} className="h-12 rounded-lg bg-muted" />)}</div>; }

/** 明确点击复制时才触碰剪贴板，普通 HTTP 页面仍可操作。 */
export async function copyNativeText(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const input = document.createElement("textarea"); input.value = value; input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select();
    const copied = document.execCommand("copy"); input.remove(); if (!copied) throw new Error("复制失败，请手动复制");
  }
}
