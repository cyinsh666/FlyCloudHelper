/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
/** 标题噪声清洗结果，诊断日志使用命中词和规则解释清洗原因。 */
export class WebdavVideoTitleNoiseCleanResult {
  originalTitle: string = ''
  cleanedTitle: string = ''
  matchedWords: string[] = []
  matchedRuleNames: string[] = []
}

/**
 * WebDAV 影视标题噪声库。
 * 统一维护分类、题材、状态和资源版本说明，按词表类别决定直接删除或限定位置删除。
 */
export class WebdavVideoTitleNoiseDictionary {
  /** 完整版本和制作说明直接清理，包含关系中的长词必须放在短词之前。 */
  private static readonly DIRECT_VERSION_WORDS: string[] = [
    // 真人版本：先处理含“电视剧”等分类词的完整标签，不删除独立的“真人”。
    '真人电视剧版', '真人电影版', '真人版本', '真人剧版', '真人版',
    // 修复和画质加工：先处理完整标签，最后才删除“精修”等已确认的短标签。
    '高清修复版', '数码修复版', '数字修复版', '蓝光修复版', '修复重制版', '特别修复版',
    '画质增强版', '画质修复版', '超分修复版', 'AI增强版', 'AI修复版', 'AI修复',
    '修复版', '超分版', '补帧版',
    // 剪辑与发行包装：不包含剧场版、番外篇、前传、外传和幕后特辑等作品区分词。
    '导演剪辑版本', '导演剪辑版', '完整无删减版', '加长版本', '加长版', '未删减版', '未删节版', '无删减版',
    '周年纪念版', '典藏版', '珍藏版', '收藏版', '纪念版', '正式版',
    // 字幕制作：必须先于通用“字幕”“双语字幕”清理，避免拆开后残留制作说明。
    '精修双语字幕', '人工翻译字幕', '精修字幕', '人工字幕', '人工精校', '字幕精校', '双语精校',
    '精修版', '精修'
  ]

  /** 地区剧种是明确分类词，标题任意位置命中后都可以直接删除。 */
  private static readonly DIRECT_CATEGORY_WORDS: string[] = [
    '动画电影', '华语电影', '欧美电影', '日韩电影', '动漫网剧', '国产动漫', '日韩动漫', '欧美动漫',
    '国产剧', '欧美剧', '日韩剧', '华语剧', '电视剧', '连续剧', '纪录片',
    '美剧', '英剧', '韩剧', '日剧', '港剧', '台剧', '泰剧', '陆剧', '国剧', '短剧', '网剧', '番剧',
    '日漫', '美漫', '国漫'
  ]

  /** 更新和完结状态不属于片名，标题任意位置命中后都直接删除。 */
  private static readonly DIRECT_STATUS_WORDS: string[] = [
    '已更新完毕', '连载完毕', '更新完毕', '已更最新集', '持续更新', '长期更新', '正在更新',
    '全集上线', '热映中', '热播中', '连载中', '更新中', '已完结', '已收官', '完结', '补档', '重新上传'
  ]

  /** 字幕、语言和资源版本属于发布信息，标题任意位置命中后都直接删除。 */
  private static readonly DIRECT_RESOURCE_WORDS: string[] = [
    'REMUX蓝光原盘', '蓝光原盘', '高码率', '高码版', '普码版', '低码版',
    '国粤英日四语', '国粤英三语', '国粤日三语', '国粤日多音轨', '国粤双语', '国英双语',
    '简繁英字幕', '简繁中字', '中英双字', '中英字幕', '国语中字', '官方中字', '内嵌特效',
    '特效字幕', '中文字幕', '英文字幕', '双语字幕', '无水印', '片名水印', '纯净版',
    '国语版', '粤语版', '英语版', '日语版', '韩语版', '多音轨', '音轨', '字幕', '水印', '净版', '源码'
  ]

