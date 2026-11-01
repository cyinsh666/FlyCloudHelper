import { Play, Save } from "lucide-react";
import { useState } from "react";
import { PrimaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import { runServiceOrganizeNow, updateServiceOrganizeSchedule, type OrganizeSchedule, type ProviderDirectory,
  type ScanScheduleType } from "@/lib/api";

type IntervalUnit = "minute" | "hour" | "day";

interface ScheduleForm {
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string;
  quietEndTime: string;
}

const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const fieldClass = "mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm";

/** 将服务端分钟间隔映射为媒体库定时扫描相同的数值与单位。 */
function readInterval(minutes: number | null): { value: number; unit: IntervalUnit } {
  const safe = Math.max(5, minutes ?? 1440);
  if (safe % 1440 === 0) return { value: safe / 1440, unit: "day" };
  if (safe % 60 === 0) return { value: safe / 60, unit: "hour" };
  return { value: safe, unit: "minute" };
}

/** 仅当服务端计划变化时重置编辑表单。 */
function readForm(schedule: OrganizeSchedule): ScheduleForm {
  const interval = readInterval(schedule.intervalMinutes);
  return { enabled: schedule.enabled, scheduleType: schedule.scheduleType, intervalValue: interval.value,
    intervalUnit: interval.unit, timeOfDay: schedule.timeOfDay ?? "03:00", dayOfWeek: schedule.dayOfWeek ?? 1,
    dayOfMonth: schedule.dayOfMonth ?? 1, quietPeriodEnabled: schedule.quietPeriodEnabled,
    quietStartTime: schedule.quietStartTime ?? "00:00", quietEndTime: schedule.quietEndTime ?? "07:00" };
}

/** 日期只在浏览器展示时格式化，不改变服务端保存的时区。 */
function showTime(value: string | null): string { return value ? new Date(value).toLocaleString("zh-CN") : "暂无"; }

/** 与媒体库扫描一致的整理定时任务编辑卡片。 */
export function ServiceOrganizeSchedule({ serviceId, admin, schedule, sources, target, mode,
  unrecognizedTransferEnabled, unrecognizedDirectory, aiAssistEnabled, aiModelId, activeJob, onSaved }: {
  serviceId: string;
  admin: boolean;
  schedule: OrganizeSchedule;
  sources: ProviderDirectory[];
  target: ProviderDirectory | null;
  mode: "move" | "copy";
  unrecognizedTransferEnabled: boolean;
  unrecognizedDirectory: ProviderDirectory | null;
  aiAssistEnabled: boolean;
  aiModelId: string;
  activeJob: boolean;
  onSaved: (next: OrganizeSchedule) => void;
}) {
  const [form, setForm] = useState<ScheduleForm>(() => readForm(schedule));
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** 保存来源、目标及周期；后台会在下次时间先识别再执行。 */
  async function save(): Promise<void> {
    if (saving) return;
    if (form.enabled && (sources.length === 0 || !target)) { setMessage("请先选择来源目录和目标目录"); return; }
    if (unrecognizedTransferEnabled && !unrecognizedDirectory) {
      setMessage("请先选择未识别转移目录"); return;
    }
    if (aiAssistEnabled && !aiModelId) { setMessage("请先选择 AI 模型"); return; }
    if (form.quietPeriodEnabled && form.quietStartTime === form.quietEndTime) {
      setMessage("暂停开始和结束时间不能相同"); return;
    }
    setSaving(true);
    setMessage("正在保存定时任务…");
    try {
      const minutes = form.intervalValue * (form.intervalUnit === "day" ? 1440 : form.intervalUnit === "hour" ? 60 : 1);
      const next = await updateServiceOrganizeSchedule(serviceId, {
        enabled: form.enabled, scheduleType: form.scheduleType, intervalMinutes: minutes,
        timeOfDay: form.timeOfDay, dayOfWeek: form.dayOfWeek, dayOfMonth: form.dayOfMonth,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(), quietPeriodEnabled: form.quietPeriodEnabled,
        quietStartTime: form.quietStartTime, quietEndTime: form.quietEndTime,
        sources, target, mode, unrecognizedTransferEnabled, unrecognizedDirectory,
        aiAssistEnabled, aiModelId: aiAssistEnabled ? aiModelId : null,
      }, admin);
      onSaved(next);
      setMessage("整理计划已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "整理计划保存失败"); }
    finally { setSaving(false); }
  }

  /** 只使用已保存的目录与选项执行，避免未保存表单与后台任务配置不一致。 */
  async function runNow(): Promise<void> {
    if (starting || saving) return;
    setStarting(true);
    setMessage("正在启动整理…");
    try {
      const next = await runServiceOrganizeNow(serviceId, admin);
      onSaved(next);
      setMessage("已开始识别，完成后自动整理");
    } catch (error) { setMessage(error instanceof Error ? error.message : "启动整理失败"); }
    finally { setStarting(false); }
  }

  return <Panel title="影片整理定时任务" description="到点后自动识别来源目录，并整理可确认的影片；手动预览和执行不受暂停时段影响。">
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 p-4">
      <div><p className="text-sm font-medium">启用计划</p><p className="mt-1 text-xs text-muted-foreground">关闭后保留配置，但不会创建后台任务。</p></div>
      <button type="button" role="switch" aria-checked={form.enabled} onClick={() => setForm((old) => ({ ...old, enabled: !old.enabled }))}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${form.enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${form.enabled ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </div>
    <label className="mt-4 block"><span className="text-xs text-muted-foreground">执行方式</span>
      <select className={fieldClass} value={form.scheduleType} onChange={(event) => setForm((old) => ({ ...old, scheduleType: event.target.value as ScanScheduleType }))}>
        <option value="interval">按间隔时间执行</option><option value="daily">每天指定时间</option>
        <option value="weekly">每周指定时间</option><option value="monthly">每月指定时间</option>
      </select>
    </label>
    {form.scheduleType === "interval" ? <div className="mt-4 grid grid-cols-[minmax(0,1fr)_140px] gap-3">
      <label><span className="text-xs text-muted-foreground">间隔数值</span><input className={fieldClass} type="number" min={1} value={form.intervalValue}
        onChange={(event) => setForm((old) => ({ ...old, intervalValue: Math.max(1, Number(event.target.value) || 1) }))} /></label>
      <label><span className="text-xs text-muted-foreground">单位</span><select className={fieldClass} value={form.intervalUnit}
        onChange={(event) => setForm((old) => ({ ...old, intervalUnit: event.target.value as IntervalUnit }))}>
        <option value="minute">分钟</option><option value="hour">小时</option><option value="day">天</option>
      </select></label>
    </div> : <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {form.scheduleType === "weekly" && <label><span className="text-xs text-muted-foreground">每周日期</span>
        <select className={fieldClass} value={form.dayOfWeek} onChange={(event) => setForm((old) => ({ ...old, dayOfWeek: Number(event.target.value) }))}>
          {weekDays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
        </select></label>}
      {form.scheduleType === "monthly" && <label><span className="text-xs text-muted-foreground">每月日期</span>
        <input className={fieldClass} type="number" min={1} max={31} value={form.dayOfMonth}
          onChange={(event) => setForm((old) => ({ ...old, dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)) }))} /></label>}
      <label><span className="text-xs text-muted-foreground">指定时间</span><input className={fieldClass} type="time" value={form.timeOfDay}
        onChange={(event) => setForm((old) => ({ ...old, timeOfDay: event.target.value }))} /></label>
    </div>}
    <div className="mt-4 rounded-xl border border-border bg-secondary/40 p-4">
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">每日暂停整理时段</p>
        <p className="mt-1 text-xs text-muted-foreground">只顺延自动任务；手动操作和正在运行的任务不受影响。</p></div>
        <button type="button" role="switch" aria-checked={form.quietPeriodEnabled}
          onClick={() => setForm((old) => ({ ...old, quietPeriodEnabled: !old.quietPeriodEnabled }))}
          className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${form.quietPeriodEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${form.quietPeriodEnabled ? "translate-x-5" : "translate-x-0"}`} />
        </button></div>
      {form.quietPeriodEnabled && <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label><span className="text-xs text-muted-foreground">开始时间</span><input className={fieldClass} type="time" value={form.quietStartTime}
          onChange={(event) => setForm((old) => ({ ...old, quietStartTime: event.target.value }))} /></label>
        <label><span className="text-xs text-muted-foreground">结束时间</span><input className={fieldClass} type="time" value={form.quietEndTime}
          onChange={(event) => setForm((old) => ({ ...old, quietEndTime: event.target.value }))} /></label>
        <p className="text-xs text-muted-foreground sm:col-span-2">{form.quietStartTime > form.quietEndTime ? "当前时间段跨越零点。" : "每天在该时间段内不启动自动任务。"}</p>
      </div>}
    </div>
    <div className="mt-4 grid gap-2 rounded-xl border border-border bg-secondary/30 p-4 text-xs text-muted-foreground sm:grid-cols-2">
      <p>执行时区：UTC{(() => { const offset = -new Date().getTimezoneOffset(); return `${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`; })()}</p>
      <p>下次执行：{showTime(schedule.nextRunAt)}</p><p>最近触发：{showTime(schedule.lastTriggeredAt)}</p>
      <p>最近任务：{schedule.lastJobId ?? "暂无"}</p>
      {schedule.pendingPlanId && <p className="sm:col-span-2">正在识别，完成后自动整理</p>}
      {!schedule.pendingPlanId && schedule.lastRunMessage && <p className="sm:col-span-2">最近结果：{schedule.lastRunMessage}</p>}
      {schedule.lastError && <p className="sm:col-span-2 text-destructive">最近错误：{schedule.lastError}</p>}
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton disabled={saving || starting} onClick={() => void save()}><Save className="size-4" />{saving ? "正在保存…" : "保存计划"}</PrimaryButton>
      <PrimaryButton disabled={saving || starting || activeJob || Boolean(schedule.pendingPlanId) || !schedule.sources.length || !schedule.target}
        onClick={() => void runNow()}><Play className="size-4" />{starting ? "正在启动…" : "立即执行整理"}</PrimaryButton>
      <span className="text-xs text-muted-foreground">使用已保存的目录和选项；不受暂停时段影响。</span>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}</div>
  </Panel>;
}
