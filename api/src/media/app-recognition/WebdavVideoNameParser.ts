/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
import { WebdavVideoReleaseTextHelper } from './WebdavVideoReleaseTextHelper.js'
import { normalizeWebdavPath } from './path.js'
import {
  WebdavParsedVideoMediaType,
  WebdavParsedVideoName
} from './models.js'
import { WebdavVideoTitleCleaner } from './WebdavVideoTitleCleaner.js'

const SEARCH_TEXT_BRACKET_PATTERN: RegExp = /[\[\]\(\){}【】（）〖〗『』《》「」]/g
const SEARCH_TEXT_SEPARATOR_PATTERN: RegExp = /[._+\-–—:：,，;；/\\|]+/g
const WHITESPACE_PATTERN: RegExp = /\s+/g
// 文件名中常见的 HTML 与号实体，只参与标题解析，不修改实际远端路径。
const HTML_AMPERSAND_ENTITY_PATTERN: RegExp = /(?:&amp;|&#0*38;|&#x0*26;)/ig
const SEASON_EPISODE_PATTERN: RegExp = /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4})/
const COLLECT_SXE_EPISODE_PATTERN: RegExp = /[Ee](\d{1,4})/g
const SEASON_WORD_EPISODE_PATTERN: RegExp =
  /(?:^|[\s._\-\[【(（])(?:Season|Series)[\s._-]*(\d{1,2})[\s._\-–—:：]*(?:Episode|EP|E)[\s._-]*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/i
const ONE_X_EPISODE_PATTERN: RegExp = /(?:^|[\s._\-\[])(\d{1,2})x(\d{1,4})(?:\D|$)/i
const CHINESE_SEASON_EPISODE_PATTERN: RegExp =
  /第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]\s*第?\s*(\d{1,4})\s*[集话話]/
const CHINESE_SEASON_TRAILING_EPISODE_PATTERN: RegExp =
  /第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]\s*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/
const CHINESE_EPISODE_PATTERN: RegExp = /(?:第\s*0*(\d{1,4})\s*[集话話]|(?:^|[\s._\-\[【(（])0*(\d{1,4})\s*[集话話])/
const SPECIAL_EPISODE_PATTERN: RegExp =
  /(?:^|[\s._\-\[【(（])(?:SP|Special|SPECIAL)(?:[\s._-]*0*(\d{1,4})(?:\s*v\d+)?)?(?:$|[\s._\-–—:：\]】)）])/i
const EPISODE_ONLY_PATTERN: RegExp =
  /(?:^|[\s._\-\[【(（])(?:Episode|EP|E)[\s._-]*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/i
const COLLECT_EPISODE_ONLY_PATTERN: RegExp = /(?:Episode|EP|E)[\s._-]*0*(\d{1,4})/ig
const TRAILING_TITLE_EPISODE_PATTERN: RegExp = /^(.*?[A-Za-z\u4e00-\u9fa5])[\s._-]*0*(\d{1,4})(?:\s*v\d+)?$/
const NUMERIC_EPISODE_PATTERN: RegExp = /^\s*[\[\(【（]?\s*0*(\d{1,4})(?:\s*v\d+)?\s*[\]\)】）]?(?:$|[\s._\-–—:：])/
const BRACKETED_TITLE_PREFIX_PATTERN: RegExp = /^\s*[\[\(【〖『《「][A-Za-z0-9._+\-\s]{1,64}[\]\)】〗』》」]\s*/g
const BRACKETED_NOISE_TAG_PATTERN: RegExp =
  /[\[\(【（〖『《「][^\]\)】）〗』》」]{0,96}(?:www\.|hmxz|haimian|kkapi|海绵小站|日剧|美剧|韩剧|国产剧|英剧|港剧|台剧|泰剧|动漫|动画|电影|剧场版|特别篇|合集|系列|SRENIX|版|秒传|BDrip|WEB[-.\s]?DL|HEVC|x\s*\.?\s*26[45]|H\s*\.?\s*26[45]|FLAC|AAC|DTS|TrueHD|1080p|2160p|4K|HQ|60\s*fps|音轨|字幕|配音|水印|豆瓣|DIY)[^\]\)】）〗』》」]{0,96}[\]\)】）〗』》」]/ig
const BRACKETED_COLLECTION_RANGE_PATTERN: RegExp =
  /[\[\(【（]\s*\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}\s*季\s*(?:\+\s*SP)?\s*[\]\)】）]/ig
const YEAR_BRACKET_PATTERN: RegExp =
  /(?:[\[\(【（]\s*(?:19\d{2}|20\d{2})\s*[\]\)】）]|(?:^|[\s._\-–—:：])(?:19\d{2}|20\d{2})(?=$|[\s._\-–—:：]))/g
const TRAILING_BACKUP_TIMESTAMP_PATTERN: RegExp =
  /(?:^|[\s._\-–—])(?:19\d{2}|20\d{2})\d{4}[\s._\-–—]*\d{4,6}$/g
const TRAILING_SERIES_SEASON_PATTERN: RegExp =
  /[\s._\-–—:：]*(?:(?:season|series|s)\s*\d{1,2}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部))$/i
const LEADING_SORT_NUMBER_TITLE_PATTERN: RegExp = /^\s*\d{1,3}\s*(?=[\u4e00-\u9fa5])/
const TRAILING_COLLECTION_RANGE_TEXT_PATTERN: RegExp =
  /(?:^|[\s._\-–—:：])\d{1,2}\s*(?:(?:-|–|—|~|至|到)|\s+)\s*\d{1,2}\s*季\s*(?:\+?\s*SP)?$/i
const TRAILING_NUMERIC_RANGE_TEXT_PATTERN: RegExp =
  /[\s._\-–—:：]+\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}$/i
const TRAILING_SERIES_SINGLE_SEASON_NUMBER_PATTERN: RegExp = /[\s._\-–—:：]+\d{1,2}$/i
const TITLE_SEASON_RANGE_TEXT_PATTERN: RegExp =
  /(?:^|[\s._\-–—:：])(?:S\d{1,2}|Season\s*\d{1,2}|Series\s*\d{1,2}|EP\s*\d{1,4}\s*(?:-|–|—|~|至|到)\s*\d{1,4}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:-|–|—|~|至|到)\s*[0-9一二三四五六七八九十两]{1,3}\s*季|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部)|\d{1,2}\s*季全|\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2})(?:$|[\s._\-–—:：])/ig
const TRAILING_BRACKETLESS_VERSION_TAG_PATTERN: RegExp = /[\s._\-–—:：]+SRENIX\s*版?$/i
const EXPLICIT_TMDB_ID_TEXT_PATTERN: RegExp =
  /[\{\[\(【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}\s*[\}\]\)】）]?/ig
const GENERIC_NUMERIC_TITLE_PATTERN: RegExp = /^\s*\d{1,4}\s*$/
const GENERIC_RANGE_TITLE_PATTERN: RegExp = /^\s*\d{1,4}\s*(?:-|–|—|~|至|到)\s*\d{1,4}\s*$/
const GENERIC_EPISODE_RANGE_TITLE_PATTERN: RegExp =
  /^\s*(?:(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季\s*)?\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}\s*(?:集|话|話)?\s*(?:4k|8k|2160p|1080p|720p)?\s*$/i
const GENERIC_YEAR_BUCKET_TITLE_PATTERN: RegExp =
  /^\s*(?:(?:19|20)\d{2}\s*(?:-|–|—|~|至|到)\s*(?:(?:19|20)\d{2}|之前|以前|以后|之后)|(?:19|20)\d{2}\s*(?:年)?)\s*$/i
const GENERIC_SEASON_ONLY_TITLE_PATTERN: RegExp =
  /^\s*(?:(?:season|series|s)\s*\d{1,2}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部))\s*$/i
const IMDB_ID_GLOBAL_PATTERN: RegExp = /tt\d{6,10}/ig
const TITLE_BRACKET_PATTERN: RegExp = /[\[\]\(\){}【】（）〖〗『』《》「」]/g
const TITLE_DOT_PATTERN: RegExp = /[._+]+/g
const TITLE_SEPARATOR_PATTERN: RegExp = /[–—:：,，;；/\\|]/g
const VIDEO_QUALITY_PATTERN: RegExp =
  /\b(?:(?:bd|hd|uhd|fhd)\s*)?(?:2160p|1440p|1080p|720p|576p|480p)\b|\b(?:4k|8k|uhd|fhd|hdr10\+?|hdr|dv|dolby\s*vision|60\s*fps|120\s*fps|hq|raw|clean)\b/ig
const VIDEO_SOURCE_CLEAN_PATTERN: RegExp =
  /\b(?:web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|remux)\b/ig
const VIDEO_CODEC_PATTERN: RegExp =
  /\b(?:x\s*\.?\s*26[45]|h\s*\.?\s*26[45]|hevc|avc|10\s*bit|8\s*bit)\b/ig
