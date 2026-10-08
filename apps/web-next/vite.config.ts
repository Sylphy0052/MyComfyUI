import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 5174で待ち受ける。旧UI (5173) と同時に起動していたころのポートを変えずに使う。
// /api とWebSocketはApplication APIへ中継し、画面からは同一originとして扱う (ADR 0001)。
const API_TARGET = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
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
