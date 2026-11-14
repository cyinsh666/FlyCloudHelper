import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError } from "../errors.js";

/** TG 绑定只保存账号关系，不复制网盘凭据。 */
export interface TelegramBinding {
  userId: string;
  telegramId: string;
  chatId: string;
  displayName: string;
  enabled: boolean;
  boundAt: string;
  generation: string;
}

/** 默认选项独立于现有网页设置，自动入库按网盘开启。 */
export interface TelegramPreferences {
  defaultServiceId: string | null;
  notifications: boolean;
  autoImportServiceIds: string[];
}

/** 转存提交结果和后续阶段持久化，重启后不会重新提交分享。 */
export interface TelegramTransferTask {
  id: string;
  userId: string;
  serviceId: string;
  title: string;
  origin: "telegram" | "web" | "subscription";
  remoteTaskId: string | null;
  stage: "submitting" | "transfer" | "organize_wait" | "organize_starting" | "organize" | "scan" | "completed" | "failed";
  autoImport: boolean;
  planId?: string;
  organizeJobId?: string;
  scanJobIds?: string[];
  /** 同一物理网盘关联多个库时，按来源逐个扫描，避免触发已有单写限制。 */
  scanSources?: Array<{ libraryId: string; sourceId: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  notificationPending?: boolean;
  /** 订阅必须等接收根命名完成后才允许整理，不能提前轮询触发。 */
  subscriptionReady?: boolean;
}

const prefix = "telegram_bot:";
const codeKeyPrefix = "code:hash:";

/** 兼容已有绑定码。新码额外保存用于网页对照状态的公开标识。 */
interface StoredBindingCode {
  hash: string;
  expiresAt: string;
  id?: string;
}

/** 已发放绑定码的公开状态，不包含可用于绑定的明文。 */
export interface TelegramBindingCode {
  id: string;
  expiresAt: string;
}

/** 机器人数据复用现有配置表，绑定、码和任务同样支持远程数据库。 */
export class TelegramBotStore {
  public constructor(public readonly database: FlyCloudHelperDatabase) {}

  /** 读取指定键，缺省值由业务调用方决定。 */
  public async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.database.query("system_settings").where({ setting_key: prefix + key }).first();
    return row ? JSON.parse(String(row.setting_value)) as T : fallback;
  }

  /** 保存普通选项；唯一键避免多个页面插入同一项。 */
  public async put(key: string, value: unknown, userId: string | null = null): Promise<void> {
    const row = this.row(key, value, userId);
    await this.database.query("system_settings").insert(row).onConflict("setting_key")
      .merge({ setting_value: row.setting_value, updated_by_user_id: userId, updated_at: row.updated_at });
  }

  /** 列出一个业务前缀下的持久记录，可限制用户归属。 */
  public async list<T>(key: string, userId?: string): Promise<T[]> {
    const query = this.database.query("system_settings").whereLike("setting_key", prefix + key + "%");
    if (userId) query.where({ updated_by_user_id: userId });
    const rows = await query.orderBy("created_at", "desc");
    return rows.map((row) => JSON.parse(String(row.setting_value)) as T);
  }

  /** 生成独立的十分钟一次性绑定码，仅返回一次明文。 */
  public async issueCode(userId: string): Promise<TelegramBindingCode & { code: string }> {
    const code = randomBytes(6).toString("hex").toUpperCase();
    const hash = this.hash(code);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await this.database.query.transaction(async (transaction) => {
      await this.lockUser(transaction, userId);
      const user = await this.database.findPublicUserById(userId, transaction);
      if (user.status !== "active") throw new ApiError(409, "telegram_user_inactive", "只能为正常用户生成绑定码");
      const previousCodes = await this.codeRows(userId, transaction);
      const now = new Date().toISOString();
      const expiredKeys = previousCodes.filter((row) => row.value.expiresAt <= now).map((row) => row.key);
      if (expiredKeys.length) {
        await transaction("system_settings").whereIn("setting_key", expiredKeys).delete();
      }
      await transaction("system_settings").insert(this.row(codeKeyPrefix + hash, { id, hash, expiresAt }, userId));
    });
    return { id, code, expiresAt };
  }

