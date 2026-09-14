/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { normalizeWebdavPath } from './path.js'
import { normalizeWebdavVideoSearchText, WebdavVideoNameParser } from './WebdavVideoNameParser.js'
import { WebdavVideoTitleCleaner } from './WebdavVideoTitleCleaner.js'
import { WebdavDirectoryVideoFileIndex, WebdavMovieSeriesPartQuery } from './WebdavMediaRecognitionModels.js'
import { WebdavMediaPathEvidence } from './WebdavMediaPathEvidence.js'

const WEBDAV_VIDEO_MOVIE_FILE_NOISE_PATTERN: RegExp =
  /(?:4\s*k|8\s*k|\bhd\b|hq|edr|sdr|超清|高清|超高清|高码率|码率|hdr|60\s*fps|120\s*fps|2160\s*p|1080\s*p|720\s*p|web[-.\s]?dl|web[-.\s]?rip|dvdrip|h\.?26[45]|x\.?26[45]|ddp|aac|dts|bestweb|batweb|bothd|btufo|wfysfx|hdts|clean|audio|国语中字|净版|高码|内嵌特效|中字|字幕)/i
const WEBDAV_TMDB_QUERY_NOISE_PATTERN: RegExp =
  /\b(?:new|clean|hd|hq|sdr|edr|hdts|audio|dual|chinese|latino|japanese|english|chs|cht|bestweb|batweb|bothd|btufo|ourtv|web|dl|rip|x264|x265|h264|h265|aac|ddp|dts|wfysfx)\b/ig

/** 电影版本、合集和分部证据；只处理内存数据。 */
export class WebdavMediaMovieEvidence {
  /** 结合文件名与父目录标题选取可用电影查询词。 */
  static pickMovieDirectoryTitle(rootPath: string, parentPath: string, fileName: string): string {
    const normalizedParentPath = normalizeWebdavPath(parentPath)
    const parentName = WebdavVideoNameParser.getLastPathName(normalizedParentPath)
    const parentIsCollectionRange = WebdavMediaPathEvidence.isMovieCollectionRangeTitle(parentName)
    const parentTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(parentName)
    if (!WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(parentTitle)) {
      return ''
    }
    const parsed = WebdavVideoNameParser.parse(fileName, normalizeWebdavPath(`${normalizedParentPath}/${fileName}`))
    if (parentIsCollectionRange && !WebdavVideoNameParser.isGenericMovieFileTitle(parsed.title)) {
      return ''
    }
    if (WebdavMediaMovieEvidence.shouldPreferParentMovieTitle(fileName, parsed.title, parentTitle)) {
      return parentTitle
    }
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    if (normalizedParentPath !== normalizedRootPath &&
      !WebdavMediaPathEvidence.isMovieCollectionRangeTitle(parentTitle) &&
      WebdavMediaPathEvidence.fileTitleMatchesDirectoryTitle(parsed.title, parentTitle)) {
      return parentTitle
    }
    return ''
  }