const VIDEO_EDITION_PATTERN: RegExp = /\b(?:proper|repack|extended|uncut|director'?s\s*cut|multi|dual|chs|cht|subbed|v\d+)\b/ig
const VIDEO_PLATFORM_PATTERN: RegExp = /\b(?:nf|netflix|amzn|amazon|dsnp|disney|hulu|hmax|max|itunes|apple\s*tv|hami|wavve|fandango)\b/ig
const VIDEO_DIMENSION_PATTERN: RegExp = /\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/g
const VIDEO_FILE_SIZE_PATTERN: RegExp = /\b\d+(?:\.\d+)?\s*(?:GB|G|MB|M)\b/ig
const VIDEO_AUDIO_CLEAN_PATTERN: RegExp =
  /\b(?:DDP(?:[-._\s]*[1572][._\s]?[01])?|DD\+?(?:[-._\s]*[1572][._\s]?[01])?|EAC3|E-AC3|DTS[-._\s]*HD(?:[-._\s]*MA)?(?:[-._\s]*[1572][._\s]?[01])?|DTS(?:[-._\s]*[1572][._\s]?[01])?|TrueHD(?:[-._\s]*[1572][._\s]?[01])?|Atmos|AAC(?:[-._\s]*[257][._\s]?[01])?|FLAC(?:[-._\s]*[257][._\s]?[01])?|MP3|LPCM|PCM(?:[-._\s]*\d[._\s]?[01])?|AC3(?:[-._\s]*[1572][._\s]?[01])?|AV3A(?:[-._\s]*[1572][._\s]?[01])?|\d+\s*Audios?|\d+\s*Audio)\b/ig
// 声道布局只是媒体参数，不能在弱集号推断中变成第 5/7/2 集。
const AUDIO_CHANNEL_LAYOUT_PATTERN: RegExp =
  /(?:^|[\s._+\-–—:：,，;；/\\|\[\]（）【】])(?:1[._\s]?0|2[._\s]?[01]|4[._\s]?0|5[._\s]?[01]|6[._\s]?1|7[._\s]?[01])(?=$|[\s._+\-–—:：,，;；/\\|\[\]（）【】])/g
// “Cantonese&Mandarin”一类双语标签需要整体移除，避免与号阻断单个语言标签的边界匹配。
const VIDEO_LANGUAGE_PAIR_PATTERN: RegExp =
  /(?:^|[\s._\-–—:：])(?:Mandarin|Cantonese)\s*(?:&|and)\s*(?:Mandarin|Cantonese)(?=$|[\s._\-–—:：])/ig
const VIDEO_RESOURCE_CLEAN_PATTERN: RegExp =
  /(?:杜比视界|高码率|高码版|高码|码率|帧率版本|臻彩|内封简繁|内封|中文字幕|双语字幕|特效字幕|歌词字幕|繁英字幕|简英双语|简繁英字幕|简繁双语|中英字幕|英文字幕|纯净版|无水印|完整版|全集|特辑|国英多音轨|国粤英三语|国粤日三语|国粤日多音轨|国英双语|多音轨|音轨|配音|字幕|附全系列|附系列|附全集|国映\s*TV|大包不错集数|动态漫画|动态漫|片名水印|水印|单集\s*\d{1,4}\s*分钟|单集|豆瓣|DIY|共\s*\d{1,4}\s*集(?:全)?|全\s*\d{1,4}\s*集|\d{1,4}\s*集全|完结|已完结|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集|更新中|(?:^|[\s._\-–—:：])(?:简繁中字|简繁|繁中|简中|简英|繁英|中字|国语|国配|粤语|英语|日语|韩语|官中|国英|国粤英|国粤日|中英|Mandarin|Cantonese|Korean|Japanese|English|CHS|CHT|CHS-ENG|ENG)(?:$|[\s._\-–—:：]))/ig
const VIDEO_RELEASE_TAG_PATTERN: RegExp =
  /\b(?:HiveWeb|HHWEB|HDSWEB|CMCT|CHD|FRDS|WiKi|NTb|BTN|PTer|PTerWEB|OurTV|ADWeb|BillionMeta|BlackTV|MOMOWEB|VARYG|CTRLWEB|EDITH|HONE|MTeam|PandaQT|QuickIO|DreamHD|ParkHD|ZeroTV|ColorTV|FROGWeb|MiniTV|MiniHD|MNHD|HDWinG|SONYHD|HQC|XLYS|Mp4Ba|Mp4Fan|QHstudIo|QHstudio|OFA|OPS|LGNB|oSpecialCN|HDSky|CHDBits|FGT|HDT|DHTCLUB|AngelaBaby|GY|CHN)\b/ig
const LEADING_SITE_TAG_PATTERN: RegExp =
  /^\s*(?:[\[\(【（〖『《「]?[^/\\\]\)】）〗』》」]{0,96}(?:www\.|hmxz|haimian|kkapi|海绵小站)[^/\\\]\)】）〗』》」]{0,96}[\]\)】）〗』》」]?[\s._\-–—:：]*)+/i
const LEADING_RESOURCE_PREFIX_PATTERN: RegExp = /^\s*([A-Za-z]{1,3}|\d-\d)[-_]+(.+)$/
const AIR_DATE_PREFIX_PATTERN: RegExp = /^\s*(?:19|20)\d{2}[-_.]\d{1,2}[-_.]\d{1,2}(?:$|[\s._\-–—:：])/
const TRAILING_RATING_PATTERN: RegExp =
  /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:豆瓣|imdb|国)\s*\d(?:\.\d)?\s*$/i
const TRAILING_DASH_PATTERN: RegExp = /\s+-\s+$/g
const LEADING_PUNCTUATION_PATTERN: RegExp = /^[\s.\-_]+/g
const TRAILING_PUNCTUATION_PATTERN: RegExp = /[\s.\-_]+$/g
const EXTENSION_PATTERN: RegExp = /^(?:mp4|mkv|iso|avi|mov|wmv|flv|m4v|ts|m2ts|webm|rmvb|mpg|mpeg|strm)$/
const EXTRACT_YEAR_PATTERN: RegExp = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/g
const EXTRACT_IMDB_PATTERN: RegExp = /tt\d{6,10}/i
const EXTRACT_RESOLUTION_PATTERN: RegExp = /\b((?:bd|hd|uhd|fhd)?\s*(?:2160p|1440p|1080p|720p|576p|480p)|4k|8k)\b/i
const EXTRACT_SOURCE_PATTERN: RegExp = /\b(web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|remux)\b/i
const RELEASE_GROUP_PATTERN: RegExp = /^[A-Za-z0-9._]+$/
const GENERIC_MOVIE_FILE_TITLE_PATTERN: RegExp =
  /^(?:movie|movies|film|feature|video|videos|main|full|index|default|stream|sample|trailer|preview|part\s*\d+|cd\s*\d+|disc\s*\d+|disk\s*\d+|\d{3,4}p|正片|影片|电影|视频|样片|预告)$/i
const EXTRACT_SEASON_FROM_PATH_PATTERN: RegExp =
  /(?:(?:season|series|s)\s*(\d{1,2})|第\s*([0-9一二三四五六七八九十两]{1,3})\s*(?:季|部))/i
const SEASON_FOLDER_PATTERN: RegExp =
  /^(?:(?:season|series|s)\s*\d{1,2}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部))$/i
const SEASON_FOLDER_PREFIX_PATTERN: RegExp =
  /^(?:(?:season|series|s)\s*\d{1,2}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部))(?:$|[\s._\-–—:：].*)/i
const SEASON_TEXT_PATTERN: RegExp =
  /(?:(?:season|series|s)\s*(\d{1,2})|第\s*([0-9一二三四五六七八九十两]{1,3})\s*(?:季|部)|特别篇)/i
const SEASON_ZERO_TEXT_PATTERN: RegExp =
  /^(?:(?:season|series|s)\s*0{1,2}|第\s*0+\s*(?:季|部))(?:$|[\s._\-–—:：].*)/i
const COLLECT_NUMBER_PATTERN: RegExp = /\d{1,4}/g
const SERIES_PATH_HINT_PATTERN: RegExp =
  /(?:电视剧|剧集|连续剧|国产剧|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|短剧|番剧|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫|动画|动态漫画|动态漫|漫剧|漫画|综艺|tv\s*shows?|shows?|season|series|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部)|\d{1,4}\s*集全)/i
const MAX_INFERRED_EPISODE_NUMBER: number = 500

class WebdavEpisodeMarker {
  matched: boolean = false
  mediaType: WebdavParsedVideoMediaType = 'unknown'
  markerIndex: number = -1
  markerEndIndex: number = -1
  seasonNumber: number = 0
  // 关键变量：区分文件名明确写出的第 0 季与未提供季号时使用的默认值。
  hasExplicitSeasonNumber: boolean = false
  episodeNumber: number = 0
  episodeNumbers: number[] = []
}

export function normalizeWebdavVideoSearchText(value: string): string {
  let text = `${value || ''}`.toLowerCase()
  text = text.replace(SEARCH_TEXT_BRACKET_PATTERN, ' ')
  text = text.replace(SEARCH_TEXT_SEPARATOR_PATTERN, ' ')
  text = text.replace(WHITESPACE_PATTERN, ' ').trim()
  return text
}

export class WebdavVideoNameParser {
  static parseAsTvEpisode(
    fileName: string,
    path: string,
    seriesTitle: string,
    seasonNumber: number,
    fallbackEpisodeNumber: number = 0
  ): WebdavParsedVideoName {
    const parsed = WebdavVideoNameParser.parse(fileName, path)
    let title = WebdavVideoNameParser.cleanSeriesTitle(seriesTitle)
    if (title.length === 0 || WebdavVideoNameParser.isGenericSeriesFolderTitle(title)) {
      title = WebdavVideoNameParser.pickSeriesTitleFromPath(path)
    }
    if (title.length === 0 || WebdavVideoNameParser.isGenericSeriesFolderTitle(title)) {
      title = WebdavVideoNameParser.cleanSeriesTitle(parsed.title)
    }
    parsed.mediaType = 'tv'
    parsed.title = title
    parsed.query = title
    // 节目年份固定取节目目录年份，不能使用单集文件自己的播出年份。
    const seriesYear = WebdavVideoNameParser.resolveSeriesYearFromPath(path, title)
    if (seriesYear !== 0) {
      parsed.year = seriesYear > 0 ? seriesYear : 0
    }
    // 关键变量：文件名明确包含季号时优先使用文件名，避免目录上下文把 S00 覆盖成其他季。
    const hasExplicitSeasonNumber = WebdavVideoNameParser.hasExplicitSeasonNumber(fileName)
    if (!hasExplicitSeasonNumber) {
      parsed.seasonNumber = seasonNumber >= 0 ? seasonNumber :
        WebdavVideoNameParser.resolveEpisodeSeasonNumber(parsed.seasonNumber, path)
    }
    let episodeNumbers = WebdavVideoNameParser.normalizeEpisodeNumbers(parsed.episodeNumbers)
    if (episodeNumbers.length === 0 && parsed.episodeNumber > 0) {
      episodeNumbers.push(parsed.episodeNumber)
    }
    if (episodeNumbers.length === 0) {
      const inferredEpisodeNumber = WebdavVideoNameParser.inferEpisodeNumberFromFileName(fileName)
      if (inferredEpisodeNumber > 0) {
        episodeNumbers.push(inferredEpisodeNumber)
      }
    }
    if (episodeNumbers.length === 0 && fallbackEpisodeNumber > 0) {
      episodeNumbers.push(fallbackEpisodeNumber)
    }
    parsed.episodeNumbers = episodeNumbers
    const firstEpisodeNumber = episodeNumbers.length > 0 ? episodeNumbers[0]! : undefined
    parsed.episodeNumber = firstEpisodeNumber !== undefined ? firstEpisodeNumber : 0
    return WebdavVideoNameParser.finishParsedName(parsed)
  }

