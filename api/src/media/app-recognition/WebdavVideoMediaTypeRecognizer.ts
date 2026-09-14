/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { normalizeWebdavPath, WebdavBrowseItem } from './path.js'
import { WebdavParsedVideoName, WebdavScannedVideoFile, WebdavVideoScrapeTaskType } from './models.js'
import { WebdavVideoNameParser } from './WebdavVideoNameParser.js'
import { WebdavMediaPathEvidence } from './WebdavMediaPathEvidence.js'
import { WebdavMediaMovieEvidence } from './WebdavMediaMovieEvidence.js'
import { WebdavMediaEpisodeEvidence } from './WebdavMediaEpisodeEvidence.js'
import {
  WebdavDirectoryTvScanContext, WebdavDirectoryVideoFileIndex, WebdavNearestPathTypeHint,
  WebdavMediaDirectoryInput, WebdavMediaRecognitionInput, WebdavMediaRecognitionResult,
  WebdavScrapeTypeInput, WebdavScrapeTypeDecision
} from './WebdavMediaRecognitionModels.js'

/** 统一媒体判型入口；规则只消费现有数据，不访问网络、数据库或扫描服务。 */
export class WebdavVideoMediaTypeRecognizer {
  /** 对已枚举目录按需收集证据，保留原有规则优先级及未命中文件的回退上下文。 */
  static prepareDirectory(input: WebdavMediaDirectoryInput): WebdavDirectoryTvScanContext {
    return WebdavVideoMediaTypeRecognizer.buildDirectoryTvScanContext(
      input.rootPath, input.currentPath, input.videoItems, input.directoryItems
    )
  }

  /** 已知类型优先用于回填；普通扫描使用文件与目录证据进行统一判型。 */
  static recognize(input: WebdavMediaRecognitionInput): WebdavMediaRecognitionResult {
    if (input.knownType !== 'unknown') {
      const parsed = WebdavVideoNameParser.parse(input.fileName, input.filePath)
      parsed.mediaType = input.knownType
      if (input.knownType === 'movie') {
        parsed.seasonNumber = 0
        parsed.episodeNumber = 0
        parsed.episodeNumbers = []
      }
      return WebdavVideoMediaTypeRecognizer.result(parsed, 'known_media_type',
        `采用已确认类型：${input.knownTypeSource || '已有元数据'}`)
    }
    return WebdavVideoMediaTypeRecognizer.parseScannedVideoName(
      input.rootPath, input.filePath, input.fileName, input.directoryContext
    )
  }

  /** 集中保留显式 TMDB、插件单类型约束及未知类型默认电影的任务策略。 */
  static resolveScrapeType(input: WebdavScrapeTypeInput): WebdavScrapeTypeDecision {
    const decision = new WebdavScrapeTypeDecision()
    decision.recognizedType = input.parsedType
    decision.taskType = input.parsedType === 'tv' ? 'tv' : 'movie'
    decision.rule = input.parsedType === 'unknown' ? 'unknown_default_movie' : 'recognized_type'
    decision.reason = input.parsedType === 'unknown' ? '未知类型沿用默认电影策略' : '沿用识别类型'
    if (input.explicitTmdbType !== 'unknown') {
      decision.taskType = input.explicitTmdbType
      decision.rule = 'explicit_tmdb_type'
      decision.reason = '显式 TMDB 标识采用路径及季集结构推断的类型'
      return decision
    }
    if (input.supportedItemTypes.length === 1) {
      const supportedType = input.supportedItemTypes[0]!
      if (supportedType === 'tv' || supportedType === 'movie') {
        decision.taskType = supportedType
        decision.rule = 'provider_supported_type'
        decision.reason = '当前插件仅支持此类型'
      }
    }
    return decision
  }

