import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { createUsernameLookup, hashPassword, verifyPassword } from "../auth.js";
import { CredentialVault } from "../secrets.js";
import { ApiError, validationError } from "../errors.js";
import { buildAbsPath } from "../abs-path.js";
import type { AbsAccountRecord, AbsContext, AbsLibraryRow } from "./types.js";

interface AbsClaims {
  userId: string;
  libraryId: string;
  username: string;
  revision: number;
  type?: "access" | "refresh";
  sessionId?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

/** Socket 握手后保存的认证身份；短期 JWT 仅用于握手，不作为长连接的持续时钟。 */
export interface AbsSocketAuthorization {
  libraryId: string;
  accountId: string;
  credentialRevision: number;
  /** 新认证绑定持久登录会话；旧永久令牌通过凭据修订撤销。 */
  authSessionId: string | null;
}

/** 账号管理、真实 HS256 JWT 和刷新会话均独立于云助手管理登录。 */
export class AbsAccessService {
  private readonly jwtKey: Buffer;
  private readonly vault: CredentialVault;
  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    config: ApiConfig,
  ) {
    this.jwtKey = createHmac("sha256", config.credentialMasterKey)
      .update("flycloud-helper:abs:jwt:v1")
      .digest();
    this.vault = new CredentialVault(config.credentialMasterKey);
  }

  /** 根据库专属路径读取协议状态；禁用协议不影响网盘凭据。 */
  public async getLibrary(pathSuffix: string): Promise<AbsLibraryRow> {
    const row = await this.database
      .query("media_libraries")
      .where({
        abs_path_suffix_lookup: pathSuffix.toLowerCase(),
        data_type: "audiobook",
        status: "active",
        abs_enabled: 1,
      })
      .first();
    if (!row) throw new ApiError(404, "abs_library_not_found", "ABS 有声书服务未启用");
    return row as AbsLibraryRow;
  }

  /** 列出单库独立 ABS 账号。 */
  public async listByLibrary(libraryId: string): Promise<AbsAccountRecord[]> {
    return (
      await this.database
        .query("library_abs_accounts")
        .where({ library_id: libraryId })
        .orderBy("created_at", "asc")
    ).map(mapAccount);
  }

  /** 只复用用户已创建的账号，开启协议本身不隐式创建账号。 */
  public async ensureForLibrary(libraryId: string): Promise<AbsAccountRecord> {
    const existing = (await this.listByLibrary(libraryId))[0];
    if (existing) return existing;
    throw new ApiError(409, "abs_account_required", "请先创建 ABS 协议访问账号");
  }

