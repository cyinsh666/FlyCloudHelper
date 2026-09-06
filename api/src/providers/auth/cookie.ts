/** 从响应中提取 Set-Cookie 首段，并合并到仅存于授权短会话的 Cookie 容器。 */
export function absorbResponseCookies(response: Response, cookies: Record<string, string>): void {
  const cookieHeaders = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
  for (const rawCookie of cookieHeaders) {
    const pair = rawCookie.split(";", 1)[0] ?? "";
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name && value) cookies[name] = value;
  }
}

/** 按名称稳定生成 Cookie 请求头。 */
export function createCookieHeader(cookies: Record<string, string>): string {
  return Object.keys(cookies).sort().map((name) => `${name}=${cookies[name]}`).join("; ");
}