  /** 判断电影文件名是否更像清晰度、音轨或发布组，适合回退到父目录片名。 */
  static shouldPreferParentMovieTitle(fileName: string, parsedTitle: string, parentTitle: string): boolean {
    if (WebdavMediaPathEvidence.isMovieCollectionRangeTitle(parentTitle) || WebdavVideoTitleCleaner.isGenericBucketTitle(parentTitle)) {
      return false
    }
    if (WebdavVideoTitleCleaner.shouldPreferDirectoryTitle(fileName, parsedTitle, parentTitle)) {
      return true
    }
    if (WebdavVideoNameParser.isGenericMovieFileTitle(parsedTitle)) {
      return true
    }
    const normalizedTitle = normalizeWebdavVideoSearchText(parsedTitle)
    if (normalizedTitle.length === 0) {
      return true
    }
    const rawFileName = `${fileName || ''}`
    const parentHasChineseTitle = /[\u4e00-\u9fa5]/.test(parentTitle)
    const titleHasChinese = /[\u4e00-\u9fa5]/.test(parsedTitle)
    // 关键变量：文件噪声命中，表示文件名主要是清晰度、音轨、字幕或发布组。
    const hasFileNoise = WEBDAV_VIDEO_MOVIE_FILE_NOISE_PATTERN.test(rawFileName) ||
      WEBDAV_VIDEO_MOVIE_FILE_NOISE_PATTERN.test(parsedTitle)
    if (parentHasChineseTitle && !titleHasChinese && hasFileNoise) {
      return true
    }
    const titleWithoutNoise = normalizedTitle
      .replace(/(?:国语中字|中字|净版|高码率|码率|高码|超高清|高清|超清|内嵌特效|官方中字|音轨|字幕|tv|率)/g, ' ')
      .replace(WEBDAV_TMDB_QUERY_NOISE_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (hasFileNoise && titleWithoutNoise.length === 0) {
      return true
    }
    if (hasFileNoise && /^(?:国语中字|中字|净版|高码率|码率|高码|超高清|高清|超清|内嵌特效|ddp|aac|dts|bestweb|batweb|bothd|btufo|wfysfx|hd|hq|sdr|edr|hdr|fps|audio|clean|new|web|dl|rip|tv\s*率|[a-z0-9\s._-]{1,16})$/i.test(normalizedTitle)) {
      return true
    }
    return false
  }

  /** 明确电影分类下的纯“第 N 部”目录按电影分部处理，不直接解释成季目录。 */
  static buildMoviePartDirectoryQuery(rootPath: string, parentPath: string): WebdavMovieSeriesPartQuery {
    const result = new WebdavMovieSeriesPartQuery()
    const normalizedParentPath = normalizeWebdavPath(parentPath)
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    const folderName = WebdavVideoNameParser.getLastPathName(normalizedParentPath)
    // 仅接收独立部号目录；“第一季”和“第一部第 1 集”等明确节目结构不参与。
    if (!/^第\s*[0-9一二三四五六七八九十两]{1,3}\s*部$/.test(folderName.trim()) ||
      normalizedParentPath === normalizedRootPath) {
      return result
    }
    const partNumber = WebdavMediaMovieEvidence.extractMovieSeriesPartNumber(folderName)
    if (partNumber <= 0 ||
      WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, parentPath).mediaType !== 'movie') {
      return result
    }
    // 分部只能借用紧邻的作品目录，不能跨过分类目录寻找不相关片名。
    const titlePath = WebdavVideoNameParser.getParentPath(normalizedParentPath)
    const titleFolderName = WebdavVideoNameParser.getLastPathName(titlePath)
    const seriesTitle = WebdavMediaMovieEvidence.cleanMovieSeriesBaseFolderTitle(titleFolderName)
    const baseTitle = seriesTitle.length > 0 ? seriesTitle :
      WebdavVideoNameParser.cleanMovieDirectoryTitle(titleFolderName)
    if (WebdavMediaPathEvidence.hasMovieDirectoryTypeHint(titleFolderName) ||
      WebdavMediaPathEvidence.hasTvDirectoryTypeHint(titleFolderName) ||
      WebdavVideoNameParser.startsWithSeasonFolderName(titleFolderName) ||
      !WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(baseTitle)) {
      return result
    }
    // 首部沿用原片名；续作保留部号，避免不同电影共用同一个搜索任务。
    result.title = partNumber === 1 ? baseTitle : `${baseTitle}${partNumber}`
    result.baseTitle = baseTitle
    result.partNumber = partNumber
    result.sourceFolder = titlePath
    return result
  }

  /** 根据上级电影系列目录和当前文件部号生成备用电影查询，例如“速度与激情 系列 4K/速度与鸡晴10”。 */
  static buildMovieSeriesPartQuery(rootPath: string, parentPath: string, fileName: string): WebdavMovieSeriesPartQuery {
    const result = new WebdavMovieSeriesPartQuery()
    const parentFolderName = WebdavVideoNameParser.getLastPathName(parentPath)
    // 关键变量：当前文件名或父目录名中提取出的部号，只接受 1 到 30 的常见电影系列编号。
    const filePartNumber = WebdavMediaMovieEvidence.extractMovieSeriesPartNumber(fileName)
    const partNumber = filePartNumber > 0 ? filePartNumber : WebdavMediaMovieEvidence.extractMovieSeriesPartNumber(parentFolderName)
    if (partNumber <= 0) {
      return result
    }
    // 关键变量：从当前目录或近层上级目录提取出的电影系列基名。
    const baseQuery = WebdavMediaMovieEvidence.pickMovieSeriesBaseQuery(rootPath, parentPath)
    if (baseQuery.title.length === 0) {
      return result
    }
    const normalizedPath = normalizeWebdavPath(`${parentPath}/${fileName}`)
    const parsed = WebdavVideoNameParser.parse(fileName, normalizedPath)
    if (!WebdavMediaMovieEvidence.shouldUseMovieSeriesPartQuery(parsed.title, baseQuery.title)) {
      return result
    }
    const title = partNumber === 1 ? baseQuery.title : `${baseQuery.title}${partNumber}`
    if (normalizeWebdavVideoSearchText(title) === normalizeWebdavVideoSearchText(parsed.title)) {
      return result
    }
    result.title = title
    result.baseTitle = baseQuery.title
    result.partNumber = partNumber
    result.sourceFolder = baseQuery.sourceFolder
    return result
  }