  /** 沿用原显式 TMDB 标识的类型推断；标识数字本身不能证明电影或节目。 */
  static inferExplicitTmdbTaskType(
    file: WebdavScannedVideoFile,
    fallback: WebdavVideoScrapeTaskType
  ): WebdavVideoScrapeTaskType {
    const nearestPathTypeHint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(file.rootPath, file.parentPath)
    if (nearestPathTypeHint.mediaType === 'movie') {
      return 'movie'
    }
    if (nearestPathTypeHint.mediaType === 'tv') {
      return 'tv'
    }
    if (WebdavMediaPathEvidence.hasExplicitTvStructure(file)) {
      return 'tv'
    }
    if (nearestPathTypeHint.mediaType === 'mixed') {
      return fallback
    }
    if (WebdavMediaPathEvidence.isCollectionContainerDirectory(file.parentPath)) {
      return 'movie'
    }
    if (WebdavMediaPathEvidence.hasSeriesPathHintForLog(file.path) || WebdavMediaPathEvidence.hasSeriesPathHintForLog(file.parentPath)) {
      return 'tv'
    }
    return fallback
  }

  /** 包装完整解析结果，不丢失多集合并、未知季、年份及规格信息。 */
  private static result(parsed: WebdavParsedVideoName, rule: string, reason: string): WebdavMediaRecognitionResult {
    const result = new WebdavMediaRecognitionResult()
    result.parsed = parsed
    result.rule = rule
    result.reason = reason
    return result
  }

