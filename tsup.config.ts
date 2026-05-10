import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  // 将 @dian/plugin-runtime 和 reflect-metadata 打包进输出，
  // 使插件成为单一可移植的 index.js
  noExternal: ["@dian/plugin-runtime", "reflect-metadata"],
  // UI 由 Vite 单独构建到 dist/public/，此处无需 cpSync
});
