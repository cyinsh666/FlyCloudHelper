import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "../errors.js";

// 关键变量：每个实例只有一个在途调用，等待队列、进程数量和消息大小均有明确上限。
const MAX_WORKERS = 16;
const MAX_PENDING_PER_WORKER = 16;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// 关键变量：上传的 JavaScript 文件必须明确提供影视源五接口，不能把任意脚本当成内容源。
const REQUIRED_SOURCE_METHODS = ["homeContent", "categoryContent", "detailContent", "searchContent", "playerContent"];
const WORKER_PATH = fileURLToPath(new URL("../../assets/javascript-spider/worker.mjs", import.meta.url));

interface JavaScriptRequest {
  id: string;
  method: string;
  serialized: string;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  priority: number;
  queueKey?: string;
  discardRunningOnCancel: boolean;
}

/** 调度只影响尚未执行的调用，默认保留原有调用的普通优先级。 */
export interface JavaScriptInvocationOptions {
  priority?: number;
  queueKey?: string;
  /** 放弃在途结果时可继续排空响应，不终止同实例的其他等待调用。 */
  discardRunningOnCancel?: boolean;
}

interface JavaScriptWorker {
  instanceId: string;
  scriptPath: string;
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, JavaScriptRequest>;
  queue: JavaScriptRequest[];
  current: JavaScriptRequest | null;
  output: string;
  stderrBytes: number;
  stopping: boolean;
  exited: boolean;
  closed: Promise<void>;
  finishClosed: () => void;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** 只映射固定错误码，不把 JavaScript 异常正文、播放地址或源日志交给客户端。 */
function sourceError(code: string): ApiError {
  const messages: Record<string, [number, string]> = {
    javascript_source_runtime_unavailable: [503, "JavaScript 源运行环境不可用，请检查 Node.js 与内容源依赖"],
    javascript_source_closed: [503, "JavaScript 源宿主已经关闭"],
    javascript_source_stopped: [409, "JavaScript 源实例已经停止，请重新打开"],
    javascript_source_busy: [503, "JavaScript 源调用较多，请稍后重试"],
    javascript_source_timeout: [504, "JavaScript 源调用超时，已结束本次源进程，请稍后重试"],
    javascript_source_queue_timeout: [504, "JavaScript 源排队超时，请稍后重试"],
    javascript_source_cancelled: [499, "JavaScript 源调用已取消"],
    javascript_source_message_too_large: [413, "JavaScript 源调用或返回内容超过大小限制"],
    javascript_source_invalid_method: [422, "JavaScript 源方法名称无效"],
    javascript_source_method_missing: [422, "JavaScript 源没有提供所需接口"],
    javascript_source_paging_unsupported: [422, "此 JavaScript 源搜索只支持首页，无法读取后续搜索页"],
    javascript_source_syntax_invalid: [422, "JavaScript 源脚本语法无效"],
    javascript_source_script_unavailable: [422, "JavaScript 源脚本无法读取"],
    javascript_source_dependency_missing: [503, "JavaScript 源缺少内置运行依赖，请更新云助手"],
    javascript_source_load_failed: [502, "JavaScript 源加载或初始化失败"],
    javascript_source_exports_invalid: [422, "JavaScript 源必须导出 CatVod 接口对象"],
    javascript_source_dependency_unsupported: [422, "JavaScript 源引用了当前宿主未提供的依赖"],
    javascript_source_invalid_arguments: [422, "JavaScript 源调用参数无效"],
    javascript_source_proxy_unsupported: [422, "此 JavaScript 线路需要额外的脚本代理能力"],
    javascript_source_network_protocol: [422, "JavaScript 源地址需要 HTTPS，请检查源或实例 HTTP 开关"],
    javascript_source_network_credentials: [422, "JavaScript 源地址不能内嵌账号凭据"],
    javascript_source_network_address: [422, "JavaScript 源不能访问本地或保留网络地址"],
    javascript_source_network_redirects: [502, "JavaScript 源重定向次数过多"],
    javascript_source_network_timeout: [504, "JavaScript 源站请求超时"],
    javascript_source_network_failed: [502, "JavaScript 源站请求失败，请稍后重试"],
    javascript_source_http_failed: [502, "JavaScript 源站拒绝请求或暂时无法访问"],
    javascript_source_storage_full: [413, "JavaScript 源会话存储超过限制"],
    javascript_source_version_guard: [409, "JavaScript 源接口要求更新版本，请更新源脚本后重试"],
    javascript_source_result_invalid: [502, "JavaScript 源返回内容无法通过运行接口传递"],
    javascript_source_protocol_failed: [502, "JavaScript 源进程通信失败，请重新打开"],
    javascript_source_call_failed: [502, "JavaScript 源接口调用失败，请稍后重试"],
  };
  const known = messages[code];
  const selectedCode = known ? code : "javascript_source_call_failed";
  const selected = known ?? messages.javascript_source_call_failed!;
  return new ApiError(selected[0], selectedCode, selected[1]);
}

/** 把 worker 编码的二进制还原为 Buffer，供 localProxy 的字节响应继续使用。 */
function restoreJavaScriptBytes(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.__javascript_bytes__ === "string") {
    return Buffer.from(object.__javascript_bytes__, "base64");
  }
  return value;
}

