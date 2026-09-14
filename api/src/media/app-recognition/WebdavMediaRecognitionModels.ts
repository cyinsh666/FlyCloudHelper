/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { WebdavBrowseItem } from './path.js'
import { WebdavParsedVideoName, WebdavParsedVideoMediaType, WebdavVideoScrapeTaskType } from './models.js'
import { WebdavConsecutiveEpisodeEvidence } from './WebdavConsecutiveEpisodeHelper.js'

export type WebdavNearestPathMediaType = 'none' | 'movie' | 'tv' | 'mixed'

/** 一次目录枚举生成并在单文件判型中复用的上下文。 */
export class WebdavDirectoryTvScanContext {
  isTv: boolean = false
  // 关键变量：电影合集即使没有统一目录标题，也必须阻止单文件被再次判成节目。
  isMovie: boolean = false
  title: string = ''
  seasonNumber: number = 1
  /** 同名季目录中由第一季确认的节目首播年份。 */
  seriesYear: number = 0
  reason: string = ''
  /** 连续集号或日期优先分支只覆盖已确认的文件，其他文件继续原逻辑。 */
  consecutiveByName: Map<string, WebdavConsecutiveEpisodeEvidence> = new Map()
  /** 未参与连续集号分支的文件沿用完整的原目录规则。 */
  fallbackContext?: WebdavDirectoryTvScanContext
  fallbackEpisodeByPath: Map<string, number> = new Map()
  movieTitle: string = ''
  movieReason: string = ''
  videoCount: number = 0
  episodeLikeCount: number = 0
  /** 仅在单文件判型需要时缓存路径证据。 */
  nearestPathTypeHint?: WebdavNearestPathTypeHint
  pathTvContext?: WebdavDirectoryTvScanContext
}

/** 日期节目文件所共享的标题及出现次数。 */
export class WebdavDateEpisodeTitleCount {
  title: string = ''
  count: number = 0
}

/** 调用方已枚举的视频索引，避免识别阶段重复遍历和读取远端文件。 */
export class WebdavDirectoryVideoFileIndex {
  path: string = ''
  name: string = ''
  parentPath: string = ''
  fileStem: string = ''
  extension: string = ''
  item: WebdavBrowseItem | undefined = undefined
}

/** 电影系列基名、当前分部编号及标题来源目录。 */
export class WebdavMovieSeriesPartQuery {
  title: string = ''
  baseTitle: string = ''
  partNumber: number = 0
  sourceFolder: string = ''
}

/** 从叶子向上遇到的最近类型提示，混合提示阻止继续继承上层分类。 */
export class WebdavNearestPathTypeHint {
  mediaType: WebdavNearestPathMediaType = 'none'
  folderName: string = ''
  folderPath: string = ''
  depth: number = -1
  movieMatched: boolean = false
  tvMatched: boolean = false
}

/** 目录准备输入；视频索引与子目录来自调用方已完成的枚举。 */
export class WebdavMediaDirectoryInput {
  rootPath: string = '/'
  currentPath: string = '/'
  videoItems: WebdavDirectoryVideoFileIndex[] = []
  directoryItems: WebdavBrowseItem[] = []
}

/** 单文件识别输入；已确认类型可用于已有条目回填。 */
export class WebdavMediaRecognitionInput {
  rootPath: string = '/'
  filePath: string = ''
  fileName: string = ''
  directoryContext?: WebdavDirectoryTvScanContext
  knownType: WebdavParsedVideoMediaType = 'unknown'
  knownTypeSource: string = ''
}

/** 保留完整解析字段，并说明最终命中的规则。 */
export class WebdavMediaRecognitionResult {
  parsed: WebdavParsedVideoName = new WebdavParsedVideoName()
  rule: string = ''
  reason: string = ''
}

/** 刮削能力约束与文件类型分开传入；显式 TMDB 类型由同一模块推断。 */
export class WebdavScrapeTypeInput {
  parsedType: WebdavParsedVideoMediaType = 'unknown'
  supportedItemTypes: string[] = []
  explicitTmdbType: WebdavParsedVideoMediaType = 'unknown'
}

/** 记录识别类型到刮削任务类型的转换原因。 */
export class WebdavScrapeTypeDecision {
  recognizedType: WebdavParsedVideoMediaType = 'unknown'
  taskType: WebdavVideoScrapeTaskType = 'movie'
  rule: string = ''
  reason: string = ''
}
