import { useRef, useState, type FormEvent } from "react";
import { PrimaryButton } from "@/components/ConsoleShell";
import { getContentMusicLibrary, updateContentMusicLibrary, type ContentSourcePlaybackMode } from "@/lib/content-source-api";
import { useApiResource } from "@/lib/use-api-resource";

/** 音乐协议页单独管理源传输模式，不读取或覆盖网盘中转偏好。 */
export function ContentMusicPlaybackModeSettings({ state }: { state: { libraryId: string; admin: boolean } }) {
  const resource = useApiResource(() => getContentMusicLibrary(state.libraryId, state.admin), [state.libraryId, state.admin]);
  const [draftMode, setDraftMode] = useState<ContentSourcePlaybackMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：同一次模式保存只允许一个请求。
  const busyRef = useRef(false);

  /** 仅提交播放模式，避免覆盖其他页面刚保存的专辑或歌单配置。 */
  async function saveMode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!resource.data || !draftMode || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateContentMusicLibrary(state.libraryId, { playbackMode: draftMode }, state.admin);
      await resource.refresh();
      setDraftMode(null);
      setMessage("Navidrome 播放模式已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "播放模式保存失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!resource.data) return resource.error ? <p role="alert" className="text-xs text-destructive">{resource.error}</p>
    : <div aria-label="播放模式加载中" className="animate-pulse space-y-3"><div className="h-5 w-40 rounded bg-muted" /><div className="h-10 rounded bg-muted" /></div>;
  return <form onSubmit={(event) => void saveMode(event)} className="grid gap-3">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><label className="min-w-0 flex-1"><span className="sr-only">Navidrome 播放模式</span><select disabled={busy} value={draftMode ?? resource.data.configuration.playbackMode} onChange={(event) => setDraftMode(event.target.value as ContentSourcePlaybackMode)} className="w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm"><option value="auto">自动</option><option value="direct">直连</option><option value="relay">中转</option></select></label><PrimaryButton type="submit" disabled={busy || draftMode === null}>{busy ? "正在保存…" : "保存模式"}</PrimaryButton></div>
    <p className="text-xs text-muted-foreground">自动模式优先直连，无法取得可用直连地址时由云助手中转；音频原样提供，不转码。</p>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </form>;
}
