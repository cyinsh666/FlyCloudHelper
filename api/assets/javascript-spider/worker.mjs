import vm from "node:vm";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { Worker } from "node:worker_threads";
import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import * as pako from "pako";
import { inspectJavaScript, dependencyKind, JavaScriptSourceFailure, METHOD_ALIASES } from "./inspect.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const scriptArgument = process.argv.indexOf("--script");
const scriptPath = process.argv[scriptArgument + 1];
const allowInsecureHttp = process.argv.includes("--allow-http");
const networkPath = new URL("./network-worker.mjs", import.meta.url);
let networkWorker;
let target;
let inspection;
let initialized = false;
let networkRequests = 0;
let networkSuccesses = 0;
let networkFailure = "javascript_source_network_failed";
let networkDiagnostics = {};
const storage = new Map();
const timers = new Set();

/** 全部脚本日志只计数，不把正文、播放地址和会话信息输出到宿主日志。 */
function discardLog(...values) { void values; }

/** 同步请求由独立网络线程执行，源进程阻塞不会阻塞云助手 API。 */
function req(url, options = {}) {
  networkWorker ??= new Worker(networkPath);
  networkRequests += 1;
  const sharedState = new SharedArrayBuffer(8);
  // 关键变量：8 MB UTF-8 正文转成 JSON 后可能变长，网络线程仍独立限制原始和解压后字节数。
  const sharedBody = new SharedArrayBuffer(32 * 1024 * 1024);
  const state = new Int32Array(sharedState);
  networkWorker.postMessage({ url: String(url), options: JSON.parse(JSON.stringify(options ?? {}, encodeValue), restoreValue), allowInsecureHttp, sharedState, sharedBody });
  const requestedTimeout = Number(options?.timeout ?? 15000);
  const timeout = Math.max(100, Math.min(30000, Number.isFinite(requestedTimeout) ? requestedTimeout : 15000));
  if (Atomics.wait(state, 0, 0, timeout + 1000) === "timed-out") {
    networkFailure = "javascript_source_network_timeout";
    networkDiagnostics = { 网络错误码: "TIMEOUT" };
    throw new JavaScriptSourceFailure(networkFailure, networkDiagnostics);
  }
  const size = Atomics.load(state, 1);
  const envelope = JSON.parse(Buffer.from(sharedBody, 0, size).toString("utf8"));
  if (!envelope.ok) {
    networkFailure = envelope.code;
    networkDiagnostics = envelope.diagnostics ?? {};
    throw new JavaScriptSourceFailure(envelope.code, networkDiagnostics);
  }
  if (envelope.value.code >= 200 && envelope.value.code < 400) networkSuccesses += 1;
  else {
    networkFailure = "javascript_source_http_failed";
    networkDiagnostics = { 上游HTTP状态码: envelope.value.code };
  }
  return envelope.value;
}

/** 海阔式 request 返回文本；CatVod req 返回带状态、正文和响应头的对象。 */
function request(url, options = {}) { return req(url, options).content; }

/** 不支持的脚本代理必须明确失败，不能生成客户端无法使用的假本地地址。 */
function unsupportedProxy() { throw new JavaScriptSourceFailure("javascript_source_proxy_unsupported"); }

/** 存储只属于当前源会话，不能写宿主文件或把播放令牌持久化到业务数据库。 */
function storageSet(key, value) {
  const content = String(value);
  if (content.length > 1024 * 1024 || (!storage.has(key) && storage.size >= 256)) throw new JavaScriptSourceFailure("javascript_source_storage_full");
  storage.set(key, content);
}

/** 记录源自己创建的定时器，结束进程前统一释放。 */
function scheduleTimeout(callback, delay, ...args) {
  if (timers.size >= 128) throw new JavaScriptSourceFailure("javascript_source_busy");
  const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, Math.max(0, Math.min(60000, Number(delay) || 0)));
  timers.add(timer);
  return timer;
}

/** 移除已登记定时器；取消旧源时不残留下一次会话的异步任务。 */
function cancelTimeout(timer) { timers.delete(timer); clearTimeout(timer); }

