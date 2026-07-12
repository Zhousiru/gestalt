import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const liveTarget =
    env.VITE_GESTALT_LIVE_URL?.trim() || "http://127.0.0.1:3000";

  return {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@gestalt/live-contracts": fileURLToPath(
          new URL("../live-contracts/src/index.ts", import.meta.url)
        )
      }
    },
    server: {
      host: "127.0.0.1",
      port: 5174,
      proxy: {
        "/api/live": {
          target: liveTarget,
          changeOrigin: true
        }
      }
    }
  };
});
