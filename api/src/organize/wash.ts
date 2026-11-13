import path from "node:path";
import { ApiError } from "../errors.js";
import { parseFlymbyVideoName } from "../media/flymby-video-parser.js";
import type { ProviderBrowseEntry } from "../providers/types.js";
import type { OrganizeDirectory, OrganizePlan, OrganizePlanItem, WashExistingFile, WashIdentity, WashPriority } from "./types.js";

const priorities: WashPriority[] = ["dv", "hdr", "bitrate", "frame_rate", "resolution", "data_saving"];
const labels: Record<WashPriority, string> = { dv: "DV", hdr: "HDR", bitrate: "高码率", frame_rate: "高帧率",
  resolution: "高分辨率", data_saving: "省流" };
const videoExtension = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|mpg|mpeg|rmvb|webm|3gp|iso)$/iu;

export type WashBrowse = (directory: OrganizeDirectory) => Promise<ProviderBrowseEntry[]>;
interface Features { dv: number; hdr: number; bitrate: number | null; frameRate: number | null;
  resolution: number | null; highBitrate: number; highFrameRate: number; dataSaving: number;
  resolutionSpecified: boolean; bitrateSpecified: boolean; frameRateSpecified: boolean; colorSpecified: boolean }
interface Candidate { name: string; displayPath: string; source?: OrganizePlanItem; existing?: WashExistingFile }

/** 前后端只接受有限优先项，旧配置默认关闭且默认优先高分辨率。 */
export function readWashOptions(input: { washEnabled?: unknown; washPriorities?: unknown }):
  { washEnabled: boolean; washPriorities: WashPriority[] } {
  if (input.washEnabled !== undefined && typeof input.washEnabled !== "boolean") throw new ApiError(422, "organize_wash_invalid", "洗版开关无效");
  const selected = input.washPriorities ?? ["resolution"];
  if (!Array.isArray(selected) || selected.length > priorities.length
    || selected.some((item) => !priorities.includes(item)) || new Set(selected).size !== selected.length
    || input.washEnabled && !selected.length) throw new ApiError(422, "organize_wash_invalid", "请选择不重复的洗版优先级");
  return { washEnabled: input.washEnabled === true, washPriorities: [...selected] as WashPriority[] };
}

/** 一部电影或一集节目只有一个身份，规格、分类名称及扩展名不进入身份键。 */
export function washIdentity(mediaType: "movie" | "tv", tmdbId: number, season: number, episode: number): WashIdentity {
  return { key: `${mediaType}:${tmdbId}:${mediaType === "tv" ? `${season}:${episode}` : "movie"}`,
    mediaType, tmdbId, season: mediaType === "tv" ? season : 0, episode: mediaType === "tv" ? episode : 0 };
}

/** 同一字段出现多个互相冲突的数值时视为未知，不按出现顺序选一个。 */
function uniqueNumber(values: number[]): number | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0]! : null;
}

/** 只读明确的命名证据；不把文件大小当码率，不根据编码猜省流。 */
function nameFeatures(text: string): Features {
  const resolutions = [...text.matchAll(/\b(4320|2160|1440|1080|720|576|480)[pi](?=\b|\d{2,3}\b)|\b([48])k\b/giu)]
    .map((match) => match[1] ? Number(match[1]) : Number(match[2]) === 8 ? 4320 : 2160);
  const bitrates = [...text.matchAll(/(?:^|[^\w])(\d+(?:\.\d+)?)\s*(mbps|kbps|mb\/s|kb\/s|m(?:bit|b)ps|k(?:bit|b)ps)(?=$|[^a-z])/giu)]
    .map((match) => Number(match[1]) * (/^m/iu.test(match[2]!) ? 1000 : 1)).filter((value) => value > 0);
  const frameRates = [...text.matchAll(/\b(\d{2,3}(?:\.\d+)?)\s*fps\b|(\d{2,3}(?:\.\d+)?)\s*帧|\b(?:2160|1080|720)p(\d{2,3})\b/giu)]
    .map((match) => Number(match[1] ?? match[2] ?? match[3])).filter((value) => value > 0 && value <= 240);
  return {
    dv: /(?:^|[^a-z0-9])(?:dv|dovi|dolby[ ._-]*vision)(?=$|[^a-z0-9])|杜比视界/iu.test(text) ? 1 : 0,
    hdr: /(?:^|[^a-z0-9])hdr(?:10\+?)?(?=$|[^a-z0-9])/iu.test(text) ? 1 : 0,
    bitrate: uniqueNumber(bitrates), frameRate: uniqueNumber(frameRates), resolution: uniqueNumber(resolutions),
    highBitrate: /高码率|高码版|(?:^|[ ._-])高码(?:$|[ ._-])/u.test(text) ? 1 : 0,
    highFrameRate: /高帧率|高帧版|\bhfr\b/iu.test(text) ? 1 : 0,
    dataSaving: /省流|小体积/iu.test(text) ? 1 : 0,
    resolutionSpecified: resolutions.length > 0, bitrateSpecified: bitrates.length > 0,
    frameRateSpecified: frameRates.length > 0,
    colorSpecified: /\b(?:dv|dovi|hdr(?:10\+?)?|sdr)\b|dolby[ ._-]*vision|杜比视界/iu.test(text),
  };
}

