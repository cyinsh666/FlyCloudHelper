import { createHash } from "node:crypto";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError } from "../errors.js";
import type { NativeQuery, NativeScanOptions, NativeStored, NativeStoredRow } from "./types.js";

/** 固定长度实体散列，只用于控制键长，不承担密码加密。 */
export function nativeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** 稳定的入口账号作用域，不依靠可编辑用户名。 */
export function nativeScope(serviceId: string, accountId: string): string {
  return nativeHash(JSON.stringify([serviceId, accountId]));
}

/** 生成短命名空间主键，多参数以 JSON 保留边界，避免拼接歧义。 */
export function nativeKey(kind: string, ...ids: string[]): string {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind)) throw new ApiError(500, "native_storage_key_invalid", "原生听书存储键不合法");
  return `ab1:${kind}:${nativeHash(JSON.stringify(ids))}`;
}

/** 唯一键冲突在三种既有数据库中映射为同一种可重试 CAS 冲突。 */
function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const detail = error as { code?: unknown; errno?: unknown };
  return detail.code === "23505" || detail.code === "SQLITE_CONSTRAINT_UNIQUE" || detail.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || detail.errno === 1062 || detail.code === "ER_DUP_ENTRY" || detail.code === "SQLITE_CONSTRAINT";
}

/** 在已有 system_settings 主键上存小对象、条件更新和有界范围索引。 */
export class NativeStore {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 仅允许原生协议的命名空间，避免覆盖既有配置。 */
  private assertKey(key: string): void {
    if (!/^ab1:[\x21-\x7e]+$/.test(key) || key.length > 100) throw new ApiError(500, "native_storage_key_invalid", "原生听书存储键不合法");
  }

  /** 读取单条小状态，格式损坏时不能伪装为不存在。 */
  public async get<T>(key: string, query: NativeQuery = this.database.query): Promise<NativeStored<T> | null> {
    this.assertKey(key);
    const row = await query("system_settings").where({ setting_key: key }).select("setting_value", "revision").first();
    if (!row) return null;
    try { return { value: JSON.parse(String(row.setting_value)) as T, revision: Number(row.revision) }; }
    catch { throw new ApiError(500, "native_storage_corrupt", "原生听书配置无法读取"); }
  }

  /** null 只允许首次创建，更新必须携带实际行版本。 */
  public async put<T>(key: string, value: T, expectedRevision: number | null, query: NativeQuery = this.database.query): Promise<number> {
    this.assertKey(key);
    const payload = JSON.stringify(value);
    if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > 49152) throw new ApiError(413, "native_state_too_large", "原生听书单条状态过大");
    const now = new Date().toISOString();
    if (expectedRevision === null) {
      try {
        await query("system_settings").insert({ setting_key: key, setting_value: payload, revision: 1, updated_by_user_id: null, created_at: now, updated_at: now });
        return 1;
      } catch (error) {
        if (isUniqueConflict(error)) throw new ApiError(409, "native_state_conflict", "原生听书状态已变化，请刷新后重试");
        throw error;
      }
    }
    // 关键变量：既有 revision 列按有符号 32 位整数约束，禁止溢出回绕。
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= 2147483647) throw new ApiError(409, "native_revision_exhausted", "原生听书状态版本无法继续更新");
    const changed = await query("system_settings").where({ setting_key: key, revision: expectedRevision }).update({ setting_value: payload, revision: expectedRevision + 1, updated_at: now });
    if (Number(changed) !== 1) throw new ApiError(409, "native_state_conflict", "原生听书状态已变化，请刷新后重试");
    return expectedRevision + 1;
  }

  /** 带行版本删除，不能静默删除并发更新后的状态。 */
  public async remove(key: string, expectedRevision: number, query: NativeQuery = this.database.query): Promise<void> {
    this.assertKey(key);
    const changed = await query("system_settings").where({ setting_key: key, revision: expectedRevision }).delete();
    if (Number(changed) !== 1) throw new ApiError(409, "native_state_conflict", "原生听书状态已变化，请刷新后重试");
  }

  /** 写事务复核身份前按固定顺序锁行；SQLite 依靠事务写入冲突及有界重试。 */
  public async lock(key: string, query: NativeQuery): Promise<void> {
    this.assertKey(key);
    let builder = query("system_settings").where({ setting_key: key }).select("setting_key");
    const client = String(query.client.config.client);
    if (!client.includes("sqlite")) builder = builder.forUpdate();
    await builder.first();
  }

  /** 通过主键前缀上下界分页，绝不先取全量配置后切片。 */
  public async scan<T>(prefix: string, options: NativeScanOptions = {}, query: NativeQuery = this.database.query): Promise<Array<NativeStoredRow<T>>> {
    this.assertKey(`${prefix}x`);
    const limit = options.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new ApiError(400, "invalid_limit", "分页数量必须在 1 到 100 之间");
    // 关键变量：递增前缀末字符得到真正的排他上界，避免使用特殊控制字符参与数据库排序。
    const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
    let builder = query("system_settings").select("setting_key", "setting_value", "revision").where("setting_key", ">=", prefix).where("setting_key", "<", upperBound);
    if (options.after) { this.assertKey(options.after); builder = builder.where("setting_key", ">", options.after); }
    if (options.before) { this.assertKey(options.before); builder = builder.where("setting_key", "<", options.before); }
    const rows = await builder.orderBy("setting_key", options.desc ? "desc" : "asc").limit(limit);
    return rows.map((row) => {
      try { return { key: String(row.setting_key), value: JSON.parse(String(row.setting_value)) as T, revision: Number(row.revision) }; }
      catch { throw new ApiError(500, "native_storage_corrupt", "原生听书配置无法读取"); }
    });
  }

  /** 相关实体、索引及版本必须共用数据库事务提交。 */
  public async transaction<T>(operation: (query: NativeQuery) => Promise<T>): Promise<T> {
    return this.database.query.transaction(async (transaction) => operation(transaction));
  }
}
