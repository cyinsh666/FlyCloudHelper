import { WEBDAV_UNKNOWN_SEASON } from "./flymby-consecutive-episode-helper.js";

/** 保留未知季标记，其余季号沿用原有非负数处理。 */
export function readVideoSeason(value: unknown): number {
  const season = Number(value ?? 0);
  return season === WEBDAV_UNKNOWN_SEASON ? season : Math.max(0, season);
}

/** 展示季名称时区分未知季与特别篇。 */
export function videoSeasonTitle(season: number): string {
  return season === WEBDAV_UNKNOWN_SEASON ? "未知季" : season === 0 ? "特别篇" : `第 ${season} 季`;
}

/** 虚拟季 UUID 的六位编码保留独立位置，不与第 0 季重合。 */
export function encodeVideoSeasonNumber(season: number): number {
  return season === WEBDAV_UNKNOWN_SEASON ? 0xffffff : Math.min(0xfffffe, Math.max(0, Math.floor(season)));
}

/** 还原虚拟季 UUID 中的未知季标记。 */
export function decodeVideoSeasonNumber(season: number): number {
  return season === 0xffffff ? WEBDAV_UNKNOWN_SEASON : season;
}