/** 请求中的 Buffer 和 Uint8Array 使用同一二进制标记，不把字节数组变为不兼容的 JavaScript 字典。 */
function encodeJavaScriptBytes(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __javascript_bytes__: Buffer.from(value).toString("base64") };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    // Buffer.toJSON 在 replacer 之前执行，这里恢复其明确的字节数组表示。
    if (object.type === "Buffer" && Array.isArray(object.data) && object.data.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      return { __javascript_bytes__: Buffer.from(object.data as number[]).toString("base64") };
    }
  }
  return value;
}

/** 常驻 JavaScript Spider 宿主；脚本检查仅解析 AST，启用后的实际调用才加载 ES Module。 */
export class JavaScriptSpiderRuntime {
  private readonly instances = new Map<string, JavaScriptWorker>();
  // 关键变量：包括临时 AST 检查进程，close 必须等待所有已启动进程退出。
  private readonly workers = new Set<JavaScriptWorker>();
  private readonly allowInsecureHttp: boolean;
  private closed = false;

  /** 使用当前 Node.js 和协议开关创建独立宿主，不执行安装或 shell 命令。 */
  public constructor(pluginDirectory: string, allowInsecureHttp = false) {
    void pluginDirectory; // 保留与其他脚本宿主一致的构造入参，脚本路径由已安装清单确定。
    this.allowInsecureHttp = allowInsecureHttp;
  }

  /** 在独立进程中解析脚本 AST，不导入脚本，不创建 Spider，也不调用 getName。 */
  public async inspect(scriptPath: string): Promise<{ name: string; methods: string[]; mediaType: "video" }> {
    const worker = this.startWorker(`inspect-${randomUUID()}`, scriptPath);
    try {
      const value = await this.enqueue(worker, "__inspect__", []);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceError("javascript_source_result_invalid");
      const result = value as Record<string, unknown>;
      if (typeof result.name !== "string" || !Array.isArray(result.methods) || result.methods.some((method) => typeof method !== "string")) {
        throw sourceError("javascript_source_result_invalid");
      }
      const methods = new Set(result.methods as string[]);
      if (REQUIRED_SOURCE_METHODS.some((method) => !methods.has(method))) throw sourceError("javascript_source_method_missing");
      if (result.mediaType !== undefined && result.mediaType !== "video") throw sourceError("javascript_source_result_invalid");
      return { name: result.name, methods: result.methods as string[], mediaType: "video" };
    } finally {
      await this.stopWorker(worker, sourceError("javascript_source_stopped"), true);
    }
  }

