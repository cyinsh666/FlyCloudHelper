import { createHash } from "node:crypto";
import type { TmdbKeyPool, TmdbVideoSearchCandidate, TmdbRecognitionIdentity } from "../../metadata/tmdb.js";
import { compareVideoTitle } from "./core.js";
import type { VideoRecognitionItem, VideoRecognitionResult } from "./models.js";

/** 在线结果保留未确认项，不能把“有候选”算作正确身份。 */
export interface VideoIdentityDecision {
  workKey: string;
  status: "accepted" | "ambiguous" | "unmatched" | "pending";
  reason: string;
  candidate: Pick<TmdbVideoSearchCandidate, "id" | "mediaType" | "title" | "originalTitle" | "year"> | null;
  candidates: TmdbVideoSearchCandidate[];
}

/** 年份冲突仅核对同一电影的官方发行年份，不把不同地区上映年直接判为不同作品。 */
function nfoMovieYearsCompatible(item: VideoRecognitionItem, identity: TmdbRecognitionIdentity): boolean {
  const conflict = item.nfoEvidence?.yearConflict;
  return !conflict || [conflict.sourceYear, conflict.nfoYear].every((year) => identity.year === year || identity.releaseYears?.includes(year));
}

/** 只有源路径明确标了季／季范围，官方对应季的首播年才可解释该年份。 */
function seasonYearCompatible(item: VideoRecognitionItem, year: number, identity: TmdbRecognitionIdentity | undefined): boolean {
  return item.mediaType === "tv" && Boolean(identity && item.seasonContextEvidence?.years.some((evidence) => evidence.year === year
    && identity.seasons?.some((season) => season.seasonNumber === evidence.seasonNumber && Number(season.airDate.slice(0, 4)) === year)));
}

/** 新拆出的目录词遇季年份歧义时，先核实该节目确有源季；不能仅靠同名首播年抢先绑定。 */
function pathSeasonEvidenceCompatible(item: VideoRecognitionItem, candidate: TmdbVideoSearchCandidate,
  identity: TmdbRecognitionIdentity | undefined): boolean {
  if (item.mediaType !== "tv" || !item.seasonContextEvidence?.years.length) return true;
  const names = [candidate.title, candidate.originalTitle, ...identity?.alternativeTitles ?? []];
  const original = item.titles.some((evidence) => evidence.source !== "path_structure"
    && names.some((name) => compareVideoTitle(name) === compareVideoTitle(evidence.title)));
  return original || Boolean(identity?.seasons?.some((season) => season.seasonNumber === item.episodeEvidence?.explicitSeason));
}

/** 按作品组裁决候选；新增文件证据不能推翻原有唯一的标题／年份强匹配。 */
function decide(item: VideoRecognitionItem, candidates: TmdbVideoSearchCandidate[], identities: TmdbRecognitionIdentity[] = []): VideoIdentityDecision {
  const matching = candidates.filter((candidate) => candidate.mediaType === item.mediaType
    && pathSeasonEvidenceCompatible(item, candidate, identities.find((identity) => identity.id === candidate.id))
    && item.titles.some((evidence) => [candidate.title, candidate.originalTitle,
      ...identities.find((identity) => identity.id === candidate.id)?.alternativeTitles ?? []]
        .some((title) => compareVideoTitle(title) === compareVideoTitle(evidence.title))
      && (evidence.source !== "directory_structure" || !evidence.year || !candidate.year || candidate.year === evidence.year
        || seasonYearCompatible(item, evidence.year, identities.find((identity) => identity.id === candidate.id))))
    && (!item.year || !candidate.year || candidate.year === item.year
      || identities.find((identity) => identity.id === candidate.id)?.releaseYears?.includes(item.year)
      || seasonYearCompatible(item, item.year, identities.find((identity) => identity.id === candidate.id))));
  const originalStrong = matching.filter((candidate) => (!item.year || !candidate.year || candidate.year === item.year)
    && item.titles.filter((evidence) => !["file_structure", "directory_structure", "path_structure"].includes(evidence.source)).some((evidence) =>
      [candidate.title, candidate.originalTitle, ...(identities.find((identity) => identity.id === candidate.id)?.alternativeTitles ?? [])]
        .some((title) => compareVideoTitle(title) === compareVideoTitle(evidence.title))));
  /** 同名候选仅缺年份时，已有精确年份或官方发行年份的证据更完整。 */
  function preferKnownYear(rows: TmdbVideoSearchCandidate[]): TmdbVideoSearchCandidate[] {
    if (!item.year) return rows;
    const known = rows.filter((candidate) => candidate.year === item.year
      || identities.find((identity) => identity.id === candidate.id)?.releaseYears?.includes(item.year!));
    return known.length === 1 && rows.every((candidate) => candidate.id === known[0]!.id || !candidate.year) ? known : rows;
  }
  const originalPreferred = preferKnownYear(originalStrong);
  const selected = originalPreferred.length === 1 ? originalPreferred : preferKnownYear(matching);
  return { workKey: item.workKey, status: selected.length === 1 ? "accepted" : selected.length > 1 ? "ambiguous" : "unmatched",
    reason: selected.length === 1 ? "exact_title_type_year" : selected.length > 1 ? "multiple_reliable_candidates" : "no_reliable_candidate",
    candidate: selected.length === 1 ? selected[0]! : null, candidates };
}

