import { ApiError } from "../errors.js";
import type { FlymbyParsedVideoName } from "../media/flymby-video-parser.js";
import type { ProviderBrowseEntry } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";

const SYSTEM_PROMPT = `你只辅助识别规则未能完整确认的视频文件。根据完整路径、文件名和规则提取结果，返回 JSON 对象：{"title":"作品正式名称","mediaType":"movie或tv","year":年份或null,"seasonNumber":季号或null,"episodeNumber":集号或null}。季集号必须在路径或文件名中有明确的“第N季”“Season N”“SxxEyy”“第N集”等标记，不能猜测；不确定的字段用 null，作品不确定时 title 返回空字符串。不要输出说明。`;

/** 为服务级整理冻结所选模型配置，不依赖任何媒体库元数据设置。 */
export async function prepareOrganizeAi(runtime: ApiRuntime, modelId: string) {
  if (!modelId) throw new ApiError(422, "organize_ai_model_missing", "请选择已启用的 AI 模型");
  return runtime.aiModels.buildTaskSnapshot({ profiles: { video: { aiCleaning: {
    enabled: true, modelId, triggerMode: "weak_or_unmatched", minConfidence: 0.75,
  } } } });
}

/** AI 只补充可在路径中核验的季集号及查询词，最终作品身份仍需 TMDB 精确核验。 */
export async function recognizeUnmatchedByAi(runtime: ApiRuntime, snapshot: NonNullable<Awaited<ReturnType<typeof prepareOrganizeAi>>>,
  entry: ProviderBrowseEntry, parsed: FlymbyParsedVideoName): Promise<FlymbyParsedVideoName> {
  const result = await runtime.aiModels.requestStructuredJson(snapshot, SYSTEM_PROMPT, {
    path: entry.displayPath, fileName: entry.name, ruleTitle: parsed.title,
    ruleMediaType: parsed.mediaType, ruleYear: parsed.year,
  }, { maxTokens: 180, temperature: 0.1 });
  if (!result.ok || !result.payload) {
    throw new ApiError(502, "organize_ai_unavailable", "AI 辅助识别失败，请稍后重试预览或关闭 AI 辅助");
  }
  const payload = result.payload;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title.length > 100 || /[\r\n]/u.test(title)) return parsed;
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
