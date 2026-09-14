/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { normalizeWebdavPath } from './path.js'
import { WebdavScannedVideoFile, WebdavVideoScrapeTask } from './models.js'
import { normalizeWebdavVideoSearchText, WebdavVideoNameParser } from './WebdavVideoNameParser.js'

/** 电影父目录补查的目录证据与任务隔离规则。 */
export class WebdavMovieParentFallbackHelper {
  /** 根据完整目录的视频名称判断单片或同片多版本，不能只检查当前任务内的文件。 */
  static hasSingleMovieEvidence(fileNames: string[]): boolean {
    if (fileNames.length === 0) {
      return false
    }
    let movieTitle = '' // 关键变量：独立文件标题必须相等，保留续集数字，不使用子串匹配。
    let movieYear = 0
    for (let index = 0; index < fileNames.length; index += 1) {
      const fileName = fileNames[index]!
      if (WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName)) {
        return false
      }
      if (fileNames.length === 1) {
        return true
      }
      const parsed = WebdavVideoNameParser.parseAsMovie(fileName, '')
      const title = normalizeWebdavVideoSearchText(parsed.query).replace(/\s+/g, '')
      if (title.length === 0 || (WebdavVideoNameParser.isGenericMovieFileTitle(parsed.query) &&
        !WebdavVideoNameParser.hasNumericMovieTitleEvidence(fileName, parsed.query))) {
        return false
      }
      if (movieTitle.length > 0 && movieTitle !== title) {
        return false
      }
      if (movieYear > 0 && parsed.year > 0 && movieYear !== parsed.year) {
        return false
      }
      movieTitle = title
      if (parsed.year > 0) {
        movieYear = parsed.year
      }
    }
    return true
  }

  /** 返回与文件当前位置一致的目录证据；旧快照没有证据时不启用新增补查。 */
  static readVerifiedParentPath(file: WebdavScannedVideoFile): string {
    const parentPath = normalizeWebdavPath(file.parentPath)
    return parentPath !== '/' && file.parsed.parentMovieDirectoryPath === parentPath ? parentPath : ''
  }

  /** 补查候选任务从入队开始按目录隔离，避免异步搜索期间或完成后追加其他目录的文件。 */
  static scopeTaskKey(baseKey: string, file: WebdavScannedVideoFile): string {
    const parentPath = WebdavMovieParentFallbackHelper.readVerifiedParentPath(file)
    return parentPath.length > 0 ? `${baseKey}|movie-parent-v1|${encodeURIComponent(parentPath)}` : baseKey
  }

  /** 校验整个任务的目录证据和隔离键，未隔离的旧任务不能使用父目录结果。 */
  static readTaskParentPath(task: WebdavVideoScrapeTask): string {
    if (task.taskType !== 'movie' || task.files.length === 0) {
      return ''
    }
    const parentPath = WebdavMovieParentFallbackHelper.readVerifiedParentPath(task.files[0]!)
    if (parentPath.length === 0 || !task.key.endsWith(`|movie-parent-v1|${encodeURIComponent(parentPath)}`)) {
      return ''
    }
    for (let index = 0; index < task.files.length; index += 1) {
      if (WebdavMovieParentFallbackHelper.readVerifiedParentPath(task.files[index]!) !== parentPath) {
        return ''
      }
    }
    return parentPath
  }
}
