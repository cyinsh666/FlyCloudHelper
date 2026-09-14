import { ApiError } from "../errors.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApiConfig } from "../config.js";
import type { ProviderAdapter, ProviderConnectionContext, ProviderEntry, ProviderFileStreamAccess } from "../providers/types.js";
import { openMusicFileStream } from "./file-stream.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readRemoteAudioTags } from "./audio-tag-reader.js";
import type { MediaDescriptor } from "../media/filename.js";

/** ffprobe 通过本机受控网关读取，真实网络字节受整首预算限制。 */
export async function readBoundedAudioTags(config: ApiConfig, entry: ProviderEntry, resolve: () => Promise<ProviderFileStreamAccess>, signal: AbortSignal) {
  const token = randomUUID();
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  let bytes = 0; // 覆盖 ffprobe 与内嵌封面提取的全部上游读取。
  let requestCount = 0;
  let readError = "";
  let authorizationError: ApiError | undefined;
  let access = await resolve();
  const gateway = createServer(AsyncLocalStorage.bind(async (request: import("node:http").IncomingMessage, reply: import("node:http").ServerResponse) => {
    if (request.url !== `/${token}` || !["GET", "HEAD"].includes(request.method ?? "")) { reply.writeHead(404).end(); return; }
    const client = new AbortController();
    const abortClient = () => client.abort();
    reply.once("close", abortClient);
    try {
      if (++requestCount > 40 || bytes >= 12 * 1024 * 1024) throw new Error("音频资料读取超过本次字节或请求预算");
      const upstream = await openMusicFileStream(async () => { access = await resolve(); return access; }, { method: request.method, headers: request.headers.range ? { Range: request.headers.range } : {} },
        { allowInsecureHttp: config.allowInsecureProviderHttp }, AbortSignal.any([requestSignal, client.signal]), access);
      // 随机定位遇到忽略 Range 的上游不能把文件开头冒充尾部字节。
      const offset = Number(request.headers.range?.match(/^bytes=(\d+)-/u)?.[1] ?? 0);
      if (offset > 0 && upstream.statusCode !== 206) { upstream.body.destroy(); throw new Error("上游未支持音频资料分段读取"); }
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers[name];
        if (value !== undefined) reply.setHeader(name, value);
      }
      reply.statusCode = upstream.statusCode;
      const budget = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 12 * 1024 * 1024) { readError = "音频资料读取超过 12 MiB 预算"; callback(new Error(readError)); }
        else callback(null, chunk);
      } });
      try { await pipeline(upstream.body, budget, reply); }
      finally { upstream.body.destroy(); }
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 410) authorizationError = error;
      if (!client.signal.aborted && !requestSignal.aborted) readError = error instanceof Error ? error.message : "音频资料读取失败";
      if (!reply.headersSent) reply.writeHead(502).end();
      else reply.destroy();
    } finally { reply.removeListener("close", abortClient); }
  }));
  try {
    await new Promise<void>((resolveListening, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolveListening); });
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("音频读取网关未启动");
    signal.throwIfAborted();
    const result = await readRemoteAudioTags({ config, access: { url: `http://127.0.0.1:${address.port}/${token}`, expiresAt: null, headers: {} }, fileName: entry.name, signal: requestSignal });
    result.actualReadBytes = bytes;
    result.requestCount = requestCount;
    result.readBytesLimit = 12 * 1024 * 1024;
    if (authorizationError) throw authorizationError;
    if (readError) { result.status = result.tags.title || result.technical.durationMs ? "partial" : "failed"; result.errorCode = "audio_read_partial"; result.errorMessage = readError; }
    if (result.errorCode) console.warn("codex-flycloud-music", { 事件: "文件资料局部失败", 资源ID: entry.resourceId, 读取字节数: bytes, 请求次数: requestCount, 错误分类: result.errorCode });
    return result;
  } finally {
    controller.abort();
    gateway.closeAllConnections();
    await new Promise<void>((resolveClosed) => gateway.close(() => resolveClosed()));
  }
}

/** 读取小型旁挂文件，按实际流量限制内存占用。 */
async function readSidecarBytes(resolve: () => Promise<ProviderFileStreamAccess>, maxBytes: number, config: ApiConfig, signal: AbortSignal): Promise<Buffer> {
  const response = await openMusicFileStream(resolve, { method: "GET" }, { allowInsecureHttp: config.allowInsecureProviderHttp }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  try {
    if (response.statusCode !== 200) throw new Error(`旁挂资料读取失败：HTTP ${response.statusCode}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("旁挂资料超过读取大小限制");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { response.body.destroy(); }
}

/** 内嵌资料优先，旁挂失败仅影响当前字段，已有标签保持。 */
export async function applyMusicSidecars(input: { descriptor: MediaDescriptor; entries: ProviderEntry[]; adapter: ProviderAdapter; connection: Record<string, unknown>; context: ProviderConnectionContext; config: ApiConfig; signal: AbortSignal }): Promise<string[]> {
  const { descriptor, entries, adapter, connection, context, config, signal } = input;
  const stem = path.posix.basename(String(descriptor.metadata.fileName ?? ""), path.posix.extname(String(descriptor.metadata.fileName ?? ""))).toLowerCase();
  const errors: string[] = [];
  const access = async (entry: ProviderEntry) => {
    if (!adapter.resolveFileStreamAccess) throw new Error("当前来源不支持音乐字节读取");
    return adapter.resolveFileStreamAccess(connection, entry.locator, signal, context);
  };
  if (!descriptor.metadata.lyrics) {
    const lyric = entries.find((entry) => entry.name.toLowerCase() === `${stem}.lrc`);
    if (lyric) try { if (lyric.size > 1024 * 1024) throw new Error("旁挂歌词超过 1 MiB"); descriptor.metadata.lyrics = (await readSidecarBytes(() => access(lyric), 1024 * 1024, config, signal)).toString("utf8").replace(/^\uFEFF/u, ""); descriptor.metadata.metadataFieldSources = { ...(descriptor.metadata.metadataFieldSources as object), lyrics: "sidecar" }; }
    catch (error) { signal.throwIfAborted(); if (error instanceof ApiError && error.statusCode === 410) throw error; errors.push(error instanceof Error && error.message.includes("MiB") ? error.message : "旁挂歌词读取失败"); }
  }
  if (!descriptor.metadata.embeddedArtworkUrl) {
    for (const name of [stem, "cover", "folder", "front"]) {
      const entry = entries.find((item) => path.posix.basename(item.name, path.posix.extname(item.name)).toLowerCase() === name && /\.(jpg|jpeg|png|webp)$/iu.test(item.name));
      if (!entry) continue;
      try {
        if (entry.size > 4 * 1024 * 1024) throw new Error("旁挂封面超过 4 MiB");
        const bytes = await readSidecarBytes(() => access(entry), 4 * 1024 * 1024, config, signal);
        const extension = bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : "";
        if (!extension) throw new Error("旁挂封面内容不是支持的图片");
        const filename = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
        await fs.mkdir(config.musicArtworkDirectory, { recursive: true });
        await fs.writeFile(path.join(config.musicArtworkDirectory, filename), bytes);
        descriptor.metadata.sidecarArtworkUrl = `/api/v1/music-artwork/${filename}`;
        descriptor.metadata.metadataFieldSources = { ...(descriptor.metadata.metadataFieldSources as object), artwork: "sidecar" };
        break;
      } catch (error) { signal.throwIfAborted(); if (error instanceof ApiError && error.statusCode === 410) throw error; errors.push(error instanceof Error && error.message.includes("MiB") ? error.message : "旁挂封面读取失败"); }
    }
  }
  return errors;
}
