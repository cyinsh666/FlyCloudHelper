/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { normalizeWebdavPath } from './path.js'
import { WebdavScannedVideoFile } from './models.js'
import { normalizeWebdavVideoSearchText, WebdavVideoNameParser } from './WebdavVideoNameParser.js'
import { WebdavVideoTitleCleaner } from './WebdavVideoTitleCleaner.js'
import { WebdavVideoTitleNoiseDictionary } from './WebdavVideoTitleNoiseDictionary.js'
import { WebdavDirectoryTvScanContext, WebdavNearestPathTypeHint } from './WebdavMediaRecognitionModels.js'

const WEBDAV_VIDEO_MOVIE_TITLE_HINT_PATTERN: RegExp =
  /(?:剧场版|劇場版|电影版|電影版|映画|代号\s*[:：]?\s*白|(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:电影|国影)(?:$|[\s._+\-–—:：,，;；/\\|·•])|\bmovie\b|\bfilm\b)/i
const WEBDAV_VIDEO_MOVIE_CATEGORY_PATH_HINT_PATTERN: RegExp =
  /(?:电影篇|网络电影合集|网络电影|电影合集|影片合集|大片合集|爆火大片|院线大片|国影|好莱坞巨制|海外巨制|剧情片|动作片|喜剧片|科幻片|奇幻片|悬疑片|犯罪片|惊悚片|恐怖片|爱情片|战争片|动画电影|纪录片\s*&\s*剧情片|\bmovies?\b|\bfilms?\b)/i
const WEBDAV_VIDEO_MOVIE_DIRECTORY_TYPE_HINT_PATTERN: RegExp =
  /(?:剧场版|劇場版|电影版|電影版|映画|电影篇|网络电影合集|网络电影|电影合集|影片合集|大片合集|爆火大片|院线大片|院线|国影|好莱坞巨制|海外巨制|剧情片|动作片|喜剧片|科幻片|奇幻片|悬疑片|犯罪片|惊悚片|恐怖片|爱情片|战争片|动画电影|动漫电影|纪录片\s*&\s*剧情片|(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:影片|电影)(?:$|[\s._+\-–—:：,，;；/\\|·•])|\bmovies?\b|\bfilms?\b|\bmovie\b|\bfilm\b)/i
const WEBDAV_VIDEO_TV_DIRECTORY_TYPE_HINT_PATTERN: RegExp =
  /(?:电视剧|剧集|连续剧|国产剧|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|陆剧|短剧|网剧|番剧|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫(?!电影)|动画(?!电影)|动态漫画|动态漫|漫剧|漫画|综艺|tv\s*shows?|shows?|season|series|第\s*[0-9一二三四五六七八九十两]{1,3}\s*季|\d{1,4}\s*集全|全\s*\d{1,4}\s*集|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集)/i
const WEBDAV_VIDEO_MOVIE_COLLECTION_RANGE_TITLE_PATTERN: RegExp =
  /(?:\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}\s*部|\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}$|(?:^|[^第\d])\d{1,2}\s*部\s*(?:4k|8k|hdr)?$|(?:^|[^第0-9一二三四五六七八九十两])[一二三四五六七八九十两]{1,3}\s*[季部])/i

/** 路径分类、标题和季目录证据；只处理内存数据。 */
export class WebdavMediaPathEvidence {
  /** 混合分类或接收目录按文件识别，不允许整体继承单一影片身份。 */
  static isMixedMediaBucketDirectory(path: string): boolean {
    const folderName = WebdavVideoNameParser.getLastPathName(normalizeWebdavPath(path))
    return normalizeWebdavVideoSearchText(folderName) === '最近接收' ||
      WebdavVideoTitleNoiseDictionary.isMixedMediaCategoryTitle(folderName)
  }

