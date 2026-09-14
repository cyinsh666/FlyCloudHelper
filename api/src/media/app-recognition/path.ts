/** 识别阶段只消费已经枚举的目录身份，不产生网络请求。 */
export interface WebdavBrowseItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** 与 APP 相同的路径处理，供名称和目录证据识别复用。 */
export function normalizeWebdavPath(path?: string): string {
  if (!path) {
    return '/'
  }

  let finalPath = path.trim()
  if (!finalPath.startsWith('/')) {
    finalPath = '/' + finalPath
  }
  while (finalPath.indexOf('//') >= 0) {
    finalPath = finalPath.replace('//', '/')
  }
  while (finalPath.length > 1 && finalPath.endsWith('/')) {
    finalPath = finalPath.substring(0, finalPath.length - 1)
  }
  return finalPath ? finalPath : '/'
}
