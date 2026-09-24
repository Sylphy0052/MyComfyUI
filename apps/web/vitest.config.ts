import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// component testはhappy-domで動かす。dialogのtop layerは再現されないため、
// portal先のDOM構造だけを検証する (#260)。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
