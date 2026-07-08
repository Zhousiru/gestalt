import { createRoute } from "honox/factory";
import { loadTraceDetail } from "../../../lib/indexer";

export default createRoute(async (c) => {
  c.header("Cache-Control", "no-store");
  const id = c.req.param("id") ?? "";
  const detail = await loadTraceDetail(id);
  if (!detail) {
    return c.json({ error: "Trace not found", id }, 404);
  }
  return c.json(detail);
});