  /** 网页读取未使用的有效码状态，响应中只含公开标识和有效期。 */
  public async listCodes(userId: string): Promise<TelegramBindingCode[]> {
    const now = new Date().toISOString();
    return (await this.codeRows(userId)).filter((row) => row.value.expiresAt > now)
      .map(({ value }) => ({ id: value.id ?? "legacy", expiresAt: value.expiresAt }));
  }

  /** 查询用户的所有绑定，同时读取新键和历史单账号键。 */
  public async listBindings(userId: string): Promise<TelegramBinding[]> {
    const rows = await this.bindingRows(userId, this.database.query);
    return rows.map((row) => row.binding);
  }

  /** 在事务内消费指定绑定码，TG 账号的唯一键阻止它绑定到多个用户。 */
  public async bind(code: string, telegramId: string, chatId: string, displayName: string): Promise<TelegramBinding> {
    const hash = this.hash(code.trim().toUpperCase());
    const query = this.database.query;
    let found = await query("system_settings").where({ setting_key: prefix + codeKeyPrefix + hash }).first();
    if (!found) {
      // 旧绑定码按用户存放，保留查找路径直至这些码自然失效。
      const legacyRows = await query("system_settings").whereLike("setting_key", prefix + "code:%")
        .where("setting_key", "not like", prefix + codeKeyPrefix + "%");
      found = legacyRows.find((row) => (JSON.parse(String(row.setting_value)) as StoredBindingCode).hash === hash);
    }
    if (!found) throw new ApiError(422, "telegram_code_invalid", "绑定码无效或已使用，请重新获取");
    const userId = String(found.updated_by_user_id ?? "");
    const codeKey = String(found.setting_key);
    return this.database.query.transaction(async (transaction) => {
      await this.lockUser(transaction, userId);
      const user = await this.database.findPublicUserById(userId, transaction);
      if (user.status !== "active") throw new ApiError(403, "telegram_user_disabled", "对应的云助手用户不可用");
      const current = await transaction("system_settings").where({ setting_key: codeKey, updated_by_user_id: userId }).first();
      const value = current ? JSON.parse(String(current.setting_value)) as StoredBindingCode : null;
      if (!value || value.hash !== hash || value.expiresAt <= new Date().toISOString()) {
        throw new ApiError(422, "telegram_code_expired", "绑定码已失效，请重新获取");
      }
      const identityKey = "identity:" + telegramId;
      const exists = await transaction("system_settings").where({ setting_key: prefix + identityKey }).first();
      if (exists) throw new ApiError(409, "telegram_already_bound", "该 TG 账号已经绑定，请先解绑");
      const binding: TelegramBinding = { userId, telegramId, chatId, displayName: displayName.slice(0, 100),
        enabled: true, boundAt: new Date().toISOString(), generation: randomUUID() };
      await transaction("system_settings").insert([
        this.row("binding:tg:" + telegramId, binding, userId), this.row(identityKey, { userId }, userId),
      ]);
      await transaction("system_settings").where({ setting_key: codeKey }).delete();
      return binding;
    }).catch((error: unknown) => {
      const dbError = error as { code?: string };
      if (["23505", "ER_DUP_ENTRY", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"].includes(dbError.code ?? "")) {
        throw new ApiError(409, "telegram_already_bound", "该 TG 账号已经绑定，请先解绑");
      }
      throw error;
    });
  }

  /** 每次消息和按钮操作重新读取账号状态，停用立即生效。 */
  public async resolve(telegramId: string): Promise<TelegramBinding | null> {
    const identity = await this.get<{ userId: string } | null>("identity:" + telegramId, null);
    if (!identity) return null;
    const binding = await this.get<TelegramBinding | null>("binding:tg:" + telegramId, null)
      ?? await this.get<TelegramBinding | null>("binding:" + identity.userId, null);
    if (!binding || binding.userId !== identity.userId || binding.telegramId !== telegramId || !binding.enabled) return null;
    const user = await this.database.findPublicUserById(binding.userId).catch(() => null);
    return user?.status === "active" ? binding : null;
  }

  /** 操作指定 TG 账号，其他账号、未用绑定码和用户任务继续有效。 */
  public async manageBinding(userId: string, action: "enable" | "disable" | "unbind", telegramId?: string): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      await this.lockUser(transaction, userId);
      const rows = await this.bindingRows(userId, transaction);
      if (!telegramId && rows.length > 1) throw new ApiError(422, "telegram_account_required", "请选择要操作的 TG 账号");
      const row = telegramId ? rows.find(({ binding }) => binding.telegramId === telegramId) : rows[0];
      if (!row) return;
      const { key, binding } = row;
      if (action === "unbind") {
        await transaction("system_settings").where({ updated_by_user_id: userId })
          .whereIn("setting_key", [key, prefix + "identity:" + binding.telegramId]).delete();
      } else {
        binding.enabled = action === "enable";
        binding.generation = randomUUID();
        await transaction("system_settings").where({ setting_key: key }).update({ setting_value: JSON.stringify(binding) });
      }
    });
  }

  /** 默认关闭自动入库，个人通知默认开启。 */
  public preferences(userId: string): Promise<TelegramPreferences> {
    return this.get("preferences:" + userId, { defaultServiceId: null, notifications: true, autoImportServiceIds: [] });
  }

  /** 同一云助手用户的多个 TG 可并行操作，按账号锁读取和更新共享设置。 */
  public async updatePreferences(userId: string, update: (value: TelegramPreferences) => void): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      await this.lockUser(transaction, userId);
      const key = "preferences:" + userId;
      const current = await transaction("system_settings").where({ setting_key: prefix + key }).first();
      const value: TelegramPreferences = current ? JSON.parse(String(current.setting_value))
        : { defaultServiceId: null, notifications: true, autoImportServiceIds: [] };
      update(value);
      const row = this.row(key, value, userId);
      await transaction("system_settings").insert(row).onConflict("setting_key")
        .merge({ setting_value: row.setting_value, updated_by_user_id: userId, updated_at: row.updated_at });
    });
  }

  /** 插入任务仅允许一次，用于订阅完成事件去重。 */
  public async insertTask(task: TelegramTransferTask): Promise<void> {
    await this.database.query("system_settings").insert(this.row("task:" + task.id, task, task.userId))
      .onConflict("setting_key").ignore();
  }

  /** 保留实际键名，旧绑定可以直接管理，无需改写数据。 */
  private async bindingRows(userId: string, query: Knex | Knex.Transaction) {
    const rows = await query("system_settings").where({ updated_by_user_id: userId })
      .whereLike("setting_key", prefix + "binding:%").orderBy("created_at", "desc");
    return rows.map((row) => ({ key: String(row.setting_key), binding: JSON.parse(String(row.setting_value)) as TelegramBinding }));
  }

  /** 读取用户的绑定码，供列表显示与生成时清理过期记录共用。 */
  private async codeRows(userId: string, query: Knex | Knex.Transaction = this.database.query) {
    const rows = await query("system_settings").where({ updated_by_user_id: userId })
      .whereLike("setting_key", prefix + "code:%").orderBy("created_at", "desc");
    return rows.map((row) => ({ key: String(row.setting_key), value: JSON.parse(String(row.setting_value)) as StoredBindingCode }));
  }

  /** 非 SQLite 使用账号行锁，SQLite 依靠写事务和唯一键保证原子性。 */
  private async lockUser(transaction: Knex.Transaction, userId: string): Promise<void> {
    const query = transaction("user_accounts").where({ id: userId });
    if (!String(transaction.client.config.client).includes("sqlite")) query.forUpdate();
    if (!(await query.first())) throw new ApiError(404, "user_not_found", "用户不存在");
  }

  /** 统一构建现有配置表的必填列。 */
  private row(key: string, value: unknown, userId: string | null) {
    const now = new Date().toISOString();
    return { setting_key: prefix + key, setting_value: JSON.stringify(value), revision: 1,
      updated_by_user_id: userId, created_at: now, updated_at: now };
  }

  /** 绑定码只保存摘要，日志和持久配置均不保存明文。 */
  private hash(code: string): string { return createHash("sha256").update(code).digest("hex"); }
}
