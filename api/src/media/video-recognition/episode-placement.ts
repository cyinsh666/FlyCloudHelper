import path from "node:path";
import type { TmdbEpisodeMetadata, TmdbKeyPool, TmdbRecognitionIdentity } from "../../metadata/tmdb.js";
import type { VideoRecognitionItem } from "./models.js";
import type { VideoIdentityDecision, VideoIdentityResolver } from "./resolver.js";
import { compareVideoTitle } from "./title-comparison.js";

/** 作品身份与文件位置分开，APP 不能把作品组已接受等同于集号已经核实。 */
export interface VideoFileMapping {
  fileId: string;
  workKey: string;
  identityStatus: "accepted" | "pending";
  placementStatus: "verified" | "pending" | "not_applicable";
  tmdbId: number | null;
  episodes: Array<Pick<TmdbEpisodeMetadata, "id" | "seasonNumber" | "episodeNumber" | "title" | "airDate">>;
  reason: string;
  /** 未核实的编号假设单独展示，不能用于 Jellyfin/Emby 的规范季集字段。 */
  numberingCandidate?: { mode: "explicit_season_cohort" | "single_ordinary_season"; sourceOrdinal: number;
    seasonNumber: number; episodeNumber: number; matchedAnchorOrdinals: number[]; needs: string[] };
}

/** 整季定位有独立预算与缓存，不能对每个日期文件单独搜索 TMDB。 */
export class VideoEpisodePlacementResolver {
  private readonly seasons = new Map<string, { expiresAt: number; promise: Promise<TmdbEpisodeMetadata[]> }>();

  /** 共用实例的详情缓存，只为实际需要定位的季读取整季索引。 */
  public constructor(private readonly tmdb: TmdbKeyPool, private readonly identities: VideoIdentityResolver) {}

  /** 同一提供者版本、节目、季、语言合并请求；异常不作为空季缓存。 */
  private async season(id: number, seasonNumber: number,
    statistics: { seasonRequests: number; cacheHits: number }): Promise<TmdbEpisodeMetadata[] | null> {
    const key = `${this.tmdb.revision}:${id}:${seasonNumber}:zh-CN`;
    const cached = this.seasons.get(key);
    if (cached && cached.expiresAt > Date.now()) { statistics.cacheHits += 1; return cached.promise; }
    if (statistics.seasonRequests >= 20) return null;
    statistics.seasonRequests += 1;
    const value = { expiresAt: Date.now() + 24 * 60 * 60_000, promise: this.tmdb.readTvSeason(id, seasonNumber, "zh-CN") };
    if (this.seasons.size >= 1000) this.seasons.delete(this.seasons.keys().next().value!);
    this.seasons.set(key, value);
    try {
      const episodes = await value.promise;
      if (!episodes.length) value.expiresAt = Date.now() + 30 * 60_000;
      return episodes;
    } catch (error) { this.seasons.delete(key); throw error; }
  }

  /** 明确季优先；日期无季时只读最接近的两季，不擅自默认第 1 季。 */
  private selectSeasons(item: VideoRecognitionItem, identity: TmdbRecognitionIdentity): number[] {
    const explicit = item.episodeEvidence?.explicitSeason;
    if (explicit !== null && explicit !== undefined) return [explicit];
    const date = item.episodeEvidence?.dates[0];
    if (!date) return [];
    const seasons = (identity.seasons ?? []).filter((season) => season.episodeCount > 0);
    if (seasons.length <= 2) return seasons.map((season) => season.seasonNumber);
    return seasons.filter((season) => season.airDate && season.airDate <= date)
      .sort((left, right) => right.airDate.localeCompare(left.airDate)).slice(0, 2).map((season) => season.seasonNumber);
  }