  /** 仅作为独立标题前缀清理，避免删除片名中间的相同文字。 */
  private static readonly LEADING_CATEGORY_WORDS: string[] = [
    '动画电影', '华语电影', '欧美电影', '日韩电影', '动漫网剧', '国产动漫', '日韩动漫', '欧美动漫',
    '华语剧', '欧美剧', '日韩剧', '国产剧', '电视剧', '连续剧', '纪录片', '剧集', '节目',
    '美剧', '英剧', '日剧', '韩剧', '港剧', '台剧', '泰剧', '陆剧', '国剧', '短剧', '网剧', '番剧',
    '日漫', '美漫', '国漫', '动漫', '动画', '综艺', '华语', '欧美', '日韩', '国产', '国影', '美影',
    '电影', '影片', '院线'
  ]

  /** 仅作为带分隔边界的标题尾部标签清理。 */
  private static readonly TRAILING_GENRE_WORDS: string[] = [
    '动作冒险', '电视电影', '真人秀', '纪录片',
    '剧情', '犯罪', '悬疑', '动作', '爱情', '科幻', '奇幻', '冒险', '惊悚', '恐怖', '战争',
    '历史', '古装', '喜剧', '家庭', '校园', '青春', '儿童', '音乐', '西部', '访谈', '动画', '动漫', '综艺'
  ]

  /** 只从标题尾部删除的资源状态。 */
  private static readonly TRAILING_STATUS_WORDS: string[] = [
    '完整版', '全集', '更新'
  ]

  /** 已确认的发布者尾缀，只在原始资源文件带技术规格且以“-发布者”结尾时删除。 */
  private static readonly PUBLISHER_SUFFIX_WORDS: string[] = ['老K']

  /** 利用原始文件的发布信息清理残留署名，不直接替换普通片名中的同名文字。 */
  static stripKnownPublisherSuffix(title: string, rawValue: string): string {
    if (!/(?:\d{3,4}p|[48]k|remux|bluray|web[-.\s]?dl|[hx][ .]?26[45])/i.test(rawValue)) {
      return title
    }
    const raw = rawValue.trim()
    let text = title.trim()
    WebdavVideoTitleNoiseDictionary.PUBLISHER_SUFFIX_WORDS.forEach((word: string): void => {
      if (raw.toLowerCase().endsWith(`-${word.toLowerCase()}`) &&
        text.toLowerCase().endsWith(` ${word.toLowerCase()}`)) {
        text = text.substring(0, text.length - word.length).trim()
      }
    })
    return text
  }

  /** 集数说明及其后的文字都是目录元数据，不参与影视标题搜索。 */
  private static readonly EPISODE_METADATA_TAIL_PATTERN: RegExp =
    /(共\s*\d{1,4}\s*集(?:全)?|全\s*\d{1,4}\s*集|\d{1,4}\s*集全|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集).*$/i

  /** 目录尾部的“26集”“（11集）”也是总集数说明，不要求带“共”或“全”。 */
  private static readonly TRAILING_EPISODE_COUNT_PATTERN: RegExp =
    /(?:[（(【〖［〔\[]\s*)?\d{1,4}\s*集\s*[）)】〗］〕\]]*\s*$/

  /** 完整判断混合分类名称，必须在拆除“电视剧”等短词之前执行。 */
  static isMixedMediaCategoryTitle(value: string): boolean {
    const title = `${value || ''}`.replace(/[\s._+\-–—:：,，;；/\\|·•&＆]/g, '')
    return /^(?:电影(?:和|与|及)?(?:电视剧|剧集)|(?:电视剧|剧集)(?:和|与|及)?电影)$/.test(title)
  }

  /** 读取目录的集数说明，供连续编号证据判断使用，不把单独“第N集”当成总集数。 */
  static readDirectoryEpisodeCount(value: string): number {
    const match = WebdavVideoTitleNoiseDictionary.findEpisodeMetadataTail(value)
    if (match === null || match.index <= 0 || value.substring(0, match.index).trim().endsWith('第')) {
      return 0
    }
    const numberMatch = /\d{1,4}/.exec(match[0]!)
    return numberMatch !== null ? Number(numberMatch[0]!) : 0
  }

