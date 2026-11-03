import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { getOutboundBrowserProxy } from "../network-proxy.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { BaiduPanProvider } from "../providers/baidupan.js";
import { selectBaiduWebCookies } from "../providers/baidupan-web-playback.js";

const LOGIN_URL = "https://passport.baidu.com/v2/?login&tpl=netdisk&u="
  + encodeURIComponent("https://pan.baidu.com/disk/home");
const SESSION_LIFETIME_MS = 10 * 60_000;

interface BaiduWebLoginSession {
  id: string;
  serviceId: string;
  ownerUserId: string;
  actorUserId: string;
  expectedUserId: string;
  credentialRevision: number;
  expiresAt: number;
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  state: "waiting" | "authorized" | "failed";
  message: string;
  checking: boolean;
  lastCheckedCookie: string;
  lastCheckedAt: number;
}

const sessions = new Map<string, BaiduWebLoginSession>(); // 登录会话仅存内存，重启时自动失效。

/** 关闭浏览器进程并清除当前页面引用。 */
async function closeBrowser(session: BaiduWebLoginSession): Promise<void> {
  const browser = session.browser;
  session.browser = null;
  session.context = null;
  session.page = null;
  await browser?.close().catch(() => undefined);
}

/** 清理过期会话，限制服务端同时运行的浏览器数量。 */
async function cleanupSessions(): Promise<void> {
  for (const [id, session] of sessions) {
    if (session.expiresAt > Date.now()) continue;
    await closeBrowser(session);
    sessions.delete(id);
  }
}

// 关键变量：用户关闭扫码页或网络断开时，过期浏览器仍会在十分钟后自动释放。
setInterval(() => { void cleanupSessions(); }, 60_000).unref();

/** 从用户或管理端请求取得目标服务，并保持现有服务权限边界。 */
async function getBaiduService(runtime: ApiRuntime, request: FastifyRequest, serviceId: string, admin: boolean) {
  const actor = admin
    ? await requireSuperAdmin(request, runtime.database)
    : await requireRequestUser(request, runtime.database);
  const service = await runtime.repository.getServiceDetail(serviceId, admin ? undefined : actor.id);
  if (service.providerType !== "baidupan") {
    throw new ApiError(422, "baidupan_web_service_required", "补充网页登录仅支持百度网盘服务");
  }
  return { actor, service };
}

/** 用户只能读取自己启动、当前服务对应的扫码会话。 */
function requireSession(sessionId: string, actorUserId: string, serviceId: string): BaiduWebLoginSession {
  const session = sessions.get(sessionId);
  if (!session || session.actorUserId !== actorUserId || session.serviceId !== serviceId) {
    throw new ApiError(404, "baidupan_web_session_missing", "百度扫码会话不存在或已过期");
  }
  return session;
}

/** 从浏览器会话读取 Cookie，核对账号后写入现有加密连接。 */
async function advanceSession(runtime: ApiRuntime, session: BaiduWebLoginSession): Promise<void> {
  if (!session.context || session.state !== "waiting" || session.checking) return;
  session.checking = true;
  try {
    const cookie = selectBaiduWebCookies(await session.context.cookies());
    if (!/(?:^|;\s*)BDUSS(?:_BFESS)?=/iu.test(cookie)) return;
    if (cookie === session.lastCheckedCookie && Date.now() - session.lastCheckedAt < 10_000) return;
    session.lastCheckedCookie = cookie;
    session.lastCheckedAt = Date.now();
    const provider = runtime.providers.get("baidupan") as BaiduPanProvider;
    await provider.validateWebLoginCookie(cookie, session.expectedUserId);
    const currentService = await runtime.repository.getServiceDetail(session.serviceId, session.ownerUserId);
    if (currentService.credentialRevision !== session.credentialRevision) {
      throw new ApiError(409, "baidupan_web_connection_changed", "百度网盘连接已更新，请重新扫码");
    }
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(session.serviceId, session.ownerUserId));
    const identity = await provider.readWebLoginIdentity(connection, (nextConnection) =>
      runtime.repository.refreshActiveEncryptedConnection({
        serviceId: session.serviceId, userId: session.ownerUserId,
        credentialRevision: session.credentialRevision,
        encryptedConnection: runtime.vault.encrypt(nextConnection),
      }));
    if (identity.userId !== session.expectedUserId) {
      throw new ApiError(409, "baidupan_web_connection_changed", "原网盘账号已变化，请重新扫码");
    }
    connection.webPlaybackCookie = cookie;
    connection.webPlaybackUserId = identity.userId;
    await runtime.repository.updateConnection({
      serviceId: session.serviceId, userId: session.ownerUserId,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: provider.descriptor.credentialSchemaVersion,
      expectedRevision: session.credentialRevision,
    });
    session.state = "authorized";
    session.message = "补充网页登录成功，视频播放将优先尝试网页取链";
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-baidupan-web-login", 事件: "网页补充登录成功",
      服务ID: session.serviceId, 用户ID: session.ownerUserId,
    });
    await closeBrowser(session);
  } catch (error) {
    if (error instanceof ApiError && error.code === "baidupan_web_account_mismatch") {
      session.state = "failed";
      session.message = error.message;
      await closeBrowser(session);
    } else if (error instanceof ApiError && error.code === "baidupan_web_connection_changed") {
      session.state = "failed";
      session.message = error.message;
      await closeBrowser(session);
    } else {
      session.message = error instanceof ApiError ? error.message : "正在等待百度网页完成登录";
    }
  } finally {
    session.checking = false;
  }
}