  /** 完整同级编号只在明确季或独立标题锚点验证后应用，不默认 S01。 */
  private async resolveNumbered(item: VideoRecognitionItem, id: number, mapping: VideoFileMapping,
    statistics: { detailRequests: number; seasonRequests: number; cacheHits: number }): Promise<boolean> {
    const context = item.numberingContext;
    const source = item.sourceOrdinal;
    if (!context?.cohortSupported || !source || item.providerIdEvidence?.boundaryTitle) return false;
    const identity = await this.identities.readIdentity(item, id, statistics);
    if (!identity) { mapping.reason = "identity_details_unavailable"; return true; }
    const explicitSeason = item.episodeEvidence?.explicitSeason;
    const ordinary = (identity.seasons ?? []).filter((season) => season.seasonNumber > 0 && season.episodeCount > 0);
    const hasExplicitSeason = explicitSeason !== null && explicitSeason !== undefined;
    if (!hasExplicitSeason && ordinary.length !== 1) {
      mapping.reason = "absolute_order_requires_verification"; return true;
    }
    const seasonNumber = hasExplicitSeason ? explicitSeason : ordinary[0]!.seasonNumber;
    const mode = hasExplicitSeason ? "explicit_season_cohort" : "single_ordinary_season";
    mapping.numberingCandidate = { mode, sourceOrdinal: source.ordinal, seasonNumber,
      episodeNumber: source.ordinal, matchedAnchorOrdinals: [], needs: [] };
    if (hasExplicitSeason && seasonNumber > 1 && context.minimumOrdinal !== 1
      && source.syntax !== "explicit") {
      mapping.numberingCandidate.needs.push("verify_local_or_absolute_numbering");
      mapping.reason = "non_reset_numbering_in_later_season"; return true;
    }
    if (!hasExplicitSeason && context.anchors.length < 2) {
      mapping.numberingCandidate.needs.push("independent_episode_order_anchors");
      mapping.reason = "single_season_order_requires_evidence"; return true;
    }
    const episodes = await this.season(id, seasonNumber, statistics);
    if (episodes === null) { mapping.reason = "season_request_budget_reached"; return true; }
    const officialNumbers = episodes.map((episode) => episode.episodeNumber);
    const target = episodes.filter((episode) => episode.episodeNumber === source.ordinal);
    // 来源超出官方覆盖的版本可能插入特别篇或切分，不能只接受恰好存在的中间编号。
    if (!officialNumbers.length || context.maximumOrdinal! > Math.max(...officialNumbers)
      || context.minimumOrdinal! < Math.min(...officialNumbers) || target.length !== 1) {
      mapping.numberingCandidate.needs.push("compatible_source_and_official_coverage");
      mapping.reason = "source_cohort_exceeds_official_index"; return true;
    }
    if (!hasExplicitSeason) {
      const matched: number[] = [];
      let contradiction = false;
      for (const anchor of context.anchors) {
        const caption = compareVideoTitle(anchor.title);
        const supported = episodes.filter((episode) => {
          const title = compareVideoTitle(episode.title);
          return [...title].length >= 3 && !/^(?:第?[零〇一二两三四五六七八九十百千万\d]+[集话話]?|episode\d+)$/iu.test(title) && caption.includes(title);
        });
        if (supported.length === 1) {
          if (supported[0]!.episodeNumber === anchor.ordinal) matched.push(anchor.ordinal);
          else contradiction = true;
        }
      }
      mapping.numberingCandidate.matchedAnchorOrdinals = [...new Set(matched)];
      if (contradiction || mapping.numberingCandidate.matchedAnchorOrdinals.length < 2) {
        mapping.numberingCandidate.needs.push(contradiction ? "resolve_episode_order_conflict" : "independent_episode_order_anchors");
        mapping.reason = contradiction ? "source_episode_order_conflicts_with_titles" : "single_season_order_requires_evidence";
        return true;
      }
    }
    mapping.placementStatus = "verified";
    mapping.reason = hasExplicitSeason ? "verified_explicit_season_cohort_ordinal" : "verified_single_season_with_title_anchors";
    mapping.episodes = target.map(({ id, seasonNumber, episodeNumber, title, airDate }) => ({ id, seasonNumber, episodeNumber, title, airDate }));
    return true;
  }

  /** 同stem单集或同季资料只给位置候选，单集ID、日期与官方索引必须一致。 */
  private async resolveNfo(item: VideoRecognitionItem, id: number, mapping: VideoFileMapping,
    statistics: { detailRequests: number; seasonRequests: number; cacheHits: number }): Promise<boolean> {
    const nfo = item.nfoEvidence;
    if (!nfo || nfo.conflicts.length) return false;
    const explicit = item.episodeEvidence;
    const positions = nfo.episodes.length ? nfo.episodes : nfo.seasonNumber !== null && explicit?.hasExplicitEpisode
      ? item.episodeNumbers.map((episodeNumber) => ({ seasonNumber: nfo.seasonNumber!, episodeNumber,
        tmdbEpisodeId: null, title: "", airDate: null })) : [];
    if (!positions.length) return false;
    const matches: TmdbEpisodeMetadata[] = [];
    for (const seasonNumber of new Set(positions.map((position) => position.seasonNumber))) {
      const episodes = await this.season(id, seasonNumber, statistics);
      if (episodes === null) { mapping.reason = "season_request_budget_reached"; return true; }
      for (const position of positions.filter((position) => position.seasonNumber === seasonNumber)) {
        const found = episodes.filter((episode) => episode.episodeNumber === position.episodeNumber);
        if (found.length !== 1) { mapping.reason = "nfo_position_not_verified"; return true; }
        const episode = found[0]!;
        if (position.tmdbEpisodeId && position.tmdbEpisodeId !== episode.id
          || position.airDate && position.airDate !== episode.airDate
          || explicit?.dates.length && (explicit.dates.length !== 1 || explicit.dates[0] !== episode.airDate)) {
          mapping.reason = "nfo_position_conflicts_with_official_or_source_date"; return true;
        }
        matches.push(episode);
      }
    }
    mapping.placementStatus = "verified";
    mapping.reason = "verified_related_nfo_episode_positions";
    mapping.episodes = matches.map(({ id, seasonNumber, episodeNumber, title, airDate }) => ({ id, seasonNumber, episodeNumber, title, airDate }));
    return true;
  }

