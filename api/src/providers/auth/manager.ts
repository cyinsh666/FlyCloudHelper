import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import type {
  CloudAuthorizationDriver,
  CloudAuthorizationStartOptions,
  CloudAuthorizationState,
  CloudAuthorizationStatus,
} from "./types.js";

const AUTHORIZATION_RETENTION_MS = 10 * 60 * 1_000;

/** 服务端短期授权会话，driverState 和 connection 严禁返回页面。 */
interface CloudAuthorizationSession extends CloudAuthorizationStatus {
  actorUserId: string;
  targetUserId: string;
  expiresAtMs: number;
  retainUntilMs: number;
  nextPollAtMs: number;
  driverState: Record<string, unknown>;
  connection: Record<string, unknown> | null;
  completing: boolean;
  consumed: boolean;
}

/** 管理四种新网盘授权会话、用户归属和一次性连接领取。 */
export class CloudAuthorizationManager {
  private readonly drivers = new Map<string, CloudAuthorizationDriver>();
  private readonly sessions = new Map<string, CloudAuthorizationSession>();

  /** 注册启用的 Provider 授权驱动。 */
  public register(driver: CloudAuthorizationDriver): void {
    this.drivers.set(driver.providerType, driver);
  }

  /** 判断指定 Provider 是否支持 FlyCloudHelper 内部授权。 */
  public supports(providerType: string): boolean {
    return this.drivers.has(providerType);
  }

  /** 判断会话是否属于当前操作者，供凭据落库后选择正确的消费器。 */
  public hasSession(actorUserId: string, authorizationSessionId: string): boolean {
    return this.sessions.get(authorizationSessionId)?.actorUserId === actorUserId;
  }

  /** 校验路由中的 Provider 与会话真实 Provider 一致。 */
  public requireSessionProvider(actorUserId: string, authorizationSessionId: string, providerType: string): void {
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (session.providerType !== providerType) {
      throw new ApiError(403, "provider_auth_session_forbidden", "授权会话不属于当前网盘类型");
    }
  }

  /** 创建并绑定操作者、目标用户的短期授权会话。 */
  public async start(
    providerType: string,
    actorUserId: string,
    targetUserId: string,
    options: CloudAuthorizationStartOptions = {},
    signal?: AbortSignal,
  ): Promise<CloudAuthorizationStatus> {
    await this.cleanupExpired();
    const driver = this.requireDriver(providerType);
    const started = await driver.start(options, signal);
    const now = Date.now();
    const expiresInSeconds = Math.max(30, Math.floor(started.expiresInSeconds));
    const pollIntervalSeconds = Math.max(1, Math.floor(started.pollIntervalSeconds));
    const session: CloudAuthorizationSession = {
      authorizationSessionId: randomUUID(),
      providerType,
      authMethod: started.authMethod,
      state: "waiting",
      qrCodeContent: started.qrCodeContent,
      qrCodeImageUrl: started.qrCodeImageUrl ?? "",
      authorizationUrl: started.authorizationUrl ?? "",
      expiresAt: new Date(now + expiresInSeconds * 1_000).toISOString(),
      pollIntervalSeconds,
      accountSummary: null,
      errorCode: null,
      message: null,
      actorUserId,
      targetUserId,
      expiresAtMs: now + expiresInSeconds * 1_000,
      retainUntilMs: now + expiresInSeconds * 1_000 + AUTHORIZATION_RETENTION_MS,
      nextPollAtMs: now,
      driverState: started.driverState,
      connection: null,
      completing: false,
      consumed: false,
    };
    this.sessions.set(session.authorizationSessionId, session);
    return this.toPublicStatus(session);
  }

  /** 轮询一次 Provider 状态；到达间隔前直接返回当前状态。 */
  public async poll(
    actorUserId: string,
    authorizationSessionId: string,
    signal?: AbortSignal,
  ): Promise<CloudAuthorizationStatus> {
    await this.cleanupExpired();
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (this.isTerminal(session.state) || session.consumed) return this.toPublicStatus(session);
    if (Date.now() >= session.expiresAtMs) {
      await this.finishSession(session, "expired", "provider_auth_session_expired", "二维码已过期，请重新扫码");
      return this.toPublicStatus(session);
    }
    if (Date.now() < session.nextPollAtMs) return this.toPublicStatus(session);
    try {
      const result = await this.requireDriver(session.providerType).poll(session.driverState, signal);
      session.state = result.state;
      session.pollIntervalSeconds = Math.max(1, Math.floor(result.retryAfterSeconds || session.pollIntervalSeconds));
      session.nextPollAtMs = Date.now() + session.pollIntervalSeconds * 1_000;
      session.errorCode = result.errorCode ?? null;
      session.message = result.message ?? null;
      if (["rejected", "expired", "cancelled", "failed"].includes(session.state)) {
        await this.disposeDriverState(session);
      }
      return this.toPublicStatus(session);
    } catch (error) {
      // 上游偶发网络错误不销毁二维码，页面可以按原会话继续轮询。
      session.errorCode = error instanceof ApiError ? error.code : "provider_auth_poll_failed";
      session.message = error instanceof Error ? error.message.slice(0, 200) : "查询扫码状态失败，请稍后重试";
      throw error;
    }
  }

