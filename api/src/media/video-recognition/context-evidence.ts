import path from "node:path";
import { WebdavVideoNameParser } from "../app-recognition/WebdavVideoNameParser.js";
import { compareVideoTitle } from "./title-comparison.js";

/** 编号来源和后代作品边界必须与编号数值一起保存。 */
export interface ProviderIdEvidence {
  id: number;
  layer: "file" | "directory" | "ancestor";
  ownerPath: string;
  ownerTitle: string;
  boundaryTitle: string | null;
}

/** 日期、明确季集与旧弱集号分开，避免把日期末尾误当集数。 */
export interface EpisodeEvidence {
  dates: string[];
  hasExplicitEpisode: boolean;
  explicitSeason: number | null;
  /** 不同层级的明确季号相反时，不能只取最后一个。 */
  seasonConflict?: boolean;
  legacyEpisodes: number[];
}

/** 中文季号只处理明确“第…季”语法，缺失和超出支持范围保持未知。 */
function readSeasonNumber(value: string): number | null {
  if (/^\d{1,2}$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const parts = value.split("十");
  let number: number;
  if (parts.length === 2 && parts.every((part) => part.length <= 1)) {
    number = (parts[0] ? digits[parts[0]]! : 1) * 10 + (parts[1] ? digits[parts[1]]! : 0);
  } else if (parts.length === 1 && [...value].every((character) => digits[character] !== undefined)) {
    number = Number([...value].map((character) => digits[character]).join(""));
  } else return null;
  return Number.isInteger(number) && number >= 0 && number <= 99 ? number : null;
}

/** 严格解析公历日期，排除带时分秒的转存后缀。 */
export function collectEpisodeEvidence(filePath: string, legacyEpisodes: number[]): EpisodeEvidence {
  const name = path.posix.basename(filePath).replace(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}/giu, "");
  const hasExplicitEpisode = /S\d{1,2}E\d{1,4}|\b\d{1,2}x\d{1,4}\b|第\s*[零〇一二两三四五六七八九十百\d]+\s*[集话]|\bEP?\d+/iu.test(name);
  // 季范围仅表示合集容量，不能把 S1-S10 的两端当成文件所在季。
  const seasonPath = filePath.replace(/\bS(?:eason[ ._-]*)?\d{1,2}[ ._]*[-~至][ ._]*(?:S(?:eason[ ._-]*)?)?\d{1,2}/giu, " ")
    .replace(/第\s*[零〇一二两三四五六七八九十\d]{1,3}\s*季?\s*[-~至]\s*第?\s*[零〇一二两三四五六七八九十\d]{1,3}\s*季/gu, " ");
  // 各语法独立闭合；“第 29 集”的空格不应让 29 变成季号。
  const seasonMatches = [...seasonPath.matchAll(/\bSeason[ ._-]*(\d{1,2})(?!\s*[-~至]\s*\d)(?=$|[\s/._（(\[-])|\bS(\d{1,2})(?!\s*[-~至]\s*\d)(?=E\d|$|[\s/._（(\[-])|第\s*([零〇一二两三四五六七八九十\d]{1,3})\s*季/giu)];
  const seasons = [...new Set(seasonMatches.map((match) => readSeasonNumber(match[1] ?? match[2] ?? match[3]!))
    .filter((season): season is number => season !== null))];
  const explicitSeason = seasons.length === 1 ? seasons[0]! : null;
  const dates: string[] = [];
  for (const match of name.matchAll(/(?<!\d)((?:19|20)\d{2})[._-]?(\d{2})[._-]?(\d{2})(?!\d)/gu)) {
    if (/^_\d{6}/u.test(name.slice(match.index! + match[0].length))) continue;
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    const text = date.toISOString().slice(0, 10);
    if (!dates.includes(text)) dates.push(text);
  }
  return { dates, hasExplicitEpisode, explicitSeason, seasonConflict: seasons.length > 1, legacyEpisodes: [...legacyEpisodes] };
}

/** 读取目录标题，保留书名正文；年份档案不是新节目的首播年。 */
function directoryTitle(name: string): string {
  const bookTitle = /《([^》]+)》/u.exec(name)?.[1];
  if (bookTitle) return bookTitle.trim();
  return WebdavVideoNameParser.cleanMovieDirectoryTitle(name.replace(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}/giu, ""))
    .replace(/(?:18|19|20)\d{2}\s*年\s*$/u, "").trim();
}

/** 从扫描根内最近的提供者标记追踪其后有效作品目录，不按路径里第一个数字决定归属。 */
export function collectProviderIdEvidence(rootPath: string, filePath: string): ProviderIdEvidence | null {
  const chain: Array<{ name: string; path: string }> = [];
  if (rootPath !== "/") chain.push({ name: path.posix.basename(rootPath), path: rootPath });
  let current = rootPath;
  for (const name of filePath.slice(rootPath === "/" ? 1 : rootPath.length + 1).split("/")) {
    current = path.posix.join(current, name); chain.push({ name, path: current });
  }
  let owner = -1; let id = 0;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const match = /(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{2,10})/iu.exec(chain[index]!.name);
    if (match) { owner = index; id = Number(match[1]); break; }
  }
  if (owner < 0) return null;
  const item = chain[owner]!;
  const layer = owner === chain.length - 1 ? "file" : owner === chain.length - 2 ? "directory" : "ancestor";
  const ownerTitle = directoryTitle(item.name);
  let boundaryTitle: string | null = null;
  for (const segment of chain.slice(owner + 1, -1)) {
    // 明确季／范围／年份目录不构成另一个作品，带独立作品名的年份目录则需保留边界。
    if (/^(?:Season[ ._-]*\d+|S\d+|第\s*\d+\s*季|\d{1,4}\s*[-~至]\s*\d{1,4}|(?:19|20)\d{2}年?)$/iu.test(segment.name)) continue;
    if (!/《[^》]+》|[（(](?:18|19|20)\d{2}[)）]/u.test(segment.name)) continue;
    const title = directoryTitle(segment.name);
    if (title && !WebdavVideoNameParser.isWeakScrapeTitle(title) && compareVideoTitle(title) !== compareVideoTitle(ownerTitle)) boundaryTitle = title;
  }
  return { id, layer, ownerPath: item.path, ownerTitle, boundaryTitle };
}
