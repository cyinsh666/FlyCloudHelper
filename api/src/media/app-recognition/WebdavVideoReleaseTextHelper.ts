/** 同步自 Flymby APP 64c528ba 的纯识别规则；仅适配模块路径和 TypeScript 类型。 */
/** 依据原始技术参数的位置清理资源信息，保留片名中的数字和续集编号。 */
export class WebdavVideoReleaseTextHelper {
  /** 查找明确技术参数的起点，不把单独的年份或普通片名词当成参数。 */
  private static findTechnicalStart(value: string, titleKey: string, extraPositions: number[]): number {
    const pattern = /\b(?:\d{3,4}[pi]|\d{3,4}\s*[xX×]\s*\d{3,4}|[48]k|web[-.\s]?(?:dl|rip)|blu[-.\s]?ray|bdrip|hdtv|dvdrip|remux|[xh][-.\s]?26[45]|hevc|avc|aac|ac3|e[-.]?ac3|ddp?|dts|truehd|flac|lpcm|pcm|av3a|atmos|mp3|\d+\s*audios?|\d+(?:\.\d+)?\s*(?:gb|mb|g|m)|(?:8|10|12)[-.\s]?bit)\b/ig
    const positions = extraPositions.slice()
    let match = pattern.exec(value)
    while (match !== null) {
      positions.push(match.index)
      match = pattern.exec(value)
    }
    let technicalStart = -1
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index]!
      if (position < 0) {
        continue
      }
      const prefixKey = value.substring(0, position).replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').toLowerCase()
      // 规格前面必须已经出现实际片名，跳过“[1080p] 沙丘 2”中的前置规格。
      if (titleKey.length > 0 && prefixKey.indexOf(titleKey) >= 0 &&
        (technicalStart < 0 || position < technicalStart)) {
        technicalStart = position
      }
    }
    return technicalStart
  }

  /** 提前移除尺寸和色深，避免尺寸变成年份、色深拆成片名数字。 */
  static stripTechnicalDimensions(value: string): string {
    return value.replace(/\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/g, ' ')
      .replace(/\b(?:8|10|12)[-.\s]?bit\b/ig, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*(?:GB|MB)\b/ig, ' ')
  }

  /** 仅移除在技术参数之后出现、且未在片名区域出现的尾部数字。 */
  static stripTrailingTechnicalNumbers(value: string, rawValue: string, extraPositions: number[] = []): string {
    const titleKey = value.replace(/(?:\s+\d{1,6})+$/, '').replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').toLowerCase()
    const technicalStart = WebdavVideoReleaseTextHelper.findTechnicalStart(rawValue, titleKey, extraPositions)
    if (technicalStart < 0) {
      return value
    }
    // 显式指定字符串数组，避免空数组分支让 ArkTS 将 indexOf 入参推断为 never。
    const titleNumbers: string[] = rawValue.substring(0, technicalStart).match(/\d+/g) || []
    const technicalNumbers: string[] = rawValue.substring(technicalStart).match(/\d+/g) || []
    let text = value.replace(/\s+/g, ' ').trim()
    let match = /^(.*\S)\s+(\d{1,6})$/.exec(text)
    while (match !== null && match[1]! !== undefined && match[2]! !== undefined) {
      const numberText = match[2]! // 片名前段出现过的数字必须保留，例如“沙丘 2”和“梅根2.0”。
      if (!/[A-Za-z\u4e00-\u9fa5]/.test(match[1]!) ||
        titleNumbers.indexOf(numberText) >= 0 || technicalNumbers.indexOf(numberText) < 0) {
        break
      }
      text = match[1]!
      match = /^(.*\S)\s+(\d{1,6})$/.exec(text)
    }
    return text
  }
}
