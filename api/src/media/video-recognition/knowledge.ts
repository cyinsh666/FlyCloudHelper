import { createHash } from "node:crypto";
import type { Knex } from "knex";
import type { TmdbRecognitionIdentity } from "../../metadata/tmdb.js";
import type { VideoRecognitionItem } from "./models.js";
import { validationError } from "../../errors.js";
import type { VideoFileMapping } from "./episode-placement.js";
import type { VideoAiStrongProof } from "./ai-verification.js";

/** 已验证身份和可选位置分开保存，系列身份不能冒充单集定位。 */
export interface VideoKnowledgeRecord {
  identity: TmdbRecognitionIdentity;
  confirmation: "manual" | "automatic_strong";
  fileMapping: VideoFileMapping | null;
}

/** 创建独立的已确认身份表；不把短期 AI 缓存提升成已验证经验。 */
export async function createVideoRecognitionKnowledgeTable(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("video_recognition_knowledge"))) await database.schema.createTable("video_recognition_knowledge", (table) => {
    table.string("id", 64).primary();
    table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
    table.string("scope_hash", 64).notNullable();
    table.string("file_key", 64).notNullable();
    table.string("evidence_hash", 64).notNullable();
    table.text("evidence_json").notNullable();
    table.text("identity_json").notNullable();
    table.string("confirmation", 32).notNullable();
    table.string("updated_at", 40).notNullable();
    table.index(["user_id", "scope_hash", "file_key"], "idx_video_recognition_knowledge_file");
  });
  if (!(await database.schema.hasTable("video_recognition_ai_proposals"))) await database.schema.createTable("video_recognition_ai_proposals", (table) => {
    table.string("id", 64).primary();
    table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
    table.string("scope_hash", 64).notNullable();
    table.string("evidence_hash", 64).notNullable();
    table.text("proposal_json").notNullable();
    table.string("expires_at", 40).notNullable();
  });
}

/** 固定序列化后的散列用于身份索引，不以片名建立全局映射。 */
function hash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** 识别输入指纹与短期模型版本分开，模型更新不抹掉已确认身份。 */
export function videoRecognitionEvidenceHash(item: VideoRecognitionItem): string {
  return hash([2, item.fileId, item.filePath, item.sourceVersion?.size ?? 0,
    item.sourceVersion?.modifiedAt ?? null, item.sourceVersion?.etag ?? null]);
}

/** 仅按已确认的同源文件复用；作品目录的推广需要后续独立校验。 */
export class VideoRecognitionKnowledge {
  /** 沿用云助手已有数据库，不建立另一套配置文件。 */
  public constructor(private readonly database: Knex) {}

  /** 用户与来源共同隔离精确文件身份。 */
  private keys(userId: string, sourceScope: string, item: VideoRecognitionItem) {
    const scopeHash = hash([sourceScope]);
    const fileKey = hash([item.fileId, item.filePath]);
    return { id: hash([userId, scopeHash, fileKey]), scopeHash, fileKey };
  }

  /** 返回证据仍相容的已确认身份；不触发 TMDB 或 AI 请求。 */
  public async find(userId: string, sourceScope: string, item: VideoRecognitionItem): Promise<TmdbRecognitionIdentity | null> {
    return (await this.findRecord(userId, sourceScope, item))?.identity ?? null;
  }

  /** 身份与位置一并返回；旧经验没有位置时明确保留空值。 */
  public async findRecord(userId: string, sourceScope: string, item: VideoRecognitionItem): Promise<VideoKnowledgeRecord | null> {
    const keys = this.keys(userId, sourceScope, item);
    const row = await this.database("video_recognition_knowledge").where({ id: keys.id, user_id: userId }).first();
    if (!row || row.evidence_hash !== videoRecognitionEvidenceHash(item)) return null;
    const evidence = JSON.parse(String(row.evidence_json));
    const identity = JSON.parse(String(row.identity_json)) as TmdbRecognitionIdentity;
    const nfo = item.nfoEvidence;
    const workConflict = nfo?.work && (nfo.work.mediaType !== identity.mediaType || nfo.work.tmdbId && nfo.work.tmdbId !== identity.id);
    const savedMapping = evidence.fileMapping as VideoFileMapping | undefined;
    const positionConflict = savedMapping && nfo && (nfo.episodes.length > 0 && (nfo.episodes.length !== savedMapping.episodes.length
      || nfo.episodes.some((position) => !savedMapping.episodes.some((episode) => episode.seasonNumber === position.seasonNumber
        && episode.episodeNumber === position.episodeNumber && (!position.tmdbEpisodeId || episode.id === position.tmdbEpisodeId)
        && (!position.airDate || episode.airDate === position.airDate))))
      || nfo.seasonNumber !== null && savedMapping.episodes.some((episode) => episode.seasonNumber !== nfo.seasonNumber));
    // 自动经验遇新强证据要重新核实；人工身份保留，旧自动位置不冒充人工位置。
    const disputed = Boolean(nfo?.conflicts.length || workConflict || positionConflict);
    if (disputed && row.confirmation !== "manual") return null;
    return { identity, confirmation: row.confirmation, fileMapping: disputed ? null : savedMapping ?? null };
  }

