import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { buildThemeBootScript } from "./src/state/themeBootScript";

// 開発時は Vite が /api と WebSocket を Application API へ中継し、画面からは
// 同一 origin として扱う。API は loopback だけで待ち受ける前提とする (ADR 0001)。
const API_TARGET = "http://127.0.0.1:8000";

// テーマの起動スクリプトをindex.htmlへ直書きせず、themeState.tsの定数から組み立てて差し込む。
function createThemeBootScriptPlugin(): Plugin {
  return {
    name: "mycomfyui-theme-boot-script",
    transformIndexHtml: () => [{ tag: "script", children: buildThemeBootScript(), injectTo: "head" }],
  };
}

export default defineConfig({
  plugins: [react(), createThemeBootScriptPlugin()],
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
    // 使用マニュアルは本体と別ページにし、本体の画面状態を中断せず別タブで開けるようにする。
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        manual: fileURLToPath(new URL("./manual.html", import.meta.url)),
      },
    },
  },
});
