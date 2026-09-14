/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { WebdavVideoReleaseTextHelper } from './WebdavVideoReleaseTextHelper.js'
import {
  WebdavVideoTitleNoiseCleanResult,
  WebdavVideoTitleNoiseDictionary
} from './WebdavVideoTitleNoiseDictionary.js'

/**
 * WebDAV 视频标题清洗工具。
 * 负责把网盘目录名、文件名和 TMDB 查询词中的资源描述、分类桶、规避字符统一清理掉。
 */
export class WebdavVideoTitleCleaner {
  private static readonly BRACKET_PATTERN: RegExp = /[\[\]\(\){}【】（）〖〗『』《》「」]/g
  private static readonly SEPARATOR_PATTERN: RegExp = /[._+\-–—:：,，;；/\\|·•]+/g
  private static readonly CJK_OBFUSCATION_JOINER_PATTERN: RegExp =
    /([\u4e00-\u9fa5])\s*(?:丨|👉|👈|👇|👆|🤜|[.．])\s*(?=[\u4e00-\u9fa5])/g
  private static readonly EXPLICIT_TMDB_ID_PATTERN: RegExp =
    /[\{\[\(【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}\s*[\}\]\)】）]?/ig
  private static readonly SUBTITLE_GROUP_BRACKET_PATTERN: RegExp =
    /[\[\(【（〖『《「][^\]\)】）〗』》」]{0,64}(?:字幕组|字幕社|压制组|翻译组)[^\]\)】）〗』》」]{0,64}[\]\)】）〗』》」]/ig
  private static readonly COLLECTION_RANGE_PATTERN: RegExp =
    /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}\s*(?:季|集|部)?|第\s*[0-9一二三四五六七八九十两]{1,3}\s*季(?:\s*\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}\s*集?)?|第\s*[0-9一二三四五六七八九十两]{1,3}\s*部|(?:season|series|s)\s*\d{1,2})(?:$|[\s._+\-–—:：,，;；/\\|·•])/ig
  private static readonly RESOURCE_TAG_PATTERN: RegExp =
    /(?:REMUX\s*蓝光原盘|蓝光原盘|高码率|高码版|普码版|低码版|码率|高码|净版|纯净版|臻彩|国粤英三语|国粤日三语|国粤日多音轨|国粤英日四语|国粤双语|国英双语|中英双字|中英字幕|国语中字|官方中字|内嵌特效|特效字幕|中文字幕|英文字幕|简繁英字幕|简繁中字|简繁|繁中|简中|简英|繁英|中字|粤语版|国语版|英语版|日语版|韩语版|多音轨|音轨|字幕|翡翠台源码|源码|附全系列|附系列|附全集|大包不错集数|国映\s*TV|动态漫画|动态漫|已更最新集|持续更新|长期更新|备用|正片|完整版|全集|单集|完结|已完结|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集|更新中)/ig
  private static readonly VIDEO_TECH_PATTERN: RegExp =
    /\b(?:4k|8k|2160[pi]|1440[pi]|1080[pi]|720[pi]|576[pi]|480[pi]|uhd|fhd|full\s*hd|hdr10\+?|hdr|sdr|edr|dv|dolby\s*vision|\d{2,3}\s*fps|web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|bd\s*remux|bdremux|remux|x\s*\.?\s*26[45]|h\s*\.?\s*26[45]|hevc|avc|vc[-.\s]?1|aac|ddp?(?:\s*\d(?:[.\s]\d)?)?|dts[-.\s]*hd(?:[-.\s]*ma)?|dts[-.\s]*hdma(?:\s*\d(?:[.\s]\d)?)?|hdma(?:\s*\d(?:[.\s]\d)?)?|dts|truehd|atmos|flac(?:\s*\d(?:[.\s]\d)?)?|lpcm|pcm(?:\s*\d(?:[.\s]\d)?)?|ac3|eac3|mp3|chs|cht|dual|multi|\d+\s*audios?|hami|wavve|fandango)\b/ig
  private static readonly RELEASE_GROUP_PATTERN: RegExp =
    /\b(?:HiveWeb|HHWEB|HDSWEB|CMCT|CHD|FRDS|WiKi|NTb|BTN|PTer|PTerWEB|OurTV|ADWeb|BillionMeta|BlackTV|MOMOWEB|VARYG|CTRLWEB|EDITH|HONE|MTeam|PandaQT|QuickIO|DreamHD|ParkHD|ZeroTV|ColorTV|FROGWeb|MiniTV|MiniHD|MNHD|HDWinG|SONYHD|HQC|XLYS|Mp4Ba|Mp4Fan|QHstudIo|QHstudio|OFA|OPS|LGNB|oSpecialCN|HDSky|CHDBits|BOTHD|BestWEB|HAN|CHAOSPACE|TAGWEB|FGT|HDT|DHTCLUB|AngelaBaby|GY|CHN|NAHOM|SGF|MgB|playBD|RARBG|DirtyHippie|KAIZEN|Telly|MHDVV|KHN|HDCTV)\b/ig
  private static readonly GENERIC_BUCKET_PATTERN: RegExp =
    /^(?:[A-Za-z]|数字开头|最近接收|电影和电视剧|盘\d*电影|院线|正片|原盘|蓝光原盘|国影|影片|电影|视频|电视剧|剧集|欧美剧|日韩剧|华语剧|海外媒体流|无字片源|普码|高码|粤语版|国语版|国粤双语|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|高能反转爽片|超清|高清|超高清|超高清SDR|4K|4K60帧|1080P|720P|专题|合集|系列|其他|未分类)$/i
  /** 短剧目录开头用于排序的序号，仅在数字后有明确分隔符时移除。 */
  private static readonly VIDEO_METADATA_LEADING_ORDER_PATTERN: RegExp =
    /^\s*0*\d{1,4}\s*[.\uff0e、_+\-\u2013\u2014:\uff1a]\s*/
  /** 短剧总集数及其后的演员、版本和类型文本，集数会单独保留给候选匹配。 */
  private static readonly VIDEO_METADATA_EPISODE_SUFFIX_PATTERN: RegExp =
    /[\[\(【（]?\s*\d{1,4}\s*集\s*[\]\)】）]?.*$/i
  /** 短剧类型标签，只在独立前后缀位置清理，避免删除剧名中的普通文字。 */
  private static readonly VIDEO_METADATA_TYPE_PATTERN: RegExp =
    /(?:^|[\s._+\-\u2013\u2014:\uff1a,，;；/\\|·•\[\]\(\){}【】（）]+)(?:微短剧|真人短剧|动画短剧|动态漫画|动态漫|有声漫画|有声漫|短剧|漫剧)(?=$|[\s._+\-\u2013\u2014:\uff1a,，;；/\\|·•\[\]\(\){}【】（）]+)/ig
  /** AI 短剧和 AI 漫剧常与日期目录直接相连，需要无条件清理。 */
  private static readonly VIDEO_METADATA_AI_TYPE_PATTERN: RegExp = /(?:AI\s*短剧|AI\s*漫剧)/ig
  /** 带有明确“主演/演员”标记的人员后缀。 */
  private static readonly VIDEO_METADATA_EXPLICIT_ACTOR_SUFFIX_PATTERN: RegExp =
    /(?:^|[\s._+\-\u2013\u2014:\uff1a,，;；/\\|]+)(?:领衔主演|主演|演员|主角)\s*[:：]?\s*.*$/i
  /** 无集数标记时常见的“剧名 演员A＆演员B”后缀。 */
  private static readonly VIDEO_METADATA_ACTOR_PAIR_SUFFIX_PATTERN: RegExp =
    /^(.*[\u4e00-\u9fa5A-Za-z0-9])\s+[\u4e00-\u9fa5·]{2,8}\s*[&＆]\s*[\u4e00-\u9fa5·]{2,8}(?:\s*[&＆]\s*[\u4e00-\u9fa5·]{2,8})*\s*$/
  /** 插件查询中不需要保留的标点与特殊符号。 */
  private static readonly VIDEO_METADATA_SPECIAL_SYMBOL_PATTERN: RegExp =
    /[\[\]\(\){}【】（）〖〗『』《》「」._+\-\u2013\u2014:：,，;；/\\|·•!！?？@#￥$%^*=<>＆&]+/g

  /** 生成用于比较的规范文本，和扫描服务中的查询规范保持一致。 */
  static normalizeSearchText(value: string): string {
    let text = `${value || ''}`.toLowerCase()
    text = text.replace(WebdavVideoTitleCleaner.BRACKET_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.SEPARATOR_PATTERN, ' ')
    return WebdavVideoTitleCleaner.collapseSpaces(text)
  }

  /** 清理普通标题，保留真正片名或剧名。 */
  static cleanTitle(value: string): string {
    const rawText = `${value || ''}`
    let text = WebdavVideoReleaseTextHelper.stripTechnicalDimensions(rawText)
    text = WebdavVideoTitleCleaner.stripExplicitTmdbIdText(text)
    text = WebdavVideoTitleCleaner.stripObfuscationJoiners(text)
    text = WebdavVideoTitleCleaner.stripSubtitleGroupBrackets(text)
    text = WebdavVideoTitleNoiseDictionary.clean(text).cleanedTitle
    text = WebdavVideoTitleCleaner.stripTrailingSupplementAndSeasonRange(text)
    text = WebdavVideoTitleCleaner.stripTrailingRating(text)
    text = WebdavVideoTitleCleaner.stripTrailingCollectionRange(text)
    text = text.replace(WebdavVideoTitleCleaner.COLLECTION_RANGE_PATTERN, ' ')
    text = WebdavVideoTitleCleaner.stripResourceTags(text)
    text = text.replace(WebdavVideoTitleCleaner.BRACKET_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.SEPARATOR_PATTERN, ' ')
    text = WebdavVideoTitleCleaner.stripIsolatedConnectors(text)
    text = WebdavVideoTitleCleaner.stripLeadingSingleLetterTitlePrefix(text)
    text = WebdavVideoTitleCleaner.stripTrailingYearAndSeason(text)
    // 年份和季信息移除后再清理一次，处理“片名 剧情 2025”留下的题材尾缀。
    text = WebdavVideoTitleNoiseDictionary.clean(text).cleanedTitle
    text = WebdavVideoTitleCleaner.stripTrailingProgramFormat(text)
    text = WebdavVideoTitleCleaner.stripTrailingReleaseDescriptors(text, rawText)
    text = WebdavVideoTitleCleaner.stripTrailingNoiseNumber(text, rawText)
    text = WebdavVideoTitleCleaner.stripTrailingMetadataResidue(text)
    text = WebdavVideoTitleCleaner.collapseSpaces(text)
    return WebdavVideoTitleCleaner.isGenericBucketTitle(text) ? '' : text
  }

  /**
   * 构建视频元数据插件的纯标题查询词。
   * 只清理网盘目录附加信息，保留剧名内部的数字和季度文本。
   */
  static cleanVideoMetadataSearchQuery(value: string): string {
    let text = `${value || ''}`.trim() // 关键变量：节目目录或解析标题的原始文本。
    if (text.length === 0) {
      return ''
    }
    text = WebdavVideoTitleCleaner.stripExplicitTmdbIdText(text)
    text = WebdavVideoTitleCleaner.stripObfuscationJoiners(text)
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_LEADING_ORDER_PATTERN, ' ')
    text = WebdavVideoTitleNoiseDictionary.clean(text).cleanedTitle
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_EPISODE_SUFFIX_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_EXPLICIT_ACTOR_SUFFIX_PATTERN, ' ')
    const actorPairMatch: RegExpExecArray | null =
      WebdavVideoTitleCleaner.VIDEO_METADATA_ACTOR_PAIR_SUFFIX_PATTERN.exec(text)
    if (actorPairMatch !== null && actorPairMatch.length > 1) {
      text = actorPairMatch[1]!
    }
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_AI_TYPE_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_TYPE_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_METADATA_SPECIAL_SYMBOL_PATTERN, ' ')
    text = WebdavVideoTitleCleaner.collapseSpaces(text)
    // 兼容旧解析流程已经把“95.剧名”转换成“95 剧名”的情况。
    text = text.replace(/^0*\d{1,4}\s+(?=[\u4e00-\u9fa5A-Za-z])/, '')
    // 只移除纯标题末尾独立的年份，不影响“重生1975”等剧名内部数字。
    text = text.replace(/\s+(?:19|20)\d{2}$/, '')
    text = WebdavVideoTitleCleaner.collapseSpaces(text)
    if (/^\d{1,2}月\d{1,2}日$/.test(text)) {
      return ''
    }
    return WebdavVideoTitleCleaner.isGenericBucketTitle(text) ? '' : text
  }

  /** 返回标题噪声命中明细，仅供扫描诊断日志解释清洗过程。 */
  static analyzeTitleNoise(value: string): WebdavVideoTitleNoiseCleanResult {
    return WebdavVideoTitleNoiseDictionary.clean(value)
  }

  /** 清理 TMDB 查询词；如果清理后和原始文本等价，则返回空字符串表示无需备用查询。 */
  static buildAlternateTmdbSearchQuery(query: string): string {
    const raw = `${query || ''}`.trim()
    const text = WebdavVideoTitleCleaner.cleanTitle(raw)
    // “原名 AKA 英文名”在主查询失败后只使用别名，避免把 AKA 一并发送给 TMDB。
    const aliasMatch = /(?:^|\s)AKA\s+(.+)$/i.exec(text)
    if (aliasMatch !== null && aliasMatch[1]! !== undefined) {
      const aliasTitle = WebdavVideoTitleCleaner.collapseSpaces(aliasMatch[1]!)
      if (aliasTitle.length > 1 && !WebdavVideoTitleCleaner.isGenericBucketTitle(aliasTitle)) {
        return aliasTitle
      }
    }
    const bilingualQuery = WebdavVideoTitleCleaner.buildBilingualQuery(text)
    if (bilingualQuery.length > 0) {
      return bilingualQuery
    }
    if (text.length === 0) {
      return ''
    }
    if (WebdavVideoTitleCleaner.normalizeSearchText(text) === WebdavVideoTitleCleaner.normalizeSearchText(raw)) {
      return ''
    }
    return text
  }

  /**
   * 使用原始文件名提供的年份和资源规格上下文，清理已经预处理过的电影标题尾词。
   * 该入口只处理明确尾缀，不会对普通标题再次执行整套清洗。
   */
  static stripContextualMovieReleaseDescriptors(title: string, rawValue: string): string {
    const cleaned = WebdavVideoTitleCleaner.stripTrailingReleaseDescriptors(title, rawValue)
    // 上游已移除音频标签时，仍使用原始文件名判断尾部数字是否属于技术参数。
    return WebdavVideoTitleCleaner.collapseSpaces(
      WebdavVideoTitleCleaner.stripTrailingNoiseNumber(cleaned, rawValue)
    )
  }

  /** 判断标题是否只是分类桶或资源描述，不能直接作为 TMDB 查询。 */
  static isGenericBucketTitle(value: string): boolean {
    const title = WebdavVideoTitleCleaner.collapseSpaces(`${value || ''}`)
    if (title.length === 0) {
      return true
    }
    const titleWithoutResource = WebdavVideoTitleCleaner.collapseSpaces(
      WebdavVideoTitleCleaner.stripResourceTags(title)
        .replace(WebdavVideoTitleCleaner.BRACKET_PATTERN, ' ')
        .replace(WebdavVideoTitleCleaner.SEPARATOR_PATTERN, ' ')
    )
    const normalizedTitle = WebdavVideoTitleCleaner.normalizeSearchText(titleWithoutResource)
    if (/^(?:(?:第\s*)?\d{1,4}\s*季\s*)?\d{1,4}\s+\d{1,4}\s*(?:集|话|話)?$/.test(normalizedTitle)) {
      return true
    }
    if (/^(?:我的\s*)?活动中心.*(?:免费|空间|免流)/.test(normalizedTitle)) {
      return true
    }
    if (/(?:不限速.*库|最全库|资源库|片库)\d*$/.test(normalizedTitle)) {
      return true
    }
    return WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.GENERIC_BUCKET_PATTERN, title)
  }

  /** 判断文件名是否应回退父目录片名，例如 4K.mp4、1080P.国粤双语.mp4。 */
  static shouldPreferDirectoryTitle(fileName: string, parsedTitle: string, parentTitle: string): boolean {
    if (WebdavVideoTitleCleaner.isGenericBucketTitle(parentTitle)) {
      return false
    }
    const cleanedParsedTitle = WebdavVideoTitleCleaner.cleanTitle(parsedTitle)
    if (cleanedParsedTitle.length === 0 || WebdavVideoTitleCleaner.isGenericBucketTitle(cleanedParsedTitle)) {
      return true
    }
    const parentHasChineseTitle = /[\u4e00-\u9fa5]/.test(parentTitle)
    const titleHasChinese = /[\u4e00-\u9fa5]/.test(parsedTitle)
    const fileText = `${fileName || ''} ${parsedTitle || ''}`
    const hasResourceNoise = WebdavVideoTitleCleaner.hasResourceNoise(fileText)
    if (parentHasChineseTitle && !titleHasChinese && hasResourceNoise) {
      return true
    }
    return hasResourceNoise && WebdavVideoTitleCleaner.cleanTitle(fileText).length === 0
  }

  /** 移除显式 TMDB ID 文本。 */
  static stripExplicitTmdbIdText(value: string): string {
    return WebdavVideoTitleCleaner.collapseSpaces(`${value || ''}`.replace(WebdavVideoTitleCleaner.EXPLICIT_TMDB_ID_PATTERN, ' '))
  }

  /** 移除夹在汉字之间的规避分隔符，例如“祝丨你好运”“走走👉停停”。 */
  private static stripObfuscationJoiners(value: string): string {
    let text = `${value || ''}`
    text = text.replace(WebdavVideoTitleCleaner.CJK_OBFUSCATION_JOINER_PATTERN, '$1')
    return text
  }

  /** 整块移除字幕组括号，不能只删“字幕”二字后留下组名。 */
  private static stripSubtitleGroupBrackets(value: string): string {
    return `${value || ''}`.replace(WebdavVideoTitleCleaner.SUBTITLE_GROUP_BRACKET_PATTERN, ' ')
  }

  /** 删除资源标签被清理后遗留的孤立连接符，不影响“Deadpool & Wolverine”这类片名。 */
  private static stripIsolatedConnectors(value: string): string {
    return `${value || ''}`.replace(/(?:^|\s)[&＆](?=\s|$)/g, ' ')
  }

  /** 删除节目名末尾的播出形式说明，只处理明确尾缀。 */
  private static stripTrailingProgramFormat(value: string): string {
    let text = `${value || ''}`
    text = text.replace(/([\u4e00-\u9fa5]{2,})(?:年番|季番)$/g, '$1')
    text = text.replace(/(?:^|\s)(?:年番|季番|周更|日更)\s*$/g, ' ')
    return text
  }

  /**
   * 只从标题尾部移除发行地区、版本和制作组描述。
   * 原文必须同时带年份或资源规格，避免误删普通片名中的短词。
   */
  private static stripTrailingReleaseDescriptors(value: string, rawValue: string): string {
    const raw = `${rawValue || ''}`
    const hasTechnicalReleaseContext =
      WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.VIDEO_TECH_PATTERN, raw) ||
      WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.RELEASE_GROUP_PATTERN, raw)
    const hasReleaseContext = /(?:19|20)\d{2}/.test(raw) || hasTechnicalReleaseContext
    if (!hasReleaseContext) {
      return value
    }
    let text = WebdavVideoTitleCleaner.collapseSpaces(value)
    text = WebdavVideoTitleNoiseDictionary.stripKnownPublisherSuffix(text, raw)
    let previousText = ''
    while (previousText !== text) {
      previousText = text
      // 只清理有发行上下文的独立尾缀，不能删除片名内部词语。
      text = text.replace(/(?:^|\s)(?:原盘|国英双音|国粤双音|蓝光版|内封字幕)\s*$/i, ' ')
      text = text.replace(/(?:^|\s)(?:Open\s+Matte|Collector'?s\s+Edition|(?:\d{1,3}(?:st|nd|rd|th)\s+)?Anniversary\s+Remastered\s+Edition|Remastered\s+Edition|Remastered|THEATRICAL|COMPLETE|Hybrid|IMAX|BDRemux|Ai\s+Upscaled|RIFE(?:\s+\d+(?:\s+\d+v?\d*)?)?|DoVi|HDR10Plus|泰吉修复|修复)\s*$/i, ' ')
      if (hasTechnicalReleaseContext) {
        text = text.replace(/(?:^|\s)(?:CC|DC|USA|JPN|KOR|KOREA|GER|GBR|ESP|HIN|TAM|FRE|ITA|SPA|POR|HUN|RUS|UKR|ENG|MOC|BFI|FRD|iT|HS|H|国语|粤语|英语|日语|韩语)\s*$/i, ' ')
        text = text.replace(/(?:^|\s)(?:NAHOM|SGF|MgB|playBD|RARBG|DirtyHippie|KAIZEN|Telly|MHDVV|KHN|HDCTV)\s*$/i, ' ')
      }
      text = WebdavVideoTitleCleaner.collapseSpaces(text)
    }
    return text
  }

  /** 移除标题末尾的合集范围，例如“功夫熊猫1-4”“护卫者1-3”。 */
  private static stripTrailingCollectionRange(value: string): string {
    let text = `${value || ''}`
    text = text.replace(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\s]{0,80}?)\s*\d{1,3}\s*(?:-|–|—|~|至|到)\s*\d{1,3}\s*(?:部|季|集)?(?=$|[\s._+\-–—:：,，;；/\\|·•])/g, '$1 ')
    return text
  }

  /**
   * 移除目录末尾的附带内容数量和整季范围。
   * 只处理明确尾缀，避免删除片名内部正常出现的数字。
   */
  private static stripTrailingSupplementAndSeasonRange(value: string): string {
    let text = `${value || ''}`
    text = text.replace(
      /\s*[\[\(【（]\s*附(?:前|第)?\s*\d{1,3}\s*(?:季|集|部)?\s*[\]\)】）]\s*$/i,
      ' '
    )
    // 括号可能已被上游解析器清理，此处继续移除残留的“附1/附前/附第1季”。
    text = text.replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])附(?:前|第)?\s*\d{0,3}\s*(?:季|集|部)?\s*$/i,
      ' '
    )
    text = text.replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:全\s*\d{1,3}\s*季|S\s*\d{1,2}\s*(?:-|–|—|~|至|到)\s*S?\s*\d{1,2})\s*$/i,
      ' '
    )
    return text
  }

  /** 移除清晰度、音轨、字幕、发布组等资源描述标签。 */
  private static stripResourceTags(value: string): string {
    let text = `${value || ''}`
    text = text.replace(WebdavVideoTitleCleaner.RESOURCE_TAG_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.VIDEO_TECH_PATTERN, ' ')
    text = text.replace(WebdavVideoTitleCleaner.RELEASE_GROUP_PATTERN, ' ')
    text = text.replace(/(?:4\s*k|8\s*k)?\s*(?:hq|hdr|sdr|edr)?\s*(?:60|120)?\s*fps/ig, ' ')
    text = text.replace(/\d{2,3}\s*帧/ig, ' ')
    text = text.replace(/([\u4e00-\u9fa5A-Za-z])(?:2160|1080|720|480)(?=$|[\s._+\-–—:：,，;；/\\|·•])/ig, '$1 ')
    text = text.replace(/(?:超高清|高清|超清|高码率|高码版|高码|码率|帧率)/ig, ' ')
    text = text.replace(/(?:^|[\s._+\-–—:：,，;；/\\|·•])率(?=$|[\s._+\-–—:：,，;；/\\|·•])/g, ' ')
    return text
  }

  /** 判断文件名或标题里是否包含资源描述噪声。 */
  private static hasResourceNoise(value: string): boolean {
    const text = `${value || ''}`
    return WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.RESOURCE_TAG_PATTERN, text) ||
      WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.VIDEO_TECH_PATTERN, text) ||
      WebdavVideoTitleCleaner.testPattern(WebdavVideoTitleCleaner.RELEASE_GROUP_PATTERN, text) ||
      /(?:4\s*k|8\s*k|超高清|高清|超清|高码率|高码|码率|帧率)/i.test(text)
  }

  /** 移除中文标题前误切出的单字母前缀。 */
  private static stripLeadingSingleLetterTitlePrefix(value: string): string {
    return `${value || ''}`.replace(/^\s*[A-Za-z]\s+(?=[\u4e00-\u9fa5])/g, '').trim()
  }

  /** 移除标题尾部年份和季信息，避免影响 TMDB 搜索词。 */
  private static stripTrailingYearAndSeason(value: string): string {
    let text = `${value || ''}`
    text = text.replace(/(\S)[\s._\-–—:：]+(?:19|20)\d{2}(?=$|[\s._\-–—:：])/g, '$1 ')
    text = text.replace(/([\u4e00-\u9fa5A-Za-z])(?:19|20)\d{2}$/g, '$1 ')
    text = text.replace(/(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季(?:$|[\s._\-–—:：].*)/ig, ' ')
    text = text.replace(/(?:season|series|s)\s*\d{1,2}(?:$|[\s._\-–—:：].*)/ig, ' ')
    return text
  }

  /** 移除“豆瓣 8.1、IMDb 7.5、国7.5”等明确评分尾缀。 */
  private static stripTrailingRating(value: string): string {
    return `${value || ''}`.replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:豆瓣|imdb|国)\s*\d(?:\.\d)?\s*$/i,
      ' '
    )
  }

  /** 资源规格被清理后，继续删除由码率、音轨等遗留的孤立尾部数字。 */
  private static stripTrailingNoiseNumber(value: string, rawValue: string): string {
    return WebdavVideoReleaseTextHelper.stripTrailingTechnicalNumbers(value, rawValue, [
      rawValue.search(WebdavVideoTitleCleaner.RESOURCE_TAG_PATTERN),
      rawValue.search(WebdavVideoTitleCleaner.RELEASE_GROUP_PATTERN)
    ])
  }

  /** 清理资源说明被拆分后残留在标题末尾的独立短词。 */
  private static stripTrailingMetadataResidue(value: string): string {
    let text = `${value || ''}`
    let previousText = ''
    while (previousText !== text) {
      previousText = text
      text = text.replace(/(?:^|\s)(?:简英|繁英|单集|共|附全系列|附系列|附全集)\s*$/, ' ')
    }
    return text
  }

  /** 从中英混排查询词中提取中文标题作为备用查询。 */
  private static buildBilingualQuery(query: string): string {
    const text = `${query || ''}`.trim()
    if (!/[\u4e00-\u9fa5]/.test(text) || !/[A-Za-z]/.test(text)) {
      return ''
    }
    const chineseOnly = WebdavVideoTitleCleaner.collapseSpaces(text.replace(/[A-Za-z][A-Za-z0-9'’:&.\-\s]*/g, ' '))
    return chineseOnly.length > 0 && chineseOnly.length < text.length ? chineseOnly : ''
  }

  /** 折叠连续空白，统一返回修剪后的文本。 */
  private static collapseSpaces(value: string): string {
    return `${value || ''}`.replace(/\s+/g, ' ').trim()
  }

  /** 统一处理全局正则的 lastIndex，避免连续 test 造成偶发漏判。 */
  private static testPattern(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0
    const matched = pattern.test(value)
    pattern.lastIndex = 0
    return matched
  }
}
