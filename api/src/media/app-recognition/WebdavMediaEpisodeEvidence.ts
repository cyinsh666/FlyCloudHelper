/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { normalizeWebdavPath, WebdavBrowseItem } from './path.js'
import { normalizeWebdavVideoSearchText, WebdavVideoNameParser } from './WebdavVideoNameParser.js'
import { WebdavVideoTitleCleaner } from './WebdavVideoTitleCleaner.js'
import { WebdavVideoTitleNoiseDictionary } from './WebdavVideoTitleNoiseDictionary.js'
import {
  WebdavConsecutiveEpisodeHelper, WebdavConsecutiveEpisodeEvidence,
  WEBDAV_UNKNOWN_SEASON, WEBDAV_MIN_CONSECUTIVE_EPISODES
} from './WebdavConsecutiveEpisodeHelper.js'
import { WebdavDirectoryTvScanContext, WebdavDateEpisodeTitleCount, WebdavDirectoryVideoFileIndex } from './WebdavMediaRecognitionModels.js'
import { WebdavMediaPathEvidence } from './WebdavMediaPathEvidence.js'


/** 节目目录、显式集号和连续序号证据；只处理内存数据。 */
export class WebdavMediaEpisodeEvidence {
  /** 统计带 S01E01、第 X 集等强季集标记的文件，不把任意数字当作剧集证据。 */
  static countEpisodeLikeVideoItems(videoItems: WebdavDirectoryVideoFileIndex[]): number {
    let count = 0
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined && WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(entry.name)) {
        count += 1
      }
      index += 1
    }
    return count
  }

  /** 优先使用连续两集及作品目录；不满足时返回空上下文，完整保留其他判型分支。 */
  static buildConsecutiveEpisodeContext(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[],
    directoryItems: WebdavBrowseItem[]
  ): WebdavDirectoryTvScanContext {
    const result = new WebdavDirectoryTvScanContext()
    const folderName = WebdavVideoNameParser.getLastPathName(currentPath)
    if (WebdavMediaPathEvidence.isCollectionContainerDirectory(currentPath) ||
      /(?:剧场版|劇場版|电影版|電影版|映画)/.test(folderName) ||
      /^(?:最近接收|待看|收藏|下载|downloads?|videos?|剧集|电影)$/i.test(folderName)) {
      return result
    }
    if (videoItems.some((item: WebdavDirectoryVideoFileIndex): boolean =>
      /(?:剧场版|劇場版|电影版|電影版|映画)/.test(item.name))) {
      return result
    }
    const title = WebdavMediaPathEvidence.pickDirectorySeriesTitle(currentPath, '')
    if (!WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
      return result
    }
    const pathContext = WebdavMediaPathEvidence.buildPathTvScanContext(currentPath)
    const childSeasons: number[] = []
    directoryItems.forEach((item: WebdavBrowseItem): void => {
      if (item.isDirectory) {
        const season = WebdavVideoNameParser.extractSeasonNumberFromText(item.name)
        if (season > 0 && childSeasons.indexOf(season) < 0) {
          childSeasons.push(season)
        }
      }
    })
    const season = pathContext.isTv ? pathContext.seasonNumber :
      (childSeasons.length >= 2 ? WEBDAV_UNKNOWN_SEASON : WebdavMediaPathEvidence.resolveDirectorySeasonNumber(currentPath))
    const names: string[] = videoItems.map((item: WebdavDirectoryVideoFileIndex): string => item.name)
    const evidence = WebdavConsecutiveEpisodeHelper.collect(names, season)
    if (evidence.length === 0) {
      return result
    }
    const hasStrongEvidence = evidence.some((item: WebdavConsecutiveEpisodeEvidence): boolean => item.explicit)
    if (!hasStrongEvidence && WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath).mediaType === 'movie') {
      // 当前作品目录明确声明总集数，并且多数文件提供连续编号时，允许覆盖上层电影分类。
      const directoryEpisodeCount = WebdavVideoTitleNoiseDictionary.readDirectoryEpisodeCount(folderName)
      const currentDirectoryTitle = WebdavVideoNameParser.cleanSeriesDirectoryTitle(folderName)
      const hasDirectoryEpisodeEvidence = directoryEpisodeCount >= WEBDAV_MIN_CONSECUTIVE_EPISODES &&
        WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(currentDirectoryTitle) && currentDirectoryTitle === title &&
        evidence.every((item: WebdavConsecutiveEpisodeEvidence): boolean => item.episodeNumber <= directoryEpisodeCount)
      if (!hasDirectoryEpisodeEvidence) {
        return result
      }
    }
    result.isTv = true
    result.title = title
    result.seasonNumber = season
    result.reason = 'consecutive_episode_priority'
    result.videoCount = videoItems.length
    result.episodeLikeCount = evidence.length
    evidence.forEach((item: WebdavConsecutiveEpisodeEvidence): void => {
      result.consecutiveByName.set(item.fileName, item)
    })
    return result
  }

  /**
   * 识别“1883/1883.S01E01”这种没有独立季目录的纯数字节目名。
   * 必须位于节目分类下，且至少两个文件、八成以上文件重复同一数字标题并带明确季集标记。
   */
  static buildNumericSeriesDirectoryContext(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    if (videoItems.length < 2 ||
      WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath).mediaType !== 'tv') {
      return context
    }
    const folderName = WebdavVideoNameParser.getLastPathName(currentPath)
    const numericMatch = /^\s*((?:18|19|20)\d{2})\s*$/.exec(folderName)
    if (numericMatch === null || numericMatch[1]! === undefined) {
      return context
    }
    const numericTitle = numericMatch[1]! // 关键变量：可能是年份桶，也可能是《1883》这样的节目名。
    const repeatedEpisodePattern = new RegExp(
      `^\\s*${numericTitle}[\\s._\\-–—:：]+(?:S\\s*0*\\d{1,2}[\\s._\\-]*E\\s*0*\\d{1,4}|\\d{1,2}x\\d{1,4})`,
      'i'
    )
    let matchedCount = 0
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined && repeatedEpisodePattern.test(entry.fileStem)) {
        matchedCount += 1
      }
      index += 1
    }
    const requiredCount = Math.max(2, Math.ceil(videoItems.length * 0.8))
    if (matchedCount < requiredCount) {
      return context
    }
    context.isTv = true
    context.title = numericTitle
    context.seasonNumber = 1
    context.videoCount = videoItems.length
    context.episodeLikeCount = matchedCount
    context.reason = 'numeric_series_file_consensus'
    return context
  }

  /** 沿用既有文件名排序生成备用集号映射，每个目录分支只构建一次。 */
  static buildDirectoryFallbackEpisodeMap(videoItems: WebdavDirectoryVideoFileIndex[]): Map<string, number> {
    const map: Map<string, number> = new Map()
    const sorted = videoItems.slice()
    sorted.sort((a: WebdavDirectoryVideoFileIndex, b: WebdavDirectoryVideoFileIndex): number => {
      const left = `${a.name || ''}`.toLowerCase()
      const right = `${b.name || ''}`.toLowerCase()
      if (left < right) {
        return -1
      }
      if (left > right) {
        return 1
      }
      return 0
    })
    let index = 0
    while (index < sorted.length) {
      const entry = sorted[index]!
      if (entry !== undefined) {
        map.set(entry.path, index + 1)
      }
      index += 1
    }
    return map
  }

  /** 从明确季集文件提取目录节目标题和季号。 */
  static buildExplicitEpisodeDirectoryContext(
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    context.videoCount = videoItems.length
    context.episodeLikeCount = WebdavMediaEpisodeEvidence.countEpisodeLikeVideoItems(videoItems)
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined && WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(entry.name)) {
        const parsed = WebdavVideoNameParser.parse(entry.name, entry.path)
        if (parsed.mediaType === 'tv') {
          const title = WebdavMediaPathEvidence.pickDirectorySeriesTitle(currentPath, parsed.query)
          if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
            context.isTv = true
            context.title = title
            context.seasonNumber = parsed.seasonNumber > 0 ||
              WebdavVideoNameParser.isSeasonZeroEpisodeFileName(entry.name) ? parsed.seasonNumber :
              WebdavMediaPathEvidence.resolveDirectorySeasonNumber(currentPath)
            context.reason = 'episode_file_marker'
            return context
          }
        }
      }
      index += 1
    }
    return context
  }

  /**
   * 判断明确季集文件是否足以覆盖上级“电影”分类。
   * 只有多数文件都使用 SxxExx 等强标记时生效，剧场版目录继续按电影处理。
   */
  static shouldExplicitEpisodesOverrideMovieCategory(
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): boolean {
    if (videoItems.length < 2) {
      return false
    }
    const folderTitle = WebdavVideoNameParser.cleanSeriesDirectoryTitle(
      WebdavVideoNameParser.getLastPathName(currentPath)
    )
    const rawFolderName = WebdavVideoNameParser.getLastPathName(currentPath)
    if (WebdavMediaPathEvidence.isSpecialEpisodeDirectoryTitle(folderTitle) || /(?:剧场版|劇場版|电影版|電影版|映画)/i.test(rawFolderName)) {
      return false
    }
    let explicitEpisodeCount = 0 // 关键变量：真正包含季集标记的文件数，不包含 H.264、年份等弱数字。
    let index = 0
    while (index < videoItems.length) {
      const item = videoItems[index]!
      if (item !== undefined && WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(item.name)) {
        explicitEpisodeCount += 1
      }
      index += 1
    }
    const requiredCount = Math.max(2, Math.ceil(videoItems.length * 0.6))
    return explicitEpisodeCount >= requiredCount
  }

  /** 读取日期开头的期次，只接受真实日历日期，不把年份、分辨率或普通数字当日期。 */
  private static readLeadingBroadcastDate(fileStem: string): string {
    const match = /^((?:19|20)\d{2})(\d{2})(\d{2})(?:期)?(?=$|[\s._\-–—:：])/.exec(fileStem.trim())
    if (match === null) {
      return ''
    }
    const year = Number(match[1]!)
    const month = Number(match[2]!)
    const day = Number(match[3]!)
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return ''
    }
    return `${match[1]!}${match[2]!}${match[3]!}`
  }

  /** 同目录多数文件以不同播出日期命名时，借用当前作品目录标题；未命中的文件仍走原规则。 */
  static buildBareDateEpisodeDirectoryContext(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    const folderName = WebdavVideoNameParser.getLastPathName(currentPath)
    const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(folderName)
    if (videoItems.length < 2 || !WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title) ||
      WebdavMediaPathEvidence.isCollectionContainerDirectory(currentPath) ||
      WebdavMediaPathEvidence.hasMovieTitleHint(folderName) ||
      WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath).mediaType === 'movie' ||
      WebdavMediaEpisodeEvidence.countEpisodeLikeVideoItems(videoItems) > 0) {
      return context
    }
    // 已有明确季目录沿用原规则；日期本身只能证明期次，不能推断官方季号。
    if (WebdavMediaPathEvidence.buildPathTvScanContext(currentPath).isTv) {
      return context
    }
    // 文件日期与不同日期分开统计，同一天的不同清晰度不能单独构成节目证据。
    const datesByName: Map<string, string> = new Map()
    const distinctDates: Set<string> = new Set()
    videoItems.forEach((entry: WebdavDirectoryVideoFileIndex): void => {
      if (WebdavMediaPathEvidence.hasMovieTitleHint(entry.name)) {
        return
      }
      const date = WebdavMediaEpisodeEvidence.readLeadingBroadcastDate(entry.fileStem)
      if (date.length > 0) {
        datesByName.set(entry.name, date)
        distinctDates.add(date)
      }
    })
    if (distinctDates.size < 2 || datesByName.size < Math.ceil(videoItems.length * 0.6)) {
      return context
    }
    // 同一天的正片、加更和企划保留不同文件条目，不仅凭日期合并成同一集的版本。
    const sortedNames: string[] = []
    datesByName.forEach((_date: string, name: string): void => { sortedNames.push(name) })
    sortedNames.sort((left: string, right: string): number => {
      const leftDate = datesByName.get(left) || ''
      const rightDate = datesByName.get(right) || ''
      if (leftDate !== rightDate) {
        return leftDate < rightDate ? -1 : 1
      }
      return left.localeCompare(right, 'zh-CN')
    })
    context.isTv = true
    context.title = title
    context.seasonNumber = WEBDAV_UNKNOWN_SEASON
    context.reason = 'date_episode_priority'
    context.videoCount = videoItems.length
    context.episodeLikeCount = datesByName.size
    sortedNames.forEach((name: string, index: number): void => {
      const evidence = new WebdavConsecutiveEpisodeEvidence()
      evidence.fileName = name
      evidence.seasonNumber = context.seasonNumber
      evidence.episodeNumber = index + 1
      evidence.matchMode = 'broadcast_date'
      context.consecutiveByName.set(name, evidence)
    })
    return context
  }

  /** 识别“节目名 20180207 单集标题”这类按播出日期归档的节目目录。 */
  static buildDateEpisodeDirectoryContext(
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    context.videoCount = videoItems.length
    if (videoItems.length < 2) {
      return context
    }
    // 关键变量：同一清洗标题在当前目录中出现的日期节目文件数量。
    const titleCounts: Map<string, WebdavDateEpisodeTitleCount> = new Map()
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        const match = /^(.*?)\s*(?:19|20)\d{2}[01]\d[0-3]\d(?:$|[\s._\-–—:：])/.exec(entry.fileStem)
        if (match !== null && match[1]! !== undefined) {
          const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(match[1]!)
          if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
            const key = normalizeWebdavVideoSearchText(title)
            let count = titleCounts.get(key)
            if (count === undefined) {
              count = new WebdavDateEpisodeTitleCount()
              count.title = title
              titleCounts.set(key, count)
            }
            count.count += 1
          }
        }
      }
      index += 1
    }
    let best = new WebdavDateEpisodeTitleCount()
    titleCounts.forEach((count: WebdavDateEpisodeTitleCount): void => {
      if (count.count > best.count) {
        best = count
      }
    })
    const requiredCount = Math.max(2, Math.ceil(videoItems.length * 0.6))
    if (best.count < requiredCount || best.title.length === 0) {
      return context
    }
    context.isTv = true
    context.title = best.title
    context.seasonNumber = WebdavMediaPathEvidence.resolveDirectorySeasonNumber(currentPath)
    context.reason = 'date_episode_sequence'
    context.episodeLikeCount = best.count
    return context
  }

  /** 结合分类路径、显式季集和连续裸集号提取节目证据。 */
  static buildHintedDirectoryTvScanContext(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    context.videoCount = videoItems.length
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    const normalizedCurrentPath = normalizeWebdavPath(currentPath)
    const hasSeriesHint = WebdavMediaPathEvidence.hasEffectiveSeriesPathHint(normalizedRootPath, normalizedCurrentPath)
    const explicitEpisodeCount = WebdavMediaEpisodeEvidence.countEpisodeLikeVideoItems(videoItems)
    const consecutiveBareEpisodeCount = WebdavMediaEpisodeEvidence.countConsecutiveBareEpisodeItems(videoItems)
    // 关键变量：裸集号与整体文件名比对使用同一个连续数量门槛。
    const hasBareEpisodeConsensus = consecutiveBareEpisodeCount >= WEBDAV_MIN_CONSECUTIVE_EPISODES
    const episodeLikeCount = explicitEpisodeCount + consecutiveBareEpisodeCount
    context.episodeLikeCount = episodeLikeCount
    if (!hasSeriesHint && explicitEpisodeCount <= 0 && !hasBareEpisodeConsensus) {
      return context
    }
    if (normalizedCurrentPath === normalizedRootPath && episodeLikeCount <= 0) {
      return context
    }
    if (hasSeriesHint && episodeLikeCount <= 0 && normalizedCurrentPath === normalizedRootPath) {
      return context
    }
    const title = WebdavMediaPathEvidence.pickDirectorySeriesTitle(currentPath, '')
    if (!WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
      return context
    }
    context.isTv = true
    context.title = title
    context.seasonNumber = WebdavMediaPathEvidence.resolveDirectorySeasonNumber(currentPath)
    context.reason = hasSeriesHint ? 'series_path_hint' :
      (hasBareEpisodeConsensus ? 'consecutive_bare_episode_files' : 'explicit_episode_files')
    return context
  }

  /**
   * 计算目录内最长的连续纯数字集号序列。
   * 只认 01/02/03 这类裸集号，片名中的年份、编码和声道数字不参与。
   */
  static countConsecutiveBareEpisodeItems(videoItems: WebdavDirectoryVideoFileIndex[]): number {
    const episodeNumbers: number[] = []
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        const episodeNumber = WebdavVideoNameParser.inferBareEpisodeNumberFromFileName(entry.name)
        if (episodeNumber > 0 && episodeNumbers.indexOf(episodeNumber) < 0) {
          episodeNumbers.push(episodeNumber)
        }
      }
      index += 1
    }
    episodeNumbers.sort((left: number, right: number): number => left - right)
    let longestCount = 0 // 关键变量：只有连续编号才能证明这是剧集序列。
    let currentCount = 0
    let previousNumber = -1
    let numberIndex = 0
    while (numberIndex < episodeNumbers.length) {
      const episodeNumber = episodeNumbers[numberIndex]!
      currentCount = previousNumber > 0 && episodeNumber === previousNumber + 1 ? currentCount + 1 : 1
      if (currentCount > longestCount) {
        longestCount = currentCount
      }
      previousNumber = episodeNumber
      numberIndex += 1
    }
    return longestCount
  }
}
