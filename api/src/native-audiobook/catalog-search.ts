import { ApiError } from "../errors.js";
import { nativeHash } from "./store.js";

/** 来源搜索结果只保存稳定作品 ID，不缓存来源临时地址或账号凭据。 */
interface NativeSearchResult {
  ids: string[];
  hasMore: boolean;
}

/** 一个来源窗口可供多个客户端继续分页，窗口内容变化时拒绝旧偏移游标。 */
export interface NativeSearchWindow extends NativeSearchResult {
  revision: string;
  expiresAt: number;
}

/** 共享任务的取消权只由全部等待者共同决定，不能交给第一个 HTTP 请求。 */
interface NativeSharedSearch {
  controller: AbortController;
  consumers: Set<symbol>;
  settled: boolean;
  promise: Promise<NativeSearchWindow>;
}

/** 原生实时搜索的短期窗口和等待者管理，不改变来源队列的执行/排空规则。 */
export class NativeCatalogSearch {
  private readonly windows = new Map<string, NativeSearchWindow>();
  private readonly requests = new Map<string, NativeSharedSearch>();

  /** 未完成窗口按查询合并；取消全部消费者后，新请求必须建立自己的一轮。 */
  public async read(key: string, load: (signal: AbortSignal) => Promise<NativeSearchResult>, signal?: AbortSignal): Promise<NativeSearchWindow> {
    if (signal?.aborted) throw new ApiError(499, "request_cancelled", "本次搜索等待已取消");
    const cached = this.windows.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
    if (cached) this.windows.delete(key);

    let request = this.requests.get(key);
    if (!request || request.controller.signal.aborted) {
      const controller = new AbortController();
      // 关键变量：先登记共享状态，再在微任务中进入来源队列，允许取消尚未入队的搜索。
      const created: NativeSharedSearch = {
        controller, consumers: new Set(), settled: false,
        promise: Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw new ApiError(499, "request_cancelled", "搜索已取消");
          const result = await load(controller.signal);
          const window = { ...result, revision: nativeHash(JSON.stringify(result.ids)), expiresAt: Date.now() + 60000 };
          // 关键变量：无人等待或已取消的一轮即使来源稍后完成，也不能回填短期窗口。
          if (!controller.signal.aborted && created.consumers.size > 0) {
            for (const [entry, value] of this.windows) if (value.expiresAt <= Date.now()) this.windows.delete(entry);
            while (this.windows.size >= 256) this.windows.delete(this.windows.keys().next().value!);
            this.windows.set(key, window);
          }
          return window;
        }),
      };
      /** 收尾时核对任务身份，旧执行完成不能删除同键的新一轮搜索。 */
      const finish = (): void => {
        created.settled = true;
        if (this.requests.get(key) === created) this.requests.delete(key);
      };
      void created.promise.then(finish, finish);
      this.requests.set(key, created);
      request = created;
    }
    return this.wait(key, request, signal);
  }

  /** 每个消费者只撤销自己的监听；最后一个离开时才通知来源取消排队或放弃在途结果。 */
  private wait(key: string, request: NativeSharedSearch, signal?: AbortSignal): Promise<NativeSearchWindow> {
    const consumer = Symbol("native-search-consumer");
    request.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let waiting = true;
      /** 所有成功、失败和取消路径都只释放一次引用及 abort 监听。 */
      const cleanup = (): void => {
        if (!waiting) return;
        waiting = false;
        signal?.removeEventListener("abort", cancel);
        request.consumers.delete(consumer);
        if (!request.settled && request.consumers.size === 0) {
          if (this.requests.get(key) === request) this.requests.delete(key);
          request.controller.abort();
        }
      };
      /** 本次页面离开只拒绝本次等待，不误伤其他仍在等待的客户端。 */
      const cancel = (): void => {
        cleanup();
        reject(new ApiError(499, "request_cancelled", "本次搜索等待已取消"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      void request.promise.then((result) => { cleanup(); resolve(result); }, (error: unknown) => { cleanup(); reject(error); });
    });
  }
}
