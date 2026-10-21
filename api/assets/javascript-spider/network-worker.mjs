import { parentPort } from "node:worker_threads";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 拒绝本地和保留地址，网络请求不会把插件变成访问宿主内网的入口。 */
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return publicAddress(value.slice(7));
  return isIP(value) === 6 && value !== "::" && value !== "::1" && !/^(?:f[cd]|fe[89ab]|ff)/u.test(value);
}

/** 检查协议并固定本次 DNS 结果，重定向重新检查目标地址。 */
async function resolveTarget(value, allowInsecureHttp) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) throw new Error("javascript_source_network_protocol");
  if (url.username || url.password) throw new Error("javascript_source_network_credentials");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!records.length || records.some((record) => !publicAddress(record.address))) throw new Error("javascript_source_network_address");
  return { url, record: records.find((record) => record.family === 4) ?? records[0] };
}

/** 请求体采用源显式声明的字符串、JSON、表单或字节，不执行网络返回内容。 */
function requestBody(options, headers) {
  const body = options.body ?? options.data;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body !== "object") return Buffer.from(String(body));
  if (options.postType === "json" || Object.entries(headers).some(([name, value]) => name.toLowerCase() === "content-type" && String(value).includes("json"))) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    return Buffer.from(JSON.stringify(body));
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return Buffer.from(new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString());
}

/** HTTP 状态和 Set-Cookie 原样返回，源可自行处理登录失效或限流。 */
async function sendRequest(value, options, allowInsecureHttp) {
  const requestedTimeout = Number(options.timeout ?? 15000);
  const timeoutMs = Math.max(100, Math.min(30000, Number.isFinite(requestedTimeout) ? requestedTimeout : 15000));
  const deadline = Date.now() + timeoutMs;
  let target = value;
  let method = String(options.method ?? "GET").toUpperCase();
  let headers = { "Accept-Encoding": "gzip, deflate, br", ...(options.headers ?? {}) };
  let body = requestBody(options, headers);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const { url, record } = await resolveTarget(target, allowInsecureHttp);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("javascript_source_network_timeout");
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, {
        method, headers, rejectUnauthorized: true,
        lookup: (_hostname, lookupOptions, callback) => lookupOptions.all ? callback(null, [record]) : callback(null, record.address, record.family),
      });
      const timer = setTimeout(() => request.destroy(new Error("javascript_source_network_timeout")), remaining);
      request.once("error", (error) => { clearTimeout(timer); reject(error); });
      request.once("response", (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { incoming.destroy(); request.destroy(new Error("javascript_source_message_too_large")); }
          else chunks.push(chunk);
        });
        incoming.once("error", (error) => { clearTimeout(timer); reject(error); });
        incoming.once("end", () => { clearTimeout(timer); resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks), url: url.href }); });
      });
      if (body && method !== "GET" && method !== "HEAD") request.write(body);
      request.end();
    });
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location && options.redirect !== 0 && options.redirect !== false) {
      if (redirect === MAX_REDIRECTS) throw new Error("javascript_source_network_redirects");
      const next = new URL(location, url);
      if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !["authorization", "proxy-authorization", "cookie", "host"].includes(name.toLowerCase())));
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET"; body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !["content-type", "content-length"].includes(name.toLowerCase())));
      }
      target = next.href;
      continue;
    }
    let bytes = response.body;
    const compression = String(response.headers["content-encoding"] ?? "").toLowerCase();
    const settings = { maxOutputLength: MAX_RESPONSE_BYTES };
    if (compression === "gzip") bytes = gunzipSync(bytes, settings);
    else if (compression === "deflate") bytes = inflateSync(bytes, settings);
    else if (compression === "br") bytes = brotliDecompressSync(bytes, settings);
    let content;
    if (options.buffer === 1) content = bytes.toString("base64");
    else {
      try { content = new TextDecoder(options.encoding || "utf-8").decode(bytes); }
      catch { content = bytes.toString("utf8"); }
    }
    return { code: response.status, status: response.status, content, headers: response.headers, header: response.headers, url: response.url };
  }
  throw new Error("javascript_source_network_redirects");
}

/** 共享内存只承担当前网络结果；Atomics 通知使同步 req 与 await req 使用同一实现。 */
parentPort.on("message", async ({ url, options, allowInsecureHttp, sharedState, sharedBody }) => {
  const state = new Int32Array(sharedState);
  const body = new Uint8Array(sharedBody);
  let envelope;
  try { envelope = { ok: true, value: await sendRequest(url, options, allowInsecureHttp) }; }
  catch (error) {
    const code = typeof error?.message === "string" && error.message.startsWith("javascript_source_") ? error.message : "javascript_source_network_failed";
    const systemCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,60}$/u.test(error.code) ? error.code : null;
    envelope = { ok: false, code, diagnostics: { 网络错误码: systemCode } };
  }
  let encoded = Buffer.from(JSON.stringify(envelope));
  if (encoded.length > body.length) encoded = Buffer.from(JSON.stringify({ ok: false, code: "javascript_source_message_too_large" }));
  body.set(encoded);
  Atomics.store(state, 1, encoded.length);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
});
