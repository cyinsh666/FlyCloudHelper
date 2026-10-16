import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type { ApiRuntime } from "../runtime.js";
import { AbsAccessService, type AbsSocketAuthorization } from "./access.js";
import type { AbsContext } from "./types.js";

type AbsSocketRequest = IncomingMessage & { absPathSuffix?: string };

/** 动态单库前缀统一挂载到一个 Engine.IO，保持 polling 与 WebSocket 标准握手。 */
export class AbsSocketHub {
  private readonly io: SocketIOServer;
  // 关键变量：同一连接的重认证与推送共用队列，避免推送读到认证切换中的临时身份。
  private readonly socketTasks = new Map<string, Promise<void>>();
  public constructor(
    server: FastifyInstance,
    private readonly runtime: ApiRuntime,
    private readonly access: AbsAccessService,
  ) {
    this.io = new SocketIOServer(server.server, {
      path: "/abs/socket.io",
      serveClient: false,
      cors: { origin: false },
    });
    /** 在 Engine.IO 检查固定路径前只改写 ABS socket 路由，其余云助手请求保持原样。 */
    const rewrite = (request: AbsSocketRequest): void => {
      const match = request.url?.match(/^\/abs\/([^/?]+)\/socket\.io(\/)?(?=\?|$)/u);
      if (!match?.[1]) return;
      try {
        request.absPathSuffix = decodeURIComponent(match[1]);
      } catch {
        return;
      }
      request.url = request.url!.replace(match[0], `/abs/socket.io${match[2] ?? ""}`);
    };
    server.server.prependListener("request", rewrite);
    server.server.prependListener("upgrade", rewrite);
    this.io.on("connection", (socket) => {
      socket.on("auth", (token: unknown) => {
        void this.runSocketTask(socket.id, async () => {
          if (!socket.connected) return;
          await this.authenticate(socket, token);
        }).catch(() => socket.emit("auth_failed", { message: "Invalid token" }));
      });
      socket.on("ping", () => socket.emit("pong"));
    });
    server.addHook("onClose", async () => {
      server.server.removeListener("request", rewrite);
      server.server.removeListener("upgrade", rewrite);
      // Fastify 统一关闭 HTTP Server；Socket.IO.close 会再次关闭它，因此这里只关连接和 Engine.IO。
      this.io.disconnectSockets(true);
      this.io.engine.close();
      this.io.removeAllListeners();
    });
  }

  /** 推送前重新检查账号，禁用、改密与跨库连接不会继续收到进度事件。 */
  public async emit(context: AbsContext, event: string, payload: unknown): Promise<void> {
    const sockets = await this.io.in(`${context.libraryId}:${context.accountId}`).fetchSockets();
    for (const candidate of sockets) {
      await this.runSocketTask(candidate.id, async () => {
        // 关键变量：房间查询结果可能早于重认证，排队后读取当前连接和身份，不能继续使用旧快照。
        const socket = this.io.sockets.sockets.get(candidate.id);
        if (!socket?.connected) return;
        const authorization = socket.data.absAuthorization as AbsSocketAuthorization | undefined;
        // 合法切换账号或库后，旧房间已选中的事件只跳过，不误断新身份，也不向它发送旧账号数据。
        if (
          !authorization ||
          authorization.libraryId !== context.libraryId ||
          authorization.accountId !== context.accountId
        )
          return;
        try {
          const state = await this.runtime.database.getSystemState();
          if (state.setupRequired || state.credentialKeyBackupRequired)
            throw new Error("Server setup is incomplete");
          const library = await this.access.getLibrary(context.pathSuffix);
          await this.access.revalidateSocket(library, authorization);
          socket.emit(event, payload);
        } catch {
          socket.emit("auth_failed", { message: "Authorization revoked" });
          socket.disconnect(true);
        }
      });
    }
  }

  /** 串行处理一个连接的身份变更与推送；失败不阻断后续认证，完成后及时清理队列。 */
  private async runSocketTask(socketId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.socketTasks.get(socketId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.socketTasks.set(socketId, current);
    try {
      await current;
    } finally {
      if (this.socketTasks.get(socketId) === current) this.socketTasks.delete(socketId);
    }
  }

  /** 标准 auth 事件只绑定真实协议用户，不把握手成功当成授权成功。 */
  private async authenticate(socket: Socket, token: unknown): Promise<void> {
    delete socket.data.absAuthorization;
    for (const room of socket.rooms) if (room !== socket.id) await socket.leave(room);
    const state = await this.runtime.database.getSystemState();
    if (state.setupRequired || state.credentialKeyBackupRequired) {
      socket.emit("auth_failed", { message: "Server setup is incomplete" });
      socket.disconnect(true);
      return;
    }
    const pathSuffix = (socket.request as AbsSocketRequest).absPathSuffix;
    if (!pathSuffix || typeof token !== "string") {
      socket.emit("auth_failed", { message: "Invalid token" });
      return;
    }
    const library = await this.access.getLibrary(pathSuffix);
    const { context, authorization } = await this.access.authorizeSocket(library, token);
    await socket.join(`${context.libraryId}:${context.accountId}`);
    socket.data.absAuthorization = authorization;
    socket.emit("init", { userId: context.accountId, username: context.username });
  }
}
