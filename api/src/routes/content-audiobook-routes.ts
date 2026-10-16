import type { FastifyInstance, FastifyRequest } from "fastify";
import { validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 读取明确选择的听书分类，不能将空配置解释为整站导入。 */
function categoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !id || id.length > 128)) {
    throw validationError("categoryIds", "请至少选择一个有效的有声书分类");
  }
  return [...new Set(value as string[])];
}

/** 独立在线听书设置只管理摘要同步和分类，协议账号继续通过标准 ABS 设置维护。 */
export async function registerContentAudiobookRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const base = admin ? "/api/v1/admin/libraries/:libraryId/content-audiobook" : "/api/v1/libraries/:libraryId/content-audiobook";
    /** 每个入口都先核对真实媒体库所有者，管理员不以自己的 ID 写入其他人的内容。 */
    async function ownerId(libraryId: string, request: FastifyRequest): Promise<string> {
      const user = admin ? await requireSuperAdmin(request, runtime.database) : await requireRequestUser(request, runtime.database);
      const library = await runtime.repository.getLibrary(libraryId, admin ? undefined : user.id);
      return library.userId;
    }
    server.get<{ Params: { libraryId: string } }>(base, async (request) => {
      return runtime.contentAudiobooks.getLibrary(request.params.libraryId, await ownerId(request.params.libraryId, request));
    });
    server.patch<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(base, async (request) => {
      return runtime.contentAudiobooks.updateLibraryCategories(request.params.libraryId, await ownerId(request.params.libraryId, request), categoryIds(request.body?.categoryIds));
    });
    server.get<{ Params: { libraryId: string } }>(`${base}/categories`, async (request) => {
      const userId = await ownerId(request.params.libraryId, request);
      const binding = await runtime.contentAudiobooks.getLibrary(request.params.libraryId, userId);
      return { items: await runtime.contentAudiobooks.categories(binding.source.id, userId) };
    });
    server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>(`${base}/sync`, async (request, reply) => {
      const body = request.body ?? {};
      if (body.mode !== undefined && !["next", "refresh", "latest"].includes(String(body.mode))) {
        throw validationError("mode", "同步模式只支持 next、refresh 或 latest");
      }
      const sync = await runtime.contentAudiobooks.startLibrarySync(request.params.libraryId, await ownerId(request.params.libraryId, request), {
        ...(body.pageCount !== undefined ? { pageCount: Number(body.pageCount) } : {}),
        ...(body.mode ? { mode: body.mode as "next" | "refresh" | "latest" } : {}),
      });
      return reply.code(202).send({ sync });
    });
  }
}
