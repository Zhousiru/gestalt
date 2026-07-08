import { showRoutes } from "hono/dev";
import { createApp } from "honox/server";

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  showRoutes(app);
}

export default app;