  /** 新建账号；不自动复制 Jellyfin/Emby 用户和播放数据。 */
  public async createAccount(
    libraryId: string,
    input: { username: unknown; password?: unknown; canDownload?: boolean },
  ): Promise<AbsAccountRecord> {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    const exists = await this.database
      .query("library_abs_accounts")
      .where({ library_id: libraryId, username_lookup: createUsernameLookup(username) })
      .first();
    if (exists) throw new ApiError(409, "abs_username_exists", "ABS 用户名已存在");
    if (
      !(await this.database.query("media_libraries").where({ id: libraryId, data_type: "audiobook" }).first())
    )
      throw new ApiError(404, "abs_library_not_found", "有声书媒体库不存在");
    const now = Date.now();
    const id = randomUUID();
    try {
      await this.database.query("library_abs_accounts").insert({
        id,
        library_id: libraryId,
        username,
        username_lookup: createUsernameLookup(username),
        password_hash: await hashPassword(password),
        password_required: password ? 1 : 0,
        credential_revision: 1,
        status: "active",
        can_download: input.canDownload === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      throwAccountWriteError(error);
    }
    return this.getAccount(libraryId, id);
  }

  /** 修改用户名、密码或启停后撤销旧凭据，下载权限变化立即生效。 */
  public async updateAccount(
    libraryId: string,
    accountId: string,
    input: { username?: unknown; password?: unknown; status?: "active" | "disabled"; canDownload?: boolean },
  ): Promise<AbsAccountRecord> {
    const old = await this.getAccount(libraryId, accountId);
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    const credentialsChanged =
      input.username !== undefined || input.password !== undefined || input.status !== undefined;
    if (input.username !== undefined) {
      const username = validateUsername(input.username);
      const duplicate = await this.database
        .query("library_abs_accounts")
        .where({ library_id: libraryId, username_lookup: createUsernameLookup(username) })
        .whereNot({ id: accountId })
        .first();
      if (duplicate) throw new ApiError(409, "abs_username_exists", "ABS 用户名已存在");
      patch.username = username;
      patch.username_lookup = createUsernameLookup(username);
    }
    if (input.password !== undefined) {
      const password = validatePassword(input.password);
      patch.password_hash = await hashPassword(password);
      patch.password_required = password ? 1 : 0;
    }
    if (input.status !== undefined) {
      if (!["active", "disabled"].includes(input.status)) throw validationError("status", "账号状态无效");
      patch.status = input.status;
    }
    if (input.canDownload !== undefined) patch.can_download = input.canDownload ? 1 : 0;
    if (credentialsChanged) patch.credential_revision = old.credentialRevision + 1;
    await this.database.query
      .transaction(async (transaction) => {
        await transaction("library_abs_accounts")
          .where({ id: accountId, library_id: libraryId })
          .update(patch);
        if (credentialsChanged) {
          await transaction("library_abs_auth_sessions").where({ account_id: accountId }).delete();
          await transaction("library_abs_playback_sessions")
            .where({ account_id: accountId, status: "active" })
            .update({ status: "closed", closed_at: Date.now() });
        }
      })
      .catch(throwAccountWriteError);
    return this.getAccount(libraryId, accountId);
  }

  /** 删除账号，关联会话、书签与进度通过外键级联删除。 */
  public async deleteAccount(libraryId: string, accountId: string): Promise<void> {
    await this.getAccount(libraryId, accountId);
    await this.database
      .query("library_abs_accounts")
      .where({ library_id: libraryId, id: accountId })
      .delete();
  }

  /** 撤销当前账号全部登录并令旧永久 token 失效。 */
  public async revokeAccountSessions(libraryId: string, accountId: string): Promise<void> {
    const account = await this.getAccount(libraryId, accountId);
    await this.database.query.transaction(async (transaction) => {
      await transaction("library_abs_auth_sessions").where({ account_id: accountId }).delete();
      await transaction("library_abs_accounts")
        .where({ id: accountId })
        .update({ credential_revision: account.credentialRevision + 1, updated_at: Date.now() });
      await transaction("library_abs_playback_sessions")
        .where({ account_id: accountId, status: "active" })
        .update({ status: "closed", closed_at: Date.now() });
    });
  }

  /** 验证标准用户名密码并创建一小时访问凭据与三十天刷新会话。 */
  public async login(
    library: AbsLibraryRow,
    username: unknown,
    password: unknown,
  ): Promise<{ context: AbsContext; accessToken: string; refreshToken: string }> {
    const row =
      typeof username === "string"
        ? await this.database
            .query("library_abs_accounts")
            .where({
              library_id: library.id,
              username_lookup: createUsernameLookup(username),
              status: "active",
            })
            .first()
        : null;
    // 关键变量：仅明确设置免密码的账号允许客户端省略密码字段，仍校验其空密码哈希。
    const suppliedPassword = password === undefined && row && Number(row.password_required) === 0 ? "" : password;
    if (!row || typeof suppliedPassword !== "string" || !(await verifyPassword(String(row.password_hash), suppliedPassword)))
      throw new ApiError(401, "abs_login_failed", "用户名或密码错误");
    const context = this.context(library, mapAccount(row));
    const now = Date.now();
    const sessionId = randomUUID();
    const refreshToken = this.sign({
      ...this.claims(context),
      type: "refresh",
      sessionId,
      jti: randomUUID(),
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 30 * 86400,
    });
    await this.database.query("library_abs_auth_sessions").insert({
      id: sessionId,
      account_id: context.accountId,
      refresh_hash: digest(refreshToken),
      previous_refresh_hash: null,
      previous_valid_until: null,
      expires_at: now + 30 * 86400000,
      credential_revision: context.credentialRevision,
      refresh_encrypted: this.vault.encrypt({ token: refreshToken }),
      created_at: now,
      updated_at: now,
    });
    return { context, accessToken: this.accessToken(context, sessionId), refreshToken };
  }

  /** 验证 JWT 签名、用途、有效期、单库范围、账号修订及真实登录会话。 */
  public async authenticate(library: AbsLibraryRow, token: string): Promise<AbsContext> {
    const claims = this.verify(token);
    if (claims.type === "refresh" || claims.libraryId !== library.id)
      throw new ApiError(401, "abs_token_invalid", "访问凭据无效");
    const account = await this.getAccount(library.id, claims.userId);
    if (account.status !== "active" || claims.revision !== account.credentialRevision)
      throw new ApiError(401, "abs_token_revoked", "访问凭据已失效");
    if (
      claims.type === "access" &&
      !(await this.database
        .query("library_abs_auth_sessions")
        .where({ id: claims.sessionId, account_id: account.id })
        .where("expires_at", ">", Date.now())
        .first())
    )
      throw new ApiError(401, "abs_session_revoked", "登录已失效");
    return this.context(library, account);
  }

  /** 在有效 JWT 握手后绑定账号与登录会话，拒绝过期令牌及 refresh token 建立新连接。 */
  public async authorizeSocket(
    library: AbsLibraryRow,
    token: string,
  ): Promise<{ context: AbsContext; authorization: AbsSocketAuthorization }> {
    const context = await this.authenticate(library, token);
    const claims = this.verify(token);
    return {
      context,
      authorization: {
        libraryId: context.libraryId,
        accountId: context.accountId,
        credentialRevision: context.credentialRevision,
        authSessionId: claims.type === "access" ? (claims.sessionId ?? null) : null,
      },
    };
  }

  /** 长连接按真实账号修订和持久登录复核，HTTP 刷新后的旧 access token 到期不会误踢。 */
  public async revalidateSocket(
    library: AbsLibraryRow,
    authorization: AbsSocketAuthorization,
  ): Promise<AbsContext> {
    if (authorization.libraryId !== library.id)
      throw new ApiError(401, "abs_socket_library_invalid", "实时连接不属于当前媒体库");
    const account = await this.getAccount(library.id, authorization.accountId);
    if (account.status !== "active" || account.credentialRevision !== authorization.credentialRevision)
      throw new ApiError(401, "abs_socket_revoked", "实时连接的账号已停用或登录已撤销");
    if (authorization.authSessionId !== null) {
      const session = await this.database
        .query("library_abs_auth_sessions")
        .where({
          id: authorization.authSessionId,
          account_id: account.id,
          credential_revision: account.credentialRevision,
        })
        .where("expires_at", ">", Date.now())
        .first();
      if (!session) throw new ApiError(401, "abs_session_revoked", "实时连接对应的登录已失效");
    }
    return this.context(library, account);
  }

  /** 刷新令牌使用数据库比较更新，宽限期内旧请求复用当前令牌避免并发旋转互踢。 */
  public async refresh(
    library: AbsLibraryRow,
    token: string,
  ): Promise<{ context: AbsContext; accessToken: string; refreshToken: string }> {
    const claims = this.verify(token);
    if (claims.type !== "refresh" || claims.libraryId !== library.id || !claims.sessionId)
      throw new ApiError(401, "abs_refresh_invalid", "刷新凭据无效");
    const account = await this.getAccount(library.id, claims.userId);
    if (account.status !== "active" || account.credentialRevision !== claims.revision)
      throw new ApiError(401, "abs_refresh_revoked", "刷新凭据已撤销");
    const context = this.context(library, account);
    const refreshToken = await this.database.query.transaction(async (transaction) => {
      let query = transaction("library_abs_auth_sessions").where({
        id: claims.sessionId,
        account_id: account.id,
      });
      if (this.database.databaseType !== "sqlite") query = query.forUpdate();
      const row = await query.first();
      const now = Date.now();
      if (!row || Number(row.expires_at) <= now)
        throw new ApiError(401, "abs_refresh_expired", "刷新凭据已过期");
      if (row.refresh_hash !== digest(token)) {
        if (
          row.previous_refresh_hash === digest(token) &&
          Number(row.previous_valid_until) > now &&
          row.refresh_encrypted
        )
          return String(this.vault.decrypt(String(row.refresh_encrypted)).token);
        throw new ApiError(401, "abs_refresh_invalid", "刷新凭据已失效");
      }
      const next = this.sign({
        ...this.claims(context),
        type: "refresh",
        sessionId: String(row.id),
        jti: randomUUID(),
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 30 * 86400,
      });
      await transaction("library_abs_auth_sessions")
        .where({ id: row.id })
        .update({
          previous_refresh_hash: row.refresh_hash,
          previous_valid_until: now + 600000,
          refresh_hash: digest(next),
          refresh_encrypted: this.vault.encrypt({ token: next }),
          expires_at: now + 30 * 86400000,
          updated_at: now,
        });
      return next;
    });
    return { context, accessToken: this.accessToken(context, claims.sessionId), refreshToken };
  }

  /** 注销给定刷新会话，可安全重复调用；不会跨账号清除其他会话。 */
  public async logout(library: AbsLibraryRow, refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const claims = this.verify(refreshToken);
    if (claims.libraryId !== library.id || claims.type !== "refresh")
      throw new ApiError(401, "abs_refresh_invalid", "刷新凭据无效");
    await this.database
      .query("library_abs_auth_sessions")
      .where({ id: claims.sessionId, account_id: claims.userId })
      .delete();
  }

  /** 当前浏览器兼容对象仍携带旧 token，其用途仅限此 ABS 账号。 */
  public legacyToken(context: AbsContext): string {
    return this.sign(this.claims(context));
  }

  /** 公开账号查找统一在单库范围进行。 */
  public async getAccount(libraryId: string, accountId: string): Promise<AbsAccountRecord> {
    const row = await this.database
      .query("library_abs_accounts")
      .where({ library_id: libraryId, id: accountId })
      .first();
    if (!row) throw new ApiError(401, "abs_account_not_found", "ABS 账号不存在或已删除");
    return mapAccount(row);
  }

  /** 为会话能力地址验证仍有效的账号和库。 */
  public context(library: AbsLibraryRow, account: AbsAccountRecord): AbsContext {
    return {
      libraryId: library.id,
      ownerUserId: library.user_id,
      libraryName: library.display_name,
      pathSuffix: library.abs_path_suffix,
      accountId: account.id,
      username: account.username,
      credentialRevision: account.credentialRevision,
      canDownload: account.canDownload,
      basePath: buildAbsPath(library.abs_path_suffix),
      relayPlaybackEnabled: Number(library.abs_relay_playback_enabled) !== 0,
    };
  }

  /** 仅签名本实现定义的有限 JWT 声明。 */
  private claims(context: AbsContext): AbsClaims {
    return {
      userId: context.accountId,
      libraryId: context.libraryId,
      username: context.username,
      revision: context.credentialRevision,
    };
  }
  /** 创建短期访问令牌。 */
  private accessToken(context: AbsContext, sessionId: string): string {
    const iat = Math.floor(Date.now() / 1000);
    return this.sign({
      ...this.claims(context),
      type: "access",
      sessionId,
      jti: randomUUID(),
      iat,
      exp: iat + 3600,
    });
  }
  /** 按 RFC 7519 生成 HS256 JWT，避免把私有 opaque token 假装为官方 JWT。 */
  private sign(claims: AbsClaims): string {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${unsigned}.${createHmac("sha256", this.jwtKey).update(unsigned).digest("base64url")}`;
  }
  /** 验证签名和算法；刷新凭据的用途由调用方再检查。 */
  private verify(token: string): AbsClaims {
    try {
      const [header, payload, signature, extra] = token.split(".");
      if (!header || !payload || !signature || extra || token.length > 8192) throw new Error("invalid");
      if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256")
        throw new Error("algorithm");
      const expected = createHmac("sha256", this.jwtKey).update(`${header}.${payload}`).digest();
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error("signature");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as AbsClaims;
      if (
        !claims.userId ||
        !claims.libraryId ||
        !Number.isInteger(claims.revision) ||
        (claims.exp !== undefined && claims.exp <= Date.now() / 1000)
      )
        throw new Error("expired");
      return claims;
    } catch {
      throw new ApiError(401, "abs_token_invalid", "访问凭据无效或已过期");
    }
  }
}

/** 只返回不含密码摘要的账号资料。 */
function mapAccount(row: Record<string, unknown>): AbsAccountRecord {
  return {
    id: String(row.id),
    libraryId: String(row.library_id),
    username: String(row.username),
    hasPassword: Number(row.password_required) === 1,
    credentialRevision: Number(row.credential_revision),
    status: row.status === "active" ? "active" : "disabled",
    canDownload: Number(row.can_download) === 1,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}
/** 用户名规则与其他协议账号一致，保留用户实际大小写。 */
function validateUsername(value: unknown): string {
  if (typeof value !== "string" || value.length < 4 || value.length > 255 || value.trim() !== value)
    throw validationError("username", "用户名需为 4 至 255 字符且不含首尾空白");
  return value;
}
/** 显式空字符串表示免密码；省略值由管理接口按创建或编辑语义处理。 */
function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw validationError("password", "ABS 密码必须为字符串且不能超过 4096 字符");
  return value;
}
/** 刷新凭据只按 SHA256 查询，正文以部署主密钥加密保存以支持宽限重试。 */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** 唯一约束为并发创建/改名的最终判断，向管理端返回明确冲突。 */
function throwAccountWriteError(error: unknown): never {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (["23505", "ER_DUP_ENTRY", "SQLITE_CONSTRAINT_UNIQUE"].includes(code))
    throw new ApiError(409, "abs_username_exists", "ABS 用户名已存在");
  throw error;
}
