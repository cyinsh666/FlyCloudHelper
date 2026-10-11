import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import {
  getContentSourceAutoSync,
  updateContentSourceAutoSync,
  type ContentSourceAutoSync,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

interface AutoSyncSettingsState {
  libraryId: string;
  admin: boolean;
  disabled: boolean;
  refreshVersion: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}

interface AutoSyncDraft {
  enabled: boolean;
  intervalMinutes: string;
}

/** 保留数值输入草稿，清空输入时不会立即替换为零。 */
function scheduleDraft(schedule: ContentSourceAutoSync): AutoSyncDraft {
  return { enabled: schedule.enabled, intervalMinutes: String(schedule.intervalMinutes) };
}

/** 使用本地时间展示调度时间，尚未安排或触发时保留明确说明。 */
function scheduleTime(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN", { hour12: false });
}

/** 编辑内容源自动同步计划，只有保存成功后计划才会生效。 */
export function ContentSourceAutoSyncSettings({ state }: { state: AutoSyncSettingsState }) {
  // 关键变量：提交前后推进版本，旧 GET 不能覆盖保存返回的配置。
  const requestVersionRef = useRef(0);
  const readErrorVersionRef = useRef(0);
  const resource = useApiResource(async () => {
    const version = requestVersionRef.current;
    try {
      return { settings: await getContentSourceAutoSync(state.libraryId, state.admin), version };
    } catch (readError) {
      readErrorVersionRef.current = version;
      throw readError;
    }
  }, [state.libraryId, state.admin, state.refreshVersion]);
  const [confirmed, setConfirmed] = useState<ContentSourceAutoSync | null>(null);
  // 关键变量：默认关闭仅用于草稿，读取页面不会写入或启动计划。
  const [draft, setDraft] = useState<AutoSyncDraft>({ enabled: false, intervalMinutes: "60" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);
  // 关键变量：状态刷新不能覆盖用户尚未保存的草稿。
  const editedRef = useRef(false);
  // 关键变量：只在重新打开时恢复已保存值，读取刷新不会丢弃正在编辑的草稿。
  const previousOpenRef = useRef(false);
  const schedule = confirmed ?? (resource.data?.version === requestVersionRef.current ? resource.data.settings : null);
  const readError = readErrorVersionRef.current === requestVersionRef.current ? resource.error : null;
  const changed = schedule !== null && (
    draft.enabled !== schedule.enabled
    || Number(draft.intervalMinutes) !== schedule.intervalMinutes || draft.intervalMinutes.trim() === ""
  );

  useEffect(() => {
    if (!resource.data || resource.data.version !== requestVersionRef.current || submittingRef.current) return;
    setConfirmed(resource.data.settings);
    if (!editedRef.current) setDraft(scheduleDraft(resource.data.settings));
  }, [resource.data]);

  useEffect(() => {
    const justOpened = state.open && !previousOpenRef.current;
    previousOpenRef.current = state.open;
    if (!justOpened || submittingRef.current) return;
    editedRef.current = false;
    if (schedule) setDraft(scheduleDraft(schedule));
    setError(null);
    setMessage(null);
  }, [state.open, schedule]);

  /** 打开时从已保存计划重建草稿，不沿用上一次取消的编辑。 */
  function openSettings(): void {
    if (submittingRef.current || state.disabled) return;
    editedRef.current = false;
    if (schedule) setDraft(scheduleDraft(schedule));
    setError(null);
    setMessage(null);
    state.onOpen();
  }

  /** 同步检查提交标记，关闭只丢弃草稿，不发送保存请求。 */
  function closeSettings(): void {
    if (submittingRef.current) return;
    editedRef.current = false;
    if (schedule) setDraft(scheduleDraft(schedule));
    setError(null);
    setMessage(null);
    state.onClose();
  }

  /** 手动重新读取计划，保存期间不复用旧 GET 覆盖确认值。 */
  function reloadSettings(): void {
    if (submittingRef.current || resource.loading) return;
    void resource.refresh();
  }

  /** 修改本地草稿，不发送保存请求。 */
  function editDraft(patch: Partial<AutoSyncDraft>): void {
    if (submittingRef.current || state.disabled) return;
    editedRef.current = true;
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setMessage(null);
  }

  /** 校验后保存启用状态与间隔，失败时保留原计划与编辑草稿。 */
  async function saveSchedule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submittingRef.current || resource.loading || state.disabled || !schedule || !changed) return;
    const intervalMinutes = Number(draft.intervalMinutes);
    if (!draft.intervalMinutes.trim() || !Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 10080) {
      setError("同步间隔必须为 10 至 10080 分钟的整数");
      return;
    }
    submittingRef.current = true;
    state.onBusyChange(true);
    requestVersionRef.current += 1;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await updateContentSourceAutoSync(state.libraryId, { enabled: draft.enabled, intervalMinutes }, state.admin);
      requestVersionRef.current += 1;
      setConfirmed(saved);
      setDraft(scheduleDraft(saved));
      editedRef.current = false;
      setMessage(saved.enabled ? "自动同步计划已保存并启用。" : "自动同步计划已保存并关闭。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "自动同步保存失败，请重试");
    } finally {
      submittingRef.current = false;
      setSaving(false);
      state.onBusyChange(false);
    }
  }

  return <>
    <section aria-label="内容源自动同步" className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm">自动同步</p>
          {schedule && <p className="text-xs text-muted-foreground">{schedule.enabled ? "已开启" : "已关闭"} · 每 {schedule.intervalMinutes} 分钟</p>}
          {!schedule && !readError && <div aria-label="自动同步设置加载中" className="h-4 w-40 animate-pulse rounded bg-muted" />}
        </div>
        {readError && <p role="alert" className="mt-1 text-xs text-destructive">读取失败，可打开设置重试</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {readError && <SecondaryButton disabled={resource.loading || saving || state.disabled} onClick={reloadSettings}>重试</SecondaryButton>}
        <SecondaryButton disabled={saving || state.disabled} onClick={openSettings}>设置</SecondaryButton>
      </div>
    </section>
    {state.open && <ContentSourceSettingsDialog state={{
      title: "自动同步设置",
      description: "修改开启状态和同步间隔，保存后生效。",
      busy: saving,
      onClose: closeSettings,
      children: <div className="min-w-0 space-y-4">
        {!schedule && !readError && <div aria-label="自动同步设置加载中" className="animate-pulse space-y-3"><div className="h-8 w-40 rounded bg-muted" /><div className="h-14 rounded bg-muted" /><div className="h-8 w-36 rounded bg-muted" /></div>}
        {readError && <div><p role="alert" className="break-words text-xs text-destructive">{readError}</p><div className="mt-2"><SecondaryButton disabled={resource.loading || saving} onClick={reloadSettings}>重新读取自动同步</SecondaryButton></div></div>}
        {schedule && <form onSubmit={(event) => void saveSchedule(event)} className="grid gap-4">
          <fieldset disabled={saving || resource.loading || state.disabled} className="grid gap-4">
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm">开启自动同步</p><p className="mt-1 text-xs text-muted-foreground">默认关闭，修改后点击保存生效。</p></div><button type="button" role="switch" aria-label="开启内容源自动同步" aria-checked={draft.enabled} onClick={() => editDraft({ enabled: !draft.enabled })} className={`relative h-7 w-12 shrink-0 rounded-full border border-border transition-colors disabled:opacity-40 ${draft.enabled ? "bg-foreground" : "bg-secondary"}`}><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-background transition-transform ${draft.enabled ? "translate-x-5" : "translate-x-0"}`} /></button></div>
            <label><span className="text-xs text-muted-foreground">同步间隔（分钟）</span><input type="number" required min={10} max={10080} step={1} value={draft.intervalMinutes} onChange={(event) => editDraft({ intervalMinutes: event.target.value })} className="mt-1.5 block w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm sm:w-52" /></label>
            <p className="text-xs text-muted-foreground">每次按当前媒体库已选分类，各读取第 1 页；已有作品更新详情和新集，新作品加入目录。作品离开第 1 页后不会被删除。</p>
            <div className="flex flex-wrap gap-2"><PrimaryButton type="submit" disabled={!changed || saving || resource.loading || state.disabled}>{saving ? "正在保存…" : "保存自动同步"}</PrimaryButton><SecondaryButton disabled={saving} onClick={closeSettings}>关闭</SecondaryButton></div>
          </fieldset>
          <div className="grid gap-1 border-t border-border pt-3 text-xs text-muted-foreground"><p>下次运行：{scheduleTime(schedule.nextRunAt, schedule.enabled ? "等待调度" : "未安排")}</p><p>最近触发：{scheduleTime(schedule.lastTriggeredAt, "尚未触发")}</p></div>
          {schedule.lastError && <p role="alert" className="break-words text-xs text-destructive">最近调度失败：{schedule.lastError}</p>}
        </form>}
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      </div>,
    }} />}
  </>;
}