  /** 缓存当前目录最近的分类提示，单文件重试时按现有路径直接提取。 */
  private static nearestPathHint(
    rootPath: string, parentPath: string, context?: WebdavDirectoryTvScanContext
  ): WebdavNearestPathTypeHint {
    if (context?.nearestPathTypeHint !== undefined) {
      return context.nearestPathTypeHint
    }
    const hint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, parentPath)
    if (context !== undefined) {
      context.nearestPathTypeHint = hint
    }
    return hint
  }

  /** 仅在规则执行到季目录分支时构建，并在本目录复用。 */
  private static pathTvContext(
    parentPath: string, context?: WebdavDirectoryTvScanContext
  ): WebdavDirectoryTvScanContext {
    if (context?.pathTvContext !== undefined) {
      return context.pathTvContext
    }
    const pathContext = WebdavMediaPathEvidence.buildPathTvScanContext(parentPath)
    if (context !== undefined) {
      context.pathTvContext = pathContext
    }
    return pathContext
  }

  /** 结合文件强证据和目录上下文识别媒体，显式季集不被普通电影容器覆盖。 */
  private static parseScannedVideoName(
    rootPath: string,
    filePath: string,
    fileName: string,
    directoryTvContext?: WebdavDirectoryTvScanContext
  ): WebdavMediaRecognitionResult {
    const normalizedPath = normalizeWebdavPath(filePath)
    const parentPath = WebdavVideoNameParser.getParentPath(normalizedPath)
    if (WebdavMediaPathEvidence.isMixedMediaBucketDirectory(parentPath)) {
      // 不传路径，避免文件名信息不足时再次从混合目录或更上层继承片名、年份和季号。
      return WebdavVideoMediaTypeRecognizer.result(WebdavVideoNameParser.parse(fileName), 'mixed_directory', '混合分类目录按单文件解析')
    }
    const consecutive = directoryTvContext?.consecutiveByName.get(fileName)
    if (consecutive !== undefined && directoryTvContext !== undefined) {
      const parsed = WebdavVideoNameParser.parseAsTvEpisode(fileName, normalizedPath,
        directoryTvContext.title, consecutive.seasonNumber, consecutive.episodeNumber)
      WebdavVideoMediaTypeRecognizer.applyDirectorySeriesYear(parsed, directoryTvContext)
      // 显式证据直接回写，避免裸数字被默认第一季或弱集号推断覆盖。
      parsed.seasonNumber = consecutive.seasonNumber
      parsed.episodeNumber = consecutive.episodeNumber
      parsed.episodeNumbers = [consecutive.episodeNumber]
      return WebdavVideoMediaTypeRecognizer.result(parsed,
        consecutive.matchMode === 'broadcast_date' ? 'directory_date_episode' : 'directory_consecutive_episode',
        consecutive.matchMode === 'broadcast_date' ? '目录不同播出日期证据' : '目录连续集号证据')
    }
    if (directoryTvContext?.reason === 'consecutive_episode_priority' || directoryTvContext?.reason === 'date_episode_priority') {
      return WebdavVideoMediaTypeRecognizer.parseScannedVideoName(rootPath, filePath, fileName, directoryTvContext.fallbackContext)
    }
    const nearestPathTypeHint = WebdavVideoMediaTypeRecognizer.nearestPathHint(rootPath, parentPath, directoryTvContext)
    if (WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName) &&
      !WebdavMediaPathEvidence.hasMovieTitleHint(fileName) && !WebdavMediaPathEvidence.hasMovieTitleHint(parentPath) &&
      (directoryTvContext === undefined || !directoryTvContext.isTv)) {
      const parsed = WebdavVideoNameParser.parse(fileName, normalizedPath)
      if (parsed.mediaType === 'tv' && parsed.episodeNumber > 0) {
        return WebdavVideoMediaTypeRecognizer.result(parsed, 'explicit_episode', '文件名明确季集标记')
      }
    }
    // “1917 (2019)”有独立年份，可以作为数字电影；普通裸集号不进入此分支。
    if (/^\d{3,4}[\s._-]+[\[（(]?(?:19|20)\d{2}/.test(fileName) &&
      nearestPathTypeHint.mediaType !== 'tv' &&
      (directoryTvContext === undefined || !directoryTvContext.isTv)) {
      const numericMovie = WebdavVideoNameParser.parseAsMovie(fileName, '')
      if (WebdavVideoNameParser.hasNumericMovieTitleEvidence(fileName, numericMovie.query)) {
        return WebdavVideoMediaTypeRecognizer.result(numericMovie, 'numeric_movie', '数字片名具有独立发行年份')
      }
    }
    if (directoryTvContext !== undefined && directoryTvContext.isMovie) {
      // 电影范围目录内的“第N部 年份”必须分别建片，不能全部继承同一个系列标题。
      if (/^第\s*[0-9一二三四五六七八九十两]{1,3}\s*部(?:\s|$)/.test(WebdavVideoNameParser.getFileStem(fileName)) &&
        !WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
        const partQuery = WebdavMediaMovieEvidence.buildMovieSeriesPartQuery(rootPath, parentPath, fileName)
        if (partQuery.title.length > 0) {
          return WebdavVideoMediaTypeRecognizer.result(
            WebdavVideoNameParser.parseAsMovie(fileName, '', partQuery.title),
            'movie_part_file', `电影文件部号=${partQuery.partNumber}，保留文件发行年份`
          )
        }
      }
      // 分部标题已由目录确认，不再把“第 N 部”传回季解析，保留文件自身的发行年份。
      const movieParsePath = directoryTvContext.movieReason === 'movie_part_directory' ? '' : normalizedPath
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, movieParsePath, directoryTvContext.movieTitle), 'movie_directory', `电影目录证据：${directoryTvContext.movieReason}`
      )
    }
    // 单文件重试没有目录上下文时也使用同一分部规则；已有节目证据不能被覆盖。
    if (directoryTvContext === undefined && !WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
      const moviePartQuery = WebdavMediaMovieEvidence.buildMoviePartDirectoryQuery(rootPath, parentPath)
      if (moviePartQuery.title.length > 0) {
        return WebdavVideoMediaTypeRecognizer.result(
          WebdavVideoNameParser.parseAsMovie(fileName, '', moviePartQuery.title),
          'movie_part_directory', '电影分类下的独立分部目录'
        )
      }
    }
    if (WebdavMediaPathEvidence.hasMovieTitleHint(fileName) &&
      !WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
      const movieTitle = WebdavMediaMovieEvidence.pickMovieDirectoryTitle(rootPath, parentPath, fileName)
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, movieTitle), 'movie_title_hint', '文件名包含电影提示'
      )
    }
    if (directoryTvContext !== undefined && directoryTvContext.isTv) {
      const fallbackEpisodeNumber = directoryTvContext.fallbackEpisodeByPath.get(normalizedPath)
      const parsed = WebdavVideoNameParser.parseAsTvEpisode(
        fileName,
        normalizedPath,
        directoryTvContext.title,
        directoryTvContext.seasonNumber,
        fallbackEpisodeNumber !== undefined ? fallbackEpisodeNumber : 0
      )
      WebdavVideoMediaTypeRecognizer.applyDirectorySeriesYear(parsed, directoryTvContext)
      parsed.confirmedNumericSeriesTitle = directoryTvContext.reason === 'numeric_series_file_consensus' ||
        directoryTvContext.reason === 'numeric_series_title_season_folder'
      return WebdavVideoMediaTypeRecognizer.result(parsed, 'tv_directory', `节目目录证据：${directoryTvContext.reason}`)
    }
    const seriesPartQuery = WebdavMediaMovieEvidence.buildMovieSeriesPartQuery(rootPath, parentPath, fileName)
    if (seriesPartQuery.title.length > 0) {
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, seriesPartQuery.title), 'movie_series_part', '电影系列分部'
      )
    }
    if (nearestPathTypeHint.mediaType === 'tv') {
      const title = WebdavMediaPathEvidence.pickDirectorySeriesTitle(parentPath, '')
      if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
        return WebdavVideoMediaTypeRecognizer.result(WebdavVideoNameParser.parseAsTvEpisode(
          fileName,
          normalizedPath,
          title,
          WebdavMediaPathEvidence.resolveDirectorySeasonNumber(parentPath),
          WebdavVideoNameParser.inferEpisodeNumberFromFileName(fileName)
        ), 'tv_category_path', '最近目录为节目分类')
      }
    } else if (nearestPathTypeHint.mediaType === 'movie') {
      if (!WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
        const movieTitle = WebdavMediaMovieEvidence.pickMovieDirectoryTitle(rootPath, parentPath, fileName)
        return WebdavVideoMediaTypeRecognizer.result(
          WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, movieTitle), 'movie_category_path', '最近目录为电影分类'
        )
      }
    }
    if (directoryTvContext !== undefined && directoryTvContext.movieTitle.length > 0) {
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, directoryTvContext.movieTitle), 'movie_directory_title', '目录提供可用电影标题'
      )
    }
    if (nearestPathTypeHint.mediaType !== 'mixed' && WebdavMediaMovieEvidence.shouldParseFileAsMovieByPath(rootPath, parentPath, fileName)) {
      const movieTitle = WebdavMediaMovieEvidence.pickMovieDirectoryTitle(rootPath, parentPath, fileName)
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, movieTitle), 'movie_container_path', '电影容器路径证据'
      )
    }
    const pathContext = WebdavVideoMediaTypeRecognizer.pathTvContext(parentPath, directoryTvContext)
    if (pathContext.isTv) {
      const parsed = WebdavVideoNameParser.parseAsTvEpisode(
        fileName,
        normalizedPath,
        pathContext.title,
        pathContext.seasonNumber,
        WebdavVideoNameParser.inferEpisodeNumberFromFileName(fileName)
      )
      parsed.confirmedNumericSeriesTitle = pathContext.reason === 'numeric_series_title_season_folder'
      return WebdavVideoMediaTypeRecognizer.result(parsed, 'season_path', '路径季目录证据')
    }
    const hasSeriesHint = WebdavMediaPathEvidence.hasEffectiveSeriesPathHint(rootPath, parentPath)
    const isNestedInSeriesRoot = hasSeriesHint && normalizeWebdavPath(parentPath) !== normalizeWebdavPath(rootPath)
    if (hasSeriesHint && (WebdavVideoNameParser.looksLikeEpisodeFileName(fileName) || isNestedInSeriesRoot)) {
      const title = WebdavMediaPathEvidence.pickDirectorySeriesTitle(parentPath, '')
      if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
        return WebdavVideoMediaTypeRecognizer.result(WebdavVideoNameParser.parseAsTvEpisode(
          fileName,
          normalizedPath,
          title,
          WebdavMediaPathEvidence.resolveDirectorySeasonNumber(parentPath),
          WebdavVideoNameParser.inferEpisodeNumberFromFileName(fileName)
        ), 'series_path', '节目路径及文件结构证据')
      }
    }
    const movieTitle = WebdavMediaMovieEvidence.pickMovieDirectoryTitle(rootPath, parentPath, fileName)
    if (movieTitle.length > 0) {
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoNameParser.parseAsMovie(fileName, normalizedPath, movieTitle), 'movie_parent_title', '父目录提供可用电影标题'
      )
    }
    const parsed = WebdavVideoNameParser.parse(fileName, normalizedPath)
    if (parsed.mediaType === 'unknown') {
      return WebdavVideoMediaTypeRecognizer.result(
        WebdavVideoMediaTypeRecognizer.resolveUnknownParsedVideoNameAsMovie(parsed, normalizedPath),
        'unknown_default_movie', '文件名证据不足，扫描沿用默认电影策略'
      )
    }
    return WebdavVideoMediaTypeRecognizer.result(parsed, 'filename_fallback', '采用文件名解析结果')
  }

  /** 将目录级确认的节目首播年份应用到单集，避免各季目录年份造成同名候选歧义。 */
  private static applyDirectorySeriesYear(
    parsed: WebdavParsedVideoName,
    directoryTvContext: WebdavDirectoryTvScanContext
  ): void {
    if (parsed.mediaType === 'tv' && directoryTvContext.seriesYear > 0) {
      parsed.year = directoryTvContext.seriesYear
    }
  }

  /** 将最终仍为 unknown 的解析结果划归电影，避免扫描落库时丢失未明确类型的视频。 */
  private static resolveUnknownParsedVideoNameAsMovie(
    parsed: WebdavParsedVideoName,
    _filePath: string
  ): WebdavParsedVideoName {
    if (parsed.mediaType !== 'unknown') {
      return parsed
    }
    parsed.mediaType = 'movie'
    parsed.seasonNumber = 0
    parsed.episodeNumber = 0
    parsed.episodeNumbers = []
    return parsed
  }

  /** 目录规则的唯一决策顺序；证据提取分别委托路径、节目和电影工具。 */
  private static buildDirectoryTvScanContext(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[],
    directoryItems: WebdavBrowseItem[],
    enableConsecutivePriority: boolean = true
  ): WebdavDirectoryTvScanContext {
    if (videoItems.length === 0) {
      return new WebdavDirectoryTvScanContext()
    }
    // 关键变量：混合分类目录不参与整目录节目分组，每个文件独立判定身份。
    if (WebdavMediaPathEvidence.isMixedMediaBucketDirectory(currentPath)) {
      const mixedContext = new WebdavDirectoryTvScanContext()
      mixedContext.videoCount = videoItems.length
      mixedContext.episodeLikeCount = WebdavMediaEpisodeEvidence.countEpisodeLikeVideoItems(videoItems)
      return mixedContext
    }
    if (enableConsecutivePriority) {
      const consecutive = WebdavMediaEpisodeEvidence.buildConsecutiveEpisodeContext(rootPath, currentPath, videoItems, directoryItems)
      if (consecutive.isTv) {
        consecutive.fallbackContext = WebdavVideoMediaTypeRecognizer.buildDirectoryTvScanContext(rootPath, currentPath, videoItems, directoryItems, false)
        WebdavVideoMediaTypeRecognizer.alignExplicitEpisodeDirectoryTitle(currentPath, consecutive)
        return consecutive
      }
      const dateContext = WebdavMediaEpisodeEvidence.buildBareDateEpisodeDirectoryContext(rootPath, currentPath, videoItems)
      if (dateContext.isTv) {
        dateContext.fallbackContext = WebdavVideoMediaTypeRecognizer.buildDirectoryTvScanContext(
          rootPath, currentPath, videoItems, directoryItems, false)
        return dateContext
      }
    }
    // 连续分集证据已在前面处理；独立“第 N 部”还需要电影分类且没有显式季集文件。
    const episodeLikeCount = WebdavMediaEpisodeEvidence.countEpisodeLikeVideoItems(videoItems)
    if (episodeLikeCount === 0) {
      const moviePartQuery = WebdavMediaMovieEvidence.buildMoviePartDirectoryQuery(rootPath, currentPath)
      if (moviePartQuery.title.length > 0) {
        const movieContext = new WebdavDirectoryTvScanContext()
        movieContext.isMovie = true
        movieContext.movieTitle = moviePartQuery.title
        movieContext.movieReason = 'movie_part_directory'
        movieContext.videoCount = videoItems.length
        return movieContext
      }
    }
    const context = WebdavMediaPathEvidence.buildPathTvScanContext(currentPath)
    context.videoCount = videoItems.length
    context.episodeLikeCount = episodeLikeCount
    const numericSeriesContext = WebdavMediaEpisodeEvidence.buildNumericSeriesDirectoryContext(rootPath, currentPath, videoItems)
    if (numericSeriesContext.isTv) {
      numericSeriesContext.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return numericSeriesContext
    }
    // 节目分类目录中若只有同片多版本或单个带年份正片，应按电影处理；强季集文件永不进入此分支。
    const tvCategoryMovieTitle = WebdavMediaMovieEvidence.pickTvCategoryMovieVariantTitle(rootPath, currentPath, videoItems)
    if (tvCategoryMovieTitle.length > 0) {
      context.isTv = false
      context.isMovie = true
      context.movieTitle = tvCategoryMovieTitle
      context.movieReason = 'tv_category_movie_variant'
      return context
    }
    if (context.isTv) {
      context.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return context
    }
    const explicitContext = WebdavMediaEpisodeEvidence.buildExplicitEpisodeDirectoryContext(currentPath, videoItems)
    if (explicitContext.isTv && WebdavMediaEpisodeEvidence.shouldExplicitEpisodesOverrideMovieCategory(currentPath, videoItems)) {
      explicitContext.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return explicitContext
    }
    // 明确电影分类优先，避免 Wall-E.2008、H.264 等文件名把整个电影合集误判成节目。
    if (WebdavMediaMovieEvidence.shouldTreatDirectoryAsMovieContainer(rootPath, currentPath, videoItems)) {
      const movieTitle = WebdavMediaMovieEvidence.pickMovieContainerDirectoryTitle(rootPath, currentPath, videoItems)
      context.isMovie = true
      context.movieTitle = movieTitle
      context.movieReason = 'movie_path_hint_container'
      return context
    }
    // 非电影目录仍允许单个明确季集标记建立节目上下文。
    if (explicitContext.isTv) {
      explicitContext.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return explicitContext
    }
    // 多个同前缀、按八位播出日期命名的文件视为节目单集，覆盖纪录片等中性目录。
    const dateEpisodeContext = WebdavMediaEpisodeEvidence.buildDateEpisodeDirectoryContext(currentPath, videoItems)
    if (dateEpisodeContext.isTv) {
      dateEpisodeContext.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return dateEpisodeContext
    }
    const earlyMovieTitle = WebdavMediaMovieEvidence.pickDirectoryMovieTitle(rootPath, currentPath, videoItems)
    if (earlyMovieTitle.length > 0 && (videoItems.length === 1 ||
      WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath).mediaType === 'movie')) {
      context.isMovie = true
      context.movieTitle = earlyMovieTitle
      context.movieReason = videoItems.length === 1 ? 'single_movie_file_in_folder' : 'movie_path_hint_folder'
      return context
    }
    const hintedContext = WebdavMediaEpisodeEvidence.buildHintedDirectoryTvScanContext(rootPath, currentPath, videoItems)
    if (hintedContext.isTv) {
      hintedContext.fallbackEpisodeByPath = WebdavMediaEpisodeEvidence.buildDirectoryFallbackEpisodeMap(videoItems)
      return hintedContext
    }
    const movieTitle = earlyMovieTitle.length > 0 ? earlyMovieTitle :
      WebdavMediaMovieEvidence.pickDirectoryMovieTitle(rootPath, currentPath, videoItems)
    if (movieTitle.length > 0) {
      context.isMovie = true
      context.movieTitle = movieTitle
      context.movieReason = videoItems.length === 1 ? 'single_movie_file_in_folder' : 'movie_folder_multi_files'
    }
    return context
  }

  /** 同一作品目录包含不同文件名前缀时，让明确集号回退分支沿用已确认的目录主标题。 */
  private static alignExplicitEpisodeDirectoryTitle(
    currentPath: string,
    consecutive: WebdavDirectoryTvScanContext
  ): void {
    const fallback = consecutive.fallbackContext
    // 只统一全部文件均带明确集号的节目目录，不扩展电影、日期节目或弱集号分支。
    if (fallback === undefined || !fallback.isTv || fallback.isMovie ||
      fallback.reason !== 'episode_file_marker' || fallback.episodeLikeCount !== consecutive.videoCount ||
      fallback.title === consecutive.title) {
      return
    }
    const folderName = WebdavVideoNameParser.getLastPathName(currentPath)
    const directoryTitle = WebdavVideoNameParser.cleanSeriesDirectoryTitle(folderName)
    // 主标题必须来自当前作品目录，不能用上级分类桶标题覆盖文件名。
    if (!WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(directoryTitle) || directoryTitle !== consecutive.title) {
      return
    }
    fallback.title = consecutive.title
  }
}