/** 只暴露内容源所需宿主能力；VM 是执行隔离环境，并非完整安全沙箱。 */
function createContext() {
  const local = {
    /** 分组读取会话配置，不落盘。 */
    get: (group, key, fallback = "") => storage.get(`${group}:${key}`) ?? fallback,
    /** 分组保存会话配置，不共享其他实例。 */
    set: (group, key, value) => storageSet(`${group}:${key}`, value),
    /** 删除明确的分组键。 */
    delete: (group, key) => storage.delete(`${group}:${key}`),
  };
  const localStorage = {
    /** 浏览器式会话读取。 */
    getItem: (key) => storage.get(`local:${key}`) ?? null,
    /** 浏览器式会话写入。 */
    setItem: (key, value) => storageSet(`local:${key}`, value),
    /** 浏览器式删除单键。 */
    removeItem: (key) => storage.delete(`local:${key}`),
    /** 只清空当前源的存储。 */
    clear: () => storage.clear(),
  };
  return vm.createContext({
    req, request, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    console: { log: discardLog, info: discardLog, warn: discardLog, error: discardLog, debug: discardLog },
    cheerio, load: cheerio.load, CryptoJS, Crypto: CryptoJS, pako, local, localStorage,
    setTimeout: scheduleTimeout, clearTimeout: cancelTimeout,
    /** atob 保留浏览器的字节字符串语义。 */
    atob: (value) => Buffer.from(String(value), "base64").toString("latin1"),
    /** btoa 编码浏览器字节字符串。 */
    btoa: (value) => Buffer.from(String(value), "latin1").toString("base64"),
    /** CatVod 文本 Base64 解码采用 UTF-8。 */
    base64Decode: (value) => Buffer.from(String(value), "base64").toString("utf8"),
    /** CatVod 文本 Base64 编码采用 UTF-8。 */
    base64Encode: (value) => Buffer.from(String(value), "utf8").toString("base64"),
    /** 常见 CatVod MD5 工具只返回文本摘要。 */
    md5: (value) => CryptoJS.MD5(String(value)).toString(),
    js2Proxy: unsupportedProxy, getProxyUrl: unsupportedProxy,
  });
}

/** 每个内置库只创建一个合成模块，不加载 assets:// 地址所指的远程脚本。 */
function libraryValues(kind) {
  if (kind === "cheerio") return { ...cheerio, default: cheerio };
  if (kind === "crypto") return { ...CryptoJS, default: CryptoJS, CryptoJS, Crypto: CryptoJS };
  if (kind === "pako") return { ...pako, default: pako };
  if (kind === "buffer") return { Buffer, default: { Buffer } };
  return { load: cheerio.load, cheerio, Crypto: CryptoJS, CryptoJS, pako, Buffer, req, request, js2Proxy: unsupportedProxy, getProxyUrl: unsupportedProxy };
}

/** 首次实际调用才求值源；上传检查仅执行 inspectJavaScript 的 AST 读取。 */
async function loadSource() {
  if (target) return;
  inspection = await inspectJavaScript(scriptPath);
  const context = createContext();
  const modules = new Map();
  /** 模块链接只接受静态检查允许的内置依赖。 */
  async function link(specifier) {
    const kind = dependencyKind(specifier);
    if (!kind) throw new JavaScriptSourceFailure("javascript_source_dependency_unsupported");
    if (!modules.has(kind)) {
      const values = libraryValues(kind);
      const module = new vm.SyntheticModule(Object.keys(values), function setExports() {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context });
      modules.set(kind, module);
    }
    return modules.get(kind);
  }
  const source = await readFile(scriptPath, "utf8");
  const module = new vm.SourceTextModule(source, {
    context,
    /** 动态导入也只复用相同内置模块，不允许任意网络或 Node 模块。 */
    importModuleDynamically: async (specifier) => {
      const dependency = await link(specifier);
      if (dependency.status === "unlinked") await dependency.link(link);
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    },
  });
  await module.link(link);
  await module.evaluate({ timeout: 5000 });
  const value = module.namespace.default ?? (typeof module.namespace.__jsEvalReturn === "function" ? await module.namespace.__jsEvalReturn() : undefined);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JavaScriptSourceFailure("javascript_source_exports_invalid");
  target = value;
}

