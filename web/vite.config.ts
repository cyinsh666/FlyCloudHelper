import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * 创建 FlyCloudHelper Web 的 Vite 配置。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(currentDirectory, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 9935,
    proxy: {
      "/abs/": {
        target: "http://127.0.0.1:9934",
        // ABS HTTP 与 Socket.IO 使用同一根路径，开发入口支持升级 WebSocket。
        changeOrigin: false,
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:9934",
        // 保留浏览器访问时的 Host，供后台进行同源 CSRF 校验。
        changeOrigin: false,
      },
      "/j/": {
        target: "http://127.0.0.1:9934",
        // Jellyfin 客户端经开发端口访问协议；保留 Host，让媒体地址沿用客户端可达入口。
        changeOrigin: false,
      },
      "/e/": {
        target: "http://127.0.0.1:9934",
        // Emby 客户端使用同一开发入口，协议请求和媒体流统一转发到 API。
        changeOrigin: false,
      },
      "/n/": {
        target: "http://127.0.0.1:9934",
        // Navidrome 的音乐和头像请求使用同一开发入口，避免落到 Web 页面。
        changeOrigin: false,
      },
    },
  },
});