  static parse(fileName: string, path: string = ''): WebdavParsedVideoName {
    const parsed = new WebdavParsedVideoName()
    parsed.fileName = `${fileName || ''}`.trim()
    parsed.baseName = WebdavVideoNameParser.removeKnownExtension(parsed.fileName)
    parsed.year = WebdavVideoNameParser.extractYear(parsed.baseName)
    if (parsed.year <= 0) {
      parsed.year = WebdavVideoNameParser.extractNearestPathYear(path)
    }
    parsed.imdbId = WebdavVideoNameParser.extractImdbId(parsed.baseName)
    parsed.resolution = WebdavVideoNameParser.extractResolution(parsed.baseName)
    parsed.source = WebdavVideoNameParser.extractSource(parsed.baseName)
    parsed.releaseGroup = WebdavVideoNameParser.extractReleaseGroup(parsed.baseName)

    const episodeMarker = WebdavVideoNameParser.parseEpisodeMarker(parsed.baseName, path)
    if (episodeMarker.matched) {
      parsed.mediaType = 'tv'
      parsed.seasonNumber = episodeMarker.seasonNumber
      parsed.episodeNumber = episodeMarker.episodeNumber
      parsed.episodeNumbers = episodeMarker.episodeNumbers.slice()
      parsed.title = WebdavVideoNameParser.pickTvTitle(parsed.baseName, path, episodeMarker)
      parsed.query = parsed.title
      const seriesYear = WebdavVideoNameParser.resolveSeriesYearFromPath(path, parsed.title)
      if (seriesYear !== 0) {
        parsed.year = seriesYear > 0 ? seriesYear : 0
      }
      return WebdavVideoNameParser.finishParsedName(parsed)
    }

    parsed.mediaType = 'movie'
    parsed.title = WebdavVideoNameParser.cleanMovieTitle(parsed.baseName)
    parsed.query = parsed.title
    return WebdavVideoNameParser.finishParsedName(parsed)
  }

  /** 使用电影上下文解析文件，保留有独立发行年份证据的数字片名。 */
  static parseAsMovie(
    fileName: string,
    path: string,
    preferredTitle: string = ''
  ): WebdavParsedVideoName {
    const parsed = WebdavVideoNameParser.parse(fileName, path)
    parsed.mediaType = 'movie'
    parsed.seasonNumber = 0
    parsed.episodeNumber = 0
    parsed.episodeNumbers = []
    let title = WebdavVideoNameParser.cleanMovieTitle(preferredTitle)
    let usedPreferredTitle = title.length > 0 && !WebdavVideoNameParser.isGenericMovieFileTitle(title)
    if (title.length === 0 || WebdavVideoNameParser.isGenericMovieFileTitle(title)) {
      // 关键变量：始终从原始文件名重新提取电影标题，避免“007”被弱集号规则识别后丢失。
      const directFileTitle = WebdavVideoNameParser.cleanMovieTitle(parsed.baseName)
      title = directFileTitle.length > 0 && (!WebdavVideoNameParser.isGenericMovieFileTitle(directFileTitle) ||
        WebdavVideoNameParser.hasNumericMovieTitleEvidence(fileName, directFileTitle)) ?
        directFileTitle : WebdavVideoNameParser.cleanMovieTitle(parsed.title)
      usedPreferredTitle = false
    }
    if ((title.length === 0 || WebdavVideoNameParser.isGenericMovieFileTitle(title)) &&
      !WebdavVideoNameParser.hasNumericMovieTitleEvidence(fileName, title)) {
      title = WebdavVideoNameParser.pickMovieTitleFromPath(path)
    }
    parsed.title = title
    parsed.query = title
    if (usedPreferredTitle) {
      // 目录标题只有与首选电影标题对应时才能覆盖年份，不能越级读取上层节目的年份。
      const directoryYear = WebdavVideoNameParser.extractMatchingMovieTitleYearFromPath(path, title)
      if (directoryYear > 0) {
        parsed.year = directoryYear
      }
    } else if (parsed.year <= 0) {
      parsed.year = WebdavVideoNameParser.extractYear(preferredTitle)
    }
    return WebdavVideoNameParser.finishParsedName(parsed)
  }

  static buildScrapeTaskKey(mediaType: WebdavParsedVideoMediaType, query: string, year: number, imdbId: string): string {
    const normalizedQuery = normalizeWebdavVideoSearchText(query)
    const normalizedImdbId = `${imdbId || ''}`.trim().toLowerCase()
    if (normalizedImdbId.length > 0) {
      return `${mediaType}|imdb|${normalizedImdbId}`
    }
    if (normalizedQuery.length === 0) {
      return ''
    }
    return `${mediaType}|${normalizedQuery}|${year > 0 ? year.toString() : ''}`
  }

  static cleanSeriesDirectoryTitle(value: string): string {
    return WebdavVideoNameParser.cleanSeriesTitle(value)
  }

  static cleanMovieDirectoryTitle(value: string): string {
    return WebdavVideoNameParser.cleanMovieTitle(value)
  }

  static isGenericSeriesTitle(value: string): boolean {
    return WebdavVideoNameParser.isGenericSeriesFolderTitle(value)
  }

  static isGenericMovieFileTitle(value: string): boolean {
    const title = WebdavVideoNameParser.cleanTitleSegment(value)
    if (title.length === 0) {
      return true
    }
    if (WebdavVideoNameParser.isWeakScrapeTitleWithoutGenericCheck(title)) {
      return true
    }
    return GENERIC_MOVIE_FILE_TITLE_PATTERN.test(title)
  }

  /** 纯数字电影必须同时有独立发行年份证据，不能放开“01.mp4”等单集数字。 */
  static hasNumericMovieTitleEvidence(fileName: string, title: string): boolean {
    if (!/^\d{3,4}$/.test(title)) {
      return false
    }
    const raw = WebdavVideoNameParser.removeKnownExtension(fileName)
    const match = /^(\d{3,4})[\s._-]+[\[（(]?((?:19|20)\d{2})(?=$|[\s._\]）)-])/.exec(raw)
    return match !== null && match[1]! === title && match[2]! !== title
  }

  static isWeakScrapeTitle(value: string): boolean {
    const raw = `${value || ''}`.trim()
    const normalized = normalizeWebdavVideoSearchText(raw)
    if (normalized.length === 0) {
      return true
    }
    if (GENERIC_NUMERIC_TITLE_PATTERN.test(raw) || GENERIC_NUMERIC_TITLE_PATTERN.test(normalized)) {
      return true
    }
    if (GENERIC_RANGE_TITLE_PATTERN.test(raw) ||
      GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(raw) ||
      GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(normalized) ||
      /^\d{1,4}\s+\d{1,4}$/.test(normalized)) {
      return true
    }
    if (GENERIC_SEASON_ONLY_TITLE_PATTERN.test(raw) || GENERIC_SEASON_ONLY_TITLE_PATTERN.test(normalized)) {
      return true
    }
    return WebdavVideoNameParser.isGenericSeriesFolderTitle(raw)
  }

  static getFileStem(fileName: string): string {
    return WebdavVideoNameParser.removeKnownExtension(fileName)
  }

  static isSeasonFolderName(folderName: string): boolean {
    if (!folderName) {
      return false
    }
    return SEASON_FOLDER_PATTERN.test(folderName.trim())
  }

  static isEpisodeRangeFolderName(folderName: string): boolean {
    const text = `${folderName || ''}`.trim()
    if (GENERIC_RANGE_TITLE_PATTERN.test(text)) {
      return true
    }
    if (GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(text)) {
      return true
    }
    const normalizedText = normalizeWebdavVideoSearchText(text)
    if (GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(normalizedText)) {
      return true
    }
    return /^\d{1,4}\s+\d{1,4}$/.test(normalizedText)
  }

  static startsWithSeasonFolderName(folderName: string): boolean {
    if (!folderName) {
      return false
    }
    const text = folderName.trim()
    return SEASON_FOLDER_PREFIX_PATTERN.test(text) || WebdavVideoNameParser.isSpecialSeasonFolderName(text)
  }

  static isSpecialSeasonFolderName(folderName: string): boolean {
    return /特别篇/i.test(`${folderName || ''}`)
  }

  static extractSeasonNumberFromText(value: string): number {
    const text = `${value || ''}`.trim()
    if (text.length === 0) {
      return 0
    }
    if (/特别篇/i.test(text)) {
      return 0
    }
    const match = SEASON_TEXT_PATTERN.exec(text)
    if (match === null) {
      return 0
    }
    const seasonText = match[1]! !== undefined && match[1]!.length > 0 ? match[1]! :
      (match[2]! !== undefined ? match[2]! : '')
    return WebdavVideoNameParser.parseSeasonNumberText(seasonText)
  }

  /** 判断目录或文本是否明确声明第 0 季。 */
  static isSeasonZeroText(value: string): boolean {
    return SEASON_ZERO_TEXT_PATTERN.test(`${value || ''}`.trim())
  }

