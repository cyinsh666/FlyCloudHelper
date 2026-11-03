import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 只接受明确的正整数页码，避免无效参数落到本地数组切片。 */
function readPage(value: unknown, field: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw validationError(field, `${field} 必须是 1 到 ${maximum} 的整数`);
  }
  return number;
}

/** 为个人与管理员模式提供同一份本地榜单快照。 */
export async function registerRecommendationRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  for (const admin of [false, true]) {
    const prefix = admin ? "/api/v1/admin/recommendations" : "/api/v1/recommendations";

    /** 检查当前页面身份，管理员模式复用原有超级管理员边界。 */
    async function requireActor(request: FastifyRequest): Promise<void> {
      if (admin) await requireSuperAdmin(request, runtime.database);
      else await requireRequestUser(request, runtime.database);
    }

    server.get(prefix, async (request) => {
      await requireActor(request);
      return runtime.recommendations.list();
    });

    server.post(`${prefix}/sync`, async (request) => {
      await requireActor(request);
      return runtime.recommendations.syncNow();
    });

    server.get<{ Params: { blockId: string; rank: string } }>(`${prefix}/:blockId/items/:rank/related`, async (request) => {
      await requireActor(request);
      const rank = readPage(request.params.rank, "rank", 1, 100000);
      const { block, item } = await runtime.recommendations.item(request.params.blockId, rank);
      // 关键变量：短剧或缺少 TMDB ID 的榜单条目没有对应的 TMDB 关联推荐。
      const mediaType = item.mediaType === "movie" || item.mediaType === "tv" ? item.mediaType
        : block.mediaType === "movie" || block.mediaType === "tv" ? block.mediaType : null;
      if (!item.tmdbId || !mediaType || runtime.tmdb.getStatus().configuredCount === 0) return { items: [] };
      return { items: await runtime.tmdb.readVideoRecommendations(mediaType, item.tmdbId, "zh-CN") };
    });

    server.get<{ Params: { blockId: string; rank: string } }>(`${prefix}/:blockId/items/:rank`, async (request) => {
      await requireActor(request);
      const rank = readPage(request.params.rank, "rank", 1, 100000);
      const { block, item } = await runtime.recommendations.item(request.params.blockId, rank);
      // 关键变量：只用快照内有效的 TMDB ID 查询指定电影或剧集，短剧等条目保留榜单信息。
      const mediaType = item.mediaType === "movie" || item.mediaType === "tv" ? item.mediaType
        : block.mediaType === "movie" || block.mediaType === "tv" ? block.mediaType : null;
      if (!item.tmdbId || !mediaType) {
        return { block, item, tmdb: null, tmdbError: "该条目没有可用的 TMDB 电影或剧集 ID" };
      }
      if (runtime.tmdb.getStatus().configuredCount === 0) {
        return { block, item, tmdb: null, tmdbError: "系统尚未配置 TMDB Key" };
      }
      try {
        const metadata = await runtime.tmdb.readVideoMetadata(mediaType, item.tmdbId, "zh-CN", "CN");
        if (!metadata) return { block, item, tmdb: null, tmdbError: "TMDB 暂未返回该作品详情" };
        return { block, item, tmdb: {
          id: metadata.id, mediaType: metadata.mediaType, title: metadata.title,
          originalTitle: metadata.originalTitle, overview: metadata.overview, year: metadata.year,
          releaseDate: metadata.releaseDate, rating: metadata.rating, genres: metadata.genres,
          originCountries: metadata.originCountries, posterUrl: metadata.posterUrl,
          backdropUrl: metadata.backdropUrl, episodeCount: metadata.episodeCount,
          people: metadata.people.slice(0, 24).map((person) => ({ name: person.name, role: person.role,
            type: person.type, profileUrl: person.profileUrl })),
        }, tmdbError: null };
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "TMDB 详情暂时无法读取";
        return { block, item, tmdb: null, tmdbError: message };
      }
    });

    server.get<{ Params: { blockId: string }; Querystring: { page?: string; pageSize?: string } }>(
      `${prefix}/:blockId`, async (request) => {
        await requireActor(request);
        const page = readPage(request.query.page, "page", 1, 10000);
        const pageSize = readPage(request.query.pageSize, "pageSize", 20, 100);
        return runtime.recommendations.detail(request.params.blockId, page, pageSize);
      },
    );
  }
}