/** 文件名证据优先；字段缺失时只参考最近一级目录，不读取更远的宣传目录。 */
function features(candidate: Candidate): Features {
  const direct = nameFeatures(path.posix.parse(candidate.name).name);
  const parent = nameFeatures(path.posix.basename(path.posix.dirname(candidate.displayPath)));
  return { ...direct, dv: direct.colorSpecified ? direct.dv : parent.dv, hdr: direct.colorSpecified ? direct.hdr : parent.hdr,
    bitrate: direct.bitrateSpecified ? direct.bitrate : parent.bitrate, frameRate: direct.frameRateSpecified ? direct.frameRate : parent.frameRate,
    resolution: direct.resolutionSpecified ? direct.resolution : parent.resolution,
    highBitrate: direct.highBitrate || parent.highBitrate, highFrameRate: direct.highFrameRate || parent.highFrameRate,
    dataSaving: direct.dataSaving || parent.dataSaving };
}

/** 洗版结果保留用于比较的名称标签，避免下次整理丢失码率、帧率或 DV 依据。 */
export function washNameTags(name: string, displayPath: string, ordinaryTags: string[]): string[] {
  const value = features({ name, displayPath });
  // 这些标签由直接名称证据重新写入，其余来源、编码、音轨标签沿用原命名格式。
  const tags = ordinaryTags.filter((tag) => !/^(?:\d{3,4}p|[48]k|dv|hdr(?:10\+?)?)$/iu.test(tag));
  if (value.resolution !== null) {
    const original = ordinaryTags.find((tag) => nameFeatures(tag).resolution === value.resolution);
    tags.unshift(original ?? `${value.resolution}P`);
  }
  if (value.dv) tags.push("DV");
  if (value.hdr) tags.push(ordinaryTags.find((tag) => /^hdr(?:10\+?)?$/iu.test(tag)) ?? "HDR");
  if (value.bitrate !== null) tags.push(`${value.bitrate}kbps`);
  else if (value.highBitrate) tags.push("高码率");
  if (value.frameRate !== null) tags.push(`${value.frameRate}fps`);
  else if (value.highFrameRate) tags.push("高帧率");
  if (value.dataSaving) tags.push("省流");
  return [...new Set(tags)];
}

/** 按用户顺序逐项比较；无法判断或同档一律返回平局，调用方保留先前视频。 */
function compare(candidate: Candidate, previous: Candidate, selected: WashPriority[]): { value: number; reason: string } {
  const leftSize = candidate.source?.size ?? candidate.existing?.size ?? 0;
  const rightSize = previous.source?.size ?? previous.existing?.size ?? 0;
  if (leftSize > 0 && rightSize === 0) return { value: 1, reason: "保留非零字节版本" };
  if (rightSize > 0 && leftSize === 0) return { value: -1, reason: "保留非零字节版本" };
  const left = features(candidate); const right = features(previous);
  for (const priority of selected) {
    let value = 0;
    if (priority === "dv" || priority === "hdr") value = left[priority] - right[priority];
    if (priority === "resolution" && left.resolution !== null && right.resolution !== null) value = left.resolution - right.resolution;
    if (priority === "bitrate") value = left.bitrate !== null && right.bitrate !== null
      ? left.bitrate - right.bitrate : left.highBitrate - right.highBitrate;
    if (priority === "frame_rate") value = left.frameRate !== null && right.frameRate !== null
      ? left.frameRate - right.frameRate : left.highFrameRate - right.highFrameRate;
    if (priority === "data_saving") value = left.dataSaving - right.dataSaving
      || (left.bitrate !== null && right.bitrate !== null ? right.bitrate - left.bitrate : 0);
    if (value !== 0) return { value, reason: `${labels[priority]}优先` };
  }
  return { value: 0, reason: "同档或命名信息不足，保留上一个视频" };
}

