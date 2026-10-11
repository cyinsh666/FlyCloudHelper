import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import {
  listContentSourceLibraryCategories,
  updateContentSourceLibraryCategories,
  type ContentSourceCategory,
} from "@/lib/content-source-api";

/** 分类编辑与父面板共享操作锁，避免和同步、源启停同时提交。 */
interface CategoriesEditorState {
  libraryId: string;
  admin: boolean;
  selectedIds: string[];
  selectedCategories: ContentSourceCategory[];
  disabled: boolean;
  pendingBatch: boolean;
  beginOperation: () => boolean;
  endOperation: () => void;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}

/** 弹窗内编辑在线库分类，取消仅丢弃草稿，保存不会自动启动同步。 */
export function ContentSourceLibraryCategoriesEditor({ state }: { state: CategoriesEditorState }) {
  const [categories, setCategories] = useState<ContentSourceCategory[] | null>(null);
  const [draftIds, setDraftIds] = useState<string[]>([...state.selectedIds]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：组件关闭或重新加载后，过期分类响应不能覆盖当前草稿。
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const selectedSet = new Set(state.selectedIds);
  const draftSet = new Set(draftIds);
  const changed = selectedSet.size !== draftSet.size || draftIds.some((id) => !selectedSet.has(id));
  const blocked = state.disabled || loading || saving;
  // 原来已选但当前源站不可用的分类继续展示，允许用户主动取消。
  const unavailableIds = categories === null ? [] : state.selectedIds.filter((id) => !categories.some((category) => category.id === id));

  useEffect(() => {
    mounted.current = true;
    void readCategories();
    return () => { mounted.current = false; };
  }, [state.libraryId, state.admin]);

  /** 读取所有可用视频叶分类；重试只更新分类列表，不重置选择草稿。 */
  async function readCategories(): Promise<void> {
    if (state.disabled || loading || saving || !state.beginOperation()) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listContentSourceLibraryCategories(state.libraryId, state.admin);
      if (mounted.current && requestVersion.current === version) setCategories(result.items);
    } catch (loadError) {
      if (mounted.current && requestVersion.current === version) setError(loadError instanceof Error ? loadError.message : "分类读取失败");
    } finally {
      state.endOperation();
      if (mounted.current && requestVersion.current === version) setLoading(false);
    }
  }

  /** 在草稿中切换一个可用分类，原有目录数据不会随选择变化。 */
  function toggleCategory(id: string): void {
    if (blocked) return;
    setDraftIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  /** 全选仅包含当前可选叶分类，取消全选同时移除不可用的旧分类。 */
  function selectAll(selected: boolean): void {
    if (blocked || categories === null) return;
    setDraftIds(selected ? categories.map((category) => category.id) : []);
  }

  /** 保存实际分类修改；服务端保留历史进度并结束原未完成批次。 */
  async function saveCategories(): Promise<void> {
    if (blocked || categories === null || !changed) return;
    if (draftIds.length === 0) {
      setError("请至少选择一个分类");
      return;
    }
    if (!state.beginOperation()) return;
    setSaving(true);
    setError(null);
    try {
      await updateContentSourceLibraryCategories(state.libraryId, draftIds, state.admin);
      await state.onSaved();
    } catch (saveError) {
      if (mounted.current) setError(saveError instanceof Error ? saveError.message : "分类保存失败");
    } finally {
      // 保存成功后父弹窗可能已关闭，操作锁仍须无条件释放。
      state.endOperation();
      if (mounted.current) setSaving(false);
    }
  }

  return <div className="grid gap-3">
    {(loading || categories === null && error === null && !state.disabled) && <div aria-label="在线分类加载中" className="grid animate-pulse gap-2 sm:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="h-10 rounded bg-muted" />)}</div>}
    {error && <div><p role="alert" className="text-sm text-destructive">{error}</p>{categories === null && <div className="mt-2"><SecondaryButton disabled={blocked} onClick={() => void readCategories()}>重新读取分类</SecondaryButton></div>}</div>}
    {categories !== null && !loading && <>
      <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">已选 {draftIds.length} 个分类</span><SecondaryButton disabled={blocked} onClick={() => selectAll(true)}>全选</SecondaryButton><SecondaryButton disabled={blocked} onClick={() => selectAll(false)}>取消全选</SecondaryButton></div>
      <div className="grid gap-2 sm:grid-cols-3">{categories.map((category) => <button key={category.id} type="button" aria-pressed={draftSet.has(category.id)} disabled={blocked} onClick={() => toggleCategory(category.id)} className={`rounded-lg border px-3 py-2.5 text-left text-sm disabled:opacity-60 ${draftSet.has(category.id) ? "border-foreground" : "border-border"}`}>{category.name}</button>)}</div>
      {categories.length === 0 && <p className="text-xs text-muted-foreground">当前源没有可选择的视频分类。</p>}
      {unavailableIds.length > 0 && <div><p className="mb-2 text-xs text-muted-foreground">以下原分类当前已不可用，可取消选择后保存。</p><div className="grid gap-2 sm:grid-cols-3">{unavailableIds.map((id) => <button key={id} type="button" aria-pressed={draftSet.has(id)} disabled={blocked || !draftSet.has(id)} onClick={() => toggleCategory(id)} className={`rounded-lg border px-3 py-2.5 text-left text-sm disabled:opacity-60 ${draftSet.has(id) ? "border-foreground" : "border-border"}`}>{state.selectedCategories.find((category) => category.id === id)?.name ?? id}<span className="mt-1 block text-xs text-muted-foreground">{draftSet.has(id) ? "不可用 · 点击取消" : "已取消"}</span></button>)}</div></div>}
      <div className="flex flex-wrap gap-2"><PrimaryButton disabled={blocked || !changed || draftIds.length === 0} onClick={() => void saveCategories()}>{saving ? "正在保存…" : "保存分类"}</PrimaryButton><SecondaryButton disabled={loading || saving} onClick={state.onCancel}>取消</SecondaryButton></div>
    </>}
    {state.disabled && <p className="text-xs text-muted-foreground">同步运行中或内容源已停用，暂时不能修改分类。</p>}
    {state.pendingBatch && <p className="text-xs text-muted-foreground">保存分类修改会结束未完成批次，下次按新分类和当前进度同步。</p>}
    <p className="text-xs text-muted-foreground">保存只更新分类选择，不自动同步。原有媒体和观看记录保留；新分类从第 1 页开始，曾选分类沿用已有进度。</p>
  </div>;
}
