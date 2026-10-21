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
// 关键变量：上传的 Python 文件必须明确提供影视源五接口，不能把任意脚本当成内容源。
const REQUIRED_SOURCE_METHODS = ["homeContent", "categoryContent", "detailContent", "searchContent", "playerContent"];
const WORKER_PATH = fileURLToPath(new URL("../../assets/python-spider/worker.py", import.meta.url));

interface PythonRequest {
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
export interface PythonInvocationOptions {
  priority?: number;
  queueKey?: string;
  /** 听书普通请求放弃在途结果时继续排空响应，不终止同实例的其他等待调用。 */
  discardRunningOnCancel?: boolean;
}

interface PythonWorker {
  instanceId: string;
  scriptPath: string;
  process: ChildProcessWithoutNullStreams;
  pending: Map<string, PythonRequest>;
  queue: PythonRequest[];
  current: PythonRequest | null;
  output: string;
  stderrBytes: number;
  stopping: boolean;
  exited: boolean;
  closed: Promise<void>;
  finishClosed: () => void;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** 只映射固定错误码，不把 Python 异常正文、播放地址或源日志交给客户端。 */
function sourceError(code: string): ApiError {
  const messages: Record<string, [number, string]> = {
    python_source_runtime_unavailable: [503, "Python 源运行环境不可用，请检查 Python 路径及依赖"],
    python_source_closed: [503, "Python 源宿主已经关闭"],
    python_source_stopped: [409, "Python 源实例已经停止，请重新打开"],
    python_source_busy: [503, "Python 源调用较多，请稍后重试"],
    python_source_timeout: [504, "Python 源调用超时，已结束本次源进程，请稍后重试"],
    python_source_queue_timeout: [504, "Python 源排队超时，请稍后重试"],
    python_source_cancelled: [499, "Python 源调用已取消"],
    python_source_message_too_large: [413, "Python 源调用或返回内容超过大小限制"],
    python_source_invalid_method: [422, "Python 源方法名称无效"],
    python_source_method_missing: [422, "Python 源没有提供所需接口"],
    python_source_paging_unsupported: [422, "此 Python 源搜索只支持首页，无法读取后续搜索页"],
    python_source_syntax_invalid: [422, "Python 源脚本语法无效"],
    python_source_script_unavailable: [422, "Python 源脚本无法读取"],
    python_source_dependency_missing: [503, "Python 源缺少运行依赖，请在服务环境中安装对应依赖"],
    python_source_load_failed: [502, "Python 源加载或初始化失败"],
    python_source_version_guard: [409, "Python 源接口要求更新版本，请更新源脚本后重试"],
    python_source_result_invalid: [502, "Python 源返回内容无法通过运行接口传递"],
    python_source_protocol_failed: [502, "Python 源进程通信失败，请重新打开"],
    python_source_call_failed: [502, "Python 源接口调用失败，请稍后重试"],
  };
  const known = messages[code];
  const selectedCode = known ? code : "python_source_call_failed";
  const selected = known ?? messages.python_source_call_failed!;
  return new ApiError(selected[0], selectedCode, selected[1]);
}

/** 把 worker 编码的二进制还原为 Buffer，供 localProxy 的字节响应继续使用。 */
function restorePythonBytes(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.__python_bytes__ === "string") {
    return Buffer.from(object.__python_bytes__, "base64");
  }
  return value;
}

/** 请求中的 Buffer 和 Uint8Array 使用同一二进制标记，不把字节数组变为不兼容的 Python 字典。 */
function encodePythonBytes(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __python_bytes__: Buffer.from(value).toString("base64") };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    // Buffer.toJSON 在 replacer 之前执行，这里恢复其明确的字节数组表示。
    if (object.type === "Buffer" && Array.isArray(object.data) && object.data.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      return { __python_bytes__: Buffer.from(object.data as number[]).toString("base64") };
    }
  }
  return value;
}

