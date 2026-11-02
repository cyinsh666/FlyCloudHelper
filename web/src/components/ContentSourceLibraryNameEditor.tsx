import { Pencil } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { updateContentLibraryName } from "@/lib/api";

/** 媒体库标题和资料弹窗所需的当前页面状态。 */
interface ContentSourceLibraryNameEditorState {
  libraryId: string;
  displayName: string;
  description: string;
  admin: boolean;
  loading: boolean;
  onSaved: () => Promise<void>;
}

/** 编辑媒体库名称和备注，保存成功后刷新当前设置页。 */
export function ContentSourceLibraryNameEditor({ state }: { state: ContentSourceLibraryNameEditorState }) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：立即占用保存操作，避免重复点击或回车发起多次提交。
  const savingRef = useRef(false);

  /** 打开弹窗时读取最新库资料，取消过的草稿不会再次带入。 */
  function openEditor(): void {
    if (savingRef.current || state.loading) return;
    setDisplayName(state.displayName);
    setDescription(state.description);
    setError(null);
    setOpen(true);
  }

  /** 保存期间保留弹窗，普通关闭只丢弃未提交的草稿。 */
  function closeEditor(): void {
    if (!savingRef.current) setOpen(false);
  }

  /** 保存库名称和备注，成功后刷新当前页面。 */
  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current) return;
    const name = displayName.trim();
    if (!name) {
      setError("媒体库名称不能为空");
      return;
    }
    if ([...name].length > 100) {
      setError("媒体库名称长度不能超过 100 个字符");
      return;
    }
    if ([...description.trim()].length > 500) {
      setError("媒体库备注不能超过 500 个字符");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await updateContentLibraryName(state.libraryId, name, description, state.admin);
      await state.onSaved();
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "媒体库资料保存失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <>
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">{state.displayName} · 媒体库设置</h1>
        <button type="button" aria-label="修改媒体库名称和备注" title="修改名称和备注" disabled={state.loading || saving} onClick={openEditor} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"><Pencil aria-hidden="true" className="size-4" /></button>
      </div>
      {state.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{state.description}</p>}
    </div>
    {open && <ContentSourceSettingsDialog state={{ title: "修改媒体库名称和备注", busy: saving, onClose: closeEditor, children: <form onSubmit={(event) => void saveProfile(event)} className="grid gap-4">
      <label><span className="text-xs text-muted-foreground">媒体库名称</span><input required maxLength={100} disabled={saving} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label>
      <label><span className="text-xs text-muted-foreground">备注（可选）</span><textarea rows={3} maxLength={500} disabled={saving} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="填写媒体库用途或内容说明" className="mt-2 w-full resize-y rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm" /></label>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><SecondaryButton disabled={saving} onClick={closeEditor}>取消</SecondaryButton><PrimaryButton type="submit" disabled={saving || !displayName.trim()}>{saving ? "正在保存…" : "保存"}</PrimaryButton></div>
    </form> }} />}
  </>;
}
