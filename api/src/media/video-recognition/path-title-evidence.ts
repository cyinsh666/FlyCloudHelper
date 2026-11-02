import path from "node:path";
import { collectEpisodeEvidence } from "./context-evidence.js";
import { collectFileTitleStructure } from "./file-title-evidence.js";
import { compareVideoTitle } from "./title-comparison.js";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import { WebdavMediaPathEvidence } from "../app-recognition/WebdavMediaPathEvidence.js";

/** 季目录的年份和副标题必须保留角色，不直接替换系列首播年或规范季。 */
export interface VideoSeasonContextEvidence {
  years: Array<{ year: number; sourcePath: string; seasonNumber: number }>;
  labels: Array<{ title: string; sourcePath: string; seasonNumber: number }>;
}

/** 清理完整的规格／容量／集数备注，只产生备用词，不修改原始路径。 */
function directoryBody(raw: string): string {
  const metadata = /^(?:(?:全|共)?[零〇一二两三四五六七八九十百\d]+(?:季|集|部)|[248]K|\d{3,4}[pi]|\d+(?:\.\d+)?\s*(?:G|GB|TB)|国语|粤语|中字|内嵌中字|简繁字幕|日漫|国漫|美剧|日剧|韩剧|英剧|完结|全集|更新中)(?:[\s,，、+]+(?:(?:全|共)?[零〇一二两三四五六七八九十百\d]+(?:季|集|部)|[248]K|\d{3,4}[pi]|\d+(?:\.\d+)?\s*(?:G|GB|TB)|国语|粤语|中字|内嵌中字|日漫|国漫|完结|全集))*$/iu;
  return raw.replace(/[（(【\[]([^（）()【】\[\]]*)[）)】\]]/gu, (whole, body: string) => metadata.test(body.trim()) ? " " : whole)
    .replace(/^(?:中|美|英|日|韩|法|德|澳)(?:纪录片|电视剧|动漫|电影|综艺|剧)[ ._-]+/u, "")
    .replace(/(?:^|[ ._-])(?:HD)?\d{3,4}[pi](?:[ ._-].*)?$/iu, "")
    .replace(/[ ._-]+(?:内嵌中字|内嵌双字|官方中字|中日双字|简繁字幕|日漫|国漫|全集|完结)\s*$/u, "")
    .trim();
}

/** 严格双语分隔才拆成两个完整候选，混合拼音紧贴汉字时不截短词。 */
function bilingualTitles(value: string): string[] {
  const match = /^(.*\p{Script=Han}[0-9]*)[ ._-]+([\p{Script=Latin}\p{Script=Hangul}][\p{Script=Latin}\p{Script=Hangul}0-9 ._'’:&+-]*)$/u.exec(value);
  return match && match[2]!.replace(/[\s\p{P}]/gu, "").length >= 3 ? [match[1]!, match[2]!] : [];
}

/** 最近作品层与透明季／范围节点分开；遇另一个命名作品不继续向远祖先找词。 */
export function collectPathTitleEvidence(root: string, directory: string, filePath: string) {
  const context: VideoSeasonContextEvidence = { years: [], labels: [] };
  const titles: Array<{ title: string; sourcePath: string }> = [];
  const explicit = collectEpisodeEvidence(filePath, []).explicitSeason;
  let cursor = directory;
  while (cursor !== root && cursor !== "/") {
    const raw = path.posix.basename(cursor);
    const month = /^((?:19|20)\d{2})\.(?:0?[1-9]|1[0-2])(?=[ ._-])/u.exec(raw);
    const body = directoryBody(month ? raw.slice(month[0].length).trim() : raw);
    if (/^\d{1,4}\s*[-~至]\s*\d{1,4}$/u.test(body)) {
      cursor = path.posix.dirname(cursor);
      continue;
    }
    const rangeEnd = /\d{1,2}\s*[-~至]\s*(\d{1,2})\s*季|\bS\d{1,2}\s*[-~至]\s*S?(\d{1,2})\b/iu.exec(body);
    const withoutRanges = body.replace(/(?:全\s*)?[零〇一二两三四五六七八九十\d]+\s*[-~至]\s*[零〇一二两三四五六七八九十\d]+\s*季/gu, " ")
      .replace(/\bS\d{1,2}\s*[-~至]\s*S?\d{1,2}\b/giu, " ");
    const season = /第\s*[零〇一二两三四五六七八九十\d]+\s*季|(?:^|[ ._-])(?:S\d{1,2}|Season[ ._-]*\d{1,2})(?=$|[ ._（(\[-])/iu.exec(withoutRanges);
    const year = collectFileTitleStructure(body + ".mkv").independentYear ?? (month ? Number(month[1]) : null);
    if (explicit !== null && (season || withoutRanges !== body) && year) context.years.push({ year, sourcePath: cursor,
      seasonNumber: rangeEnd ? Number(rangeEnd[1] ?? rangeEnd[2]) : explicit });
    let name = withoutRanges;
    if (season) {
      const after = directoryBody(withoutRanges.slice(season.index + season[0].length)).replace(/^[ ._（(\[]+|[ ._）)\]]+$/gu, "").trim();
      const caption = after.replace(/(?:^|[ ._-])(?:19|20)\d{2}(?:[ ._-].*)?$/u, "").trim();
      if (caption && !/^(?:[零〇一二两三四五六七八九十\d]+|全|全集|完结|更新中)$/u.test(caption)
        && !/^(?:[248]K|\d{3,4}[pi]|WEB|BluRay|REMUX)/iu.test(caption) && explicit !== null) {
        context.labels.push({ title: caption, sourcePath: cursor, seasonNumber: explicit });
      }
      name = withoutRanges.slice(0, season.index).trim();
    }
    const clean = WebdavVideoNameParser.cleanSeriesDirectoryTitle(name);
    /** 新词须与旧清理路径不同且不是无信息规格；不覆盖已成功的原标题。 */
    function add(value: string): void {
      const title = value.trim();
      if (title && !WebdavVideoNameParser.isWeakScrapeTitle(title)
        && !titles.some((previous) => compareVideoTitle(previous.title) === compareVideoTitle(title))) titles.push({ title, sourcePath: cursor });
    }
    if (clean && !WebdavMediaPathEvidence.isMixedMediaBucketDirectory(cursor)
      && !WebdavMediaPathEvidence.isCollectionContainerDirectory(name)) {
      add(clean);
      for (const title of bilingualTitles(clean)) add(title);
      // 紧贴汉字的四位数字属于原文，不把它作为独立发行年从标题中抹掉。
      if (/\p{Script=Han}(?:18|19|20)\d{2}$/u.test(name.trim())) add(name.trim());
    }
    if (name.replace(/[ ._-]/gu, "")) break;
    cursor = path.posix.dirname(cursor);
  }
  return { titles, context };
}
