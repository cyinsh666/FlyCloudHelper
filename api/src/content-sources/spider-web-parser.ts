import { load } from "cheerio";
import { ApiError } from "../errors.js";
import { providerStream } from "../providers/network.js";
import { isSpiderProxyUrl } from "./spider-proxy.js";

/** 静态网页取址只读取小型页面与 JSON，完整视频不进入解析内存。 */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const MAX_PARSE_PAGES = 4;

/** 解析器只接受明确 HTTP 地址，拒绝网页脚本和播放器私有协议。 */
function httpAddress(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !isSpiderProxyUrl(url.href) ? url.href : null;
  } catch { return null; }
}

/** 已有明确媒体扩展名的目标可以交给统一流格式探测，不从网页链接猜视频。 */
function mediaAddress(value: string): boolean {
  return /\.(?:m3u8?|mp4|mkv|webm|mov|flv|m4v)$/iu.test(new URL(value).pathname);
}

/** 同域保留源账号头，解析器跨域访问时不泄露原站 Cookie 与认证头。 */
function forwardedHeaders(headers: Record<string, string>, previous: string, next: string): Record<string, string> {
  if (new URL(previous).origin === new URL(next).origin) return { ...headers };
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !["cookie", "authorization", "proxy-authorization"].includes(name.toLowerCase())));
}

/** 从播放器的明确数据对象读取媒体字段，最大深度限制无关嵌套内容。 */
function jsonMediaAddress(value: unknown, base: string, depth = 0): string | null {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  for (const key of ["url", "src", "play_url", "playUrl"]) {
    const raw = item[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    let decoded = raw.trim();
    try {
      if (String(item.encrypt) === "1") decoded = decodeURIComponent(decoded);
      else if (String(item.encrypt) === "2") decoded = decodeURIComponent(Buffer.from(decoded, "base64").toString("utf8"));
    } catch { continue; }
    const address = httpAddress(decoded, base);
    if (address) return address;
  }
  for (const key of ["data", "player", "video"]) {
    const address = jsonMediaAddress(item[key], base, depth + 1);
    if (address) return address;
  }
  return null;
}

/** 只截取赋值中的完整 JSON 对象，不 eval 网页代码，也不读取后续脚本。 */
function assignedPlayerJson(script: string): unknown[] {
  const values: unknown[] = [];
  const assignments = script.matchAll(/\b(?:player_[A-Za-z0-9_]+|player_data|player)\s*=\s*(?=\{)/gu);
  for (const match of assignments) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < script.length && index - start <= MAX_PARSE_BYTES; index += 1) {
      const character = script[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try { values.push(JSON.parse(script.slice(start, index + 1))); } catch { /* 对象含可执行表达式时交还源脚本处理。 */ }
        break;
      }
    }
  }
  return values;
}

/** 优先读取标准视频标签及播放器数据，iframe 只作为有限下一层页面。 */
function nextPageAddress(body: string, base: string): string | null {
  try {
    const address = jsonMediaAddress(JSON.parse(body), base);
    if (address) return address;
  } catch { /* 普通 HTML 继续读取实际 DOM。 */ }
  const document = load(body);
  const baseHref = document("base[href]").first().attr("href");
  const documentBase = baseHref ? httpAddress(baseHref, base) ?? base : base;
  for (const selector of ["video[src]", "video source[src]", "meta[property='og:video:url']", "meta[property='og:video']", "meta[property='og:video:secure_url']"]) {
    const element = document(selector).first();
    const address = httpAddress(element.attr("src") ?? element.attr("content") ?? "", documentBase);
    if (address && address !== documentBase) return address;
  }
  for (const script of document("script").toArray()) {
    for (const value of assignedPlayerJson(document(script).html() ?? "")) {
      const address = jsonMediaAddress(value, documentBase);
      if (address) return address;
    }
  }
  const frame = document("iframe[src]").first().attr("src");
  return frame ? httpAddress(frame, documentBase) : null;
}

/** 有界读取清单和播放器页面，取消或超大正文立即断开上游。 */
async function readParseBody(body: NodeJS.ReadableStream & { destroy(error?: Error): unknown }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of body) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > MAX_PARSE_BYTES) {
      body.destroy();
      throw new ApiError(502, "content_source_parse_too_large", "内容源解析页面超过大小限制");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, "");
}

/** 对 parse=1 的常见静态页面共用取址流程，浏览器嗅探或 DRM 明确留给专用源能力。 */
export async function resolveSpiderWebPlayback(
  input: string,
  parserPrefix: string,
  sourceHeaders: Record<string, string>,
  allowInsecureHttp: boolean,
  signal?: AbortSignal,
): Promise<{ url: string; headers: Record<string, string> }> {
  const initial = httpAddress(parserPrefix ? `${parserPrefix}${input}` : input);
  if (!initial) throw new ApiError(422, "content_source_parse_unsupported", "此线路未提供可解析的 HTTP 播放地址");
  const visited = new Set<string>();
  let address = initial;
  let headers = { ...sourceHeaders };
  if (parserPrefix) {
    const inputAddress = httpAddress(input);
    // 关键变量：外部解析入口不能继承另一来源的账号 Cookie；无来源时也不猜认证范围。
    headers = inputAddress ? forwardedHeaders(headers, inputAddress, initial)
      : Object.fromEntries(Object.entries(headers).filter(([name]) => !["cookie", "authorization", "proxy-authorization"].includes(name.toLowerCase())));
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 20_000);
  try {
    for (let page = 0; page < MAX_PARSE_PAGES; page += 1) {
      controller.signal.throwIfAborted();
      if (visited.has(address)) break;
      visited.add(address);
      if (mediaAddress(address)) return { url: address, headers };
      const response = await providerStream(address, { method: "GET", headers: { ...headers, "Accept-Encoding": "identity" } }, { allowInsecureHttp }, controller.signal);
      const finalAddress = response.finalUrl.href;
      headers = forwardedHeaders(headers, address, finalAddress);
      const contentType = String(response.headers["content-type"] ?? "");
      if (/^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/iu.test(contentType)) {
        response.body.destroy();
        return { url: finalAddress, headers };
      }
      const body = await readParseBody(response.body);
      if (body.trimStart().startsWith("#EXTM3U")) return { url: finalAddress, headers };
      const next = nextPageAddress(body, finalAddress);
      if (!next) break;
      headers = forwardedHeaders(headers, finalAddress, next);
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "referer")) headers.Referer = finalAddress;
      address = next;
    }
    throw new ApiError(422, "content_source_parse_unsupported", "此线路需要网页脚本或专用解析，静态页面未提供媒体地址");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