  /** 仅有相符的系列目录证据时，允许首部“片名1”回退成“片名”，不改变主查询。 */
  static buildFirstMoviePartFallback(rootPath: string, parentPath: string, query: string): string {
    if (!/[^\d]1$/.test(query.trim())) {
      return ''
    }
    const baseQuery = WebdavMediaMovieEvidence.pickMovieSeriesBaseQuery(rootPath, parentPath)
    if (baseQuery.title.length === 0 || normalizeWebdavVideoSearchText(query) !==
      normalizeWebdavVideoSearchText(`${baseQuery.title}1`)) {
      return ''
    }
    return baseQuery.title
  }

  /** 从文件名提取电影部号，限制在 1 到 30，避免把年份和分辨率当成部号。 */
  static extractMovieSeriesPartNumber(fileName: string): number {
    const raw = WebdavVideoNameParser.getFileStem(fileName)
    const explicitPart = /第\s*([0-9一二三四五六七八九十两]{1,3})\s*部/.exec(raw)
    if (explicitPart !== null && explicitPart[1]! !== undefined) {
      return WebdavMediaMovieEvidence.normalizeMovieSeriesPartNumber(WebdavMediaMovieEvidence.parseMovieSeriesPartNumberText(explicitPart[1]!))
    }
    const englishPart = /(?:^|[\s._\-–—])(?:part|pt)\s*0*([1-9]|[12]\d|30)(?:$|[\s._\-–—])/i.exec(raw)
    if (englishPart !== null && englishPart[1]! !== undefined) {
      return WebdavMediaMovieEvidence.normalizeMovieSeriesPartNumber(parseInt(englishPart[1]!, 10))
    }
    const title = WebdavVideoNameParser.cleanMovieDirectoryTitle(raw)
    const genericNumber = /^0*([1-9]|[12]\d|30)$/.exec(normalizeWebdavVideoSearchText(title))
    if (genericNumber !== null && genericNumber[1]! !== undefined) {
      return WebdavMediaMovieEvidence.normalizeMovieSeriesPartNumber(parseInt(genericNumber[1]!, 10))
    }
    if (!/[\u4e00-\u9fa5]/.test(title)) {
      return 0
    }
    const titlePart = /(?:^|[^\d])([1-9]|[12]\d|30)(?:$|[^\d])/.exec(title)
    if (titlePart !== null && titlePart[1]! !== undefined) {
      return WebdavMediaMovieEvidence.normalizeMovieSeriesPartNumber(parseInt(titlePart[1]!, 10))
    }
    return 0
  }

  /** 归一化电影部号，超过常见系列范围时丢弃。 */
  static normalizeMovieSeriesPartNumber(value: number): number {
    if (isNaN(value) || value <= 0 || value > 30) {
      return 0
    }
    return value
  }

  /** 解析阿拉伯数字或简单中文数字形式的部号。 */
  static parseMovieSeriesPartNumberText(value: string): number {
    const text = `${value || ''}`.trim().replace(/两/g, '二')
    if (/^\d{1,2}$/.test(text)) {
      return parseInt(text, 10)
    }
    const chineseDigits: string[] = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
    const tenIndex = text.indexOf('十')
    if (tenIndex >= 0) {
      const leftText = text.substring(0, tenIndex)
      const rightText = text.substring(tenIndex + 1)
      const tens = leftText.length === 0 ? 1 : chineseDigits.indexOf(leftText)
      const ones = rightText.length === 0 ? 0 : chineseDigits.indexOf(rightText)
      return tens > 0 && ones >= 0 ? tens * 10 + ones : 0
    }
    return chineseDigits.indexOf(text)
  }

