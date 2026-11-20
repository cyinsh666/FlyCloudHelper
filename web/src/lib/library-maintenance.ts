import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { requestJson, type MediaLibrary } from "./api";

type MaintenanceKind = "clear" | "delete";

export interface LibraryMaintenanceOperation {
  id: string;
  libraryId: string;
  kind: MaintenanceKind;
  status: "running" | "completed" | "failed";
  error: string | null;
}

interface MaintenanceSubmission {
  library: MediaLibrary;
  admin: boolean;
  operation: LibraryMaintenanceOperation;
}

// 确认后先保存卡片摘要，设置页卸载或列表请求尚未返回时，仍能立即显示目标媒体库。
let submissions = new Map<string, MaintenanceSubmission>();
const listeners = new Set<() => void>();

/** 发布提交状态，供媒体库列表在切换页面后读取。 */
function updateSubmissions(next: Map<string, MaintenanceSubmission>): void {
  submissions = next;
  listeners.forEach((listener) => listener());
}

/** 订阅本标签页发起的媒体库操作。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 返回当前提交状态的稳定快照。 */
function readSubmissions() { return submissions; }

/** 返回当前控制台作用域的媒体库 API 路径。 */
function libraryApiPath(admin: boolean): string {
  return admin ? "/api/v1/admin/libraries" : "/api/v1/libraries";
}

/** 单独读取维护状态，避免反复加载整个媒体库目录。 */
async function listMaintenance(admin: boolean, libraryId?: string): Promise<LibraryMaintenanceOperation[]> {
  const query = libraryId ? `?${new URLSearchParams({ libraryId })}` : "";
  const result = await requestJson<{ items: LibraryMaintenanceOperation[] }>(`${libraryApiPath(admin)}/maintenance${query}`);
  return result.items;
}

/** 返回正在执行的操作名称。 */
export function getLibraryMaintenanceLabel(kind: MaintenanceKind): string {
  return kind === "clear" ? "正在清空" : "正在删除";
}

/** 确认后立即锁定卡片，提交请求由路由之外的状态保存。 */
export function startLibraryMaintenance(library: MediaLibrary, kind: MaintenanceKind, admin = false): void {
  if (submissions.get(library.id)?.operation.status === "running") return;
  const local: MaintenanceSubmission = { library, admin, operation: {
    id: "", libraryId: library.id, kind, status: "running", error: null,
  } };
  updateSubmissions(new Map(submissions).set(library.id, local));
  const path = `${libraryApiPath(admin)}/${encodeURIComponent(library.id)}${kind === "clear" ? "/catalog" : ""}`;
  void requestJson<{ operation: LibraryMaintenanceOperation }>(path, {
    method: "DELETE", body: JSON.stringify({ confirmation: library.id, background: true }),
  }).then(({ operation }) => {
    if (submissions.get(library.id) !== local) return;
    updateSubmissions(new Map(submissions).set(library.id, { ...local, operation }));
  }).catch((error: unknown) => {
    if (submissions.get(library.id) !== local) return;
    const failure: MaintenanceSubmission = { ...local, operation: { ...local.operation, status: "failed",
      error: error instanceof Error ? error.message : "媒体库操作提交失败",
    } };
    updateSubmissions(new Map(submissions).set(library.id, failure));
    window.setTimeout(() => {
      if (submissions.get(library.id) !== failure) return;
      const next = new Map(submissions);
      next.delete(library.id);
      updateSubmissions(next);
    }, 5 * 60_000);
  });
}

/** 路由直达时先看尚未提交完成的请求，再核对服务端锁。 */
export async function isLibraryMaintenanceLocked(libraryId: string, admin = false): Promise<boolean> {
  const submission = submissions.get(libraryId);
  const local = submission?.operation;
  if (local?.status === "running" && !local.id) return true;
  try {
    const [operation] = await listMaintenance(admin, libraryId);
    if (local?.id && operation?.status !== "running" && submissions.get(libraryId) === submission) {
      const next = new Map(submissions);
      next.delete(libraryId);
      updateSubmissions(next);
    }
    return operation?.status === "running";
  } catch {
    return local?.status === "running";
  }
}

/** 轮询在后台执行的操作，服务端终态到达后恢复卡片入口。 */
export function useLibraryMaintenance(admin: boolean, onCompleted?: () => Promise<void>) {
  const local = useSyncExternalStore(subscribe, readSubmissions);
  const [remote, setRemote] = useState<LibraryMaintenanceOperation[]>([]);
  // 目录列表只在新操作完成后刷新一次，日常轮询只读取状态接口。
  const handledCompletions = useRef(new Set<string>());
  useEffect(() => {
    if (!onCompleted) return;
    const completed = remote.filter((operation) => operation.status === "completed" && !handledCompletions.current.has(operation.id));
    if (completed.length === 0) return;
    completed.forEach((operation) => handledCompletions.current.add(operation.id));
    void onCompleted();
  }, [onCompleted, remote]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let hasRunningOperation = false;

    /** 单次状态请求结束后再开始下一轮，连接慢时避免堆积请求。 */
    async function poll(): Promise<void> {
      const submittedBeforeRequest = submissions;
      try {
        const items = await listMaintenance(admin);
        if (disposed) return;
        hasRunningOperation = items.some((item) => item.status === "running");
        const next = new Map(submissions);
        for (const [id, submission] of submittedBeforeRequest) {
          if (submission.admin !== admin || next.get(id) !== submission) continue;
          const operation = items.find((item) => item.libraryId === id);
          // 请求已被服务端接收后才按服务端结果解锁，避免旧轮询覆盖刚提交的维护状态。
          if ((submission.operation.id && (operation?.id !== submission.operation.id || operation.status !== "running"))
            || (submission.operation.status === "failed" && operation?.status === "running")) next.delete(id);
        }
        setRemote(items);
        if (next.size !== submissions.size) updateSubmissions(next);
      } catch {
        // 暂时读不到服务端时保留最后一次的状态，下一轮继续确认。
      } finally {
        const isSubmitting = [...submissions.values()].some((item) => item.admin === admin && item.operation.status === "running");
        if (!disposed) timer = window.setTimeout(poll, hasRunningOperation || isSubmitting ? 2_000 : 5_000);
      }
    }

    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [admin]);

  return useMemo(() => {
    const operations = new Map(remote.map((operation) => [operation.libraryId, operation]));
    const submittedLibraries: MediaLibrary[] = [];
    for (const submission of local.values()) {
      if (submission.admin !== admin) continue;
      const { operation, library } = submission;
      const serverOperation = operations.get(library.id);
      if (!serverOperation || (serverOperation.status !== "running" && (!operation.id || serverOperation.id !== operation.id))) {
        operations.set(library.id, operation);
      }
      submittedLibraries.push(library);
    }
    return { operations, submittedLibraries };
  }, [admin, local, remote]);
}
