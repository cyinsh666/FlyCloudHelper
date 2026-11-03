import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { TmdbVideoMetadata } from "../metadata/tmdb.js";
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

/** 将完整 TMDB 元数据裁剪成影视推荐详情页使用的字段。 */
function readDetailMetadata(metadata: TmdbVideoMetadata) {
  return {
    id: metadata.id, mediaType: metadata.mediaType, title: metadata.title,
    originalTitle: metadata.originalTitle, overview: metadata.overview, year: metadata.year,
    releaseDate: metadata.releaseDate, rating: metadata.rating, genres: metadata.genres,
    originCountries: metadata.originCountries, posterUrl: metadata.posterUrl,
    backdropUrl: metadata.backdropUrl, episodeCount: metadata.episodeCount,
    people: metadata.people.slice(0, 24).map((person) => ({ name: person.name, role: person.role,
      type: person.type, profileUrl: person.profileUrl })),
  };
}

/** 仅允许电影或剧集类型进入 TMDB 详情接口。 */
function readMediaType(value: string): "movie" | "tv" {
  if (value !== "movie" && value !== "tv") throw validationError("mediaType", "TMDB 类型必须是电影或剧集");
  return value;
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

    server.get<{ Querystring: { query?: string } }>(`${prefix}/tmdb/search`, async (request) => {
      await requireActor(request);
      const query = typeof request.query.query === "string" ? request.query.query.trim() : "";
      if (!query || [...query].length > 100) throw validationError("query", "请输入不超过 100 字的影视名称");
      const status = runtime.tmdb.getStatus();
      if (status.configuredCount === 0) throw new ApiError(503, "tmdb_not_configured", "系统尚未配置 TMDB Key");
      const temporaryError = runtime.tmdb.getTemporaryUnavailableError();
      if (temporaryError) throw temporaryError;
      if (status.healthyCount === 0) throw new ApiError(503, "tmdb_unavailable", "TMDB Key 当前不可用");
      // 关键变量：电影和剧集并行查询；一类暂时失败时仍展示另一类的结果。
      const [movies, series] = await Promise.allSettled([
        runtime.tmdb.searchVideoCandidates({ mediaType: "movie", title: query, year: null, language: "zh-CN", region: "CN" }),
        runtime.tmdb.searchVideoCandidates({ mediaType: "tv", title: query, year: null, language: "zh-CN", region: "CN" }),
      ]);
      if (movies.status === "rejected" && series.status === "rejected") {
        throw movies.reason instanceof ApiError ? movies.reason : new ApiError(502, "tmdb_search_failed", "TMDB 搜索暂时不可用");
      }
      const movieItems = movies.status === "fulfilled" ? movies.value : [];
      const seriesItems = series.status === "fulfilled" ? series.value : [];
      const items = [] as Array<(typeof movieItems)[number]>;
      for (let index = 0; index < Math.max(movieItems.length, seriesItems.length); index++) {
        const movie = movieItems[index];
        const seriesItem = seriesItems[index];
        if (movie) items.push(movie);
        if (seriesItem) items.push(seriesItem);
      }
      const errors = [movies.status === "rejected" ? "电影搜索暂时不可用" : null,
        series.status === "rejected" ? "剧集搜索暂时不可用" : null].filter((message): message is string => Boolean(message));
      return { items, errors };
    });

    server.get<{ Params: { mediaType: string; tmdbId: string } }>(`${prefix}/tmdb/:mediaType/:tmdbId/related`, async (request) => {
      await requireActor(request);
      const mediaType = readMediaType(request.params.mediaType);
      const tmdbId = readPage(request.params.tmdbId, "tmdbId", 1, 1_000_000_000);
      if (runtime.tmdb.getStatus().configuredCount === 0) return { items: [] };
      return { items: await runtime.tmdb.readVideoRecommendations(mediaType, tmdbId, "zh-CN") };
    });

    server.get<{ Params: { mediaType: string; tmdbId: string } }>(`${prefix}/tmdb/:mediaType/:tmdbId`, async (request) => {
      await requireActor(request);
      const mediaType = readMediaType(request.params.mediaType);
      const tmdbId = readPage(request.params.tmdbId, "tmdbId", 1, 1_000_000_000);
      if (runtime.tmdb.getStatus().configuredCount === 0) return { tmdb: null, tmdbError: "系统尚未配置 TMDB Key" };
      try {
        const metadata = await runtime.tmdb.readVideoMetadata(mediaType, tmdbId, "zh-CN", "CN");
        return metadata ? { tmdb: readDetailMetadata(metadata), tmdbError: null }
          : { tmdb: null, tmdbError: "TMDB 暂未返回该作品详情" };
      } catch (error) {
        return { tmdb: null, tmdbError: error instanceof ApiError ? error.message : "TMDB 详情暂时无法读取" };
      }
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
        return { block, item, tmdb: readDetailMetadata(metadata), tmdbError: null };
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