  /** 先识别已有的更新与总集数后缀，再补充普通数字集数后缀。 */
  private static findEpisodeMetadataTail(value: string): RegExpExecArray | null {
    const marked = WebdavVideoTitleNoiseDictionary.EPISODE_METADATA_TAIL_PATTERN.exec(value)
    if (marked !== null) {
      return marked
    }
    const trailing = WebdavVideoTitleNoiseDictionary.TRAILING_EPISODE_COUNT_PATTERN.exec(value)
    if (trailing !== null && value.substring(0, trailing.index).trim().endsWith('第')) {
      return null
    }
    return trailing
  }

  /** 清理标题噪声并保留命中明细。 */
  static clean(value: string): WebdavVideoTitleNoiseCleanResult {
    const result = new WebdavVideoTitleNoiseCleanResult()
    result.originalTitle = `${value || ''}`
    if (WebdavVideoTitleNoiseDictionary.isMixedMediaCategoryTitle(result.originalTitle)) {
      result.matchedWords.push(result.originalTitle)
      result.matchedRuleNames.push('混合分类目录整体排除')
      return result
    }
    let text = result.originalTitle
    text = WebdavVideoTitleNoiseDictionary.stripEpisodeMetadataTail(text, result)
    // 完整版本词优先，避免“真人电视剧版”“精修双语字幕”被分类或资源短词拆开。
    text = WebdavVideoTitleNoiseDictionary.stripDirectWords(
      text,
      WebdavVideoTitleNoiseDictionary.DIRECT_VERSION_WORDS,
      '版本制作直接替换',
      result
    )
    text = WebdavVideoTitleNoiseDictionary.stripDirectWords(
      text,
      WebdavVideoTitleNoiseDictionary.DIRECT_CATEGORY_WORDS,
      '分类直接替换',
      result
    )
    text = WebdavVideoTitleNoiseDictionary.stripDirectWords(
      text,
      WebdavVideoTitleNoiseDictionary.DIRECT_STATUS_WORDS,
      '状态直接替换',
      result
    )
    text = WebdavVideoTitleNoiseDictionary.stripDirectWords(
      text,
      WebdavVideoTitleNoiseDictionary.DIRECT_RESOURCE_WORDS,
      '资源直接替换',
      result
    )
    text = WebdavVideoTitleNoiseDictionary.stripLeadingCategoryWords(text, result)
    text = WebdavVideoTitleNoiseDictionary.stripTrailingExactWords(
      text,
      WebdavVideoTitleNoiseDictionary.TRAILING_STATUS_WORDS,
      '状态尾缀',
      result
    )
    text = WebdavVideoTitleNoiseDictionary.stripTrailingGenreWords(text, result)
    result.cleanedTitle = text.trim()
    return result
  }

  /** 按词表直接替换标题中的全部命中项，不要求前后存在分隔符。 */
  private static stripDirectWords(
    value: string,
    words: string[],
    ruleName: string,
    result: WebdavVideoTitleNoiseCleanResult
  ): string {
    let text = `${value || ''}`
    let index = 0
    while (index < words.length) {
      const word = words[index]!
      if (text.indexOf(word) >= 0) {
        text = text.split(word).join(' ')
        result.matchedWords.push(word)
        result.matchedRuleNames.push(ruleName)
      }
      index += 1
    }
    return text
  }

  /** 删除“共24集”等明确集数标记及其后的演员、题材和宣传说明。 */
  private static stripEpisodeMetadataTail(
    value: string,
    result: WebdavVideoTitleNoiseCleanResult
  ): string {
    const match = WebdavVideoTitleNoiseDictionary.findEpisodeMetadataTail(value)
    if (match === null || match.index <= 0) {
      return value
    }
    const title = value.substring(0, match.index).trim()
    if (title.length < 2) {
      return value
    }
    result.matchedWords.push(match[1]! !== undefined ? match[1]! : match[0]!.trim())
    result.matchedRuleNames.push('集数说明后缀')
    return title
  }

