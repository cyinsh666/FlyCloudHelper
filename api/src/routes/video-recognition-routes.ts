import type { FastifyInstance } from "fastify";
import { requireRequestUser } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import { recognizeVideoDirectory, VIDEO_RECOGNITION_RULE_VERSION } from "../media/video-recognition/core.js";
import type { VideoRecognitionInput } from "../media/video-recognition/models.js";
import { VideoIdentityResolver } from "../media/video-recognition/resolver.js";
import { ApiError, validationError } from "../errors.js";
import { VideoRecognitionKnowledge } from "../media/video-recognition/knowledge.js";
import { VideoRecognitionAi } from "../media/video-recognition/ai.js";
import { VideoEpisodePlacementResolver } from "../media/video-recognition/episode-placement.js";

/** 提供 APP 可直接调用的规则识别接口，沿用云助手已有 Bearer 与 Cookie 登录。 */
export async function registerVideoRecognitionRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const resolver = new VideoIdentityResolver(runtime.tmdb);
  const knowledge = new VideoRecognitionKnowledge(runtime.database.query);
  const placements = new VideoEpisodePlacementResolver(runtime.tmdb, resolver);
  const ai = new VideoRecognitionAi(runtime, resolver, knowledge, placements);
  /** 来源键由 APP 固定保存；不同设备或网盘不可随意共用一个键。 */
  function sourceScope(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 500) {
      throw validationError("sourceScope", "请提供稳定的网盘来源标识");
    }
    return value;
  }
  server.get("/api/v1/video-recognition/capabilities", async (request) => {
    await requireRequestUser(request, runtime.database);
    return { ruleVersion: VIDEO_RECOGNITION_RULE_VERSION, directorySnapshots: true,
      maxFiles: 5000, maxResolveFiles: 100, onlineIdentityVerification: true, verifiedKnowledge: "manual_and_automatic_strong_exact_file",
      aiAssistance: "suggest_verify_remember_or_confirm", fileEpisodeMapping: true, inheritedIdScopeVerification: true,
      automaticAiKnowledge: true,
      callerMediaKind: true,
      completeNumberingContext: true,
      relatedNfoEvidence: true,
      completeDateDirectoryEvidence: true,
      ancestorDirectoryTitleEvidence: true,
      maxNewSeasonReadsPerResolve: 20 };
  });
  server.post<{ Body: VideoRecognitionInput }>("/api/v1/video-recognition/parse", async (request) => {
    await requireRequestUser(request, runtime.database);
    return recognizeVideoDirectory(request.body);
  });
  server.post<{ Body: VideoRecognitionInput & { sourceScope?: string; targetFileIds?: string[] } }>("/api/v1/video-recognition/resolve", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const result = recognizeVideoDirectory(request.body);
    // 完整目录可大于本次在线批次；保留完整解析上下文后，仅选择指定目标联网查询。
    if (request.body.targetFileIds !== undefined) {
      const targets = request.body.targetFileIds;
      if (!Array.isArray(targets) || targets.length > 100 || targets.some((id) => typeof id !== "string")) {
        throw validationError("targetFileIds", "一次在线识别最多选择 100 个文件");
      }
      const ids = new Set(targets);
      const selected = result.items.filter((item) => ids.has(item.fileId));
      if (selected.length !== ids.size) throw validationError("targetFileIds", "目标文件必须来自本次目录快照");
      result.items = selected;
    }
    if (result.items.length > 100) throw validationError("targetFileIds", "请从完整目录快照中选择最多 100 个目标文件");
    // 已隔离的冲突/未知文件不产生在线请求，不能挤占正常作品的联网批次。
    if (new Set(result.items.filter((item) => !item.requiresReview && item.mediaType !== "unknown").map((item) => item.workKey)).size > 20) {
      throw validationError("files", "一次在线识别最多包含 20 个作品组");
    }
    const known = [];
    const knownMappings = [];
    const knownPositionItems = [];
    const knownPositionDecisions = [];
    const pending = [];
    for (const item of result.items) {
      const record = request.body.sourceScope ? await knowledge.findRecord(user.id, sourceScope(request.body.sourceScope), item) : null;
      if (record) {
        known.push({ fileId: item.fileId, workKey: item.workKey, status: "accepted" as const,
          reason: record.confirmation === "manual" ? "verified_manual_knowledge" : "verified_automatic_knowledge", candidate: record.identity, candidates: [] });
        if (record.fileMapping) knownMappings.push({ ...record.fileMapping, workKey: item.workKey });
        else if (item.nfoEvidence && !item.nfoEvidence.conflicts.length) {
          // 人工身份逐文件隔离后核对位置，不能让该文件的手动身份接管同组其他文件。
          const workKey = `confirmed-file:${item.fileId}`;
          knownPositionItems.push({ ...item, workKey, mediaType: record.identity.mediaType });
          knownPositionDecisions.push({ workKey, status: "accepted" as const, reason: "verified_knowledge_identity",
            candidate: record.identity, candidates: [] });
        }
      }
      else pending.push(item);
    }
    if (pending.length && !runtime.tmdb.getStatus().configuredCount) throw new ApiError(503, "tmdb_not_configured", "请先配置 TMDB");
    const resolved = await resolver.resolve(user.id, { ...result, items: pending });
    const placed = await placements.resolve([...pending, ...knownPositionItems], [...resolved.decisions, ...knownPositionDecisions]);
    const workKeys = new Map(result.items.map((item) => [item.fileId, item.workKey]));
    return { ...result, confirmedFiles: known, decisions: resolved.decisions,
      fileMappings: [...knownMappings, ...placed.fileMappings.map((mapping) => ({ ...mapping, workKey: workKeys.get(mapping.fileId)! }))],
      statistics: { ...resolved.statistics, detailRequests: resolved.statistics.detailRequests + placed.statistics.detailRequests,
        cacheHits: resolved.statistics.cacheHits + placed.statistics.cacheHits,
        seasonRequests: placed.statistics.seasonRequests, knowledgeHits: known.length } };
  });
  server.post<{ Body: VideoRecognitionInput & { sourceScope: string; fileId: string; modelId: string } }>(
    "/api/v1/video-recognition/suggest", async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const body = request.body;
      const scope = sourceScope(body?.sourceScope);
      const item = recognizeVideoDirectory(body).items.find((entry) => entry.fileId === body.fileId);
      if (!item) throw validationError("fileId", "指定文件不在本次快照内");
      const known = await knowledge.findRecord(user.id, scope, item);
      if (known) return { status: "accepted", reason: known.confirmation === "manual" ? "verified_manual_knowledge" : "verified_automatic_knowledge",
        identity: known.identity, confirmation: known.confirmation,
        fileMappings: known.fileMapping ? [{ ...known.fileMapping, workKey: item.workKey }] : [] };
      if (item.contentRole === "commentary") return { status: "pending", reason: "non_feature_commentary", contentRole: item.contentRole };
      if (item.nfoEvidence?.conflicts.length) return { status: "pending", reason: "conflicting_nfo_evidence", nfoEvidence: item.nfoEvidence };
      // 先用普通规则和已有查询缓存，网络错误会直接返回，不因错误追加模型调用。
      const regular = await resolver.resolve(user.id, { ruleVersion: VIDEO_RECOGNITION_RULE_VERSION,
        enumerationComplete: body.enumerationComplete, items: [item] });
      if (regular.decisions[0]?.status === "accepted" || regular.decisions[0]?.reason === "inherited_id_requires_file_evidence") {
        const placed = await placements.resolve([item], regular.decisions);
        const statistics = { ...regular.statistics,
          detailRequests: regular.statistics.detailRequests + placed.statistics.detailRequests,
          cacheHits: regular.statistics.cacheHits + placed.statistics.cacheHits, seasonRequests: placed.statistics.seasonRequests };
        if (placed.fileMappings[0]?.identityStatus === "accepted") return {
          status: "accepted", reason: "regular_recognition_succeeded", ...regular, statistics, fileMappings: placed.fileMappings };
        // 作品编号已有候选而文件位置不明时，AI 猜标题不能替代官方季集核验。
        return { status: "pending", reason: "file_evidence_needs_review", ...regular, statistics, fileMappings: placed.fileMappings };
      }
      return ai.suggest(user.id, scope, body.modelId, body, item);
    });
  server.post<{ Body: VideoRecognitionInput & { sourceScope: string; fileId: string; mediaType: "movie" | "tv"; tmdbId: number; aiProposalId?: string } }>(
    "/api/v1/video-recognition/confirm", async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const body = request.body;
      const scope = sourceScope(body?.sourceScope);
      if ((body.mediaType !== "movie" && body.mediaType !== "tv") || !Number.isSafeInteger(body.tmdbId) || body.tmdbId <= 0) {
        throw validationError("tmdbId", "请提供已人工确认的媒体类型与 TMDB 编号");
      }
      const item = recognizeVideoDirectory(body).items.find((entry) => entry.fileId === body.fileId);
      if (!item) throw validationError("fileId", "指定文件不在本次快照内");
      if (!runtime.tmdb.getStatus().configuredCount) throw new ApiError(503, "tmdb_not_configured", "请先配置 TMDB");
      const identity = await resolver.readIdentity({ ...item, mediaType: body.mediaType }, body.tmdbId, { detailRequests: 0, cacheHits: 0 });
      if (!identity) throw validationError("tmdbId", "TMDB 中未找到该身份");
      if (body.aiProposalId !== undefined && typeof body.aiProposalId !== "string") throw validationError("aiProposalId", "AI 建议标识无效");
      await knowledge.confirm(user.id, scope, item, identity, body.aiProposalId);
      return { confirmed: true, fileId: item.fileId, identity };
    });
}
