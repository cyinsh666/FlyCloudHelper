import { isIP } from "node:net";
import { Agent as HttpAgent } from "node:http";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import { Server as ProxyServer } from "proxy-chain";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";
import type { CredentialVault } from "./secrets.js";

const NETWORK_PROXY_SETTING_KEY = "network_outbound_proxy";

export interface NetworkProxyStatus {
  enabled: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  passwordConfigured: boolean;
  configurationRevision: number;
}

interface NetworkProxyConfiguration {
  enabled: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  password: string;
}

/** 内网、回环和本机域名保持直连，避免数据库、直播子进程和 API 请求绕到外部代理。 */
function isInternalTarget(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 6) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/u.test(host);
  if (isIP(host) !== 4) return false;
  const [first = 0, second = 0] = host.split(".").map(Number);
  return first === 10 || first === 127 || first === 0 || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

/** 校验代理主机，账号和端口由独立字段提交，不允许在主机里嵌入 URL 内容。 */
function readProxyHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 255) throw validationError("host", "代理主机不能为空且不能超过 255 个字符");
  const host = value.trim().replace(/^\[|\]$/gu, "");
  if (/[/\\\s@?#]/u.test(host)) throw validationError("host", "代理主机只填写域名或 IP 地址");
  try {
    const url = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:80`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error("invalid host");
  } catch {
    throw validationError("host", "代理主机只填写域名或 IP 地址");
  }
  return host;
}

/** 将上游地址交给本地代理桥接，不把认证信息放入进程环境变量。 */
function createUpstreamUrl(configuration: NetworkProxyConfiguration): string {
  const host = isIP(configuration.host) === 6 ? `[${configuration.host}]` : configuration.host;
  const url = new URL(`${configuration.protocol}://${host}:${configuration.port}`);
  if (configuration.username) url.username = configuration.username;
  if (configuration.password) url.password = configuration.password;
  return url.href;
}

/** 管理所有服务端出站请求共用的本机 HTTP 出口及加密上游配置。 */
export class NetworkProxyManager {
  private bridge: ProxyServer | null = null;
  private localUrl = "";
  private configuration: NetworkProxyConfiguration | null = null;
  private revision = 0;
  private readonly originalDispatcher: Dispatcher = getGlobalDispatcher();
  private fetchDispatcher: EnvHttpProxyAgent | null = null;
  // 关键变量：Provider 原生流式请求需要 Node Agent；普通 fetch 使用 Undici Dispatcher。
  private readonly nodeAgent = new NodeProxyAgent({
    getProxyForUrl: (url) => this.configuration?.enabled && !isInternalTarget(new URL(url).hostname) ? this.localUrl : "",
  });

  public constructor(private readonly database: FlyCloudHelperDatabase, private readonly vault: CredentialVault) {}

  /** 启动本机出口并从加密系统配置恢复上游；只在启动完成后修改进程代理环境。 */
  public async initialize(): Promise<void> {
    const saved = await this.database.getSystemSecretSetting(NETWORK_PROXY_SETTING_KEY);
    if (saved) {
      const payload = this.vault.decrypt(saved.encryptedPayload);
      this.configuration = this.readConfiguration(payload);
      this.revision = saved.revision;
    }
    this.bridge = new ProxyServer({
      host: "127.0.0.1", port: 0,
      prepareRequestFunction: ({ hostname }) => ({
        requestAuthentication: false,
        upstreamProxyUrl: this.configuration?.enabled && !isInternalTarget(hostname)
          ? createUpstreamUrl(this.configuration) : null,
      }),
    });
    await this.bridge.listen();
    this.localUrl = `http://127.0.0.1:${this.bridge.port}`;
    // 关键变量：子进程始终连接同一个本机出口；关闭代理时出口直连，运行中修改配置也能生效。
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) process.env[key] = this.localUrl;
    const bypass = "localhost,127.0.0.1,::1,[::1]";
    process.env.no_proxy = bypass;
    process.env.NO_PROXY = bypass;
    this.fetchDispatcher = new EnvHttpProxyAgent({ httpProxy: this.localUrl, httpsProxy: this.localUrl, noProxy: bypass });
    this.applyFetchDispatcher();
  }

  /** 还原 Node fetch 并关闭本机出口，供服务正常退出。 */
  public async close(): Promise<void> {
    setGlobalDispatcher(this.originalDispatcher);
    await this.fetchDispatcher?.close();
    await this.bridge?.close(true);
  }

  /** 供 Provider 流式请求按当前代理开关选择 Agent。 */
  public getNodeAgent(): HttpAgent | undefined {
    return this.configuration?.enabled ? this.nodeAgent : undefined;
  }

  /** 浏览器只连接无密码的本机出口，SOCKS5 账号密码由出口连接上游。 */
  public getBrowserProxy(): { server: string; bypass: string } | undefined {
    return this.configuration?.enabled ? { server: this.localUrl, bypass: "localhost,127.0.0.1,[::1]" } : undefined;
  }

  /** 返回脱敏配置；密码只显示是否已配置。 */
  public getStatus(): NetworkProxyStatus {
    const current = this.configuration;
    return {
      enabled: current?.enabled ?? false,
      protocol: current?.protocol ?? "http",
      host: current?.host ?? "",
      port: current?.port ?? 0,
      username: current?.username ?? "",
      passwordConfigured: Boolean(current?.password),
      configurationRevision: this.revision,
    };
  }

  /** 保存加密代理配置，并即时切换 Node fetch 和本机出口的后续请求。 */
  public async save(input: Record<string, unknown>, userId: string): Promise<NetworkProxyStatus> {
    const current = this.configuration;
    const next = this.readConfiguration({
      enabled: input.enabled,
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password === undefined ? current && current.username === input.username ? current.password : "" : input.password,
    });
    this.revision = await this.database.saveSystemSecretSetting({
      settingKey: NETWORK_PROXY_SETTING_KEY,
      encryptedPayload: this.vault.encrypt({ ...next }),
      updatedByUserId: userId,
    });
    this.configuration = next;
    this.applyFetchDispatcher();
    return this.getStatus();
  }

  /** 只使用已保存的代理配置连接公开目标，供设置页检查鉴权和上游连通性。 */
  public async test(): Promise<{ reachable: boolean; statusCode: number }> {
    if (!this.configuration?.enabled || !this.fetchDispatcher) throw new ApiError(409, "network_proxy_disabled", "请先保存并启用代理");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://example.com/", { method: "HEAD", signal: controller.signal });
      return { reachable: response.ok, statusCode: response.status };
    } catch {
      throw new ApiError(502, "network_proxy_test_failed", "代理连接失败，请检查地址、端口和账号密码");
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 校验数据库或页面提交值，避免不完整配置进入本机出口。 */
  private readConfiguration(value: Record<string, unknown>): NetworkProxyConfiguration {
    if (typeof value.enabled !== "boolean") throw validationError("enabled", "代理开关必须是布尔值");
    if (value.protocol !== "http" && value.protocol !== "socks5") throw validationError("protocol", "只支持 HTTP 和 SOCKS5 代理");
    const host = value.enabled || value.host ? readProxyHost(value.host) : "";
    const port = Number(value.port);
    if (host && (!Number.isInteger(port) || port < 1 || port > 65535)) throw validationError("port", "代理端口必须在 1 到 65535 之间");
    if (typeof value.username !== "string" || value.username.length > 255 || /[\r\n]/u.test(value.username)) throw validationError("username", "代理用户名格式无效");
    if (typeof value.password !== "string" || value.password.length > 1024 || /[\r\n]/u.test(value.password)) throw validationError("password", "代理密码格式无效");
    return { enabled: value.enabled, protocol: value.protocol, host, port: host ? port : 0, username: value.username, password: value.password };
  }

  /** 仅启用时接管 Node fetch；停用时恢复原调度器，不修改入站服务。 */
  private applyFetchDispatcher(): void {
    setGlobalDispatcher(this.configuration?.enabled && this.fetchDispatcher ? this.fetchDispatcher : this.originalDispatcher);
  }
}

// 关键变量：网络请求入口在运行时通过同一个代理管理器取得当前配置。
let activeNetworkProxy: NetworkProxyManager | null = null;

/** 注册已经初始化的管理器，供 Provider 和浏览器入口读取代理。 */
export function setActiveNetworkProxy(manager: NetworkProxyManager | null): void { activeNetworkProxy = manager; }

/** 返回当前原生请求使用的代理 Agent。 */
export function getOutboundNodeAgent(): HttpAgent | undefined { return activeNetworkProxy?.getNodeAgent(); }

/** 返回当前浏览器启动使用的本机代理配置。 */
export function getOutboundBrowserProxy(): { server: string; bypass: string } | undefined { return activeNetworkProxy?.getBrowserProxy(); }
