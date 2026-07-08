import build from "@hono/vite-build/node";
import adapter from "@hono/vite-dev-server/node";
import tailwindcss from "@tailwindcss/vite";
import honox from "honox/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => ({
  define:
    command === "build" && mode !== "client"
      ? {
          "process.env": "process.env"
        }
      : {},
  ssr: {
    external: ["react", "react-dom"]
  },
  plugins: [
    honox({
      devServer: { adapter },
      client: { input: ["/app/client.ts", "/app/style.css"] }
    }),
    tailwindcss(),
    build()
  ]
}));
