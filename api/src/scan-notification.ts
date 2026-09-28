import type { LibraryScanJobRecord, ScanJobRecord } from "./domain.js";
import type { ScanCreatedMediaCounts } from "./service-repository.js";

/** 创建通知统计失败时使用的空结果，保证扫描完成通知仍然能够送达。 */
export function createEmptyScanCreatedMediaCounts(): ScanCreatedMediaCounts {
  return { videoContentCount: 0, videoContents: [], songCount: 0, albumCount: 0, artistCount: 0 };
}

/** 把本次新增的影视内容转换为通知明细，最多展示仓储层返回的五条内容。 */
function buildCreatedVideoLines(createdMediaCounts: ScanCreatedMediaCounts): string[] {
  return createdMediaCounts.videoContents.map((content, index) => (
    content.itemType === "video.series"
      ? `${index + 1}. 《${content.title}》（本次新增 ${content.episodeCount ?? 0} 集）`
      : `${index + 1}. 《${content.title}》（电影）`
  ));
}

/** 当新增影视超过明细展示上限时，生成总数提示。 */
function buildRemainingVideoLine(createdMediaCounts: ScanCreatedMediaCounts): string | null {
  return createdMediaCounts.videoContentCount > createdMediaCounts.videoContents.length
    ? `……等 ${createdMediaCounts.videoContentCount} 个影片。`
    : null;
}

/** 生成单来源扫描完成通知；影视列出最多五个新入库影片，音乐保持数量摘要。 */
export function buildScanCompletionMessage(
  job: Pick<ScanJobRecord, "dataType" | "scanMode" | "serviceName">,
  createdMediaCounts: ScanCreatedMediaCounts,
): string {
  const scanModeLabel = job.scanMode === "full" ? "全量" : "增量";
  if (job.dataType === "music") {
    return `服务“${job.serviceName}”的${scanModeLabel}扫描已完成：新增入库 ${createdMediaCounts.songCount} 首歌曲、${createdMediaCounts.albumCount} 张专辑、${createdMediaCounts.artistCount} 位艺术家。`;
  }
  const remainingLine = buildRemainingVideoLine(createdMediaCounts);
  return [
    `服务“${job.serviceName}”的${scanModeLabel}扫描已完成：新增入库 ${createdMediaCounts.videoContentCount} 个影片。`,
    ...buildCreatedVideoLines(createdMediaCounts),
    ...(remainingLine ? [remainingLine] : []),
  ].join("\n");
}

/** 生成云聚合父任务完成通知，并在来源汇总后列出本次新增影视。 */
export function buildAggregateScanCompletionMessage(
  job: Pick<LibraryScanJobRecord, "scanMode" | "completedSourceCount" | "failedSourceCount" | "cancelledSourceCount" | "processedCount" | "errorCount">,
  createdMediaCounts: ScanCreatedMediaCounts,
): string {
  const scanModeLabel = job.scanMode === "full" ? "全量" : "增量";
  const remainingLine = buildRemainingVideoLine(createdMediaCounts);
  return [
    `媒体库${scanModeLabel}扫描已结束：${job.completedSourceCount} 个来源完成，${job.failedSourceCount} 个来源失败，${job.cancelledSourceCount} 个来源已取消；共处理 ${job.processedCount} 项，错误 ${job.errorCount} 项。`,
    `新增入库 ${createdMediaCounts.videoContentCount} 个影片。`,
    ...buildCreatedVideoLines(createdMediaCounts),
    ...(remainingLine ? [remainingLine] : []),
  ].join("\n");
}