  /** 从叶子父目录向上查找最近的单类型目录提示；混合目录会立即终止查找。 */
  static buildNearestAncestorPathTypeHint(rootPath: string, parentPath: string): WebdavNearestPathTypeHint {
    const result = new WebdavNearestPathTypeHint()
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    // 关键变量：从视频父目录开始向上移动，depth 越小代表路径类型提示越近。
    let cursor = normalizeWebdavPath(parentPath)
    let depth = 0
    while (cursor.length > 0 && cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      const movieMatched = WebdavMediaPathEvidence.hasMovieDirectoryTypeHint(folderName)
      const tvMatched = WebdavMediaPathEvidence.hasTvDirectoryTypeHint(folderName)
      if (WebdavMediaPathEvidence.isMixedMediaBucketDirectory(cursor) || (movieMatched && tvMatched)) {
        result.mediaType = 'mixed'
        result.folderName = folderName
        result.folderPath = cursor
        result.depth = depth
        result.movieMatched = true
        result.tvMatched = true
        return result
      }
      if (movieMatched || tvMatched) {
        result.mediaType = movieMatched ? 'movie' : 'tv'
        result.folderName = folderName
        result.folderPath = cursor
        result.depth = depth
        result.movieMatched = movieMatched
        result.tvMatched = tvMatched
        return result
      }
      if (cursor === normalizedRootPath) {
        break
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
      depth += 1
    }
    return result
  }

  /** 判断单层目录名是否包含明确电影类型关键词。 */
  static hasMovieDirectoryTypeHint(folderName: string): boolean {
    const text = `${folderName || ''}`.trim()
    if (text.length === 0) {
      return false
    }
    return WEBDAV_VIDEO_MOVIE_DIRECTORY_TYPE_HINT_PATTERN.test(text) ||
      WebdavMediaPathEvidence.hasMovieTitleHint(text) ||
      WebdavMediaPathEvidence.hasMovieCategoryPathHint(text)
  }

  /** 识别剧场版、电影版等文件名电影提示。 */
  static hasMovieTitleHint(value: string): boolean {
    return WEBDAV_VIDEO_MOVIE_TITLE_HINT_PATTERN.test(`${value || ''}`)
  }

  /** 判断路径是否包含明确电影分类词，避免电影分类目录被上级混合库误判成剧集。 */
  static hasMovieCategoryPathHint(path: string): boolean {
    return WEBDAV_VIDEO_MOVIE_CATEGORY_PATH_HINT_PATTERN.test(`${path || ''}`)
  }

  /** 判断单层目录名是否包含明确节目类型关键词。 */
  static hasTvDirectoryTypeHint(folderName: string): boolean {
    const text = `${folderName || ''}`.trim()
    if (text.length === 0) {
      return false
    }
    return WEBDAV_VIDEO_TV_DIRECTORY_TYPE_HINT_PATTERN.test(text)
  }

  /** 判断标题是否是电影合集范围，而不是单部影片名。 */
  static isMovieCollectionRangeTitle(title: string): boolean {
    return WEBDAV_VIDEO_MOVIE_COLLECTION_RANGE_TITLE_PATTERN.test(`${title || ''}`)
  }

  /** 排除分类桶、合集和特别篇，确认目录标题可用于电影查询。 */
  static isUsableDirectoryMovieTitle(title: string): boolean {
    return title.length > 0 &&
      !WebdavVideoTitleCleaner.isGenericBucketTitle(title) &&
      !WebdavVideoNameParser.isGenericSeriesTitle(title) &&
      !WebdavVideoNameParser.isGenericMovieFileTitle(title) &&
      !WebdavMediaPathEvidence.isSpecialEpisodeDirectoryTitle(title) &&
      !WebdavMediaPathEvidence.isCollectionDirectoryTitle(title)
  }

  /** 判断标题是否只是特别篇、番外或剧场版分类。 */
  static isSpecialEpisodeDirectoryTitle(title: string): boolean {
    const normalized = normalizeWebdavVideoSearchText(title)
    return normalized === '剧场版' ||
      normalized === '劇場版' ||
      normalized.indexOf('剧场版 ') === 0 ||
      normalized.indexOf('劇場版 ') === 0 ||
      normalized === '特别篇' ||
      normalized.indexOf('特别篇 ') === 0 ||
      normalized === '番外' ||
      normalized.indexOf('番外 ') === 0
  }

  /** 判断标题是否表示系列合集或季部范围。 */
  static isCollectionDirectoryTitle(title: string): boolean {
    const normalized = normalizeWebdavVideoSearchText(title)
    return normalized === '系列' ||
      normalized === '合集' ||
      normalized.indexOf('合集') >= 0 ||
      normalized.indexOf('系列') >= 0 ||
      WEBDAV_VIDEO_MOVIE_COLLECTION_RANGE_TITLE_PATTERN.test(title) ||
      normalized.indexOf(' 系列') > 0 ||
      normalized.indexOf(' 系列 ') > 0 ||
      normalized.indexOf(' 合集') > 0 ||
      normalized.indexOf(' collection') > 0 ||
      normalized.indexOf(' trilogy') > 0
  }

  /** 比较清洗后的文件标题与目录标题是否相同或互相包含。 */
  static fileTitleMatchesDirectoryTitle(fileTitle: string, directoryTitle: string): boolean {
    const left = normalizeWebdavVideoSearchText(fileTitle)
    const right = normalizeWebdavVideoSearchText(directoryTitle)
    if (left.length === 0 || right.length === 0) {
      return false
    }
    return left === right || left.indexOf(right) >= 0 || right.indexOf(left) >= 0
  }

  /** 优先使用给定节目名，否则沿父目录寻找有效节目标题。 */
  static pickDirectorySeriesTitle(currentPath: string, preferredTitle: string): string {
    const preferred = WebdavVideoNameParser.cleanSeriesDirectoryTitle(preferredTitle)
    if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(preferred)) {
      return preferred
    }
    const normalizedCurrentPath = normalizeWebdavPath(currentPath)
    let cursor = normalizedCurrentPath
    while (cursor !== '/') {
      if (WebdavMediaPathEvidence.isMixedMediaBucketDirectory(cursor)) {
        break
      }
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      if (!WebdavMediaPathEvidence.isSubtitleGroupDirectoryName(folderName) &&
        !WebdavVideoNameParser.startsWithSeasonFolderName(folderName) &&
        !WebdavVideoNameParser.isEpisodeRangeFolderName(folderName)) {
        const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(folderName)
        if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
          return title
        }
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return ''
  }

  /** 排除通用分类、弱标题、特别篇和合集标题。 */
  static isUsableDirectorySeriesTitle(title: string): boolean {
    return title.length > 0 &&
      !WebdavVideoNameParser.isGenericSeriesTitle(title) &&
      !WebdavVideoNameParser.isWeakScrapeTitle(title) &&
      !WebdavMediaPathEvidence.isSpecialEpisodeDirectoryTitle(title) &&
      !WebdavMediaPathEvidence.isCollectionDirectoryTitle(title)
  }

  /** 字幕组和压制组容器不能覆盖更上层的真实节目名称。 */
  static isSubtitleGroupDirectoryName(folderName: string): boolean {
    return /(?:字幕组|字幕社|压制组|翻译组)/i.test(`${folderName || ''}`)
  }

  /** 从近到远读取目录季号，保留明确第零季，无季号时沿用第一季。 */
  static resolveDirectorySeasonNumber(currentPath: string): number {
    let cursor = normalizeWebdavPath(currentPath)
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      if (WebdavVideoNameParser.isSpecialSeasonFolderName(folderName) ||
        WebdavVideoNameParser.isSeasonZeroText(folderName)) {
        return 0
      }
      const seasonNumber = WebdavVideoNameParser.extractSeasonNumberFromText(folderName)
      if (seasonNumber > 0) {
        return seasonNumber
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return 1
  }

  /** 识别当前目录是否为电影系列或合集容器。 */
  static isCollectionContainerDirectory(path: string): boolean {
    const folderName = WebdavVideoNameParser.getLastPathName(path)
    const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(folderName)
    return WebdavMediaPathEvidence.isCollectionDirectoryTitle(title) || /(?:系列|合集|collection|trilogy)/i.test(folderName)
  }

  /** 从季目录和重复节目标题中提取路径级节目证据。 */
  static buildPathTvScanContext(directoryPath: string): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    const normalizedDirectoryPath = normalizeWebdavPath(directoryPath)
    if (normalizedDirectoryPath === '/' || WebdavMediaPathEvidence.isMixedMediaBucketDirectory(normalizedDirectoryPath)) {
      return context
    }
    const folderName = WebdavVideoNameParser.getLastPathName(normalizedDirectoryPath)
    const parentPath = WebdavVideoNameParser.getParentPath(normalizedDirectoryPath)
    const parentName = WebdavVideoNameParser.getLastPathName(parentPath)
    const seasonNumber = WebdavVideoNameParser.extractSeasonNumberFromText(folderName)
    if (WebdavVideoNameParser.startsWithSeasonFolderName(folderName)) {
      if (WebdavMediaPathEvidence.isMovieCollectionRangeTitle(parentName)) {
        return context
      }
      const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(parentName)
      if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
        context.isTv = true
        context.title = title
        context.seasonNumber = WebdavVideoNameParser.isSpecialSeasonFolderName(folderName) ||
          WebdavVideoNameParser.isSeasonZeroText(folderName) ? 0 :
          (seasonNumber > 0 ? seasonNumber : 1)
        context.reason = 'season_folder'
      }
      return context
    }
    if (seasonNumber > 0 && WebdavMediaPathEvidence.directoryNameContainsParentTitle(folderName, parentName)) {
      const numericSeriesTitle = WebdavMediaPathEvidence.pickRepeatedNumericSeasonSeriesTitle(folderName, parentName)
      if (numericSeriesTitle.length > 0) {
        context.isTv = true
        context.title = numericSeriesTitle
        context.seasonNumber = seasonNumber
        context.reason = 'numeric_series_title_season_folder'
        return context
      }
      const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(parentName)
      if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
        context.isTv = true
        context.title = title
        context.seasonNumber = seasonNumber
        context.reason = 'series_title_season_folder'
      }
      return context
    }
    if (seasonNumber > 0 && WebdavMediaPathEvidence.hasSeasonDirectoryTitleHint(folderName)) {
      const numericSeriesTitle = WebdavMediaPathEvidence.pickRepeatedNumericSeasonSeriesTitle(folderName, parentName)
      if (numericSeriesTitle.length > 0) {
        context.isTv = true
        context.title = numericSeriesTitle
        context.seasonNumber = seasonNumber
        context.reason = 'numeric_series_title_season_folder'
        return context
      }
      const title = WebdavMediaPathEvidence.pickSeasonDirectorySeriesTitle(folderName, parentName)
      if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
        context.isTv = true
        context.title = title
        context.seasonNumber = seasonNumber
        context.reason = 'season_title_folder'
      }
      return context
    }
    return WebdavMediaPathEvidence.buildAncestralSeasonTvScanContext(normalizedDirectoryPath)
  }

  /** 检查季目录名称是否包含父目录节目标题。 */
  static directoryNameContainsParentTitle(folderName: string, parentName: string): boolean {
    const folderText = normalizeWebdavVideoSearchText(folderName)
    const parentText = normalizeWebdavVideoSearchText(parentName)
    return parentText.length > 0 && folderText.indexOf(parentText) >= 0
  }

  /**
   * 识别“1923/1923.第一季”这种片名本身是四位数字的节目。
   * 必须由父目录和带季号子目录重复声明同一数字，普通年份桶不会命中。
   */
  static pickRepeatedNumericSeasonSeriesTitle(folderName: string, parentName: string): string {
    const parentMatch = /^\s*((?:18|19|20)\d{2})\s*$/.exec(`${parentName || ''}`)
    if (parentMatch === null || parentMatch[1]! === undefined) {
      return ''
    }
    const numericTitle = parentMatch[1]! // 关键变量：父目录明确重复的纯数字节目名。
    const repeatedTitlePattern = new RegExp(`^\\s*${numericTitle}(?:$|[\\s._\\-–—:：])`, 'i')
    return repeatedTitlePattern.test(`${folderName || ''}`) && WebdavMediaPathEvidence.hasSeasonDirectoryTitleHint(folderName) ?
      numericTitle : ''
  }

  /** 判断目录名是否自带季信息，例如“神龙骑士第三季”。 */
  static hasSeasonDirectoryTitleHint(folderName: string): boolean {
    return /(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季/i.test(`${folderName || ''}`) ||
      /(?:season|series|s)\s*\d{1,2}/i.test(`${folderName || ''}`)
  }

  /** 从带季信息的目录名中提取剧名，避免把“第一季/全11集/音轨”带进 TMDB 查询。 */
  static pickSeasonDirectorySeriesTitle(folderName: string, parentName: string): string {
    let text = `${folderName || ''}`
    text = text.replace(/[\s._\-–—:：]*(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季(?:$|[\s._\-–—:：].*)/i, ' ')
    text = text.replace(/[\s._\-–—:：]*(?:season|series|s)\s*\d{1,2}(?:$|[\s._\-–—:：].*)/i, ' ')
    let title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(text)
    if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
      return title
    }
    title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(parentName)
    return WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title) ? title : ''
  }

  /** 从祖先季目录中提取节目名与季号。 */
  static buildAncestralSeasonTvScanContext(directoryPath: string): WebdavDirectoryTvScanContext {
    const context = new WebdavDirectoryTvScanContext()
    const normalizedDirectoryPath = normalizeWebdavPath(directoryPath)
    const parts = normalizedDirectoryPath.split('/')
    let index = parts.length - 1
    while (index > 1) {
      const part = parts[index]!
      if (part !== undefined && WebdavMediaPathEvidence.isMixedMediaBucketDirectory(part)) {
        break
      }
      if (part !== undefined && WebdavVideoNameParser.startsWithSeasonFolderName(part)) {
        const parentName = parts[index - 1]!
        if (parentName !== undefined) {
          const title = WebdavVideoNameParser.cleanSeriesDirectoryTitle(parentName)
          if (WebdavMediaPathEvidence.isUsableDirectorySeriesTitle(title)) {
            context.isTv = true
            context.title = title
            context.seasonNumber = WebdavVideoNameParser.isSpecialSeasonFolderName(part) ? 0 :
              WebdavMediaPathEvidence.resolveDirectorySeasonNumber(part)
            context.reason = 'ancestor_season_folder'
            return context
          }
        }
      }
      index -= 1
    }
    return context
  }

  /** 只在有效子路径里识别剧集提示，避免 rootPath 的“电视剧”污染所有子目录。 */
  static hasEffectiveSeriesPathHint(rootPath: string, currentPath: string): boolean {
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    const normalizedCurrentPath = normalizeWebdavPath(currentPath)
    const nearestPathTypeHint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(normalizedRootPath, normalizedCurrentPath)
    return nearestPathTypeHint.mediaType === 'tv'
  }

  /** 检查文件名或父目录是否声明明确的季集结构。 */
  static hasExplicitTvStructure(file: WebdavScannedVideoFile): boolean {
    const parentName = WebdavVideoNameParser.getLastPathName(file.parentPath)
    if (/^season\s*\d+$/i.test(parentName)) {
      return true
    }
    if (/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}/.test(file.name)) {
      return true
    }
    return /(?:第\s*)?\d{1,4}\s*[集话話]/.test(file.name)
  }

  /** 读取既有宽泛节目路径提示，供显式标识判型及诊断复用。 */
  static hasSeriesPathHintForLog(value: string): boolean {
    const text = `${value || ''}`.toLowerCase()
    if (text.indexOf('电视剧') >= 0 ||
      text.indexOf('剧集') >= 0 ||
      text.indexOf('连续剧') >= 0 ||
      text.indexOf('番剧') >= 0 ||
      text.indexOf('动漫') >= 0 ||
      text.indexOf('动画') >= 0 ||
      text.indexOf('综艺') >= 0 ||
      text.indexOf('season') >= 0 ||
      text.indexOf('series') >= 0) {
      return true
    }
    if (/第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部)/.test(value)) {
      return true
    }
    return /\d{1,4}\s*集全/.test(value)
  }
}