  /** 仅供服务端强核验调用；原始 AI 链仍从同用户／同来源建议表读取。 */
  public async rememberAutomatic(userId: string, sourceScope: string, item: VideoRecognitionItem,
    identity: TmdbRecognitionIdentity, aiProposalId: string, proof: VideoAiStrongProof,
    fileMapping: VideoFileMapping): Promise<"saved" | "manual_protected" | "conflict"> {
    const keys = this.keys(userId, sourceScope, item);
    const evidenceHash = videoRecognitionEvidenceHash(item);
    const proposal = await this.database("video_recognition_ai_proposals").where({ id: aiProposalId,
      user_id: userId, scope_hash: keys.scopeHash, evidence_hash: evidenceHash }).first();
    if (!proposal) throw validationError("aiProposalId", "AI 建议与当前文件或来源不符");
    const row = { id: keys.id, user_id: userId, scope_hash: keys.scopeHash, file_key: keys.fileKey,
      evidence_hash: evidenceHash, evidence_json: JSON.stringify({ item, aiProposalId,
        aiProposal: JSON.parse(String(proposal.proposal_json)), proof, fileMapping }),
      identity_json: JSON.stringify(identity), confirmation: "automatic_strong", updated_at: new Date().toISOString() };
    return this.database.transaction(async (transaction) => {
      // 先忽略重复键，再条件更新；并发手动确认不能被自动结果覆盖。
      await transaction("video_recognition_knowledge").insert(row).onConflict("id").ignore();
      const previous = await transaction("video_recognition_knowledge").where({ id: keys.id, user_id: userId }).first();
      if (previous.confirmation === "manual") return "manual_protected";
      const previousIdentity = JSON.parse(String(previous.identity_json)) as TmdbRecognitionIdentity;
      if (previous.evidence_hash === evidenceHash && (previousIdentity.id !== identity.id
        || previousIdentity.mediaType !== identity.mediaType)) return "conflict";
      const changed = await transaction("video_recognition_knowledge").where({ id: keys.id,
        confirmation: "automatic_strong", evidence_hash: previous.evidence_hash,
        identity_json: previous.identity_json, updated_at: previous.updated_at }).update(row);
      return changed ? "saved" : "conflict";
    });
  }

  /** 只在用户明确确认最终身份后写入；AI 建议和搜索候选不能自行调用此入口。 */
  public async confirm(userId: string, sourceScope: string, item: VideoRecognitionItem, identity: TmdbRecognitionIdentity,
    aiProposalId?: string): Promise<void> {
    const keys = this.keys(userId, sourceScope, item);
    // AI 建议必须来自同用户、同来源和同文件输入；不能由调用端伪造模型成功记录。
    const proposal = aiProposalId ? await this.database("video_recognition_ai_proposals").where({ id: aiProposalId,
      user_id: userId, scope_hash: keys.scopeHash, evidence_hash: videoRecognitionEvidenceHash(item) }).first() : null;
    if (aiProposalId && !proposal) throw validationError("aiProposalId", "AI 建议与当前文件或来源不符");
    const previous = await this.database("video_recognition_knowledge").where({ id: keys.id, user_id: userId }).first();
    const previousIdentity = previous ? JSON.parse(String(previous.identity_json)) as TmdbRecognitionIdentity : null;
    // 同一源修订、同一最终身份的幂等确认不能清掉已留存的 AI 特征；改绑后不沿用旧建议。
    const reusePreviousAi = previous && previous.evidence_hash === videoRecognitionEvidenceHash(item)
      && previousIdentity?.mediaType === identity.mediaType && previousIdentity.id === identity.id;
    const previousEvidence = reusePreviousAi ? JSON.parse(String(previous.evidence_json)) : null;
    const previousAi = previousEvidence?.aiProposal;
    const row = { id: keys.id, user_id: userId, scope_hash: keys.scopeHash, file_key: keys.fileKey,
      evidence_hash: videoRecognitionEvidenceHash(item), evidence_json: JSON.stringify({ item,
        aiProposal: proposal ? JSON.parse(String(proposal.proposal_json)) : previousAi ?? null,
        fileMapping: previousEvidence?.fileMapping ?? null, proof: previousEvidence?.proof ?? null }), identity_json: JSON.stringify(identity),
      confirmation: "manual", updated_at: new Date().toISOString() };
    await this.database("video_recognition_knowledge").insert(row).onConflict("id").merge(row);
  }
}
