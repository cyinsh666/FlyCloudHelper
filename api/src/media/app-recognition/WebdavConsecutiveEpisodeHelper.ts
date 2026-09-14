/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
/** 未知季与特别篇第 0 季、界面未选择的 -1 分开保存。 */
export const WEBDAV_UNKNOWN_SEASON: number = -2

/** 至少两个不同且连续的集号形成目录证据，直接匹配与文件名差异匹配共用。 */
export const WEBDAV_MIN_CONSECUTIVE_EPISODES: number = 2

/** 单个文件能够明确提取出的集号证据。 */
export class WebdavConsecutiveEpisodeEvidence {
  fileName: string = ''
  prefix: string = ''
  seasonNumber: number = -1
  episodeNumber: number = 0
  explicit: boolean = false
  /** 关键变量：区分单文件规则与目录文件名差异规则，用于扫描日志排查。 */
  matchMode: string = 'direct'
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
      if (/^(?:\s*[-~–—至到]\s*(?:EP?\s*)?\d+(?=$|[\s._-])|[\s._-]*EP?\s*\d+)/i.test(strong[6]! || '')) {
        return undefined
      }
      evidence.explicit = true
      evidence.prefix = strong[1]! || ''
      evidence.episodeNumber = Number(strong[3]! || strong[4]! || strong[5]!)
      if (strong[2]! !== undefined && strong[2]!.length > 0) {
        evidence.seasonNumber = Number(strong[2]!)
      }
    } else {
      const weak = /^(?:(.*?)[\s._-]+)?(\d{1,4})(?=$|[\s._-])(.*)$/.exec(base)
      if (weak === null) {
        return undefined
      }
      evidence.prefix = weak[1]! || ''
      evidence.episodeNumber = Number(weak[2]!)
      // 裸数字后只允许资源规格，不能把“5.1”声道或“2024.影片”当作集号。
      const suffix = (weak[3]! || '').replace(/(?:2160p|1440p|1080p|720p|576p|480p|4k|8k|web[-. ]?dl|bluray|[hx][ .]?26[45]|hevc|aac|flac|国语|中字)/ig, '')
        .replace(/[\s._-]/g, '')
      if (suffix.length > 0 || evidence.episodeNumber >= 1900) {
        return undefined
      }
    }
    evidence.prefix = evidence.prefix.replace(/[\s._-]+/g, '').toLowerCase()
    return evidence.episodeNumber > 0 ? evidence : undefined
  }

  /** 同一前缀、同一季去重后至少两集连续，且覆盖目录多数文件，才启用优先分支。 */
  static collect(fileNames: string[], defaultSeason: number): WebdavConsecutiveEpisodeEvidence[] {
    if (fileNames.length < WEBDAV_MIN_CONSECUTIVE_EPISODES) {
      return []
    }
    const directEvidence: WebdavConsecutiveEpisodeEvidence[] = []
    for (let index = 0; index < fileNames.length; index += 1) {
      const item = WebdavConsecutiveEpisodeHelper.read(fileNames[index]! || '', defaultSeason)
      if (item !== undefined) {
        directEvidence.push(item)
      }
    }
    if (WebdavConsecutiveEpisodeHelper.isQualifiedEpisodeEvidence(directEvidence, fileNames.length)) {
      return directEvidence
    }
    return WebdavConsecutiveEpisodeHelper.collectByFileNameDifference(fileNames, defaultSeason)
  }

  /** 整体比对目录文件名，用其他文字相同、某段数字不同来定位集号。 */
  private static collectByFileNameDifference(
    fileNames: string[],
    defaultSeason: number
  ): WebdavConsecutiveEpisodeEvidence[] {
    // 关键变量：将每个候选数字替换为 # 后分组，同组即表示除该数字外文件名整体一致。
    const evidenceGroups: Map<string, WebdavConsecutiveEpisodeEvidence[]> = new Map()
    for (let fileIndex = 0; fileIndex < fileNames.length; fileIndex += 1) {
      const fileName = fileNames[fileIndex]! || ''
      const fileEvidence = WebdavConsecutiveEpisodeHelper.collectFileDifferenceEvidence(fileName, defaultSeason)
      for (let evidenceIndex = 0; evidenceIndex < fileEvidence.length; evidenceIndex += 1) {
        const item = fileEvidence[evidenceIndex]!
        const currentGroup = evidenceGroups.get(item.prefix)
        if (currentGroup !== undefined) {
          currentGroup.push(item)
        } else {
          evidenceGroups.set(item.prefix, [item])
        }
      }
    }
    let bestEvidence: WebdavConsecutiveEpisodeEvidence[] = []
    evidenceGroups.forEach((items: WebdavConsecutiveEpisodeEvidence[]): void => {
      if (WebdavConsecutiveEpisodeHelper.isQualifiedEpisodeEvidence(items, fileNames.length) &&
        items.length > bestEvidence.length) {
        bestEvidence = items
      }
    })
    return bestEvidence
  }

  /** 枚举单个文件名中可用于目录整体比对的数字差异。 */
  private static collectFileDifferenceEvidence(
    fileName: string,
    defaultSeason: number
  ): WebdavConsecutiveEpisodeEvidence[] {
    const out: WebdavConsecutiveEpisodeEvidence[] = []
    const base = fileName.replace(/\.[A-Za-z0-9]+$/, '').trim()
    const numberPattern: RegExp = /(^|\D)(\d{1,4})(?=$|\D)/g
    let match = numberPattern.exec(base)
    while (match !== null) {
      const leadingText = match[1]! || ''
      const numberText = match[2]! || ''
      const numberIndex = match.index + leadingText.length
      const episodeNumber = Number(numberText)
      if (WebdavConsecutiveEpisodeHelper.isUsableComparedEpisodeNumber(
        base, numberIndex, numberText, episodeNumber)) {
        const evidence = new WebdavConsecutiveEpisodeEvidence()
        evidence.fileName = fileName
        evidence.seasonNumber = defaultSeason
        evidence.episodeNumber = episodeNumber
        evidence.explicit = WebdavConsecutiveEpisodeHelper.isExplicitEpisodeNumber(base, numberIndex)
        evidence.matchMode = 'filename_difference'
        evidence.prefix = `${base.substring(0, numberIndex)}#${base.substring(numberIndex + numberText.length)}`
          .replace(/[\s._-]+/g, '').toLowerCase()
        out.push(evidence)
      }
      match = numberPattern.exec(base)
    }
    return out
  }

  /** 排除年份、分辨率、编码、帧率和声道等技术数字。 */
  private static isUsableComparedEpisodeNumber(
    base: string,
    numberIndex: number,
    numberText: string,
    episodeNumber: number
  ): boolean {
    if (episodeNumber <= 0 || episodeNumber >= 1900) {
      return false
    }
    const leftText = base.substring(Math.max(0, numberIndex - 8), numberIndex)
    const rightText = base.substring(numberIndex + numberText.length, numberIndex + numberText.length + 10)
    if (/^[._][01](?:$|\D)/.test(rightText) && [1, 2, 4, 5, 6, 7].indexOf(episodeNumber) >= 0) {
      return false
    }
    if (/[124567][._]$/.test(leftText) && /^(?:0|1)(?:$|\D)/.test(rightText)) {
      return false
    }
    if (/^(?:p|i|fps|hz|bit|bits|kbps|mbps)/i.test(rightText)) {
      return false
    }
    if (/^[kK](?:$|[\s._-])/.test(rightText) && (episodeNumber === 4 || episodeNumber === 8)) {
      return false
    }
    if (/(?:x|h)[ ._-]*$/i.test(leftText) && episodeNumber >= 200) {
      return false
    }
    return true
  }

  /** 判断数字差异前是否带有 E/EP 等明确集号标记。 */
  private static isExplicitEpisodeNumber(base: string, numberIndex: number): boolean {
    const leftText = base.substring(Math.max(0, numberIndex - 12), numberIndex)
    return /(?:Episode|EP|E)[\s._-]*$/i.test(leftText) || /第\s*$/.test(leftText)
  }

  /** 校验集号证据是否覆盖多数文件，并在同季形成至少两个连续集号。 */
  private static isQualifiedEpisodeEvidence(
    evidence: WebdavConsecutiveEpisodeEvidence[],
    fileCount: number
  ): boolean {
    if (evidence.length < Math.max(WEBDAV_MIN_CONSECUTIVE_EPISODES, Math.ceil(fileCount * 0.6))) {
      return false
    }
    let sharedPrefix = ''
    // 关键变量：按季收集集号，使用 Set 避免大目录去重退化为平方级遍历。
    const numberGroups: Map<number, Set<number>> = new Map()
    for (let evidenceIndex = 0; evidenceIndex < evidence.length; evidenceIndex += 1) {
      const item = evidence[evidenceIndex]!
      if (item.prefix.length > 0) {
        if (sharedPrefix.length === 0) {
          sharedPrefix = item.prefix
        } else if (sharedPrefix !== item.prefix) {
          return false
        }
      }
      const currentNumbers = numberGroups.get(item.seasonNumber)
      if (currentNumbers !== undefined) {
        currentNumbers.add(item.episodeNumber)
      } else {
        numberGroups.set(item.seasonNumber, new Set([item.episodeNumber]))
      }
    }
    let hasConsecutiveEpisodes = false
    numberGroups.forEach((numberSet: Set<number>): void => {
      if (hasConsecutiveEpisodes) {
        return
      }
      const numbers: number[] = Array.from(numberSet)
      numbers.sort((left: number, right: number): number => left - right)
      let consecutiveCount = 0
      for (let numberIndex = 0; numberIndex < numbers.length; numberIndex += 1) {
        consecutiveCount = numberIndex > 0 && numbers[numberIndex]! === (numbers[numberIndex - 1]! || 0) + 1 ?
          consecutiveCount + 1 : 1
        if (consecutiveCount >= WEBDAV_MIN_CONSECUTIVE_EPISODES) {
          hasConsecutiveEpisodes = true
          return
        }
      }
    })
    return hasConsecutiveEpisodes
  }
}
