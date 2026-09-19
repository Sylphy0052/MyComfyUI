import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発時は Vite が /api と WebSocket を Application API へ中継し、画面からは
// 同一 origin として扱う。API は loopback だけで待ち受ける前提とする (ADR 0001)。
const API_TARGET = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
