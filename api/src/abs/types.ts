import type { Knex } from "knex";
import type { MediaItemRecord } from "../domain.js";

/** 分类库只负责 ABS 展示，真实媒体库、账号和进度仍使用原数据库身份。 */
export interface AbsLibraryView {
  id: string;
  name: string;
  categoryId: string | null;
  displayOrder: number;
}

/** 已验证账号及其真实库范围；可选分类视图不替代真实库 ID。 */
export interface AbsContext {
  /** 真实数据库库 ID，账号、播放、进度和来源查询都必须使用它。 */
  libraryId: string;
  /** 当前协议地址可枚举的分类库；网盘听书库仍只有原库。 */
  libraryViews?: AbsLibraryView[];
  /** 仅分类路由设置此值；未设置时代表账号在此地址下的全部书籍。 */
  viewLibraryId?: string;
  ownerUserId: string;
  libraryName: string;
  pathSuffix: string;
  accountId: string;
  username: string;
  credentialRevision: number;
  canDownload: boolean;
  basePath: string;
  relayPlaybackEnabled: boolean;
}

/** ABS 独立账号公开资料，不含密码、JWT 或刷新凭据。 */
export interface AbsAccountRecord {
  id: string;
  libraryId: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  canDownload: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 从数据库读取的 ABS 媒体库，不依赖首条网盘服务。 */
export interface AbsLibraryRow {
  id: string;
  user_id: string;
  display_name: string;
  data_type: string;
  status: string;
  abs_enabled: number | string;
  abs_path_suffix: string;
  abs_relay_playback_enabled: number | string;
  last_scan_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** 协议音轨保留内部来源文件用于取址，序号与时间轴用于对外映射。 */
export interface AbsTrack {
  index: number;
  ino: string;
  chapterId: string;
  title: string;
  startOffset: number;
  duration: number;
  mimeType: string;
  codec: string;
  contentUrl: string;
  metadata: Record<string, unknown>;
  file: Record<string, unknown>;
}

/** 一本作品的完整已排序时间轴。 */
export interface AbsBook {
  item: MediaItemRecord;
  bookId: string;
  tracks: AbsTrack[];
  chapters: Array<{ id: number; start: number; end: number; title: string }>;
  duration: number;
  authors: Array<{ id: string; name: string }>;
  narrators: string[];
  series: Array<{ id: string; name: string; sequence: string | null }>;
}

/** 可事务复用的查询实例。 */
export type AbsQuery = Knex | Knex.Transaction;

/** 严格读取有限非负秒数，保留浮点精度。 */
export function readAbsSeconds(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

/** 解析数据库里的内部 JSON，非法历史值按空对象处理。 */
export function readAbsObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return readAbsObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 解析内部数组字段，防止空历史值破坏完整协议响应。 */
export function readAbsArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return readAbsArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}
