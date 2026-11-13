import { Panel } from "@/components/ui-kit";
import type { WashPriority } from "@/lib/api";

const options: Array<{ value: WashPriority; label: string; description: string }> = [
  { value: "dv", label: "DV", description: "优先明确标注 DV、DoVi、Dolby Vision 的版本" },
  { value: "hdr", label: "HDR", description: "优先明确标注 HDR、HDR10、HDR10+ 的版本" },
  { value: "bitrate", label: "高码率", description: "比较名称中的码率数字，或明确的高码率标记" },
  { value: "frame_rate", label: "高帧率", description: "比较名称中的帧率数字，或明确的高帧率标记" },
  { value: "resolution", label: "高分辨率", description: "比较明确的 4K、2160P、1080P 等清晰度标记" },
  { value: "data_saving", label: "省流", description: "优先省流、小体积标记；码率都明确时优先较低值" },
];

/** 洗版设置只修改当前整理表单，修改后由父页面使旧预览失效。 */
export function ServiceOrganizeWash({ state }: { state: {
  enabled: boolean; priorities: WashPriority[];
  onChange: (enabled: boolean, priorities: WashPriority[]) => void;
} }) {
  /** 勾选后排到末尾，至少保留一个优先项。 */
  function toggle(priority: WashPriority): void {
    const selected = state.priorities.includes(priority);
    if (selected && state.priorities.length === 1) return;
    state.onChange(state.enabled, selected ? state.priorities.filter((item) => item !== priority) : [...state.priorities, priority]);
  }

  /** 上下移动只交换相邻优先项，其他选项顺序保持不变。 */
  function move(index: number, direction: number): void {
    const destination = index + direction;
    if (destination < 0 || destination >= state.priorities.length) return;
    const next = [...state.priorities];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    state.onChange(state.enabled, next);
  }

  const ordered = [...state.priorities.map((key) => options.find((option) => option.value === key)!),
    ...options.filter((option) => !state.priorities.includes(option.value))];
  return <Panel title="洗版" description="开启后，本次涉及的电影及单集在整理目标中只保留一份。只根据名称判断版本，无法判断或同档时保留已有视频。">
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">启用洗版</span>
      <button type="button" role="switch" aria-label="启用洗版" aria-checked={state.enabled}
        onClick={() => state.onChange(!state.enabled, state.priorities.length ? state.priorities : ["resolution"])}
        className={`relative h-7 w-12 shrink-0 rounded-full border border-border transition-colors ${state.enabled ? "bg-foreground" : "bg-secondary"}`}>
        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-background transition-transform ${state.enabled ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </div>
    {state.enabled && <div className="mt-4 space-y-2">
      <p className="text-xs text-muted-foreground">保留版本优先级：勾选后按从上到下比较，可使用上下按钮调整顺序。</p>
      {ordered.map((option) => {
        const index = state.priorities.indexOf(option.value);
        return <div key={option.value} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" checked={index >= 0} disabled={index >= 0 && state.priorities.length === 1}
              onChange={() => toggle(option.value)} />
            <span className="min-w-0"><span>{index >= 0 ? `${index + 1}. ` : ""}{option.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span></span>
          </label>
          {index >= 0 && <div className="flex shrink-0 gap-1">
            <button type="button" aria-label={`上移${option.label}`} disabled={index === 0} onClick={() => move(index, -1)}
              className="rounded border px-2 py-1 text-sm disabled:opacity-30">↑</button>
            <button type="button" aria-label={`下移${option.label}`} disabled={index === state.priorities.length - 1} onClick={() => move(index, 1)}
              className="rounded border px-2 py-1 text-sm disabled:opacity-30">↓</button>
          </div>}
        </div>;
      })}
      <p className="text-xs text-muted-foreground">保留版本核验成功后才清理目标旧版本；未选中的来源文件保留，不转入未识别目录。</p>
    </div>}
  </Panel>;
}
