import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error resolved by the bundler, not by tsc
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Dev port deliberately not 1420 / 1490 - other Tauri apps may own those.
const DEV_PORT = 14320;
const HMR_PORT = 14321;

export default defineConfig(async () => ({
  plugins: [react()],
  // So About can state the version instead of it being written twice.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: HMR_PORT,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