/** 独立在线识别工具，使用原 Key 池而不经过旧的宽松候选兜底。 */
export class VideoIdentityResolver {
  /** 关键变量：缓存的是查询响应；它不是已验证经验，也不参与跨用户作品分组。 */
  private readonly searches = new Map<string, { expiresAt: number; promise: Promise<TmdbVideoSearchCandidate[]> }>();
  /** 关键变量：详情和查询分开缓存，相同编号的别名核对只请求一次。 */
  private readonly identities = new Map<string, { expiresAt: number; promise: Promise<TmdbRecognitionIdentity | null> }>();

  /** 依赖注入现有 TMDB 服务，避免工具另建 Key 和网络重试规则。 */
  public constructor(private readonly tmdb: TmdbKeyPool) {}

  /** 文件定位及确认接口沿用同一详情缓存，避免再取相同作品的详情。 */
  public async readIdentity(item: VideoRecognitionItem, id: number,
    statistics: { detailRequests: number; cacheHits: number }): Promise<TmdbRecognitionIdentity | null> {
    return this.identity(item, id, statistics);
  }

  /** AI 查询也复用普通识别的查询缓存与在途合并，不另建重复请求通道。 */
  public async searchSuggestion(userId: string, item: VideoRecognitionItem, title: string, year: number | null) {
    const statistics = { searchRequests: 0, cacheHits: 0 };
    const candidates = await this.search(userId, item, title, year, statistics);
    return { candidates, statistics };
  }

  /** 只缓存明确的编号响应；网络异常不会被记成作品不存在。 */
  private async identity(item: VideoRecognitionItem, id: number,
    statistics: { detailRequests: number; cacheHits: number }): Promise<TmdbRecognitionIdentity | null> {
    if (item.mediaType === "unknown") return null;
    const key = `${this.tmdb.revision}:${item.mediaType}:${id}`;
    const cached = this.identities.get(key);
    if (cached && cached.expiresAt > Date.now()) { statistics.cacheHits += 1; return cached.promise; }
    statistics.detailRequests += 1;
    const value = { expiresAt: Date.now() + 24 * 60 * 60_000,
      promise: this.tmdb.readRecognitionIdentity(item.mediaType, id) };
    if (this.identities.size >= 1000) this.identities.delete(this.identities.keys().next().value!);
    this.identities.set(key, value);
    try { const result = await value.promise; if (!result) value.expiresAt = Date.now() + 30 * 60_000; return result; }
    catch (error) { this.identities.delete(key); throw error; }
  }

  /** 合并同用户的在途查询；明确空结果短暂缓存，异常立即撤销。 */
  private async search(userId: string, item: VideoRecognitionItem, title: string, year: number | null,
    statistics: { searchRequests: number; cacheHits: number }): Promise<TmdbVideoSearchCandidate[]> {
    if (item.mediaType === "unknown") return [];
    const key = createHash("sha256").update(JSON.stringify([userId, this.tmdb.revision, item.mediaType, title, year])).digest("hex");
    const cached = this.searches.get(key);
    if (cached && cached.expiresAt > Date.now()) { statistics.cacheHits += 1; return cached.promise; }
    if (this.searches.size >= 1000) this.searches.delete(this.searches.keys().next().value!);
    statistics.searchRequests += 1;
    const value = { expiresAt: Date.now() + 60_000, promise: this.tmdb.searchVideoCandidates({
      mediaType: item.mediaType, title, year, language: "zh-CN", region: "" }) };
    this.searches.set(key, value);
    try {
      const candidates = await value.promise;
      value.expiresAt = Date.now() + (candidates.length ? 24 * 60 * 60_000 : 30 * 60_000);
      return candidates;
    } catch (error) { this.searches.delete(key); throw error; }
  }

