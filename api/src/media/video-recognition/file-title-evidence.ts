/** 原文件中独立年份与技术尾缀的边界证据，不改变真实文件名和路径。 */
export interface FileTitleStructureEvidence {
  titles: string[];
  independentYear: number | null;
  parsedYearInTechnicalTail: boolean;
}

/** 识别名称中的有限 HTML 展示实体，仅用于新增候选，不用于资源定位。 */
function decodeDisplayText(value: string): string {
  return value.replace(/&#0*39;|&apos;/giu, "'").replace(/&quot;/giu, '"').replace(/&amp;/giu, "&");
}

/** 先隔离发行信息，再拆分中英文双标题，保留正文中的数字和数学符号。 */
export function collectFileTitleStructure(name: string, parsedYear: number | null = null): FileTitleStructureEvidence {
  const rawStem = decodeDisplayText(name.replace(/\.[^.]+$/u, ""));
  const leadingYear = /^[【\[(（]\s*((?:19|20)\d{2})(?:电影)?\s*[】\])）]\s*/u.exec(rawStem);
  // 只有和独立年份证据相符的开头年份标签才剥离；括号里的数字片名仍保留。
  const hasLeadingYear = Boolean(leadingYear && Number(leadingYear[1]) === parsedYear);
  const stem = (hasLeadingYear ? rawStem.slice(leadingYear![0].length) : rawStem)
    .replace(/(?<=[\p{Script=Han}])[\p{Extended_Pictographic}\uFE0F\u200D]+(?=[\p{Script=Han}])/gu, "");
  const masked = stem.replace(/[\[({【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d+\s*[\])}】）]?/giu,
    (value) => " ".repeat(value.length));
  const years = [...masked.matchAll(/(^|[\s._()\[\]{}（）【】-])((?:18|19|20)\d{2})(?=$|[\s._()\[\]{}（）【】-])/gu)]
    .map((match) => ({ year: Number(match[2]), index: match.index! + match[1]!.length }))
    .filter((match) => match.year >= 1888 && match.year <= new Date().getFullYear() + 2
      && /[\p{L}\p{N}]/u.test(masked.slice(0, match.index)));
  const technical = /(?:^|[\s._-])(?:\d{3,5}[xX×]\d{3,5}|\d{3,4}[pi]|[248]k|\d{2,3}fps|UHD|BluRay|BDrip|LDRip|REMUX|WEB-DL|HEVC|AVC|[hx][ .]?26[45])(?=$|[\s._-])/giu;
  const markers = [...masked.matchAll(technical)].map((match) => match.index);
  const firstTechnical = markers[0];
  const beforeTechnical = years.filter((match) => firstTechnical === undefined || match.index < firstTechnical);
  const independent = beforeTechnical.find((match) => match.year === parsedYear) ?? beforeTechnical[0] ?? years[0];
  const parsedOccurrences = years.filter((match) => match.year === parsedYear);
  const parsedYearInTechnicalTail = firstTechnical !== undefined && parsedOccurrences.length > 0
    && parsedOccurrences.every((match) => match.index > firstTechnical) && Boolean(independent && independent.index < firstTechnical);
  const episode = /S\d{1,2}E\d{1,4}(?:\b|[集话])/iu.exec(masked);
  const boundaries = [independent?.index, episode?.index,
    episode || markers.length >= 2 || hasLeadingYear ? firstTechnical : undefined].filter((index): index is number => index !== undefined);
  const boundary = boundaries.length ? Math.min(...boundaries) : undefined;
  const titles: string[] = [];
  /** 保留原始正文，去掉因切分留下的空括号和分隔符。 */
  function add(value: string): void {
    const title = value.replace(/[._]+/gu, " ").replace(/\s+/gu, " ")
      .replace(/^[\s()[\]（）-]+|[\s()[\]（）-]+$/gu, "").trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  if (boundary !== undefined) {
    const prefix = stem.slice(0, boundary).trim();
    const bilingual = /^(.*[\p{Script=Han}][0-9]*)(?:[-._ ]*)([\p{Script=Latin}\p{Script=Hangul}][\p{Script=Latin}\p{Script=Hangul}\p{Nl}0-9 ._'’:&+-]*)$/u.exec(prefix);
    if (bilingual && bilingual[2]!.replace(/[\s\p{P}]/gu, "").length >= 3) { add(bilingual[1]!); add(bilingual[2]!); }
    add(prefix);
    // 只在明确季集标记前识别有边界的格式标签，不替换作品正文中的一般词语。
    if (episode && /\s动态漫画$/u.test(prefix)) add(prefix.replace(/动态漫画$/u, "动态漫"));
    const seriesSubtitle = /系列\s*[：:]\s*(.+)$/u.exec(prefix);
    if (seriesSubtitle) add(seriesSubtitle[1]!);
  }
  return { titles, independentYear: independent?.year ?? (hasLeadingYear ? Number(leadingYear![1]) : null), parsedYearInTechnicalTail };
}

/** 有明确书名和解说角色的文件不作为正片绑定，避免把解说分段认成电视剧单集。 */
export function isExplicitCommentaryFile(name: string): boolean {
  return /[》】]\s*(?:剧情|电影|影视|电视剧)?解说(?:\s|P\d|[._-])/iu.test(name);
}
