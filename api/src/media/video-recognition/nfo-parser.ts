import { XMLParser, XMLValidator } from "fast-xml-parser";

/** 编号的提供者和对象层级同时保存，单集／集合编号不能充当系列编号。 */
export interface VideoNfoProviderIdentity {
  provider: string;
  entityKind: "movie" | "tv" | "season" | "episode" | "collection" | "unknown";
  id: string;
  sourceTag: string;
}

/** 这里只读取身份与位置字段，不消费图片、脚本、人物或描述中的同名节点。 */
export interface VideoNfoRecord {
  rootType: "movie" | "tvshow" | "season" | "episodedetails";
  title: string;
  originalTitle: string;
  showTitle: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  airDate: string | null;
  displaySeason: number | null;
  displayEpisode: number | null;
  identities: VideoNfoProviderIdentity[];
  conflicts: string[];
}

type XmlNode = Record<string, unknown>;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "",
  parseTagValue: false, trimValues: true, removeNSPrefix: true, ignoreDeclaration: true });

/** preserveOrder 保留相邻多单集根；返回只读数组，其他形状不猜测成字段。 */
function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value.filter((node): node is XmlNode => Boolean(node && typeof node === "object")) : [];
}

/** 只读取当前根的直接节点，避免演员／CDATA中的 id 被提升。 */
function children(body: XmlNode[], tag: string): XmlNode[] {
  return body.filter((node) => Object.keys(node).some((key) => key.toLowerCase() === tag));
}

/** 当前节点的文本不递归读取子节点，CDATA由XML库作为文本处理。 */
function text(node: XmlNode, tag: string): string {
  const key = Object.keys(node).find((key) => key.toLowerCase() === tag);
  return nodes(key ? node[key] : []).map((value) => typeof value["#text"] === "string" ? value["#text"] : "").join("").trim();
}

/** 单值字段重复且不同则留冲突，不靠标签顺序取最后一个。 */
function field(body: XmlNode[], tag: string, conflicts: string[]): string {
  const values = [...new Set(children(body, tag).map((node) => text(node, tag)).filter(Boolean))];
  if (values.length > 1) conflicts.push(`multiple_${tag}_values`);
  return values.length === 1 ? values[0]! : "";
}

/** 整数必须完整合法，季0有效，负值及部分数字不兜底为1。 */
function integer(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

/** 严格公历日期可用于单集核验，不能把无效日期或单集年份当系列首播年。 */
function date(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(value)) return null;
  const candidate = value.slice(0, 10);
  const parsed = new Date(candidate + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
}

/** 明确支持的纯链接仅保留作品对象，不从其他网站或附属链接提取数字。 */
function urlRecord(value: string): VideoNfoRecord | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || !["themoviedb.org", "www.themoviedb.org"].includes(url.hostname)) return null;
  const match = /^\/(movie|tv)\/(\d+)(?:-[^/]*)?\/?$/u.exec(url.pathname);
  if (!match || !integer(match[2]!, 1)) return null;
  return { rootType: match[1] === "movie" ? "movie" : "tvshow", title: "", originalTitle: "", showTitle: "", year: null,
    seasonNumber: null, episodeNumber: null, airDate: null, displaySeason: null, displayEpisode: null,
    identities: [{ provider: "tmdb", entityKind: match[1] as "movie" | "tv", id: match[2]!, sourceTag: "supported_work_url" }], conflicts: [] };
}

/** 原始XML只解析根内直接字段；支持相邻episodedetails，不把描述中的标签当新根。 */
export function parseVideoRecognitionNfo(raw: string): { records: VideoNfoRecord[]; reason: string | null } {
  const linked = urlRecord(raw);
  if (linked) return { records: [linked], reason: null };
  if (/<!DOCTYPE|<!ENTITY/iu.test(raw)) return { records: [], reason: "unsupported_nfo_dtd" };
  const wrapped = "<recognition_nfo>" + raw.replace(/^\uFEFF/u, "").replace(/<\?xml[\s\S]*?\?>/gu, "") + "</recognition_nfo>";
  if (XMLValidator.validate(wrapped) !== true) return { records: [], reason: "invalid_nfo_xml" };
  let roots: XmlNode[];
  try { roots = nodes(nodes(parser.parse(wrapped))[0]?.recognition_nfo); }
  catch { return { records: [], reason: "invalid_nfo_xml" }; }
  const records: VideoNfoRecord[] = [];
  for (const root of roots) {
    const key = Object.keys(root).find((key) => ["movie", "tvshow", "season", "episodedetails"].includes(key.toLowerCase()));
    if (!key) continue;
    const rootType = key.toLowerCase() as VideoNfoRecord["rootType"];
    const entityKind = rootType === "tvshow" ? "tv" : rootType === "episodedetails" ? "episode" : rootType;
    const body = nodes(root[key]); const conflicts: string[] = [];
    const identities: VideoNfoProviderIdentity[] = [];
    /** 编号只接受明确来源；未定来源的普通id独立保留，不参与TMDB映射。 */
    function add(providerRaw: string, value: string, sourceTag: string): void {
      const source = providerRaw.trim().toLowerCase();
      const collection = source === "tmdbset";
      const provider = collection ? "tmdb" : source || (/^tt\d+$/u.test(value) ? "imdb" : "unspecified");
      if (!value || (["tmdb", "tvdb"].includes(provider) && integer(value, 1) === null)) return;
      const id = ["tmdb", "tvdb"].includes(provider) ? String(integer(value, 1)) : value.slice(0, 300);
      identities.push({ provider, entityKind: collection ? "collection" : entityKind, id, sourceTag });
    }
    for (const tag of ["tmdbid", "tvdbid", "imdbid"]) for (const node of children(body, tag)) add(tag.slice(0, -2), text(node, tag), tag);
    for (const tag of ["uniqueid", "id"]) for (const node of children(body, tag)) {
      const attributes = node[":@"] as Record<string, unknown> | undefined;
      add(typeof attributes?.type === "string" ? attributes.type : "", text(node, tag), tag);
    }
    for (const identity of identities) {
      if (["tmdb", "tvdb", "imdb"].includes(identity.provider) && identities.some((other) => other.provider === identity.provider && other.entityKind === identity.entityKind && other.id !== identity.id)) {
        conflicts.push(`conflicting_${identity.provider}_${identity.entityKind}_ids`);
      }
    }
    const season = integer(field(body, "season", conflicts), 0);
    const seasonNumber = integer(field(body, "seasonnumber", conflicts), 0);
    if (season !== null && seasonNumber !== null && season !== seasonNumber) conflicts.push("conflicting_season_fields");
    records.push({ rootType, title: field(body, "title", conflicts), originalTitle: field(body, "originaltitle", conflicts),
      showTitle: field(body, "showtitle", conflicts), year: integer(field(body, "year", conflicts), 1888, new Date().getFullYear() + 2),
      seasonNumber: seasonNumber ?? season, episodeNumber: integer(field(body, "episode", conflicts), 1),
      airDate: date(field(body, "aired", conflicts) || field(body, "premiered", conflicts)),
      displaySeason: integer(field(body, "displayseason", conflicts), 0), displayEpisode: integer(field(body, "displayepisode", conflicts), 0),
      identities, conflicts: [...new Set(conflicts)] });
  }
  if (records.length > 1 && records.some((record) => record.rootType !== "episodedetails")) return { records: [], reason: "ambiguous_nfo_roots" };
  return { records, reason: records.length ? null : "unknown_nfo_root" };
}
