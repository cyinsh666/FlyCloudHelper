import { useRef, useState } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import {
  getContentSourcePlaybackModes,
  updateContentSourcePlaybackMode,
  type ContentSourcePlaybackMode,
  type ContentSourcePlaybackModes,
  type ContentSourcePlaybackProtocol,
} from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

interface PlaybackModeSettingsState {
  libraryId: string;
  admin: boolean;
  protocol: ContentSourcePlaybackProtocol;
}

// 关键变量：使用协议播放模式枚举，不能把旧网盘中转开关当作在线源模式。
const playbackOptions: Array<{ mode: ContentSourcePlaybackMode; label: string }> = [
  { mode: "auto", label: "自动" },
  { mode: "direct", label: "直连" },
  { mode: "relay", label: "中转" },
];

/** 管理一个协议的在线播放模式，选择后立即保存，只有服务端成功响应才更新选中项。 */
export function ContentSourcePlaybackModeSettings({ state }: { state: PlaybackModeSettingsState }) {
  const resource = useApiResource(() => getContentSourcePlaybackModes(state.libraryId, state.admin), [state.libraryId, state.admin]);
  // 关键变量：保存响应是当前已确认模式；请求失败时仍显示之前确认的选中项。
  const [confirmedModes, setConfirmedModes] = useState<ContentSourcePlaybackModes | null>(null);
  const [savingMode, setSavingMode] = useState<ContentSourcePlaybackMode | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：同步拦截连续点击，避免 React 重绘前提交多个模式修改。
  const submittingRef = useRef(false);
  const modes = confirmedModes ?? resource.data;
  const selectedMode = modes?.[state.protocol];
  const protocolName = state.protocol === "jellyfin" ? "Jellyfin" : "Emby";

  /** 保存当前协议的模式，直接使用完整响应，不提前显示尚未成功的选择。 */
  async function saveMode(mode: ContentSourcePlaybackMode): Promise<void> {
    if (submittingRef.current || resource.loading || !modes || selectedMode === mode) return;
    submittingRef.current = true;
    setSavingMode(mode);
    setSaveError(null);
    setMessage(null);
    try {
      const saved = await updateContentSourcePlaybackMode(state.libraryId, state.protocol, mode, state.admin);
      setConfirmedModes(saved);
      const label = playbackOptions.find((option) => option.mode === saved[state.protocol])?.label ?? "自动";
      setMessage(`${protocolName} 播放模式已保存为${label}。`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "播放模式保存失败，请重试");
    } finally {
      submittingRef.current = false;
      setSavingMode(null);
    }
  }

  return <div className="rounded-lg border border-border bg-secondary/35 px-3 py-2.5">
    <p className="text-sm">播放模式</p>
    {!modes && !resource.error && <div aria-label={`${protocolName} 播放模式加载中`} className="mt-3 animate-pulse space-y-2"><div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((index) => <div key={index} className="h-9 rounded-lg bg-muted" />)}</div><div className="h-3 rounded bg-muted" /><div className="h-3 w-4/5 rounded bg-muted" /></div>}
    {resource.error && <div className="mt-2"><p role="alert" className="text-xs text-destructive">{resource.error}</p><div className="mt-2"><SecondaryButton disabled={resource.loading || savingMode !== null} onClick={() => void resource.refresh()}>重新读取播放模式</SecondaryButton></div></div>}
    {modes && <div role="group" aria-label={`${protocolName} 在线播放模式`} className="mt-3 grid grid-cols-3 gap-2">{playbackOptions.map((option) => <button key={option.mode} type="button" aria-pressed={selectedMode === option.mode} disabled={resource.loading || savingMode !== null} onClick={() => void saveMode(option.mode)} className={`rounded-lg border px-2 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${selectedMode === option.mode ? "border-foreground" : "border-border"}`}>{savingMode === option.mode ? "保存中…" : option.label}</button>)}</div>}
    <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
      <p>自动（默认）：优先直连，不满足直连条件时由云助手中转。</p>
      <p>直连：客户端访问源站；播放失败时请改为自动或中转。</p>
      <p>中转：由云助手获取并转发媒体。</p>
      <p>Jellyfin 和 Emby 分别保存，当前不提供完整影片下载。</p>
    </div>
    {saveError && <p role="alert" className="mt-2 text-xs text-destructive">{saveError}</p>}
    {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
  </div>;
}
