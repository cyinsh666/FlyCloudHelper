/** 未知季与特别篇第 0 季、界面未选择的 -1 分开保存。 */
export const WEBDAV_UNKNOWN_SEASON: number = -2

/** 单个文件能够明确提取出的集号证据。 */
export class WebdavConsecutiveEpisodeEvidence {
  fileName: string = ''
  prefix: string = ''
  seasonNumber: number = -1
  episodeNumber: number = 0
  explicit: boolean = false
}

/** APP 与云助手采用同样的连续集号优先规则；不满足时不改变原有判型。 */
export class WebdavConsecutiveEpisodeHelper {
  /** 读取明确季集、E/第N集、共同前缀加编号和纯数字文件名。 */
  static read(fileName: string, defaultSeason: number): WebdavConsecutiveEpisodeEvidence | undefined {
    const base = fileName.replace(/\.[A-Za-z0-9]+$/, '').trim()
    const strong = /^(?:(.*?)[\s._-]+)?(?:S(\d{1,2})[ ._-]*E(\d{1,4})|EP?[ ._-]*(\d{1,4})|第\s*(\d{1,4})\s*[集话話])(?=$|[\s._-])(.*)$/i.exec(base)
    const evidence = new WebdavConsecutiveEpisodeEvidence()
    evidence.fileName = fileName
    evidence.seasonNumber = defaultSeason
    if (strong !== null) {
      // 多集合并文件交给已有范围规则，避免优先分支丢失后续集号。
      if (/^(?:\s*[-~–—至到]\s*(?:EP?\s*)?\d+(?=$|[\s._-])|[\s._-]*EP?\s*\d+)/i.test(strong[6] || '')) {
        return undefined
      }
      evidence.explicit = true
      evidence.prefix = strong[1] || ''
      evidence.episodeNumber = Number(strong[3] || strong[4] || strong[5])
      if (strong[2] !== undefined && strong[2].length > 0) {
        evidence.seasonNumber = Number(strong[2])
      }
    } else {
      const weak = /^(?:(.*?)[\s._-]+)?(\d{1,4})(?=$|[\s._-])(.*)$/.exec(base)
      if (weak === null) {
        return undefined
      }
      evidence.prefix = weak[1] || ''
      evidence.episodeNumber = Number(weak[2])
      // 裸数字后只允许资源规格，不能把“5.1”声道或“2024.影片”当作集号。
      const suffix = (weak[3] || '').replace(/(?:2160p|1440p|1080p|720p|576p|480p|4k|8k|web[-. ]?dl|bluray|[hx][ .]?26[45]|hevc|aac|flac|国语|中字)/ig, '')
        .replace(/[\s._-]/g, '')
      if (suffix.length > 0 || evidence.episodeNumber >= 1900) {
        return undefined
      }
    }
    evidence.prefix = evidence.prefix.replace(/[\s._-]+/g, '').toLowerCase()
    return evidence.episodeNumber > 0 ? evidence : undefined
  }

  /** 同一前缀、同一季去重后至少三集连续，且覆盖目录多数文件，才启用优先分支。 */
  static collect(fileNames: string[], defaultSeason: number): WebdavConsecutiveEpisodeEvidence[] {
    const evidence: WebdavConsecutiveEpisodeEvidence[] = []
    const prefixes: string[] = []
    const seasons: number[] = []
    for (let index = 0; index < fileNames.length; index += 1) {
      const item = WebdavConsecutiveEpisodeHelper.read(fileNames[index] || '', defaultSeason)
      if (item === undefined) {
        continue
      }
      evidence.push(item)
      if (item.prefix.length > 0 && prefixes.indexOf(item.prefix) < 0) {
        prefixes.push(item.prefix)
      }
      if (seasons.indexOf(item.seasonNumber) < 0) {
        seasons.push(item.seasonNumber)
      }
    }
    if (prefixes.length > 1 || evidence.length < Math.max(3, Math.ceil(fileNames.length * 0.6))) {
      return []
    }
    for (let index = 0; index < seasons.length; index += 1) {
      const numbers: number[] = []
      evidence.forEach((item: WebdavConsecutiveEpisodeEvidence): void => {
        if (item.seasonNumber === seasons[index] && numbers.indexOf(item.episodeNumber) < 0) {
          numbers.push(item.episodeNumber)
        }
      })
      numbers.sort((left: number, right: number): number => left - right)
      let count = 0
      for (let numberIndex = 0; numberIndex < numbers.length; numberIndex += 1) {
        count = numberIndex > 0 && numbers[numberIndex] === (numbers[numberIndex - 1] || 0) + 1 ? count + 1 : 1
        if (count >= 3) {
          return evidence
        }
      }
    }
    return []
  }
}