  /** 每组至多两次标题搜索；请求失败直接交还调用端重试，不改词重查。 */
  public async resolve(userId: string, result: VideoRecognitionResult): Promise<{
    decisions: VideoIdentityDecision[]; statistics: { workGroups: number; searchRequests: number; detailRequests: number; cacheHits: number };
  }> {
    const groups = new Map<string, VideoRecognitionItem>();
    for (const rawItem of result.items) {
      // 日期目录纠正的旧文件查询仍保留在输出证据中，但不能逐个当系列标题补搜。
      const item = rawItem.dateDirectoryEvidence ? { ...rawItem,
        titles: rawItem.titles.filter((evidence) => evidence.source === "date_directory" || evidence.source === "nfo") } : rawItem;
      const previous = groups.get(item.workKey);
      if (!previous) { groups.set(item.workKey, item); continue; }
      // 同作品的多集提供共同证据，不能让目录最后一个文件决定整组的集数覆盖判断。
      const titles = [...previous.titles];
      for (const evidence of item.titles) {
        if (!titles.some((existing) => compareVideoTitle(existing.title) === compareVideoTitle(evidence.title))) titles.push(evidence);
      }
      groups.set(item.workKey, { ...previous, titles,
        episodeNumbers: [...new Set([...previous.episodeNumbers, ...item.episodeNumbers])].sort((left, right) => left - right),
        requiresReview: previous.requiresReview || item.requiresReview });
    }
    const statistics = { workGroups: groups.size, searchRequests: 0, detailRequests: 0, cacheHits: 0 };
    const decisions: VideoIdentityDecision[] = [];
    for (const groupedItem of groups.values()) {
      // 新清理目录词先留在增强阶段；先完成原查询链，避免误标目录抢走独立文件名身份。
      const extraTitles = groupedItem.titles.filter((evidence) => evidence.source === "path_structure"
        || evidence.source === "directory_structure" && groupedItem.directoryTitleEvidence?.some((directory) => directory.kind === "peer_index"
          && compareVideoTitle(directory.title) === compareVideoTitle(evidence.title)));
      const item = { ...groupedItem, titles: groupedItem.titles.filter((evidence) => !extraTitles.includes(evidence)) };
      if (item.mediaType === "unknown" || item.requiresReview) {
        decisions.push({ workKey: item.workKey, status: "pending", reason: item.nfoEvidence?.conflicts.length ? "conflicting_nfo_evidence" : item.contentRole === "commentary"
          ? "non_feature_commentary" : "insufficient_or_conflicting_evidence", candidate: null, candidates: [] });
        continue;
      }
      if (item.tmdbId) {
        const metadata = await this.identity(item, item.tmdbId, statistics);
        if (metadata) {
          const nfo = item.nfoEvidence?.work;
          if (item.nfoEvidence?.scopeTitles.some((sourceTitle) => ![metadata.title, metadata.originalTitle, ...metadata.alternativeTitles]
            .some((title) => compareVideoTitle(title) === compareVideoTitle(sourceTitle)))) {
            decisions.push({ workKey: item.workKey, status: "pending", reason: "nfo_series_scope_not_verified", candidate: metadata, candidates: [] });
            continue;
          }
          const nfoTitles = item.nfoEvidence?.documents.filter((document) => document.rootType === "movie" || document.rootType === "tvshow")
            .flatMap((document) => [document.title, document.originalTitle]).filter(Boolean) ?? [];
          if (nfo?.tmdbId === metadata.id && nfoTitles.length && !nfoTitles.some((sourceTitle) => [metadata.title, metadata.originalTitle, ...metadata.alternativeTitles]
            .some((title) => compareVideoTitle(title) === compareVideoTitle(sourceTitle)))) {
            decisions.push({ workKey: item.workKey, status: "pending", reason: "nfo_title_and_official_identity_conflict", candidate: metadata, candidates: [] });
            continue;
          }
          if (!nfoMovieYearsCompatible(item, metadata)) {
            decisions.push({ workKey: item.workKey, status: "pending", reason: "nfo_and_source_years_not_verified", candidate: metadata, candidates: [] });
            continue;
          }
          // 编号存在只证明官方条目存在，跨越作品目录的编号仍需逐文件核实作用域。
          const boundary = item.providerIdEvidence?.boundaryTitle;
          const titleVerified = !boundary || [metadata.title, metadata.originalTitle, ...metadata.alternativeTitles]
            .some((title) => compareVideoTitle(title) === compareVideoTitle(boundary));
          decisions.push({ workKey: item.workKey, status: titleVerified ? "accepted" : "pending",
            reason: titleVerified ? nfo?.tmdbId === metadata.id ? "verified_nfo_work_id" : "verified_explicit_id" : "inherited_id_requires_file_evidence", candidate: metadata, candidates: [] });
          continue;
        }
        if (item.nfoEvidence?.work?.tmdbId === item.tmdbId) {
          decisions.push({ workKey: item.workKey, status: "pending", reason: "nfo_work_id_not_found", candidate: null, candidates: [] });
          continue;
        }
      }
      const first = item.titles[0];
      if (!first) { decisions.push({ workKey: item.workKey, status: "pending", reason: "no_usable_title", candidate: null, candidates: [] }); continue; }
      const candidates = new Map<number, TmdbVideoSearchCandidate>();
      const steps = [{ title: first.title, year: item.year }];
      // 剧集补查只使用目录或 NFO 证据；电影仍可使用原文件中的独立标题。
      const second = item.mediaType === "tv"
        ? item.titles.find((evidence) => ["directory_structure", "path_structure", "nfo"].includes(evidence.source)
          && compareVideoTitle(evidence.title) !== compareVideoTitle(first.title))
        : item.titles.find((evidence) => evidence.source === "file_structure"
          && compareVideoTitle(evidence.title) !== compareVideoTitle(first.title))
          ?? item.titles.find((evidence) => evidence.source === "directory_structure"
            && compareVideoTitle(evidence.title) !== compareVideoTitle(first.title)) ?? item.titles[1];
      if (second) steps.push({ title: second.title, year: second.source === "directory_structure" ? second.year ?? null : null });
      else if (item.year) steps.push({ title: first.title, year: null });
      let decision = decide(item, []);
      for (const step of steps) {
        for (const candidate of await this.search(userId, item, step.title, step.year, statistics)) candidates.set(candidate.id, candidate);
        decision = decide(item, [...candidates.values()]);
        if (decision.status === "accepted") break;
      }
      // 查询可命中官方别名；仅对同年且文字接近的少量候选补读别名，不做同义词特判。
      if (decision.status === "unmatched") {
        const allCandidates = [...candidates.values()];
        const compatibleYears = allCandidates.filter((candidate) => !item.year || candidate.year === item.year);
        const near = allCandidates.filter((candidate) => {
          const exactTitle = item.titles.some((evidence) => [candidate.title, candidate.originalTitle]
            .some((title) => compareVideoTitle(title) === compareVideoTitle(evidence.title)));
          if (exactTitle && item.mediaType === "tv" && item.seasonContextEvidence?.years.length) return true;
          // 年份接近只能触发官方发行日期核验，本身不能作为接受理由。
          if (exactTitle && item.year && candidate.year && Math.abs(item.year - candidate.year) <= 3) return true;
          if (item.year && candidate.year !== item.year) return false;
          if (compatibleYears.length === 1) return true;
          // 节目强季集证据下，译名查询返回外文标题时可补读官方别名；仍要求名称精确核验。
          if (item.mediaType === "tv" && item.episodeNumbers.length > 0
            && item.titles.some((evidence) => /[\p{Script=Han}]/u.test(evidence.title))
            && /^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(candidate.originalTitle)) return true;
          return item.titles.some((evidence) => {
            const left = compareVideoTitle(evidence.title); const right = compareVideoTitle(candidate.title);
            const shared = [...left].filter((char) => right.includes(char)).length;
            return Math.min(left.length, right.length) >= 2 && shared / Math.max(left.length, right.length) >= 0.6;
          });
        }).slice(0, 2);
        const identities: TmdbRecognitionIdentity[] = [];
        for (const candidate of near) {
          const identity = await this.identity(item, candidate.id, statistics);
          if (identity) identities.push(identity);
        }
        decision = decide(item, [...candidates.values()], identities);
      }
      // 同名节目只使用可核验的集数覆盖排除已完结短节目，连载或缺资料的候选不作负推断。
      if (decision.status === "ambiguous" && item.mediaType === "tv" && (item.episodeNumbers.length || item.sourceOrdinal)) {
        const exact = [...candidates.values()].filter((candidate) => item.titles.some((evidence) =>
          [candidate.title, candidate.originalTitle].some((title) => compareVideoTitle(title) === compareVideoTitle(evidence.title))));
        if (exact.length <= 3) {
          const identities: TmdbRecognitionIdentity[] = [];
          for (const candidate of exact) {
            const identity = await this.identity(item, candidate.id, statistics);
            if (identity) identities.push(identity);
          }
          const highestEpisode = Math.max(...item.episodeNumbers, item.sourceOrdinal?.ordinal ?? 0,
            item.numberingContext?.cohortSupported ? item.numberingContext.maximumOrdinal ?? 0 : 0);
          const covered = identities.some((identity) => identity.episodeCount >= highestEpisode);
          if (covered) {
            const excluded = new Set(identities.filter((identity) => ["Ended", "Canceled"].includes(identity.status)
              && identity.episodeCount > 0 && identity.episodeCount < highestEpisode).map((identity) => identity.id));
            decision = decide(item, [...candidates.values()].filter((candidate) => !excluded.has(candidate.id)), identities);
            if (decision.status === "accepted") decision.reason = "exact_title_with_verified_episode_coverage";
          }
          if (decision.status === "ambiguous" && item.episodeEvidence?.explicitSeason !== null
            && item.episodeEvidence?.explicitSeason !== undefined) {
            const seasonNumber = item.episodeEvidence.explicitSeason;
            const covered = identities.filter((identity) => identity.seasons?.some((season) => season.seasonNumber === seasonNumber
              && season.episodeCount >= (item.sourceOrdinal?.ordinal ?? Math.max(...item.episodeNumbers, 1))));
            const positiveYears = covered.filter((identity) => item.seasonContextEvidence?.years.some((year) => seasonYearCompatible(item, year.year, identity)));
            const excluded = new Set(identities.filter((identity) => ["Ended", "Canceled"].includes(identity.status)
              && (identity.seasons?.length ?? 0) > 0 && !identity.seasons?.some((season) => season.seasonNumber === seasonNumber)).map((identity) => identity.id));
            const filtered = positiveYears.length === 1 ? [...candidates.values()].filter((candidate) => candidate.id === positiveYears[0]!.id)
              : covered.length ? [...candidates.values()].filter((candidate) => !excluded.has(candidate.id)) : [...candidates.values()];
            const next = decide(item, filtered, identities);
            if (next.status === "accepted") { decision = { ...next, candidates: [...candidates.values()] }; decision.reason = "exact_title_with_verified_season_context"; }
          }
        }
      }
      if (decision.status === "unmatched" && extraTitles.length) {
        const enhanced = { ...item, titles: [...item.titles, ...extraTitles] };
        const identities = new Map<number, TmdbRecognitionIdentity>();
        const inspected = new Set<number>();
        /** 增强只补少量有关详情，先核对已有响应，仍不足才追加最多一次新标题搜索。 */
        const verifyExtra = async (): Promise<VideoIdentityDecision> => {
          let extra = decide(enhanced, [...candidates.values()], [...identities.values()]);
          if (extra.status === "accepted") return extra;
          const compatible = [...candidates.values()].filter((candidate) => !item.year || candidate.year === item.year);
          const relevant = [...candidates.values()].filter((candidate) => !inspected.has(candidate.id)
            && (extraTitles.some((evidence) => [candidate.title, candidate.originalTitle].some((name) => compareVideoTitle(name) === compareVideoTitle(evidence.title)))
              || compatible.length === 1 && compatible[0]!.id === candidate.id));
          for (const candidate of relevant.slice(0, Math.max(0, 2 - inspected.size))) {
            inspected.add(candidate.id);
            const identity = await this.identity(enhanced, candidate.id, statistics);
            if (identity) identities.set(identity.id, identity);
          }
          return decide(enhanced, [...candidates.values()], [...identities.values()]);
        };
        let extra = await verifyExtra();
        const query = extraTitles.find((evidence) => evidence.source === "directory_structure") ?? extraTitles[0]!;
        const queryYear = query.source === "directory_structure" ? query.year ?? null : null;
        if (extra.status === "unmatched" && !steps.some((step) => compareVideoTitle(step.title) === compareVideoTitle(query.title) && step.year === queryYear)) {
          for (const candidate of await this.search(userId, enhanced, query.title, queryYear, statistics)) candidates.set(candidate.id, candidate);
          extra = await verifyExtra();
        }
        decision = extra;
      }
      if (decision.status === "accepted" && decision.candidate && item.nfoEvidence?.yearConflict) {
        const identity = await this.identity(item, decision.candidate.id, statistics);
        if (!identity || !nfoMovieYearsCompatible(item, identity)) decision = { ...decision, status: "pending", reason: "nfo_and_source_years_not_verified" };
        else decision = { ...decision, candidate: identity, reason: "verified_title_and_official_release_years" };
      }
      decisions.push(decision);
    }
    return { decisions, statistics };
  }
}
