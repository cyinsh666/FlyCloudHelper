import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { updateServiceProfile, type ServiceDetail } from "@/lib/api";

/** 编辑服务名称和描述，草稿只在保存成功后更新详情页。 */
export function ServiceProfileEditDialog({ service, admin, onClose, onSaved }: {
  service: ServiceDetail;
  admin: boolean;
  onClose: () => void;
  onSaved: (service: ServiceDetail) => void;
}) {
  const [displayName, setDisplayName] = useState(service.displayName);
  const [description, setDescription] = useState(service.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：提交期间同步阻止重复保存、Esc 和背景点击关闭。
  const savingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    nameInputRef.current?.focus();
    /** Esc 关闭草稿；保存期间等待接口完成。 */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !savingRef.current) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [onClose]);

  /** 放弃本次未保存的草稿。 */
  function close(): void {
    if (!savingRef.current) onClose();
  }

  /** 保存服务资料，描述可以清空，名称不能为空。 */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current) return;
    if (!displayName.trim()) {
      setError("服务名称不能为空");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateServiceProfile(service.id, {
        displayName: displayName.trim(),
        description: description.trim(),
        expectedUpdatedAt: service.updatedAt,
      }, admin);
      onSaved(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "服务资料保存失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <button type="button" aria-label="关闭编辑服务" onClick={close} disabled={saving} className="absolute inset-0 bg-black/70" />
      <section role="dialog" aria-modal="true" aria-labelledby="service-profile-edit-title" className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl">
        <header className="mb-5 flex items-center justify-between gap-3">
          <h2 id="service-profile-edit-title" className="text-lg font-semibold">编辑服务</h2>
          <button type="button" aria-label="关闭编辑服务" onClick={close} disabled={saving} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-40"><X className="size-4" /></button>
        </header>
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <label className="block"><span className="text-xs text-muted-foreground">服务名称</span><input ref={nameInputRef} value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100} disabled={saving} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <label className="block"><span className="text-xs text-muted-foreground">服务描述（选填）</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={500} disabled={saving} placeholder="填写服务用途或备注" className="mt-2 w-full resize-y rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <footer className="flex justify-end gap-2"><SecondaryButton onClick={close} disabled={saving}>取消</SecondaryButton><PrimaryButton type="submit" disabled={saving || !displayName.trim()}>{saving ? "保存中…" : "保存"}</PrimaryButton></footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
