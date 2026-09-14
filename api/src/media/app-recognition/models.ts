/** APP 识别层所需的数据模型，不包含界面与 TMDB 网络类型。 */
export type WebdavParsedVideoMediaType = 'movie' | 'tv' | 'unknown'
export type WebdavVideoScrapeTaskType = 'movie' | 'tv'
export class WebdavParsedVideoName {
  fileName: string = ''
  baseName: string = ''
  title: string = ''
  query: string = ''
  mediaType: WebdavParsedVideoMediaType = 'unknown'
  year: number = 0
  seasonNumber: number = 0
  episodeNumber: number = 0
  episodeNumbers: number[] = []
  imdbId: string = ''
  resolution: string = ''
  source: string = ''
  releaseGroup: string = ''
  /** 是否通过“数字目录名 + 多数同名前缀季集文件”确认了纯数字节目名。 */
  confirmedNumericSeriesTitle: boolean = false
  /** 完整目录枚举确认只有单片或同片多版本时记录，供父目录补查及断点恢复使用。 */
  parentMovieDirectoryPath: string = ''
}

export class WebdavScannedVideoFile {
  rootPath: string = '/'
  parentPath: string = '/'
  path: string = ''
  name: string = ''
  size: number = 0
  modifiedMs: number = 0
  etag: string = ''
  parsed: WebdavParsedVideoName = new WebdavParsedVideoName()
}

/** 父目录证据校验只使用任务类型、分组键和文件列表。 */
export interface WebdavVideoScrapeTask {
  taskType: WebdavVideoScrapeTaskType;
  key: string;
  files: WebdavScannedVideoFile[];
}
