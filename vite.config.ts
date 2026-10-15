import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import path from "node:path";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // Older WebKit on macOS (the system WebView) needs lowered syntax.
  build: { target: ["chrome105", "safari15"] },

  // Direct access to Monaco ESM files (for src/lib/monaco-lean.ts)
  resolve: {
    alias: { "monaco-esm": path.resolve("node_modules/monaco-editor/esm/vs") },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    // node_modules may be a link to another checkout (git worktrees)
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fs.realpathSync("node_modules")] },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
