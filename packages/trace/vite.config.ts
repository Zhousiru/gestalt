import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const liveTarget =
    env.VITE_GESTALT_LIVE_URL?.trim() || "http://127.0.0.1:5175";

  return {
    plugins: [tailwindcss()],
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