/** 将通用 Spider 参数转换为 CatVod 参数，分集 ID、线路和搜索页码均原样保留。 */
async function dispatch(method, args, instanceId) {
  if (method === "__inspect__") return inspectJavaScript(scriptPath);
  await loadSource();
  if (method === "init" && initialized) return "";
  const aliases = METHOD_ALIASES[method];
  if (!aliases) throw new JavaScriptSourceFailure("javascript_source_invalid_method");
  const name = aliases.find((alias) => typeof target[alias] === "function");
  if (!name && ["init", "destroy"].includes(method)) { if (method === "init") initialized = true; return ""; }
  if (!name) throw new JavaScriptSourceFailure("javascript_source_method_missing");
  let selected = args;
  if (method === "init") selected = [{ skey: instanceId, stype: 3, sourceKey: instanceId, ext: typeof args[0] === "string" ? args[0] : "" }];
  if (method === "detailContent" && name === "detail") {
    if (!Array.isArray(args[0]) || args[0].length !== 1) throw new JavaScriptSourceFailure("javascript_source_invalid_arguments");
    selected = [String(args[0][0])];
  }
  if (method === "searchContent" && !inspection.searchPaged && Number(args[2] ?? 1) > 1) throw new JavaScriptSourceFailure("javascript_source_paging_unsupported");
  networkRequests = 0; networkSuccesses = 0; networkDiagnostics = {};
  const result = await Reflect.apply(target[name], target, selected);
  // 关键变量：源脚本吞掉全部网络错误后返回兜底空页，不能被当作成功读到目录末尾。
  if (networkRequests > 0 && networkSuccesses === 0) throw new JavaScriptSourceFailure(networkFailure, networkDiagnostics);
  if (method === "init") initialized = true;
  if (method === "searchContent" && !inspection.searchPaged) {
    const value = typeof result === "string" ? JSON.parse(result) : result;
    return { ...value, __python_search_paged__: false };
  }
  return result ?? null;
}

/** 二进制结果采用明确标记，其余对象必须能够通过 JSON 消息传递。 */
function encodeValue(_key, value) {
  if (value instanceof Uint8Array) return { __javascript_bytes__: Buffer.from(value).toString("base64") };
  if (value?.type === "Buffer" && Array.isArray(value.data)) return { __javascript_bytes__: Buffer.from(value.data).toString("base64") };
  return value;
}

/** 宿主传入的二进制标记只还原明确的单字段对象。 */
function restoreValue(_key, value) {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.__javascript_bytes__ === "string") {
    return Buffer.from(value.__javascript_bytes__, "base64");
  }
  return value;
}

/** 只向宿主输出一条有界响应，不输出源日志和异常堆栈。 */
function respond(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, encodeValue);
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new JavaScriptSourceFailure("javascript_source_message_too_large");
  } catch (error) {
    serialized = JSON.stringify({ id: value.id, ok: false, error: { code: error instanceof JavaScriptSourceFailure ? error.code : "javascript_source_result_invalid" } });
  }
  process.stdout.write(`${serialized}\n`);
}

/** 一次只分发一条消息；宿主的取消或超时会结束整个源进程。 */
async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let request;
    try {
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new JavaScriptSourceFailure("javascript_source_message_too_large");
      request = JSON.parse(line, restoreValue);
      if (!request || typeof request.id !== "string" || !Array.isArray(request.args)) throw new JavaScriptSourceFailure("javascript_source_protocol_failed");
      if (request.method === "__shutdown__") break;
      const value = await dispatch(request.method, request.args, request.instanceId);
      respond({ id: request.id, ok: true, value });
    } catch (error) {
      const code = error instanceof JavaScriptSourceFailure ? error.code : "javascript_source_call_failed";
      respond({ id: request?.id ?? null, ok: false, error: { code, diagnostics: error instanceof JavaScriptSourceFailure ? error.diagnostics : undefined } });
    }
  }
  // 关键变量：正常停用先允许源清理会话，父宿主保留两秒后强制退出的上限。
  if (target && typeof target.destroy === "function") {
    try { await Reflect.apply(target.destroy, target, []); } catch { /* 清理失败不输出源异常。 */ }
  }
  for (const timer of timers) clearTimeout(timer);
  if (networkWorker) await networkWorker.terminate();
}

main().catch(() => { process.exitCode = 1; });