  /** 从当前目录及其近层上级目录提取电影系列基名。 */
  static pickMovieSeriesBaseQuery(rootPath: string, parentPath: string): WebdavMovieSeriesPartQuery {
    const result = new WebdavMovieSeriesPartQuery()
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    // 关键变量：从文件父目录向上查找，最多只看近层目录，避免宽泛分类目录误参与。
    let cursor = normalizeWebdavPath(parentPath)
    let depth = 0
    while (cursor.length > 0 && cursor !== '/' && depth < 4) {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      const title = WebdavMediaMovieEvidence.cleanMovieSeriesBaseFolderTitle(folderName)
      if (title.length > 0) {
        result.title = title
        result.baseTitle = title
        result.sourceFolder = cursor
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

  /** 清洗电影系列目录名，只保留可作为片名基底的部分。 */
  static cleanMovieSeriesBaseFolderTitle(folderName: string): string {
    const raw = `${folderName || ''}`
    if (!WebdavMediaMovieEvidence.isMovieSeriesBaseFolderName(raw)) {
      return ''
    }
    if (WebdavMediaPathEvidence.hasMovieCategoryPathHint(raw)) {
      return ''
    }
    let text = raw.replace(/(?:系列电影|电影系列|系列|合集|collection|trilogy)/ig, ' ')
    const title = WebdavVideoNameParser.cleanMovieDirectoryTitle(text)
    return WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(title) ? title : ''
  }

  /** 判断目录名是否像具体电影系列，而不是普通电影分类桶。 */
  static isMovieSeriesBaseFolderName(folderName: string): boolean {
    const text = `${folderName || ''}`
    return /(?:系列|合集|collection|trilogy|\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}\s*部?)/i.test(text)
  }

  /** 只有泛化部号文件或确实属于该电影系列的文件，才允许使用“合集基名+部号”覆盖自身片名。 */
  static shouldUseMovieSeriesPartQuery(parsedTitle: string, baseTitle: string): boolean {
    const normalizedParsedTitle = normalizeWebdavVideoSearchText(parsedTitle) // 文件自身清洗后的片名。
    const normalizedBaseTitle = normalizeWebdavVideoSearchText(baseTitle) // 合集目录提取出的系列基名。
    if (normalizedParsedTitle.length === 0 ||
      WebdavVideoNameParser.isGenericMovieFileTitle(parsedTitle) ||
      WebdavVideoNameParser.isWeakScrapeTitle(parsedTitle)) {
      return true
    }
    if (normalizedBaseTitle.length === 0) {
      return false
    }
    return normalizedParsedTitle.indexOf(normalizedBaseTitle) >= 0 ||
      normalizedBaseTitle.indexOf(normalizedParsedTitle) >= 0
  }

  /** 判断路径电影分类或合集证据是否适用于当前文件。 */
  static shouldParseFileAsMovieByPath(rootPath: string, parentPath: string, fileName: string): boolean {
    if (WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
      return false
    }
    const nearestPathTypeHint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, parentPath)
    if (nearestPathTypeHint.mediaType === 'movie') {
      return true
    }
    if (nearestPathTypeHint.mediaType === 'tv' || nearestPathTypeHint.mediaType === 'mixed') {
      return false
    }
    if (!WebdavMediaPathEvidence.isCollectionContainerDirectory(parentPath)) {
      return false
    }
    const normalizedPath = normalizeWebdavPath(`${parentPath}/${fileName}`)
    const parsed = WebdavVideoNameParser.parse(fileName, normalizedPath)
    return parsed.mediaType === 'movie' && !WebdavVideoNameParser.isGenericMovieFileTitle(parsed.title)
  }

  /**
   * 在“日漫/欧美剧”等节目分类下识别电影正片或同片多版本。
   * 只处理完全没有季集特征的目录，防止把原有 SxxExx、纯数字单集重新判成电影。
   */
  static pickTvCategoryMovieVariantTitle(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): string {
    const nearestPathType = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath)
    if (nearestPathType.mediaType !== 'tv' || videoItems.length === 0) {
      return ''
    }
    const folderName = WebdavVideoNameParser.getLastPathName(currentPath)
    if (WebdavVideoNameParser.startsWithSeasonFolderName(folderName) ||
      WebdavMediaPathEvidence.hasSeasonDirectoryTitleHint(folderName) ||
      WebdavMediaPathEvidence.isCollectionDirectoryTitle(folderName)) {
      return ''
    }
    const folderTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(folderName)
    if (!WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(folderTitle)) {
      return ''
    }
    const folderYearMatch = /(?:19|20)\d{2}/.exec(folderName) // 关键变量：电影版本必须与目录年份一致。
    if (videoItems.length > 1 && (videoItems.length > 8 || folderYearMatch === null)) {
      return ''
    }
    let movieReleaseContextCount = 0 // 关键变量：同时包含同年和视频规格的发行版本数量。
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        if (WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(entry.name)) {
          return ''
        }
        // 关键变量：带年份和视频规格的发行文件允许包含 AAC2.0、H.264 等弱数字。
        const hasMovieReleaseContext = /(?:19|20)\d{2}/.test(entry.name) &&
          /(?:2160p|1080p|720p|4k|8k|web[-.\s]?dl|web[-.\s]?rip|bluray|blu[-.\s]?ray|remux|hdtv|h[.\s_-]*26[45]|x[.\s_-]*26[45])/i.test(entry.name)
        if (hasMovieReleaseContext && folderYearMatch !== null && entry.name.indexOf(folderYearMatch[0]!) >= 0) {
          movieReleaseContextCount += 1
        }
        if (!hasMovieReleaseContext && WebdavVideoNameParser.looksLikeEpisodeFileName(entry.name)) {
          return ''
        }
      }
      index += 1
    }
    if (videoItems.length === 1) {
      const onlyEntry = videoItems[0]!
      if (onlyEntry === undefined) {
        return ''
      }
      return folderYearMatch !== null && onlyEntry.name.indexOf(folderYearMatch[0]!) >= 0 ? folderTitle : ''
    }
    const titleCounts: Map<string, number> = new Map() // 关键变量：同目录不同清晰度版本的文件标题计数。
    index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        const fileTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(entry.fileStem)
        if (fileTitle.length === 0 || WebdavVideoNameParser.isGenericMovieFileTitle(fileTitle)) {
          return ''
        }
        const key = normalizeWebdavVideoSearchText(fileTitle)
        titleCounts.set(key, (titleCounts.get(key) || 0) + 1)
      }
      index += 1
    }
    let dominantCount = 0
    titleCounts.forEach((count: number): void => {
      dominantCount = Math.max(dominantCount, count)
    })
    const requiredCount = Math.max(2, Math.ceil(videoItems.length * 0.8))
    return dominantCount >= requiredCount && movieReleaseContextCount >= requiredCount ? folderTitle : ''
  }

  /** 根据最近分类提示和合集结构提取电影容器证据。 */
  static shouldTreatDirectoryAsMovieContainer(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): boolean {
    if (videoItems.length <= 0) {
      return false
    }
    const nearestPathTypeHint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(rootPath, currentPath)
    if (nearestPathTypeHint.mediaType === 'movie') {
      return true
    }
    if (nearestPathTypeHint.mediaType === 'tv' || nearestPathTypeHint.mediaType === 'mixed') {
      return false
    }
    return WebdavMediaPathEvidence.isCollectionContainerDirectory(currentPath)
  }

  /** 从电影容器目录提取标题，当前目录是范围桶时回退到上级电影标题。 */
  static pickMovieContainerDirectoryTitle(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): string {
    const normalizedCurrentPath = normalizeWebdavPath(currentPath)
    const currentFolderName = WebdavVideoNameParser.getLastPathName(normalizedCurrentPath)
    const currentIsCollectionRange = WebdavMediaPathEvidence.isMovieCollectionRangeTitle(currentFolderName)
    // 关键变量：当前目录标题，适用于“目中无人 2部4K”这类目录本身就是片名的情况。
    const currentTitle = WebdavMediaMovieEvidence.pickDirectoryMovieTitle(rootPath, currentPath, videoItems)
    if (currentTitle.length > 0 && (!currentIsCollectionRange || WebdavMediaMovieEvidence.onlyHasPartLikeMovieFiles(videoItems))) {
      return currentTitle
    }
    // 无片名的多个规格文件优先取最近作品目录，不越级拿到“聊会电影”等分类名。
    const localTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(currentFolderName)
    const onlyPartFiles = WebdavMediaMovieEvidence.onlyHasPartLikeMovieFiles(videoItems)
    if (!currentIsCollectionRange && !WebdavMediaPathEvidence.isCollectionDirectoryTitle(localTitle) &&
      WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(localTitle) && onlyPartFiles) {
      return localTitle
    }
    // 已有独立片名的文件必须逐文件识别；上级标题仅供无片名的范围/资源子目录使用。
    if (!onlyPartFiles || (!currentIsCollectionRange && WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(localTitle))) {
      return ''
    }
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    if (normalizedCurrentPath === normalizedRootPath) {
      return ''
    }
    const parentPath = WebdavVideoNameParser.getParentPath(normalizedCurrentPath)
    const parentName = WebdavVideoNameParser.getLastPathName(parentPath)
    // 关键变量：上级电影标题，适用于当前目录只是“1-5部”范围桶的情况。
    const parentTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(parentName)
    return WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(parentTitle) ? parentTitle : ''
  }

  /** 结合单片或同片多版本结构提取目录电影标题。 */
  static pickDirectoryMovieTitle(
    rootPath: string,
    currentPath: string,
    videoItems: WebdavDirectoryVideoFileIndex[]
  ): string {
    const normalizedCurrentPath = normalizeWebdavPath(currentPath)
    const folderName = WebdavVideoNameParser.getLastPathName(normalizedCurrentPath)
    const folderTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(folderName)
    if (!WebdavMediaPathEvidence.isUsableDirectoryMovieTitle(folderTitle)) {
      return ''
    }
    const normalizedRootPath = normalizeWebdavPath(rootPath)
    const nearestPathTypeHint = WebdavMediaPathEvidence.buildNearestAncestorPathTypeHint(normalizedRootPath, normalizedCurrentPath)
    if (normalizedCurrentPath === normalizedRootPath) {
      if (nearestPathTypeHint.mediaType === 'tv' || nearestPathTypeHint.mediaType === 'mixed') {
        return ''
      }
      if (videoItems.length === 1) {
        const entry = videoItems[0]!
        if (entry === undefined) {
          return ''
        }
        const fileTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(entry.fileStem)
        if (nearestPathTypeHint.mediaType === 'movie') {
          return folderTitle
        }
        return !WebdavVideoNameParser.isGenericMovieFileTitle(fileTitle) &&
          WebdavMediaPathEvidence.fileTitleMatchesDirectoryTitle(fileTitle, folderTitle) ? folderTitle : ''
      }
      return videoItems.length <= 2 && WebdavMediaMovieEvidence.shouldGroupDirectoryAsMovie(folderTitle, videoItems) ? folderTitle : ''
    }
    if (videoItems.length === 1) {
      const entry = videoItems[0]!
      if (entry === undefined) {
        return ''
      }
      const fileTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(entry.fileStem)
      if (nearestPathTypeHint.mediaType === 'tv' || nearestPathTypeHint.mediaType === 'mixed') {
        return ''
      }
      if (nearestPathTypeHint.mediaType === 'movie' ||
        (!WebdavVideoNameParser.isGenericMovieFileTitle(fileTitle) &&
          WebdavMediaPathEvidence.fileTitleMatchesDirectoryTitle(fileTitle, folderTitle))) {
        return folderTitle
      }
      return ''
    }
    if (WebdavMediaMovieEvidence.shouldGroupDirectoryAsMovie(folderTitle, videoItems)) {
      return folderTitle
    }
    return ''
  }

  /** 检查目录文件是否均匹配同一电影标题或通用版本名。 */
  static shouldGroupDirectoryAsMovie(title: string, videoItems: WebdavDirectoryVideoFileIndex[]): boolean {
    let matchedCount = 0
    let genericCount = 0
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        const parsed = WebdavVideoNameParser.parse(entry.name, entry.path)
        if (WebdavVideoNameParser.isGenericMovieFileTitle(parsed.title)) {
          genericCount += 1
        } else if (WebdavMediaPathEvidence.fileTitleMatchesDirectoryTitle(parsed.title, title)) {
          matchedCount += 1
        }
      }
      index += 1
    }
    return matchedCount + genericCount > 0 && matchedCount + genericCount === videoItems.length
  }

  /** 判断当前电影目录下是否只有“第N部/清晰度”这类不能独立作为片名的文件。 */
  static onlyHasPartLikeMovieFiles(videoItems: WebdavDirectoryVideoFileIndex[]): boolean {
    if (videoItems.length <= 0) {
      return false
    }
    let index = 0
    while (index < videoItems.length) {
      const entry = videoItems[index]!
      if (entry !== undefined) {
        const fileTitle = WebdavVideoNameParser.cleanMovieDirectoryTitle(entry.fileStem)
        if (!WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(entry.name) &&
          !WebdavVideoNameParser.isGenericMovieFileTitle(fileTitle)) {
          return false
        }
      }
      index += 1
    }
    return true
  }
}