/** 常驻 Python Spider 宿主；脚本检查仅解析 AST，启用后的实际调用才加载脚本。 */
export class PythonSpiderRuntime {
  private readonly instances = new Map<string, PythonWorker>();
  // 关键变量：包括临时 AST 检查进程，close 必须等待所有已启动进程退出。
  private readonly workers = new Set<PythonWorker>();
  private readonly pythonPath: string;
  private readonly pluginDirectory: string;
  private closed = false;

  /** 保存插件根目录和可配置的 Python 可执行文件，不执行安装或 shell 命令。 */
  public constructor(pluginDirectory: string, pythonPath = "python3") {
    this.pluginDirectory = path.resolve(pluginDirectory);
    this.pythonPath = pythonPath || "python3";
  }

  /** 在独立进程中解析脚本 AST，不导入脚本，不创建 Spider，也不调用 getName。 */
  public async inspect(scriptPath: string): Promise<{ name: string; methods: string[]; mediaType: "video" | "audiobook" }> {
    const worker = this.startWorker(`inspect-${randomUUID()}`, scriptPath);
    try {
      const value = await this.enqueue(worker, "__inspect__", []);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceError("python_source_result_invalid");
      const result = value as Record<string, unknown>;
      if (typeof result.name !== "string" || !Array.isArray(result.methods) || result.methods.some((method) => typeof method !== "string")) {
        throw sourceError("python_source_result_invalid");
      }
      const methods = new Set(result.methods as string[]);
      if (REQUIRED_SOURCE_METHODS.some((method) => !methods.has(method))) throw sourceError("python_source_method_missing");
      if (result.mediaType !== undefined && result.mediaType !== "video" && result.mediaType !== "audiobook") throw sourceError("python_source_result_invalid");
      return { name: result.name, methods: result.methods as string[], mediaType: result.mediaType === "audiobook" ? "audiobook" : "video" };
    } finally {
      await this.stopWorker(worker, sourceError("python_source_stopped"), true);
    }
  }

  /** 按实例串行调用；排队取消只移除该项，执行中的超时才释放源进程。 */
  public async invoke(instanceId: string, scriptPath: string, method: string, args: unknown[], signal?: AbortSignal, options?: PythonInvocationOptions): Promise<unknown> {
    if (this.closed) throw sourceError("python_source_closed");
    if (signal?.aborted) throw sourceError("python_source_cancelled");
    const hostMethod = method === "__set_proxy__" || method === "__proxy__";
    if (!instanceId || (!hostMethod && !/^[A-Za-z][A-Za-z0-9_]*$/u.test(method)) || !Array.isArray(args)) throw sourceError("python_source_invalid_method");
    const resolvedScriptPath = path.resolve(scriptPath);
    let worker = this.instances.get(instanceId);
    while (worker && worker.scriptPath !== resolvedScriptPath) {
      await this.stopWorker(worker, sourceError("python_source_stopped"), false);
      if (this.closed) throw sourceError("python_source_closed");
      if (signal?.aborted) throw sourceError("python_source_cancelled");
      worker = this.instances.get(instanceId);
    }
    if (this.closed) throw sourceError("python_source_closed");
    if (signal?.aborted) throw sourceError("python_source_cancelled");
    if (!worker) {
      worker = this.startWorker(instanceId, resolvedScriptPath);
      this.instances.set(instanceId, worker);
    }
    return this.enqueue(worker, method, args, signal, options);
  }