  /** 逐文件核对，跨作品边界只凭日期命中不足以恢复专题身份。 */
  public async resolve(items: VideoRecognitionItem[], decisions: VideoIdentityDecision[]) {
    const byWork = new Map(decisions.map((decision) => [decision.workKey, decision]));
    const statistics = { detailRequests: 0, seasonRequests: 0, cacheHits: 0 };
    const fileMappings: VideoFileMapping[] = [];
    for (const item of items) {
      const decision = byWork.get(item.workKey);
      const boundaryPending = decision?.reason === "inherited_id_requires_file_evidence";
      const identityAccepted = decision?.status === "accepted";
      const candidate = decision?.candidate;
      const mapping: VideoFileMapping = { fileId: item.fileId, workKey: item.workKey,
        identityStatus: identityAccepted ? "accepted" : "pending", placementStatus: "pending",
        tmdbId: identityAccepted && candidate ? candidate.id : null, episodes: [], reason: decision?.reason ?? "no_work_decision" };
      fileMappings.push(mapping);
      if (!candidate || (!identityAccepted && !boundaryPending)) continue;
      if (item.mediaType !== "tv") { mapping.placementStatus = identityAccepted ? "not_applicable" : "pending"; continue; }
      const evidence = item.episodeEvidence;
      if (evidence?.seasonConflict) { mapping.reason = "conflicting_explicit_seasons"; continue; }
      if (identityAccepted && await this.resolveNfo(item, candidate.id, mapping, statistics)) continue;
      const dates = evidence?.dates ?? [];
      const missingDirectNumbering = !evidence?.hasExplicitEpisode || !item.episodeNumbers.length
        || evidence.explicitSeason === null || evidence.explicitSeason === undefined;
      // 已有明确季集／日期路径不被新候选替换；上下文来自完整解析，不从本轮少量目标重建。
      if (!dates.length && identityAccepted && missingDirectNumbering
        && await this.resolveNumbered(item, candidate.id, mapping, statistics)) continue;
      // 弱裸数字、绝对编号和日期尾号不能直接当作规范播出集号。
      if (!dates.length && (!evidence?.hasExplicitEpisode || !item.episodeNumbers.length)) {
        mapping.reason = boundaryPending ? "inherited_id_without_file_proof" : "numbering_system_not_verified"; continue;
      }
      if (dates.length > 1) { mapping.reason = "multiple_source_dates_need_review"; continue; }
      if (!dates.length && (evidence?.explicitSeason === null || evidence?.explicitSeason === undefined)) {
        mapping.reason = "season_not_determined"; continue;
      }
      const identity = await this.identities.readIdentity(item, candidate.id, statistics);
      if (!identity) { mapping.reason = "identity_details_unavailable"; continue; }
      const seasons = this.selectSeasons(item, identity);
      if (!seasons.length) { mapping.reason = "season_not_determined"; continue; }
      const episodes: TmdbEpisodeMetadata[] = [];
      let budgetLimited = false;
      for (const seasonNumber of seasons) {
        const rows = await this.season(candidate.id, seasonNumber, statistics);
        if (rows === null) { budgetLimited = true; break; }
        episodes.push(...rows);
      }
      if (budgetLimited) { mapping.reason = "season_request_budget_reached"; continue; }
      let matches: TmdbEpisodeMetadata[];
      if (dates.length) {
        matches = episodes.filter((episode) => episode.airDate === dates[0]);
        if (matches.length !== 1) {
          mapping.reason = matches.length ? "multiple_episodes_on_source_date" : "date_not_verified_in_bounded_seasons"; continue;
        }
        if (evidence?.hasExplicitEpisode && item.episodeNumbers.length
          && (item.episodeNumbers.length !== 1 || item.episodeNumbers[0] !== matches[0]!.episodeNumber)) {
          mapping.reason = "explicit_episode_conflicts_with_date"; continue;
        }
      } else {
        matches = episodes.filter((episode) => item.episodeNumbers.includes(episode.episodeNumber));
        if (matches.length !== item.episodeNumbers.length) { mapping.reason = "explicit_episode_not_verified"; continue; }
      }
      if (boundaryPending) {
        // 不同节目可能同一天播出；专题子集必须另有连续、足够长的官方单集标题证据。
        const fileTitle = compareVideoTitle(path.posix.basename(item.filePath));
        const titleSupported = dates.length === 1 && matches.every((episode) => {
          const title = compareVideoTitle(episode.title);
          return [...title].length >= 3 && !/^第?\d+集?$/u.test(title) && fileTitle.includes(title);
        });
        if (!titleSupported) { mapping.reason = "inherited_id_requires_date_and_episode_title"; continue; }
      }
      mapping.identityStatus = "accepted";
      mapping.tmdbId = candidate.id;
      mapping.placementStatus = "verified";
      mapping.reason = boundaryPending ? "verified_date_and_episode_title_in_subset"
        : dates.length ? "verified_unique_official_air_date" : "verified_explicit_season_episode";
      mapping.episodes = matches.map(({ id, seasonNumber, episodeNumber, title, airDate }) => ({ id, seasonNumber, episodeNumber, title, airDate }));
    }
    return { fileMappings, statistics };
  }
}