/** 创建隔离的服务端 Chromium 会话，让用户扫描百度官网显示的二维码。 */
async function startSession(runtime: ApiRuntime, serviceId: string, ownerUserId: string,
  actorUserId: string): Promise<BaiduWebLoginSession> {
  await cleanupSessions();
  if ([...sessions.values()].filter((session) => session.browser).length >= 3) {
    throw new ApiError(429, "baidupan_web_sessions_busy", "当前扫码会话较多，请稍后重试");
  }
  const service = await runtime.repository.getServiceDetail(serviceId, ownerUserId);
  const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(serviceId, ownerUserId));
  const provider = runtime.providers.get("baidupan") as BaiduPanProvider;
  const identity = await provider.readWebLoginIdentity(connection, (nextConnection) =>
    runtime.repository.refreshActiveEncryptedConnection({ serviceId, userId: ownerUserId,
      credentialRevision: service.credentialRevision, encryptedConnection: runtime.vault.encrypt(nextConnection) }));
  if (identity.vipType !== 0 && identity.vipType !== 1) {
    throw new ApiError(409, "baidupan_web_membership_unavailable", identity.vipType === 2
      ? "SVIP 账号继续使用原有百度播放方式，无需补充网页登录"
      : "暂未确认百度账号会员状态，请稍后重试");
  }
  const session: BaiduWebLoginSession = {
    id: randomUUID(), serviceId, ownerUserId, actorUserId, expectedUserId: identity.userId,
    credentialRevision: service.credentialRevision, expiresAt: Date.now() + SESSION_LIFETIME_MS,
    browser: null, context: null, page: null, state: "waiting", message: "请扫描百度网页二维码并确认登录",
    checking: false, lastCheckedCookie: "", lastCheckedAt: 0,
  };
  try {
    const { chromium } = await import("playwright-core");
    session.browser = await chromium.launch({
      executablePath: process.env.FLYCLOUDHELPER_CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
      proxy: getOutboundBrowserProxy(),
    });
    session.context = await session.browser.newContext({ viewport: { width: 900, height: 700 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
    session.page = await session.context.newPage();
    await session.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await session.page.getByText("扫码登录", { exact: true }).first().click({ timeout: 2_000 }).catch(() => undefined);
    sessions.set(session.id, session);
    return session;
  } catch (error) {
    await closeBrowser(session);
    throw new ApiError(502, "baidupan_web_browser_unavailable", "百度网页登录页面无法打开，请检查服务端浏览器环境");
  }
}

/** 注册用户与管理员共用的百度补充网页登录接口。 */
export async function registerBaiduPanWebLoginRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const base = admin ? "/api/v1/admin/services/:serviceId/baidu-web-login"
      : "/api/v1/services/:serviceId/baidu-web-login";
    server.get<{ Params: { serviceId: string } }>(base, async (request) => {
      const { service } = await getBaiduService(runtime, request, request.params.serviceId, admin);
      const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
      return { configured: Boolean(connection.webPlaybackCookie && connection.webPlaybackUserId) };
    });
    server.post<{ Params: { serviceId: string } }>(`${base}/sessions`, async (request) => {
      const { actor, service } = await getBaiduService(runtime, request, request.params.serviceId, admin);
      const session = await startSession(runtime, service.id, service.userId, actor.id);
      return { sessionId: session.id, expiresAt: session.expiresAt };
    });
    server.get<{ Params: { serviceId: string; sessionId: string } }>(`${base}/sessions/:sessionId`, async (request) => {
      const { actor } = await getBaiduService(runtime, request, request.params.serviceId, admin);
      const session = requireSession(request.params.sessionId, actor.id, request.params.serviceId);
      if (session.expiresAt <= Date.now()) {
        await closeBrowser(session);
        sessions.delete(session.id);
        throw new ApiError(410, "baidupan_web_session_expired", "百度扫码会话已过期，请重新打开");
      }
      await advanceSession(runtime, session);
      let imageDataUrl: string | null = null;
      if (session.state === "waiting" && session.page) {
        imageDataUrl = `data:image/png;base64,${(await session.page.screenshot({ type: "png", timeout: 10_000 })).toString("base64")}`;
      }
      return { state: session.state, message: session.message, imageDataUrl };
    });
    server.delete<{ Params: { serviceId: string; sessionId: string } }>(`${base}/sessions/:sessionId`, async (request) => {
      const { actor } = await getBaiduService(runtime, request, request.params.serviceId, admin);
      const session = requireSession(request.params.sessionId, actor.id, request.params.serviceId);
      await closeBrowser(session);
      sessions.delete(session.id);
      return { cancelled: true };
    });
    server.delete<{ Params: { serviceId: string } }>(base, async (request) => {
      const { actor, service } = await getBaiduService(runtime, request, request.params.serviceId, admin);
      for (const [id, session] of sessions) {
        if (session.serviceId !== service.id || session.actorUserId !== actor.id) continue;
        await closeBrowser(session);
        sessions.delete(id);
      }
      const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.userId));
      delete connection.webPlaybackCookie;
      delete connection.webPlaybackUserId;
      await runtime.repository.updateConnection({ serviceId: service.id, userId: service.userId,
        encryptedConnection: runtime.vault.encrypt(connection),
        providerSchemaVersion: runtime.providers.get("baidupan").descriptor.credentialSchemaVersion,
        expectedRevision: service.credentialRevision });
      return { configured: false };
    });
  }
}
