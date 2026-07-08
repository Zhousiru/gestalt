import { createRoute } from "honox/factory";
import { loadTraceWorkspace } from "../../lib/indexer";

export default createRoute(async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await loadTraceWorkspace());
});
