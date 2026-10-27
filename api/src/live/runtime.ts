import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import type { ContentSourceManifest } from "../content-sources/types.js";

/** 独立服务按实例隔离进程、端口及设备状态，不进入 Spider RPC。 */
interface LiveProcess {
  child: ChildProcess;
  origin: string;
  hash: string;
  ready: boolean;
}

/** 仅在首次播放或用户启动时运行，停用、卸载和服务器关闭均等待退出。 */
export class PythonLiveRuntime {
  private readonly processes = new Map<string, LiveProcess>();
  private readonly starting = new Map<string, Promise<LiveProcess>>();
  private readonly generations = new Map<string, number>();
  private closing = false;

  /** 保存运行环境，构造时不启动脚本。 */
  public constructor(private readonly config: ApiConfig) {}

  /** 状态查询不启动来源网络请求或设备注册。 */
  public status(instanceId: string): "running" | "starting" | "stopped" {
    if (this.starting.has(instanceId)) return "starting";
    return this.processes.get(instanceId)?.ready ? "running" : "stopped";
  }

  /** 并发播放共用一轮启动；退出中的旧实例不能覆盖新进程。 */
  public async ensure(instanceId: string, manifest: ContentSourceManifest): Promise<string> {
    if (this.closing) throw new ApiError(503, "live_source_stopping", "直播服务正在停止");
    const running = this.processes.get(instanceId);
    if (running?.ready && running.hash === manifest.scriptHash && running.child.exitCode === null && !running.child.killed) return running.origin;
    if (running?.ready && running.hash !== manifest.scriptHash) { await this.stop(instanceId); return this.ensure(instanceId, manifest); }
    const pending = this.starting.get(instanceId);
    if (pending) return (await pending).origin;
    const generation = this.generations.get(instanceId) ?? 0;
    const task = this.start(instanceId, manifest, generation);
    this.starting.set(instanceId, task);
    try { return (await task).origin; }
    finally { if (this.starting.get(instanceId) === task) this.starting.delete(instanceId); }
  }

  /** 校验原文件后直接启动受支持的 YSP 入口，附加引擎未提供时明确关闭。 */
  private async start(instanceId: string, manifest: ContentSourceManifest, generation: number): Promise<LiveProcess> {
    if (manifest.adapter !== "python_live" || manifest.liveConfig?.engine !== "ysp" || !manifest.scriptHash || !manifest.scriptFile)
      throw new ApiError(422, "live_engine_unsupported", "此直播脚本尚未适配运行引擎");
    const script = path.resolve(this.config.pluginDirectory, manifest.scriptFile);
    let bytes: Buffer;
    try { bytes = await fs.readFile(script); }
    catch { throw new ApiError(503, "live_script_missing", "直播源脚本缺失，请重新导入原插件补回"); }
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.scriptHash)
      throw new ApiError(409, "live_script_changed", "直播源脚本已变化，请通过插件管理重新导入");
    const directory = path.join(this.config.pluginDirectory, "live-state", instanceId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const port = await this.availablePort();
    if (this.closing || generation !== (this.generations.get(instanceId) ?? 0)) throw new ApiError(409, "live_start_cancelled", "直播服务启动已取消");
    const runner = fileURLToPath(new URL("../../assets/python-live/ysp-runner.py", import.meta.url));
    const child = spawn(this.config.pythonPath ?? "python3", ["-B", "-u", runner, "--script", script, String(port), "--bind", "127.0.0.1", "--data-dir", directory,
      "--cache-mb", "64", "--no-engine"], { cwd: path.dirname(script), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "ignore" });
    const entry: LiveProcess = { child, origin: `http://127.0.0.1:${port}`, hash: manifest.scriptHash, ready: false };
    this.processes.set(instanceId, entry);
    let failed = false;
    /** 仅清理当前进程，旧子进程退出不误删新一轮运行状态。 */
    const exited = (): void => { failed = true; if (this.processes.get(instanceId) === entry) this.processes.delete(instanceId); };
    child.once("error", exited);
    child.once("exit", exited);
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (failed || this.closing || generation !== (this.generations.get(instanceId) ?? 0)) break;
        try {
          const response = await fetch(`${entry.origin}/health`, { signal: AbortSignal.timeout(400) });
          if (response.ok && (await response.json() as { ok?: boolean }).ok) { entry.ready = true; return entry; }
        } catch { /* HTTP 就绪之前继续异步等待；不阻塞管理接口线程。 */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new ApiError(503, "live_start_failed", "直播服务未启动，请检查 Python 环境和脚本运行权限");
    } catch (error) { await this.terminate(entry); throw error; }
  }

  /** 让操作系统选择回环端口，不把源服务暴露到外部网卡。 */
  private async availablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { server.close(); reject(new Error("直播服务端口不可用")); return; }
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  }

  /** 停用后撤销尚在启动的一轮，再等待子进程实际退出。 */
  public async stop(instanceId: string): Promise<void> {
    this.generations.set(instanceId, (this.generations.get(instanceId) ?? 0) + 1);
    const entry = this.processes.get(instanceId);
    if (entry) await this.terminate(entry);
    await this.starting.get(instanceId)?.catch(() => undefined);
  }

  /** 先请求退出，超时才终止；等待时间有界，关闭服务不会遗留常驻脚本。 */
  private async terminate(entry: LiveProcess): Promise<void> {
    entry.ready = false;
    if (entry.child.exitCode !== null || entry.child.signalCode !== null || !entry.child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { entry.child.kill("SIGKILL"); }, 1500);
      entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
      entry.child.kill("SIGTERM");
    });
  }

  /** 服务器退出时等待全部实例，设备状态文件保留供下次启动复用。 */
  public async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...new Set([...this.processes.keys(), ...this.starting.keys()])].map((id) => this.stop(id)));
  }
}
