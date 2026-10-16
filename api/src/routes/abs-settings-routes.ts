import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildAbsPath, validateAbsPathSuffix } from "../abs-path.js";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 校验设置操作的库归属和媒体类型，ABS 不借用其他协议的账号。 */
async function requireAbsLibrary(
  runtime: ApiRuntime,
  request: FastifyRequest,
  libraryId: string,
  admin: boolean,
): Promise<void> {
  const operator = admin
    ? await requireSuperAdmin(request, runtime.database)
    : await requireRequestUser(request, runtime.database);
  const library = await runtime.repository.getLibrary(libraryId, admin ? undefined : operator.id);
  if (library.dataType !== "audiobook")
    throw new ApiError(409, "abs_requires_audiobook", "ABS 仅用于有声书媒体库");
}

/** 读取可选布尔配置，拒绝把字符串或数字静默转换为开关。 */
function readOptionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value !== undefined && typeof value !== "boolean") throw validationError(key, "开关必须为布尔值");
  return value as boolean | undefined;
}

/** 返回独立 ABS 配置；历史库尚未设置后缀时使用稳定的库 ID。 */
async function readAbsSettings(runtime: ApiRuntime, libraryId: string) {
  const row = await runtime.database.query("media_libraries").where({ id: libraryId }).first();
  if (!row) throw new ApiError(404, "library_not_found", "媒体库不存在");
  const pathSuffix = String(row.abs_path_suffix || libraryId);
  return {
    enabled: Number(row.abs_enabled) === 1,
    pathSuffix,
    path: buildAbsPath(pathSuffix),
    url: await runtime.publicAccess.buildAbsUrl(pathSuffix),
    relayPlaybackEnabled: Number(row.abs_relay_playback_enabled) !== 0,
    accounts: await runtime.absAccess.listByLibrary(libraryId),
  };
}

/** 注册管理端和个人端的 ABS 设置及账号维护接口。 */
export async function registerAbsSettingsRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  /** 同一组接口共享归属校验，管理员可以维护用户媒体库。 */
  function registerScope(prefix: string, admin: boolean): void {
    const path = `${prefix}/:libraryId/abs-settings`;
    server.get<{ Params: { libraryId: string } }>(path, async (request) => {
      await requireAbsLibrary(runtime, request, request.params.libraryId, admin);
      return { settings: await readAbsSettings(runtime, request.params.libraryId) };
    });

    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(path, async (request) => {
      const libraryId = request.params.libraryId;
      await requireAbsLibrary(runtime, request, libraryId, admin);
      const body = request.body ?? {};
      const enabled = readOptionalBoolean(body, "enabled");
      const relay = readOptionalBoolean(body, "relayPlaybackEnabled");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (enabled !== undefined) patch.abs_enabled = enabled ? 1 : 0;
      if (relay !== undefined) patch.abs_relay_playback_enabled = relay ? 1 : 0;
      if (body.pathSuffix !== undefined) {
        const suffix = validateAbsPathSuffix(body.pathSuffix);
        const conflict = await runtime.database
          .query("media_libraries")
          .where({ abs_path_suffix_lookup: suffix.lookup })
          .whereNot({ id: libraryId })
          .first();
        if (conflict) throw new ApiError(409, "abs_path_conflict", "ABS 地址已被其他媒体库使用");
        patch.abs_path_suffix = suffix.value;
        patch.abs_path_suffix_lookup = suffix.lookup;
      }
      try {
        await runtime.database.query.transaction(async (transaction) => {
          await transaction("media_libraries").where({ id: libraryId }).update(patch);
          if (enabled === false) {
            // 关键变量：关闭后立即终止会话；再次开启需要客户端重新登录。
            const accounts = transaction("library_abs_accounts")
              .select("id")
              .where({ library_id: libraryId });
            await transaction("library_abs_auth_sessions").whereIn("account_id", accounts).delete();
            await transaction("library_abs_accounts")
              .where({ library_id: libraryId })
              .increment("credential_revision", 1);
            await transaction("library_abs_playback_sessions")
              .where({ library_id: libraryId, status: "active" })
              .update({ status: "closed", closed_at: Date.now() });
          }
        });
      } catch (error) {
        const databaseError = error as Error & { code?: string };
        // 并发修改可能在预查后占用同一个后缀，唯一约束失败仍返回可理解的冲突。
        if (
          ["23505", "ER_DUP_ENTRY", "SQLITE_CONSTRAINT_UNIQUE"].includes(databaseError.code ?? "") ||
          /UNIQUE constraint failed.*abs_path_suffix_lookup/iu.test(databaseError.message)
        ) {
          throw new ApiError(409, "abs_path_conflict", "ABS 地址已被其他媒体库使用");
        }
        throw error;
      }
      return { settings: await readAbsSettings(runtime, libraryId) };
    });

    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(
      `${path}/accounts`,
      async (request, reply) => {
        const libraryId = request.params.libraryId;
        await requireAbsLibrary(runtime, request, libraryId, admin);
        const body = request.body ?? {};
        // 关键变量：生成密码只在创建响应中提供一次，后续不能读取原密码。
        const password = body.password === undefined ? randomBytes(18).toString("base64url") : body.password;
        if (typeof password !== "string" || !password.trim())
          throw validationError("password", "ABS 账号密码不能为空");
        const account = await runtime.absAccess.createAccount(libraryId, {
          username: body.username,
          password,
          canDownload: readOptionalBoolean(body, "canDownload"),
        });
        return reply.status(201).send({ account, password });
      },
    );

    server.patch<{ Params: { libraryId: string; accountId: string }; Body: Record<string, unknown> }>(
      `${path}/accounts/:accountId`,
      async (request) => {
        const { libraryId, accountId } = request.params;
        await requireAbsLibrary(runtime, request, libraryId, admin);
        const body = request.body ?? {};
        if (body.status !== undefined && body.status !== "active" && body.status !== "disabled")
          throw validationError("status", "账号状态无效");
        if (body.password !== undefined && (typeof body.password !== "string" || !body.password.trim()))
          throw validationError("password", "ABS 账号密码不能为空");
        const account = await runtime.absAccess.updateAccount(libraryId, accountId, {
          username: body.username,
          password: body.password,
          status: body.status,
          canDownload: readOptionalBoolean(body, "canDownload"),
        });
        return { account };
      },
    );

    server.delete<{ Params: { libraryId: string; accountId: string } }>(
      `${path}/accounts/:accountId`,
      async (request) => {
        const { libraryId, accountId } = request.params;
        await requireAbsLibrary(runtime, request, libraryId, admin);
        await runtime.absAccess.deleteAccount(libraryId, accountId);
        return { deleted: true };
      },
    );

    server.post<{ Params: { libraryId: string; accountId: string } }>(
      `${path}/accounts/:accountId/revoke-sessions`,
      async (request) => {
        const { libraryId, accountId } = request.params;
        await requireAbsLibrary(runtime, request, libraryId, admin);
        await runtime.absAccess.revokeAccountSessions(libraryId, accountId);
        return { revoked: true };
      },
    );
  }
  registerScope("/api/v1/libraries", false);
  registerScope("/api/v1/admin/libraries", true);
}
