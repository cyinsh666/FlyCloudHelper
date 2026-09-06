/** 云盘授权页可见状态，不包含 Token、Cookie 和设备码。 */
export type CloudAuthorizationState =
  | "waiting"
  | "scanned"
  | "confirmed"
  | "authorized"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed";

/** 云盘授权会话的公开字段。 */
export interface CloudAuthorizationStatus {
  authorizationSessionId: string;
  providerType: string;
  authMethod: string;
  state: CloudAuthorizationState;
  qrCodeContent: string;
  qrCodeImageUrl: string;
  authorizationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  accountSummary: string | null;
  errorCode: string | null;
  message: string | null;
}

/** Provider 创建授权会话后交给通用管理器保存的结果。 */
export interface CloudAuthorizationStartResult {
  authMethod: string;
  qrCodeContent: string;
  qrCodeImageUrl?: string;
  authorizationUrl?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
  driverState: Record<string, unknown>;
}

/** Provider 单次轮询后返回的新状态。 */
export interface CloudAuthorizationPollResult {
  state: CloudAuthorizationState;
  retryAfterSeconds: number;
  errorCode?: string | null;
  message?: string | null;
}

/** Provider 完成授权后返回的连接只保存在服务端短会话内。 */
export interface CloudAuthorizationCompleteResult {
  connection: Record<string, unknown>;
  accountSummary: string | null;
}

/** 页面启动授权时允许提交的非敏感选项。 */
export interface CloudAuthorizationStartOptions {
  clientType?: string;
}

/** 每种网盘独立实现登录协议，通用管理器只负责编排与归属。 */
export interface CloudAuthorizationDriver {
  readonly providerType: string;
  start(options: CloudAuthorizationStartOptions, signal?: AbortSignal): Promise<CloudAuthorizationStartResult>;
  poll(driverState: Record<string, unknown>, signal?: AbortSignal): Promise<CloudAuthorizationPollResult>;
  complete(
    driverState: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CloudAuthorizationCompleteResult>;
  /** 会话取消或清理时擦除 Provider 自己持有的短期状态。 */
  dispose?(driverState: Record<string, unknown>): Promise<void> | void;
}