  static inferEpisodeNumberFromFileName(fileName: string): number {
    const baseName = WebdavVideoNameParser.removeKnownExtension(fileName)
    const sxeMarker = WebdavVideoNameParser.parseSeasonEpisodeMarker(baseName)
    if (sxeMarker.episodeNumber > 0) {
      return sxeMarker.episodeNumber
    }
    const seasonWordMarker = WebdavVideoNameParser.parseSeasonWordEpisodeMarker(baseName)
    if (seasonWordMarker.episodeNumber > 0) {
      return seasonWordMarker.episodeNumber
    }
    const oneXMarker = WebdavVideoNameParser.parseOneXEpisodeMarker(baseName)
    if (oneXMarker.episodeNumber > 0) {
      return oneXMarker.episodeNumber
    }
    const cnSeasonMarker = WebdavVideoNameParser.parseChineseSeasonEpisodeMarker(baseName)
    if (cnSeasonMarker.episodeNumber > 0) {
      return cnSeasonMarker.episodeNumber
    }
    const cnSeasonTrailingMarker = WebdavVideoNameParser.parseChineseSeasonTrailingEpisodeMarker(baseName)
    if (cnSeasonTrailingMarker.episodeNumber > 0) {
      return cnSeasonTrailingMarker.episodeNumber
    }
    const cnEpisodeMarker = WebdavVideoNameParser.parseChineseEpisodeMarker(baseName, '')
    if (cnEpisodeMarker.episodeNumber > 0) {
      return cnEpisodeMarker.episodeNumber
    }
    const episodeOnlyMarker = WebdavVideoNameParser.parseEpisodeOnlyMarker(baseName, '')
    if (episodeOnlyMarker.episodeNumber > 0) {
      return episodeOnlyMarker.episodeNumber
    }
    if (WebdavVideoNameParser.startsWithAirDate(baseName)) {
      return 0
    }
    const numericMarker = WebdavVideoNameParser.parseNumericEpisodeMarker(baseName)
    if (numericMarker.episodeNumber > 0) {
      return numericMarker.episodeNumber
    }
    let text = baseName.replace(YEAR_BRACKET_PATTERN, ' ')
    text = text.replace(VIDEO_DIMENSION_PATTERN, ' ')
    text = text.replace(VIDEO_QUALITY_PATTERN, ' ')
    text = text.replace(VIDEO_SOURCE_CLEAN_PATTERN, ' ')
    text = text.replace(VIDEO_CODEC_PATTERN, ' ')
    text = text.replace(VIDEO_AUDIO_CLEAN_PATTERN, ' ')
    text = text.replace(AUDIO_CHANNEL_LAYOUT_PATTERN, ' ')
    text = text.replace(VIDEO_FILE_SIZE_PATTERN, ' ')
    text = text.replace(VIDEO_RELEASE_TAG_PATTERN, ' ')
    const pattern = COLLECT_NUMBER_PATTERN
    pattern.lastIndex = 0
    let match = pattern.exec(text)
    while (match !== null) {
      const numberText = match[0]! !== undefined ? match[0]! : ''
      const value = WebdavVideoNameParser.safeParsePositiveInt(numberText)
      if (WebdavVideoNameParser.isUsableInferredEpisodeNumber(value)) {
        return value
      }
      match = pattern.exec(text)
    }
    return 0
  }

