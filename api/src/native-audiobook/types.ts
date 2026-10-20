import type { Knex } from "knex";
import type { MediaLibraryRecord } from "../domain.js";

/** 原生协议存储允许在已有事务中复用同一连接。 */
export type NativeQuery = Knex | Knex.Transaction;

/** 协议鉴权只读取媒体库身份及展示名称，不执行全库数量聚合。 */
export type NativeLibraryAccess = Pick<MediaLibraryRecord, "id" | "userId" | "displayName" | "dataType" | "libraryKind" | "status">;

/** 服务入口同时界定独立账号域，关联既有实际听书媒体库。 */
export interface NativeService {
  ServiceId: string;
  OwnerUserId: string;
  Name: string;
  Mode: "SingleLibrary" | "MultiLibrary";
  PathSuffix: string;
  LibraryIds: string[];
  Enabled: boolean;
  RelayPlaybackEnabled: boolean;
  CredentialRevision: number;
  PermissionsRevision: string;
  CreatedAt: string;
  UpdatedAt: string;
  /** 删除期间关闭新写入，分批清理失败后允许继续删除。 */
  Deleting?: boolean;
  /** 移除关联后分批清理旧授权，期间阻止管理写入，失败后可继续。 */
  LibraryGrantCleanupPending?: boolean;
}

/** 账号只在所属入口内唯一，密码校验值禁止用于公开投影。 */
export interface NativeAccount {
  AccountId: string;
  ServiceId: string;
  Username: string;
  DisplayName: string;
  PasswordHash: string;
  AllowedLibraryIds: string[];
  Enabled: boolean;
  CanDownload: boolean;
  CredentialRevision: number;
  PermissionsRevision: string;
  CreatedAt: string;
  UpdatedAt: string;
  /** 删除期间阻止新状态写入，不影响实际媒体库。 */
  Deleting?: boolean;
}

/** 安装级设备信息，不使用硬件唯一号。 */
export interface NativeDeviceInfo {
  DeviceId: string;
  DeviceName: string;
  Client: string;
  Version: string;
}

/** 每次登录建立独立设备会话，仅保存访问令牌的摘要。 */
export interface NativeAuthSession {
  AuthSessionId: string;
  ServiceId: string;
  AccountId: string;
  TokenHash: string;
  AccountCredentialRevision: number;
  ServiceCredentialRevision: number;
  DeviceInfo: NativeDeviceInfo;
  CreatedAt: string;
  ExpiresAt: string;
}

/** 已通过当前入口、账号和设备令牌校验的请求上下文。 */
export interface NativeContext {
  service: NativeService;
  account: NativeAccount;
  authSession: NativeAuthSession;
  basePath: string;
}

/** KV 返回的行版本用于数据库 CAS，不与业务修订号混用。 */
export interface NativeStored<T> {
  value: T;
  revision: number;
}

/** 有界主键范围扫描的单条结果。 */
export interface NativeStoredRow<T> extends NativeStored<T> {
  key: string;
}

/** 范围边界都是完整主键，避免 OFFSET 或整表加载。 */
export interface NativeScanOptions {
  after?: string;
  before?: string;
  limit?: number;
  desc?: boolean;
}