  /** 按实例串行调用；排队取消只移除该项，执行中的超时才释放源进程。 */
  public async invoke(instanceId: string, scriptPath: string, method: string, args: unknown[], signal?: AbortSignal, options?: JavaScriptInvocationOptions): Promise<unknown> {
    if (this.closed) throw sourceError("javascript_source_closed");
    if (signal?.aborted) throw sourceError("javascript_source_cancelled");
    if (!instanceId || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(method) || !Array.isArray(args)) throw sourceError("javascript_source_invalid_method");
    const resolvedScriptPath = path.resolve(scriptPath);
    let worker = this.instances.get(instanceId);
    while (worker && worker.scriptPath !== resolvedScriptPath) {
      await this.stopWorker(worker, sourceError("javascript_source_stopped"), false);
      if (this.closed) throw sourceError("javascript_source_closed");
      if (signal?.aborted) throw sourceError("javascript_source_cancelled");
      worker = this.instances.get(instanceId);
    }
    if (this.closed) throw sourceError("javascript_source_closed");
    if (signal?.aborted) throw sourceError("javascript_source_cancelled");
    if (!worker) {
      worker = this.startWorker(instanceId, resolvedScriptPath);
      this.instances.set(instanceId, worker);
    }
    return this.enqueue(worker, method, args, signal, options);
  }

  /** 前台合并已有预取后提升同一逻辑任务的待执行项，不启动重复 JavaScript 调用。 */
  public promote(instanceId: string, queueKey: string): void {
    this.setPriority(instanceId, queueKey, 0);
  }

  /** 共享取址失去前台消费者时可以降回预取优先级，执行中的调用仍不能抢占。 */
  public setPriority(instanceId: string, queueKey: string, priority: number): void {
    const worker = this.instances.get(instanceId);
    if (!worker) return;
    for (const request of worker.queue) if (request.queueKey === queueKey) request.priority = priority;
  }

  /** 停止一个源实例；空闲时允许 destroy 收尾，正在调用时立即结束进程。 */
  public async stopInstance(instanceId: string): Promise<void> {
    const worker = this.instances.get(instanceId);
    if (worker) await this.stopWorker(worker, sourceError("javascript_source_stopped"), worker.current === null);
  }