  /** 循环删除标题开头的独立剧种分类词。 */
  private static stripLeadingCategoryWords(
    value: string,
    result: WebdavVideoTitleNoiseCleanResult
  ): string {
    let text = `${value || ''}`.trim()
    let matched = true
    while (matched && text.length > 0) {
      matched = false
      let leadingBoundaryLength = 0
      while (leadingBoundaryLength < text.length &&
        WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(text.substring(
          leadingBoundaryLength,
          leadingBoundaryLength + 1
        ))) {
        leadingBoundaryLength += 1
      }
      const candidate = text.substring(leadingBoundaryLength)
      let index = 0
      while (index < WebdavVideoTitleNoiseDictionary.LEADING_CATEGORY_WORDS.length) {
        const word = WebdavVideoTitleNoiseDictionary.LEADING_CATEGORY_WORDS[index]!
        if (candidate.startsWith(word)) {
          const nextCharacter = candidate.substring(word.length, word.length + 1)
          if (nextCharacter.length === 0 || WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(nextCharacter)) {
            text = candidate.substring(word.length).trim()
            result.matchedWords.push(word)
            result.matchedRuleNames.push('剧种前缀')
            matched = true
            break
          }
        }
        index += 1
      }
    }
    return text
  }

  /** 从标题末尾按最长词优先删除连续题材标签，要求标签前存在分隔边界。 */
  private static stripTrailingGenreWords(
    value: string,
    result: WebdavVideoTitleNoiseCleanResult
  ): string {
    const text = `${value || ''}`.trim()
    let cursor = text.length
    let firstMatchedStart = text.length
    const matchedWords: string[] = []
    let searching = true
    while (searching && cursor > 0) {
      searching = false
      while (cursor > 0 && WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(
        text.substring(cursor - 1, cursor))) {
        cursor -= 1
      }
      let index = 0
      while (index < WebdavVideoTitleNoiseDictionary.TRAILING_GENRE_WORDS.length) {
        const word = WebdavVideoTitleNoiseDictionary.TRAILING_GENRE_WORDS[index]!
        const start = cursor - word.length
        if (start >= 0 && text.substring(start, cursor) === word) {
          matchedWords.unshift(word)
          firstMatchedStart = start
          cursor = start
          searching = true
          break
        }
        index += 1
      }
    }
    if (matchedWords.length === 0 || firstMatchedStart <= 0) {
      return text
    }
    // 关键变量：题材序列前必须有分隔符，不能把“爱情而已”等真实片名拆开。
    const previousCharacter = text.substring(firstMatchedStart - 1, firstMatchedStart)
    if (!WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(previousCharacter)) {
      return text
    }
    const title = text.substring(0, firstMatchedStart).trim()
    if (title.length < 2) {
      return text
    }
    let matchedIndex = 0
    while (matchedIndex < matchedWords.length) {
      result.matchedWords.push(matchedWords[matchedIndex]!)
      result.matchedRuleNames.push('题材尾缀')
      matchedIndex += 1
    }
    return title
  }

  /** 循环删除带独立边界的指定尾词。 */
  private static stripTrailingExactWords(
    value: string,
    words: string[],
    ruleName: string,
    result: WebdavVideoTitleNoiseCleanResult
  ): string {
    let text = `${value || ''}`.trim()
    let matched = true
    while (matched && text.length > 0) {
      matched = false
      let effectiveEnd = text.length
      while (effectiveEnd > 0 && WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(
        text.substring(effectiveEnd - 1, effectiveEnd))) {
        effectiveEnd -= 1
      }
      const candidate = text.substring(0, effectiveEnd)
      let index = 0
      while (index < words.length) {
        const word = words[index]!
        if (candidate.endsWith(word)) {
          const start = candidate.length - word.length
          const previousCharacter = start > 0 ? candidate.substring(start - 1, start) : ''
          if (start > 0 && WebdavVideoTitleNoiseDictionary.isBoundaryCharacter(previousCharacter)) {
            const title = candidate.substring(0, start).trim()
            if (title.length >= 2) {
              text = title
              result.matchedWords.push(word)
              result.matchedRuleNames.push(ruleName)
              matched = true
              break
            }
          }
        }
        index += 1
      }
    }
    return text
  }

  /** 判断字符是否是词语之间的明确边界。 */
  private static isBoundaryCharacter(value: string): boolean {
    return /^[\s._+\-–—:：,，;；/\\|·•\[\]\(\){}【】（）〖〗『』《》「」]$/.test(value)
  }
}
