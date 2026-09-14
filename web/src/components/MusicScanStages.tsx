import { useEffect, useState } from "react";
import { listMusicStageTasks, type MusicStageTask } from "../lib/api";

interface Stage {
  stage: "directory" | "file" | "online";
  total: number; pending: number; running: number; succeeded: number;
  failed: number; skipped: number; unmatched: number; closed: boolean;
  currentPath?: string; effectiveConcurrency?: number;
}

/** 父任务快照展示阶段进度，失败明细另行分页，旧任务不伪造三阶段。 */
export function MusicScanStages({ stages, jobId, admin, retryEnabled, onRetry }: { stages: unknown; jobId: string; admin: boolean; retryEnabled: boolean; onRetry: (stage: string) => void }) {
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ items: MusicStageTask[]; total: number }>({ items: [], total: 0 });
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const entries = Array.isArray(stages) ? stages as Stage[] : [];
  const revision = entries.map((stage) => `${stage.failed}:${stage.unmatched}`).join(";");
  useEffect(() => { setSelected(""); setOffset(0); }, [jobId]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setMessage("");
    void listMusicStageTasks(jobId, selected, offset, admin).then((data) => {
      if (!cancelled) setResult(data);
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "明细读取失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, selected, offset, admin, revision]);
  if (!entries.length) return null;
  const names = { directory: "发现目录和文件", file: "读取文件资料", online: "在线补全" };
  return <div className="mt-5 space-y-3">
    <div className="grid gap-3 lg:grid-cols-3">{entries.filter((stage) => stage.stage in names).map((stage) => {
      const done = stage.succeeded + stage.failed + stage.skipped + stage.unmatched;
      return <section key={stage.stage} className="rounded-xl border border-border bg-background/40 p-4">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{names[stage.stage]}</h3><span className="text-xs text-muted-foreground">{stage.closed ? stage.failed ? "结束，有失败" : "已结束" : stage.running ? "处理中" : "等待中"}</span></div>
        <p className="mt-3 text-sm">{done} / {stage.total}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-foreground/70" style={{ width: `${stage.total ? Math.min(100, done / stage.total * 100) : 0}%` }} /></div>
        <p className="mt-3 text-xs leading-6 text-muted-foreground">等待 {stage.pending} · 运行 {stage.running} · 成功 {stage.succeeded}<br />失败 {stage.failed} · 跳过 {stage.skipped} · 未匹配 {stage.unmatched}</p>
        <p className="mt-2 text-xs text-muted-foreground">并发上限 {stage.effectiveConcurrency ?? "—"}，受共享预算和上游限流约束</p>
        {stage.currentPath && <p className="mt-2 break-all text-xs text-muted-foreground">{stage.currentPath}</p>}
        {(stage.failed + stage.unmatched > 0) && <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setSelected(stage.stage); setOffset(0); }} className="rounded-lg border border-border px-3 py-2 text-xs">查看失败和未匹配</button>
          <button type="button" disabled={!retryEnabled} onClick={() => onRetry(stage.stage)} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-40">重试此阶段</button>
        </div>}
      </section>;
    })}</div>
    {selected && <section className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{names[selected as keyof typeof names]} · 失败及未匹配</h3><button type="button" className="text-xs" onClick={() => setSelected("")}>收起</button></div>
      {loading ? <p className="mt-3 text-sm text-muted-foreground">正在读取…</p> : message ? <p className="mt-3 text-sm text-destructive">{message}</p> : <>
        {result.items.map((item) => <div key={item.id} className="mt-3 border-t border-border pt-3 text-xs"><p className="break-all">{item.path || item.name || item.resourceId}</p><p className="mt-1 break-all text-muted-foreground">{item.error}</p></div>)}
        {!result.total && <p className="mt-3 text-xs text-muted-foreground">当前没有失败或未匹配项目。</p>}
        <div className="mt-3 flex items-center gap-3 text-xs"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))} className="disabled:opacity-40">上一页</button><span>共 {result.total} 项</span><button type="button" disabled={offset + 20 >= result.total} onClick={() => setOffset(offset + 20)} className="disabled:opacity-40">下一页</button></div>
      </>}
    </section>}
  </div>;
}