  /** 关闭全部常驻和临时进程，并禁止后续创建新的源进程。 */
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers].map((worker) => this.stopWorker(worker, sourceError("javascript_source_closed"), worker.current === null)));
  }

  /** 使用参数数组启动受控 worker；不执行源文件的命令行入口。 */
  private startWorker(instanceId: string, scriptPath: string): JavaScriptWorker {
    if (this.closed) throw sourceError("javascript_source_closed");
    if (this.workers.size >= MAX_WORKERS) throw sourceError("javascript_source_busy");
    const resolvedScriptPath = path.resolve(scriptPath);
    const child = spawn(process.execPath, ["--experimental-vm-modules", "--max-old-space-size=192", WORKER_PATH, "--script", resolvedScriptPath, ...(this.allowInsecureHttp ? ["--allow-http"] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 独立进程组用于取消时同时释放源脚本创建的子进程，不调用 shell。
      detached: process.platform !== "win32",
      shell: false,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ },
    });
    let finishClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { finishClosed = resolve; });
    const worker: JavaScriptWorker = {
      instanceId, scriptPath: resolvedScriptPath, process: child, pending: new Map(), queue: [], current: null,
      output: "", stderrBytes: 0, stopping: false, exited: false, closed, finishClosed,
    };
    this.workers.add(worker);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readOutput(worker, chunk));
    // 源脚本的原始 stderr 只被排空和计数，绝不输出正文或地址。
    child.stderr.on("data", (chunk: Buffer) => { worker.stderrBytes += chunk.length; });
    child.stdin.on("error", () => { void this.stopWorker(worker, sourceError("javascript_source_protocol_failed"), false); });
    child.on("error", () => { void this.stopWorker(worker, sourceError("javascript_source_runtime_unavailable"), false); });
    child.on("close", () => {
      worker.exited = true;
      if (!worker.stopping) void this.stopWorker(worker, sourceError("javascript_source_protocol_failed"), false);
      if (worker.killTimer) clearTimeout(worker.killTimer);
      this.workers.delete(worker);
      worker.finishClosed();
    });
    return worker;
  }

  /** 将一次调用放入有界队列，只有队头会写入 stdin，避免无限积压进程输入。 */
  private enqueue(worker: JavaScriptWorker, method: string, args: unknown[], signal?: AbortSignal, options?: JavaScriptInvocationOptions): Promise<unknown> {
    if (worker.stopping || worker.exited) return Promise.reject(sourceError("javascript_source_stopped"));
    if (worker.pending.size >= MAX_PENDING_PER_WORKER) return Promise.reject(sourceError("javascript_source_busy"));
    const id = randomUUID();
    let serialized: string;
    try { serialized = `${JSON.stringify({ id, method, args, instanceId: worker.instanceId }, encodeJavaScriptBytes)}\n`; }
    catch { return Promise.reject(sourceError("javascript_source_result_invalid")); }
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) return Promise.reject(sourceError("javascript_source_message_too_large"));
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => this.cancelRequest(worker, request, sourceError("javascript_source_cancelled"));
      // 关键变量：等待预算只影响当前待执行项，不能误杀正在播放的另一条调用。
      const timer = setTimeout(() => this.cancelRequest(worker, request, sourceError("javascript_source_queue_timeout")), REQUEST_TIMEOUT_MS);
      timer.unref();
      const request: JavaScriptRequest = { id, method, serialized, timer, signal, abort, resolve, reject, priority: options?.priority ?? 1, queueKey: options?.queueKey, discardRunningOnCancel: options?.discardRunningOnCancel ?? false };
      worker.pending.set(id, request);
      worker.queue.push(request);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.pump(worker);
    });
  }

  /** 未执行的取消和排队超时不终止 worker；已经执行的 JavaScript 调用只能结束进程释放。 */
  private cancelRequest(worker: JavaScriptWorker, request: JavaScriptRequest, failure: ApiError): void {
    if (!worker.pending.has(request.id)) return;
    if (worker.current === request) {
      if (request.discardRunningOnCancel && failure.code === "javascript_source_cancelled") {
        // 关键变量：保留current/pending及真实执行计时器，晚到响应仍必须按ID排空才能发送下一条。
        request.signal?.removeEventListener("abort", request.abort);
        request.reject(failure);
        return;
      }
      void this.stopWorker(worker, failure, false);
      return;
    }
    worker.queue = worker.queue.filter((entry) => entry !== request);
    this.clearRequest(worker, request);
    request.reject(failure);
  }

  /** 前一响应收尾后才发送下一条调用，JavaScript 会话不承受同实例的并发修改。 */
  private pump(worker: JavaScriptWorker): void {
    if (worker.stopping || worker.exited || worker.current) return;
    // 关键变量：排序稳定，同优先级仍按入队顺序；当前正在执行的请求不受提权影响。
    worker.queue.sort((left, right) => left.priority - right.priority);
    const request = worker.queue.shift();
    if (!request) return;
    worker.current = request;
    clearTimeout(request.timer);
    // 关键变量：执行超时从真正写入 stdin 开始计算，排队不能消耗当前调用的执行预算。
    request.timer = setTimeout(() => { void this.stopWorker(worker, sourceError("javascript_source_timeout"), false); }, REQUEST_TIMEOUT_MS);
    request.timer.unref();
    worker.process.stdin.write(request.serialized, "utf8", (error) => {
      if (error && !worker.stopping) void this.stopWorker(worker, sourceError("javascript_source_protocol_failed"), false);
    });
  }

  /** 读取有界 JSON 行响应；二进制仅还原受控 worker 的专用 JSON 标记。 */
  private readOutput(worker: JavaScriptWorker, chunk: string): void {
    if (worker.stopping) return;
    worker.output += chunk;
    if (Buffer.byteLength(worker.output) > MAX_RESPONSE_BYTES) {
      void this.stopWorker(worker, sourceError("javascript_source_message_too_large"), false);
      return;
    }
    let newline = worker.output.indexOf("\n");
    while (newline >= 0 && !worker.stopping) {
      const line = worker.output.slice(0, newline);
      worker.output = worker.output.slice(newline + 1);
      if (line.trim()) {
        let result: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(line, restoreJavaScriptBytes);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid envelope");
          result = value as Record<string, unknown>;
        } catch {
          void this.stopWorker(worker, sourceError("javascript_source_protocol_failed"), false);
          return;
        }
        const request = worker.current;
        if (!request || result.id !== request.id || typeof result.ok !== "boolean") {
          void this.stopWorker(worker, sourceError("javascript_source_protocol_failed"), false);
          return;
        }
        this.clearRequest(worker, request);
        worker.current = null;
        if (result.ok) request.resolve(result.value);
        else {
          const error = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
          const failure = sourceError(typeof error.code === "string" ? error.code : "javascript_source_call_failed");
          request.reject(failure);
          if (["javascript_source_load_failed", "javascript_source_dependency_missing"].includes(failure.code)) {
            void this.stopWorker(worker, failure, false);
            return;
          }
          this.logFailure(worker, failure.code, request.method, error.diagnostics);
        }
        this.pump(worker);
      }
      newline = worker.output.indexOf("\n");
    }
  }

  /** 释放请求的计时器和取消监听，成功和失败都不能保留过期等待项。 */
  private clearRequest(worker: JavaScriptWorker, request: JavaScriptRequest): void {
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    worker.pending.delete(request.id);
  }

  /** 终止时统一拒绝等待项；正常停用可短暂等待 destroy，其他情况立即 SIGKILL。 */
  private stopWorker(worker: JavaScriptWorker, failure: ApiError, graceful: boolean): Promise<void> {
    if (worker.stopping) return worker.closed;
    worker.stopping = true;
    if (this.instances.get(worker.instanceId) === worker) this.instances.delete(worker.instanceId);
    if (!["javascript_source_stopped", "javascript_source_closed", "javascript_source_cancelled"].includes(failure.code)) {
      this.logFailure(worker, failure.code, worker.current?.method);
    }
    for (const request of worker.pending.values()) {
      this.clearRequest(worker, request);
      request.reject(failure);
    }
    worker.queue = [];
    worker.current = null;
    worker.output = "";
    if (worker.exited) return worker.closed;
    if (graceful && worker.process.stdin.writable) {
      worker.process.stdin.end(`${JSON.stringify({ id: randomUUID(), method: "__shutdown__", args: [] })}\n`);
      // 关键变量：destroy 本身也可能阻塞，关库最多等待两秒后强制释放进程。
      worker.killTimer = setTimeout(() => this.killWorker(worker), 2_000);
      worker.killTimer.unref();
    } else {
      this.killWorker(worker);
    }
    return worker.closed;
  }

  /** 强制释放 JavaScript 进程组；Windows 或进程组已退出时使用直接结束进程。 */
  private killWorker(worker: JavaScriptWorker): void {
    if (worker.exited) return;
    if (process.platform !== "win32" && worker.process.pid) {
      try { process.kill(-worker.process.pid, "SIGKILL"); return; }
      catch { /* 启动失败或进程已经退出时，直接结束进程不会影响其他源实例。 */ }
    }
    worker.process.kill("SIGKILL");
  }

  /** 仅输出固定诊断字段，不打印源脚本的 stdout、stderr 或原始异常。 */
  private logFailure(worker: JavaScriptWorker, code: string, method?: string, diagnostics?: unknown): void {
    // 关键变量：只接受稳定系统错误码及 HTTP 数字，不能把网络库异常正文或地址记录进日志。
    const detail = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics) ? diagnostics as Record<string, unknown> : {};
    const systemCode = typeof detail.网络错误码 === "string" && /^[A-Z0-9_]{1,60}$/u.test(detail.网络错误码) ? detail.网络错误码 : null;
    const status = Number(detail.上游HTTP状态码);
    console.warn(JSON.stringify({ 日志关键字: "codex-javascript-source", 事件: "JavaScript 源运行失败", 源实例ID: worker.instanceId,
      调用方法: method ?? null, 错误代码: code, 原始日志字节数: worker.stderrBytes,
      网络错误码: systemCode, 上游HTTP状态码: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null }));
  }
}