  /**
   * 仅从纯数字文件名提取弱集号，供目录内连续集号共识使用。
   * 例如 01.mp4、02 4K.mp4；带片名、年份或声道的文件不会进入该通道。
   */
  static inferBareEpisodeNumberFromFileName(fileName: string): number {
    const baseName = WebdavVideoNameParser.removeKnownExtension(fileName)
    if (WebdavVideoNameParser.startsWithAirDate(baseName)) {
      return 0
    }
    let text = baseName.replace(YEAR_BRACKET_PATTERN, ' ')
    text = text.replace(VIDEO_DIMENSION_PATTERN, ' ')
    text = text.replace(VIDEO_QUALITY_PATTERN, ' ')
    text = text.replace(VIDEO_SOURCE_CLEAN_PATTERN, ' ')
    text = text.replace(VIDEO_CODEC_PATTERN, ' ')
    text = text.replace(VIDEO_AUDIO_CLEAN_PATTERN, ' ')
    text = text.replace(AUDIO_CHANNEL_LAYOUT_PATTERN, ' ')
    text = text.replace(VIDEO_FILE_SIZE_PATTERN, ' ')
    text = text.replace(VIDEO_RELEASE_TAG_PATTERN, ' ')
    text = text.replace(/[\[\]（）【】()]/g, ' ').replace(WHITESPACE_PATTERN, ' ').trim()
    const match = /^0*(\d{1,4})(?:\s*v\d+)?$/i.exec(text)
    if (match === null || match[1]! === undefined) {
      return 0
    }
    const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[1]!)
    return WebdavVideoNameParser.isUsableInferredEpisodeNumber(episodeNumber) ? episodeNumber : 0
  }

  static looksLikeExplicitEpisodeFileName(fileName: string): boolean {
    const baseName = WebdavVideoNameParser.removeKnownExtension(fileName)
    return WebdavVideoNameParser.parseSeasonEpisodeMarker(baseName).matched ||
      WebdavVideoNameParser.parseSeasonWordEpisodeMarker(baseName).matched ||
      WebdavVideoNameParser.parseOneXEpisodeMarker(baseName).matched ||
      WebdavVideoNameParser.parseChineseSeasonEpisodeMarker(baseName).matched ||
      WebdavVideoNameParser.parseChineseSeasonTrailingEpisodeMarker(baseName).matched ||
      WebdavVideoNameParser.parseChineseEpisodeMarker(baseName, '').matched ||
      WebdavVideoNameParser.parseSpecialEpisodeMarker(baseName, '').matched ||
      WebdavVideoNameParser.parseEpisodeOnlyMarker(baseName, '').matched
  }

  /** 判断文件名是否明确声明第 0 季。 */
  static isSeasonZeroEpisodeFileName(fileName: string): boolean {
    const parsed = WebdavVideoNameParser.parseExplicitSeasonMarker(fileName)
    return parsed.matched && parsed.seasonNumber === 0
  }

  /** 判断文件名是否使用了同时包含季号和集号的明确剧集格式。 */
  private static hasExplicitSeasonNumber(fileName: string): boolean {
    return WebdavVideoNameParser.parseExplicitSeasonMarker(fileName).matched
  }

  /** 按优先级提取文件名中同时包含季号和集号的标记。 */
  private static parseExplicitSeasonMarker(fileName: string): WebdavEpisodeMarker {
    const baseName = WebdavVideoNameParser.removeKnownExtension(fileName)
    const markers: WebdavEpisodeMarker[] = [
      WebdavVideoNameParser.parseSeasonEpisodeMarker(baseName),
      WebdavVideoNameParser.parseSeasonWordEpisodeMarker(baseName),
      WebdavVideoNameParser.parseOneXEpisodeMarker(baseName),
      WebdavVideoNameParser.parseChineseSeasonEpisodeMarker(baseName),
      WebdavVideoNameParser.parseChineseSeasonTrailingEpisodeMarker(baseName)
    ]
    let index = 0
    while (index < markers.length) {
      if (markers[index]!.matched) {
        return markers[index]!
      }
      index += 1
    }
    return new WebdavEpisodeMarker()
  }

  static looksLikeEpisodeFileName(fileName: string): boolean {
    return WebdavVideoNameParser.looksLikeExplicitEpisodeFileName(fileName) ||
      WebdavVideoNameParser.inferEpisodeNumberFromFileName(fileName) > 0
  }

  private static finishParsedName(parsed: WebdavParsedVideoName): WebdavParsedVideoName {
    parsed.title = WebdavVideoNameParser.collapseSpaces(parsed.title)
    parsed.query = WebdavVideoNameParser.collapseSpaces(parsed.query)
    if (parsed.query.length === 0) {
      parsed.query = parsed.title
    }
    if (parsed.query.length === 0) {
      parsed.mediaType = 'unknown'
    }
    return parsed
  }

  private static parseEpisodeMarker(baseName: string, path: string): WebdavEpisodeMarker {
    return WebdavVideoNameParser.parseSingleEpisodeFileNameMarker(baseName, path)
  }

  private static parseSingleEpisodeFileNameMarker(baseName: string, path: string): WebdavEpisodeMarker {
    const sxeMarker = WebdavVideoNameParser.parseSeasonEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, sxeMarker)) {
      return sxeMarker
    }

    const seasonWordMarker = WebdavVideoNameParser.parseSeasonWordEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, seasonWordMarker)) {
      return seasonWordMarker
    }

    const oneXMarker = WebdavVideoNameParser.parseOneXEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, oneXMarker)) {
      return oneXMarker
    }

    const cnSeasonMarker = WebdavVideoNameParser.parseChineseSeasonEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, cnSeasonMarker)) {
      return cnSeasonMarker
    }

    const cnSeasonTrailingMarker = WebdavVideoNameParser.parseChineseSeasonTrailingEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, cnSeasonTrailingMarker)) {
      return cnSeasonTrailingMarker
    }

    const cnEpisodeMarker = WebdavVideoNameParser.parseChineseEpisodeMarker(baseName, path)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, cnEpisodeMarker)) {
      return cnEpisodeMarker
    }

    const specialMarker = WebdavVideoNameParser.parseSpecialEpisodeMarker(baseName, path)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, specialMarker)) {
      return specialMarker
    }

    const episodeOnlyMarker = WebdavVideoNameParser.parseEpisodeOnlyMarker(baseName, path)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, episodeOnlyMarker)) {
      return episodeOnlyMarker
    }

    const trailingTitleEpisodeMarker = WebdavVideoNameParser.parseTrailingTitleEpisodeMarker(baseName, path)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, trailingTitleEpisodeMarker)) {
      return trailingTitleEpisodeMarker
    }

    const numericMarker = WebdavVideoNameParser.parseNumericEpisodeMarker(baseName)
    if (WebdavVideoNameParser.isUsableEpisodeMarker(baseName, path, numericMarker)) {
      return numericMarker
    }

    return new WebdavEpisodeMarker()
  }

  private static isUsableEpisodeMarker(baseName: string, path: string, marker: WebdavEpisodeMarker): boolean {
    if (!marker.matched || marker.episodeNumber <= 0) {
      return false
    }
    if (marker.episodeNumbers.length === 0) {
      marker.episodeNumbers.push(marker.episodeNumber)
    }
    if (marker.markerIndex > 0) {
      const titleSegment = baseName.substring(0, marker.markerIndex)
      const title = WebdavVideoNameParser.cleanSeriesTitle(titleSegment)
      if (title.length > 0 && !WebdavVideoNameParser.isGenericSeriesFolderTitle(title)) {
        marker.seasonNumber = WebdavVideoNameParser.resolveEpisodeSeasonNumber(
          marker.seasonNumber,
          path,
          marker.hasExplicitSeasonNumber
        )
        return true
      }
    }
    if (WebdavVideoNameParser.pickSeriesTitleFromPath(path).length === 0) {
      return false
    }
    marker.seasonNumber = WebdavVideoNameParser.resolveEpisodeSeasonNumber(
      marker.seasonNumber,
      path,
      marker.hasExplicitSeasonNumber
    )
    return true
  }

  private static parseSeasonEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = SEASON_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.parseSeasonNumberText(match[1]!)
    marker.hasExplicitSeasonNumber = true
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    marker.episodeNumbers = WebdavVideoNameParser.collectSxeEpisodeNumbers(baseName.substring(match.index))
    if (marker.episodeNumbers.length === 0 && marker.episodeNumber > 0) {
      marker.episodeNumbers.push(marker.episodeNumber)
    }
    return marker
  }

  private static collectSxeEpisodeNumbers(value: string): number[] {
    const out: number[] = []
    const pattern = COLLECT_SXE_EPISODE_PATTERN
    pattern.lastIndex = 0
    let match = pattern.exec(value)
    while (match !== null) {
      const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[1]!)
      if (episodeNumber > 0 && out.indexOf(episodeNumber) < 0) {
        out.push(episodeNumber)
      }
      match = pattern.exec(value)
    }
    return out
  }

  private static parseSeasonWordEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = SEASON_WORD_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.parseSeasonNumberText(match[1]!)
    marker.hasExplicitSeasonNumber = true
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseOneXEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = ONE_X_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.parseSeasonNumberText(match[1]!)
    marker.hasExplicitSeasonNumber = true
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseChineseSeasonEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = CHINESE_SEASON_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.parseSeasonNumberText(match[1]!)
    marker.hasExplicitSeasonNumber = true
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseChineseSeasonTrailingEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = CHINESE_SEASON_TRAILING_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    // 没有“集/话”标记的四位年份属于发行信息，不能把“第1部 2019”解析为第2019集。
    if (/^(?:19|20)\d{2}$/.test(match[2]!)) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.parseSeasonNumberText(match[1]!)
    marker.hasExplicitSeasonNumber = true
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseChineseEpisodeMarker(baseName: string, path: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = CHINESE_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.extractSeasonFromPath(path)
    const episodeText = match[1]! !== undefined ? match[1]! : (match[2]! !== undefined ? match[2]! : '')
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(episodeText)
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseSpecialEpisodeMarker(baseName: string, path: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = SPECIAL_EPISODE_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.extractSeasonFromPath(path)
    const episodeText = match[1]! !== undefined ? match[1]! : ''
    marker.episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(episodeText)
    if (marker.episodeNumber <= 0) {
      marker.episodeNumber = 1
    }
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseEpisodeOnlyMarker(baseName: string, path: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const match = EPISODE_ONLY_PATTERN.exec(baseName)
    if (match === null || match.index === undefined) {
      return marker
    }
    const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[1]!)
    // “Wall-E.2008”中的 E.2008 是片名和年份，不是第 2008 集。
    if (!WebdavVideoNameParser.isUsableEpisodeOnlyMarkerNumber(episodeNumber)) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index
    marker.markerEndIndex = match.index + match[0]!.length
    marker.seasonNumber = WebdavVideoNameParser.extractSeasonFromPath(path)
    marker.episodeNumber = episodeNumber
    marker.episodeNumbers = WebdavVideoNameParser.collectEpisodeOnlyNumbers(baseName.substring(match.index))
    if (marker.episodeNumbers.length === 0 && marker.episodeNumber > 0) {
      marker.episodeNumbers.push(marker.episodeNumber)
    }
    return marker
  }

  private static collectEpisodeOnlyNumbers(value: string): number[] {
    const out: number[] = []
    const pattern = COLLECT_EPISODE_ONLY_PATTERN
    pattern.lastIndex = 0
    let match = pattern.exec(value)
    while (match !== null) {
      const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[1]!)
      if (WebdavVideoNameParser.isUsableEpisodeOnlyMarkerNumber(episodeNumber) &&
        out.indexOf(episodeNumber) < 0) {
        out.push(episodeNumber)
      }
      match = pattern.exec(value)
    }
    return out
  }

  private static parseTrailingTitleEpisodeMarker(baseName: string, path: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    if (!WebdavVideoNameParser.hasSeriesPathHint(path)) {
      return marker
    }
    if (WebdavVideoNameParser.startsWithAirDate(baseName) || WebdavVideoNameParser.containsResolutionDimension(baseName)) {
      return marker
    }
    if (WebdavVideoNameParser.endsWithVideoCodecNumber(baseName)) {
      return marker
    }
    const match = TRAILING_TITLE_EPISODE_PATTERN.exec(WebdavVideoNameParser.collapseSpaces(baseName))
    if (match === null || match.index === undefined) {
      return marker
    }
    const title = WebdavVideoNameParser.cleanSeriesTitle(match[1]!)
    if (title.length === 0 || WebdavVideoNameParser.isGenericSeriesFolderTitle(title)) {
      return marker
    }
    const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[2]!)
    if (!WebdavVideoNameParser.isUsableInferredEpisodeNumber(episodeNumber)) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = match.index + match[1]!.length
    marker.markerEndIndex = baseName.length
    marker.seasonNumber = WebdavVideoNameParser.extractSeasonFromPath(path)
    marker.episodeNumber = episodeNumber
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static parseNumericEpisodeMarker(baseName: string): WebdavEpisodeMarker {
    const marker = new WebdavEpisodeMarker()
    const cleanBaseName = WebdavVideoNameParser.collapseSpaces(`${baseName || ''}`.trim())
    if (WebdavVideoNameParser.startsWithAirDate(cleanBaseName) ||
      WebdavVideoNameParser.containsResolutionDimension(cleanBaseName)) {
      return marker
    }
    const match = NUMERIC_EPISODE_PATTERN.exec(cleanBaseName)
    if (match === null) {
      return marker
    }
    const episodeNumber = WebdavVideoNameParser.safeParsePositiveInt(match[1]!)
    if (!WebdavVideoNameParser.isUsableInferredEpisodeNumber(episodeNumber)) {
      return marker
    }
    marker.matched = true
    marker.mediaType = 'tv'
    marker.markerIndex = 0
    marker.markerEndIndex = baseName.length
    marker.episodeNumber = episodeNumber
    marker.episodeNumbers.push(marker.episodeNumber)
    return marker
  }

  private static pickTvTitle(baseName: string, path: string, marker: WebdavEpisodeMarker): string {
    let titleSegment = ''
    if (marker.markerIndex > 0) {
      titleSegment = baseName.substring(0, marker.markerIndex)
    }
    let title = WebdavVideoNameParser.cleanSeriesTitle(titleSegment)
    if (title.length > 0) {
      return title
    }

    title = WebdavVideoNameParser.pickSeriesTitleFromPath(path)
    if (title.length > 0) {
      return title
    }

    title = WebdavVideoNameParser.cleanSeriesTitle(baseName)
    return title
  }

  private static pickSeriesTitleFromPath(path: string): string {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return ''
    }
    let cursor = WebdavVideoNameParser.getParentPath(normalizedPath)
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      if (!WebdavVideoNameParser.isGenericMediaRootDirectoryName(folderName) &&
        !WebdavVideoNameParser.isSeasonFolderName(folderName) &&
        !WebdavVideoNameParser.isEpisodeRangeFolderName(folderName)) {
        const title = WebdavVideoNameParser.cleanSeriesTitle(folderName)
        if (title.length > 0 &&
          !WebdavVideoNameParser.isGenericSeriesFolderTitle(title) &&
          !WebdavVideoNameParser.isWeakScrapeTitle(title) &&
          !WebdavVideoNameParser.isSpecialEpisodeContainerTitle(title) &&
          !WebdavVideoNameParser.isStoryArcContainerTitle(folderName, title)) {
          return title
        }
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return ''
  }

  /** 清理电影资源说明，保留数字片名和续集编号。 */
  private static cleanMovieTitle(baseName: string): string {
    let text = baseName
    // “1917：逆战救兵”开头的四位数字属于片名，不作为发行年份删除。
    const numericTitleMatch = /^((?:19|20)\d{2})(?:\s*[:：]\s*|(?=$|[\s._-]+[\[（(]?(?:(?:19|20)\d{2}|\d{3,4}[pi]|[48]k)\b))/i.exec(text)
    const numericTitlePrefix = numericTitleMatch !== null && numericTitleMatch[1]! !== undefined ?
      numericTitleMatch[1]! : ''
    if (numericTitleMatch !== null) {
      text = text.substring(numericTitleMatch[0]!.length)
    }
    text = text.replace(IMDB_ID_GLOBAL_PATTERN, ' ')
    text = text.replace(EXPLICIT_TMDB_ID_TEXT_PATTERN, ' ')
    text = text.replace(TRAILING_BACKUP_TIMESTAMP_PATTERN, ' ')
    // “Wreck-It.Ralph2012”末尾紧邻英文片名的四位数仍是发行年份。
    text = text.replace(/([A-Za-z])((?:19|20)\d{2})(?=$|[\s._\-–—:：])/g, '$1 ')
    text = text.replace(YEAR_BRACKET_PATTERN, ' ')
    if (/(?:19|20)\d{2}/.test(text)) {
      text = text.replace(/([\]\)】）])?\s*[-_.]\s*(?:(?:cd|disc|disk|part|pt)\s*)?\d{1,2}\s*$/i, '$1')
    }
    const cleanedTitle = WebdavVideoNameParser.cleanTitleSegment(text)
    // 关键变量：保留原始文件名的年份和资源规格上下文，只在标题尾部删除版本、地区等说明。
    const contextualTitle = WebdavVideoTitleCleaner.stripContextualMovieReleaseDescriptors(cleanedTitle, baseName)
    return numericTitlePrefix.length > 0 ?
      WebdavVideoNameParser.collapseSpaces(`${numericTitlePrefix} ${contextualTitle}`) : contextualTitle
  }

  private static cleanSeriesTitle(value: string): string {
    let text = `${value || ''}`
    text = text.replace(BRACKETED_COLLECTION_RANGE_PATTERN, ' ')
    text = text.replace(TRAILING_BACKUP_TIMESTAMP_PATTERN, ' ')
    text = text.replace(YEAR_BRACKET_PATTERN, ' ')
    // 先清理完整的 S01~S07、附1 等范围，再处理单季尾缀，避免只剩下“S01~”。
    text = WebdavVideoTitleCleaner.cleanTitle(text)
    text = text.replace(TRAILING_SERIES_SEASON_PATTERN, ' ')
    const title = WebdavVideoNameParser.cleanTitleSegment(text)
    return WebdavVideoNameParser.collapseSpaces(title.replace(TRAILING_SERIES_SINGLE_SEASON_NUMBER_PATTERN, ' '))
  }

  private static isGenericSeriesFolderTitle(value: string): boolean {
    if (WebdavVideoNameParser.isWeakScrapeTitleWithoutGenericCheck(value)) {
      return true
    }
    if (WebdavVideoNameParser.isIgnoredDirectoryTitle(value)) {
      return true
    }
    if (WebdavVideoNameParser.isStoryArcContainerTitle(value, value)) {
      return true
    }
    const normalized = normalizeWebdavVideoSearchText(value)
    if (/^\d{1,4}\s+(?:电视剧|剧集|动漫|动画|电影|影片|视频)$/.test(normalized)) {
      return true
    }
    return normalized === 'movie' ||
      normalized === 'movies' ||
      normalized === 'film' ||
      normalized === 'films' ||
      normalized === 'video' ||
      normalized === 'videos' ||
      normalized === 'tv' ||
      normalized === 'series' ||
      normalized === 'show' ||
      normalized === 'shows' ||
      normalized === 'anime' ||
      normalized === 'animation' ||
      normalized === 'webdav' ||
      normalized === 'dav' ||
      normalized === 'media' ||
      normalized === '资源' ||
      normalized === '云盘' ||
      normalized === '网盘' ||
      normalized === '个人盘' ||
      normalized === '国产' ||
      normalized === '华语' ||
      normalized === '欧美' ||
      normalized === '日韩' ||
      normalized === '国漫' ||
      normalized === '电影' ||
      normalized === '动画电影' ||
      normalized === '华语电影' ||
      normalized === '影片' ||
      normalized === '视频' ||
      normalized === '电视剧' ||
      normalized === '剧集' ||
      normalized === '国产剧' ||
      normalized === '美剧' ||
      normalized === '英剧' ||
      normalized === '日剧' ||
      normalized === '韩剧' ||
      normalized === '港剧' ||
      normalized === '台剧' ||
      normalized === '泰剧' ||
      normalized === '短剧' ||
      normalized === '节目' ||
      normalized === '动漫网剧' ||
      normalized === '国产动漫' ||
      normalized === '日韩动漫' ||
      normalized === '欧美动漫' ||
      normalized === '日漫' ||
      normalized === '美漫' ||
      normalized === '高能反转爽片' ||
      normalized === '动漫' ||
      normalized === '动画' ||
      normalized === '综艺' ||
      normalized === '纪录片'
  }

  private static isSpecialEpisodeContainerTitle(value: string): boolean {
    const normalized = normalizeWebdavVideoSearchText(value)
    return normalized === '剧场版' ||
      normalized === '劇場版' ||
      normalized.indexOf('剧场版 ') === 0 ||
      normalized.indexOf('劇場版 ') === 0 ||
      normalized === '特别篇' ||
      normalized.indexOf('特别篇 ') === 0 ||
      normalized === '番外' ||
      normalized.indexOf('番外 ') === 0
  }

  private static isWeakScrapeTitleWithoutGenericCheck(value: string): boolean {
    const raw = `${value || ''}`.trim()
    const normalized = normalizeWebdavVideoSearchText(raw)
    if (normalized.length === 0) {
      return true
    }
    if (GENERIC_NUMERIC_TITLE_PATTERN.test(raw) || GENERIC_NUMERIC_TITLE_PATTERN.test(normalized)) {
      return true
    }
    if (GENERIC_RANGE_TITLE_PATTERN.test(raw) ||
      GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(raw) ||
      GENERIC_EPISODE_RANGE_TITLE_PATTERN.test(normalized) ||
      /^\d{1,4}\s+\d{1,4}$/.test(normalized)) {
      return true
    }
    return GENERIC_SEASON_ONLY_TITLE_PATTERN.test(raw) || GENERIC_SEASON_ONLY_TITLE_PATTERN.test(normalized)
  }

  /** 先剔除完整技术参数，再处理分隔符，避免将参数拆成片名数字。 */
  private static cleanTitleSegment(value: string): string {
    let text = WebdavVideoReleaseTextHelper.stripTechnicalDimensions(`${value || ''}`)
    text = text.replace(HTML_AMPERSAND_ENTITY_PATTERN, '&')
    text = WebdavVideoNameParser.removeKnownExtension(text)
    text = text.replace(LEADING_SITE_TAG_PATTERN, ' ')
    text = WebdavVideoNameParser.stripLeadingResourcePrefix(text)
    text = text.replace(EXPLICIT_TMDB_ID_TEXT_PATTERN, ' ')
    text = text.replace(BRACKETED_COLLECTION_RANGE_PATTERN, ' ')
    text = text.replace(BRACKETED_NOISE_TAG_PATTERN, ' ')
    text = WebdavVideoNameParser.removeTitleCategoryNoise(text)
    text = text.replace(TRAILING_BACKUP_TIMESTAMP_PATTERN, ' ')
    text = text.replace(BRACKETED_TITLE_PREFIX_PATTERN, ' ')
    text = text.replace(LEADING_SORT_NUMBER_TITLE_PATTERN, ' ')
    text = text.replace(IMDB_ID_GLOBAL_PATTERN, ' ')
    text = text.replace(TRAILING_RATING_PATTERN, ' ')
    text = text.replace(TITLE_BRACKET_PATTERN, ' ')
    text = text.replace(TITLE_DOT_PATTERN, ' ')
    text = text.replace(TRAILING_NUMERIC_RANGE_TEXT_PATTERN, ' ')
    text = text.replace(TITLE_SEPARATOR_PATTERN, ' ')
    text = text.replace(VIDEO_QUALITY_PATTERN, ' ')
    text = text.replace(VIDEO_DIMENSION_PATTERN, ' ')
    text = text.replace(VIDEO_SOURCE_CLEAN_PATTERN, ' ')
    text = text.replace(VIDEO_CODEC_PATTERN, ' ')
    text = text.replace(VIDEO_AUDIO_CLEAN_PATTERN, ' ')
    text = text.replace(VIDEO_LANGUAGE_PAIR_PATTERN, ' ')
    text = text.replace(VIDEO_EDITION_PATTERN, ' ')
    text = text.replace(VIDEO_PLATFORM_PATTERN, ' ')
    text = text.replace(VIDEO_FILE_SIZE_PATTERN, ' ')
    text = text.replace(VIDEO_RESOURCE_CLEAN_PATTERN, ' ')
    text = WebdavVideoNameParser.removeTrailingMetadataResidue(text)
    text = text.replace(VIDEO_RELEASE_TAG_PATTERN, ' ')
    text = text.replace(TITLE_SEASON_RANGE_TEXT_PATTERN, ' ')
    text = text.replace(TRAILING_COLLECTION_RANGE_TEXT_PATTERN, ' ')
    text = text.replace(TRAILING_BRACKETLESS_VERSION_TAG_PATTERN, ' ')
    text = WebdavVideoNameParser.truncateTitleAtMetadataSuffix(text)
    text = WebdavVideoNameParser.removeTrailingNoiseNumber(text, value)
    text = WebdavVideoNameParser.removeTrailingReleaseGroup(text, value)
    text = text.replace(TRAILING_DASH_PATTERN, ' ')
    text = text.replace(LEADING_PUNCTUATION_PATTERN, ' ')
    text = text.replace(TRAILING_PUNCTUATION_PATTERN, ' ')
    text = text.replace(TRAILING_COLLECTION_RANGE_TEXT_PATTERN, ' ')
    text = WebdavVideoTitleCleaner.cleanTitle(text)
    return WebdavVideoNameParser.collapseSpaces(text)
  }

  /** 清理资源说明被拆分后残留在片名末尾的独立短词。 */
  private static removeTrailingMetadataResidue(value: string): string {
    let text = `${value || ''}`
    let previousText = ''
    while (previousText !== text) {
      previousText = text
      text = text.replace(/(?:^|\s)(?:简英|繁英|单集|共|附全系列|附系列|附全集)\s*$/, ' ')
    }
    return text
  }

  /** 移除无括号的剧种分类词，并处理连续多个分类词的情况。 */
  private static removeTitleCategoryNoise(value: string): string {
    return WebdavVideoTitleCleaner.analyzeTitleNoise(value).cleanedTitle
  }

  private static stripLeadingResourcePrefix(value: string): string {
    const match = LEADING_RESOURCE_PREFIX_PATTERN.exec(value)
    if (match === null) {
      return value
    }
    const prefix = match[1]! !== undefined ? match[1]! : ''
    const rest = match[2]! !== undefined ? match[2]!.trim() : ''
    if (rest.length === 0) {
      return value
    }
    if (prefix.indexOf('-') >= 0 || prefix.length > 1 || /^[\u4e00-\u9fa5]/.test(rest)) {
      return rest
    }
    return value
  }

  /** 由统一噪声库删除标题尾部的题材、状态和集数说明。 */
  private static truncateTitleAtMetadataSuffix(value: string): string {
    const cleaned = WebdavVideoTitleCleaner.analyzeTitleNoise(value).cleanedTitle
    return cleaned.length >= 2 && !WebdavVideoNameParser.isWeakScrapeTitleWithoutGenericCheck(cleaned) ?
      cleaned : value
  }

  /** 按原始文件名的技术参数位置清理数字，避免删除续集编号。 */
  private static removeTrailingNoiseNumber(value: string, rawValue: string): string {
    return WebdavVideoReleaseTextHelper.stripTrailingTechnicalNumbers(value, rawValue, [
      rawValue.search(VIDEO_RESOURCE_CLEAN_PATTERN),
      rawValue.search(VIDEO_RELEASE_TAG_PATTERN)
    ])
  }

  private static removeTrailingReleaseGroup(value: string, rawValue: string): string {
    const text = WebdavVideoNameParser.collapseSpaces(value)
    if (!/[A-Za-z\u4e00-\u9fa5]/.test(text)) {
      return value
    }
    const raw = `${rawValue || ''}`
    const hasReleaseContext = WebdavVideoNameParser.testGlobalPattern(VIDEO_QUALITY_PATTERN, raw) ||
      WebdavVideoNameParser.testGlobalPattern(VIDEO_SOURCE_CLEAN_PATTERN, raw) ||
      WebdavVideoNameParser.testGlobalPattern(VIDEO_CODEC_PATTERN, raw) ||
      WebdavVideoNameParser.testGlobalPattern(VIDEO_AUDIO_CLEAN_PATTERN, raw) ||
      WebdavVideoNameParser.testGlobalPattern(VIDEO_FILE_SIZE_PATTERN, raw) ||
      WebdavVideoNameParser.testGlobalPattern(VIDEO_RELEASE_TAG_PATTERN, raw)
    if (!hasReleaseContext) {
      return value
    }
    let output = text.replace(/[\s._\-–—:：]+(?:PandaQT|QuickIO|DreamHD|ParkHD|ZeroTV|ColorTV|FROGWeb|MiniTV|SONYHD|HQC|XLYS|Mp4Ba|Mp4Fan|QHstudIo|QHstudio|OFA|OPS|LGNB|oSpecialCN|HDSky|CHDBits|PTerWEB|PTer)$/i, ' ')
    output = output.replace(/[\s._\-–—:：]+(?:H|X)\s*26[45]$/i, ' ')
    output = output.replace(/[\s._\-–—:：]+(?:TrueHD|DTS|DDP|AAC)\s*\d?\s*\d?$/i, ' ')
    // 关键变量：从原始文件名末尾动态提取的发布组，例如 CHS-ENG.JKYY 中的 JKYY。
    const releaseGroup = WebdavVideoNameParser.extractReleaseGroup(raw)
    const groupParts = releaseGroup.split(/[._\-]+/).filter((part: string): boolean => part.length > 0)
    const outputParts = WebdavVideoNameParser.collapseSpaces(output).split(' ')
    let shouldRemoveLastPart = true
    while (outputParts.length > 0 && shouldRemoveLastPart) {
      shouldRemoveLastPart = false
      const lastPart = outputParts[outputParts.length - 1]!
      if (lastPart === undefined) {
        break
      }
      let groupIndex = 0
      while (groupIndex < groupParts.length) {
        const groupPart = groupParts[groupIndex]!
        if (groupPart !== undefined && groupPart.toLowerCase() === lastPart.toLowerCase()) {
          shouldRemoveLastPart = true
          break
        }
        groupIndex += 1
      }
      if (!shouldRemoveLastPart) {
        break
      }
      outputParts.pop()
    }
    output = outputParts.join(' ')
    return WebdavVideoNameParser.collapseSpaces(output)
  }

  private static testGlobalPattern(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0
    const matched = pattern.test(value)
    pattern.lastIndex = 0
    return matched
  }

  private static isIgnoredDirectoryTitle(value: string): boolean {
    const raw = `${value || ''}`.trim()
    const normalized = normalizeWebdavVideoSearchText(raw)
    if (GENERIC_YEAR_BUCKET_TITLE_PATTERN.test(raw) || GENERIC_YEAR_BUCKET_TITLE_PATTERN.test(normalized)) {
      return true
    }
    if (normalized === '人人影视' ||
      normalized === '年份未标' ||
      normalized === '年代未标' ||
      normalized === '年代未详' ||
      normalized === '年份未知' ||
      normalized === '未知年份' ||
      normalized === '之前' ||
      normalized === '以前' ||
      normalized === '以后' ||
      normalized === '之后' ||
      normalized === '求片' ||
      normalized === '求片求片' ||
      normalized === '求片求片求片' ||
      normalized === '未分类' ||
      normalized === '其他' ||
      normalized === '公众号' ||
      normalized.indexOf('公众号 ') === 0 ||
      normalized.indexOf(' 公众号 ') >= 0) {
      return true
    }
    return false
  }

  private static isStoryArcContainerTitle(rawValue: string, cleanedTitle: string): boolean {
    const raw = `${rawValue || ''}`.trim()
    const title = `${cleanedTitle || ''}`.trim()
    if (title.length === 0) {
      return false
    }
    if (!/篇$/.test(title)) {
      return false
    }
    return /^\d{1,3}[\s._\-–—:：]*[\u4e00-\u9fa5]{1,12}篇$/.test(raw) ||
      /^(?:月红篇|王权篇|竹业篇|尾生篇|南国篇|千颜篇|沐天城篇|金晨曦篇|无暮篇)$/.test(title)
  }

  private static removeKnownExtension(fileName: string): string {
    let value = `${fileName || ''}`.trim()
    let count = 0
    while (count < 3) {
      const dotIndex = value.lastIndexOf('.')
      if (dotIndex === 0) {
        const extensionOnly = value.substring(1).toLowerCase()
        return EXTENSION_PATTERN.test(extensionOnly) ? '' : value
      }
      if (dotIndex <= 0 || dotIndex >= value.length - 2) {
        return value
      }
      const extension = value.substring(dotIndex + 1).toLowerCase()
      if (!EXTENSION_PATTERN.test(extension)) {
        return value
      }
      value = value.substring(0, dotIndex)
      count += 1
    }
    return value
  }

  /** 从非技术信息中提取发行年份；开头的数字片名不作为发行年份。 */
  private static extractYear(value: string): number {
    // 尺寸必须在年份提取前清除，1920x1080、3840x2074 都不是发行年份。
    const text = WebdavVideoReleaseTextHelper.stripTechnicalDimensions(`${value || ''}`)
    EXTRACT_YEAR_PATTERN.lastIndex = 0
    let lastYear = 0 // 关键变量：标题本身含年份时，文件名最后一个年份通常才是发行年份。
    let match = EXTRACT_YEAR_PATTERN.exec(text)
    while (match !== null) {
      const yearText = match[1]! !== undefined ? match[1]! : ''
      const yearIndex = match.index + match[0]!.indexOf(yearText)
      const prev = yearIndex > 0 ? text.substring(yearIndex - 1, yearIndex) : ''
      const nextIndex = yearIndex + yearText.length
      const next = nextIndex < text.length ? text.substring(nextIndex, nextIndex + 1) : ''
      const remainingText = text.substring(nextIndex)
      if (yearIndex === 0 && (/^\s*[:：]/.test(remainingText) ||
        /^[\s._-]+[\[（(]?(?:19|20)\d{2}\b/i.test(remainingText))) {
        EXTRACT_YEAR_PATTERN.lastIndex = nextIndex
        match = EXTRACT_YEAR_PATTERN.exec(text)
        continue
      }
      if (!/[\u4e00-\u9fa5]/.test(prev) && !/[\u4e00-\u9fa5]/.test(next)) {
        lastYear = WebdavVideoNameParser.safeParsePositiveInt(yearText)
      }
      EXTRACT_YEAR_PATTERN.lastIndex = nextIndex
      match = EXTRACT_YEAR_PATTERN.exec(text)
    }
    EXTRACT_YEAR_PATTERN.lastIndex = 0
    return lastYear
  }

  private static extractImdbId(value: string): string {
    const match = EXTRACT_IMDB_PATTERN.exec(value)
    if (match === null) {
      return ''
    }
    return match[0]!.toLowerCase()
  }

  private static extractResolution(value: string): string {
    const match = EXTRACT_RESOLUTION_PATTERN.exec(value)
    if (match === null) {
      return ''
    }
    return match[1]!.toUpperCase()
  }

  private static extractSource(value: string): string {
    const match = EXTRACT_SOURCE_PATTERN.exec(value)
    if (match === null) {
      return ''
    }
    return WebdavVideoNameParser.collapseSpaces(match[1]!).toUpperCase()
  }

  private static extractReleaseGroup(value: string): string {
    const dashIndex = value.lastIndexOf('-')
    if (dashIndex < 0 || dashIndex >= value.length - 1) {
      return ''
    }
    const group = value.substring(dashIndex + 1).trim()
    if (group.length === 0 || group.length > 32) {
      return ''
    }
    if (!RELEASE_GROUP_PATTERN.test(group)) {
      return ''
    }
    return group
  }

  private static extractSeasonFromPath(path: string): number {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return 0
    }
    const parentName = WebdavVideoNameParser.getLastPathName(WebdavVideoNameParser.getParentPath(normalizedPath))
    const match = EXTRACT_SEASON_FROM_PATH_PATTERN.exec(parentName)
    if (match === null) {
      return 0
    }
    const seasonText = match[1]! !== undefined && match[1]!.length > 0 ? match[1]! :
      (match[2]! !== undefined ? match[2]! : '')
    return WebdavVideoNameParser.parseSeasonNumberText(seasonText)
  }

  /** 解析最终季号，文件名明确声明第 0 季时禁止回落到第 1 季。 */
  private static resolveEpisodeSeasonNumber(
    currentSeasonNumber: number,
    path: string,
    hasExplicitSeasonNumber: boolean = false
  ): number {
    if (currentSeasonNumber > 0 || hasExplicitSeasonNumber) {
      return currentSeasonNumber
    }
    const pathSeasonNumber = WebdavVideoNameParser.extractSeasonFromPath(path)
    if (pathSeasonNumber > 0) {
      return pathSeasonNumber
    }
    return 1
  }

  static getParentPath(path: string): string {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return '/'
    }
    const index = normalizedPath.lastIndexOf('/')
    if (index <= 0) {
      return '/'
    }
    return normalizedPath.substring(0, index)
  }

  static getLastPathName(path: string): string {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return ''
    }
    const parts = normalizedPath.split('/')
    return parts[parts.length - 1]!
  }

  private static pickMovieTitleFromPath(path: string): string {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return ''
    }
    let cursor = WebdavVideoNameParser.getParentPath(normalizedPath)
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      if (WebdavVideoNameParser.isGenericMediaRootDirectoryName(folderName)) {
        cursor = WebdavVideoNameParser.getParentPath(cursor)
        continue
      }
      const title = WebdavVideoNameParser.cleanMovieTitle(folderName)
      if (!WebdavVideoNameParser.isGenericSeriesFolderTitle(title) &&
        !WebdavVideoNameParser.isGenericMovieFileTitle(title) &&
        !WebdavVideoNameParser.isSpecialEpisodeContainerTitle(title) &&
        !WebdavVideoNameParser.isStoryArcContainerTitle(folderName, title)) {
        return title
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return ''
  }

  /**
   * 从节目文件路径中提取节目首播年份。
   * 返回 -1 表示已经找到节目标题目录但目录没有首播年份，此时必须清空单集年份。
   */
  private static resolveSeriesYearFromPath(path: string, seriesTitle: string): number {
    let cursor = WebdavVideoNameParser.getParentPath(normalizeWebdavPath(path))
    const currentFolderName = WebdavVideoNameParser.getLastPathName(cursor)
    if (WebdavVideoNameParser.startsWithSeasonFolderName(currentFolderName)) {
      const seriesFolderName = WebdavVideoNameParser.getLastPathName(WebdavVideoNameParser.getParentPath(cursor))
      const seriesFolderYear = WebdavVideoNameParser.extractYear(seriesFolderName)
      if (seriesFolderYear > 0) {
        return seriesFolderYear
      }
    }
    const normalizedSeriesTitle = normalizeWebdavVideoSearchText(seriesTitle)
    let matchedSeasonScopedTitle = false // 关键变量：匹配到带季号目录时继续查找真正的节目根目录。
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      const folderTitle = WebdavVideoNameParser.cleanSeriesTitle(folderName)
      if (normalizeWebdavVideoSearchText(folderTitle) === normalizedSeriesTitle) {
        const isSeasonScopedFolder = WebdavVideoNameParser.extractSeasonNumberFromText(folderName) > 0 ||
          WebdavVideoNameParser.isSeasonZeroText(folderName)
        if (isSeasonScopedFolder) {
          matchedSeasonScopedTitle = true
          cursor = WebdavVideoNameParser.getParentPath(cursor)
          continue
        }
        const folderYear = WebdavVideoNameParser.extractYear(folderName)
        if (folderYear > 0) {
          return folderYear
        }
        return -1
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return matchedSeasonScopedTitle ? -1 : 0
  }

  /** 从叶子目录向上读取最近年份，遇到电影、剧集、合集等分类桶后停止。 */
  private static extractNearestPathYear(path: string): number {
    let cursor = WebdavVideoNameParser.getParentPath(normalizeWebdavPath(path))
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      if (WebdavVideoNameParser.startsWithSeasonFolderName(folderName)) {
        cursor = WebdavVideoNameParser.getParentPath(cursor)
        continue
      }
      if (WebdavVideoNameParser.isGenericMediaRootDirectoryName(folderName) ||
        WebdavVideoNameParser.isGenericSeriesFolderTitle(folderName)) {
        return 0
      }
      const folderYear = WebdavVideoNameParser.extractYear(folderName)
      if (folderYear > 0) {
        return folderYear
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return 0
  }

  /**
   * 只读取与当前电影标题相同目录上的年份。
   * 例如“完美世界 (2026)/火之灰烬 剧场版/S00E03.2024”必须保留文件年份 2024。
   */
  private static extractMatchingMovieTitleYearFromPath(path: string, movieTitle: string): number {
    const normalizedMovieTitle = normalizeWebdavVideoSearchText(movieTitle) // 关键变量：首选电影标题的比较文本。
    if (normalizedMovieTitle.length === 0) {
      return 0
    }
    let cursor = WebdavVideoNameParser.getParentPath(normalizeWebdavPath(path))
    while (cursor !== '/') {
      const folderName = WebdavVideoNameParser.getLastPathName(cursor)
      const folderTitle = WebdavVideoNameParser.cleanMovieTitle(folderName)
      if (normalizeWebdavVideoSearchText(folderTitle) === normalizedMovieTitle) {
        return WebdavVideoNameParser.extractYear(folderName)
      }
      cursor = WebdavVideoNameParser.getParentPath(cursor)
    }
    return 0
  }

  /** 判断文件名是否以 H.264、H265、x264 或 x265 等编码编号结尾。 */
  private static endsWithVideoCodecNumber(value: string): boolean {
    return /(?:^|[\s._\-])(?:h|x)[\s._\-]*26[45]\s*$/i.test(`${value || ''}`)
  }

  /** 过滤“影视资源大合集”一类扫描根目录，避免其覆盖真实电影文件名。 */
  private static isGenericMediaRootDirectoryName(value: string): boolean {
    const text = normalizeWebdavVideoSearchText(value)
    return /(?:影视|电影|影片).*资源.*(?:合集|大全)/.test(text) ||
      /资源大合集/.test(text) ||
      /(?:影视资源大|资源大)\s*\d*$/.test(text)
  }

  private static safeParsePositiveInt(value: string): number {
    const numberValue = parseInt(`${value || ''}`, 10)
    if (isNaN(numberValue) || numberValue <= 0) {
      return 0
    }
    return numberValue
  }

  private static startsWithAirDate(value: string): boolean {
    return AIR_DATE_PREFIX_PATTERN.test(`${value || ''}`)
  }

  private static containsResolutionDimension(value: string): boolean {
    return WebdavVideoNameParser.testGlobalPattern(VIDEO_DIMENSION_PATTERN, `${value || ''}`)
  }

  private static isUsableInferredEpisodeNumber(value: number): boolean {
    if (value <= 0 || value > MAX_INFERRED_EPISODE_NUMBER) {
      return false
    }
    return value < 1900 || value > 2099
  }

  /** 判断裸 E 数字是否可作为集号，年份范围不能误识别为剧集。 */
  private static isUsableEpisodeOnlyMarkerNumber(value: number): boolean {
    return value > 0 && value <= 5000 && (value < 1900 || value > 2099)
  }

  private static parseSeasonNumberText(value: string): number {
    const text = `${value || ''}`.trim()
    const numericValue = WebdavVideoNameParser.safeParsePositiveInt(text)
    if (numericValue > 0) {
      return numericValue
    }
    return WebdavVideoNameParser.parseChineseNumber(text)
  }

  private static parseChineseNumber(value: string): number {
    const text = `${value || ''}`.trim()
    if (text.length === 0) {
      return 0
    }
    const direct = WebdavVideoNameParser.chineseDigitValue(text)
    if (direct > 0) {
      return direct
    }
    const tenIndex = text.indexOf('十')
    if (tenIndex < 0) {
      return 0
    }
    const left = text.substring(0, tenIndex)
    const right = text.substring(tenIndex + 1)
    const tens = left.length === 0 ? 1 : WebdavVideoNameParser.chineseDigitValue(left)
    const ones = right.length === 0 ? 0 : WebdavVideoNameParser.chineseDigitValue(right)
    if (tens <= 0 || ones < 0) {
      return 0
    }
    return tens * 10 + ones
  }

  private static chineseDigitValue(value: string): number {
    if (value === '一') {
      return 1
    }
    if (value === '二' || value === '两') {
      return 2
    }
    if (value === '三') {
      return 3
    }
    if (value === '四') {
      return 4
    }
    if (value === '五') {
      return 5
    }
    if (value === '六') {
      return 6
    }
    if (value === '七') {
      return 7
    }
    if (value === '八') {
      return 8
    }
    if (value === '九') {
      return 9
    }
    return 0
  }

  static hasSeriesPathHint(path: string): boolean {
    const normalizedPath = normalizeWebdavPath(path)
    if (normalizedPath === '/') {
      return false
    }
    return SERIES_PATH_HINT_PATTERN.test(normalizedPath)
  }

  private static normalizeEpisodeNumbers(values: number[]): number[] {
    const out: number[] = []
    let i = 0
    while (i < values.length) {
      const value = values[i]!
      if (value > 0 && out.indexOf(value) < 0) {
        out.push(value)
      }
      i += 1
    }
    return out
  }

  private static collapseSpaces(value: string): string {
    return `${value || ''}`.replace(WHITESPACE_PATTERN, ' ').trim()
  }
}