/** 只读取本次涉及作品的目标目录；同 TMDB ID 的旧目录名也参与比较。 */
export async function readWashTargets(plan: OrganizePlan, browse: WashBrowse): Promise<Map<string, WashExistingFile[]>> {
  const groups = new Map((plan.washGroups ?? []).map((identity) => [identity.key, identity]));
  const works = new Map((plan.washGroups ?? []).map((identity) => [`${identity.mediaType}:${identity.tmdbId}`, identity]));
  const result = new Map<string, WashExistingFile[]>();
  if (!groups.size) return result;
  const categories = (await browse(plan.targetDirectory)).filter((entry) => entry.isDirectory
    && ["电影", "剧集", "动漫", "综艺"].includes(entry.name));
  let count = 0;
  for (const category of categories) {
    const mediaType = category.name === "电影" ? "movie" : "tv";
    for (const work of (await browse(category)).filter((entry) => entry.isDirectory)) {
      const ids = [...work.name.matchAll(/(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{1,10})/giu)].map((match) => Number(match[1]));
      const id = uniqueNumber(ids);
      if (id === null || !works.has(`${mediaType}:${id}`)) continue;
      const queue: OrganizeDirectory[] = [work];
      while (queue.length) {
        if (++count > 2000) throw new Error("本次洗版涉及的目标目录超过 2000 个，请缩小整理范围");
        const parent = queue.shift()!;
        for (const entry of await browse(parent)) {
          if (entry.isDirectory) { queue.push(entry); continue; }
          if (!videoExtension.test(entry.name) || /(?:^|[ ._-])(?:sample|trailer|预告片|花絮|样片)(?:$|[ ._-])/iu.test(entry.name)) continue;
          const parsed = parseFlymbyVideoName({ ...entry, path: entry.displayPath }, "/");
          if (parsed.tmdbId > 0 && parsed.tmdbId !== id) continue;
          if (mediaType === "tv" && (parsed.seasonNumber < 0 || parsed.episodeNumber <= 0 || parsed.episodeNumbers.length > 1)) continue;
          const identity = washIdentity(mediaType, id, parsed.seasonNumber, parsed.episodeNumber);
          if (!groups.has(identity.key)) continue;
          const items = result.get(identity.key) ?? [];
          items.push({ resourceId: entry.resourceId, parent: { resourceId: parent.resourceId, displayPath: parent.displayPath },
            displayPath: entry.displayPath, name: entry.name, size: entry.size, modifiedAt: entry.modifiedAt });
          result.set(identity.key, items);
        }
      }
    }
  }
  return result;
}

/** 本次来源与目标已有版本统一选优；清理项放在普通整理之后，来源落选项保持原位。 */
export async function prepareWashPlan(plan: OrganizePlan, browse: WashBrowse): Promise<void> {
  if (!plan.washEnabled) return;
  const sourceGroups = new Map<string, OrganizePlanItem[]>();
  for (const item of plan.items) {
    if (item.status !== "ready" || item.action === "unrecognized" || !item.washIdentity) continue;
    if (item.size === 0) { item.status = "skipped"; item.reason = "洗版跳过零字节来源文件，保留原位"; continue; }
    const group = sourceGroups.get(item.washIdentity.key) ?? [];
    group.push(item); sourceGroups.set(item.washIdentity.key, group);
  }
  plan.washGroups = [...sourceGroups.values()].map((group) => group[0]!.washIdentity!);
  const targets = await readWashTargets(plan, browse);
  const summary = { keepExisting: 0, selectNew: 0, cleanup: 0, skippedSources: 0 };
  for (const [key, sources] of sourceGroups) {
    const previous = (targets.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })
      || a.resourceId.localeCompare(b.resourceId));
    const orderedSources = [...sources].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "zh-CN", { numeric: true })
      || a.sourceId.localeCompare(b.sourceId));
    const candidates: Candidate[] = [
      ...previous.map((existing) => ({ name: existing.name, displayPath: existing.displayPath, existing })),
      ...orderedSources.map((source) => ({ name: source.sourceName, displayPath: source.sourcePath, source })),
    ];
    let winner = candidates[0]!;
    let reason = previous.length ? "同档或命名信息不足，保留已有版本" : "按固定顺序保留首个版本";
    for (const candidate of candidates.slice(1)) {
      const compared = compare(candidate, winner, plan.washPriorities ?? ["resolution"]);
      if (compared.value > 0) { winner = candidate; reason = compared.reason; }
    }
    if (winner.existing) summary.keepExisting += 1; else summary.selectNew += 1;
    for (const item of sources) {
      item.washReason = reason;
      item.washWinnerSourceId = winner.source?.sourceId;
      item.washExistingWinner = winner.existing;
      if (item === winner.source) continue;
      item.status = "skipped";
      item.reason = `洗版重复版本跳过：${reason}；来源文件保留`;
      summary.skippedSources += 1;
    }
    for (const old of previous.filter((entry) => entry.resourceId !== winner.existing?.resourceId)) {
      plan.items.push({ sourceId: old.resourceId, parentId: old.parent.resourceId, sourcePath: old.displayPath,
        sourceName: old.name, size: old.size, modifiedAt: old.modifiedAt, targetParts: [],
        targetName: winner.existing?.displayPath ?? path.posix.join(plan.targetDirectory.displayPath,
          ...winner.source!.targetParts, winner.source!.targetName), category: sources[0]!.category,
        tmdbId: sources[0]!.tmdbId, willOverwrite: false, status: "ready", reason: null,
        action: "wash_cleanup", washIdentity: sources[0]!.washIdentity, washReason: reason,
        washWinnerSourceId: winner.source?.sourceId, washExistingWinner: winner.existing });
      summary.cleanup += 1;
    }
  }
  plan.washSummary = summary;
}
