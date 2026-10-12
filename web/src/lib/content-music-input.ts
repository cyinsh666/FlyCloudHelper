/** 读取用户填写的网易数字 ID，避免把无效内容带入源站请求。 */
export function readContentMusicIds(value: string, label: string): string[] {
  const ids = value.trim() ? value.trim().split(/[\s,，]+/) : [];
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) throw new Error(`${label}请填写数字 ID，多个 ID 使用逗号、空格或换行分隔`);
  // 关键变量：去掉重复输入，避免同一专辑或歌单重复同步。
  return [...new Set(ids)];
}