  /** 扫码确认后交换最终连接，连接仍只保留在服务端。 */
  public async complete(
    actorUserId: string,
    authorizationSessionId: string,
    signal?: AbortSignal,
  ): Promise<CloudAuthorizationStatus> {
    await this.cleanupExpired();
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (session.state === "authorized" && session.connection) return this.toPublicStatus(session);
    if (session.completing || session.consumed) {
      throw new ApiError(409, "provider_auth_session_consumed", "授权会话正在处理或已经使用");
    }
    if (Date.now() >= session.expiresAtMs) {
      await this.finishSession(session, "expired", "provider_auth_session_expired", "二维码已过期，请重新扫码");
      throw new ApiError(410, "provider_auth_session_expired", "二维码已过期，请重新扫码");
    }
    if (session.state !== "confirmed") {
      await this.poll(actorUserId, authorizationSessionId, signal);
    }
    if (session.state !== "confirmed") {
      throw new ApiError(409, "provider_auth_not_confirmed", "请先在对应网盘客户端扫码并确认");
    }
    session.completing = true;
    try {
      const result = await this.requireDriver(session.providerType).complete(session.driverState, signal);
      session.connection = result.connection;
      session.accountSummary = result.accountSummary;
      session.state = "authorized";
      session.errorCode = null;
      session.message = "授权成功，可以创建或更新服务";
      session.qrCodeContent = "";
      session.qrCodeImageUrl = "";
      session.authorizationUrl = "";
      session.retainUntilMs = Date.now() + AUTHORIZATION_RETENTION_MS;
      return this.toPublicStatus(session);
    } catch (error) {
      // 尚未确认属于正常交互状态；仅真正的换取凭据失败才结束会话。
      if (!(error instanceof ApiError && error.code === "provider_auth_not_confirmed")) {
        this.applySafeError(session, error);
        await this.disposeDriverState(session);
      }
      throw error;
    } finally {
      session.completing = false;
    }
  }

  /** 服务创建或连接替换时读取一次已授权连接。 */
  public getAuthorizedConnection(
    actorUserId: string,
    targetUserId: string,
    providerType: string,
    authorizationSessionId: string,
  ): Record<string, unknown> {
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (session.targetUserId !== targetUserId || session.providerType !== providerType) {
      throw new ApiError(403, "provider_auth_session_forbidden", "授权会话不属于当前服务或用户");
    }
    if (session.state !== "authorized" || !session.connection || session.consumed) {
      throw new ApiError(409, "provider_auth_not_completed", "网盘授权尚未完成或已经使用");
    }
    return { ...session.connection };
  }

  /** 服务凭据成功落库后消费授权连接并擦除敏感状态。 */
  public consume(actorUserId: string, authorizationSessionId: string | null): void {
    if (!authorizationSessionId) return;
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    session.consumed = true;
    session.connection = null;
    session.driverState = {};
    this.sessions.delete(authorizationSessionId);
  }

  /** 用户主动取消并立即清理会话。 */
  public async cancel(actorUserId: string, authorizationSessionId: string): Promise<void> {
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    await this.finishSession(session, "cancelled", null, "已取消授权");
    this.sessions.delete(authorizationSessionId);
  }

  /** 清理已完成或超过保留期限的授权会话。 */
  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now < session.retainUntilMs && !session.consumed) continue;
      await this.disposeDriverState(session);
      session.connection = null;
      this.sessions.delete(sessionId);
    }
  }

  /** 查找已启用的 Provider 授权驱动。 */
  private requireDriver(providerType: string): CloudAuthorizationDriver {
    const driver = this.drivers.get(providerType);
    if (!driver) throw new ApiError(422, "provider_auth_unsupported", "当前网盘未启用内部扫码登录");
    return driver;
  }

  /** 校验会话只能由创建它的操作者访问。 */
  private requireOwnedSession(actorUserId: string, authorizationSessionId: string): CloudAuthorizationSession {
    const session = this.sessions.get(authorizationSessionId);
    if (!session) throw new ApiError(404, "provider_auth_session_not_found", "授权会话不存在或已经失效");
    if (session.actorUserId !== actorUserId) {
      throw new ApiError(403, "provider_auth_session_forbidden", "授权会话不属于当前操作者");
    }
    return session;
  }

  /** 设置终态并清理 Provider 临时材料。 */
  private async finishSession(
    session: CloudAuthorizationSession,
    state: CloudAuthorizationState,
    errorCode: string | null,
    message: string | null,
  ): Promise<void> {
    session.state = state;
    session.errorCode = errorCode;
    session.message = message;
    session.connection = null;
    await this.disposeDriverState(session);
  }

  /** 调用 Provider 清理逻辑后移除内存中的扫码材料。 */
  private async disposeDriverState(session: CloudAuthorizationSession): Promise<void> {
    await this.drivers.get(session.providerType)?.dispose?.(session.driverState);
    session.driverState = {};
    session.qrCodeContent = "";
    session.qrCodeImageUrl = "";
    session.authorizationUrl = "";
  }

  /** 将异常转换成页面可见终态，但不读取上游正文或凭据。 */
  private applySafeError(session: CloudAuthorizationSession, error: unknown): void {
    session.state = "failed";
    session.errorCode = error instanceof ApiError ? error.code : "provider_auth_failed";
    session.message = error instanceof Error ? error.message.slice(0, 200) : "网盘授权失败，请重新扫码";
  }

  /** 返回不含内部状态和连接的安全快照。 */
  private toPublicStatus(session: CloudAuthorizationSession): CloudAuthorizationStatus {
    return {
      authorizationSessionId: session.authorizationSessionId,
      providerType: session.providerType,
      authMethod: session.authMethod,
      state: session.state,
      qrCodeContent: session.qrCodeContent,
      qrCodeImageUrl: session.qrCodeImageUrl,
      authorizationUrl: session.authorizationUrl,
      expiresAt: session.expiresAt,
      pollIntervalSeconds: session.pollIntervalSeconds,
      accountSummary: session.accountSummary,
      errorCode: session.errorCode,
      message: session.message,
    };
  }

  /** 判断当前状态是否不再向上游轮询。 */
  private isTerminal(state: CloudAuthorizationState): boolean {
    return ["authorized", "rejected", "expired", "cancelled", "failed"].includes(state);
  }
}