  /** 前台合并已有预取后提升同一逻辑任务的待执行项，不启动重复 Python 调用。 */
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
    if (worker) await this.stopWorker(worker, sourceError("python_source_stopped"), worker.current === null);
  }

  /** 关闭全部常驻和临时进程，并禁止后续创建新的源进程。 */
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers].map((worker) => this.stopWorker(worker, sourceError("python_source_closed"), worker.current === null)));
  }

  /** 使用参数数组启动受控 worker；不执行源文件的命令行入口。 */
  private startWorker(instanceId: string, scriptPath: string): PythonWorker {
    if (this.closed) throw sourceError("python_source_closed");
    if (this.workers.size >= MAX_WORKERS) throw sourceError("python_source_busy");
    const resolvedScriptPath = path.resolve(scriptPath);
    const child = spawn(this.pythonPath, ["-B", "-u", WORKER_PATH, "--script", resolvedScriptPath, "--plugin-root", this.pluginDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 独立进程组用于取消时同时释放源脚本创建的子进程，不调用 shell。
      detached: process.platform !== "win32",
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let finishClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { finishClosed = resolve; });
    const worker: PythonWorker = {
      instanceId, scriptPath: resolvedScriptPath, process: child, pending: new Map(), queue: [], current: null,
      output: "", stderrBytes: 0, stopping: false, exited: false, closed, finishClosed,
    };
    this.workers.add(worker);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readOutput(worker, chunk));
    // 源脚本的原始 stderr 只被排空和计数，绝不输出正文或地址。
    child.stderr.on("data", (chunk: Buffer) => { worker.stderrBytes += chunk.length; });
    child.stdin.on("error", () => { void this.stopWorker(worker, sourceError("python_source_protocol_failed"), false); });
    child.on("error", () => { void this.stopWorker(worker, sourceError("python_source_runtime_unavailable"), false); });
    child.on("close", () => {
      worker.exited = true;
      if (!worker.stopping) void this.stopWorker(worker, sourceError("python_source_protocol_failed"), false);
      if (worker.killTimer) clearTimeout(worker.killTimer);
      this.workers.delete(worker);
      worker.finishClosed();
    });
    return worker;
  }

  /** 将一次调用放入有界队列，只有队头会写入 stdin，避免无限积压进程输入。 */
  private enqueue(worker: PythonWorker, method: string, args: unknown[], signal?: AbortSignal, options?: PythonInvocationOptions): Promise<unknown> {
    if (worker.stopping || worker.exited) return Promise.reject(sourceError("python_source_stopped"));
    if (worker.pending.size >= MAX_PENDING_PER_WORKER) return Promise.reject(sourceError("python_source_busy"));
    const id = randomUUID();
    let serialized: string;
    try { serialized = `${JSON.stringify({ id, method, args }, encodePythonBytes)}\n`; }
    catch { return Promise.reject(sourceError("python_source_result_invalid")); }
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) return Promise.reject(sourceError("python_source_message_too_large"));
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => this.cancelRequest(worker, request, sourceError("python_source_cancelled"));
      // 关键变量：等待预算只影响当前待执行项，不能误杀正在播放的另一条调用。
      const timer = setTimeout(() => this.cancelRequest(worker, request, sourceError("python_source_queue_timeout")), REQUEST_TIMEOUT_MS);
      timer.unref();
      const request: PythonRequest = { id, method, serialized, timer, signal, abort, resolve, reject, priority: options?.priority ?? 1, queueKey: options?.queueKey, discardRunningOnCancel: options?.discardRunningOnCancel ?? false };
      worker.pending.set(id, request);
      worker.queue.push(request);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.pump(worker);
    });
  }

  /** 未执行的取消和排队超时不终止 worker；已经执行的 Python 调用只能结束进程释放。 */
  private cancelRequest(worker: PythonWorker, request: PythonRequest, failure: ApiError): void {
    if (!worker.pending.has(request.id)) return;
    if (worker.current === request) {
      if (request.discardRunningOnCancel && failure.code === "python_source_cancelled") {
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

  /** 前一响应收尾后才发送下一条调用，Python 会话不承受同实例的并发修改。 */
  private pump(worker: PythonWorker): void {
    if (worker.stopping || worker.exited || worker.current) return;
    // 关键变量：排序稳定，同优先级仍按入队顺序；当前正在执行的请求不受提权影响。
    worker.queue.sort((left, right) => left.priority - right.priority);
    const request = worker.queue.shift();
    if (!request) return;
    worker.current = request;
    clearTimeout(request.timer);
    // 关键变量：执行超时从真正写入 stdin 开始计算，排队不能消耗当前调用的执行预算。
    request.timer = setTimeout(() => { void this.stopWorker(worker, sourceError("python_source_timeout"), false); }, REQUEST_TIMEOUT_MS);
    request.timer.unref();
    worker.process.stdin.write(request.serialized, "utf8", (error) => {
      if (error && !worker.stopping) void this.stopWorker(worker, sourceError("python_source_protocol_failed"), false);
    });
  }

  /** 读取有界 JSON 行响应；二进制仅还原受控 worker 的专用 JSON 标记。 */
  private readOutput(worker: PythonWorker, chunk: string): void {
    if (worker.stopping) return;
    worker.output += chunk;
    const responseLimit = worker.current?.method === "__proxy__" ? 24 * 1024 * 1024 : MAX_RESPONSE_BYTES;
    if (Buffer.byteLength(worker.output) > responseLimit) {
      void this.stopWorker(worker, sourceError("python_source_message_too_large"), false);
      return;
    }
    let newline = worker.output.indexOf("\n");
    while (newline >= 0 && !worker.stopping) {
      const line = worker.output.slice(0, newline);
      worker.output = worker.output.slice(newline + 1);
      if (line.trim()) {
        let result: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(line, restorePythonBytes);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid envelope");
          result = value as Record<string, unknown>;
        } catch {
          void this.stopWorker(worker, sourceError("python_source_protocol_failed"), false);
          return;
        }
        const request = worker.current;
        if (!request || result.id !== request.id || typeof result.ok !== "boolean") {
          void this.stopWorker(worker, sourceError("python_source_protocol_failed"), false);
          return;
        }
        this.clearRequest(worker, request);
        worker.current = null;
        if (result.ok) request.resolve(result.value);
        else {
          const error = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
          const failure = sourceError(typeof error.code === "string" ? error.code : "python_source_call_failed");
          request.reject(failure);
          if (["python_source_load_failed", "python_source_dependency_missing"].includes(failure.code)) {
            void this.stopWorker(worker, failure, false);
            return;
          }
          this.logFailure(worker, failure.code, request.method);
        }
        this.pump(worker);
      }
      newline = worker.output.indexOf("\n");
    }
  }

  /** 释放请求的计时器和取消监听，成功和失败都不能保留过期等待项。 */
  private clearRequest(worker: PythonWorker, request: PythonRequest): void {
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    worker.pending.delete(request.id);
  }

  /** 终止时统一拒绝等待项；正常停用可短暂等待 destroy，其他情况立即 SIGKILL。 */
  private stopWorker(worker: PythonWorker, failure: ApiError, graceful: boolean): Promise<void> {
    if (worker.stopping) return worker.closed;
    worker.stopping = true;
    if (this.instances.get(worker.instanceId) === worker) this.instances.delete(worker.instanceId);
    if (!["python_source_stopped", "python_source_closed", "python_source_cancelled"].includes(failure.code)) {
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

  /** 强制释放 Python 进程组；Windows 或进程组已退出时使用直接结束进程。 */
  private killWorker(worker: PythonWorker): void {
    if (worker.exited) return;
    if (process.platform !== "win32" && worker.process.pid) {
      try { process.kill(-worker.process.pid, "SIGKILL"); return; }
      catch { /* 启动失败或进程已经退出时，直接结束进程不会影响其他源实例。 */ }
    }
    worker.process.kill("SIGKILL");
  }

  /** 仅输出固定诊断字段，不打印源脚本的 stdout、stderr 或原始异常。 */
  private logFailure(worker: PythonWorker, code: string, method?: string): void {
    console.warn(JSON.stringify({ 日志关键字: "codex-python-source", 事件: "Python 源运行失败", 源实例ID: worker.instanceId,
      调用方法: method ?? null, 错误代码: code, 原始日志字节数: worker.stderrBytes }));
  }
}
