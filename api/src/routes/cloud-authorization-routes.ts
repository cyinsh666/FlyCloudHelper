import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

const AUTH_LOG_KEY = "codex-flycloud-helper-cloud-auth";

/** 限制通用路由只处理已经注册内部登录驱动的新 Provider。 */
function requireSupportedProvider(runtime: ApiRuntime, providerType: string): string {
  const normalized = providerType.trim();
  if (!runtime.providers.cloudAuthorization.supports(normalized)) {
    throw new ApiError(422, "provider_auth_unsupported", "当前网盘未启用内部扫码登录");
  }
  return normalized;
}

/** 读取可选登录来源，限制长度后再交给具体Provider白名单校验。 */
function readAuthorizationClientType(body: Record<string, unknown>): string | undefined {
  if (typeof body.clientType !== "string") return undefined;
  const clientType = body.clientType.trim();
  if (!clientType) return undefined;
  if (clientType.length > 32) throw new ApiError(400, "provider_auth_client_type_invalid", "登录来源格式无效");
  return clientType;
}

/** 注册普通用户和管理员使用的通用网盘扫码授权接口。 */
export async function registerCloudAuthorizationRoutes(
  server: FastifyInstance,
  runtime: ApiRuntime,
): Promise<void> {
  server.post<{ Params: { providerType: string }; Body: Record<string, unknown> }>(
    "/api/v1/providers/:providerType/auth-sessions",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      const clientType = readAuthorizationClientType(request.body ?? {});
      const authorization = await runtime.providers.cloudAuthorization.start(
        providerType,
        user.id,
        user.id,
        { clientType },
      );
      runtime.logBusinessEvent("info", {
        日志关键字: AUTH_LOG_KEY,
        事件: "用户启动网盘扫码登录",
        用户ID: user.id,
        网盘类型: providerType,
        登录来源: clientType ?? "默认",
        授权状态: authorization.state,
      });
      return reply.status(201).send(authorization);
    },
  );

  server.get<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/providers/:providerType/auth-sessions/:authorizationSessionId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(user.id, request.params.authorizationSessionId, providerType);
      return runtime.providers.cloudAuthorization.poll(
        user.id,
        request.params.authorizationSessionId,
      );
    },
  );

  server.post<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/providers/:providerType/auth-sessions/:authorizationSessionId/complete",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(user.id, request.params.authorizationSessionId, providerType);
      const authorization = await runtime.providers.cloudAuthorization.complete(
        user.id,
        request.params.authorizationSessionId,
      );
      runtime.logBusinessEvent("info", {
        日志关键字: AUTH_LOG_KEY,
        事件: "用户完成网盘扫码登录",
        用户ID: user.id,
        网盘类型: providerType,
        授权状态: authorization.state,
      });
      return authorization;
    },
  );

  server.delete<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/providers/:providerType/auth-sessions/:authorizationSessionId",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(user.id, request.params.authorizationSessionId, providerType);
      await runtime.providers.cloudAuthorization.cancel(user.id, request.params.authorizationSessionId);
      return reply.status(204).send();
    },
  );

  server.post<{ Params: { providerType: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/providers/:providerType/auth-sessions",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const targetUserId = requireString(request.body, "userId", "目标用户 ID", 100);
      await runtime.database.findPublicUserById(targetUserId);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      const clientType = readAuthorizationClientType(request.body);
      const authorization = await runtime.providers.cloudAuthorization.start(
        providerType,
        operator.id,
        targetUserId,
        { clientType },
      );
      runtime.logBusinessEvent("info", {
        日志关键字: AUTH_LOG_KEY,
        事件: "管理员代用户启动网盘扫码登录",
        管理员ID: operator.id,
        目标用户ID: targetUserId,
        网盘类型: providerType,
        登录来源: clientType ?? "默认",
        授权状态: authorization.state,
      });
      return reply.status(201).send(authorization);
    },
  );

  server.get<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/admin/providers/:providerType/auth-sessions/:authorizationSessionId",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(operator.id, request.params.authorizationSessionId, providerType);
      return runtime.providers.cloudAuthorization.poll(
        operator.id,
        request.params.authorizationSessionId,
      );
    },
  );

  server.post<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/admin/providers/:providerType/auth-sessions/:authorizationSessionId/complete",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(operator.id, request.params.authorizationSessionId, providerType);
      return runtime.providers.cloudAuthorization.complete(
        operator.id,
        request.params.authorizationSessionId,
      );
    },
  );

  server.delete<{ Params: { providerType: string; authorizationSessionId: string } }>(
    "/api/v1/admin/providers/:providerType/auth-sessions/:authorizationSessionId",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const providerType = requireSupportedProvider(runtime, request.params.providerType);
      runtime.providers.cloudAuthorization.requireSessionProvider(operator.id, request.params.authorizationSessionId, providerType);
      await runtime.providers.cloudAuthorization.cancel(operator.id, request.params.authorizationSessionId);
      return reply.status(204).send();
    },
  );
}
