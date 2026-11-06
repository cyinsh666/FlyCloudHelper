/** 只接受带有效 BTIH 的磁力链接，避免把普通文本交给光鸭离线接口。 */
export function parseMagnetUrl(input: string): { url: string; infoHash: string } | null {
  const value = input.trim().replace(/[.!?。！？，,]+$/u, "");
  if (value.length > 4000 || !value.toLowerCase().startsWith("magnet:?")) return null;
  try {
    const parsed = new URL(value);
    const hash = parsed.searchParams.get("xt")?.match(/^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/iu)?.[1];
    if (!hash) return null;
    return { url: value, infoHash: hash.toLowerCase() };
  } catch { return null; }
}

/** 用 BTIH 标识同一磁力资源，Tracker 参数不同也只展示和提交一次。 */
export function resourceResultKey(cloudType: string, url: string): string {
  const magnet = cloudType === "magnet" ? parseMagnetUrl(url) : null;
  return magnet ? `magnet:${magnet.infoHash}` : `${cloudType}:${url}`;
}
