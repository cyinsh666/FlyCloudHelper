import { ApiError } from "../errors.js";
import type { FlymbyParsedVideoName } from "../media/flymby-video-parser.js";
import type { ProviderBrowseEntry } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";

const SYSTEM_PROMPT = `你只辅助识别自动整理未完成的视频文件。请结合完整路径、文件名、同目录视频及 NFO 文件名，重新判断作品的正式名称、类型、年份和季集号。路径中的作品名可能混入错字、规避符号、排序标记、资源规格或发布者信息，不能直接照抄；应利用仍可辨认的作品信息提出最可能的正式片名。只有无法从这些证据提出合理片名时，title 才返回空字符串。只返回 JSON 对象：{"title":"作品正式名称","mediaType":"movie或tv","year":年份或null,"seasonNumber":季号或null,"episodeNumber":集号或null}。季集号必须在路径或文件名中有明确的“第N季”“Season N”“SxxEyy”“第N集”等标记，不能猜测；不确定的字段用 null。不要输出说明。`;

/** 为服务级整理冻结所选模型配置，不依赖任何媒体库元数据设置。 */
export async function prepareOrganizeAi(runtime: ApiRuntime, modelId: string) {
  if (!modelId) throw new ApiError(422, "organize_ai_model_missing", "请选择已启用的 AI 模型");
  return runtime.aiModels.buildTaskSnapshot({ profiles: { video: { aiCleaning: {
    enabled: true, modelId, triggerMode: "weak_or_unmatched", minConfidence: 0.75,
  } } } });
}

/** AI 只补充可在路径中核验的季集号及查询词，最终作品身份仍需 TMDB 精确核验。 */
export async function recognizeUnmatchedByAi(runtime: ApiRuntime, snapshot: NonNullable<Awaited<ReturnType<typeof prepareOrganizeAi>>>,
  entry: ProviderBrowseEntry, parsed: FlymbyParsedVideoName, siblingNames: string[]): Promise<FlymbyParsedVideoName> {
  // 关键变量：规则片名已经无法生成可整理结果，不能再作为“片名”提示给 AI。
  const result = await runtime.aiModels.requestStructuredJson(snapshot, SYSTEM_PROMPT, {
    path: entry.displayPath, fileName: entry.name, siblingNames,
    recognitionStatus: "现有规则未生成可整理结果，请依据原始路径和文件名重新判断",
  }, { maxTokens: 1024, temperature: 0.1 });
  if (!result.ok || !result.payload) {
    throw new ApiError(502, result.errorCode ?? "organize_ai_unavailable",
      result.errorMessage ?? "AI 辅助识别失败，请稍后重试预览或关闭 AI 辅助");
  }
  const payload = result.payload;
  const rawTitle = typeof payload.title === "string" ? payload.title.trim() : "";
  // 关键变量：网盘目录常用点号拆开中文片名；AI 若沿用该写法，查询 TMDB 前只合并中文字符之间的点号。
  const title = rawTitle.replace(/(?<=\p{Script=Han})[.．·](?=\p{Script=Han})/gu, "");
  // 关键变量：区分模型返回空片名、无效片名和有效片名，便于定位 AI 与 TMDB 两段识别的边界。
  const titleStatus = typeof payload.title !== "string" ? "片名不是字符串"
    : !title ? "空片名" : title.length > 100 || /[\r\n]/u.test(title) ? "片名格式无效" : "有效片名";
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-organize-ai", 事件: "AI返回整理片名",
    来源资源ID: entry.resourceId, 规则片名: parsed.title,
    AI返回片名: rawTitle.slice(0, 100).replace(/[\r\n]/gu, " "), AI片名状态: titleStatus,
    AI返回类型: payload.mediaType === "tv" || payload.mediaType === "movie" ? payload.mediaType : null,
    AI返回年份: typeof payload.year === "number" ? payload.year : null,
  });
  if (titleStatus === "片名格式无效") return parsed;
  const mediaType = payload.mediaType === "tv" || payload.mediaType === "movie" ? payload.mediaType : parsed.mediaType;
  const year = typeof payload.year === "number" && Number.isInteger(payload.year) && payload.year >= 1888 && payload.year <= 2100
    ? payload.year : parsed.year;
  const seasonEvidence = /(?:\bSeason[ ._-]*0*(\d{1,2})\b|第\s*0*(\d{1,2})\s*季|\bS0*(\d{1,2})E\d{1,3}\b)/iu.exec(entry.displayPath);
  const episodeEvidence = /(?:第\s*0*(\d{1,3})\s*[集话回]|\bS\d{1,2}E0*(\d{1,3})\b|\bE(?:P)?0*(\d{1,3})\b)/iu.exec(entry.name);
  const seasonNumber = Number(seasonEvidence?.slice(1).find(Boolean) ?? -1);
  const episodeNumber = Number(episodeEvidence?.slice(1).find(Boolean) ?? 0);
  const verifiedSeason = typeof payload.seasonNumber === "number" && payload.seasonNumber === seasonNumber && seasonNumber >= 0
    ? seasonNumber : parsed.seasonNumber;
  const verifiedEpisode = typeof payload.episodeNumber === "number" && payload.episodeNumber === episodeNumber && episodeNumber > 0
    ? episodeNumber : parsed.episodeNumber;
  return { ...parsed, title: title || parsed.title, query: title || parsed.query,
    mediaType: parsed.episodeNumber > 0 ? "tv" : mediaType, year, tmdbId: title ? 0 : parsed.tmdbId,
    seasonNumber: verifiedSeason, episodeNumber: verifiedEpisode,
    episodeNumbers: verifiedEpisode > 0 && parsed.episodeNumbers.length === 0 ? [verifiedEpisode] : parsed.episodeNumbers };
}
